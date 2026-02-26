import {
  getActiveConfig,
  getConfig,
  getConfigTiers,
  getEnabledAccounts,
  getMonthlySpend,
  type AccountDecrypted,
  type Config,
  type ConfigTier,
} from "./db.js";
import { detectTier } from "./model-mapper.js";
import { isRateLimited } from "./rate-limiter.js";

export interface ResolvedRoute {
  account: AccountDecrypted;
  targetModel: string | null; // null = use original model
  needsFormatConversion: boolean; // true if account.provider != "anthropic"
  tier: string | null;
  configId: string;
  fallbacks: Array<{ account: AccountDecrypted; targetModel: string | null }>;
}

// Round-robin counter per config+tier
const roundRobinCounters = new Map<string, number>();

/**
 * Resolve a route for a given model string.
 *
 * 1. Detect tier from model name
 * 2. Get active config
 * 3. Get tier assignments for that tier
 * 4. Filter out disabled / rate-limited / over-budget accounts
 * 5. Select based on routing strategy
 * 6. Return primary + fallback accounts
 */
export function resolveRoute(model: string): ResolvedRoute | null {
  return resolveRouteWithConfig(model, undefined);
}

/**
 * Resolve a route for a given model using a specific config (tenant-scoped).
 * Falls back to global active config if configId is not found.
 */
export function resolveRouteForConfig(model: string, configId: string): ResolvedRoute | null {
  return resolveRouteWithConfig(model, configId);
}

function resolveRouteWithConfig(model: string, configId: string | undefined): ResolvedRoute | null {
  const tier = detectTier(model);
  const activeConfig = configId ? getConfig(configId) ?? getActiveConfig() : getActiveConfig();

  if (!activeConfig) {
    // No active config: try to find any enabled account
    const enabledAccounts = getEnabledAccounts();
    if (enabledAccounts.length === 0) return null;

    // Pick the first enabled anthropic account, or any account
    const anthropicAccount = enabledAccounts.find((a) => a.provider === "anthropic");
    const account = anthropicAccount || enabledAccounts[0];

    return {
      account,
      targetModel: null,
      needsFormatConversion: account.provider !== "anthropic",
      tier,
      configId: "",
      fallbacks: [],
    };
  }

  // Get tier assignments for this tier
  let tierAssignments: ConfigTier[];
  if (tier) {
    tierAssignments = getConfigTiers(activeConfig.id).filter((t) => t.tier === tier);
  } else {
    // No tier detected -- use all tier assignments
    tierAssignments = getConfigTiers(activeConfig.id);
  }

  if (tierAssignments.length === 0) {
    // Fall back to any enabled account
    const enabledAccounts = getEnabledAccounts();
    if (enabledAccounts.length === 0) return null;

    const account = enabledAccounts[0];
    return {
      account,
      targetModel: null,
      needsFormatConversion: account.provider !== "anthropic",
      tier,
      configId: activeConfig.id,
      fallbacks: [],
    };
  }

  // Resolve accounts for each tier assignment, filtering out unavailable ones
  const enabledAccounts = getEnabledAccounts();
  const accountMap = new Map(enabledAccounts.map((a) => [a.id, a]));

  const candidates: Array<{
    account: AccountDecrypted;
    targetModel: string | null;
    priority: number;
  }> = [];

  for (const assignment of tierAssignments) {
    const account = accountMap.get(assignment.account_id);
    if (!account) continue; // Account disabled or deleted
    if (isRateLimited(account.id, account.rate_limit)) continue;

    // Budget check
    if (account.monthly_budget != null && account.monthly_budget > 0) {
      const monthlySpend = getMonthlySpend(account.id);
      if (monthlySpend >= account.monthly_budget) continue;
    }

    candidates.push({
      account,
      targetModel: assignment.target_model || null,
      priority: assignment.priority,
    });
  }

  if (candidates.length === 0) return null;

  // Select based on routing strategy
  const selected = selectByStrategy(
    activeConfig.routing_strategy,
    candidates,
    activeConfig.id,
    tier
  );

  const primary = selected[0];
  const fallbacks = selected.slice(1).map((c) => ({
    account: c.account,
    targetModel: c.targetModel,
  }));

  return {
    account: primary.account,
    targetModel: primary.targetModel,
    needsFormatConversion: primary.account.provider !== "anthropic",
    tier,
    configId: activeConfig.id,
    fallbacks,
  };
}

function selectByStrategy(
  strategy: string,
  candidates: Array<{
    account: AccountDecrypted;
    targetModel: string | null;
    priority: number;
  }>,
  configId: string,
  tier: string | null
): Array<{
  account: AccountDecrypted;
  targetModel: string | null;
  priority: number;
}> {
  switch (strategy) {
    case "round-robin": {
      const key = `${configId}:${tier || "all"}`;
      const counter = roundRobinCounters.get(key) ?? 0;
      roundRobinCounters.set(key, counter + 1);

      // Rotate the array so the "next" candidate is first
      const idx = counter % candidates.length;
      return [...candidates.slice(idx), ...candidates.slice(0, idx)];
    }

    case "least-used": {
      // Sort by monthly spend ascending (least used first)
      const withSpend = candidates.map((c) => ({
        ...c,
        spend: getMonthlySpend(c.account.id),
      }));
      withSpend.sort((a, b) => a.spend - b.spend);
      return withSpend;
    }

    case "budget-aware": {
      // Sort by remaining budget (most remaining first)
      const withBudget = candidates.map((c) => {
        const budget = c.account.monthly_budget ?? Infinity;
        const spend = getMonthlySpend(c.account.id);
        const remaining = budget - spend;
        return { ...c, remaining };
      });
      withBudget.sort((a, b) => b.remaining - a.remaining);
      return withBudget;
    }

    case "priority":
    default: {
      // Sort by priority descending (highest priority first)
      const sorted = [...candidates];
      sorted.sort((a, b) => b.priority - a.priority);
      return sorted;
    }
  }
}
