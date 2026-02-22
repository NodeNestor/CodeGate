/**
 * Converts between Anthropic Messages API format and OpenAI Chat Completions format.
 * Supports bidirectional conversion for both requests and responses, plus SSE stream conversion.
 */

import { clampMaxTokens } from "./model-limits.js";

// ─── Anthropic Request → OpenAI Request ─────────────────────────────────────

export function anthropicToOpenAI(body: any, targetModel: string): any {
  const isDeepSeekReasoner = /deepseek-reasoner|deepseek-r1/i.test(targetModel);
  const messages: any[] = [];

  if (body.system) {
    if (typeof body.system === "string") {
      messages.push({ role: "system", content: body.system });
    } else if (Array.isArray(body.system)) {
      const text = body.system
        .map((block: any) => (typeof block === "string" ? block : block.text || ""))
        .join("\n");
      messages.push({ role: "system", content: text });
    }
  }

  if (body.messages) {
    for (const msg of body.messages) {
      const converted = convertAnthropicMessage(msg, isDeepSeekReasoner);
      messages.push(converted);
    }
  }

  const result: any = { model: targetModel, messages };

  if (body.max_tokens !== undefined) result.max_tokens = clampMaxTokens(body.max_tokens, targetModel);
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stream !== undefined) result.stream = body.stream;
  if (body.stop_sequences) result.stop = body.stop_sequences;

  // Stream options for providers that need usage in streaming
  if (body.stream) {
    result.stream_options = { include_usage: true };
  }

  if (body.tools && body.tools.length > 0) {
    result.tools = body.tools.map((tool: any) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || {},
      },
    }));
  }

  if (body.tool_choice) {
    if (body.tool_choice.type === "auto") result.tool_choice = "auto";
    else if (body.tool_choice.type === "any") result.tool_choice = "required";
    else if (body.tool_choice.type === "tool") {
      result.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
    }
  }

  // NOTE: Anthropic-specific fields (thinking, metadata, context_management, etc.)
  // are intentionally NOT copied — they are not part of the OpenAI format.

  return result;
}

function convertAnthropicMessage(msg: any, isDeepSeekReasoner = false): any {
  const role = msg.role;

  if (typeof msg.content === "string") return { role, content: msg.content };
  if (!Array.isArray(msg.content)) return { role, content: msg.content ?? "" };

  const parts: any[] = [];
  const toolCalls: any[] = [];

  for (const block of msg.content) {
    // Skip Anthropic-specific fields that providers don't understand
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: block.text });
        break;
      case "image": {
        const imageUrl = block.source.type === "base64"
          ? `data:${block.source.media_type};base64,${block.source.data}`
          : block.source.url;
        parts.push({ type: "image_url", image_url: { url: imageUrl } });
        break;
      }
      case "tool_use":
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
        break;
      case "tool_result": {
        const content = typeof block.content === "string" ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n")
            : JSON.stringify(block.content ?? "");
        return {
          role: "tool",
          tool_call_id: block.tool_use_id,
          content,
        };
      }
      case "thinking":
        // Skip Anthropic thinking blocks — not part of OpenAI format
        break;
      default:
        // Skip unknown block types rather than serializing them
        if (block.text !== undefined) {
          parts.push({ type: "text", text: block.text });
        }
    }
  }

  const result: any = { role };
  if (toolCalls.length > 0) {
    result.content = parts.length > 0 ? parts.map((p: any) => p.text || "").join("") : null;
    result.tool_calls = toolCalls;
    // DeepSeek reasoner requires reasoning_content on assistant messages with tool calls
    if (isDeepSeekReasoner && role === "assistant") {
      result.reasoning_content = "";
    }
  } else if (parts.length === 1 && parts[0].type === "text") {
    result.content = parts[0].text;
  } else if (parts.length === 0) {
    result.content = "";
  } else {
    result.content = parts;
  }
  return result;
}

// ─── OpenAI Response → Anthropic Response ───────────────────────────────────

export function openAIToAnthropic(response: any, originalModel: string): any {
  const choice = response.choices?.[0];
  if (!choice) {
    return {
      id: response.id || `msg_${Date.now()}`,
      type: "message", role: "assistant", content: [],
      model: originalModel, stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const message = choice.message;
  const content: any[] = [];

  if (message.content) content.push({ type: "text", text: message.content });
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let parsedArgs: any = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments || "{}");
      } catch {
        parsedArgs = { _raw: tc.function.arguments || "" };
      }
      content.push({
        type: "tool_use", id: tc.id || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name: tc.function.name,
        input: parsedArgs,
      });
    }
  }

  let stopReason: string;
  switch (choice.finish_reason) {
    case "stop": stopReason = "end_turn"; break;
    case "length": stopReason = "max_tokens"; break;
    case "tool_calls": stopReason = "tool_use"; break;
    default: stopReason = "end_turn";
  }

  return {
    id: response.id || `msg_${Date.now()}`,
    type: "message", role: "assistant", content, model: originalModel,
    stop_reason: stopReason, stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    },
  };
}

// ─── OpenAI Request → Anthropic Request (NEW) ──────────────────────────────

export function openAIToAnthropicRequest(body: any): any {
  const result: any = {};
  const messages: any[] = [];

  if (body.messages) {
    for (const msg of body.messages) {
      if (msg.role === "system") {
        // Collect system messages into Anthropic system field
        if (!result.system) result.system = [];
        if (typeof result.system === "string") result.system = [{ type: "text", text: result.system }];
        result.system.push({ type: "text", text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) });
      } else if (msg.role === "tool") {
        // OpenAI tool message → Anthropic tool_result in user message
        messages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: msg.content,
          }],
        });
      } else {
        // user or assistant message
        const converted: any = { role: msg.role };

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Assistant message with tool calls
          const content: any[] = [];
          if (msg.content) content.push({ type: "text", text: msg.content });
          for (const tc of msg.tool_calls) {
            content.push({
              type: "tool_use",
              id: tc.id || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              name: tc.function?.name || tc.name,
              input: typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments || "{}") : (tc.function?.arguments || {}),
            });
          }
          converted.content = content;
        } else if (Array.isArray(msg.content)) {
          // Multi-part content (images, etc.)
          converted.content = msg.content.map((part: any) => {
            if (part.type === "text") return { type: "text", text: part.text };
            if (part.type === "image_url") {
              const url = part.image_url?.url || "";
              if (url.startsWith("data:")) {
                const match = url.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                  return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
                }
              }
              return { type: "image", source: { type: "url", url } };
            }
            return { type: "text", text: JSON.stringify(part) };
          });
        } else {
          converted.content = msg.content || "";
        }

        messages.push(converted);
      }
    }
  }

  result.messages = messages;

  // Map parameters
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  if (body.max_completion_tokens !== undefined) result.max_tokens = body.max_completion_tokens;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stream !== undefined) result.stream = body.stream;
  if (body.stop) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  // Convert tools
  if (body.tools && body.tools.length > 0) {
    result.tools = body.tools.map((tool: any) => ({
      name: tool.function?.name || tool.name,
      description: tool.function?.description || tool.description || "",
      input_schema: tool.function?.parameters || tool.parameters || {},
    }));
  }

  // Convert tool_choice
  if (body.tool_choice) {
    if (body.tool_choice === "auto") result.tool_choice = { type: "auto" };
    else if (body.tool_choice === "required") result.tool_choice = { type: "any" };
    else if (body.tool_choice === "none") { /* no tool_choice in Anthropic */ }
    else if (typeof body.tool_choice === "object" && body.tool_choice.function?.name) {
      result.tool_choice = { type: "tool", name: body.tool_choice.function.name };
    }
  }

  // Default max_tokens if not provided (Anthropic requires it)
  if (!result.max_tokens) result.max_tokens = 4096;

  return result;
}

// ─── Anthropic Response → OpenAI Response (NEW) ────────────────────────────

export function anthropicToOpenAIResponse(body: any, model: string): any {
  const content: string[] = [];
  const toolCalls: any[] = [];

  if (body.content) {
    for (const block of body.content) {
      if (block.type === "text") {
        content.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      }
    }
  }

  let finishReason: string;
  switch (body.stop_reason) {
    case "end_turn": finishReason = "stop"; break;
    case "max_tokens": finishReason = "length"; break;
    case "tool_use": finishReason = "tool_calls"; break;
    default: finishReason = "stop";
  }

  const message: any = {
    role: "assistant",
    content: content.join("") || null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: `chatcmpl-${body.id || Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: body.usage?.input_tokens ?? 0,
      completion_tokens: body.usage?.output_tokens ?? 0,
      total_tokens: (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0),
    },
  };
}

// ─── SSE Stream Conversion: OpenAI → Anthropic ─────────────────────────────

export function convertSSEStream(
  stream: ReadableStream<Uint8Array>,
  originalModel: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let sentMessageStart = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let buffer = "";

  // Track all started content blocks so we can close them properly
  const startedBlocks = new Set<number>();
  // Counter for assigning Anthropic content block indices
  let nextContentBlockIndex = 0;
  // Map from OpenAI tool_call index to our Anthropic content block index
  const toolIndexMap = new Map<number, number>();
  // Track the last finish_reason to determine stop_reason
  let lastFinishReason: string | null = null;
  // Whether we've started a text content block
  let textBlockStarted = false;
  // Track thinking/reasoning block for DeepSeek reasoner
  let thinkingBlockStarted = false;
  let thinkingBlockIndex = -1;

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
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const dataStr = trimmed.slice(6);

            if (dataStr === "[DONE]") {
              // Close ALL started content blocks
              for (const idx of Array.from(startedBlocks).sort((a, b) => a - b)) {
                controller.enqueue(encoder.encode(
                  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: idx })}\n\n`
                ));
              }

              // Determine stop_reason from last finish_reason
              let stopReason = "end_turn";
              if (lastFinishReason === "tool_calls") stopReason = "tool_use";
              else if (lastFinishReason === "length") stopReason = "max_tokens";

              controller.enqueue(encoder.encode(
                `event: message_delta\ndata: ${JSON.stringify({
                  type: "message_delta",
                  delta: { stop_reason: stopReason, stop_sequence: null },
                  usage: { output_tokens: outputTokens },
                })}\n\n`
              ));
              controller.enqueue(encoder.encode(
                `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
              ));
              continue;
            }

            let parsed: any;
            try { parsed = JSON.parse(dataStr); } catch { continue; }

            if (!sentMessageStart) {
              sentMessageStart = true;
              controller.enqueue(encoder.encode(
                `event: message_start\ndata: ${JSON.stringify({
                  type: "message_start",
                  message: {
                    id: parsed.id || `msg_${Date.now()}`, type: "message", role: "assistant",
                    content: [], model: originalModel, stop_reason: null, stop_sequence: null,
                    usage: { input_tokens: inputTokens, output_tokens: 0 },
                  },
                })}\n\n`
              ));
            }

            if (parsed.usage) {
              if (parsed.usage.prompt_tokens) inputTokens = parsed.usage.prompt_tokens;
              if (parsed.usage.completion_tokens) outputTokens = parsed.usage.completion_tokens;
            }

            const choice = parsed.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta;
            if (!delta) continue;

            // Handle reasoning/thinking content (DeepSeek reasoner)
            if (delta.reasoning_content) {
              if (!thinkingBlockStarted) {
                thinkingBlockStarted = true;
                thinkingBlockIndex = nextContentBlockIndex++;
                startedBlocks.add(thinkingBlockIndex);
                controller.enqueue(encoder.encode(
                  `event: content_block_start\ndata: ${JSON.stringify({
                    type: "content_block_start", index: thinkingBlockIndex,
                    content_block: { type: "thinking", thinking: "" },
                  })}\n\n`
                ));
              }
              controller.enqueue(encoder.encode(
                `event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta", index: thinkingBlockIndex,
                  delta: { type: "thinking_delta", thinking: delta.reasoning_content },
                })}\n\n`
              ));
            }

            // Handle text content
            if (delta.content) {
              if (!textBlockStarted) {
                textBlockStarted = true;
                const blockIdx = nextContentBlockIndex++;
                startedBlocks.add(blockIdx);
                controller.enqueue(encoder.encode(
                  `event: content_block_start\ndata: ${JSON.stringify({
                    type: "content_block_start", index: blockIdx,
                    content_block: { type: "text", text: "" },
                  })}\n\n`
                ));
              }
              // Use the correct index for text block (after thinking block if present)
              const textIdx = thinkingBlockStarted ? thinkingBlockIndex + 1 : 0;
              controller.enqueue(encoder.encode(
                `event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta", index: textIdx,
                  delta: { type: "text_delta", text: delta.content },
                })}\n\n`
              ));
            }

            // Handle tool calls
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const openaiIndex = tc.index ?? 0;

                if (tc.function?.name) {
                  // New tool call starting -- assign a content block index
                  if (!textBlockStarted) {
                    // Ensure text block is at index 0 even if empty
                    textBlockStarted = true;
                    const textIdx = nextContentBlockIndex++;
                    startedBlocks.add(textIdx);
                    controller.enqueue(encoder.encode(
                      `event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start", index: textIdx,
                        content_block: { type: "text", text: "" },
                      })}\n\n`
                    ));
                  }

                  const blockIdx = nextContentBlockIndex++;
                  toolIndexMap.set(openaiIndex, blockIdx);
                  startedBlocks.add(blockIdx);

                  // Generate a tool ID if the provider omits one (DeepSeek does this)
                  const toolId = tc.id || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

                  controller.enqueue(encoder.encode(
                    `event: content_block_start\ndata: ${JSON.stringify({
                      type: "content_block_start", index: blockIdx,
                      content_block: { type: "tool_use", id: toolId, name: tc.function.name, input: {} },
                    })}\n\n`
                  ));
                }

                if (tc.function?.arguments) {
                  const blockIdx = toolIndexMap.get(openaiIndex);
                  if (blockIdx !== undefined) {
                    controller.enqueue(encoder.encode(
                      `event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta", index: blockIdx,
                        delta: { type: "input_json_delta", partial_json: tc.function.arguments },
                      })}\n\n`
                    ));
                  }
                }
              }
            }

            if (choice.finish_reason) {
              lastFinishReason = choice.finish_reason;
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

// ─── SSE Stream Conversion: Anthropic → OpenAI (NEW) ───────────────────────

export function convertAnthropicSSEToOpenAI(
  stream: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let messageId = `chatcmpl-${Date.now()}`;

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

            // Parse event type
            if (trimmed.startsWith("event: ")) continue; // Skip event lines, we parse data lines

            if (!trimmed.startsWith("data: ")) continue;
            const dataStr = trimmed.slice(6);
            if (!dataStr) continue;

            let parsed: any;
            try { parsed = JSON.parse(dataStr); } catch { continue; }

            switch (parsed.type) {
              case "message_start": {
                messageId = `chatcmpl-${parsed.message?.id || Date.now()}`;
                // Emit first chunk with role
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({
                    id: messageId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
                    model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
                  })}\n\n`
                ));
                break;
              }
              case "content_block_delta": {
                const delta = parsed.delta;
                if (delta?.type === "text_delta" && delta.text) {
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({
                      id: messageId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
                      model, choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
                    })}\n\n`
                  ));
                } else if (delta?.type === "input_json_delta" && delta.partial_json) {
                  // Tool call argument streaming
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({
                      id: messageId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
                      model, choices: [{ index: 0, delta: { tool_calls: [{ index: parsed.index ?? 0, function: { arguments: delta.partial_json } }] }, finish_reason: null }],
                    })}\n\n`
                  ));
                }
                break;
              }
              case "content_block_start": {
                if (parsed.content_block?.type === "tool_use") {
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({
                      id: messageId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
                      model, choices: [{ index: 0, delta: {
                        tool_calls: [{ index: (parsed.index ?? 1) - 1, id: parsed.content_block.id, type: "function", function: { name: parsed.content_block.name, arguments: "" } }]
                      }, finish_reason: null }],
                    })}\n\n`
                  ));
                }
                break;
              }
              case "message_delta": {
                let finishReason: string | null = null;
                if (parsed.delta?.stop_reason) {
                  switch (parsed.delta.stop_reason) {
                    case "end_turn": finishReason = "stop"; break;
                    case "max_tokens": finishReason = "length"; break;
                    case "tool_use": finishReason = "tool_calls"; break;
                    default: finishReason = "stop";
                  }
                }
                if (finishReason) {
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({
                      id: messageId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
                      model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                      usage: parsed.usage ? {
                        prompt_tokens: 0, completion_tokens: parsed.usage.output_tokens ?? 0,
                        total_tokens: parsed.usage.output_tokens ?? 0,
                      } : undefined,
                    })}\n\n`
                  ));
                }
                break;
              }
              case "message_stop": {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                break;
              }
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
