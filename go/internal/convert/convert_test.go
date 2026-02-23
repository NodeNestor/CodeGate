package convert

import (
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestAnthropicToOpenAI_BasicMessage(t *testing.T) {
	body := map[string]any{
		"model":      "claude-sonnet-4-20250514",
		"messages":   []any{map[string]any{"role": "user", "content": "Hello"}},
		"max_tokens": float64(1024),
		"stream":     true,
	}
	result := AnthropicToOpenAI(body, "gpt-4o")
	if result["model"] != "gpt-4o" {
		t.Errorf("model = %v, want gpt-4o", result["model"])
	}
	msgs := result["messages"].([]any)
	if len(msgs) != 1 {
		t.Errorf("messages length = %d, want 1", len(msgs))
	}
	if result["stream_options"] == nil {
		t.Error("stream_options should be set when stream=true")
	}
}

func TestAnthropicToOpenAI_SystemString(t *testing.T) {
	body := map[string]any{
		"model":      "claude-sonnet-4-20250514",
		"system":     "You are helpful",
		"messages":   []any{map[string]any{"role": "user", "content": "Hi"}},
		"max_tokens": float64(100),
	}
	result := AnthropicToOpenAI(body, "gpt-4o")
	msgs := result["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("messages length = %d, want 2 (system + user)", len(msgs))
	}
	sysMsg := msgs[0].(map[string]any)
	if sysMsg["role"] != "system" {
		t.Error("first message should be system")
	}
	if sysMsg["content"] != "You are helpful" {
		t.Error("system content mismatch")
	}
}

func TestAnthropicToOpenAI_SystemArray(t *testing.T) {
	body := map[string]any{
		"model": "test",
		"system": []any{
			map[string]any{"type": "text", "text": "Part 1"},
			map[string]any{"type": "text", "text": "Part 2"},
		},
		"messages":   []any{map[string]any{"role": "user", "content": "Hi"}},
		"max_tokens": float64(100),
	}
	result := AnthropicToOpenAI(body, "gpt-4o")
	msgs := result["messages"].([]any)
	sysMsg := msgs[0].(map[string]any)
	content := sysMsg["content"].(string)
	if !strings.Contains(content, "Part 1") || !strings.Contains(content, "Part 2") {
		t.Error("system array should be joined")
	}
}

func TestAnthropicToOpenAI_ToolUse(t *testing.T) {
	body := map[string]any{
		"model": "test",
		"messages": []any{
			map[string]any{
				"role": "assistant",
				"content": []any{
					map[string]any{
						"type":  "tool_use",
						"id":    "toolu_123",
						"name":  "get_weather",
						"input": map[string]any{"city": "NYC"},
					},
				},
			},
		},
		"max_tokens": float64(100),
	}
	result := AnthropicToOpenAI(body, "gpt-4o")
	msgs := result["messages"].([]any)
	msg := msgs[0].(map[string]any)
	toolCalls, ok := msg["tool_calls"].([]any)
	if !ok || len(toolCalls) == 0 {
		t.Fatal("expected tool_calls")
	}
	tc := toolCalls[0].(map[string]any)
	if tc["type"] != "function" {
		t.Error("tool_call type should be function")
	}
	fn := tc["function"].(map[string]any)
	if fn["name"] != "get_weather" {
		t.Error("function name mismatch")
	}
}

func TestAnthropicToOpenAI_ToolResult(t *testing.T) {
	body := map[string]any{
		"model": "test",
		"messages": []any{
			map[string]any{
				"role": "user",
				"content": []any{
					map[string]any{
						"type":        "tool_result",
						"tool_use_id": "toolu_123",
						"content":     "Sunny, 72°F",
					},
				},
			},
		},
		"max_tokens": float64(100),
	}
	result := AnthropicToOpenAI(body, "gpt-4o")
	msgs := result["messages"].([]any)
	msg := msgs[0].(map[string]any)
	if msg["role"] != "tool" {
		t.Errorf("tool_result should become tool message, got role=%v", msg["role"])
	}
	if msg["tool_call_id"] != "toolu_123" {
		t.Error("tool_call_id mismatch")
	}
}

func TestAnthropicToOpenAI_Tools(t *testing.T) {
	body := map[string]any{
		"model":    "test",
		"messages": []any{map[string]any{"role": "user", "content": "Hi"}},
		"tools": []any{
			map[string]any{
				"name":         "get_weather",
				"description":  "Get weather",
				"input_schema": map[string]any{"type": "object"},
			},
		},
		"max_tokens": float64(100),
	}
	result := AnthropicToOpenAI(body, "gpt-4o")
	tools := result["tools"].([]any)
	if len(tools) != 1 {
		t.Fatal("expected 1 tool")
	}
	tool := tools[0].(map[string]any)
	if tool["type"] != "function" {
		t.Error("tool type should be function")
	}
}

func TestAnthropicToOpenAI_ToolChoice(t *testing.T) {
	tests := []struct {
		input map[string]any
		want  any
	}{
		{map[string]any{"type": "auto"}, "auto"},
		{map[string]any{"type": "any"}, "required"},
	}
	for _, tt := range tests {
		body := map[string]any{
			"model": "test", "messages": []any{}, "max_tokens": float64(100),
			"tool_choice": tt.input,
		}
		result := AnthropicToOpenAI(body, "gpt-4o")
		if result["tool_choice"] != tt.want {
			t.Errorf("tool_choice %v -> %v, want %v", tt.input, result["tool_choice"], tt.want)
		}
	}
}

func TestAnthropicToOpenAI_StopSequences(t *testing.T) {
	body := map[string]any{
		"model": "test", "messages": []any{}, "max_tokens": float64(100),
		"stop_sequences": []any{"STOP", "END"},
	}
	result := AnthropicToOpenAI(body, "gpt-4o")
	if result["stop"] == nil {
		t.Error("stop_sequences should map to stop")
	}
}

func TestAnthropicToOpenAI_ThinkingBlocks(t *testing.T) {
	body := map[string]any{
		"model": "test",
		"messages": []any{
			map[string]any{
				"role": "assistant",
				"content": []any{
					map[string]any{"type": "thinking", "thinking": "deep thought"},
					map[string]any{"type": "text", "text": "Hello"},
				},
			},
		},
		"max_tokens": float64(100),
	}
	result := AnthropicToOpenAI(body, "gpt-4o")
	msgs := result["messages"].([]any)
	msg := msgs[0].(map[string]any)
	// Thinking blocks should be skipped
	content := msg["content"].(string)
	if strings.Contains(content, "deep thought") {
		t.Error("thinking block should be skipped")
	}
}

func TestOpenAIToAnthropic_BasicResponse(t *testing.T) {
	response := map[string]any{
		"id": "chatcmpl-123",
		"choices": []any{
			map[string]any{
				"index":         float64(0),
				"message":       map[string]any{"role": "assistant", "content": "Hello!"},
				"finish_reason": "stop",
			},
		},
		"usage": map[string]any{"prompt_tokens": float64(10), "completion_tokens": float64(5)},
	}
	result := OpenAIToAnthropic(response, "claude-sonnet-4-20250514")
	if result["type"] != "message" {
		t.Error("type should be message")
	}
	content := result["content"].([]any)
	if len(content) == 0 {
		t.Fatal("content should have blocks")
	}
	block := content[0].(map[string]any)
	if block["text"] != "Hello!" {
		t.Error("text content mismatch")
	}
	if result["stop_reason"] != "end_turn" {
		t.Error("stop -> end_turn")
	}
}

func TestOpenAIToAnthropic_ToolCalls(t *testing.T) {
	response := map[string]any{
		"id": "chatcmpl-123",
		"choices": []any{
			map[string]any{
				"index": float64(0),
				"message": map[string]any{
					"role":    "assistant",
					"content": nil,
					"tool_calls": []any{
						map[string]any{
							"id":   "call_123",
							"type": "function",
							"function": map[string]any{
								"name":      "get_weather",
								"arguments": `{"city":"NYC"}`,
							},
						},
					},
				},
				"finish_reason": "tool_calls",
			},
		},
		"usage": map[string]any{"prompt_tokens": float64(10), "completion_tokens": float64(5)},
	}
	result := OpenAIToAnthropic(response, "claude-sonnet-4-20250514")
	content := result["content"].([]any)
	found := false
	for _, block := range content {
		b := block.(map[string]any)
		if b["type"] == "tool_use" {
			found = true
			if b["name"] != "get_weather" {
				t.Error("tool name mismatch")
			}
		}
	}
	if !found {
		t.Error("expected tool_use block")
	}
	if result["stop_reason"] != "tool_use" {
		t.Error("tool_calls -> tool_use")
	}
}

func TestOpenAIToAnthropic_LengthFinish(t *testing.T) {
	response := map[string]any{
		"id": "chatcmpl-123",
		"choices": []any{
			map[string]any{
				"index":         float64(0),
				"message":       map[string]any{"role": "assistant", "content": "truncated"},
				"finish_reason": "length",
			},
		},
		"usage": map[string]any{"prompt_tokens": float64(10), "completion_tokens": float64(5)},
	}
	result := OpenAIToAnthropic(response, "test")
	if result["stop_reason"] != "max_tokens" {
		t.Errorf("length -> max_tokens, got %v", result["stop_reason"])
	}
}

func TestOpenAIToAnthropic_EmptyChoices(t *testing.T) {
	response := map[string]any{
		"id":      "chatcmpl-123",
		"choices": []any{},
	}
	result := OpenAIToAnthropic(response, "test")
	if result["type"] != "message" {
		t.Error("should return valid message even with empty choices")
	}
}

func TestOpenAIToAnthropic_MalformedArgs(t *testing.T) {
	response := map[string]any{
		"id": "chatcmpl-123",
		"choices": []any{
			map[string]any{
				"index": float64(0),
				"message": map[string]any{
					"role": "assistant",
					"tool_calls": []any{
						map[string]any{
							"id":   "call_123",
							"type": "function",
							"function": map[string]any{
								"name":      "test",
								"arguments": "not-valid-json{",
							},
						},
					},
				},
				"finish_reason": "tool_calls",
			},
		},
		"usage": map[string]any{"prompt_tokens": float64(0), "completion_tokens": float64(0)},
	}
	result := OpenAIToAnthropic(response, "test")
	content := result["content"].([]any)
	for _, block := range content {
		b := block.(map[string]any)
		if b["type"] == "tool_use" {
			input := b["input"].(map[string]any)
			if _, ok := input["_raw"]; !ok {
				t.Error("malformed args should fall back to _raw")
			}
		}
	}
}

func TestOpenAIToAnthropicRequest_Messages(t *testing.T) {
	body := map[string]any{
		"model": "gpt-4o",
		"messages": []any{
			map[string]any{"role": "system", "content": "Be helpful"},
			map[string]any{"role": "user", "content": "Hello"},
		},
	}
	result := OpenAIToAnthropicRequest(body)
	// System should be extracted
	if result["system"] == nil {
		t.Error("system should be extracted")
	}
	msgs := result["messages"].([]any)
	if len(msgs) != 1 {
		t.Errorf("messages should have 1 (user only), got %d", len(msgs))
	}
}

func TestOpenAIToAnthropicRequest_MaxTokensDefault(t *testing.T) {
	body := map[string]any{
		"model":    "gpt-4o",
		"messages": []any{},
	}
	result := OpenAIToAnthropicRequest(body)
	if result["max_tokens"] != float64(4096) {
		t.Errorf("default max_tokens should be 4096, got %v", result["max_tokens"])
	}
}

func TestOpenAIToAnthropicRequest_Stop(t *testing.T) {
	body := map[string]any{
		"model":    "gpt-4o",
		"messages": []any{},
		"stop":     []any{"STOP"},
	}
	result := OpenAIToAnthropicRequest(body)
	if result["stop_sequences"] == nil {
		t.Error("stop should map to stop_sequences")
	}
}

func TestAnthropicToOpenAIResponse_Text(t *testing.T) {
	body := map[string]any{
		"id":   "msg_123",
		"type": "message",
		"content": []any{
			map[string]any{"type": "text", "text": "Hello!"},
		},
		"stop_reason": "end_turn",
		"usage": map[string]any{"input_tokens": float64(10), "output_tokens": float64(5)},
	}
	result := AnthropicToOpenAIResponse(body, "gpt-4o")
	if result["object"] != "chat.completion" {
		t.Error("object should be chat.completion")
	}
	choices := result["choices"].([]any)
	choice := choices[0].(map[string]any)
	if choice["finish_reason"] != "stop" {
		t.Error("end_turn -> stop")
	}
}

func TestAnthropicToOpenAIResponse_ToolUse(t *testing.T) {
	body := map[string]any{
		"id":   "msg_123",
		"type": "message",
		"content": []any{
			map[string]any{
				"type":  "tool_use",
				"id":    "toolu_123",
				"name":  "get_weather",
				"input": map[string]any{"city": "NYC"},
			},
		},
		"stop_reason": "tool_use",
		"usage": map[string]any{"input_tokens": float64(10), "output_tokens": float64(5)},
	}
	result := AnthropicToOpenAIResponse(body, "gpt-4o")
	choices := result["choices"].([]any)
	choice := choices[0].(map[string]any)
	msg := choice["message"].(map[string]any)
	toolCalls := msg["tool_calls"].([]any)
	if len(toolCalls) == 0 {
		t.Fatal("expected tool_calls")
	}
	if choice["finish_reason"] != "tool_calls" {
		t.Error("tool_use -> tool_calls")
	}
}

func TestConvertSSEStream(t *testing.T) {
	// Build a minimal OpenAI SSE stream
	events := []string{
		`data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}`,
		`data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}`,
		`data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}`,
		`data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}`,
		`data: [DONE]`,
	}
	input := strings.Join(events, "\n") + "\n"

	stream := ConvertSSEStream(strings.NewReader(input), "claude-sonnet-4-20250514")
	output, _ := io.ReadAll(stream)
	stream.Close()
	result := string(output)

	if !strings.Contains(result, "message_start") {
		t.Error("should contain message_start event")
	}
	if !strings.Contains(result, "content_block_delta") {
		t.Error("should contain content_block_delta events")
	}
	if !strings.Contains(result, "Hello") {
		t.Error("should contain text content")
	}
	if !strings.Contains(result, "message_stop") {
		t.Error("should contain message_stop event")
	}
}

func TestConvertAnthropicSSEToOpenAI(t *testing.T) {
	events := []string{
		`event: message_start`,
		`data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}`,
		``,
		`event: content_block_start`,
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		``,
		`event: content_block_delta`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}`,
		``,
		`event: content_block_stop`,
		`data: {"type":"content_block_stop","index":0}`,
		``,
		`event: message_delta`,
		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}`,
		``,
		`event: message_stop`,
		`data: {"type":"message_stop"}`,
		``,
	}
	input := strings.Join(events, "\n") + "\n"

	stream := ConvertAnthropicSSEToOpenAI(strings.NewReader(input), "gpt-4o")
	output, _ := io.ReadAll(stream)
	stream.Close()
	result := string(output)

	if !strings.Contains(result, "chat.completion.chunk") {
		t.Error("should contain chat.completion.chunk objects")
	}
	if !strings.Contains(result, "Hi") {
		t.Error("should contain text content")
	}
	if !strings.Contains(result, "[DONE]") {
		t.Error("should end with [DONE]")
	}

	// Parse to verify structure
	for _, line := range strings.Split(result, "\n") {
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		dataStr := line[6:]
		if dataStr == "[DONE]" {
			continue
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(dataStr), &parsed); err != nil {
			t.Errorf("invalid JSON in SSE: %s", dataStr)
		}
	}
}
