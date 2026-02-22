export type ModelTier = "opus" | "sonnet" | "haiku";

const TIER_PATTERNS: Array<{ pattern: RegExp; tier: ModelTier }> = [
  { pattern: /opus/i, tier: "opus" },
  { pattern: /sonnet/i, tier: "sonnet" },
  { pattern: /haiku/i, tier: "haiku" },
];

const DEFAULT_MODELS: Record<ModelTier, string> = {
  opus: "claude-opus-4-6-20250219",
  sonnet: "claude-sonnet-4-6-20250219",
  haiku: "claude-haiku-4-5-20251001",
};

/** Model info returned by the dynamic fetcher. */
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  tier: ModelTier | null;
}

/**
 * Detect the tier from a model name string.
 * Returns null if no tier pattern matches.
 */
export function detectTier(model: string): ModelTier | null {
  for (const { pattern, tier } of TIER_PATTERNS) {
    if (pattern.test(model)) {
      return tier;
    }
  }
  return null;
}

/**
 * Get the default (latest) model ID for a given tier.
 */
export function getDefaultModel(tier: ModelTier): string {
  return DEFAULT_MODELS[tier];
}
