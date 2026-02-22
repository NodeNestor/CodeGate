/**
 * OpenRouter API provider.
 *
 * Forwards requests to openrouter.ai/api and extracts token counts.
 * OpenRouter uses an OpenAI-compatible format with /api prefix on paths.
 *
 * Supports streaming by returning the response body as a ReadableStream.
 */

import type { ProviderResponse, ForwardOptions } from "./types.js";

const OPENROUTER_DEFAULT_BASE = "https://openrouter.ai";

/**
 * Forward a request to the OpenRouter API.
 */
export async function forwardRequest(
  opts: ForwardOptions
): Promise<ProviderResponse> {
  const { path, method, headers, body, apiKey } = opts;

  // OpenRouter uses /api/v1/... prefix
  const apiPath = path.startsWith("/api") ? path : `/api${path}`;

  const outHeaders: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    "http-referer": headers["http-referer"] || "https://claude-proxy.local",
    "x-title": headers["x-title"] || "ClaudeProxy",
  };

  const targetUrl = `${OPENROUTER_DEFAULT_BASE}${apiPath}`;

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

    parseOpenRouterSSETokens(streamForParsing, usage).catch((err) => {
      console.error("[openrouter] Error parsing SSE tokens:", err);
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

    // OpenRouter can return usage in the standard OpenAI format
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
 * Parse OpenRouter SSE stream events for token usage (OpenAI-compatible format).
 */
async function parseOpenRouterSSETokens(
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
 * Check which OpenRouter API paths are supported.
 */
export function supportsPath(path: string): boolean {
  return (
    path.startsWith("/v1/chat/completions") ||
    path.startsWith("/v1/completions") ||
    path.startsWith("/v1/models") ||
    path.startsWith("/api/v1/")
  );
}
