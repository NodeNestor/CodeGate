package ratelimit

import (
	"sync"
	"time"
)

const windowDuration = time.Minute

type window struct {
	mu         sync.Mutex
	timestamps []int64
}

var (
	mu      sync.RWMutex
	windows = make(map[string]*window)
)

func getWindow(accountID string) *window {
	mu.RLock()
	w, ok := windows[accountID]
	mu.RUnlock()
	if ok {
		return w
	}

	mu.Lock()
	defer mu.Unlock()
	w, ok = windows[accountID]
	if ok {
		return w
	}
	w = &window{}
	windows[accountID] = w
	return w
}

// CheckAndRecord atomically checks the rate limit and records the request.
// Returns true if the request is rate-limited (rejected).
func CheckAndRecord(accountID string, rateLimit int) bool {
	if rateLimit <= 0 {
		return false
	}

	w := getWindow(accountID)
	w.mu.Lock()
	defer w.mu.Unlock()

	now := time.Now().UnixMilli()
	cutoff := now - windowDuration.Milliseconds()

	// Prune old timestamps
	pruned := w.timestamps[:0]
	for _, t := range w.timestamps {
		if t > cutoff {
			pruned = append(pruned, t)
		}
	}
	w.timestamps = pruned

	if len(w.timestamps) >= rateLimit {
		return true
	}

	w.timestamps = append(w.timestamps, now)
	return false
}

// IsRateLimited checks if an account is rate-limited without recording.
func IsRateLimited(accountID string, rateLimit int) bool {
	if rateLimit <= 0 {
		return false
	}

	w := getWindow(accountID)
	w.mu.Lock()
	defer w.mu.Unlock()

	now := time.Now().UnixMilli()
	cutoff := now - windowDuration.Milliseconds()

	count := 0
	for _, t := range w.timestamps {
		if t > cutoff {
			count++
		}
	}
	return count >= rateLimit
}

// Clear removes rate limit state for an account.
func Clear(accountID string) {
	mu.Lock()
	defer mu.Unlock()
	delete(windows, accountID)
}
