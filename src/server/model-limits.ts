/**
 * Per-model capability and limit overrides.
 * Stored in the database -- no hardcoded values.
 * Users add limits manually for models that need them (e.g. DeepSeek's 8k cap).
 */

import { getDb } from "./db.js";

export interface ModelLimits {
  maxOutputTokens: number | null;
  supportsToolCalling: boolean | null;
  supportsReasoning: boolean | null;
}

// In-memory cache, loaded from DB
let cache: Record<string, ModelLimits> = {};

/**
 * Initialize the model_limits table and load cache.
 * Called once at startup from db.ts init.
 */
export function initModelLimitsTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_limits (
      model_id TEXT PRIMARY KEY,
      max_output_tokens INTEGER,
      supports_tool_calling INTEGER,
      supports_reasoning INTEGER
    )
  `);
  reloadCache();
}

function reloadCache(): void {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM model_limits").all() as Array<{
    model_id: string;
    max_output_tokens: number | null;
    supports_tool_calling: number | null;
    supports_reasoning: number | null;
  }>;
  cache = {};
  for (const row of rows) {
    cache[row.model_id] = {
      maxOutputTokens: row.max_output_tokens,
      supportsToolCalling: row.supports_tool_calling === null ? null : row.supports_tool_calling === 1,
      supportsReasoning: row.supports_reasoning === null ? null : row.supports_reasoning === 1,
    };
  }
}

/**
 * Prefix-matching lookup for model limits.
 * Tries exact match first, then prefix match.
 * Returns undefined if no user-defined limits exist.
 */
export function getModelLimits(modelId: string): ModelLimits | undefined {
  if (cache[modelId]) return cache[modelId];

  for (const [key, limits] of Object.entries(cache)) {
    if (modelId.startsWith(key) || key.startsWith(modelId)) {
      return limits;
    }
  }

  return undefined;
}

/**
 * Clamp max_tokens to the model's configured limit.
 * Returns the value unchanged if no limit is configured.
 */
export function clampMaxTokens(value: number | undefined, modelId: string): number | undefined {
  if (value === undefined) return undefined;
  const limits = getModelLimits(modelId);
  if (!limits || limits.maxOutputTokens === null) return value;
  return Math.min(value, limits.maxOutputTokens);
}

/**
 * Return all user-configured model limits for UI display.
 */
export function getAllModelLimits(): Record<string, ModelLimits> {
  return { ...cache };
}

/**
 * Set limits for a model. Pass null fields to leave them unset.
 */
export function setModelLimit(
  modelId: string,
  limits: { maxOutputTokens?: number | null; supportsToolCalling?: boolean | null; supportsReasoning?: boolean | null }
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO model_limits (model_id, max_output_tokens, supports_tool_calling, supports_reasoning)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(model_id) DO UPDATE SET
       max_output_tokens = excluded.max_output_tokens,
       supports_tool_calling = excluded.supports_tool_calling,
       supports_reasoning = excluded.supports_reasoning`
  ).run(
    modelId,
    limits.maxOutputTokens ?? null,
    limits.supportsToolCalling === null || limits.supportsToolCalling === undefined ? null : limits.supportsToolCalling ? 1 : 0,
    limits.supportsReasoning === null || limits.supportsReasoning === undefined ? null : limits.supportsReasoning ? 1 : 0,
  );
  reloadCache();
}

/**
 * Delete limits for a model.
 */
export function deleteModelLimit(modelId: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM model_limits WHERE model_id = ?").run(modelId);
  reloadCache();
  return result.changes > 0;
}
