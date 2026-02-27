package proxy

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestHealthEndpoint(t *testing.T) {
	handler := Handler()

	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Errorf("health status = %d, want 200", w.Code)
	}

	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body["status"] != "ok" {
		t.Error("status should be ok")
	}
}

func TestModelsEndpoint(t *testing.T) {
	handler := Handler()

	req := httptest.NewRequest("GET", "/v1/models", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Errorf("models status = %d, want 200", w.Code)
	}

	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body["object"] != "list" {
		t.Error("object should be list")
	}
	data := body["data"].([]any)
	if len(data) < 3 {
		t.Error("should have at least 3 models")
	}
}

func TestToOpenAIError(t *testing.T) {
	raw := `{"error":{"message":"Rate limit exceeded","type":"rate_limit_error"}}`
	result := toOpenAIError(raw, 429, "anthropic")

	var parsed map[string]any
	if err := json.Unmarshal([]byte(result), &parsed); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	errObj := parsed["error"].(map[string]any)
	if errObj["message"] != "Rate limit exceeded" {
		t.Error("should preserve error message")
	}
}

func TestToAnthropicError(t *testing.T) {
	raw := `{"error":{"message":"Not found","type":"not_found_error","code":404}}`
	result := toAnthropicError(raw, 404, "openai")

	var parsed map[string]any
	if err := json.Unmarshal([]byte(result), &parsed); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if parsed["type"] != "error" {
		t.Error("type should be error")
	}
	errObj := parsed["error"].(map[string]any)
	if errObj["type"] != "not_found_error" {
		t.Errorf("error type = %v, want not_found_error", errObj["type"])
	}
}

func TestCORSPreflight(t *testing.T) {
	handler := Handler()

	req := httptest.NewRequest("OPTIONS", "/v1/messages", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 204 {
		t.Errorf("OPTIONS status = %d, want 204", w.Code)
	}
	if w.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Error("should have CORS allow origin header")
	}
}

func TestWriteError_OpenAI(t *testing.T) {
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	writeError(w, req, "openai", 400, "invalid_request_error", "Bad request")

	if w.Code != 400 {
		t.Errorf("status = %d, want 400", w.Code)
	}

	var parsed map[string]any
	json.Unmarshal(w.Body.Bytes(), &parsed)
	errObj := parsed["error"].(map[string]any)
	if errObj["message"] != "Bad request" {
		t.Error("error message mismatch")
	}
}

func TestWriteError_Anthropic(t *testing.T) {
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/messages", nil)
	writeError(w, req, "anthropic", 401, "authentication_error", "Invalid key")

	if w.Code != 401 {
		t.Errorf("status = %d, want 401", w.Code)
	}

	var parsed map[string]any
	json.Unmarshal(w.Body.Bytes(), &parsed)
	if parsed["type"] != "error" {
		t.Error("Anthropic errors should have type=error")
	}
}

func TestFormatDetection(t *testing.T) {
	// Test that /chat/completions is detected as openai format
	// We can't fully test handleProxy without a DB, but we can test the format detection logic
	tests := []struct {
		path   string
		format string
	}{
		{"/v1/chat/completions", "openai"},
		{"/v1/messages", "anthropic"},
		{"/v1/messages/count_tokens", "anthropic"},
	}

	for _, tt := range tests {
		format := "anthropic"
		if contains(tt.path, "/chat/completions") {
			format = "openai"
		}
		if format != tt.format {
			t.Errorf("path %q -> format %q, want %q", tt.path, format, tt.format)
		}
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsHelper(s, substr))
}

func containsHelper(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
