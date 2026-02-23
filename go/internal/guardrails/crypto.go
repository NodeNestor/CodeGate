// Package guardrails implements PII/credential anonymization for LLM requests
// and deanonymization for LLM responses. It uses deterministic AES-256-CTR
// encryption so replacements can be reversed without database lookups.
package guardrails

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"unicode"

	"golang.org/x/crypto/scrypt"
)

// guardrailKey is the cached 32-byte key used for deterministic encryption.
var (
	guardrailKey   []byte
	guardrailKeyMu sync.Mutex
)

// getGuardrailKey returns the 32-byte guardrail encryption key.
//
// Priority:
//  1. GUARDRAIL_KEY env var (derived via scrypt with salt "claude-proxy-guardrail-key-salt")
//  2. {DATA_DIR}/.guardrail-key file (hex-encoded 32 bytes)
//  3. Generate random 32 bytes and persist to file
func getGuardrailKey() []byte {
	guardrailKeyMu.Lock()
	defer guardrailKeyMu.Unlock()

	if guardrailKey != nil {
		return guardrailKey
	}

	// 1. Check GUARDRAIL_KEY env var
	if envKey := os.Getenv("GUARDRAIL_KEY"); envKey != "" && envKey != "auto" {
		derived, err := scrypt.Key(
			[]byte(envKey),
			[]byte("claude-proxy-guardrail-key-salt"),
			16384, 8, 1, 32, // N=16384, r=8, p=1, keyLen=32 (matches Node.js scryptSync defaults)
		)
		if err == nil {
			guardrailKey = derived
			return guardrailKey
		}
	}

	// 2. Try reading from file
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}
	keyFile := filepath.Join(dataDir, ".guardrail-key")

	if data, err := os.ReadFile(keyFile); err == nil {
		hexStr := strings.TrimSpace(string(data))
		if key, err := hex.DecodeString(hexStr); err == nil && len(key) == 32 {
			guardrailKey = key
			return guardrailKey
		}
	}

	// 3. Generate and save
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		panic(fmt.Sprintf("guardrails: failed to generate key: %v", err))
	}
	_ = os.MkdirAll(dataDir, 0o755)
	_ = os.WriteFile(keyFile, []byte(hex.EncodeToString(key)), 0o600)
	guardrailKey = key
	return guardrailKey
}

// deriveIV derives a deterministic IV from the value and a domain-specific salt.
// This ensures the same value always produces the same ciphertext.
func deriveIV(value, domain string) []byte {
	key := getGuardrailKey()

	// salt = HMAC-SHA256(key, domain)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(domain))
	salt := mac.Sum(nil)

	// iv = HMAC-SHA256(salt, value)[0:16]
	mac2 := hmac.New(sha256.New, salt)
	mac2.Write([]byte(value))
	return mac2.Sum(nil)[:16]
}

// encryptForToken encrypts a value for embedding in a replacement token.
// Deterministic: same input always produces the same token.
// Format: base64url(IV(16) + ciphertext + checksum(4))
// The IV is included so decryption does not need the plaintext.
func encryptForToken(value, domain string) string {
	key := getGuardrailKey()
	iv := deriveIV(value, domain)

	block, err := aes.NewCipher(key)
	if err != nil {
		return ""
	}

	plaintext := []byte(value)
	ciphertext := make([]byte, len(plaintext))
	stream := cipher.NewCTR(block, iv)
	stream.XORKeyStream(ciphertext, plaintext)

	// checksum = HMAC-SHA256(key, value+domain)[0:4]
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(value + domain))
	checksum := mac.Sum(nil)[:4]

	// Combine: IV + ciphertext + checksum
	combined := make([]byte, 0, 16+len(ciphertext)+4)
	combined = append(combined, iv...)
	combined = append(combined, ciphertext...)
	combined = append(combined, checksum...)

	// base64url encode and strip padding
	encoded := base64.RawURLEncoding.EncodeToString(combined)
	return encoded
}

// decryptToken reverses encryptForToken.
// Extracts the IV from the first 16 bytes of the token.
// Returns "" if decryption fails or checksum does not match.
func decryptToken(token, domain string) string {
	key := getGuardrailKey()

	// Handle missing padding: base64url decode (RawURLEncoding handles no padding)
	data, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		// Try with standard padding added
		padded := token
		if m := len(token) % 4; m != 0 {
			padded += strings.Repeat("=", 4-m)
		}
		data, err = base64.URLEncoding.DecodeString(padded)
		if err != nil {
			return ""
		}
	}

	// Format: IV(16) + ciphertext(1+) + checksum(4) = minimum 21 bytes
	if len(data) < 21 {
		return ""
	}

	iv := data[:16]
	encrypted := data[16 : len(data)-4]
	checksum := data[len(data)-4:]

	block, err := aes.NewCipher(key)
	if err != nil {
		return ""
	}

	plaintext := make([]byte, len(encrypted))
	stream := cipher.NewCTR(block, iv)
	stream.XORKeyStream(plaintext, encrypted)

	plaintextStr := string(plaintext)

	// Verify checksum
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(plaintextStr + domain))
	expectedChecksum := mac.Sum(nil)[:4]

	if !hmac.Equal(checksum, expectedChecksum) {
		return ""
	}

	return plaintextStr
}

// hmacHash computes HMAC-SHA256(guardrailKey, value) and returns the hex string.
func hmacHash(value string) string {
	key := getGuardrailKey()
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(value))
	return hex.EncodeToString(mac.Sum(nil))
}

// shortHash returns the first length characters of hmacHash(value).
func shortHash(value string, length int) string {
	h := hmacHash(value)
	if length > len(h) {
		return h
	}
	return h[:length]
}

// shannonEntropy computes the Shannon entropy of a string.
func shannonEntropy(s string) float64 {
	if len(s) == 0 {
		return 0
	}
	freq := make(map[rune]int)
	total := 0
	for _, ch := range s {
		freq[ch]++
		total++
	}
	var entropy float64
	for _, count := range freq {
		p := float64(count) / float64(total)
		if p > 0 {
			entropy -= p * math.Log2(p)
		}
	}
	return entropy
}

// charClassCount counts the number of character classes present in s.
// Classes: lowercase, uppercase, digit, special.
func charClassCount(s string) int {
	var hasLower, hasUpper, hasDigit, hasSpecial bool
	for _, ch := range s {
		switch {
		case unicode.IsLower(ch):
			hasLower = true
		case unicode.IsUpper(ch):
			hasUpper = true
		case unicode.IsDigit(ch):
			hasDigit = true
		default:
			hasSpecial = true
		}
	}
	count := 0
	if hasLower {
		count++
	}
	if hasUpper {
		count++
	}
	if hasDigit {
		count++
	}
	if hasSpecial {
		count++
	}
	return count
}

// Precompiled regexps for looksLikeSecret.
var (
	kebabCaseRe = regexp.MustCompile(`^[a-z][a-z0-9]*(-[a-z0-9]+){2,}$`)
	hexLongRe   = regexp.MustCompile(`^[0-9a-fA-F]{32,}$`)
	base64LongRe = regexp.MustCompile(`^[A-Za-z0-9+/]{20,}={0,2}$`)
)

// looksLikeSecret performs entropy-based secret detection with thresholds
// matching the TypeScript version exactly.
func looksLikeSecret(s string) bool {
	if len(s) < 8 {
		return false
	}

	// Skip file paths and slash-separated text
	if strings.Contains(s, "/") {
		return false
	}

	// Skip kebab-case identifiers (model IDs like claude-haiku-4-5-20251001)
	if kebabCaseRe.MatchString(s) {
		return false
	}

	// Skip our own anonymization tokens
	if strings.HasPrefix(s, "SECRET-") || strings.HasPrefix(s, "REDACTED-") {
		return false
	}

	entropy := shannonEntropy(s)
	classes := charClassCount(s)

	if entropy >= 4.0 && classes >= 3 {
		return true
	}
	if entropy >= 3.5 && classes >= 3 && len(s) >= 16 {
		return true
	}
	if entropy >= 3.0 && len(s) >= 32 {
		return true
	}
	if hexLongRe.MatchString(s) && len(s) >= 32 {
		return true
	}
	if base64LongRe.MatchString(s) && entropy >= 3.5 {
		return true
	}

	return false
}
