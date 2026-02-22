import React, { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, RefreshCw, Search } from "lucide-react";
import Button from "./ui/Button";
import { Select } from "./ui/Input";
import Badge from "./ui/Badge";
import type { Account, ConfigTier, Config, ModelInfo, ModelLimitsInfo } from "../lib/api";
import { getModelCatalog, refreshModelCatalog, getModelLimits } from "../lib/api";

interface TierRow {
  key: string; // local key for React
  account_id: string;
  target_model: string;
  priority: number;
}

interface ConfigEditorProps {
  config: Config;
  accounts: Account[];
  tiers: ConfigTier[];
  onSave: (
    routingStrategy: string,
    tiers: Omit<ConfigTier, "id" | "config_id">[]
  ) => Promise<void>;
  onCancel: () => void;
}

const DEFAULT_MODELS: Record<string, string> = {
  opus: "claude-opus-4-6-20250219",
  sonnet: "claude-sonnet-4-6-20250219",
  haiku: "claude-haiku-4-5-20251001",
};

const TIER_NAMES: ("opus" | "sonnet" | "haiku")[] = [
  "opus",
  "sonnet",
  "haiku",
];

const ROUTING_STRATEGIES = [
  { value: "priority", label: "Priority" },
  { value: "round-robin", label: "Round Robin" },
  { value: "least-used", label: "Least Used" },
  { value: "budget-aware", label: "Budget Aware" },
];

let nextKey = 0;

export default function ConfigEditor({
  config,
  accounts,
  tiers,
  onSave,
  onCancel,
}: ConfigEditorProps) {
  const [strategy, setStrategy] = useState(config.routing_strategy);
  const [tierRows, setTierRows] = useState<
    Record<string, TierRow[]>
  >({ opus: [], sonnet: [], haiku: [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelSearch, setModelSearch] = useState<Record<string, string>>({});
  const [modelLimits, setModelLimits] = useState<Record<string, ModelLimitsInfo>>({});
  const [customModeRows, setCustomModeRows] = useState<Set<string>>(new Set());

  const loadModels = useCallback(async (force = false) => {
    setModelsLoading(true);
    try {
      const result = force
        ? await refreshModelCatalog()
        : await getModelCatalog();
      setModels(result);
    } catch {
      // Models fetch failed — dropdown will show "Custom" option only
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadModels();
    getModelLimits().then(setModelLimits).catch(() => {});
  }, [loadModels]);

  useEffect(() => {
    const grouped: Record<string, TierRow[]> = {
      opus: [],
      sonnet: [],
      haiku: [],
    };
    for (const t of tiers) {
      const tier = t.tier as string;
      if (grouped[tier]) {
        grouped[tier].push({
          key: `existing-${nextKey++}`,
          account_id: t.account_id,
          target_model: t.target_model || "",
          priority: t.priority,
        });
      }
    }
    // If no rows exist for a tier, add one default row
    for (const tierName of TIER_NAMES) {
      if (grouped[tierName].length === 0 && accounts.length > 0) {
        grouped[tierName].push({
          key: `default-${nextKey++}`,
          account_id: accounts[0].id,
          target_model: "",
          priority: 0,
        });
      }
    }
    setTierRows(grouped);
  }, [tiers, accounts]);

  function addRow(tier: string) {
    setTierRows((prev) => ({
      ...prev,
      [tier]: [
        ...prev[tier],
        {
          key: `new-${nextKey++}`,
          account_id: accounts[0]?.id || "",
          target_model: "",
          priority: prev[tier].length,
        },
      ],
    }));
  }

  function removeRow(tier: string, idx: number) {
    setTierRows((prev) => ({
      ...prev,
      [tier]: prev[tier].filter((_, i) => i !== idx),
    }));
  }

  function updateRow(
    tier: string,
    idx: number,
    field: keyof TierRow,
    value: string | number
  ) {
    setTierRows((prev) => ({
      ...prev,
      [tier]: prev[tier].map((r, i) =>
        i === idx ? { ...r, [field]: value } : r
      ),
    }));
  }

  async function handleSave() {
    setError("");
    setSaving(true);
    try {
      const allTiers: Omit<ConfigTier, "id" | "config_id">[] = [];
      for (const tierName of TIER_NAMES) {
        for (const row of tierRows[tierName]) {
          if (!row.account_id) continue;
          allTiers.push({
            tier: tierName,
            account_id: row.account_id,
            target_model: row.target_model || undefined,
            priority: row.priority,
          });
        }
      }
      await onSave(strategy, allTiers);
    } catch (err: any) {
      setError(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  // Build model options filtered to the selected account's provider
  function getModelOptions(tierName: string, rowKey: string, accountId: string) {
    const defaultModel = DEFAULT_MODELS[tierName];
    const search = (modelSearch[rowKey] || "").toLowerCase();

    // Find the selected account's provider
    const selectedAccount = accounts.find((a) => a.id === accountId);
    const accountProvider = selectedAccount?.provider;

    const filtered: ModelInfo[] = [];
    for (const m of models) {
      // Only show models from the selected account's provider
      if (accountProvider && m.provider !== accountProvider) continue;
      // Apply search filter
      if (
        search &&
        !m.name.toLowerCase().includes(search) &&
        !m.id.toLowerCase().includes(search)
      ) {
        continue;
      }
      filtered.push(m);
    }

    return { filtered, defaultModel, accountProvider };
  }

  // Look up model limits (exact match or prefix match)
  function findModelLimits(modelId: string): ModelLimitsInfo | undefined {
    if (!modelId) return undefined;
    if (modelLimits[modelId]) return modelLimits[modelId];
    for (const [key, limits] of Object.entries(modelLimits)) {
      if (modelId.startsWith(key) || key.startsWith(modelId)) return limits;
    }
    return undefined;
  }

  const TIER_LABELS: Record<string, string> = {
    opus: "Opus",
    sonnet: "Sonnet",
    haiku: "Haiku",
  };

  // Provider display names
  const PROVIDER_LABELS: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    openai_sub: "OpenAI",
    openrouter: "OpenRouter",
    cerebras: "Cerebras",
    deepseek: "DeepSeek",
    glm: "GLM (Zhipu)",
    gemini: "Google Gemini",
    minimax: "MiniMax",
    custom: "Custom",
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="flex items-end gap-4">
        <div className="flex-1">
          <Select
            label="Routing Strategy"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as Config["routing_strategy"])}
            options={ROUTING_STRATEGIES}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => loadModels(true)}
          loading={modelsLoading}
          title="Refresh model list from providers"
        >
          <RefreshCw className="h-4 w-4" />
          {modelsLoading ? "Loading..." : `${models.length} models`}
        </Button>
      </div>

      {TIER_NAMES.map((tierName) => {
        return (
          <div key={tierName} className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold text-gray-200 uppercase tracking-wider">
                {TIER_LABELS[tierName]} Tier
              </h4>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => addRow(tierName)}
              >
                <Plus className="h-4 w-4" />
                Add Fallback
              </Button>
            </div>

            {tierRows[tierName].length === 0 && (
              <p className="text-sm text-gray-500 italic">
                No accounts assigned. Click "Add Fallback" to add one.
              </p>
            )}

            <div className="space-y-2">
              {tierRows[tierName].map((row, idx) => {
                const { filtered, defaultModel, accountProvider } = getModelOptions(tierName, row.key, row.account_id);
                const isCustom = customModeRows.has(row.key);
                const providerLabel = accountProvider
                  ? PROVIDER_LABELS[accountProvider] || accountProvider
                  : "";
                const effectiveModel = row.target_model || defaultModel;
                const limits = findModelLimits(effectiveModel);

                return (
                  <div
                    key={row.key}
                    className="flex items-end gap-3 bg-gray-800/50 rounded-lg p-3"
                  >
                    <div className="flex-1 min-w-0">
                      <label className="block text-xs text-gray-400 mb-1">
                        Account
                      </label>
                      <select
                        value={row.account_id}
                        onChange={(e) => {
                          updateRow(tierName, idx, "account_id", e.target.value);
                          // Reset model selection when account changes
                          updateRow(tierName, idx, "target_model", "");
                        }}
                        className="block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
                      >
                        <option value="">Select account...</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name} ({a.provider})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="w-72">
                      <label className="block text-xs text-gray-400 mb-1">
                        Model
                        {modelsLoading && (
                          <span className="ml-1 text-gray-500">(loading...)</span>
                        )}
                        {!modelsLoading && providerLabel && (
                          <span className="ml-1 text-gray-500">({providerLabel})</span>
                        )}
                      </label>
                      {!isCustom ? (
                        <>
                          {/* Search filter for large model lists */}
                          {filtered.length > 15 && (
                            <div className="relative mb-1">
                              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-500" />
                              <input
                                type="text"
                                placeholder="Filter models..."
                                value={modelSearch[row.key] || ""}
                                onChange={(e) =>
                                  setModelSearch((prev) => ({
                                    ...prev,
                                    [row.key]: e.target.value,
                                  }))
                                }
                                className="block w-full rounded-lg border border-gray-700 bg-gray-800 pl-7 pr-3 py-1 text-xs text-gray-100 placeholder-gray-500 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
                              />
                            </div>
                          )}
                          <select
                            value={row.target_model}
                            onChange={(e) => {
                              if (e.target.value === "__custom__") {
                                setCustomModeRows((prev) => new Set(prev).add(row.key));
                                updateRow(tierName, idx, "target_model", "");
                              } else {
                                updateRow(tierName, idx, "target_model", e.target.value);
                              }
                            }}
                            className="block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
                          >
                            <option value="">Default ({defaultModel})</option>
                            {filtered.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name}
                              </option>
                            ))}
                            <option value="__custom__">Enter custom model ID...</option>
                          </select>
                        </>
                      ) : (
                        <div className="flex gap-1">
                          <input
                            type="text"
                            placeholder="e.g. my-provider/my-model"
                            value={row.target_model}
                            onChange={(e) =>
                              updateRow(tierName, idx, "target_model", e.target.value)
                            }
                            className="block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
                            autoFocus
                          />
                          <button
                            onClick={() => {
                              setCustomModeRows((prev) => {
                                const next = new Set(prev);
                                next.delete(row.key);
                                return next;
                              });
                              updateRow(tierName, idx, "target_model", "");
                            }}
                            className="px-2 text-xs text-gray-400 hover:text-gray-200"
                            title="Back to dropdown"
                          >
                            Back
                          </button>
                        </div>
                      )}
                      {limits && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {limits.supportsToolCalling === true && (
                            <Badge variant="success">Tools</Badge>
                          )}
                          {limits.supportsToolCalling === false && (
                            <Badge variant="warning">No Tools</Badge>
                          )}
                          {limits.supportsReasoning === true && (
                            <Badge variant="purple">Reasoning</Badge>
                          )}
                          {limits.maxOutputTokens != null && (
                            <Badge variant="default">
                              max: {limits.maxOutputTokens.toLocaleString()}
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="w-20">
                      <label className="block text-xs text-gray-400 mb-1">
                        Priority
                      </label>
                      <input
                        type="number"
                        value={row.priority}
                        onChange={(e) =>
                          updateRow(
                            tierName,
                            idx,
                            "priority",
                            parseInt(e.target.value) || 0
                          )
                        }
                        min="0"
                        className="block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
                      />
                    </div>

                    <button
                      onClick={() => removeRow(tierName, idx)}
                      className="p-2 rounded-lg text-gray-400 hover:text-red-400 hover:bg-gray-800 transition-colors"
                      title="Remove"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="flex items-center justify-end gap-3 pt-4 border-t border-gray-800">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={handleSave} loading={saving}>
          Save Configuration
        </Button>
      </div>
    </div>
  );
}
