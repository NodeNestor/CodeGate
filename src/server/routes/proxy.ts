/**
 * Universal LLM Proxy Route.
 *
 * Hono router mounted on port 9112 that handles:
 *   - Anthropic Messages API requests (/v1/messages) from Claude Code
 *   - OpenAI Chat Completions requests (/v1/chat/completions) from Cline, Aider, Codex, etc.
 *   - Automatic routing via config-manager (tier detection, account selection)
 *   - Format conversion (Anthropic <-> OpenAI) as needed for provider/client mismatch
 *   - SSE streaming passthrough with on-the-fly format conversion
 *   - Failover across multiple accounts on 429/5xx errors
 *   - Async usage recording
 *   - Privacy filter (anonymize/deanonymize)
 *
 * The proxy accepts BOTH inbound formats and converts to whatever the target
 * provider needs. Responses are converted back to the client's expected format.
 *
 * Four conversion paths:
 *   Anthropic client → Anthropic provider: pass-through
 *   Anthropic client → OpenAI provider: convert request/response
 *   OpenAI client → OpenAI provider: pass-through (model remapping only)
 *   OpenAI client → Anthropic provider: convert request/response
 */

import { Hono } from "hono";

import { resolveRoute } from "../config-manager.js";
import {
  recordUsage,
  recordAccountSuccess,
  recordAccountError,
  updateAccountStatus,
  getSetting,
  insertRequestLog,
  getTenantByKeyHash,
  hashApiKey,
  hasTenants,
  type AccountDecrypted,
} from "../db.js";
import {
  setCooldown,
  isOnCooldown,
  clearCooldown,
  sortByCooldown,
  parseRetryAfter,
} from "../cooldown-manager.js";
import { detectTier } from "../model-mapper.js";
import { checkAndRecordRequest, isRateLimited } from "../rate-limiter.js";
import { clampMaxTokens } from "../model-limits.js";
import { ensureValidToken, forceSyncFromFile } from "../auth-refresh.js";
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  convertSSEStream,
  openAIToAnthropicRequest,
  anthropicToOpenAIResponse,
  convertAnthropicSSEToOpenAI,
} from "../format-converter.js";

import * as anthropicProvider from "../providers/anthropic.js";
import * as openaiCompatProvider from "../providers/openai-compat.js";
import * as openrouterProvider from "../providers/openrouter.js";
import * as customProvider from "../providers/custom.js";
import * as codexProvider from "../providers/codex.js";

import type { ProviderResponse, ForwardOptions } from "../providers/types.js";

import {
  isGuardrailsEnabled,
  runGuardrailsOnRequestBody,
  deanonymize,
  createDeanonymizeStream,
} from "../guardrails/manager.js";

const proxy = new Hono();

// ─── Configuration ──────────────────────────────────────────────────────────

type InboundFormat = "anthropic" | "openai";

// ─── Health check ───────────────────────────────────────────────────────────

proxy.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "2.0.0",
  });
});

// ─── Auth middleware ────────────────────────────────────────────────────────

function validateApiKey(c: any): { valid: boolean; tenantId?: string } {
  const envKey = process.env.PROXY_API_KEY;

  // Extract key from headers
  const xApiKey = c.req.header("x-api-key");
  const authHeader = c.req.header("authorization");
  const key = xApiKey || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null);

  // 1. Legacy: PROXY_API_KEY env var (backwards compat)
  if (envKey) {
    return { valid: key === envKey };
  }

  // 2. Simple mode: match against stored proxy_api_key
  if (getSetting("multi_tenancy") !== "true") {
    const storedKey = getSetting("proxy_api_key");
    if (!storedKey) return { valid: true }; // no key configured → open
    return { valid: key === storedKey };
  }

  // 3. No tenants at all → open mode (pre-first-boot edge case)
  if (!hasTenants()) {
    return { valid: true };
  }

  // 4. No key provided → reject
  if (!key) {
    return { valid: false };
  }

  // 5. Tenant key lookup via hash
  const hash = hashApiKey(key);
  const tenant = getTenantByKeyHash(hash);
  if (tenant) {
    return { valid: true, tenantId: tenant.id };
  }

  return { valid: false };
}

// ─── OpenAI Models endpoint ─────────────────────────────────────────────────

proxy.get("/v1/models", (c) => {
  // Return a minimal models list so OpenAI-format clients can discover models
  return c.json({
    object: "list",
    data: [
      { id: "claude-sonnet-4-20250514", object: "model", created: 1700000000, owned_by: "anthropic" },
      { id: "claude-opus-4-20250514", object: "model", created: 1700000000, owned_by: "anthropic" },
      { id: "claude-haiku-4-20250514", object: "model", created: 1700000000, owned_by: "anthropic" },
      { id: "claude-sonnet-4-20250514", object: "model", created: 1700000000, owned_by: "proxy" },
    ],
  });
});

// ─── Main proxy handler (both formats) ──────────────────────────────────────

proxy.all("/v1/*", async (c) => {
  const startTime = Date.now();
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;

  // Handle CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
        "access-control-allow-headers": "*",
      },
    });
  }

  // 1. Validate proxy API key
  const { valid } = validateApiKey(c);
  if (!valid) {
    return c.json(
      {
        type: "error",
        error: {
          type: "authentication_error",
          message: "Invalid or missing proxy API key",
        },
      },
      401
    );
  }

  // 2. Detect inbound format from path
  const inboundFormat: InboundFormat = path.includes("/chat/completions")
    ? "openai"
    : "anthropic";

  // 3. Read request body
  let bodyText: string;
  try {
    bodyText = await c.req.text();
  } catch {
    return c.json(
      {
        type: "error",
        error: { type: "invalid_request_error", message: "Failed to read request body" },
      },
      400
    );
  }

  // 4. Parse body JSON
  let bodyJson: Record<string, unknown> = {};
  let originalModel = "claude-sonnet-4-20250514";
  let isStreamRequest = false;

  if (bodyText) {
    try {
      bodyJson = JSON.parse(bodyText);
      if (typeof bodyJson.model === "string") {
        originalModel = bodyJson.model as string;
      }
      isStreamRequest = bodyJson.stream === true;
    } catch {
      return c.json(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "Invalid JSON in request body" },
        },
        400
      );
    }
  }

  // 5. If inbound is OpenAI format, convert to Anthropic internally for routing
  let anthropicBody = bodyJson;
  if (inboundFormat === "openai" && bodyText) {
    try {
      anthropicBody = openAIToAnthropicRequest(bodyJson);
      // Ensure model is preserved for routing
      if (typeof bodyJson.model === "string") {
        anthropicBody.model = bodyJson.model;
      }
    } catch (err) {
      console.error("[proxy] Failed to convert OpenAI request to internal format:", err);
      return c.json(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "Failed to parse OpenAI-format request" },
        },
        400
      );
    }
  }

  // 6. Guardrails: anonymize outgoing request body
  const guardrailsActive = isGuardrailsEnabled();
  if (guardrailsActive && bodyText) {
    try {
      anthropicBody = runGuardrailsOnRequestBody(anthropicBody as any) as any;
    } catch (err) {
      console.error("[proxy] Guardrails anonymization failed:", err);
    }
  }

  // 7. Detect tier via model-mapper
  const tier = detectTier(originalModel);

  // 8. Resolve route via config-manager
  const route = resolveRoute(originalModel);

  if (!route) {
    const errPayload = inboundFormat === "openai"
      ? { error: { message: "No available accounts to handle this request. Configure accounts and an active routing config.", type: "server_error", code: 503 } }
      : { type: "error", error: { type: "overloaded_error", message: "No available accounts to handle this request. Configure accounts and an active routing config." } };
    return c.json(errPayload, 503);
  }

  // Collect all candidate accounts for failover
  const rawCandidates = [
    { account: route.account, targetModel: route.targetModel },
    ...route.fallbacks,
  ];

  const allCandidates = sortByCooldown(rawCandidates);

  const autoSwitchOnError = getSetting("auto_switch_on_error") !== "false";
  const autoSwitchOnRateLimit = getSetting("auto_switch_on_rate_limit") !== "false";

  // Extract request headers for forwarding
  const reqHeaders: Record<string, string> = {};
  c.req.raw.headers.forEach((value: string, key: string) => {
    reqHeaders[key.toLowerCase()] = value;
  });

  // Try each candidate account in order (primary + fallbacks)
  for (let i = 0; i < allCandidates.length; i++) {
    const candidate = allCandidates[i];
    let account = candidate.account;
    const targetModel = candidate.targetModel || originalModel;
    const isFailover = i > 0;
    const isLastCandidate = i === allCandidates.length - 1;
    const targetIsAnthropic = account.provider === "anthropic";

    // Skip cooled-down accounts unless it's the last candidate
    if (!isLastCandidate && isOnCooldown(account.id)) {
      console.log(
        `[proxy] Skipping "${account.name}" (on cooldown), ${allCandidates.length - i - 1} candidates left`
      );
      continue;
    }

    // Atomic rate limit check + record BEFORE sending to provider.
    // This eliminates the TOCTOU race between checking and recording.
    if (checkAndRecordRequest(account.id, account.rate_limit)) {
      if (!isLastCandidate) {
        console.log(
          `[proxy] Skipping "${account.name}" (rate limited locally), ${allCandidates.length - i - 1} candidates left`
        );
        continue;
      } else {
        // Last candidate and rate limited -- return 429 to client
        const errPayload = inboundFormat === "openai"
          ? { error: { message: `Rate limit exceeded for account "${account.name}" (${account.rate_limit} req/min)`, type: "rate_limit_error", code: 429 } }
          : { type: "error", error: { type: "rate_limit_error", message: `Rate limit exceeded for account "${account.name}" (${account.rate_limit} req/min)` } };
        return c.json(errPayload, 429);
      }
    }

    try {
      // Ensure OAuth tokens are fresh
      if (account.auth_type === "oauth") {
        account = await ensureValidToken(account);
      }

      const strategy = route.configId ? "config" : "direct";
      console.log(
        `[proxy] ${isFailover ? "Failover" : "Routing"} [${inboundFormat}] to "${account.name}" (${account.provider}/${account.auth_type}) model=${targetModel}`
      );

      let providerResponse: ProviderResponse;

      // ── Decide conversion path ──────────────────────────────────────
      //
      // There are 4 combinations of inbound format × target provider format.
      // We optimize to avoid unnecessary double-conversion.

      if (inboundFormat === "openai" && !targetIsAnthropic) {
        // OpenAI client → OpenAI-compatible provider: forward mostly as-is
        const forwardBody: Record<string, unknown> = { ...bodyJson, model: targetModel };
        // Clamp max_tokens to model limits
        if (forwardBody.max_tokens !== undefined) {
          forwardBody.max_tokens = clampMaxTokens(forwardBody.max_tokens as number, targetModel);
        }
        if (forwardBody.max_completion_tokens !== undefined) {
          forwardBody.max_completion_tokens = clampMaxTokens(forwardBody.max_completion_tokens as number, targetModel);
        }
        const forwardBodyStr = JSON.stringify(forwardBody);

        providerResponse = await forwardToProvider(account, {
          path: "/v1/chat/completions",
          method,
          headers: reqHeaders,
          body: forwardBodyStr,
          apiKey: account.api_key || "",
          baseUrl: account.base_url,
          authType: account.auth_type,
          externalAccountId: account.external_account_id,
        });
      } else if (inboundFormat === "openai" && targetIsAnthropic) {
        // OpenAI client → Anthropic provider: convert request to Anthropic format
        const anthropicForwardBody = { ...anthropicBody, model: targetModel };
        const forwardBodyStr = JSON.stringify(anthropicForwardBody);

        providerResponse = await forwardToProvider(account, {
          path: "/v1/messages",
          method,
          headers: reqHeaders,
          body: forwardBodyStr,
          apiKey: account.api_key || "",
          baseUrl: account.base_url,
          authType: account.auth_type,
          externalAccountId: account.external_account_id,
        });
      } else if (inboundFormat === "anthropic" && !targetIsAnthropic) {
        // Anthropic client → OpenAI-compatible provider: convert request to OpenAI format
        const openaiBody = anthropicToOpenAI(anthropicBody, targetModel);
        const openaiPath = "/v1/chat/completions";
        const openaiBodyStr = JSON.stringify(openaiBody);

        providerResponse = await forwardToProvider(account, {
          path: openaiPath,
          method,
          headers: reqHeaders,
          body: openaiBodyStr,
          apiKey: account.api_key || "",
          baseUrl: account.base_url,
          authType: account.auth_type,
          externalAccountId: account.external_account_id,
        });
      } else {
        // Anthropic client → Anthropic provider: forward as-is
        const forwardBody = { ...anthropicBody, model: targetModel };
        const forwardBodyStr = JSON.stringify(forwardBody);

        providerResponse = await forwardToProvider(account, {
          path: path.startsWith("/v1/messages") ? path : "/v1/messages",
          method,
          headers: reqHeaders,
          body: forwardBodyStr,
          apiKey: account.api_key || "",
          baseUrl: account.base_url,
          authType: account.auth_type,
          externalAccountId: account.external_account_id,
        });
      }

      // ── Check for retryable errors ──────────────────────────────────

      if (providerResponse.status === 429) {
        updateAccountStatus(account.id, "rate_limited", "Rate limited (429)");
        recordAccountError(account.id, "Rate limited (429)");
        const retryAfterSec = parseRetryAfter(providerResponse.headers["retry-after"]);
        setCooldown(account.id, "rate_limit", retryAfterSec);
        if (autoSwitchOnRateLimit && !isLastCandidate) {
          console.log(`[proxy] Got 429 from "${account.name}", trying failover...`);
          continue;
        }
      } else if (providerResponse.status >= 500) {
        recordAccountError(account.id, `Server error (${providerResponse.status})`);
        setCooldown(account.id, "server_error");
        if (autoSwitchOnError && !isLastCandidate) {
          console.log(`[proxy] Got ${providerResponse.status} from "${account.name}", trying failover...`);
          continue;
        }
      }

      // Handle 401 from Anthropic OAuth -- try syncing from credential file
      if (
        providerResponse.status === 401 &&
        account.auth_type === "oauth" &&
        account.provider === "anthropic"
      ) {
        updateAccountStatus(account.id, "expired", "Authentication failed (401)");
        recordAccountError(account.id, "Authentication failed (401)");
        console.log(`[proxy] Got 401 for OAuth account "${account.name}", syncing from credential file...`);
        const synced = forceSyncFromFile(account);
        if (synced) {
          account = synced;
          try {
            const retryBody = targetIsAnthropic
              ? JSON.stringify({ ...anthropicBody, model: targetModel })
              : JSON.stringify(anthropicToOpenAI(anthropicBody, targetModel));
            const retryPath = targetIsAnthropic ? "/v1/messages" : "/v1/chat/completions";

            providerResponse = await forwardToProvider(account, {
              path: retryPath,
              method,
              headers: reqHeaders,
              body: retryBody,
              apiKey: account.api_key || "",
              baseUrl: account.base_url,
              authType: account.auth_type,
            });
            console.log(`[proxy] Retry after credential file sync succeeded (status ${providerResponse.status})`);
          } catch (retryErr) {
            console.error("[proxy] Retry after sync failed:", retryErr);
            if (!isLastCandidate) continue;
          }
        } else {
          console.warn("[proxy] No fresh tokens in credential file");
          if (!isLastCandidate) continue;
        }
      }

      // ── Handle streaming response ───────────────────────────────────

      if (providerResponse.isStream && providerResponse.body instanceof ReadableStream) {
        let responseStream: ReadableStream<Uint8Array> = providerResponse.body;

        if (providerResponse.status >= 200 && providerResponse.status < 300) {
          recordAccountSuccess(account.id);
          clearCooldown(account.id);
        }

        // Convert stream format if there's a mismatch between provider format and client format
        if (inboundFormat === "anthropic" && !targetIsAnthropic) {
          // Provider sends OpenAI SSE, client wants Anthropic SSE
          responseStream = convertSSEStream(responseStream, originalModel);
        } else if (inboundFormat === "openai" && targetIsAnthropic) {
          // Provider sends Anthropic SSE, client wants OpenAI SSE
          responseStream = convertAnthropicSSEToOpenAI(responseStream, targetModel);
        }
        // If formats match (openai→openai or anthropic→anthropic), no conversion needed

        // Guardrails: deanonymize streaming response
        if (guardrailsActive) {
          responseStream = createDeanonymizeStream(responseStream);
        }

        // Record usage asynchronously
        setImmediate(() => {
          try {
            recordUsage({
              account_id: account.id,
              config_id: route.configId || undefined,
              tier: tier || undefined,
              original_model: originalModel,
              routed_model: targetModel,
              input_tokens: providerResponse.inputTokens,
              output_tokens: providerResponse.outputTokens,
              cache_read_tokens: providerResponse.cacheReadTokens,
              cache_write_tokens: providerResponse.cacheWriteTokens,
            });
          } catch (err) {
            console.error("[proxy] Failed to record usage:", err);
          }
        });

        // Log the streaming request
        logRequest({
          method, path, inboundFormat: inboundFormat,
          account, originalModel, targetModel,
          statusCode: providerResponse.status,
          inputTokens: providerResponse.inputTokens,
          outputTokens: providerResponse.outputTokens,
          latencyMs: Date.now() - startTime,
          isStream: true, isFailover,
          requestBody: bodyText,
        });

        const responseHeaders: Record<string, string> = {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-proxy-account": account.name,
          "x-proxy-strategy": isFailover ? `${strategy}+failover` : strategy,
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-expose-headers": "x-proxy-account, x-proxy-strategy",
        };

        return new Response(responseStream, {
          status: providerResponse.status,
          headers: responseHeaders,
        });
      }

      // ── Handle non-streaming response ───────────────────────────────

      let responseBodyStr: string;
      if (typeof providerResponse.body === "string") {
        responseBodyStr = providerResponse.body;
      } else {
        const reader = (providerResponse.body as ReadableStream<Uint8Array>).getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        responseBodyStr = new TextDecoder().decode(combined);
      }

      // Convert response format if there's a mismatch
      if (providerResponse.status >= 200 && providerResponse.status < 300) {
        try {
          if (inboundFormat === "anthropic" && !targetIsAnthropic) {
            // Provider returned OpenAI format, client wants Anthropic
            const openaiResponse = JSON.parse(responseBodyStr);
            const anthropicResponse = openAIToAnthropic(openaiResponse, originalModel);
            responseBodyStr = JSON.stringify(anthropicResponse);
          } else if (inboundFormat === "openai" && targetIsAnthropic) {
            // Provider returned Anthropic format, client wants OpenAI
            const anthropicResponse = JSON.parse(responseBodyStr);
            const openaiResponse = anthropicToOpenAIResponse(anthropicResponse, targetModel);
            responseBodyStr = JSON.stringify(openaiResponse);
          }
          // If formats match, no conversion needed
        } catch {
          // Could not parse/convert -- return raw response
        }
      } else {
        // Error response: convert to the client's expected error format
        if (inboundFormat === "openai") {
          responseBodyStr = toOpenAIError(responseBodyStr, providerResponse.status, account.provider);
        } else if (!targetIsAnthropic) {
          responseBodyStr = toAnthropicError(responseBodyStr, providerResponse.status, account.provider);
        }
      }

      // Guardrails: deanonymize non-streaming response
      if (guardrailsActive) {
        try {
          responseBodyStr = deanonymize(responseBodyStr);
        } catch (err) {
          console.error("[proxy] Guardrails deanonymization failed:", err);
        }
      }

      // Track account status
      if (providerResponse.status >= 200 && providerResponse.status < 300) {
        recordAccountSuccess(account.id);
        clearCooldown(account.id);
      } else if (providerResponse.status === 401) {
        updateAccountStatus(account.id, "expired", "Authentication failed (401)");
        recordAccountError(account.id, "Authentication failed (401)");
      } else if (providerResponse.status === 429) {
        updateAccountStatus(account.id, "rate_limited", "Rate limited (429)");
        recordAccountError(account.id, "Rate limited (429)");
      } else if (providerResponse.status >= 400) {
        recordAccountError(account.id, `HTTP ${providerResponse.status}`);
        updateAccountStatus(account.id, "error", `HTTP ${providerResponse.status}`);
      }

      // Record usage asynchronously
      setImmediate(() => {
        try {
          recordUsage({
            account_id: account.id,
            config_id: route.configId || undefined,
            tier: tier || undefined,
            original_model: originalModel,
            routed_model: targetModel,
            input_tokens: providerResponse.inputTokens,
            output_tokens: providerResponse.outputTokens,
            cache_read_tokens: providerResponse.cacheReadTokens,
            cache_write_tokens: providerResponse.cacheWriteTokens,
          });
        } catch (err) {
          console.error("[proxy] Failed to record usage:", err);
        }
      });

      // Log the non-streaming request
      logRequest({
        method, path, inboundFormat: inboundFormat,
        account, originalModel, targetModel,
        statusCode: providerResponse.status,
        inputTokens: providerResponse.inputTokens,
        outputTokens: providerResponse.outputTokens,
        latencyMs: Date.now() - startTime,
        isStream: false, isFailover,
        requestBody: bodyText,
        responseBody: responseBodyStr,
        errorMessage: providerResponse.status >= 400 ? responseBodyStr.substring(0, 1000) : undefined,
      });

      const upstreamContentType = providerResponse.headers["content-type"] || "application/json";

      const responseHeaders: Record<string, string> = {
        "content-type": upstreamContentType,
        "x-proxy-account": account.name,
        "x-proxy-strategy": isFailover ? `${strategy}+failover` : strategy,
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-expose-headers": "x-proxy-account, x-proxy-strategy",
      };

      return new Response(responseBodyStr, {
        status: providerResponse.status,
        headers: responseHeaders,
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[proxy] Error forwarding to "${account.name}":`, errMsg);

      recordAccountError(account.id, errMsg);
      updateAccountStatus(account.id, "error", errMsg);
      setCooldown(account.id, "connection_error");

      if (autoSwitchOnError && !isLastCandidate) {
        console.log(`[proxy] Attempting failover (${allCandidates.length - i - 1} accounts left)...`);
        continue;
      }

      const errPayload = inboundFormat === "openai"
        ? { error: { message: `All provider accounts failed. Last error: ${errMsg}`, type: "server_error", code: 502 } }
        : { type: "error", error: { type: "api_error", message: `All provider accounts failed. Last error: ${errMsg}` } };
      return c.json(errPayload, 502);
    }
  }

  // All candidates exhausted
  const errPayload = inboundFormat === "openai"
    ? { error: { message: "No accounts available after exhausting all candidates", type: "server_error", code: 502 } }
    : { type: "error", error: { type: "api_error", message: "No accounts available after exhausting all candidates" } };
  return c.json(errPayload, 502);
});

// ─── Provider dispatch ──────────────────────────────────────────────────────

async function forwardToProvider(
  account: AccountDecrypted,
  opts: ForwardOptions
): Promise<ProviderResponse> {
  // Codex subscription accounts use the Responses API, not Chat Completions
  if (
    (account.provider === "openai" || account.provider === "openai_sub") &&
    account.external_account_id &&
    account.auth_type === "oauth"
  ) {
    return codexProvider.forwardRequest(opts);
  }

  switch (account.provider) {
    case "anthropic":
      return anthropicProvider.forwardRequest(opts);

    case "openai":
    case "openai_sub":
    case "glm":
    case "cerebras":
    case "deepseek":
    case "gemini":
    case "minimax":
      return openaiCompatProvider.forwardRequest(opts);

    case "openrouter":
      return openrouterProvider.forwardRequest(opts);

    default:
      if (account.base_url) {
        return customProvider.forwardRequest(opts);
      }
      throw new Error(`Unknown provider "${account.provider}" with no base_url configured`);
  }
}

// ─── Error format helpers ───────────────────────────────────────────────────

function toOpenAIError(rawBody: string, status: number, provider: string): string {
  try {
    const parsed = JSON.parse(rawBody);
    const errMsg =
      parsed?.error?.message ||
      parsed?.message ||
      parsed?.detail ||
      `Provider ${provider} returned HTTP ${status}`;
    return JSON.stringify({
      error: { message: errMsg, type: "server_error", code: status },
    });
  } catch {
    return JSON.stringify({
      error: { message: `Provider ${provider} returned HTTP ${status}`, type: "server_error", code: status },
    });
  }
}

function toAnthropicError(rawBody: string, status: number, provider: string): string {
  try {
    const parsed = JSON.parse(rawBody);
    const errMsg =
      parsed?.error?.message ||
      parsed?.message ||
      parsed?.detail ||
      `Provider ${provider} returned HTTP ${status}`;
    const errType =
      status === 401 ? "authentication_error" :
      status === 404 ? "not_found_error" :
      status === 429 ? "rate_limit_error" :
      status >= 500 ? "api_error" :
      "invalid_request_error";
    return JSON.stringify({
      type: "error",
      error: { type: errType, message: errMsg },
    });
  } catch {
    return JSON.stringify({
      type: "error",
      error: { type: "api_error", message: `Provider ${provider} returned HTTP ${status}` },
    });
  }
}

// ─── Request logging helper ─────────────────────────────────────────────────

function logRequest(opts: {
  method: string;
  path: string;
  inboundFormat: string;
  account: AccountDecrypted;
  originalModel: string;
  targetModel: string;
  statusCode: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  isStream: boolean;
  isFailover: boolean;
  errorMessage?: string;
  requestBody?: string;
  responseBody?: string;
}): void {
  if (getSetting("request_logging") !== "true") return;

  const detailed = getSetting("detailed_request_logging") === "true";

  setImmediate(() => {
    try {
      insertRequestLog({
        method: opts.method,
        path: opts.path,
        inbound_format: opts.inboundFormat,
        account_id: opts.account.id,
        account_name: opts.account.name,
        provider: opts.account.provider,
        original_model: opts.originalModel,
        routed_model: opts.targetModel,
        status_code: opts.statusCode,
        input_tokens: opts.inputTokens,
        output_tokens: opts.outputTokens,
        latency_ms: opts.latencyMs,
        is_stream: opts.isStream,
        is_failover: opts.isFailover,
        error_message: opts.errorMessage,
        request_body: detailed ? opts.requestBody : undefined,
        response_body: detailed ? opts.responseBody : undefined,
      });
    } catch (err) {
      console.error("[proxy] Failed to log request:", err);
    }
  });
}

export default proxy;
