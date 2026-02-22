/**
 * Generic OpenAI-compatible API provider.
 *
 * Works with any provider that implements the OpenAI chat completions format:
 * GLM (ChatGLM/Zhipu), Google Gemini (via OpenAI compat), Together AI,
 * local models (vLLM, Ollama, LM Studio), etc.
 *
 * The caller specifies the full base URL (hostname + optional path prefix).
 * Supports streaming by returning the response body as a ReadableStream.
 */

import type { ProviderResponse, ForwardOptions } from "./types.js";

/**
 * Forward a request to a custom OpenAI-compatible API.
 */
export async function forwardRequest(
  opts: ForwardOptions
): Promise<ProviderResponse> {
  const { path, method, headers, body, apiKey, baseUrl } = opts;

  if (!baseUrl) {
    throw new Error("Custom provider requires a base_url");
  }

  // Build the full URL: baseUrl + API path
  let targetUrl: string;
  try {
    const parsed = new URL(baseUrl);
    const basePath = parsed.pathname.replace(/\/$/, "");
    targetUrl = `${parsed.protocol}//${parsed.host}${basePath}${path}`;
  } catch {
    throw new Error(`Invalid base URL for custom provider: ${baseUrl}`);
  }

  const outHeaders: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };

  // Forward any custom headers the caller sends
  if (headers["anthropic-version"]) {
    outHeaders["anthropic-version"] = headers["anthropic-version"];
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

    parseCustomSSETokens(streamForParsing, usage).catch((err) => {
      console.error("[custom] Error parsing SSE tokens:", err);
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

    // Flexible OpenAI-compatible usage format
    if (parsed.usage) {
      inputTokens = parsed.usage.prompt_tokens || parsed.usage.input_tokens || 0;
      outputTokens = parsed.usage.completion_tokens || parsed.usage.output_tokens || 0;
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
 * Parse SSE stream events using flexible token extraction
 * (supports both OpenAI and custom field names).
 */
async function parseCustomSSETokens(
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
            usage.inputTokens =
              ev.usage.prompt_tokens || ev.usage.input_tokens || usage.inputTokens;
            usage.outputTokens =
              ev.usage.completion_tokens || ev.usage.output_tokens || usage.outputTokens;
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
 * Custom endpoints support any path.
 */
export function supportsPath(_path: string): boolean {
  return true;
}
