/**
 * Simple in-memory sliding-window rate limiter per account.
 */

interface RateWindow {
  timestamps: number[];
}

const windows = new Map<string, RateWindow>();

/**
 * Check if an account is currently rate-limited.
 * Does NOT consume a request slot -- use recordRequest() for that.
 */
export function isRateLimited(accountId: string, rateLimit: number): boolean {
  if (rateLimit <= 0) return false;

  const now = Date.now();
  const windowMs = 60_000; // 1-minute sliding window
  const window = windows.get(accountId);

  if (!window) return false;

  // Prune old timestamps
  const cutoff = now - windowMs;
  const recent = window.timestamps.filter((t) => t > cutoff);
  window.timestamps = recent;

  return recent.length >= rateLimit;
}

/**
 * Record a request for rate-limiting purposes.
 */
export function recordRequest(accountId: string): void {
  const now = Date.now();
  let window = windows.get(accountId);
  if (!window) {
    window = { timestamps: [] };
    windows.set(accountId, window);
  }
  window.timestamps.push(now);

  // Prune timestamps older than 1 minute to avoid memory growth
  const cutoff = now - 60_000;
  window.timestamps = window.timestamps.filter((t) => t > cutoff);
}

/**
 * Get the current request count for an account within the window.
 */
export function getRequestCount(accountId: string): number {
  const now = Date.now();
  const windowMs = 60_000;
  const window = windows.get(accountId);
  if (!window) return 0;

  const cutoff = now - windowMs;
  return window.timestamps.filter((t) => t > cutoff).length;
}

/**
 * Clear rate limit state for an account (e.g., on account deletion).
 */
export function clearRateLimit(accountId: string): void {
  windows.delete(accountId);
}
