/**
 * Smart Provider Cooldown Manager.
 *
 * Tracks per-account cooldowns with adaptive durations:
 *   - Honors Retry-After header from upstream providers
 *   - Exponential backoff for repeated failures: 15s * 2^failures, capped at 300s
 *   - Clears on success (resets consecutive failure count)
 *   - In-memory only — resets on restart (transient state)
 */

interface CooldownEntry {
  until: number; // timestamp ms
  reason: string;
  consecutiveFailures: number;
}

const cooldowns = new Map<string, CooldownEntry>();

const BASE_COOLDOWN_SEC = 15;
const MAX_COOLDOWN_SEC = 300; // 5 minutes
const DEFAULT_RETRY_AFTER_SEC = 60;

/**
 * Set a cooldown for an account.
 * Uses Retry-After if provided, otherwise exponential backoff.
 */
export function setCooldown(
  accountId: string,
  reason: string,
  retryAfterSec?: number
): void {
  const existing = cooldowns.get(accountId);
  const failures = (existing?.consecutiveFailures ?? 0) + 1;

  let durationSec: number;
  if (retryAfterSec != null && retryAfterSec > 0) {
    durationSec = retryAfterSec;
  } else {
    // Exponential backoff: 15, 30, 60, 120, 300 (capped)
    durationSec = Math.min(BASE_COOLDOWN_SEC * Math.pow(2, failures - 1), MAX_COOLDOWN_SEC);
  }

  cooldowns.set(accountId, {
    until: Date.now() + durationSec * 1000,
    reason,
    consecutiveFailures: failures,
  });

  console.log(
    `[cooldown] Account ${accountId} cooled down for ${durationSec}s (${reason}, failures=${failures})`
  );
}

/**
 * Check whether an account is currently on cooldown.
 * Auto-expires stale entries.
 */
export function isOnCooldown(accountId: string): boolean {
  const entry = cooldowns.get(accountId);
  if (!entry) return false;
  if (Date.now() >= entry.until) {
    cooldowns.delete(accountId);
    return false;
  }
  return true;
}

/**
 * Clear cooldown on success — resets consecutive failure count.
 */
export function clearCooldown(accountId: string): void {
  cooldowns.delete(accountId);
}

/**
 * Sort candidates so non-cooled-down accounts come first,
 * then cooled-down accounts sorted by earliest expiry.
 * Preserves original order within each group.
 */
export function sortByCooldown<T extends { account: { id: string } }>(
  candidates: T[]
): T[] {
  const now = Date.now();
  return [...candidates].sort((a, b) => {
    const cdA = cooldowns.get(a.account.id);
    const cdB = cooldowns.get(b.account.id);
    const cooledA = cdA && cdA.until > now;
    const cooledB = cdB && cdB.until > now;

    if (!cooledA && !cooledB) return 0; // both available — keep original order
    if (!cooledA) return -1; // a is available, b is cooled
    if (!cooledB) return 1; // b is available, a is cooled
    return cdA!.until - cdB!.until; // both cooled — earliest expiry first
  });
}

/**
 * Get all current cooldowns (for debug/status API).
 */
export function getAllCooldowns(): Record<
  string,
  { until: string; reason: string; consecutiveFailures: number; remainingSec: number }
> {
  const now = Date.now();
  const result: Record<
    string,
    { until: string; reason: string; consecutiveFailures: number; remainingSec: number }
  > = {};

  for (const [id, entry] of cooldowns) {
    if (entry.until > now) {
      result[id] = {
        until: new Date(entry.until).toISOString(),
        reason: entry.reason,
        consecutiveFailures: entry.consecutiveFailures,
        remainingSec: Math.ceil((entry.until - now) / 1000),
      };
    } else {
      cooldowns.delete(id); // cleanup expired
    }
  }
  return result;
}

/**
 * Parse Retry-After header value to seconds.
 * Handles numeric seconds and HTTP-date formats.
 * Returns undefined for unparseable values.
 */
export function parseRetryAfter(headerValue: string | undefined | null): number | undefined {
  if (!headerValue) return undefined;

  const num = Number(headerValue);
  if (!isNaN(num) && num > 0) return num;

  // Try HTTP-date format
  const date = Date.parse(headerValue);
  if (!isNaN(date)) {
    const sec = Math.ceil((date - Date.now()) / 1000);
    return sec > 0 ? sec : DEFAULT_RETRY_AFTER_SEC;
  }

  return DEFAULT_RETRY_AFTER_SEC;
}
