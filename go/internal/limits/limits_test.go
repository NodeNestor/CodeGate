package limits

import (
	"testing"
)

func intPtr(v int) *int    { return &v }
func boolPtr(v bool) *bool { return &v }

// setCache is a test helper that directly sets the cache
func setCache(entries map[string]ModelLimits) {
	cacheMu.Lock()
	cache = entries
	cacheMu.Unlock()
}

func TestClampMaxTokens_Clamped(t *testing.T) {
	setCache(map[string]ModelLimits{
		"deepseek-r1": {MaxOutputTokens: intPtr(8192)},
	})

	v := 16384
	result := ClampMaxTokens(&v, "deepseek-r1")
	if result == nil {
		t.Fatal("result should not be nil")
	}
	if *result != 8192 {
		t.Errorf("clamped value = %d, want 8192", *result)
	}
}

func TestClampMaxTokens_NotClamped(t *testing.T) {
	setCache(map[string]ModelLimits{
		"deepseek-r1": {MaxOutputTokens: intPtr(8192)},
	})

	v := 4096
	result := ClampMaxTokens(&v, "deepseek-r1")
	if result == nil {
		t.Fatal("result should not be nil")
	}
	if *result != 4096 {
		t.Errorf("unclamped value = %d, want 4096", *result)
	}
}

func TestClampMaxTokens_NoLimit(t *testing.T) {
	setCache(map[string]ModelLimits{})

	v := 100000
	result := ClampMaxTokens(&v, "claude-sonnet-4-20250514")
	if result == nil {
		t.Fatal("result should not be nil")
	}
	if *result != 100000 {
		t.Errorf("value should be unchanged when no limit, got %d", *result)
	}
}

func TestClampMaxTokens_Nil(t *testing.T) {
	result := ClampMaxTokens(nil, "any-model")
	if result != nil {
		t.Error("nil input should return nil")
	}
}

func TestGetModelLimits_ExactMatch(t *testing.T) {
	setCache(map[string]ModelLimits{
		"deepseek-r1": {MaxOutputTokens: intPtr(8192)},
	})

	ml := GetModelLimits("deepseek-r1")
	if ml == nil {
		t.Fatal("should find exact match")
	}
	if *ml.MaxOutputTokens != 8192 {
		t.Error("wrong limit value")
	}
}

func TestGetModelLimits_PrefixMatch(t *testing.T) {
	setCache(map[string]ModelLimits{
		"deepseek": {MaxOutputTokens: intPtr(8192)},
	})

	ml := GetModelLimits("deepseek-r1-distill-qwen-32b")
	if ml == nil {
		t.Fatal("should find prefix match")
	}
	if *ml.MaxOutputTokens != 8192 {
		t.Error("wrong limit value for prefix match")
	}
}

func TestGetModelLimits_NoMatch(t *testing.T) {
	setCache(map[string]ModelLimits{
		"deepseek": {MaxOutputTokens: intPtr(8192)},
	})

	ml := GetModelLimits("claude-sonnet-4-20250514")
	if ml != nil {
		t.Error("should not match unrelated model")
	}
}

func TestGetAllModelLimits(t *testing.T) {
	setCache(map[string]ModelLimits{
		"model-a": {MaxOutputTokens: intPtr(100)},
		"model-b": {MaxOutputTokens: intPtr(200)},
	})

	all := GetAllModelLimits()
	if len(all) != 2 {
		t.Errorf("expected 2 limits, got %d", len(all))
	}
}
