/**
 * Dynamic model fetcher — queries each provider's /models endpoint
 * and caches results with a TTL. No more hardcoded model lists.
 */
import { getEnabledAccounts, type AccountDecrypted } from "./db.js";

export interface FetchedModel {
  id: string;
  name: string;
  provider: string; // anthropic | openai | openrouter | cerebras | deepseek | glm | custom
  owned_by?: string;
}

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  models: FetchedModel[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Track in-flight requests to deduplicate
const inflight = new Map<string, Promise<FetchedModel[]>>();

// ── Provider-specific fetchers ───────────────────────────────────────────────

const BASE_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  openai_sub: "https://api.openai.com",
  cerebras: "https://api.cerebras.ai",
  deepseek: "https://api.deepseek.com",
  glm: "https://api.z.ai/api/coding/paas/v4",
  openrouter: "https://openrouter.ai/api",
  gemini: "https://generativelanguage.googleapis.com",
  minimax: "https://api.minimax.chat",
};

function getBaseUrl(account: AccountDecrypted): string {
  return account.base_url || BASE_URLS[account.provider] || "";
}

function makeHeaders(account: AccountDecrypted): Record<string, string> {
  const key = account.api_key;
  if (!key) return {};

  if (account.provider === "anthropic") {
    // Anthropic uses x-api-key, unless OAuth (Bearer token)
    if (account.auth_type === "oauth") {
      return {
        Authorization: `Bearer ${key}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
        "anthropic-dangerous-direct-browser-access": "true",
      };
    }
    return {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    };
  }

  if (account.provider === "gemini") {
    // Gemini uses API key as query param, not header — handled in endpoint
    return {};
  }

  // OpenAI subscription accounts (Codex) use ChatGPT backend API with special headers
  if ((account.provider === "openai" || account.provider === "openai_sub") && account.auth_type === "oauth") {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      "User-Agent": "codex_cli_rs/0.1.0",
      "originator": "codex_cli_rs",
    };
    // ChatGPT backend requires the account ID header
    if (account.external_account_id) {
      headers["ChatGPT-Account-ID"] = account.external_account_id;
    }
    return headers;
  }

  // Everyone else uses Bearer
  return { Authorization: `Bearer ${key}` };
}

function modelsEndpoint(account: AccountDecrypted): string {
  const base = getBaseUrl(account);
  if (!base) return "";

  // OpenAI subscription accounts (Codex) use the ChatGPT backend API
  if ((account.provider === "openai" || account.provider === "openai_sub") && account.auth_type === "oauth") {
    return "https://chatgpt.com/backend-api/codex/models?client_version=0.1.0";
  }

  switch (account.provider) {
    case "anthropic":
      return `${base}/v1/models?limit=100`;
    case "glm":
      return `${base}/models`;
    case "gemini":
      return `${base}/v1beta/models`;
    default:
      // OpenAI-compatible: openai, cerebras, deepseek, openrouter, minimax, custom
      return `${base}/v1/models`;
  }
}

/** Pretty-print a model ID into a display name. */
function prettifyModelName(id: string, provider: string): string {
  // Strip provider prefix (openrouter-style "org/model")
  let name = id;

  // Special casing for well-known patterns
  if (provider === "anthropic") {
    // claude-opus-4-6-20250219 → Claude Opus 4.6
    const m = name.match(/^claude-(\w+)-(\d+)-(\d+)-\d+$/);
    if (m) {
      const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
      return `Claude ${family} ${m[2]}.${m[3]}`;
    }
    const m2 = name.match(/^claude-(\w+)-(\d+)-\d+$/);
    if (m2) {
      const family = m2[1].charAt(0).toUpperCase() + m2[1].slice(1);
      return `Claude ${family} ${m2[2]}`;
    }
    // Fallback: capitalize
    return name
      .replace(/^claude-/, "Claude ")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  if (provider === "openrouter") {
    // org/model-name → Model Name (by Org)
    const parts = name.split("/");
    if (parts.length === 2) {
      const org = parts[0];
      const model = parts[1]
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      return `${model} (${org})`;
    }
  }

  // Generic: replace dashes/underscores, smart title case
  const ACRONYMS = new Set([
    "gpt", "llm", "ai", "api", "oss", "vlm", "vl", "sft",
    "rl", "dpo", "gguf", "fp16", "bf16", "int8", "int4",
  ]);
  return name
    .replace(/[-_]/g, " ")
    .replace(/\b\w+/g, (word) => {
      // Numbers with letter suffix like "120b" → "120B"
      if (/^\d+[a-z]$/i.test(word)) return word.toUpperCase();
      // Known acronyms → UPPERCASE
      if (ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
      // Version-like segments "v3" → "V3"
      if (/^v\d/i.test(word)) return word.toUpperCase();
      // Normal word → Title Case
      return word.charAt(0).toUpperCase() + word.slice(1);
    });
}

// ── Fallbacks for providers where API listing may not work ────────────────

/**
 * Known models for providers where the /models endpoint may fail
 * (e.g., Anthropic OAuth accounts can't call /v1/models).
 * These are fetched from the API at https://docs.anthropic.com/en/docs/about-claude/models
 * and updated periodically. If the live API works, these are ignored.
 */
// No hardcoded fallback models — only show what the provider's API actually returns.
// If a provider's /models endpoint doesn't work, use "Enter custom model ID" in the UI.
const FALLBACK_MODELS: Record<string, FetchedModel[]> = {};

/** Filter out internal/system models that aren't useful for routing. */
function isUsableModel(id: string, provider: string): boolean {
  // Skip embedding, tts, whisper, dall-e, moderation, etc.
  const skipPatterns = [
    /embed/i,
    /tts/i,
    /whisper/i,
    /dall-e/i,
    /moderation/i,
    /^babbage/i,
    /^davinci/i,
    /^curie/i,
    /^ada/i,
    /realtime/i,
    /audio/i,
    /^ft:/i,
    /^chatgpt-/i,
    /search/i,
  ];
  for (const pat of skipPatterns) {
    if (pat.test(id)) return false;
  }

  // For OpenRouter: include everything (users want access to the full catalog)
  if (provider === "openrouter") return true;

  return true;
}

async function fetchModelsForAccount(
  account: AccountDecrypted
): Promise<FetchedModel[]> {
  let url = modelsEndpoint(account);
  if (!url) return [];

  const headers = makeHeaders(account);
  let isCodexBackendUrl = url.includes("chatgpt.com/backend-api/codex");

  // Gemini uses API key as query param
  if (account.provider === "gemini" && account.api_key) {
    url += `${url.includes("?") ? "&" : "?"}key=${account.api_key}`;
  } else if (!headers.Authorization && !headers["x-api-key"]) {
    return [];
  }

  try {
    let res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000), // 10s timeout
    });

    // If standard OpenAI /v1/models returns 401/403, try the ChatGPT backend API
    // (subscription tokens don't have /v1/models access but work with the backend API)
    if (
      !res.ok &&
      (res.status === 401 || res.status === 403) &&
      (account.provider === "openai" || account.provider === "openai_sub") &&
      account.auth_type !== "oauth" // Don't retry if we already tried the backend URL
    ) {
      console.log(
        `[model-fetcher] ${account.provider}/${account.name}: ${res.status} on /v1/models, trying ChatGPT backend...`
      );
      const backendUrl = "https://chatgpt.com/backend-api/codex/models?client_version=0.1.0";
      const backendHeaders: Record<string, string> = {
        Authorization: `Bearer ${account.api_key}`,
        "User-Agent": "codex_cli_rs/0.1.0",
        "originator": "codex_cli_rs",
      };
      if (account.external_account_id) {
        backendHeaders["ChatGPT-Account-ID"] = account.external_account_id;
      }
      res = await fetch(backendUrl, {
        headers: backendHeaders,
        signal: AbortSignal.timeout(10_000),
      });
      isCodexBackendUrl = true;
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.warn(
        `[model-fetcher] ${account.provider}/${account.name}: ${res.status} ${res.statusText} url=${url} hasAccountId=${!!account.external_account_id}`
      );
      console.warn(`[model-fetcher] error body: ${errBody.slice(0, 500)}`);
      return [];
    }

    const json = await res.json() as any;

    // Gemini returns { models: [...] } instead of { data: [...] }
    if (account.provider === "gemini" && Array.isArray(json.models)) {
      return json.models
        .filter((m: any) => {
          const id = m.name?.replace("models/", "") || "";
          return id && isUsableModel(id, account.provider);
        })
        .map((m: any) => ({
          id: m.name?.replace("models/", "") || m.name,
          name: m.displayName || prettifyModelName(m.name?.replace("models/", "") || "", account.provider),
          provider: account.provider,
        }));
    }

    // Codex ChatGPT backend returns { models: [...] } with slug/display_name fields
    if (isCodexBackendUrl && Array.isArray(json.models)) {
      return json.models
        .filter((m: any) => {
          // Skip hidden models and models not supported in API
          if (m.visibility === "hidden") return false;
          const modelId = m.slug || m.model || m.id;
          return modelId && isUsableModel(modelId, account.provider);
        })
        .map((m: any) => {
          const modelId = m.slug || m.model || m.id;
          // Use display_name from API, or prettify the slug
          const displayName = m.display_name || m.displayName || prettifyModelName(modelId, account.provider);
          return {
            id: modelId,
            name: displayName,
            provider: account.provider,
          };
        });
    }

    // Standard OpenAI format: { data: [...] }
    if (!json.data || !Array.isArray(json.data)) return [];

    return json.data
      .filter((m: any) => {
        const modelId = m.model || m.id;
        return modelId && isUsableModel(modelId, account.provider);
      })
      .filter((m: any) => !m.hidden)
      .map((m: any) => ({
        id: m.model || m.id,
        name:
          m.display_name ||
          m.displayName ||
          m.name ||
          prettifyModelName(m.model || m.id, account.provider),
        provider: account.provider,
        owned_by: m.owned_by,
      }));
  } catch (err: any) {
    console.warn(
      `[model-fetcher] ${account.provider}/${account.name}: ${err.message}`
    );
    return [];
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch models for a specific provider. Uses one enabled account's
 * credentials. Results are cached per provider for CACHE_TTL_MS.
 */
export async function getModelsForProvider(
  provider: string
): Promise<FetchedModel[]> {
  // Check cache
  const cached = cache.get(provider);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.models;
  }

  // Deduplicate in-flight requests
  const existing = inflight.get(provider);
  if (existing) return existing;

  const promise = (async () => {
    try {
      // Pick enabled accounts for this provider
      const accounts = getEnabledAccounts().filter(
        (a) => a.provider === provider
      );
      if (accounts.length === 0) return [];

      // Try api_key accounts first (they reliably support /models), then others
      const sorted = [
        ...accounts.filter((a) => a.auth_type === "api_key"),
        ...accounts.filter((a) => a.auth_type !== "api_key"),
      ];

      let models: FetchedModel[] = [];
      for (const account of sorted) {
        models = await fetchModelsForAccount(account);
        if (models.length > 0) break;
      }

      // If all accounts returned nothing, try fallback list
      if (models.length === 0 && FALLBACK_MODELS[provider]) {
        models = FALLBACK_MODELS[provider];
      }

      // Deduplicate by id
      const seen = new Set<string>();
      const unique = models.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      // Sort: alphabetically by name
      unique.sort((a, b) => a.name.localeCompare(b.name));

      // Update cache
      cache.set(provider, { models: unique, fetchedAt: Date.now() });

      return unique;
    } finally {
      inflight.delete(provider);
    }
  })();

  inflight.set(provider, promise);
  return promise;
}

/**
 * Fetch models from ALL enabled providers. Runs requests in parallel.
 * Returns models grouped by provider.
 */
export async function getAllModels(): Promise<FetchedModel[]> {
  const accounts = getEnabledAccounts();

  // Get unique providers
  const providers = [...new Set(accounts.map((a) => a.provider))];

  // Fetch all in parallel
  const results = await Promise.all(
    providers.map((p) => getModelsForProvider(p))
  );

  return results.flat();
}

/** Force-clear the cache for a specific provider or all providers. */
export function invalidateModelCache(provider?: string): void {
  if (provider) {
    cache.delete(provider);
  } else {
    cache.clear();
  }
}
