package cooldown

import (
	"testing"
	"time"
)

func TestExponentialBackoff(t *testing.T) {
	Clear("test-exp")

	// First failure: 15s
	Set("test-exp", "test", 0)
	until := CooldownUntil("test-exp")
	if until.IsZero() {
		t.Fatal("should be on cooldown")
	}
	expected := time.Now().Add(15 * time.Second)
	if until.Before(expected.Add(-2*time.Second)) || until.After(expected.Add(2*time.Second)) {
		t.Errorf("first cooldown should be ~15s, got %v", time.Until(until))
	}

	// Second failure: 30s
	Set("test-exp", "test", 0)
	until = CooldownUntil("test-exp")
	expected = time.Now().Add(30 * time.Second)
	if until.Before(expected.Add(-2*time.Second)) || until.After(expected.Add(2*time.Second)) {
		t.Errorf("second cooldown should be ~30s, got %v", time.Until(until))
	}
}

func TestClear_Success(t *testing.T) {
	Set("test-clear", "test", 0)
	if !IsOnCooldown("test-clear") {
		t.Error("should be on cooldown")
	}

	Clear("test-clear")
	if IsOnCooldown("test-clear") {
		t.Error("should not be on cooldown after clear")
	}
}

func TestParseRetryAfter(t *testing.T) {
	tests := []struct {
		input string
		want  int
	}{
		{"60", 60},
		{"", 0},
		{"invalid", 60}, // default
	}
	for _, tt := range tests {
		got := ParseRetryAfter(tt.input)
		if got != tt.want {
			t.Errorf("ParseRetryAfter(%q) = %d, want %d", tt.input, got, tt.want)
		}
	}
}

func TestCooldownUntil(t *testing.T) {
	Clear("test-until")

	// No cooldown
	until := CooldownUntil("test-until")
	if !until.IsZero() {
		t.Error("should be zero when no cooldown")
	}

	// Set cooldown
	Set("test-until", "test", 10)
	until = CooldownUntil("test-until")
	if until.IsZero() {
		t.Error("should not be zero when on cooldown")
	}
	if time.Until(until) > 11*time.Second || time.Until(until) < 8*time.Second {
		t.Error("cooldown should be ~10s")
	}
}

func TestRetryAfterOverride(t *testing.T) {
	Clear("test-retry")

	// Set with explicit retry-after
	Set("test-retry", "rate_limit", 120)
	until := CooldownUntil("test-retry")
	expected := time.Now().Add(120 * time.Second)
	if until.Before(expected.Add(-2*time.Second)) || until.After(expected.Add(2*time.Second)) {
		t.Errorf("retry-after should override to ~120s, got %v", time.Until(until))
	}
}
