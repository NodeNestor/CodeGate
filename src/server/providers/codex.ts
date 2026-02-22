/**
 * Codex (ChatGPT backend) provider.
 *
 * Uses the OpenAI Responses API at chatgpt.com/backend-api/codex/responses
 * which is the only completions endpoint supported by Codex subscription tokens.
 *
 * Converts between OpenAI Chat Completions format (used by the proxy internally)
 * and the Responses API format used by the ChatGPT backend.
 */

import type { ProviderResponse, ForwardOptions } from "./types.js";

const CODEX_BASE = "https://chatgpt.com/backend-api/codex";

/**
 * Convert OpenAI Chat Completions request body to Responses API format.
 */
function chatCompletionsToResponsesAPI(body: any): any {
  const result: any = {
    model: body.model,
    instructions: "",
    input: [],
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    stream: body.stream ?? true,
    store: false,
  };

  // Extract system messages as instructions
  const systemParts: string[] = [];

  if (body.messages) {
    for (const msg of body.messages) {
      if (msg.role === "system") {
        systemParts.push(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
      } else if (msg.role === "user") {
        const content = typeof msg.content === "string"
          ? [{ type: "input_text", text: msg.content }]
          : Array.isArray(msg.content)
            ? msg.content.map((c: any) => {
                if (c.type === "text") return { type: "input_text", text: c.text };
                if (c.type === "image_url") return { type: "input_image", image_url: c.image_url?.url };
                return { type: "input_text", text: JSON.stringify(c) };
              })
            : [{ type: "input_text", text: String(msg.content || "") }];
        result.input.push({ type: "message", role: "user", content });
      } else if (msg.role === "assistant") {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Emit the assistant text first if present
          if (msg.content) {
            result.input.push({
              type: "message", role: "assistant",
              content: [{ type: "output_text", text: msg.content }],
            });
          }
          // Then emit each tool call
          for (const tc of msg.tool_calls) {
            result.input.push({
              type: "function_call",
              call_id: tc.id,
              name: tc.function?.name || tc.name,
              arguments: tc.function?.arguments || "{}",
            });
          }
        } else {
          const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
          result.input.push({
            type: "message", role: "assistant",
            content: [{ type: "output_text", text }],
          });
        }
      } else if (msg.role === "tool") {
        result.input.push({
          type: "function_call_output",
          call_id: msg.tool_call_id,
          output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || ""),
        });
      }
    }
  }

  result.instructions = systemParts.join("\n");

  // Convert tools
  if (body.tools && body.tools.length > 0) {
    result.tools = body.tools.map((t: any) => ({
      type: "function",
      name: t.function?.name || t.name,
      description: t.function?.description || t.description || "",
      parameters: t.function?.parameters || t.parameters || {},
    }));
  }

  // Convert tool_choice
  if (body.tool_choice) {
    if (body.tool_choice === "auto") result.tool_choice = "auto";
    else if (body.tool_choice === "required") result.tool_choice = "required";
    else if (body.tool_choice === "none") result.tool_choice = "none";
    else if (typeof body.tool_choice === "object" && body.tool_choice.function?.name) {
      result.tool_choice = { type: "function", name: body.tool_choice.function.name };
    }
  }

  // Reasoning settings
  if (body.reasoning_effort || body.reasoning) {
    result.reasoning = body.reasoning || { effort: body.reasoning_effort || "medium" };
  }

  return result;
}

/**
 * Parse Responses API SSE stream and convert to OpenAI Chat Completions SSE format.
 */
function convertResponsesSSE(
  stream: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  const messageId = `chatcmpl-${Date.now()}`;
  let sentFirstChunk = false;
  let toolCallIndex = 0;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const dataStr = trimmed.slice(6);
            if (dataStr === "[DONE]") {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              continue;
            }

            let parsed: any;
            try { parsed = JSON.parse(dataStr); } catch { continue; }
            const eventType = parsed.type;

            if (!sentFirstChunk) {
              sentFirstChunk = true;
              // Send initial role chunk
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({
                  id: messageId, object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000), model,
                  choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
                })}\n\n`
              ));
            }

            // Text content delta
            if (eventType === "response.output_text.delta" && parsed.delta) {
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({
                  id: messageId, object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000), model,
                  choices: [{ index: 0, delta: { content: parsed.delta }, finish_reason: null }],
                })}\n\n`
              ));
            }

            // Reasoning text delta
            if (eventType === "response.reasoning_summary_text.delta" && parsed.delta) {
              // Emit as reasoning_content for compatibility
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({
                  id: messageId, object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000), model,
                  choices: [{ index: 0, delta: { reasoning_content: parsed.delta }, finish_reason: null }],
                })}\n\n`
              ));
            }

            // Function call output item
            if (eventType === "response.output_item.done" && parsed.item) {
              const item = parsed.item;
              if (item.type === "function_call") {
                // Emit tool call as a complete chunk
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({
                    id: messageId, object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, delta: {
                      tool_calls: [{
                        index: toolCallIndex++,
                        id: item.call_id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        type: "function",
                        function: { name: item.name, arguments: item.arguments || "{}" },
                      }],
                    }, finish_reason: null }],
                  })}\n\n`
                ));
              }
            }

            // Response completed
            if (eventType === "response.completed" || eventType === "response.done") {
              const hasToolCalls = toolCallIndex > 0;
              const finishReason = hasToolCalls ? "tool_calls" : "stop";

              // Usage info
              const usage = parsed.response?.usage || parsed.usage;

              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({
                  id: messageId, object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000), model,
                  choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                  usage: usage ? {
                    prompt_tokens: usage.input_tokens ?? 0,
                    completion_tokens: usage.output_tokens ?? 0,
                    total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
                  } : undefined,
                })}\n\n`
              ));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            }

            // Error
            if (eventType === "response.failed") {
              const errorMsg = parsed.response?.status_details?.error?.message || "Codex request failed";
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({
                  error: { message: errorMsg, type: "server_error" },
                })}\n\n`
              ));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            }
          }
        }
      } catch (err) {
        controller.error(err);
      } finally {
        controller.close();
        reader.releaseLock();
      }
    },
  });
}

/**
 * Forward a request to the Codex (ChatGPT backend) via the Responses API.
 */
export async function forwardRequest(
  opts: ForwardOptions
): Promise<ProviderResponse> {
  const { body, apiKey } = opts;

  // Parse the Chat Completions request body
  let parsedBody: any;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    return {
      status: 400,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: { message: "Invalid request body" } }),
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      model: "", isStream: false,
    };
  }

  // Convert to Responses API format
  const responsesBody = chatCompletionsToResponsesAPI(parsedBody);
  const isStream = responsesBody.stream;

  const outHeaders: Record<string, string> = {
    "content-type": "application/json",
    "authorization": `Bearer ${apiKey}`,
    "User-Agent": "codex_cli_rs/0.1.0",
    "originator": "codex_cli_rs",
  };

  if (opts.externalAccountId) {
    outHeaders["ChatGPT-Account-ID"] = opts.externalAccountId;
  }

  const targetUrl = `${CODEX_BASE}/responses`;

  const response = await fetch(targetUrl, {
    method: "POST",
    headers: outHeaders,
    body: JSON.stringify(responsesBody),
  });

  // Copy response headers
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  if (response.body && isStream) {
    // Convert Responses API SSE to OpenAI Chat Completions SSE
    const convertedStream = convertResponsesSSE(response.body, parsedBody.model);

    // Also tee to extract usage
    const [streamForClient, streamForParsing] = convertedStream.tee();
    const usage = { inputTokens: 0, outputTokens: 0, model: parsedBody.model };
    parseResponsesSSEUsage(streamForParsing, usage).catch(() => {});

    // Override content-type to text/event-stream for the client
    responseHeaders["content-type"] = "text/event-stream";

    return {
      status: response.status,
      headers: responseHeaders,
      body: streamForClient,
      get inputTokens() { return usage.inputTokens; },
      get outputTokens() { return usage.outputTokens; },
      cacheReadTokens: 0, cacheWriteTokens: 0,
      get model() { return usage.model; },
      isStream: true,
    };
  }

  // Non-streaming response
  const responseBody = await response.text();
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const parsed = JSON.parse(responseBody);
    if (parsed.usage) {
      inputTokens = parsed.usage.input_tokens ?? 0;
      outputTokens = parsed.usage.output_tokens ?? 0;
    }

    // Convert Responses API response to Chat Completions format
    if (parsed.output) {
      const converted = responsesToChatCompletion(parsed, parsedBody.model);
      return {
        status: response.status,
        headers: { ...responseHeaders, "content-type": "application/json" },
        body: JSON.stringify(converted),
        inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0,
        model: parsedBody.model, isStream: false,
      };
    }
  } catch { /* pass through raw body */ }

  return {
    status: response.status,
    headers: responseHeaders,
    body: responseBody,
    inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0,
    model: parsedBody.model, isStream: false,
  };
}

/**
 * Convert a non-streaming Responses API response to Chat Completions format.
 */
function responsesToChatCompletion(resp: any, model: string): any {
  const content: string[] = [];
  const toolCalls: any[] = [];

  if (resp.output) {
    for (const item of resp.output) {
      if (item.type === "message" && item.content) {
        for (const c of item.content) {
          if (c.type === "output_text") content.push(c.text);
        }
      }
      if (item.type === "function_call") {
        toolCalls.push({
          id: item.call_id || `call_${Date.now()}`,
          type: "function",
          function: { name: item.name, arguments: item.arguments || "{}" },
        });
      }
    }
  }

  const message: any = {
    role: "assistant",
    content: content.join("") || null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: `chatcmpl-${resp.id || Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
    }],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
    },
  };
}

/**
 * Parse converted SSE stream for usage extraction.
 */
async function parseResponsesSSEUsage(
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
          if (ev.usage) {
            usage.inputTokens = ev.usage.prompt_tokens || usage.inputTokens;
            usage.outputTokens = ev.usage.completion_tokens || usage.outputTokens;
          }
        } catch { /* skip */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
