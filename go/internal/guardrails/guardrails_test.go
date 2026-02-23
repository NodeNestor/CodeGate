package guardrails

import (
	"os"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	registerBuiltinGuardrails()
	os.Exit(m.Run())
}

func TestRunGuardrails_EmailAnonymization(t *testing.T) {
	// Enable guardrails for test
	text := "Contact alice@example.com for details"
	result := RunGuardrails(text)
	if strings.Contains(result, "alice@example.com") {
		t.Error("email should be anonymized")
	}
	if !strings.Contains(result, "@anon.com") {
		t.Error("replacement should contain @anon.com")
	}
}

func TestRunGuardrails_APIKeyDetection(t *testing.T) {
	text := "Use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456"
	result := RunGuardrails(text)
	if strings.Contains(result, "sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456") {
		t.Error("API key should be anonymized")
	}
}

func TestRunGuardrails_PasswordDetection(t *testing.T) {
	text := "password = MyS3cretP@ssw0rd!"
	result := RunGuardrails(text)
	if strings.Contains(result, "MyS3cretP@ssw0rd!") {
		t.Error("password should be anonymized")
	}
}

func TestRunGuardrails_NameDetection(t *testing.T) {
	text := "James Smith works here"
	result := RunGuardrails(text)
	if strings.Contains(result, "James Smith") {
		t.Error("name should be anonymized")
	}
	// The replacement should be a fake name (not a bracket token)
	if strings.Contains(result, "[") {
		t.Error("name replacement should be plain text, not bracket token")
	}
}

func TestRunGuardrailsOnRequestBody(t *testing.T) {
	body := map[string]any{
		"model": "claude-sonnet-4-20250514",
		"system": "You are helpful",
		"messages": []any{
			map[string]any{
				"role":    "user",
				"content": "Contact alice@example.com",
			},
		},
	}

	result := RunGuardrailsOnRequestBody(body)

	msgs, ok := result["messages"].([]any)
	if !ok || len(msgs) == 0 {
		t.Fatal("messages should be present")
	}
	msg := msgs[0].(map[string]any)
	content := msg["content"].(string)
	if strings.Contains(content, "alice@example.com") {
		t.Error("email in message should be anonymized")
	}
}

func TestRunGuardrailsOnRequestBody_ThinkingBlockSkipped(t *testing.T) {
	body := map[string]any{
		"model": "claude-sonnet-4-20250514",
		"messages": []any{
			map[string]any{
				"role": "assistant",
				"content": []any{
					map[string]any{
						"type":     "thinking",
						"thinking": "Thinking about alice@example.com...",
					},
					map[string]any{
						"type": "text",
						"text": "Contact alice@example.com",
					},
				},
			},
		},
	}

	result := RunGuardrailsOnRequestBody(body)

	msgs := result["messages"].([]any)
	msg := msgs[0].(map[string]any)
	content := msg["content"].([]any)

	// Thinking block should be unchanged
	thinking := content[0].(map[string]any)
	if !strings.Contains(thinking["thinking"].(string), "alice@example.com") {
		t.Error("thinking block should NOT be anonymized")
	}

	// Text block should be anonymized
	textBlock := content[1].(map[string]any)
	if strings.Contains(textBlock["text"].(string), "alice@example.com") {
		t.Error("text block should be anonymized")
	}
}
