package auth

import (
	"codegate-proxy/internal/db"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	refreshMargin       = 5 * time.Minute
	credCacheTTL        = 5 * time.Second
	anthropicClientID   = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
	anthropicTokenURL   = "https://console.anthropic.com/v1/oauth/token"
	refreshLoopInterval = 15 * time.Minute
)

type credFile struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    int64
}

var (
	credCache     *credFile
	credCacheTime time.Time
	credCacheMu   sync.Mutex

	refreshMu       sync.Mutex
	refreshInFlight = make(map[string]chan struct{})
)

func credFilePath() string {
	if p := os.Getenv("CLAUDE_CREDENTIALS_FILE"); p != "" {
		return p
	}
	return "/host-claude/.credentials.json"
}

func readCredentialFile() *credFile {
	credCacheMu.Lock()
	defer credCacheMu.Unlock()

	if credCache != nil && time.Since(credCacheTime) < credCacheTTL {
		return credCache
	}

	data, err := os.ReadFile(credFilePath())
	if err != nil {
		return nil
	}

	var parsed struct {
		ClaudeAiOauth struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
			ExpiresAt    int64  `json:"expiresAt"`
		} `json:"claudeAiOauth"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil
	}
	if parsed.ClaudeAiOauth.AccessToken == "" {
		return nil
	}

	credCache = &credFile{
		AccessToken:  parsed.ClaudeAiOauth.AccessToken,
		RefreshToken: parsed.ClaudeAiOauth.RefreshToken,
		ExpiresAt:    parsed.ClaudeAiOauth.ExpiresAt,
	}
	credCacheTime = time.Now()
	return credCache
}

func isHostAccount(account db.Account) bool {
	creds := readCredentialFile()
	if creds == nil {
		return false
	}
	return account.APIKey == creds.AccessToken
}

// NeedsRefresh checks if an OAuth account's token needs refreshing.
func NeedsRefresh(account db.Account) bool {
	if account.AuthType != "oauth" {
		return false
	}
	if !account.TokenExpiresAt.Valid {
		return false
	}
	now := time.Now().UnixMilli()
	return now >= account.TokenExpiresAt.Int64-refreshMargin.Milliseconds()
}

// EnsureValidToken ensures the account has a valid token.
func EnsureValidToken(account *db.Account) error {
	if !NeedsRefresh(*account) {
		return nil
	}

	refreshMu.Lock()
	if ch, ok := refreshInFlight[account.ID]; ok {
		refreshMu.Unlock()
		<-ch
		if updated := db.GetAccount(account.ID); updated != nil {
			*account = *updated
		}
		return nil
	}
	ch := make(chan struct{})
	refreshInFlight[account.ID] = ch
	refreshMu.Unlock()

	err := doRefresh(account)

	refreshMu.Lock()
	delete(refreshInFlight, account.ID)
	close(ch)
	refreshMu.Unlock()

	return err
}

func doRefresh(account *db.Account) error {
	if isHostAccount(*account) {
		return doFileRefresh(account)
	}

	if account.RefreshToken != "" {
		err := RefreshTokenDirectly(account)
		if err == nil {
			return nil
		}
		log.Printf("[auth-refresh] Direct refresh failed for %q: %v", account.Name, err)
	}

	return doFileRefresh(account)
}

func doFileRefresh(account *db.Account) error {
	creds := readCredentialFile()
	if creds == nil {
		log.Printf("[auth-refresh] Credential file not available for %q", account.Name)
		return fmt.Errorf("credential file not available")
	}

	if creds.AccessToken != account.APIKey {
		log.Printf("[auth-refresh] Syncing fresh token from credential file for %q", account.Name)
		db.UpdateAccountTokens(account.ID, creds.AccessToken, creds.RefreshToken, creds.ExpiresAt)
		if updated := db.GetAccount(account.ID); updated != nil {
			*account = *updated
		}
		return nil
	}

	log.Printf("[auth-refresh] Token for %q matches credential file", account.Name)
	return nil
}

// RefreshTokenDirectly refreshes a token with Anthropic's OAuth endpoint.
func RefreshTokenDirectly(account *db.Account) error {
	if account.RefreshToken == "" {
		return fmt.Errorf("no refresh token available")
	}

	log.Printf("[auth-refresh] Refreshing token directly for %q", account.Name)

	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {account.RefreshToken},
		"client_id":     {anthropicClientID},
	}

	resp, err := http.Post(anthropicTokenURL, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		return fmt.Errorf("token refresh request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		if resp.StatusCode == 401 || resp.StatusCode == 400 {
			db.UpdateAccountStatus(account.ID, "expired", fmt.Sprintf("Refresh token rejected: %d", resp.StatusCode))
		}
		return fmt.Errorf("token refresh failed (%d)", resp.StatusCode)
	}

	var data struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return fmt.Errorf("failed to parse refresh response: %w", err)
	}

	expiresAt := time.Now().UnixMilli() + data.ExpiresIn*1000
	if data.ExpiresIn == 0 {
		expiresAt = time.Now().UnixMilli() + 3600*1000
	}

	refreshToken := data.RefreshToken
	if refreshToken == "" {
		refreshToken = account.RefreshToken
	}

	db.UpdateAccountTokens(account.ID, data.AccessToken, refreshToken, expiresAt)

	if updated := db.GetAccount(account.ID); updated != nil {
		*account = *updated
	}

	log.Printf("[auth-refresh] Token refreshed for %q", account.Name)
	return nil
}

// ForceSyncFromFile forces a re-read of the credential file.
func ForceSyncFromFile(account *db.Account) *db.Account {
	credCacheMu.Lock()
	credCacheTime = time.Time{}
	credCacheMu.Unlock()

	creds := readCredentialFile()
	if creds == nil {
		return nil
	}

	if creds.AccessToken != account.APIKey {
		log.Printf("[auth-refresh] Force-syncing fresh token for %q", account.Name)
		db.UpdateAccountTokens(account.ID, creds.AccessToken, creds.RefreshToken, creds.ExpiresAt)
		return db.GetAccount(account.ID)
	}
	return nil
}

// StartTokenRefreshLoop starts a background goroutine that periodically
// checks all OAuth accounts and refreshes tokens nearing expiry.
func StartTokenRefreshLoop() {
	go func() {
		refreshAll()
		ticker := time.NewTicker(refreshLoopInterval)
		defer ticker.Stop()
		for range ticker.C {
			refreshAll()
		}
	}()
	log.Printf("[auth-refresh] Token refresh loop started (interval: %s)", refreshLoopInterval)
}

func refreshAll() {
	accounts, err := db.GetOAuthAccounts()
	if err != nil {
		log.Printf("[auth-refresh] Failed to get OAuth accounts: %v", err)
		return
	}
	for i := range accounts {
		if NeedsRefresh(accounts[i]) {
			if err := EnsureValidToken(&accounts[i]); err != nil {
				log.Printf("[auth-refresh] Background refresh failed for %q: %v", accounts[i].Name, err)
			}
		}
	}
}
