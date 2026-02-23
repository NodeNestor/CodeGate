package tenant

import (
	"codegate-proxy/internal/db"
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"
)

// Tenant represents a resolved tenant from the database.
type Tenant struct {
	ID        string
	Name      string
	ConfigID  string            // "" = use global active config
	RateLimit int               // 0 = no tenant-level limit
	Settings  map[string]string // cached tenant_settings
}

type cachedTenant struct {
	tenant    *Tenant
	expiresAt time.Time
}

type cachedBool struct {
	value     bool
	expiresAt time.Time
}

var (
	cacheMu        sync.RWMutex
	tenantCache    = make(map[string]*cachedTenant)
	hasTenantsMu   sync.RWMutex
	hasTenantsCached *cachedBool
)

const cacheTTL = 30 * time.Second

// Resolve looks up a tenant by raw API key.
// Returns nil if no matching tenant found or if tenants table doesn't exist.
func Resolve(rawAPIKey string) *Tenant {
	hash := hashKey(rawAPIKey)

	cacheMu.RLock()
	if cached, ok := tenantCache[hash]; ok && time.Now().Before(cached.expiresAt) {
		cacheMu.RUnlock()
		if cached.tenant == nil {
			return nil
		}
		t := *cached.tenant
		settings := make(map[string]string, len(cached.tenant.Settings))
		for k, v := range cached.tenant.Settings {
			settings[k] = v
		}
		t.Settings = settings
		return &t
	}
	cacheMu.RUnlock()

	row := db.GetTenantByKeyHash(hash)
	if row == nil {
		cacheMu.Lock()
		tenantCache[hash] = &cachedTenant{tenant: nil, expiresAt: time.Now().Add(cacheTTL)}
		cacheMu.Unlock()
		return nil
	}

	settings := db.GetTenantSettings(row.ID)

	t := &Tenant{
		ID:        row.ID,
		Name:      row.Name,
		ConfigID:  row.ConfigID,
		RateLimit: row.RateLimit,
		Settings:  settings,
	}

	cacheMu.Lock()
	tenantCache[hash] = &cachedTenant{tenant: t, expiresAt: time.Now().Add(cacheTTL)}
	cacheMu.Unlock()

	result := *t
	settingsCopy := make(map[string]string, len(settings))
	for k, v := range settings {
		settingsCopy[k] = v
	}
	result.Settings = settingsCopy
	return &result
}

// GetSetting returns a tenant-specific setting, falling back to the global setting.
func GetSetting(t *Tenant, key string) string {
	if t != nil && t.Settings != nil {
		if v, ok := t.Settings[key]; ok {
			return v
		}
	}
	return db.GetSetting(key)
}

// HasTenants returns true if any tenants exist in the database.
func HasTenants() bool {
	hasTenantsMu.RLock()
	if hasTenantsCached != nil && time.Now().Before(hasTenantsCached.expiresAt) {
		val := hasTenantsCached.value
		hasTenantsMu.RUnlock()
		return val
	}
	hasTenantsMu.RUnlock()

	val := db.HasTenants()

	hasTenantsMu.Lock()
	hasTenantsCached = &cachedBool{value: val, expiresAt: time.Now().Add(cacheTTL)}
	hasTenantsMu.Unlock()

	return val
}

func hashKey(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(h[:])
}
