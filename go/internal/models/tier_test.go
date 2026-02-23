package models

import "testing"

func TestDetectTier(t *testing.T) {
	tests := []struct {
		model string
		want  Tier
	}{
		{"claude-opus-4-20250514", TierOpus},
		{"claude-sonnet-4-20250514", TierSonnet},
		{"claude-haiku-4-5-20251001", TierHaiku},
		{"gpt-4o", ""},
		{"deepseek-r1", ""},
	}
	for _, tt := range tests {
		got := DetectTier(tt.model)
		if got != tt.want {
			t.Errorf("DetectTier(%q) = %q, want %q", tt.model, got, tt.want)
		}
	}
}

func TestEstimateCost(t *testing.T) {
	// Known model
	cost := EstimateCost("claude-sonnet-4-20250514", 1000000, 1000000)
	// 3.0 + 15.0 = 18.0
	if cost < 17.9 || cost > 18.1 {
		t.Errorf("EstimateCost sonnet = %f, want ~18.0", cost)
	}

	// Unknown model uses default
	cost2 := EstimateCost("unknown-model", 1000000, 1000000)
	// 2.0 + 8.0 = 10.0
	if cost2 < 9.9 || cost2 > 10.1 {
		t.Errorf("EstimateCost unknown = %f, want ~10.0", cost2)
	}
}
