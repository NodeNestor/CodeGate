package ratelimit

import "testing"

func TestCheckAndRecord_UnderLimit(t *testing.T) {
	Clear("test-acct")

	rejected := CheckAndRecord("test-acct", 10)
	if rejected {
		t.Error("first request should not be rejected")
	}
}

func TestCheckAndRecord_AtLimit(t *testing.T) {
	Clear("test-limit")

	for i := 0; i < 5; i++ {
		CheckAndRecord("test-limit", 5)
	}

	rejected := CheckAndRecord("test-limit", 5)
	if !rejected {
		t.Error("should be rejected at limit")
	}
}

func TestCheckAndRecord_NoLimit(t *testing.T) {
	Clear("test-nolimit")
	rejected := CheckAndRecord("test-nolimit", 0)
	if rejected {
		t.Error("zero limit should never reject")
	}
}

func TestIsRateLimited_NoRecord(t *testing.T) {
	Clear("test-readonly")

	// Record some requests
	CheckAndRecord("test-readonly", 5)
	CheckAndRecord("test-readonly", 5)

	// IsRateLimited should check without recording
	limited := IsRateLimited("test-readonly", 5)
	if limited {
		t.Error("2 of 5 should not be limited")
	}
}

func TestClear(t *testing.T) {
	Clear("test-clear")

	for i := 0; i < 5; i++ {
		CheckAndRecord("test-clear", 5)
	}

	// Should be at limit
	if !CheckAndRecord("test-clear", 5) {
		t.Error("should be at limit before clear")
	}

	Clear("test-clear")

	// Should be under limit after clear
	if CheckAndRecord("test-clear", 5) {
		t.Error("should not be limited after clear")
	}
}
