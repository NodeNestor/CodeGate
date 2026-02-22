/**
 * OpenAI-compatible API provider.
 *
 * Forwards requests to api.openai.com (or custom base URL) and extracts
 * token counts. Works with OpenAI, DeepSeek, GLM, and any OpenAI-compatible
 * API provider.
 *
 * Supports streaming by returning the response body as a ReadableStream
 * when SSE is detected. Token counts are extracted from a tee'd copy.
 */

import type { ProviderResponse, ForwardOptions } from "./types.js";

const OPENAI_DEFAULT_BASE = "https://api.openai.com";

/**
 * Forward a request to an OpenAI-compatible API.
 */
export async function forwardRequest(
  opts: ForwardOptions
): Promise<ProviderResponse> {
  const { path, method, headers, body, apiKey, baseUrl } = opts;

  const outHeaders: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };

  // Forward OpenAI org header if present
  if (headers["openai-organization"]) {
    outHeaders["openai-organization"] = headers["openai-organization"];
  }

  // Codex subscription accounts need ChatGPT backend headers
  if (opts.externalAccountId) {
    outHeaders["ChatGPT-Account-ID"] = opts.externalAccountId;
    outHeaders["User-Agent"] = "codex_cli_rs/0.1.0";
    outHeaders["originator"] = "codex_cli_rs";
  }

  // Build the target URL
  // For Codex subscription accounts, use ChatGPT backend URL unless base_url is explicitly set
  const isCodexSub = !!opts.externalAccountId && !baseUrl;
  const base = isCodexSub ? "https://chatgpt.com/backend-api/codex" : (baseUrl || OPENAI_DEFAULT_BASE);
  let targetUrl: string;
  try {
    const parsed = new URL(base);
    const basePath = parsed.pathname.replace(/\/$/, "");

    // Gemini OpenAI-compat: use /v1beta/openai/ base and strip /v1 prefix from path
    if (parsed.host === "generativelanguage.googleapis.com") {
      const geminiPath = path.replace(/^\/v1\//, "/");
      targetUrl = `${parsed.protocol}//${parsed.host}/v1beta/openai${geminiPath}`;
    } else {
      // If the base URL already ends with a version segment (e.g. /v4, /v3),
      // strip the /v1 prefix from the forwarded path to avoid double-versioning.
      // This handles providers like GLM/z.ai whose base is .../v4 instead of .../v1.
      let adjustedPath = path;
      if (/\/v\d+$/.test(basePath)) {
        adjustedPath = path.replace(/^\/v1\//, "/");
      }
      targetUrl = `${parsed.protocol}//${parsed.host}${basePath}${adjustedPath}`;
    }
  } catch {
    targetUrl = `${OPENAI_DEFAULT_BASE}${path}`;
  }

  const response = await fetch(targetUrl, {
    method: method.toUpperCase(),
    headers: outHeaders,
    body: method.toUpperCase() !== "GET" ? body : undefined,
  });

  // Copy response headers
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  const contentType = responseHeaders["content-type"] || "";
  const isSSE = contentType.includes("text/event-stream");

  if (isSSE && response.body) {
    // Streaming response: tee for token extraction
    const [streamForClient, streamForParsing] = response.body.tee();

    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      model: "",
    };

    parseOpenAISSETokens(streamForParsing, usage).catch((err) => {
      console.error("[openai] Error parsing SSE tokens:", err);
    });

    return {
      status: response.status,
      headers: responseHeaders,
      body: streamForClient,
      get inputTokens() { return usage.inputTokens; },
      get outputTokens() { return usage.outputTokens; },
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      get model() { return usage.model; },
      isStream: true,
    };
  }

  // Non-streaming response: buffer and parse
  const responseBody = await response.text();

  let inputTokens = 0;
  let outputTokens = 0;
  let model = "";

  try {
    const parsed = JSON.parse(responseBody);
    model = parsed.model || "";

    if (parsed.usage) {
      inputTokens = parsed.usage.prompt_tokens || 0;
      outputTokens = parsed.usage.completion_tokens || 0;
    }
  } catch {
    // Non-JSON response -- token counts stay 0
  }

  return {
    status: response.status,
    headers: responseHeaders,
    body: responseBody,
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    model,
    isStream: false,
  };
}

/**
 * Parse OpenAI SSE stream events for token usage.
 * OpenAI reports usage in the final chunk or via a separate usage event.
 */
async function parseOpenAISSETokens(
  stream: ReadableStream<Uint8Array>,
  usage: { inputTokens: number; outputTokens: number; model: string }
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let lineEnd: number;
      while ((lineEnd = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);

        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6);
        if (jsonStr === "[DONE]") continue;

        try {
          const ev = JSON.parse(jsonStr);
          if (ev.model) usage.model = ev.model;
          if (ev.usage) {
            usage.inputTokens = ev.usage.prompt_tokens || usage.inputTokens;
            usage.outputTokens = ev.usage.completion_tokens || usage.outputTokens;
          }
        } catch {
          // Skip non-JSON data lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Check which OpenAI API paths are supported.
 */
export function supportsPath(path: string): boolean {
  return (
    path.startsWith("/v1/chat/completions") ||
    path.startsWith("/v1/completions") ||
    path.startsWith("/v1/embeddings") ||
    path.startsWith("/v1/models")
  );
}
