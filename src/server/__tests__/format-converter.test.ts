import { describe, it, expect } from "vitest";
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  openAIToAnthropicRequest,
  anthropicToOpenAIResponse,
} from "../format-converter.js";

// ─── Anthropic Request → OpenAI Request ─────────────────────────────────────

describe("anthropicToOpenAI", () => {
  it("converts a basic text message", () => {
    const result = anthropicToOpenAI(
      {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 1024,
        stream: true,
      },
      "gpt-4o"
    );

    expect(result.model).toBe("gpt-4o");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: "user", content: "Hello" });
    expect(result.max_tokens).toBe(1024);
    expect(result.stream).toBe(true);
    expect(result.stream_options).toEqual({ include_usage: true });
  });

  it("converts system prompt (string)", () => {
    const result = anthropicToOpenAI(
      {
        system: "You are a helpful assistant.",
        messages: [{ role: "user", content: "Hi" }],
      },
      "gpt-4o"
    );

    expect(result.messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });
    expect(result.messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("converts system prompt (array of blocks)", () => {
    const result = anthropicToOpenAI(
      {
        system: [
          { type: "text", text: "Line 1" },
          { type: "text", text: "Line 2" },
        ],
        messages: [{ role: "user", content: "Hi" }],
      },
      "gpt-4o"
    );

    expect(result.messages[0]).toEqual({
      role: "system",
      content: "Line 1\nLine 2",
    });
  });

  it("converts tool_use blocks to tool_calls", () => {
    const result = anthropicToOpenAI(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me check." },
              {
                type: "tool_use",
                id: "toolu_123",
                name: "get_weather",
                input: { city: "NYC" },
              },
            ],
          },
        ],
      },
      "gpt-4o"
    );

    const msg = result.messages[0];
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("Let me check.");
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls[0]).toEqual({
      id: "toolu_123",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"NYC"}' },
    });
  });

  it("converts tool_result to tool message", () => {
    const result = anthropicToOpenAI(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_123",
                content: "72°F and sunny",
              },
            ],
          },
        ],
      },
      "gpt-4o"
    );

    expect(result.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "toolu_123",
      content: "72°F and sunny",
    });
  });

  it("converts Anthropic tools to OpenAI function tools", () => {
    const result = anthropicToOpenAI(
      {
        messages: [{ role: "user", content: "Hi" }],
        tools: [
          {
            name: "get_weather",
            description: "Get the weather",
            input_schema: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        ],
      },
      "gpt-4o"
    );

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toEqual({
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    });
  });

  it("converts tool_choice mappings", () => {
    expect(
      anthropicToOpenAI(
        { messages: [], tool_choice: { type: "auto" } },
        "gpt-4o"
      ).tool_choice
    ).toBe("auto");

    expect(
      anthropicToOpenAI(
        { messages: [], tool_choice: { type: "any" } },
        "gpt-4o"
      ).tool_choice
    ).toBe("required");

    expect(
      anthropicToOpenAI(
        {
          messages: [],
          tool_choice: { type: "tool", name: "get_weather" },
        },
        "gpt-4o"
      ).tool_choice
    ).toEqual({ type: "function", function: { name: "get_weather" } });
  });

  it("maps stop_sequences to stop", () => {
    const result = anthropicToOpenAI(
      { messages: [], stop_sequences: ["END", "STOP"] },
      "gpt-4o"
    );
    expect(result.stop).toEqual(["END", "STOP"]);
  });

  it("skips thinking blocks", () => {
    const result = anthropicToOpenAI(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "let me think..." },
              { type: "text", text: "The answer is 42." },
            ],
          },
        ],
      },
      "gpt-4o"
    );

    expect(result.messages[0].content).toBe("The answer is 42.");
  });

  it("does not copy stream_options when stream is false", () => {
    const result = anthropicToOpenAI(
      { messages: [], stream: false },
      "gpt-4o"
    );
    expect(result.stream_options).toBeUndefined();
  });
});

// ─── OpenAI Response → Anthropic Response ───────────────────────────────────

describe("openAIToAnthropic", () => {
  it("converts a basic text response", () => {
    const result = openAIToAnthropic(
      {
        id: "chatcmpl-abc",
        choices: [
          {
            message: { role: "assistant", content: "Hello there!" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      "claude-sonnet-4-20250514"
    );

    expect(result.type).toBe("message");
    expect(result.role).toBe("assistant");
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.content).toEqual([{ type: "text", text: "Hello there!" }]);
    expect(result.stop_reason).toBe("end_turn");
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(5);
  });

  it("converts tool_calls finish reason", () => {
    const result = openAIToAnthropic(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_123",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"city":"NYC"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      },
      "claude-sonnet-4-20250514"
    );

    expect(result.stop_reason).toBe("tool_use");
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("tool_use");
    expect(result.content[0].name).toBe("get_weather");
    expect(result.content[0].input).toEqual({ city: "NYC" });
  });

  it("handles length finish reason", () => {
    const result = openAIToAnthropic(
      {
        choices: [
          {
            message: { content: "partial..." },
            finish_reason: "length",
          },
        ],
      },
      "claude-sonnet-4-20250514"
    );
    expect(result.stop_reason).toBe("max_tokens");
  });

  it("handles empty choices", () => {
    const result = openAIToAnthropic({ choices: [] }, "claude-sonnet-4-20250514");
    expect(result.content).toEqual([]);
    expect(result.stop_reason).toBe("end_turn");
  });

  it("handles malformed tool arguments gracefully", () => {
    const result = openAIToAnthropic(
      {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "test", arguments: "not json" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      "claude-sonnet-4-20250514"
    );

    expect(result.content[0].input).toEqual({ _raw: "not json" });
  });
});

// ─── OpenAI Request → Anthropic Request ─────────────────────────────────────

describe("openAIToAnthropicRequest", () => {
  it("converts basic messages", () => {
    const result = openAIToAnthropicRequest({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Be helpful." },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    expect(result.system).toEqual([{ type: "text", text: "Be helpful." }]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: "user", content: "Hello" });
    expect(result.max_tokens).toBe(500);
    expect(result.temperature).toBe(0.7);
  });

  it("converts tool messages to tool_result", () => {
    const result = openAIToAnthropicRequest({
      messages: [
        { role: "tool", tool_call_id: "call_123", content: "72°F" },
      ],
    });

    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call_123",
      content: "72°F",
    });
  });

  it("converts assistant messages with tool_calls", () => {
    const result = openAIToAnthropicRequest({
      messages: [
        {
          role: "assistant",
          content: "Checking...",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search", arguments: '{"q":"test"}' },
            },
          ],
        },
      ],
    });

    const msg = result.messages[0];
    expect(msg.role).toBe("assistant");
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0]).toEqual({ type: "text", text: "Checking..." });
    expect(msg.content[1].type).toBe("tool_use");
    expect(msg.content[1].name).toBe("search");
    expect(msg.content[1].input).toEqual({ q: "test" });
  });

  it("converts OpenAI tools to Anthropic tools", () => {
    const result = openAIToAnthropicRequest({
      messages: [{ role: "user", content: "Hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            description: "Search things",
            parameters: { type: "object" },
          },
        },
      ],
    });

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toEqual({
      name: "search",
      description: "Search things",
      input_schema: { type: "object" },
    });
  });

  it("converts tool_choice values", () => {
    expect(
      openAIToAnthropicRequest({ messages: [], tool_choice: "auto" })
        .tool_choice
    ).toEqual({ type: "auto" });

    expect(
      openAIToAnthropicRequest({ messages: [], tool_choice: "required" })
        .tool_choice
    ).toEqual({ type: "any" });
  });

  it("defaults max_tokens to 4096 if not provided", () => {
    const result = openAIToAnthropicRequest({
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(result.max_tokens).toBe(4096);
  });

  it("maps stop to stop_sequences", () => {
    const result = openAIToAnthropicRequest({
      messages: [],
      stop: ["END"],
    });
    expect(result.stop_sequences).toEqual(["END"]);
  });

  it("handles max_completion_tokens", () => {
    const result = openAIToAnthropicRequest({
      messages: [],
      max_completion_tokens: 2048,
    });
    expect(result.max_tokens).toBe(2048);
  });
});

// ─── Anthropic Response → OpenAI Response ───────────────────────────────────

describe("anthropicToOpenAIResponse", () => {
  it("converts a basic text response", () => {
    const result = anthropicToOpenAIResponse(
      {
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      "gpt-4o"
    );

    expect(result.object).toBe("chat.completion");
    expect(result.model).toBe("gpt-4o");
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].message.content).toBe("Hello!");
    expect(result.choices[0].finish_reason).toBe("stop");
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
    expect(result.usage.total_tokens).toBe(15);
  });

  it("converts tool_use to tool_calls", () => {
    const result = anthropicToOpenAIResponse(
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "search",
            input: { q: "test" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      "gpt-4o"
    );

    expect(result.choices[0].finish_reason).toBe("tool_calls");
    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.choices[0].message.tool_calls[0].function.name).toBe(
      "search"
    );
  });

  it("converts max_tokens stop reason", () => {
    const result = anthropicToOpenAIResponse(
      {
        content: [{ type: "text", text: "partial" }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      "gpt-4o"
    );
    expect(result.choices[0].finish_reason).toBe("length");
  });
});
