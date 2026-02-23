package guardrails

import (
	"strings"
	"testing"
)

func TestDeanonymize_BracketTokens(t *testing.T) {
	original := "123-45-6789"
	replacement := getOrCreateMapping(original, "ssn", func(o string) string {
		token := encryptForToken(o, "ssn")
		return "[SSN-" + token[:12] + "]"
	})

	result := Deanonymize(replacement)
	if result != original {
		t.Errorf("deanonymize bracket token: got %q, want %q", result, original)
	}
}

func TestDeanonymize_EmailFormat(t *testing.T) {
	original := "john.doe@example.com"
	replacement := getOrCreateMapping(original, "email", emailPatternDef.ReplacementGenerator)

	if !strings.Contains(replacement, "@anon.com") {
		t.Fatalf("email replacement should contain @anon.com, got %q", replacement)
	}

	result := Deanonymize(replacement)
	if result != original {
		t.Errorf("deanonymize email: got %q, want %q", result, original)
	}
}

func TestDeanonymize_APIKeyTokens(t *testing.T) {
	original := "sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456"
	replacement := getOrCreateMapping(original, "api_key", generateAPIKeyReplacement)

	result := Deanonymize(replacement)
	if result != original {
		t.Errorf("deanonymize API key: got %q, want %q", result, original)
	}
}

func TestDeanonymize_SecretTokens(t *testing.T) {
	original := "MyVerySecretLongPassword123!"
	replacement := getOrCreateMapping(original, "secret", generateAPIKeySecretReplacement)

	if !strings.Contains(replacement, "[SECRET-") {
		t.Fatalf("secret replacement should contain [SECRET-, got %q", replacement)
	}

	result := Deanonymize(replacement)
	if result != original {
		t.Errorf("deanonymize secret: got %q, want %q", result, original)
	}
}

func TestDeanonymize_RoundTrip(t *testing.T) {
	// Clear reverse map
	ClearReverseMappings()

	original := "Contact john.doe@example.com about SSN 123-45-6789"
	anonymized := RunGuardrails(original)

	// Should be different from original
	if anonymized == original {
		t.Fatal("anonymized text should differ from original")
	}

	// Deanonymize should recover
	result := Deanonymize(anonymized)
	if !strings.Contains(result, "john.doe@example.com") {
		t.Error("deanonymize should recover email")
	}
	if !strings.Contains(result, "123-45-6789") {
		t.Error("deanonymize should recover SSN")
	}
}

func TestCreateDeanonymizeStream(t *testing.T) {
	// Clear reverse map
	ClearReverseMappings()

	// Create a known mapping
	original := "alice@example.com"
	replacement := getOrCreateMapping(original, "email", emailPatternDef.ReplacementGenerator)

	// Create SSE stream with the replacement
	sseData := "event: content_block_delta\ndata: " +
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"` + replacement + `"}}` +
		"\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n"

	reader := strings.NewReader(sseData)
	stream := CreateDeanonymizeStream(reader)

	buf := make([]byte, 4096)
	n, _ := stream.Read(buf)
	result := string(buf[:n])
	stream.Close()

	if !strings.Contains(result, original) {
		t.Errorf("stream deanonymize should contain original %q, got: %s", original, result)
	}
}
