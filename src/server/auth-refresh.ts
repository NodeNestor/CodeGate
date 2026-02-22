/**
 * OAuth token refresh for subscription-based LLM accounts.
 *
 * Two refresh strategies:
 *   1. File-based: For the ONE account whose token matches the host credential
 *      file (Claude Code CLI manages rotation, we just read the latest).
 *   2. Direct refresh: For all other OAuth accounts, refresh tokens directly
 *      with Anthropic's OAuth endpoint. This is safe because these tokens are
 *      NOT managed by a running Claude Code CLI instance.
 *
 * Credential file paths:
 *   - Read-only:  /host-claude/.credentials.json
 *
 * A background refresh loop checks all OAuth accounts periodically and
 * refreshes ones nearing expiry.
 */

import { readFileSync } from "node:fs";
import {
  getAccount,
  getOAuthAccounts,
  updateAccountTokens,
  updateAccountStatus,
  type AccountDecrypted,
} from "./db.js";

/** Refresh tokens 5 minutes before expiry */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Cache of in-flight refresh promises to avoid duplicate refreshes */
const refreshInFlight = new Map<string, Promise<AccountDecrypted>>();

/** Path to Claude Code's credential file (mounted from host) */
const CRED_FILE = process.env.CLAUDE_CREDENTIALS_FILE || "/host-claude/.credentials.json";

/** Anthropic OAuth client ID */
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/** Anthropic OAuth token endpoint */
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";

/** Cache the last-read credential file to avoid excessive disk reads */
let credFileCache: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} | null = null;
let credFileCacheTime = 0;
const CRED_CACHE_TTL_MS = 5_000; // re-read file at most every 5 seconds

/** Reference to the background refresh interval */
let refreshInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Read fresh tokens from Claude Code's credential file.
 */
function readCredentialFile(): {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} | null {
  const now = Date.now();
  if (credFileCache && now - credFileCacheTime < CRED_CACHE_TTL_MS) {
    return credFileCache;
  }

  try {
    const raw = readFileSync(CRED_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const oauth = parsed.claudeAiOauth;
    if (oauth?.accessToken) {
      credFileCache = {
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt,
      };
      credFileCacheTime = now;
      return credFileCache;
    }
  } catch {
    // File not available -- this is expected in non-Docker environments
  }
  return null;
}

/**
 * Check if an account's token matches the host credential file.
 * If so, this account should use file-based refresh (managed by Claude Code CLI).
 */
function isHostAccount(account: AccountDecrypted): boolean {
  const fileCreds = readCredentialFile();
  if (!fileCreds) return false;
  // Compare by access token -- if it matches the file, it's the host account
  return account.api_key === fileCreds.accessToken;
}

/**
 * Check if an account's token needs refreshing.
 */
export function needsRefresh(account: AccountDecrypted): boolean {
  if (account.auth_type !== "oauth") return false;
  if (!account.token_expires_at) return false;

  const now = Date.now();
  return now >= account.token_expires_at - REFRESH_MARGIN_MS;
}

/**
 * Ensure the account has a valid token.
 * Uses file-based sync for the host account, direct refresh for others.
 * Coalesces concurrent refresh attempts for the same account.
 */
export async function ensureValidToken(
  account: AccountDecrypted
): Promise<AccountDecrypted> {
  if (!needsRefresh(account)) return account;

  // Coalesce concurrent refreshes for the same account
  const existing = refreshInFlight.get(account.id);
  if (existing) return existing;

  const promise = doRefresh(account).finally(() => {
    refreshInFlight.delete(account.id);
  });

  refreshInFlight.set(account.id, promise);
  return promise;
}

/**
 * Refresh an account's token using the appropriate strategy.
 */
async function doRefresh(account: AccountDecrypted): Promise<AccountDecrypted> {
  // Strategy 1: If this account matches the host credential file, sync from file
  if (isHostAccount(account)) {
    return doFileRefresh(account);
  }

  // Strategy 2: Direct refresh with Anthropic's OAuth endpoint
  if (account.refresh_token) {
    try {
      return await refreshTokenDirectly(account);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[auth-refresh] Direct refresh failed for "${account.name}": ${msg}`
      );
      // Fall through to file-based as a last resort
    }
  }

  // Fallback: try file-based refresh
  return doFileRefresh(account);
}

/**
 * Sync tokens from the credential file.
 * Used for the account that matches the host Claude Code CLI's tokens.
 */
function doFileRefresh(account: AccountDecrypted): AccountDecrypted {
  const fileCreds = readCredentialFile();
  if (!fileCreds) {
    console.warn(
      `[auth-refresh] Credential file not available for "${account.name}", cannot refresh`
    );
    return account;
  }

  if (fileCreds.accessToken !== account.api_key) {
    console.log(
      `[auth-refresh] Syncing fresh token from Claude Code credential file for "${account.name}"`
    );
    updateAccountTokens(
      account.id,
      fileCreds.accessToken,
      fileCreds.refreshToken,
      fileCreds.expiresAt
    );
    console.log(
      `[auth-refresh] Token synced for "${account.name}", expires at ${new Date(fileCreds.expiresAt).toISOString()}`
    );
    return getAccount(account.id) || account;
  }

  // File tokens are the same -- nothing to do
  console.log(
    `[auth-refresh] Token for "${account.name}" matches credential file -- waiting for Claude Code to refresh`
  );
  return account;
}

/**
 * Refresh an OAuth token directly with Anthropic's token endpoint.
 * Used for accounts that are NOT the currently active Claude Code session.
 */
export async function refreshTokenDirectly(
  account: AccountDecrypted
): Promise<AccountDecrypted> {
  if (!account.refresh_token) {
    throw new Error("No refresh token available");
  }

  console.log(
    `[auth-refresh] Refreshing token directly with Anthropic for "${account.name}"`
  );

  const response = await fetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: account.refresh_token,
      client_id: ANTHROPIC_CLIENT_ID,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 400) {
      updateAccountStatus(account.id, "expired", `Refresh token rejected: ${response.status}`);
    }
    throw new Error(
      `Token refresh failed (${response.status}): ${errorText}`
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const expiresAt = data.expires_in
    ? Date.now() + data.expires_in * 1000
    : Date.now() + 3600 * 1000; // Default 1 hour

  updateAccountTokens(
    account.id,
    data.access_token,
    data.refresh_token || account.refresh_token,
    expiresAt
  );

  console.log(
    `[auth-refresh] Token refreshed for "${account.name}", expires at ${new Date(expiresAt).toISOString()}`
  );

  return getAccount(account.id) || account;
}

/**
 * Force sync tokens from the credential file.
 * Used when a 401 is received -- always re-reads the file (bypassing cache).
 */
export function forceSyncFromFile(
  account: AccountDecrypted
): AccountDecrypted | null {
  // Invalidate cache to force fresh read
  credFileCacheTime = 0;
  const fileCreds = readCredentialFile();
  if (!fileCreds) return null;

  // Only update if the token is actually different
  if (fileCreds.accessToken !== account.api_key) {
    console.log(
      `[auth-refresh] Force-syncing fresh token from credential file for "${account.name}"`
    );
    updateAccountTokens(
      account.id,
      fileCreds.accessToken,
      fileCreds.refreshToken,
      fileCreds.expiresAt
    );
    return getAccount(account.id) || null;
  }
  return null;
}

/**
 * Start a background loop that checks all OAuth accounts and refreshes
 * tokens that are nearing expiry.
 *
 * @param intervalMs - How often to check (default: 15 minutes)
 */
export function startTokenRefreshLoop(intervalMs = 15 * 60 * 1000): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }

  async function refreshAll() {
    try {
      const accounts = getOAuthAccounts();
      for (const account of accounts) {
        if (needsRefresh(account)) {
          try {
            await ensureValidToken(account);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `[auth-refresh] Background refresh failed for "${account.name}": ${msg}`
            );
          }
        }
      }
    } catch (err) {
      console.error("[auth-refresh] Background refresh loop error:", err);
    }
  }

  // Run immediately on startup, then at interval
  refreshAll();
  refreshInterval = setInterval(refreshAll, intervalMs);

  console.log(
    `[auth-refresh] Token refresh loop started (interval: ${intervalMs / 1000}s)`
  );
}
