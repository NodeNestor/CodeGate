import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { v4 as uuidv4 } from "uuid";
import { encrypt, decrypt, tryDecrypt, decryptWithKey, encryptWithKey } from "./encryption.js";

const DATA_DIR = process.env.DATA_DIR || "./data";
const DB_PATH = path.join(DATA_DIR, "codegate.db");

let db: Database.Database;

// ─── Cost table for usage estimation ────────────────────────────────────────

const COST_TABLE: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6-20250219": { input: 15.0, output: 75.0 },
  "claude-sonnet-4-6-20250219": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 0.25, output: 1.25 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "o3": { input: 10.0, output: 40.0 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "deepseek/deepseek-r1": { input: 0.55, output: 2.19 },
  "deepseek-r1": { input: 0.55, output: 2.19 },
  default: { input: 2.0, output: 8.0 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates = COST_TABLE[model] || COST_TABLE["default"];
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Account {
  id: string;
  name: string;
  provider: string;
  auth_type: string;
  api_key_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: number | null;
  base_url: string | null;
  priority: number;
  rate_limit: number;
  monthly_budget: number | null;
  enabled: number;
  subscription_type: string | null;
  account_email: string | null;
  external_account_id: string | null;
  last_used_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  error_count: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AccountDecrypted extends Omit<Account, "api_key_enc" | "refresh_token_enc"> {
  api_key: string | null;
  refresh_token: string | null;
  external_account_id: string | null;
  decrypt_error?: boolean;
}

export type AccountStatus = "unknown" | "active" | "expired" | "error" | "rate_limited";

export interface Config {
  id: string;
  name: string;
  description: string | null;
  is_active: number;
  routing_strategy: string;
  created_at: string;
}

export interface ConfigTier {
  id: string;
  config_id: string;
  tier: string;
  account_id: string;
  priority: number;
  target_model: string | null;
}

export interface PrivacyMapping {
  id: string;
  category: string;
  original_hash: string;
  original_enc: string;
  replacement: string;
  created_at: string;
}

export interface UsageRecord {
  id: string;
  account_id: string | null;
  config_id: string | null;
  tier: string | null;
  original_model: string | null;
  routed_model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  created_at: string;
}

export interface UsageInput {
  account_id?: string;
  config_id?: string;
  tier?: string;
  original_model?: string;
  routed_model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd?: number;
}

export interface UsageStatsOpts {
  from?: string;
  to?: string;
  groupBy?: "model" | "account" | "tier" | "hour" | "day";
  limit?: number;
}

export interface Session {
  id: string;
  container_id: string | null;
  name: string;
  status: string;
  port: number | null;
  account_id: string | null;
  created_at: string;
  last_active_at: string;
}

// ─── Init ───────────────────────────────────────────────────────────────────

export function initDB(): Database.Database {
  if (db) return db;

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      auth_type TEXT NOT NULL DEFAULT 'api_key',
      api_key_enc TEXT,
      refresh_token_enc TEXT,
      token_expires_at INTEGER,
      base_url TEXT,
      priority INTEGER DEFAULT 0,
      rate_limit INTEGER DEFAULT 60,
      monthly_budget REAL,
      enabled INTEGER DEFAULT 1,
      subscription_type TEXT,
      account_email TEXT,
      last_used_at TEXT,
      last_error TEXT,
      last_error_at TEXT,
      error_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'unknown',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      is_active INTEGER DEFAULT 0,
      routing_strategy TEXT DEFAULT 'priority',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS config_tiers (
      id TEXT PRIMARY KEY,
      config_id TEXT NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
      tier TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      priority INTEGER DEFAULT 0,
      target_model TEXT
    );

    CREATE TABLE IF NOT EXISTS usage (
      id TEXT PRIMARY KEY,
      account_id TEXT REFERENCES accounts(id),
      config_id TEXT,
      tier TEXT,
      original_model TEXT,
      routed_model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS privacy_mappings (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      original_hash TEXT NOT NULL UNIQUE,
      original_enc TEXT NOT NULL,
      replacement TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      container_id TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'starting',
      port INTEGER,
      account_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_usage_account_id ON usage(account_id);
    CREATE INDEX IF NOT EXISTS idx_usage_created_at ON usage(created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_config_id ON usage(config_id);
    CREATE INDEX IF NOT EXISTS idx_config_tiers_config_id ON config_tiers(config_id);
    CREATE INDEX IF NOT EXISTS idx_config_tiers_tier ON config_tiers(tier);
    CREATE TABLE IF NOT EXISTS request_logs (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      method TEXT,
      path TEXT,
      inbound_format TEXT,
      account_id TEXT,
      account_name TEXT,
      provider TEXT,
      original_model TEXT,
      routed_model TEXT,
      status_code INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      latency_ms INTEGER,
      is_stream INTEGER DEFAULT 0,
      is_failover INTEGER DEFAULT 0,
      error_message TEXT,
      request_body TEXT,
      response_body TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_privacy_hash ON privacy_mappings(original_hash);
    CREATE INDEX IF NOT EXISTS idx_privacy_replacement ON privacy_mappings(replacement);
    CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON request_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_request_logs_status ON request_logs(status_code);
  `);

  // Migrations for existing databases
  const cols = db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("last_used_at")) db.exec("ALTER TABLE accounts ADD COLUMN last_used_at TEXT");
  if (!colNames.has("last_error")) db.exec("ALTER TABLE accounts ADD COLUMN last_error TEXT");
  if (!colNames.has("last_error_at")) db.exec("ALTER TABLE accounts ADD COLUMN last_error_at TEXT");
  if (!colNames.has("error_count")) db.exec("ALTER TABLE accounts ADD COLUMN error_count INTEGER DEFAULT 0");
  if (!colNames.has("status")) db.exec("ALTER TABLE accounts ADD COLUMN status TEXT DEFAULT 'unknown'");
  if (!colNames.has("external_account_id")) db.exec("ALTER TABLE accounts ADD COLUMN external_account_id TEXT");

  // Session table migrations
  const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  const sessionColNames = new Set(sessionCols.map((c) => c.name));
  if (!sessionColNames.has("account_id")) db.exec("ALTER TABLE sessions ADD COLUMN account_id TEXT");

  return db;
}

function getDB(): Database.Database {
  if (!db) throw new Error("Database not initialized. Call initDB() first.");
  return db;
}

export const getDb = getDB;

// ─── Helper: decrypt account row ────────────────────────────────────────────

function decryptAccount(row: Account): AccountDecrypted {
  const { api_key_enc, refresh_token_enc, ...rest } = row;
  const api_key = api_key_enc ? tryDecrypt(api_key_enc) : null;
  const refresh_token = refresh_token_enc ? tryDecrypt(refresh_token_enc) : null;
  const decrypt_error =
    (api_key_enc !== null && api_key === null) ||
    (refresh_token_enc !== null && refresh_token === null);
  return {
    ...rest,
    api_key,
    refresh_token,
    ...(decrypt_error ? { decrypt_error: true } : {}),
  };
}

// ─── Account CRUD ───────────────────────────────────────────────────────────

export function getAccounts(): AccountDecrypted[] {
  const d = getDB();
  const rows = d.prepare("SELECT * FROM accounts ORDER BY priority DESC, name ASC").all() as Account[];
  return rows.map(decryptAccount);
}

export function getAccount(id: string): AccountDecrypted | undefined {
  const d = getDB();
  const row = d.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Account | undefined;
  return row ? decryptAccount(row) : undefined;
}

export function getEnabledAccounts(): AccountDecrypted[] {
  const d = getDB();
  const rows = d
    .prepare("SELECT * FROM accounts WHERE enabled = 1 ORDER BY priority DESC, name ASC")
    .all() as Account[];
  return rows.map(decryptAccount);
}

export function createAccount(data: {
  name: string;
  provider: string;
  auth_type?: string;
  api_key?: string;
  refresh_token?: string;
  token_expires_at?: number;
  base_url?: string;
  priority?: number;
  rate_limit?: number;
  monthly_budget?: number;
  enabled?: number;
  subscription_type?: string;
  account_email?: string;
  external_account_id?: string;
}): AccountDecrypted {
  const d = getDB();
  const id = uuidv4();
  const apiKeyEnc = data.api_key ? encrypt(data.api_key) : null;
  const refreshTokenEnc = data.refresh_token ? encrypt(data.refresh_token) : null;

  d.prepare(
    `INSERT INTO accounts (id, name, provider, auth_type, api_key_enc, refresh_token_enc, token_expires_at, base_url, priority, rate_limit, monthly_budget, enabled, subscription_type, account_email, external_account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, data.name, data.provider, data.auth_type || "api_key",
    apiKeyEnc, refreshTokenEnc, data.token_expires_at ?? null,
    data.base_url ?? null, data.priority ?? 0, data.rate_limit ?? 60,
    data.monthly_budget ?? null, data.enabled ?? 1,
    data.subscription_type ?? null, data.account_email ?? null,
    data.external_account_id ?? null
  );

  return getAccount(id)!;
}

export function updateAccount(
  id: string,
  updates: Partial<{
    name: string; provider: string; auth_type: string;
    api_key: string; refresh_token: string; token_expires_at: number | null;
    base_url: string | null; priority: number; rate_limit: number;
    monthly_budget: number | null; enabled: number;
    subscription_type: string | null; account_email: string | null;
    external_account_id: string | null;
  }>
): AccountDecrypted | undefined {
  const d = getDB();
  const existing = d.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Account | undefined;
  if (!existing) return undefined;

  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) { sets.push("name = ?"); values.push(updates.name); }
  if (updates.provider !== undefined) { sets.push("provider = ?"); values.push(updates.provider); }
  if (updates.auth_type !== undefined) { sets.push("auth_type = ?"); values.push(updates.auth_type); }
  if (updates.api_key !== undefined) { sets.push("api_key_enc = ?"); values.push(encrypt(updates.api_key)); }
  if (updates.refresh_token !== undefined) { sets.push("refresh_token_enc = ?"); values.push(encrypt(updates.refresh_token)); }
  if (updates.token_expires_at !== undefined) { sets.push("token_expires_at = ?"); values.push(updates.token_expires_at); }
  if (updates.base_url !== undefined) { sets.push("base_url = ?"); values.push(updates.base_url); }
  if (updates.priority !== undefined) { sets.push("priority = ?"); values.push(updates.priority); }
  if (updates.rate_limit !== undefined) { sets.push("rate_limit = ?"); values.push(updates.rate_limit); }
  if (updates.monthly_budget !== undefined) { sets.push("monthly_budget = ?"); values.push(updates.monthly_budget); }
  if (updates.enabled !== undefined) { sets.push("enabled = ?"); values.push(updates.enabled); }
  if (updates.subscription_type !== undefined) { sets.push("subscription_type = ?"); values.push(updates.subscription_type); }
  if (updates.account_email !== undefined) { sets.push("account_email = ?"); values.push(updates.account_email); }
  if (updates.external_account_id !== undefined) { sets.push("external_account_id = ?"); values.push(updates.external_account_id); }

  if (sets.length === 0) return getAccount(id);

  sets.push("updated_at = datetime('now')");
  values.push(id);
  d.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return getAccount(id);
}

export function deleteAccount(id: string): boolean {
  const d = getDB();
  // Clear FK references that lack ON DELETE CASCADE
  d.prepare("UPDATE usage SET account_id = NULL WHERE account_id = ?").run(id);
  d.prepare("UPDATE sessions SET account_id = NULL WHERE account_id = ?").run(id);
  return d.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes > 0;
}

export function updateAccountTokens(id: string, accessToken: string, refreshToken: string, expiresAt: number, externalAccountId?: string): void {
  if (externalAccountId) {
    getDB().prepare(
      `UPDATE accounts SET api_key_enc = ?, refresh_token_enc = ?, token_expires_at = ?, external_account_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(encrypt(accessToken), encrypt(refreshToken), expiresAt, externalAccountId, id);
  } else {
    getDB().prepare(
      `UPDATE accounts SET api_key_enc = ?, refresh_token_enc = ?, token_expires_at = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(encrypt(accessToken), encrypt(refreshToken), expiresAt, id);
  }
}

// ─── Account Status Tracking ────────────────────────────────────────────────

export function updateAccountStatus(id: string, status: string, error?: string): void {
  const d = getDB();
  if (error) {
    d.prepare(`UPDATE accounts SET status = ?, last_error = ?, last_error_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(status, error.substring(0, 500), id);
  } else {
    d.prepare(`UPDATE accounts SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
  }
}

export function recordAccountSuccess(id: string): void {
  getDB().prepare(
    `UPDATE accounts SET status = 'active', last_used_at = datetime('now'), error_count = 0, updated_at = datetime('now') WHERE id = ?`
  ).run(id);
}

export function recordAccountError(id: string, error: string): void {
  getDB().prepare(
    `UPDATE accounts SET last_error = ?, last_error_at = datetime('now'), error_count = error_count + 1, updated_at = datetime('now') WHERE id = ?`
  ).run(error.substring(0, 500), id);
}

export function getAccountsWithDecryptErrors(): number {
  const d = getDB();
  const rows = d.prepare("SELECT api_key_enc, refresh_token_enc FROM accounts").all() as Pick<Account, "api_key_enc" | "refresh_token_enc">[];
  let count = 0;
  for (const row of rows) {
    if (row.api_key_enc && tryDecrypt(row.api_key_enc) === null) count++;
    else if (row.refresh_token_enc && tryDecrypt(row.refresh_token_enc) === null) count++;
  }
  return count;
}

export function reEncryptAllAccounts(
  oldKey: Buffer,
  newKey: Buffer
): { success: number; failed: number } {
  const d = getDB();
  const rows = d.prepare("SELECT id, api_key_enc, refresh_token_enc FROM accounts").all() as Pick<Account, "id" | "api_key_enc" | "refresh_token_enc">[];

  let success = 0;
  let failed = 0;

  const updateStmt = d.prepare(
    "UPDATE accounts SET api_key_enc = ?, refresh_token_enc = ?, updated_at = datetime('now') WHERE id = ?"
  );

  d.transaction(() => {
    for (const row of rows) {
      try {
        let newApiKeyEnc = row.api_key_enc;
        let newRefreshTokenEnc = row.refresh_token_enc;

        if (row.api_key_enc) {
          const plaintext = decryptWithKey(row.api_key_enc, oldKey);
          newApiKeyEnc = encryptWithKey(plaintext, newKey);
        }
        if (row.refresh_token_enc) {
          const plaintext = decryptWithKey(row.refresh_token_enc, oldKey);
          newRefreshTokenEnc = encryptWithKey(plaintext, newKey);
        }

        updateStmt.run(newApiKeyEnc, newRefreshTokenEnc, row.id);
        success++;
      } catch {
        failed++;
      }
    }
  })();

  return { success, failed };
}

export function getOAuthAccounts(): AccountDecrypted[] {
  const d = getDB();
  const rows = d
    .prepare("SELECT * FROM accounts WHERE auth_type = 'oauth' AND enabled = 1 ORDER BY priority DESC, name ASC")
    .all() as Account[];
  return rows.map(decryptAccount);
}

// ─── Config CRUD ────────────────────────────────────────────────────────────

export function getConfigs(): Config[] {
  return getDB().prepare("SELECT * FROM configs ORDER BY is_active DESC, name ASC").all() as Config[];
}

export function getConfig(id: string): Config | undefined {
  return getDB().prepare("SELECT * FROM configs WHERE id = ?").get(id) as Config | undefined;
}

export function getActiveConfig(): Config | undefined {
  return getDB().prepare("SELECT * FROM configs WHERE is_active = 1 LIMIT 1").get() as Config | undefined;
}

export function createConfig(data: { name: string; description?: string; is_active?: number; routing_strategy?: string }): Config {
  const d = getDB();
  const id = uuidv4();
  d.prepare(`INSERT INTO configs (id, name, description, is_active, routing_strategy) VALUES (?, ?, ?, ?, ?)`)
    .run(id, data.name, data.description ?? null, data.is_active ?? 0, data.routing_strategy ?? "priority");
  return getConfig(id)!;
}

export function updateConfig(id: string, updates: Partial<{ name: string; description: string | null; is_active: number; routing_strategy: string }>): Config | undefined {
  const d = getDB();
  if (!getConfig(id)) return undefined;
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { sets.push("name = ?"); values.push(updates.name); }
  if (updates.description !== undefined) { sets.push("description = ?"); values.push(updates.description); }
  if (updates.is_active !== undefined) { sets.push("is_active = ?"); values.push(updates.is_active); }
  if (updates.routing_strategy !== undefined) { sets.push("routing_strategy = ?"); values.push(updates.routing_strategy); }
  if (sets.length === 0) return getConfig(id);
  values.push(id);
  d.prepare(`UPDATE configs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return getConfig(id);
}

export function deleteConfig(id: string): boolean {
  return getDB().prepare("DELETE FROM configs WHERE id = ?").run(id).changes > 0;
}

export function activateConfig(id: string): Config | undefined {
  const d = getDB();
  if (!getConfig(id)) return undefined;
  d.prepare("UPDATE configs SET is_active = 0").run();
  d.prepare("UPDATE configs SET is_active = 1 WHERE id = ?").run(id);
  return getConfig(id);
}

export function getConfigTiers(configId: string): ConfigTier[] {
  return getDB()
    .prepare("SELECT * FROM config_tiers WHERE config_id = ? ORDER BY tier, priority DESC")
    .all(configId) as ConfigTier[];
}

export function setConfigTiers(configId: string, tiers: Array<{ tier: string; account_id: string; priority?: number; target_model?: string | null }>): ConfigTier[] {
  const d = getDB();
  const deleteStmt = d.prepare("DELETE FROM config_tiers WHERE config_id = ?");
  const insertStmt = d.prepare(`INSERT INTO config_tiers (id, config_id, tier, account_id, priority, target_model) VALUES (?, ?, ?, ?, ?, ?)`);
  d.transaction(() => {
    deleteStmt.run(configId);
    for (const tier of tiers) {
      insertStmt.run(uuidv4(), configId, tier.tier, tier.account_id, tier.priority ?? 0, tier.target_model ?? null);
    }
  })();
  return getConfigTiers(configId);
}

// ─── Usage ──────────────────────────────────────────────────────────────────

export function recordUsage(data: UsageInput): UsageRecord {
  const d = getDB();
  const id = uuidv4();
  const inputTokens = data.input_tokens ?? 0;
  const outputTokens = data.output_tokens ?? 0;
  const costUsd = data.cost_usd ?? estimateCost(data.routed_model || data.original_model || "default", inputTokens, outputTokens);

  d.prepare(
    `INSERT INTO usage (id, account_id, config_id, tier, original_model, routed_model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, data.account_id ?? null, data.config_id ?? null, data.tier ?? null,
    data.original_model ?? null, data.routed_model ?? null,
    inputTokens, outputTokens, data.cache_read_tokens ?? 0, data.cache_write_tokens ?? 0, costUsd);

  return d.prepare("SELECT * FROM usage WHERE id = ?").get(id) as UsageRecord;
}

export function getUsageStats(opts: UsageStatsOpts = {}): unknown[] {
  const d = getDB();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.from) { conditions.push("created_at >= ?"); params.push(opts.from); }
  if (opts.to) { conditions.push("created_at <= ?"); params.push(opts.to); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  let groupByCol: string;
  let selectCol: string;
  switch (opts.groupBy) {
    case "model": groupByCol = "routed_model"; selectCol = "routed_model AS label"; break;
    case "account": groupByCol = "account_id"; selectCol = "account_id AS label"; break;
    case "tier": groupByCol = "tier"; selectCol = "tier AS label"; break;
    case "hour": groupByCol = "strftime('%Y-%m-%d %H:00', created_at)"; selectCol = "strftime('%Y-%m-%d %H:00', created_at) AS label"; break;
    case "day": groupByCol = "strftime('%Y-%m-%d', created_at)"; selectCol = "strftime('%Y-%m-%d', created_at) AS label"; break;
    default:
      return [d.prepare(
        `SELECT COUNT(*) AS total_requests, COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens, COALESCE(SUM(cost_usd), 0) AS total_cost_usd
         FROM usage ${where}`
      ).get(...params)];
  }

  const limit = opts.limit ? `LIMIT ${Number(opts.limit)}` : "";
  return d.prepare(
    `SELECT ${selectCol}, COUNT(*) AS total_requests,
     COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
     COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
     COALESCE(SUM(cost_usd), 0) AS total_cost_usd
     FROM usage ${where} GROUP BY ${groupByCol} ORDER BY total_requests DESC ${limit}`
  ).all(...params);
}

export function getRecentUsage(limit = 50): UsageRecord[] {
  return getDB().prepare("SELECT * FROM usage ORDER BY created_at DESC LIMIT ?").all(limit) as UsageRecord[];
}

export function getMonthlySpend(accountId: string): number {
  const now = new Date();
  const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const row = getDB().prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE account_id = ? AND created_at >= ?`
  ).get(accountId, firstOfMonth) as { total: number };
  return row.total;
}

// ─── Settings ───────────────────────────────────────────────────────────────

export function getSetting(key: string): string | undefined {
  const row = getDB().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  getDB().prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = getDB().prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

// ─── Privacy Mappings ────────────────────────────────────────────────────────

export function getPrivacyMapping(hash: string): PrivacyMapping | undefined {
  return getDB().prepare("SELECT * FROM privacy_mappings WHERE original_hash = ?").get(hash) as PrivacyMapping | undefined;
}

export function getPrivacyMappingByReplacement(replacement: string): PrivacyMapping | undefined {
  return getDB().prepare("SELECT * FROM privacy_mappings WHERE replacement = ?").get(replacement) as PrivacyMapping | undefined;
}

export function createPrivacyMapping(data: { id: string; category: string; original_hash: string; original_enc: string; replacement: string }): PrivacyMapping {
  const d = getDB();
  d.prepare(`INSERT INTO privacy_mappings (id, category, original_hash, original_enc, replacement) VALUES (?, ?, ?, ?, ?)`)
    .run(data.id, data.category, data.original_hash, data.original_enc, data.replacement);
  return d.prepare("SELECT * FROM privacy_mappings WHERE id = ?").get(data.id) as PrivacyMapping;
}

export function getAllPrivacyMappings(): PrivacyMapping[] {
  return getDB().prepare("SELECT * FROM privacy_mappings ORDER BY created_at DESC").all() as PrivacyMapping[];
}

export function deletePrivacyMappings(): void {
  getDB().prepare("DELETE FROM privacy_mappings").run();
}

export function getPrivacyMappingCount(): { total: number; by_category: Record<string, number> } {
  const d = getDB();
  const totalRow = d.prepare("SELECT COUNT(*) AS cnt FROM privacy_mappings").get() as { cnt: number };
  const catRows = d.prepare("SELECT category, COUNT(*) AS cnt FROM privacy_mappings GROUP BY category").all() as Array<{ category: string; cnt: number }>;
  const by_category: Record<string, number> = {};
  for (const row of catRows) by_category[row.category] = row.cnt;
  return { total: totalRow.cnt, by_category };
}

// ─── Session CRUD ───────────────────────────────────────────────────────────

export function createSession(session: Omit<Session, "created_at" | "last_active_at">): Session {
  const d = getDB();
  d.prepare(
    `INSERT INTO sessions (id, container_id, name, status, port, account_id) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(session.id, session.container_id, session.name, session.status, session.port, session.account_id || null);
  return d.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id) as Session;
}

export function getSessionsByAccountId(accountId: string): Session[] {
  return getDB().prepare("SELECT * FROM sessions WHERE account_id = ?").all(accountId) as Session[];
}

export function getLinkedSessions(): Session[] {
  return getDB().prepare("SELECT * FROM sessions WHERE account_id IS NOT NULL AND status = 'running'").all() as Session[];
}

export function getSessions(): Session[] {
  return getDB().prepare("SELECT * FROM sessions ORDER BY created_at DESC").all() as Session[];
}

export function getSession(id: string): Session | undefined {
  return getDB().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Session | undefined;
}

export function updateSession(id: string, updates: Partial<Session>): Session | undefined {
  const d = getDB();
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.container_id !== undefined) { sets.push("container_id = ?"); values.push(updates.container_id); }
  if (updates.name !== undefined) { sets.push("name = ?"); values.push(updates.name); }
  if (updates.status !== undefined) { sets.push("status = ?"); values.push(updates.status); }
  if (updates.port !== undefined) { sets.push("port = ?"); values.push(updates.port); }
  if (updates.account_id !== undefined) { sets.push("account_id = ?"); values.push(updates.account_id); }
  sets.push("last_active_at = datetime('now')");
  if (sets.length === 0) return getSession(id);
  values.push(id);
  d.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return getSession(id);
}

export function deleteSession(id: string): boolean {
  return getDB().prepare("DELETE FROM sessions WHERE id = ?").run(id).changes > 0;
}

// ─── Request Logs ────────────────────────────────────────────────────────────

export interface RequestLogInput {
  method?: string;
  path?: string;
  inbound_format?: string;
  account_id?: string;
  account_name?: string;
  provider?: string;
  original_model?: string;
  routed_model?: string;
  status_code?: number;
  input_tokens?: number;
  output_tokens?: number;
  latency_ms?: number;
  is_stream?: boolean;
  is_failover?: boolean;
  error_message?: string;
  request_body?: string;
  response_body?: string;
}

export interface RequestLogRow {
  id: string;
  timestamp: string;
  method: string | null;
  path: string | null;
  inbound_format: string | null;
  account_id: string | null;
  account_name: string | null;
  provider: string | null;
  original_model: string | null;
  routed_model: string | null;
  status_code: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  is_stream: number;
  is_failover: number;
  error_message: string | null;
  request_body: string | null;
  response_body: string | null;
}

export function insertRequestLog(data: RequestLogInput): void {
  const d = getDB();
  const id = uuidv4();
  d.prepare(
    `INSERT INTO request_logs (id, method, path, inbound_format, account_id, account_name, provider, original_model, routed_model, status_code, input_tokens, output_tokens, latency_ms, is_stream, is_failover, error_message, request_body, response_body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    data.method ?? null,
    data.path ?? null,
    data.inbound_format ?? null,
    data.account_id ?? null,
    data.account_name ?? null,
    data.provider ?? null,
    data.original_model ?? null,
    data.routed_model ?? null,
    data.status_code ?? null,
    data.input_tokens ?? null,
    data.output_tokens ?? null,
    data.latency_ms ?? null,
    data.is_stream ? 1 : 0,
    data.is_failover ? 1 : 0,
    data.error_message ?? null,
    data.request_body ?? null,
    data.response_body ?? null
  );
}

export function getRequestLogs(opts: {
  page?: number;
  limit?: number;
  status?: string;
  account?: string;
  model?: string;
}): { logs: RequestLogRow[]; total: number } {
  const d = getDB();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.status === "success") {
    conditions.push("status_code >= 200 AND status_code < 300");
  } else if (opts.status === "error") {
    conditions.push("(status_code < 200 OR status_code >= 300)");
  }
  if (opts.account) {
    conditions.push("(account_name LIKE ? OR account_id = ?)");
    params.push(`%${opts.account}%`, opts.account);
  }
  if (opts.model) {
    conditions.push("(original_model LIKE ? OR routed_model LIKE ?)");
    params.push(`%${opts.model}%`, `%${opts.model}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const page = opts.page ?? 1;
  const limit = opts.limit ?? 50;
  const offset = (page - 1) * limit;

  const totalRow = d.prepare(`SELECT COUNT(*) AS cnt FROM request_logs ${where}`).get(...params) as { cnt: number };
  const logs = d.prepare(
    `SELECT id, timestamp, method, path, inbound_format, account_id, account_name, provider, original_model, routed_model, status_code, input_tokens, output_tokens, latency_ms, is_stream, is_failover, error_message
     FROM request_logs ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as RequestLogRow[];

  return { logs, total: totalRow.cnt };
}

export function getRequestLog(id: string): RequestLogRow | undefined {
  return getDB().prepare("SELECT * FROM request_logs WHERE id = ?").get(id) as RequestLogRow | undefined;
}

export function deleteOldRequestLogs(daysOld: number): number {
  const d = getDB();
  const result = d.prepare(
    `DELETE FROM request_logs WHERE timestamp < datetime('now', ? || ' days')`
  ).run(`-${daysOld}`);
  return result.changes;
}

export function clearAllRequestLogs(): number {
  const d = getDB();
  const result = d.prepare("DELETE FROM request_logs").run();
  return result.changes;
}

export function getRequestLogCount(): number {
  const d = getDB();
  const row = d.prepare("SELECT COUNT(*) AS cnt FROM request_logs").get() as { cnt: number };
  return row.cnt;
}

// ─── Automatic Log Retention ────────────────────────────────────────────────

const DEFAULT_LOG_RETENTION_DAYS = 30;
const LOG_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

function getLogRetentionDays(): number {
  const val = getSetting("log_retention_days");
  if (val) {
    const n = parseInt(val, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return DEFAULT_LOG_RETENTION_DAYS;
}

/**
 * Start a periodic cleanup loop that deletes request logs older than the
 * configured retention period. Runs every 6 hours. Reads the setting
 * each cycle so changes take effect without restart.
 */
let logCleanupStarted = false;
export function startLogRetentionCleanup(): void {
  if (logCleanupStarted) return;
  logCleanupStarted = true;

  function runCleanup() {
    try {
      const days = getLogRetentionDays();
      const deleted = deleteOldRequestLogs(days);
      if (deleted > 0) {
        console.log(`[db] Log retention cleanup: deleted ${deleted} logs older than ${days} days`);
      }
    } catch (err) {
      console.error("[db] Log retention cleanup failed:", err);
    }
  }

  // Run once immediately on startup, then periodically
  runCleanup();
  setInterval(runCleanup, LOG_CLEANUP_INTERVAL_MS);
}
