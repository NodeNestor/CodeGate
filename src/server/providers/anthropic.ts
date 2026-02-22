/**
 * Anthropic API provider.
 *
 * Forwards requests to api.anthropic.com and extracts token counts.
 * Supports both API key and OAuth subscription authentication.
 * For streaming responses, returns the body as a passthrough ReadableStream
 * while extracting token counts from a tee'd copy.
 */

import type { ProviderResponse, ForwardOptions } from "./types.js";

const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";

/**
 * Forward a request to the Anthropic API.
 *
 * For streaming responses (SSE), the body is returned as a ReadableStream
 * that can be piped directly to the client. Token counts are extracted from
 * a tee'd copy of the stream so we can report usage without buffering.
 */
export async function forwardRequest(
  opts: ForwardOptions
): Promise<ProviderResponse> {
  const { path, method, headers, body, apiKey, baseUrl, authType } = opts;

  // Build outgoing headers
  const outHeaders: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": headers["anthropic-version"] || "2023-06-01",
  };

  // OAuth tokens use Authorization: Bearer + required beta headers
  if (authType === "oauth") {
    outHeaders["authorization"] = `Bearer ${apiKey}`;
    const beta = headers["anthropic-beta"] || "";
    const betaParts = beta ? beta.split(",").map((s) => s.trim()) : [];
    if (!betaParts.includes("oauth-2025-04-20")) betaParts.push("oauth-2025-04-20");
    if (!betaParts.includes("claude-code-20250219")) betaParts.push("claude-code-20250219");
    outHeaders["anthropic-beta"] = betaParts.join(",");
    outHeaders["anthropic-dangerous-direct-browser-access"] = "true";
    // Forward Claude Code identity headers
    if (headers["user-agent"]) outHeaders["user-agent"] = headers["user-agent"];
    if (headers["x-app"]) outHeaders["x-app"] = headers["x-app"];
  } else {
    outHeaders["x-api-key"] = apiKey;
  }

  // Forward anthropic-beta header if present (for non-OAuth, or additional flags)
  if (headers["anthropic-beta"] && !outHeaders["anthropic-beta"]) {
    outHeaders["anthropic-beta"] = headers["anthropic-beta"];
  }

  // Build the target URL
  let targetUrl: string;
  const base = baseUrl || ANTHROPIC_DEFAULT_BASE;
  try {
    const parsed = new URL(base);
    const basePath = parsed.pathname.replace(/\/$/, "");
    targetUrl = `${parsed.protocol}//${parsed.host}${basePath}${path}`;
  } catch {
    // Invalid base URL -- fall back to default
    targetUrl = `${ANTHROPIC_DEFAULT_BASE}${path}`;
  }

  // Make the request using Node fetch (supports streaming)
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
    // Streaming response: tee the stream to extract tokens from one copy
    // while returning the other copy as the response body.
    const [streamForClient, streamForParsing] = response.body.tee();

    // Token extraction state - populated asynchronously
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model: "",
    };

    // Parse tokens from the tee'd stream in the background
    parseSSETokens(streamForParsing, usage).catch((err) => {
      console.error("[anthropic] Error parsing SSE tokens:", err);
    });

    return {
      status: response.status,
      headers: responseHeaders,
      body: streamForClient,
      get inputTokens() { return usage.inputTokens; },
      get outputTokens() { return usage.outputTokens; },
      get cacheReadTokens() { return usage.cacheReadTokens; },
      get cacheWriteTokens() { return usage.cacheWriteTokens; },
      get model() { return usage.model; },
      isStream: true,
    };
  }

  // Non-streaming response: buffer and parse
  const responseBody = await response.text();

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let model = "";

  // Check if the text looks like SSE even without the content-type header
  const looksLikeSSE = responseBody.trimStart().startsWith("event:");

  if (looksLikeSSE) {
    const parsed = parseSSEFromText(responseBody);
    inputTokens = parsed.inputTokens;
    outputTokens = parsed.outputTokens;
    cacheReadTokens = parsed.cacheReadTokens;
    cacheWriteTokens = parsed.cacheWriteTokens;
    model = parsed.model;
  } else {
    try {
      const parsed = JSON.parse(responseBody);
      model = parsed.model || "";
      if (parsed.usage) {
        inputTokens = parsed.usage.input_tokens || 0;
        outputTokens = parsed.usage.output_tokens || 0;
        cacheReadTokens = parsed.usage.cache_read_input_tokens || 0;
        cacheWriteTokens = parsed.usage.cache_creation_input_tokens || 0;
      }
    } catch {
      // Non-JSON response -- token counts stay 0
    }
  }

  return {
    status: response.status,
    headers: responseHeaders,
    body: responseBody,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    model,
    isStream: false,
  };
}

/**
 * Parse SSE events from a ReadableStream to extract token usage.
 * This consumes the stream entirely (used on the tee'd parsing copy).
 */
async function parseSSETokens(
  stream: ReadableStream<Uint8Array>,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    model: string;
  }
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      let lineEnd: number;
      while ((lineEnd = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);

        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6);
        if (jsonStr === "[DONE]") continue;

        try {
          const ev = JSON.parse(jsonStr);
          if (ev.type === "message_start" && ev.message) {
            usage.model = ev.message.model || usage.model;
            if (ev.message.usage) {
              usage.inputTokens = ev.message.usage.input_tokens || usage.inputTokens;
              usage.cacheReadTokens = ev.message.usage.cache_read_input_tokens || usage.cacheReadTokens;
              usage.cacheWriteTokens = ev.message.usage.cache_creation_input_tokens || usage.cacheWriteTokens;
            }
          } else if (ev.type === "message_delta" && ev.usage) {
            usage.outputTokens = ev.usage.output_tokens || usage.outputTokens;
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
 * Parse SSE events from a text buffer (for non-streaming but SSE-formatted responses).
 */
function parseSSEFromText(text: string): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let model = "";

  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const jsonStr = line.slice(6);
    if (jsonStr === "[DONE]") continue;
    try {
      const ev = JSON.parse(jsonStr);
      if (ev.type === "message_start" && ev.message) {
        model = ev.message.model || model;
        if (ev.message.usage) {
          inputTokens = ev.message.usage.input_tokens || inputTokens;
          cacheReadTokens = ev.message.usage.cache_read_input_tokens || cacheReadTokens;
          cacheWriteTokens = ev.message.usage.cache_creation_input_tokens || cacheWriteTokens;
        }
      } else if (ev.type === "message_delta" && ev.usage) {
        outputTokens = ev.usage.output_tokens || outputTokens;
      }
    } catch {
      // Skip non-JSON data lines
    }
  }

  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, model };
}

/**
 * Check which Anthropic API paths are supported.
 */
export function supportsPath(path: string): boolean {
  return (
    path.startsWith("/v1/messages") ||
    path.startsWith("/v1/complete")
  );
}
