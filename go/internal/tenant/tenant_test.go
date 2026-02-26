package tenant

import (
	"testing"
)

func TestHashKey(t *testing.T) {
	hash1 := hashKey("cgk_abc123")
	hash2 := hashKey("cgk_abc123")
	hash3 := hashKey("cgk_different")

	if hash1 != hash2 {
		t.Error("same input should produce same hash")
	}
	if hash1 == hash3 {
		t.Error("different inputs should produce different hashes")
	}
	if len(hash1) != 64 {
		t.Errorf("SHA256 hex should be 64 chars, got %d", len(hash1))
	}
}

func TestGetSetting_NilTenant(t *testing.T) {
	// GetSetting with nil tenant should not panic
	// It will fall back to db.GetSetting which returns "" when DB is nil
	result := GetSetting(nil, "some_key")
	if result != "" {
		t.Errorf("expected empty string for nil tenant with no DB, got %q", result)
	}
}

func TestGetSetting_WithTenantOverride(t *testing.T) {
	tenant := &Tenant{
		ID:   "t1",
		Name: "Test Tenant",
		Settings: map[string]string{
			"guardrails_enabled": "true",
			"auto_switch_on_error": "false",
		},
	}

	// Tenant-scoped settings should override
	if v := GetSetting(tenant, "guardrails_enabled"); v != "true" {
		t.Errorf("expected 'true', got %q", v)
	}
	if v := GetSetting(tenant, "auto_switch_on_error"); v != "false" {
		t.Errorf("expected 'false', got %q", v)
	}

	// Non-existent tenant setting falls back to db.GetSetting (returns "" with no DB)
	if v := GetSetting(tenant, "nonexistent"); v != "" {
		t.Errorf("expected '', got %q", v)
	}
}

func TestGetSetting_EmptySettings(t *testing.T) {
	tenant := &Tenant{
		ID:       "t2",
		Name:     "Empty",
		Settings: map[string]string{},
	}

	// Should fall back to global (empty with no DB)
	if v := GetSetting(tenant, "any_key"); v != "" {
		t.Errorf("expected '', got %q", v)
	}
}

func TestHasTenants_NoDB(t *testing.T) {
	// Without a DB connection, HasTenants should return false
	result := HasTenants()
	if result {
		t.Error("expected false when DB is not open")
	}
}

func TestResolve_NoDB(t *testing.T) {
	// Without a DB connection, Resolve should return nil
	result := Resolve("cgk_some_api_key")
	if result != nil {
		t.Error("expected nil when DB is not open")
	}
}
