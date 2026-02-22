/**
 * Simple in-memory sliding-window rate limiter per account.
 */

interface RateWindow {
  timestamps: number[];
}

const windows = new Map<string, RateWindow>();

const WINDOW_MS = 60_000; // 1-minute sliding window

/**
 * Atomically check rate limit AND record the request in one step.
 * Returns true if the request is rate-limited (rejected), false if allowed.
 *
 * This eliminates the TOCTOU race between checking and recording that
 * existed when isRateLimited() and recordRequest() were separate calls.
 */
export function checkAndRecordRequest(accountId: string, rateLimit: number): boolean {
  if (rateLimit <= 0) return false;

  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  let window = windows.get(accountId);
  if (!window) {
    window = { timestamps: [] };
    windows.set(accountId, window);
  }

  // Prune old timestamps
  window.timestamps = window.timestamps.filter((t) => t > cutoff);

  // Check limit THEN record atomically (no async gap between check and record)
  if (window.timestamps.length >= rateLimit) {
    return true; // rate limited, do NOT record
  }

  window.timestamps.push(now);
  return false; // allowed
}

/**
 * Check if an account is currently rate-limited WITHOUT recording.
 * Used for pre-filtering candidates in config-manager (read-only check).
 */
export function isRateLimited(accountId: string, rateLimit: number): boolean {
  if (rateLimit <= 0) return false;

  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const window = windows.get(accountId);
  if (!window) return false;

  const recent = window.timestamps.filter((t) => t > cutoff);
  return recent.length >= rateLimit;
}

/**
 * Get the current request count for an account within the window.
 */
export function getRequestCount(accountId: string): number {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const window = windows.get(accountId);
  if (!window) return 0;

  return window.timestamps.filter((t) => t > cutoff).length;
}

/**
 * Clear rate limit state for an account (e.g., on account deletion).
 */
export function clearRateLimit(accountId: string): void {
  windows.delete(accountId);
}
