package guardrails

import (
	"testing"
)

func TestEncryptDecryptRoundTrip(t *testing.T) {
	original := "hello-world-secret-value"
	domain := "test"

	token := encryptForToken(original, domain)
	if token == "" {
		t.Fatal("encryptForToken returned empty string")
	}

	decrypted := decryptToken(token, domain)
	if decrypted != original {
		t.Errorf("round-trip failed: got %q, want %q", decrypted, original)
	}
}

func TestDeterministicEncryption(t *testing.T) {
	original := "test-value-123"
	domain := "test"

	token1 := encryptForToken(original, domain)
	token2 := encryptForToken(original, domain)

	if token1 != token2 {
		t.Errorf("encryption is not deterministic: %q != %q", token1, token2)
	}
}

func TestDifferentDomains(t *testing.T) {
	original := "same-value"

	token1 := encryptForToken(original, "domain1")
	token2 := encryptForToken(original, "domain2")

	if token1 == token2 {
		t.Error("different domains should produce different tokens")
	}

	// Each should decrypt correctly with its own domain
	if decryptToken(token1, "domain1") != original {
		t.Error("failed to decrypt domain1 token")
	}
	if decryptToken(token2, "domain2") != original {
		t.Error("failed to decrypt domain2 token")
	}
	// Cross-domain should fail
	if decryptToken(token1, "domain2") == original {
		t.Error("cross-domain decryption should fail")
	}
}

func TestShannonEntropy(t *testing.T) {
	tests := []struct {
		input    string
		minEntropy float64
		maxEntropy float64
	}{
		{"", 0, 0},
		{"aaaa", 0, 0.1},
		{"abcd", 1.9, 2.1},
		{"aB3!aB3!", 1.9, 2.1},
	}
	for _, tt := range tests {
		e := shannonEntropy(tt.input)
		if e < tt.minEntropy || e > tt.maxEntropy {
			t.Errorf("shannonEntropy(%q) = %f, want [%f, %f]", tt.input, e, tt.minEntropy, tt.maxEntropy)
		}
	}
}

func TestCharClassCount(t *testing.T) {
	tests := []struct {
		input string
		want  int
	}{
		{"abc", 1},
		{"aBc", 2},
		{"aB3", 3},
		{"aB3!", 4},
		{"ABC", 1},
		{"123", 1},
	}
	for _, tt := range tests {
		got := charClassCount(tt.input)
		if got != tt.want {
			t.Errorf("charClassCount(%q) = %d, want %d", tt.input, got, tt.want)
		}
	}
}

func TestLooksLikeSecret(t *testing.T) {
	trueCases := []string{
		"xK9mPqR2sT4vW6yA8bC0dE3fG5hJ7kL",
		"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5",
		"ghp_1234567890abcdefABCDEF1234567890ab",
	}
	for _, s := range trueCases {
		if !looksLikeSecret(s) {
			t.Errorf("looksLikeSecret(%q) = false, want true", s)
		}
	}

	falseCases := []string{
		"hello",
		"short",
		"simple-text",
		"claude-haiku-4-5-20251001",
		"/usr/local/bin/something",
		"SECRET-already-replaced",
	}
	for _, s := range falseCases {
		if looksLikeSecret(s) {
			t.Errorf("looksLikeSecret(%q) = true, want false", s)
		}
	}
}
