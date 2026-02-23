package cooldown

import (
	"log"
	"math"
	"strconv"
	"sync"
	"time"
)

const (
	baseCooldownSec      = 15
	maxCooldownSec       = 300
	defaultRetryAfterSec = 60
)

type entry struct {
	until               time.Time
	reason              string
	consecutiveFailures int
}

var (
	mu        sync.RWMutex
	cooldowns = make(map[string]*entry)
)

// Set sets a cooldown for an account.
func Set(accountID, reason string, retryAfterSec int) {
	mu.Lock()
	defer mu.Unlock()

	existing := cooldowns[accountID]
	failures := 1
	if existing != nil {
		failures = existing.consecutiveFailures + 1
	}

	var durationSec int
	if retryAfterSec > 0 {
		durationSec = retryAfterSec
	} else {
		durationSec = int(math.Min(
			float64(baseCooldownSec)*math.Pow(2, float64(failures-1)),
			float64(maxCooldownSec),
		))
	}

	cooldowns[accountID] = &entry{
		until:               time.Now().Add(time.Duration(durationSec) * time.Second),
		reason:              reason,
		consecutiveFailures: failures,
	}

	log.Printf("[cooldown] Account %s cooled down for %ds (%s, failures=%d)", accountID, durationSec, reason, failures)
}

// IsOnCooldown checks if an account is currently cooled down.
func IsOnCooldown(accountID string) bool {
	mu.RLock()
	e := cooldowns[accountID]
	mu.RUnlock()

	if e == nil {
		return false
	}
	if time.Now().After(e.until) {
		mu.Lock()
		delete(cooldowns, accountID)
		mu.Unlock()
		return false
	}
	return true
}

// Clear clears cooldown for an account on success.
func Clear(accountID string) {
	mu.Lock()
	defer mu.Unlock()
	delete(cooldowns, accountID)
}

// CooldownUntil returns the cooldown expiry for sorting. Zero time if not on cooldown.
func CooldownUntil(accountID string) time.Time {
	mu.RLock()
	defer mu.RUnlock()
	e := cooldowns[accountID]
	if e == nil || time.Now().After(e.until) {
		return time.Time{}
	}
	return e.until
}

// ParseRetryAfter parses a Retry-After header value to seconds.
func ParseRetryAfter(headerValue string) int {
	if headerValue == "" {
		return 0
	}

	if n, err := strconv.Atoi(headerValue); err == nil && n > 0 {
		return n
	}

	if t, err := time.Parse(time.RFC1123, headerValue); err == nil {
		sec := int(time.Until(t).Seconds())
		if sec > 0 {
			return sec
		}
		return defaultRetryAfterSec
	}

	return defaultRetryAfterSec
}
