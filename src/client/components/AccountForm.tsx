import React, { useState, useEffect } from "react";
import { Eye, EyeOff, RefreshCw, Check, AlertCircle } from "lucide-react";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import { Input, Select } from "./ui/Input";
import { type Account } from "../lib/api";

interface AccountFormProps {
  open: boolean;
  account?: Account | null;
  onClose: () => void;
  onSave: (data: Partial<Account> & { api_key?: string }) => Promise<void>;
}

const PROVIDERS = [
  { value: "anthropic", label: "Anthropic (API Key / OAuth)" },
  { value: "openai", label: "OpenAI (API Key)" },
  { value: "openai_sub", label: "OpenAI Subscription" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "cerebras", label: "Cerebras" },
  { value: "gemini", label: "Google Gemini" },
  { value: "glm", label: "GLM / Zhipu AI" },
  { value: "minimax", label: "MiniMax" },
  { value: "custom", label: "Custom (OpenAI-compatible)" },
];

const SUBSCRIPTION_TYPES = [
  { value: "", label: "None" },
  { value: "pro", label: "Pro" },
  { value: "max_5x", label: "Max 5x" },
  { value: "max_20x", label: "Max 20x" },
];

/** Default base URLs for providers that have known endpoints. */
const DEFAULT_BASE_URLS: Record<string, string> = {
  glm: "https://api.z.ai/api/coding/paas/v4",
  cerebras: "https://api.cerebras.ai",
  deepseek: "https://api.deepseek.com",
  gemini: "https://generativelanguage.googleapis.com",
  minimax: "https://api.minimax.chat",
};

/** Providers that should show the base URL field. */
function shouldShowBaseUrl(provider: string, currentBaseUrl: string): boolean {
  return (
    provider === "openrouter" ||
    provider === "custom" ||
    provider === "glm" ||
    provider === "cerebras" ||
    provider === "deepseek" ||
    provider === "gemini" ||
    provider === "minimax" ||
    currentBaseUrl !== ""
  );
}

/** Providers that support API key auth. */
function supportsApiKey(provider: string): boolean {
  return provider !== "openai_sub";
}

/** Providers that support OAuth. */
function supportsOAuth(provider: string): boolean {
  return provider === "anthropic";
}

export default function AccountForm({
  open,
  account,
  onClose,
  onSave,
}: AccountFormProps) {
  const isEdit = !!account;

  const [name, setName] = useState("");
  const [provider, setProvider] = useState<string>("anthropic");
  const [authType, setAuthType] = useState<"api_key" | "oauth">("api_key");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [priority, setPriority] = useState(0);
  const [rateLimit, setRateLimit] = useState(60);
  const [monthlyBudget, setMonthlyBudget] = useState("");
  const [subscriptionType, setSubscriptionType] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Refresh from host state
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (open) {
      if (account) {
        setName(account.name);
        setProvider(account.provider);
        setAuthType(account.auth_type);
        setApiKey("");
        setShowKey(false);
        setBaseUrl(account.base_url || "");
        setPriority(account.priority);
        setRateLimit(account.rate_limit);
        setMonthlyBudget(
          account.monthly_budget != null ? String(account.monthly_budget) : ""
        );
        setSubscriptionType(account.subscription_type || "");
        setEmail(account.account_email || "");
      } else {
        setName("");
        setProvider("anthropic");
        setAuthType("api_key");
        setApiKey("");
        setShowKey(false);
        setBaseUrl("");
        setPriority(0);
        setRateLimit(60);
        setMonthlyBudget("");
        setSubscriptionType("");
        setEmail("");
      }
      setError("");
      setSaving(false);
      setRefreshResult(null);
      setRefreshing(false);
    }
  }, [open, account]);

  function handleProviderChange(newProvider: string) {
    setProvider(newProvider);

    // Set default base URL for known providers
    if (DEFAULT_BASE_URLS[newProvider] && !baseUrl) {
      setBaseUrl(DEFAULT_BASE_URLS[newProvider]);
    }

    // Reset base URL when switching away from a provider with a default
    if (!DEFAULT_BASE_URLS[newProvider] && DEFAULT_BASE_URLS[provider]) {
      const oldDefault = DEFAULT_BASE_URLS[provider];
      if (baseUrl === oldDefault) {
        setBaseUrl("");
      }
    }

    // Only anthropic supports OAuth
    if (!supportsOAuth(newProvider)) {
      setAuthType("api_key");
    }
  }

  async function handleRefreshFromHost() {
    // Host refresh not available in CodeProxy - use terminal sessions instead
    setRefreshResult({ success: false, message: "Use terminal sessions to refresh OAuth credentials" });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      const data: Partial<Account> & { api_key?: string } = {
        name,
        provider: provider as Account["provider"],
        auth_type: authType,
        priority,
        rate_limit: rateLimit,
      };
      if (apiKey) data.api_key = apiKey;
      if (baseUrl) data.base_url = baseUrl;
      else data.base_url = undefined;
      if (monthlyBudget) data.monthly_budget = parseFloat(monthlyBudget);
      if (subscriptionType) data.subscription_type = subscriptionType;
      if (email) data.account_email = email;
      await onSave(data);
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const showApiKeyField = supportsApiKey(provider) && authType === "api_key";
  const showOAuthOption = supportsOAuth(provider);
  const showSubscriptionType = provider === "anthropic";
  const isOAuthEdit = isEdit && account?.auth_type === "oauth";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? "Edit Provider" : "Add Provider"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="account-form"
            loading={saving}
          >
            {isEdit ? "Save Changes" : "Add Provider"}
          </Button>
        </>
      }
    >
      <form id="account-form" onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Refresh from Host -- only shown for OAuth accounts being edited */}
        {isOAuthEdit && (
          <div className="rounded-lg bg-gray-800/50 border border-gray-700 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-300">
                OAuth Account -- refresh tokens from host credentials
              </span>
              <button
                type="button"
                onClick={handleRefreshFromHost}
                disabled={refreshing}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600/20 text-blue-400 border border-blue-500/30 px-3 py-1.5 text-xs font-medium hover:bg-blue-600/30 hover:border-blue-500/50 transition-colors disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
                />
                Refresh from Host
              </button>
            </div>
            {refreshResult && (
              <div
                className={`flex items-center gap-2 text-xs ${
                  refreshResult.success ? "text-green-400" : "text-red-400"
                }`}
              >
                {refreshResult.success ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5" />
                )}
                {refreshResult.message}
              </div>
            )}
            {account?.token_expires_at && (
              <p className="text-xs text-gray-500">
                Current token expires:{" "}
                {new Date(account.token_expires_at).toLocaleString()}
              </p>
            )}
          </div>
        )}

        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Anthropic Account"
          required
        />

        <Select
          label="Provider"
          value={provider}
          onChange={(e) => handleProviderChange(e.target.value)}
          options={PROVIDERS}
        />

        {/* OpenAI Sub note */}
        {provider === "openai_sub" && (
          <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/20 p-3 text-sm text-yellow-400">
            OpenAI Subscription uses browser authentication (future feature).
            For now, you can set this up as a placeholder.
          </div>
        )}

        {/* Auth type radio -- only show for providers that support multiple auth types */}
        {(showOAuthOption || showApiKeyField) && (
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-300">
              Authentication
            </label>
            <div className="flex gap-4">
              {supportsApiKey(provider) && (
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="auth_type"
                    value="api_key"
                    checked={authType === "api_key"}
                    onChange={() => setAuthType("api_key")}
                    className="text-brand-600 focus:ring-brand-500 bg-gray-800 border-gray-700"
                  />
                  <span className="text-sm text-gray-300">API Key</span>
                </label>
              )}
              {showOAuthOption && (
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="auth_type"
                    value="oauth"
                    checked={authType === "oauth"}
                    onChange={() => setAuthType("oauth")}
                    className="text-brand-600 focus:ring-brand-500 bg-gray-800 border-gray-700"
                  />
                  <span className="text-sm text-gray-300">OAuth</span>
                </label>
              )}
            </div>
          </div>
        )}

        {showApiKeyField && (
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-300">
              API Key
            </label>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={isEdit ? "(unchanged)" : "sk-..."}
                className="block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 pr-10 text-sm text-gray-100 placeholder-gray-500 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200"
              >
                {showKey ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        )}

        {shouldShowBaseUrl(provider, baseUrl) && (
          <Input
            label={`Base URL${DEFAULT_BASE_URLS[provider] ? "" : " (required for custom)"}`}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={
              DEFAULT_BASE_URLS[provider] ||
              (provider === "openrouter"
                ? "https://openrouter.ai/api/v1"
                : "https://api.example.com/v1")
            }
            required={provider === "custom"}
          />
        )}

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Priority"
            type="number"
            value={String(priority)}
            onChange={(e) => setPriority(parseInt(e.target.value) || 0)}
            min="0"
          />
          <Input
            label="Rate Limit (req/min)"
            type="number"
            value={String(rateLimit)}
            onChange={(e) => setRateLimit(parseInt(e.target.value) || 0)}
            min="0"
          />
        </div>

        <Input
          label="Monthly Budget (USD)"
          type="number"
          value={monthlyBudget}
          onChange={(e) => setMonthlyBudget(e.target.value)}
          placeholder="100.00"
          min="0"
          step="0.01"
        />

        {showSubscriptionType && (
          <Select
            label="Subscription Type"
            value={subscriptionType}
            onChange={(e) => setSubscriptionType(e.target.value)}
            options={SUBSCRIPTION_TYPES}
          />
        )}

        <Input
          label="Account Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
        />
      </form>
    </Modal>
  );
}
