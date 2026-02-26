package db

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	_ "github.com/mattn/go-sqlite3"
)

var (
	conn   *sql.DB
	connMu sync.Mutex
)

// Account represents a decrypted account row.
type Account struct {
	ID                string
	Name              string
	Provider          string
	AuthType          string
	APIKey            string // decrypted
	RefreshToken      string // decrypted
	TokenExpiresAt    sql.NullInt64
	BaseURL           string
	Priority          int
	RateLimit         int
	MonthlyBudget     sql.NullFloat64
	Enabled           bool
	SubscriptionType  string
	AccountEmail      string
	ExternalAccountID string
	Status            string
	ErrorCount        int
}

// Config represents a routing config row.
type Config struct {
	ID              string
	Name            string
	Description     string
	IsActive        bool
	RoutingStrategy string
}

// ConfigTier represents a tier-account mapping.
type ConfigTier struct {
	ID          string
	ConfigID    string
	Tier        string
	AccountID   string
	Priority    int
	TargetModel string
}

// Setting represents a key-value setting.
type Setting struct {
	Key   string
	Value string
}

// Open opens the shared SQLite database.
func Open() error {
	connMu.Lock()
	defer connMu.Unlock()

	if conn != nil {
		return nil
	}

	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}
	dbPath := filepath.Join(dataDir, "codegate.db")

	var err error
	conn, err = sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_foreign_keys=on&mode=ro")
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}

	conn.SetMaxOpenConns(4)
	return nil
}

// DB returns the database connection.
func DB() *sql.DB {
	return conn
}

// Close closes the database connection.
func Close() {
	connMu.Lock()
	defer connMu.Unlock()
	if conn != nil {
		conn.Close()
		conn = nil
	}
}

// GetEnabledAccounts returns all enabled accounts with decrypted keys.
func GetEnabledAccounts() ([]Account, error) {
	rows, err := conn.Query(`SELECT id, name, provider, auth_type, api_key_enc, refresh_token_enc,
		token_expires_at, base_url, priority, rate_limit, monthly_budget, enabled,
		COALESCE(subscription_type, ''), COALESCE(account_email, ''),
		COALESCE(external_account_id, ''), COALESCE(status, 'unknown'), COALESCE(error_count, 0)
		FROM accounts WHERE enabled = 1 ORDER BY priority DESC, name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	encKey := getEncryptionKey()
	var accounts []Account
	for rows.Next() {
		var a Account
		var apiKeyEnc, refreshTokenEnc sql.NullString
		var baseURL sql.NullString
		var enabledInt int

		err := rows.Scan(&a.ID, &a.Name, &a.Provider, &a.AuthType,
			&apiKeyEnc, &refreshTokenEnc, &a.TokenExpiresAt,
			&baseURL, &a.Priority, &a.RateLimit, &a.MonthlyBudget,
			&enabledInt, &a.SubscriptionType, &a.AccountEmail,
			&a.ExternalAccountID, &a.Status, &a.ErrorCount)
		if err != nil {
			return nil, fmt.Errorf("scan account: %w", err)
		}

		a.Enabled = enabledInt == 1
		if baseURL.Valid {
			a.BaseURL = baseURL.String
		}
		if apiKeyEnc.Valid && apiKeyEnc.String != "" {
			a.APIKey = decryptValue(apiKeyEnc.String, encKey)
		}
		if refreshTokenEnc.Valid && refreshTokenEnc.String != "" {
			a.RefreshToken = decryptValue(refreshTokenEnc.String, encKey)
		}

		accounts = append(accounts, a)
	}
	return accounts, rows.Err()
}

// GetActiveConfig returns the currently active routing config.
func GetActiveConfig() (*Config, error) {
	row := conn.QueryRow("SELECT id, name, COALESCE(description, ''), is_active, COALESCE(routing_strategy, 'priority') FROM configs WHERE is_active = 1 LIMIT 1")

	var c Config
	var isActive int
	err := row.Scan(&c.ID, &c.Name, &c.Description, &isActive, &c.RoutingStrategy)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	c.IsActive = isActive == 1
	return &c, nil
}

// GetConfigTiers returns all tier assignments for a config.
func GetConfigTiers(configID string) ([]ConfigTier, error) {
	rows, err := conn.Query("SELECT id, config_id, tier, account_id, priority, COALESCE(target_model, '') FROM config_tiers WHERE config_id = ? ORDER BY tier, priority DESC", configID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tiers []ConfigTier
	for rows.Next() {
		var t ConfigTier
		if err := rows.Scan(&t.ID, &t.ConfigID, &t.Tier, &t.AccountID, &t.Priority, &t.TargetModel); err != nil {
			return nil, err
		}
		tiers = append(tiers, t)
	}
	return tiers, rows.Err()
}

// GetSetting returns a setting value by key.
func GetSetting(key string) string {
	if conn == nil {
		return ""
	}
	var val sql.NullString
	err := conn.QueryRow("SELECT value FROM settings WHERE key = ?", key).Scan(&val)
	if err != nil || !val.Valid {
		return ""
	}
	return val.String
}

// GetMonthlySpend returns the current month's spend for an account.
func GetMonthlySpend(accountID string) float64 {
	// Use a simple query for the first of the current month
	var total sql.NullFloat64
	err := conn.QueryRow(`SELECT COALESCE(SUM(cost_usd), 0) FROM usage WHERE account_id = ? AND created_at >= date('now', 'start of month')`, accountID).Scan(&total)
	if err != nil || !total.Valid {
		return 0
	}
	return total.Float64
}

// RecordUsage inserts a usage record into the database.
// This opens a separate write connection since the main one is read-only.
func RecordUsage(accountID, configID, tier, originalModel, routedModel string, inputTokens, outputTokens, cacheRead, cacheWrite int, costUSD float64, tenantID ...string) error {
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}
	dbPath := filepath.Join(dataDir, "codegate.db")

	wConn, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_foreign_keys=on")
	if err != nil {
		return err
	}
	defer wConn.Close()

	tid := ""
	if len(tenantID) > 0 {
		tid = tenantID[0]
	}

	id := generateID()
	_, err = wConn.Exec(`INSERT INTO usage (id, account_id, config_id, tier, original_model, routed_model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, nullStr(accountID), nullStr(configID), nullStr(tier), nullStr(originalModel), nullStr(routedModel),
		inputTokens, outputTokens, cacheRead, cacheWrite, costUSD, nullStr(tid))
	return err
}

// RecordAccountSuccess updates an account's status to active on success.
func RecordAccountSuccess(accountID string) {
	writeExec(`UPDATE accounts SET status = 'active', last_used_at = datetime('now'), error_count = 0, updated_at = datetime('now') WHERE id = ?`, accountID)
}

// RecordAccountError records an error for an account.
func RecordAccountError(accountID, errMsg string) {
	if len(errMsg) > 500 {
		errMsg = errMsg[:500]
	}
	writeExec(`UPDATE accounts SET last_error = ?, last_error_at = datetime('now'), error_count = error_count + 1, updated_at = datetime('now') WHERE id = ?`, errMsg, accountID)
}

// UpdateAccountStatus updates an account's status.
func UpdateAccountStatus(accountID, status, errMsg string) {
	if errMsg != "" {
		if len(errMsg) > 500 {
			errMsg = errMsg[:500]
		}
		writeExec(`UPDATE accounts SET status = ?, last_error = ?, last_error_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`, status, errMsg, accountID)
	} else {
		writeExec(`UPDATE accounts SET status = ?, updated_at = datetime('now') WHERE id = ?`, status, accountID)
	}
}

// InsertRequestLog inserts a request log entry.
func InsertRequestLog(method, path, inboundFormat, accountID, accountName, provider, originalModel, routedModel string, statusCode, inputTokens, outputTokens, latencyMs int, isStream, isFailover bool, errorMessage string, tenantID ...string) {
	streamInt, failoverInt := 0, 0
	if isStream {
		streamInt = 1
	}
	if isFailover {
		failoverInt = 1
	}
	tid := ""
	if len(tenantID) > 0 {
		tid = tenantID[0]
	}
	writeExec(`INSERT INTO request_logs (id, method, path, inbound_format, account_id, account_name, provider, original_model, routed_model, status_code, input_tokens, output_tokens, latency_ms, is_stream, is_failover, error_message, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		generateID(), method, path, inboundFormat, accountID, accountName, provider, originalModel, routedModel, statusCode, inputTokens, outputTokens, latencyMs, streamInt, failoverInt, nullStr(errorMessage), nullStr(tid))
}

// TenantRow represents a tenant from the database.
type TenantRow struct {
	ID        string
	Name      string
	ConfigID  string
	RateLimit int
	Enabled   bool
}

// GetTenantByKeyHash looks up a tenant by API key hash.
func GetTenantByKeyHash(hash string) *TenantRow {
	if conn == nil {
		return nil
	}
	row := conn.QueryRow(
		"SELECT id, name, COALESCE(config_id, ''), rate_limit, enabled FROM tenants WHERE api_key_hash = ? AND enabled = 1",
		hash,
	)
	var t TenantRow
	var enabledInt int
	err := row.Scan(&t.ID, &t.Name, &t.ConfigID, &t.RateLimit, &enabledInt)
	if err != nil {
		return nil
	}
	t.Enabled = enabledInt == 1
	return &t
}

// GetTenantSettings returns all settings for a tenant.
func GetTenantSettings(tenantID string) map[string]string {
	if conn == nil {
		return nil
	}
	rows, err := conn.Query("SELECT key, value FROM tenant_settings WHERE tenant_id = ?", tenantID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	settings := make(map[string]string)
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err == nil {
			settings[k] = v
		}
	}
	return settings
}

// HasTenants checks if any tenants exist. Returns false if table doesn't exist.
func HasTenants() bool {
	if conn == nil {
		return false
	}
	var dummy int
	err := conn.QueryRow("SELECT 1 FROM tenants LIMIT 1").Scan(&dummy)
	return err == nil
}

// GetConfigByID returns a config by its specific ID.
func GetConfigByID(id string) (*Config, error) {
	if conn == nil {
		return nil, fmt.Errorf("db not open")
	}
	row := conn.QueryRow("SELECT id, name, COALESCE(description, ''), is_active, COALESCE(routing_strategy, 'priority') FROM configs WHERE id = ?", id)
	var c Config
	var isActive int
	err := row.Scan(&c.ID, &c.Name, &c.Description, &isActive, &c.RoutingStrategy)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	c.IsActive = isActive == 1
	return &c, nil
}

// writeExec opens a write connection and executes a statement.
func writeExec(query string, args ...any) {
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}
	dbPath := filepath.Join(dataDir, "codegate.db")

	wConn, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_foreign_keys=on")
	if err != nil {
		return
	}
	defer wConn.Close()
	wConn.Exec(query, args...)
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func generateID() string {
	return fmt.Sprintf("%x", mustRandBytes(16))
}

func mustRandBytes(n int) []byte {
	b := make([]byte, n)
	_, err := cryptoRandRead(b)
	if err != nil {
		panic(err)
	}
	return b
}

var cryptoRandRead = func(b []byte) (int, error) {
	// Import crypto/rand inline
	return randRead(b)
}

// getEncryptionKey reads the account encryption key from the data directory.
// Compatible with Node.js which stores the key at DATA_DIR/.account-key
// (hex-encoded 32-byte key). Falls back to legacy .master-key.
func getEncryptionKey() []byte {
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}

	// Try .account-key first (current Node.js format), then legacy .master-key
	for _, name := range []string{".account-key", ".master-key", "encryption.key"} {
		keyPath := filepath.Join(dataDir, name)
		data, err := os.ReadFile(keyPath)
		if err != nil {
			continue
		}
		key, err := hex.DecodeString(strings.TrimSpace(string(data)))
		if err != nil {
			continue
		}
		if len(key) == 32 {
			return key
		}
	}
	return nil
}

// encryptValue encrypts a value with AES-256-GCM using 16-byte IV.
// Output format: base64(iv[16] + ciphertext + authTag[16]) — compatible with Node.js.
func encryptValue(value string, key []byte) string {
	if key == nil || value == "" {
		return ""
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return ""
	}
	aesGCM, err := cipher.NewGCMWithNonceSize(block, 16)
	if err != nil {
		return ""
	}
	iv := make([]byte, 16)
	if _, err := rand.Read(iv); err != nil {
		return ""
	}
	ciphertext := aesGCM.Seal(nil, iv, []byte(value), nil)
	// Combine iv + ciphertext+tag, base64 encode
	combined := make([]byte, 0, len(iv)+len(ciphertext))
	combined = append(combined, iv...)
	combined = append(combined, ciphertext...)
	return base64.StdEncoding.EncodeToString(combined)
}

// decryptValue decrypts an AES-256-GCM encrypted value.
// Supports two formats:
//   - Node.js format: base64(iv[16] + ciphertext + authTag[16]) — uses 16-byte nonce
//   - Legacy Go format: hex(iv):hex(ciphertext+tag) — uses 12-byte nonce
func decryptValue(encrypted string, key []byte) string {
	if key == nil || encrypted == "" {
		return ""
	}

	var iv, ciphertext []byte
	nonceSize := 16 // default: Node.js format

	if parts := strings.SplitN(encrypted, ":", 2); len(parts) == 2 {
		// Legacy Go hex format: hex(iv):hex(ciphertext+tag)
		var err error
		iv, err = hex.DecodeString(parts[0])
		if err != nil {
			return ""
		}
		ciphertext, err = hex.DecodeString(parts[1])
		if err != nil {
			return ""
		}
		nonceSize = len(iv) // use actual IV length (typically 12)
	} else {
		// Node.js base64 format: base64(iv[16] + ciphertext + authTag[16])
		combined, err := base64.StdEncoding.DecodeString(encrypted)
		if err != nil {
			return ""
		}
		if len(combined) < 33 { // 16 iv + 1 min ciphertext + 16 tag
			return ""
		}
		iv = combined[:16]
		ciphertext = combined[16:] // ciphertext + authTag (GCM expects them together)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return ""
	}

	aesGCM, err := cipher.NewGCMWithNonceSize(block, nonceSize)
	if err != nil {
		return ""
	}

	plaintext, err := aesGCM.Open(nil, iv, ciphertext, nil)
	if err != nil {
		return ""
	}

	return string(plaintext)
}

// UpdateAccountTokens updates an account's access/refresh tokens and expiry.
func UpdateAccountTokens(id, accessToken, refreshToken string, expiresAt int64) {
	encKey := getEncryptionKey()
	encAccess := encryptValue(accessToken, encKey)
	encRefresh := encryptValue(refreshToken, encKey)
	writeExec(`UPDATE accounts SET api_key_enc = ?, refresh_token_enc = ?, token_expires_at = ?, status = 'active', updated_at = datetime('now') WHERE id = ?`,
		encAccess, encRefresh, expiresAt, id)
}

// GetOAuthAccounts returns all enabled OAuth accounts with decrypted keys.
func GetOAuthAccounts() ([]Account, error) {
	rows, err := conn.Query(`SELECT id, name, provider, auth_type, api_key_enc, refresh_token_enc,
		token_expires_at, base_url, priority, rate_limit, monthly_budget, enabled,
		COALESCE(subscription_type, ''), COALESCE(account_email, ''),
		COALESCE(external_account_id, ''), COALESCE(status, 'unknown'), COALESCE(error_count, 0)
		FROM accounts WHERE auth_type = 'oauth' AND enabled = 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	encKey := getEncryptionKey()
	var accounts []Account
	for rows.Next() {
		var a Account
		var apiKeyEnc, refreshTokenEnc sql.NullString
		var baseURL sql.NullString
		var enabledInt int

		err := rows.Scan(&a.ID, &a.Name, &a.Provider, &a.AuthType,
			&apiKeyEnc, &refreshTokenEnc, &a.TokenExpiresAt,
			&baseURL, &a.Priority, &a.RateLimit, &a.MonthlyBudget,
			&enabledInt, &a.SubscriptionType, &a.AccountEmail,
			&a.ExternalAccountID, &a.Status, &a.ErrorCount)
		if err != nil {
			return nil, fmt.Errorf("scan account: %w", err)
		}
		a.Enabled = enabledInt == 1
		if baseURL.Valid {
			a.BaseURL = baseURL.String
		}
		if apiKeyEnc.Valid && apiKeyEnc.String != "" {
			a.APIKey = decryptValue(apiKeyEnc.String, encKey)
		}
		if refreshTokenEnc.Valid && refreshTokenEnc.String != "" {
			a.RefreshToken = decryptValue(refreshTokenEnc.String, encKey)
		}
		accounts = append(accounts, a)
	}
	return accounts, rows.Err()
}

// GetAccount returns a single account by ID with decrypted keys.
func GetAccount(id string) *Account {
	row := conn.QueryRow(`SELECT id, name, provider, auth_type, api_key_enc, refresh_token_enc,
		token_expires_at, base_url, priority, rate_limit, monthly_budget, enabled,
		COALESCE(subscription_type, ''), COALESCE(account_email, ''),
		COALESCE(external_account_id, ''), COALESCE(status, 'unknown'), COALESCE(error_count, 0)
		FROM accounts WHERE id = ?`, id)

	var a Account
	var apiKeyEnc, refreshTokenEnc sql.NullString
	var baseURL sql.NullString
	var enabledInt int

	err := row.Scan(&a.ID, &a.Name, &a.Provider, &a.AuthType,
		&apiKeyEnc, &refreshTokenEnc, &a.TokenExpiresAt,
		&baseURL, &a.Priority, &a.RateLimit, &a.MonthlyBudget,
		&enabledInt, &a.SubscriptionType, &a.AccountEmail,
		&a.ExternalAccountID, &a.Status, &a.ErrorCount)
	if err != nil {
		return nil
	}
	a.Enabled = enabledInt == 1
	if baseURL.Valid {
		a.BaseURL = baseURL.String
	}
	encKey := getEncryptionKey()
	if apiKeyEnc.Valid && apiKeyEnc.String != "" {
		a.APIKey = decryptValue(apiKeyEnc.String, encKey)
	}
	if refreshTokenEnc.Valid && refreshTokenEnc.String != "" {
		a.RefreshToken = decryptValue(refreshTokenEnc.String, encKey)
	}
	return &a
}
