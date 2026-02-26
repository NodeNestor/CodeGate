import React, { useState } from "react";
import { ArrowLeft, Eye, EyeOff, ChevronDown, ChevronUp } from "lucide-react";
import Button from "./ui/Button";
import { Input, Select } from "./ui/Input";
import { getProviderLabel } from "./ui/Badge";
import { createAccount, type Account } from "../lib/api";

interface ApiKeyQuickFormProps {
  provider: string;
  onSubmit: () => void;
  onBack: () => void;
}

const DEFAULT_BASE_URLS: Record<string, string> = {
  glm: "https://api.z.ai/api/coding/paas/v4",
  cerebras: "https://api.cerebras.ai",
  deepseek: "https://api.deepseek.com",
  gemini: "https://generativelanguage.googleapis.com",
  minimax: "https://api.minimax.chat",
};

const PROVIDERS_WITH_BASE_URL = new Set([
  "openrouter",
  "custom",
  "glm",
  "cerebras",
  "deepseek",
  "gemini",
  "minimax",
]);

const SUBSCRIPTION_TYPES = [
  { value: "", label: "None" },
  { value: "pro", label: "Pro" },
  { value: "max_5x", label: "Max 5x" },
  { value: "max_20x", label: "Max 20x" },
];

export default function ApiKeyQuickForm({
  provider,
  onSubmit,
  onBack,
}: ApiKeyQuickFormProps) {
  const providerLabel = getProviderLabel(provider);

  const [name, setName] = useState(`My ${providerLabel} Account`);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URLS[provider] ?? "");
  const [subscriptionType, setSubscriptionType] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [priority, setPriority] = useState(0);
  const [rateLimit, setRateLimit] = useState(60);
  const [monthlyBudget, setMonthlyBudget] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const showBaseUrl = PROVIDERS_WITH_BASE_URL.has(provider);
  const showSubscriptionType = provider === "anthropic";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      const data: Partial<Account> & { api_key?: string } = {
        name,
        provider: provider as Account["provider"],
        auth_type: "api_key",
        priority,
        rate_limit: rateLimit,
      };
      if (apiKey) data.api_key = apiKey;
      if (baseUrl) data.base_url = baseUrl;
      if (monthlyBudget) data.monthly_budget = parseFloat(monthlyBudget);
      if (subscriptionType) data.subscription_type = subscriptionType;
      if (email) data.account_email = email;
      await createAccount(data);
      onSubmit();
    } catch (err: any) {
      setError(err.message || "Failed to connect account");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Back button */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="gap-1.5 -ml-1"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </Button>

      {/* Title */}
      <div>
        <h2 className="text-lg font-semibold text-gray-100">{providerLabel}</h2>
        <p className="text-sm text-gray-400 mt-1">
          Connect your {providerLabel} API key to get started.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Error banner */}
        {error && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Name */}
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`My ${providerLabel} Account`}
          required
        />

        {/* API Key */}
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-gray-300">
            API Key
          </label>
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              required
              className="block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 pr-10 text-sm text-gray-100 placeholder-gray-500 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none transition-colors"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200 transition-colors"
            >
              {showKey ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>

        {/* Base URL (conditional) */}
        {showBaseUrl && (
          <Input
            label="Base URL"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={
              DEFAULT_BASE_URLS[provider] ?? "https://api.example.com/v1"
            }
            required={provider === "custom"}
          />
        )}

        {/* Subscription Type (anthropic only) */}
        {showSubscriptionType && (
          <Select
            label="Subscription Type"
            value={subscriptionType}
            onChange={(e) => setSubscriptionType(e.target.value)}
            options={SUBSCRIPTION_TYPES}
          />
        )}

        {/* Advanced section toggle */}
        <button
          type="button"
          onClick={() => setAdvancedOpen((prev) => !prev)}
          className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-gray-200 transition-colors"
        >
          {advancedOpen ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
          Advanced options
        </button>

        {/* Advanced fields */}
        {advancedOpen && (
          <div className="space-y-4 rounded-lg border border-gray-700 bg-gray-800/40 p-4">
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
              label="Monthly Budget"
              type="number"
              value={monthlyBudget}
              onChange={(e) => setMonthlyBudget(e.target.value)}
              placeholder="100.00"
              min="0"
              step={0.01}
            />
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
            />
          </div>
        )}

        {/* Submit */}
        <Button type="submit" loading={saving} className="w-full">
          Connect {providerLabel}
        </Button>
      </form>
    </div>
  );
}
