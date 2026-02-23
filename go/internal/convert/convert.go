// Package convert handles bidirectional conversion between Anthropic Messages API
// format and OpenAI Chat Completions format, for both requests and responses,
// including SSE stream conversion in both directions.
package convert

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"regexp"
	"sort"
	"strings"
	"time"
)

// deepSeekReasonerRe matches DeepSeek reasoner model names.
var deepSeekReasonerRe = regexp.MustCompile(`(?i)deepseek-reasoner|deepseek-r1`)

// dataURIRe parses a base64 data URI into media type and data components.
var dataURIRe = regexp.MustCompile(`^data:([^;]+);base64,(.+)$`)

// generateID produces a random alphanumeric suffix suitable for IDs.
func generateID() string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 6)
	for i := range b {
		b[i] = chars[rand.Intn(len(chars))]
	}
	return string(b)
}

// nowMillis returns the current time in milliseconds since epoch.
func nowMillis() int64 {
	return time.Now().UnixMilli()
}

// nowUnix returns the current time as a Unix timestamp (seconds).
func nowUnix() int64 {
	return time.Now().Unix()
}

// toJSONString marshals a value to a JSON string; returns "{}" on error.
func toJSONString(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}

// getStr safely extracts a string from a map.
func getStr(m map[string]any, key string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// getFloat safely extracts a float64 from a map.
func getFloat(m map[string]any, key string) (float64, bool) {
	if v, ok := m[key]; ok {
		if f, ok := v.(float64); ok {
			return f, true
		}
	}
	return 0, false
}

// getBool safely extracts a bool from a map.
func getBool(m map[string]any, key string) (bool, bool) {
	if v, ok := m[key]; ok {
		if b, ok := v.(bool); ok {
			return b, true
		}
	}
	return false, false
}

// getSlice safely extracts a []any from a map.
func getSlice(m map[string]any, key string) ([]any, bool) {
	if v, ok := m[key]; ok {
		if s, ok := v.([]any); ok {
			return s, true
		}
	}
	return nil, false
}

// getMap safely extracts a map[string]any from a map.
func getMap(m map[string]any, key string) (map[string]any, bool) {
	if v, ok := m[key]; ok {
		if m2, ok := v.(map[string]any); ok {
			return m2, true
		}
	}
	return nil, false
}

// toMap converts any value to map[string]any via JSON round-trip if needed.
func toMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// toSlice converts any value to []any.
func toSlice(v any) []any {
	if s, ok := v.([]any); ok {
		return s
	}
	return nil
}

// --------------------------------------------------------------------------
// Anthropic Request -> OpenAI Request
// --------------------------------------------------------------------------

// AnthropicToOpenAI converts an Anthropic Messages API request body to an
// OpenAI Chat Completions API request body.
func AnthropicToOpenAI(body map[string]any, targetModel string) map[string]any {
	isDeepSeekReasoner := deepSeekReasonerRe.MatchString(targetModel)
	messages := []any{}

	// Extract system messages from body.system
	if sys, ok := body["system"]; ok {
		switch s := sys.(type) {
		case string:
			messages = append(messages, map[string]any{"role": "system", "content": s})
		case []any:
			var parts []string
			for _, block := range s {
				switch b := block.(type) {
				case string:
					parts = append(parts, b)
				case map[string]any:
					parts = append(parts, getStr(b, "text"))
				default:
					parts = append(parts, "")
				}
			}
			messages = append(messages, map[string]any{"role": "system", "content": strings.Join(parts, "\n")})
		}
	}

	// Convert messages
	if msgs, ok := getSlice(body, "messages"); ok {
		for _, rawMsg := range msgs {
			msg := toMap(rawMsg)
			converted := convertAnthropicMessage(msg, isDeepSeekReasoner)
			messages = append(messages, converted)
		}
	}

	result := map[string]any{
		"model":    targetModel,
		"messages": messages,
	}

	// Map parameters
	if v, ok := body["max_tokens"]; ok {
		result["max_tokens"] = v
	}
	if v, ok := body["temperature"]; ok {
		result["temperature"] = v
	}
	if v, ok := body["top_p"]; ok {
		result["top_p"] = v
	}
	if v, ok := body["stream"]; ok {
		result["stream"] = v
	}
	if v, ok := body["stop_sequences"]; ok {
		result["stop"] = v
	}

	// Stream options for providers that need usage in streaming
	if stream, ok := getBool(body, "stream"); ok && stream {
		result["stream_options"] = map[string]any{"include_usage": true}
	}

	// Convert tools
	if tools, ok := getSlice(body, "tools"); ok && len(tools) > 0 {
		var oaiTools []any
		for _, rawTool := range tools {
			tool := toMap(rawTool)
			inputSchema := tool["input_schema"]
			if inputSchema == nil {
				inputSchema = map[string]any{}
			}
			desc := getStr(tool, "description")
			oaiTools = append(oaiTools, map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":        getStr(tool, "name"),
					"description": desc,
					"parameters":  inputSchema,
				},
			})
		}
		result["tools"] = oaiTools
	}

	// Convert tool_choice
	if tc, ok := getMap(body, "tool_choice"); ok {
		tcType := getStr(tc, "type")
		switch tcType {
		case "auto":
			result["tool_choice"] = "auto"
		case "any":
			result["tool_choice"] = "required"
		case "tool":
			result["tool_choice"] = map[string]any{
				"type":     "function",
				"function": map[string]any{"name": getStr(tc, "name")},
			}
		}
	}

	// NOTE: Anthropic-specific fields (thinking, metadata, context_management, etc.)
	// are intentionally NOT copied -- they are not part of the OpenAI format.

	return result
}

// convertAnthropicMessage converts a single Anthropic message to OpenAI format.
func convertAnthropicMessage(msg map[string]any, isDeepSeekReasoner bool) map[string]any {
	role := getStr(msg, "role")

	// String content
	if content, ok := msg["content"].(string); ok {
		return map[string]any{"role": role, "content": content}
	}

	// Non-array content
	contentSlice, ok := msg["content"].([]any)
	if !ok {
		content := msg["content"]
		if content == nil {
			content = ""
		}
		return map[string]any{"role": role, "content": content}
	}

	var parts []any
	var toolCalls []any

	for _, rawBlock := range contentSlice {
		block := toMap(rawBlock)
		blockType := getStr(block, "type")

		switch blockType {
		case "text":
			parts = append(parts, map[string]any{"type": "text", "text": getStr(block, "text")})

		case "image":
			source := toMap(block["source"])
			var imageURL string
			if getStr(source, "type") == "base64" {
				imageURL = fmt.Sprintf("data:%s;base64,%s", getStr(source, "media_type"), getStr(source, "data"))
			} else {
				imageURL = getStr(source, "url")
			}
			parts = append(parts, map[string]any{
				"type":      "image_url",
				"image_url": map[string]any{"url": imageURL},
			})

		case "tool_use":
			input := block["input"]
			if input == nil {
				input = map[string]any{}
			}
			toolCalls = append(toolCalls, map[string]any{
				"id":   getStr(block, "id"),
				"type": "function",
				"function": map[string]any{
					"name":      getStr(block, "name"),
					"arguments": toJSONString(input),
				},
			})

		case "tool_result":
			// tool_result returns immediately as a tool message
			var contentStr string
			switch c := block["content"].(type) {
			case string:
				contentStr = c
			case []any:
				var resultParts []string
				for _, item := range c {
					itemMap := toMap(item)
					if getStr(itemMap, "type") == "text" {
						resultParts = append(resultParts, getStr(itemMap, "text"))
					} else {
						resultParts = append(resultParts, toJSONString(item))
					}
				}
				contentStr = strings.Join(resultParts, "\n")
			default:
				if c == nil {
					contentStr = ""
				} else {
					contentStr = toJSONString(c)
				}
			}
			return map[string]any{
				"role":         "tool",
				"tool_call_id": getStr(block, "tool_use_id"),
				"content":      contentStr,
			}

		case "thinking":
			// Skip Anthropic thinking blocks -- not part of OpenAI format

		default:
			// Skip unknown block types rather than serializing them
			if text := getStr(block, "text"); text != "" {
				parts = append(parts, map[string]any{"type": "text", "text": text})
			}
		}
	}

	result := map[string]any{"role": role}

	if len(toolCalls) > 0 {
		if len(parts) > 0 {
			var textParts []string
			for _, p := range parts {
				pm := toMap(p)
				textParts = append(textParts, getStr(pm, "text"))
			}
			result["content"] = strings.Join(textParts, "")
		} else {
			result["content"] = nil
		}
		result["tool_calls"] = toolCalls
		// DeepSeek reasoner requires reasoning_content on assistant messages with tool calls
		if isDeepSeekReasoner && role == "assistant" {
			result["reasoning_content"] = ""
		}
	} else if len(parts) == 1 && getStr(toMap(parts[0]), "type") == "text" {
		result["content"] = getStr(toMap(parts[0]), "text")
	} else if len(parts) == 0 {
		result["content"] = ""
	} else {
		result["content"] = parts
	}

	return result
}

// --------------------------------------------------------------------------
// OpenAI Response -> Anthropic Response
// --------------------------------------------------------------------------

// OpenAIToAnthropic converts an OpenAI Chat Completions response to an
// Anthropic Messages API response.
func OpenAIToAnthropic(response map[string]any, originalModel string) map[string]any {
	choices, _ := getSlice(response, "choices")

	if len(choices) == 0 {
		id := getStr(response, "id")
		if id == "" {
			id = fmt.Sprintf("msg_%d", nowMillis())
		}
		return map[string]any{
			"id": id, "type": "message", "role": "assistant",
			"content": []any{}, "model": originalModel,
			"stop_reason": "end_turn",
			"usage":       map[string]any{"input_tokens": float64(0), "output_tokens": float64(0)},
		}
	}

	choice := toMap(choices[0])
	message := toMap(choice["message"])
	var content []any

	if msgContent := message["content"]; msgContent != nil {
		if s, ok := msgContent.(string); ok && s != "" {
			content = append(content, map[string]any{"type": "text", "text": s})
		}
	}

	if tcs, ok := getSlice(message, "tool_calls"); ok {
		for _, rawTC := range tcs {
			tc := toMap(rawTC)
			fn := toMap(tc["function"])
			argsStr := getStr(fn, "arguments")
			if argsStr == "" {
				argsStr = "{}"
			}

			var parsedArgs any
			if err := json.Unmarshal([]byte(argsStr), &parsedArgs); err != nil {
				parsedArgs = map[string]any{"_raw": argsStr}
			}

			tcID := getStr(tc, "id")
			if tcID == "" {
				tcID = fmt.Sprintf("toolu_%d_%s", nowMillis(), generateID())
			}

			content = append(content, map[string]any{
				"type":  "tool_use",
				"id":    tcID,
				"name":  getStr(fn, "name"),
				"input": parsedArgs,
			})
		}
	}

	var stopReason string
	switch getStr(choice, "finish_reason") {
	case "stop":
		stopReason = "end_turn"
	case "length":
		stopReason = "max_tokens"
	case "tool_calls":
		stopReason = "tool_use"
	default:
		stopReason = "end_turn"
	}

	usage := toMap(response["usage"])
	promptTokens, _ := getFloat(usage, "prompt_tokens")
	completionTokens, _ := getFloat(usage, "completion_tokens")

	id := getStr(response, "id")
	if id == "" {
		id = fmt.Sprintf("msg_%d", nowMillis())
	}

	return map[string]any{
		"id": id, "type": "message", "role": "assistant",
		"content": content, "model": originalModel,
		"stop_reason": stopReason, "stop_sequence": nil,
		"usage": map[string]any{
			"input_tokens":                promptTokens,
			"output_tokens":               completionTokens,
			"cache_creation_input_tokens":  float64(0),
			"cache_read_input_tokens":      float64(0),
		},
	}
}

// --------------------------------------------------------------------------
// OpenAI Request -> Anthropic Request
// --------------------------------------------------------------------------

// OpenAIToAnthropicRequest converts an OpenAI Chat Completions request body
// to an Anthropic Messages API request body.
func OpenAIToAnthropicRequest(body map[string]any) map[string]any {
	result := map[string]any{}
	var messages []any

	if msgs, ok := getSlice(body, "messages"); ok {
		for _, rawMsg := range msgs {
			msg := toMap(rawMsg)
			msgRole := getStr(msg, "role")

			if msgRole == "system" {
				// Collect system messages into Anthropic system field
				if result["system"] == nil {
					result["system"] = []any{}
				}
				// Ensure system is a slice
				sysSlice, ok := result["system"].([]any)
				if !ok {
					// If somehow it's a string, wrap it
					if s, ok2 := result["system"].(string); ok2 {
						sysSlice = []any{map[string]any{"type": "text", "text": s}}
					} else {
						sysSlice = []any{}
					}
				}
				var text string
				if s, ok := msg["content"].(string); ok {
					text = s
				} else {
					text = toJSONString(msg["content"])
				}
				sysSlice = append(sysSlice, map[string]any{"type": "text", "text": text})
				result["system"] = sysSlice

			} else if msgRole == "tool" {
				// OpenAI tool message -> Anthropic tool_result in user message
				messages = append(messages, map[string]any{
					"role": "user",
					"content": []any{
						map[string]any{
							"type":        "tool_result",
							"tool_use_id": getStr(msg, "tool_call_id"),
							"content":     msg["content"],
						},
					},
				})

			} else {
				// user or assistant message
				converted := map[string]any{"role": msgRole}

				if tcs, ok := getSlice(msg, "tool_calls"); ok && len(tcs) > 0 {
					// Assistant message with tool calls
					var contentBlocks []any
					if msgContent, ok := msg["content"].(string); ok && msgContent != "" {
						contentBlocks = append(contentBlocks, map[string]any{"type": "text", "text": msgContent})
					}
					for _, rawTC := range tcs {
						tc := toMap(rawTC)
						fn := toMap(tc["function"])

						tcID := getStr(tc, "id")
						if tcID == "" {
							tcID = fmt.Sprintf("toolu_%d_%s", nowMillis(), generateID())
						}

						// Determine function name
						name := getStr(fn, "name")
						if name == "" {
							name = getStr(tc, "name")
						}

						// Parse arguments
						var input any
						argsStr := getStr(fn, "arguments")
						if argsStr != "" {
							if err := json.Unmarshal([]byte(argsStr), &input); err != nil {
								input = map[string]any{}
							}
						} else {
							fnArgs := fn["arguments"]
							if fnArgs != nil {
								input = fnArgs
							} else {
								input = map[string]any{}
							}
						}

						contentBlocks = append(contentBlocks, map[string]any{
							"type":  "tool_use",
							"id":    tcID,
							"name":  name,
							"input": input,
						})
					}
					converted["content"] = contentBlocks

				} else if contentSlice, ok := msg["content"].([]any); ok {
					// Multi-part content (images, etc.)
					var convertedParts []any
					for _, rawPart := range contentSlice {
						part := toMap(rawPart)
						partType := getStr(part, "type")
						switch partType {
						case "text":
							convertedParts = append(convertedParts, map[string]any{"type": "text", "text": getStr(part, "text")})
						case "image_url":
							imageURL := toMap(part["image_url"])
							url := getStr(imageURL, "url")
							if strings.HasPrefix(url, "data:") {
								match := dataURIRe.FindStringSubmatch(url)
								if match != nil {
									convertedParts = append(convertedParts, map[string]any{
										"type": "image",
										"source": map[string]any{
											"type":       "base64",
											"media_type": match[1],
											"data":       match[2],
										},
									})
								} else {
									convertedParts = append(convertedParts, map[string]any{
										"type":   "image",
										"source": map[string]any{"type": "url", "url": url},
									})
								}
							} else {
								convertedParts = append(convertedParts, map[string]any{
									"type":   "image",
									"source": map[string]any{"type": "url", "url": url},
								})
							}
						default:
							convertedParts = append(convertedParts, map[string]any{"type": "text", "text": toJSONString(part)})
						}
					}
					converted["content"] = convertedParts

				} else {
					content := msg["content"]
					if content == nil {
						content = ""
					}
					converted["content"] = content
				}

				messages = append(messages, converted)
			}
		}
	}

	result["messages"] = messages

	// Map parameters
	if v, ok := body["max_tokens"]; ok {
		result["max_tokens"] = v
	}
	if v, ok := body["max_completion_tokens"]; ok {
		result["max_tokens"] = v
	}
	if v, ok := body["temperature"]; ok {
		result["temperature"] = v
	}
	if v, ok := body["top_p"]; ok {
		result["top_p"] = v
	}
	if v, ok := body["stream"]; ok {
		result["stream"] = v
	}
	if stopVal, ok := body["stop"]; ok {
		if stopSlice, ok := stopVal.([]any); ok {
			result["stop_sequences"] = stopSlice
		} else {
			result["stop_sequences"] = []any{stopVal}
		}
	}

	// Convert tools
	if tools, ok := getSlice(body, "tools"); ok && len(tools) > 0 {
		var anthropicTools []any
		for _, rawTool := range tools {
			tool := toMap(rawTool)
			fn := toMap(tool["function"])

			name := getStr(fn, "name")
			if name == "" {
				name = getStr(tool, "name")
			}
			desc := getStr(fn, "description")
			if desc == "" {
				desc = getStr(tool, "description")
			}
			params := fn["parameters"]
			if params == nil {
				params = tool["parameters"]
			}
			if params == nil {
				params = map[string]any{}
			}

			anthropicTools = append(anthropicTools, map[string]any{
				"name":         name,
				"description":  desc,
				"input_schema": params,
			})
		}
		result["tools"] = anthropicTools
	}

	// Convert tool_choice
	if tc, ok := body["tool_choice"]; ok {
		switch tcVal := tc.(type) {
		case string:
			switch tcVal {
			case "auto":
				result["tool_choice"] = map[string]any{"type": "auto"}
			case "required":
				result["tool_choice"] = map[string]any{"type": "any"}
			case "none":
				// no tool_choice in Anthropic
			}
		case map[string]any:
			fn := toMap(tcVal["function"])
			if name := getStr(fn, "name"); name != "" {
				result["tool_choice"] = map[string]any{"type": "tool", "name": name}
			}
		}
	}

	// Default max_tokens if not provided (Anthropic requires it)
	if result["max_tokens"] == nil {
		result["max_tokens"] = float64(4096)
	}

	return result
}

// --------------------------------------------------------------------------
// Anthropic Response -> OpenAI Response
// --------------------------------------------------------------------------

// AnthropicToOpenAIResponse converts an Anthropic Messages API response to an
// OpenAI Chat Completions response.
func AnthropicToOpenAIResponse(body map[string]any, model string) map[string]any {
	var contentTexts []string
	var toolCalls []any

	if blocks, ok := getSlice(body, "content"); ok {
		for _, rawBlock := range blocks {
			block := toMap(rawBlock)
			switch getStr(block, "type") {
			case "text":
				contentTexts = append(contentTexts, getStr(block, "text"))
			case "tool_use":
				input := block["input"]
				if input == nil {
					input = map[string]any{}
				}
				toolCalls = append(toolCalls, map[string]any{
					"id":   getStr(block, "id"),
					"type": "function",
					"function": map[string]any{
						"name":      getStr(block, "name"),
						"arguments": toJSONString(input),
					},
				})
			}
		}
	}

	var finishReason string
	switch getStr(body, "stop_reason") {
	case "end_turn":
		finishReason = "stop"
	case "max_tokens":
		finishReason = "length"
	case "tool_use":
		finishReason = "tool_calls"
	default:
		finishReason = "stop"
	}

	joined := strings.Join(contentTexts, "")
	var contentVal any
	if joined != "" {
		contentVal = joined
	}

	message := map[string]any{
		"role":    "assistant",
		"content": contentVal,
	}
	if len(toolCalls) > 0 {
		message["tool_calls"] = toolCalls
	}

	bodyID := getStr(body, "id")
	if bodyID == "" {
		bodyID = fmt.Sprintf("%d", nowMillis())
	}

	usage := toMap(body["usage"])
	inputTokens, _ := getFloat(usage, "input_tokens")
	outputTokens, _ := getFloat(usage, "output_tokens")

	return map[string]any{
		"id":      fmt.Sprintf("chatcmpl-%s", bodyID),
		"object":  "chat.completion",
		"created": nowUnix(),
		"model":   model,
		"choices": []any{
			map[string]any{
				"index":         float64(0),
				"message":       message,
				"finish_reason": finishReason,
			},
		},
		"usage": map[string]any{
			"prompt_tokens":     inputTokens,
			"completion_tokens": outputTokens,
			"total_tokens":      inputTokens + outputTokens,
		},
	}
}

// --------------------------------------------------------------------------
// SSE Stream Conversion: OpenAI -> Anthropic
// --------------------------------------------------------------------------

// ConvertSSEStream converts an OpenAI SSE stream (io.Reader) to an Anthropic
// SSE stream. It returns an io.ReadCloser that produces the Anthropic-format
// SSE events.
func ConvertSSEStream(reader io.Reader, originalModel string) io.ReadCloser {
	pr, pw := io.Pipe()

	go func() {
		defer pw.Close()

		scanner := bufio.NewScanner(reader)
		// Increase buffer size for large SSE messages
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

		sentMessageStart := false
		inputTokens := float64(0)
		outputTokens := float64(0)

		// Track all started content blocks so we can close them properly
		startedBlocks := map[int]bool{}
		// Counter for assigning Anthropic content block indices
		nextContentBlockIndex := 0
		// Map from OpenAI tool_call index to our Anthropic content block index
		toolIndexMap := map[int]int{}
		// Track the last finish_reason to determine stop_reason
		lastFinishReason := ""
		// Whether we've started a text content block
		textBlockStarted := false
		// Track thinking/reasoning block for DeepSeek reasoner
		thinkingBlockStarted := false
		thinkingBlockIndex := -1

		// Buffer for incomplete lines
		var lineBuffer string

		for scanner.Scan() {
			rawLine := scanner.Text()

			// Handle line buffering - SSE lines end with \n
			lineBuffer += rawLine
			line := strings.TrimSpace(lineBuffer)
			lineBuffer = ""

			if line == "" || !strings.HasPrefix(line, "data: ") {
				continue
			}

			dataStr := line[6:]

			if dataStr == "[DONE]" {
				// Close ALL started content blocks
				var indices []int
				for idx := range startedBlocks {
					indices = append(indices, idx)
				}
				sort.Ints(indices)

				for _, idx := range indices {
					writeSSE(pw, "content_block_stop", map[string]any{
						"type":  "content_block_stop",
						"index": idx,
					})
				}

				// Determine stop_reason from last finish_reason
				stopReason := "end_turn"
				if lastFinishReason == "tool_calls" {
					stopReason = "tool_use"
				} else if lastFinishReason == "length" {
					stopReason = "max_tokens"
				}

				writeSSE(pw, "message_delta", map[string]any{
					"type":  "message_delta",
					"delta": map[string]any{"stop_reason": stopReason, "stop_sequence": nil},
					"usage": map[string]any{"output_tokens": outputTokens},
				})

				writeSSE(pw, "message_stop", map[string]any{"type": "message_stop"})
				continue
			}

			var parsed map[string]any
			if err := json.Unmarshal([]byte(dataStr), &parsed); err != nil {
				continue
			}

			if !sentMessageStart {
				sentMessageStart = true
				msgID := getStr(parsed, "id")
				if msgID == "" {
					msgID = fmt.Sprintf("msg_%d", nowMillis())
				}
				writeSSE(pw, "message_start", map[string]any{
					"type": "message_start",
					"message": map[string]any{
						"id": msgID, "type": "message", "role": "assistant",
						"content": []any{}, "model": originalModel,
						"stop_reason": nil, "stop_sequence": nil,
						"usage": map[string]any{"input_tokens": inputTokens, "output_tokens": float64(0)},
					},
				})
			}

			// Update usage
			if usageMap, ok := getMap(parsed, "usage"); ok {
				if pt, ok := getFloat(usageMap, "prompt_tokens"); ok && pt > 0 {
					inputTokens = pt
				}
				if ct, ok := getFloat(usageMap, "completion_tokens"); ok && ct > 0 {
					outputTokens = ct
				}
			}

			choices, _ := getSlice(parsed, "choices")
			if len(choices) == 0 {
				continue
			}
			choice := toMap(choices[0])
			delta, ok := getMap(choice, "delta")
			if !ok {
				continue
			}

			// Handle reasoning/thinking content (DeepSeek reasoner)
			if rc := getStr(delta, "reasoning_content"); rc != "" {
				if !thinkingBlockStarted {
					thinkingBlockStarted = true
					thinkingBlockIndex = nextContentBlockIndex
					nextContentBlockIndex++
					startedBlocks[thinkingBlockIndex] = true
					writeSSE(pw, "content_block_start", map[string]any{
						"type":  "content_block_start",
						"index": thinkingBlockIndex,
						"content_block": map[string]any{
							"type":     "thinking",
							"thinking": "",
						},
					})
				}
				writeSSE(pw, "content_block_delta", map[string]any{
					"type":  "content_block_delta",
					"index": thinkingBlockIndex,
					"delta": map[string]any{
						"type":     "thinking_delta",
						"thinking": rc,
					},
				})
			}

			// Handle text content
			if content := getStr(delta, "content"); content != "" {
				if !textBlockStarted {
					textBlockStarted = true
					blockIdx := nextContentBlockIndex
					nextContentBlockIndex++
					startedBlocks[blockIdx] = true
					writeSSE(pw, "content_block_start", map[string]any{
						"type":  "content_block_start",
						"index": blockIdx,
						"content_block": map[string]any{
							"type": "text",
							"text": "",
						},
					})
				}
				// Use the correct index for text block (after thinking block if present)
				textIdx := 0
				if thinkingBlockStarted {
					textIdx = thinkingBlockIndex + 1
				}
				writeSSE(pw, "content_block_delta", map[string]any{
					"type":  "content_block_delta",
					"index": textIdx,
					"delta": map[string]any{
						"type": "text_delta",
						"text": content,
					},
				})
			}

			// Handle tool calls
			if tcs, ok := getSlice(delta, "tool_calls"); ok {
				for _, rawTC := range tcs {
					tc := toMap(rawTC)
					openaiIndex := 0
					if idx, ok := getFloat(tc, "index"); ok {
						openaiIndex = int(idx)
					}

					fn := toMap(tc["function"])

					if fnName := getStr(fn, "name"); fnName != "" {
						// New tool call starting -- assign a content block index
						if !textBlockStarted {
							// Ensure text block is at index 0 even if empty
							textBlockStarted = true
							textIdx := nextContentBlockIndex
							nextContentBlockIndex++
							startedBlocks[textIdx] = true
							writeSSE(pw, "content_block_start", map[string]any{
								"type":  "content_block_start",
								"index": textIdx,
								"content_block": map[string]any{
									"type": "text",
									"text": "",
								},
							})
						}

						blockIdx := nextContentBlockIndex
						nextContentBlockIndex++
						toolIndexMap[openaiIndex] = blockIdx
						startedBlocks[blockIdx] = true

						// Generate a tool ID if the provider omits one (DeepSeek does this)
						toolID := getStr(tc, "id")
						if toolID == "" {
							toolID = fmt.Sprintf("toolu_%d_%s", nowMillis(), generateID())
						}

						writeSSE(pw, "content_block_start", map[string]any{
							"type":  "content_block_start",
							"index": blockIdx,
							"content_block": map[string]any{
								"type":  "tool_use",
								"id":    toolID,
								"name":  fnName,
								"input": map[string]any{},
							},
						})
					}

					if fnArgs := getStr(fn, "arguments"); fnArgs != "" {
						if blockIdx, exists := toolIndexMap[openaiIndex]; exists {
							writeSSE(pw, "content_block_delta", map[string]any{
								"type":  "content_block_delta",
								"index": blockIdx,
								"delta": map[string]any{
									"type":         "input_json_delta",
									"partial_json": fnArgs,
								},
							})
						}
					}
				}
			}

			if fr := getStr(choice, "finish_reason"); fr != "" {
				lastFinishReason = fr
			}
		}
	}()

	return pr
}

// --------------------------------------------------------------------------
// SSE Stream Conversion: Anthropic -> OpenAI
// --------------------------------------------------------------------------

// ConvertAnthropicSSEToOpenAI converts an Anthropic SSE stream (io.Reader) to
// an OpenAI SSE stream. It returns an io.ReadCloser that produces the
// OpenAI-format SSE events.
func ConvertAnthropicSSEToOpenAI(reader io.Reader, model string) io.ReadCloser {
	pr, pw := io.Pipe()

	go func() {
		defer pw.Close()

		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

		messageID := fmt.Sprintf("chatcmpl-%d", nowMillis())

		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())

			// Skip event lines, we parse data lines
			if strings.HasPrefix(line, "event: ") {
				continue
			}

			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			dataStr := line[6:]
			if dataStr == "" {
				continue
			}

			var parsed map[string]any
			if err := json.Unmarshal([]byte(dataStr), &parsed); err != nil {
				continue
			}

			eventType := getStr(parsed, "type")

			switch eventType {
			case "message_start":
				msgObj := toMap(parsed["message"])
				msgID := getStr(msgObj, "id")
				if msgID != "" {
					messageID = fmt.Sprintf("chatcmpl-%s", msgID)
				}
				// Emit first chunk with role
				writeDataLine(pw, map[string]any{
					"id": messageID, "object": "chat.completion.chunk",
					"created": nowUnix(), "model": model,
					"choices": []any{
						map[string]any{
							"index":         float64(0),
							"delta":         map[string]any{"role": "assistant", "content": ""},
							"finish_reason": nil,
						},
					},
				})

			case "content_block_delta":
				delta := toMap(parsed["delta"])
				deltaType := getStr(delta, "type")

				if deltaType == "text_delta" {
					text := getStr(delta, "text")
					if text != "" {
						writeDataLine(pw, map[string]any{
							"id": messageID, "object": "chat.completion.chunk",
							"created": nowUnix(), "model": model,
							"choices": []any{
								map[string]any{
									"index":         float64(0),
									"delta":         map[string]any{"content": text},
									"finish_reason": nil,
								},
							},
						})
					}
				} else if deltaType == "input_json_delta" {
					partialJSON := getStr(delta, "partial_json")
					if partialJSON != "" {
						// Tool call argument streaming
						parsedIndex := float64(0)
						if idx, ok := getFloat(parsed, "index"); ok {
							parsedIndex = idx
						}
						writeDataLine(pw, map[string]any{
							"id": messageID, "object": "chat.completion.chunk",
							"created": nowUnix(), "model": model,
							"choices": []any{
								map[string]any{
									"index": float64(0),
									"delta": map[string]any{
										"tool_calls": []any{
											map[string]any{
												"index":    parsedIndex,
												"function": map[string]any{"arguments": partialJSON},
											},
										},
									},
									"finish_reason": nil,
								},
							},
						})
					}
				}

			case "content_block_start":
				cb := toMap(parsed["content_block"])
				if getStr(cb, "type") == "tool_use" {
					// Calculate tool call index: (parsed.index ?? 1) - 1
					toolIdx := float64(0)
					if idx, ok := getFloat(parsed, "index"); ok {
						toolIdx = idx - 1
					} else {
						toolIdx = 0 // (1) - 1 = 0
					}

					writeDataLine(pw, map[string]any{
						"id": messageID, "object": "chat.completion.chunk",
						"created": nowUnix(), "model": model,
						"choices": []any{
							map[string]any{
								"index": float64(0),
								"delta": map[string]any{
									"tool_calls": []any{
										map[string]any{
											"index":    toolIdx,
											"id":       getStr(cb, "id"),
											"type":     "function",
											"function": map[string]any{"name": getStr(cb, "name"), "arguments": ""},
										},
									},
								},
								"finish_reason": nil,
							},
						},
					})
				}

			case "message_delta":
				delta := toMap(parsed["delta"])
				stopReason := getStr(delta, "stop_reason")
				if stopReason != "" {
					var finishReason string
					switch stopReason {
					case "end_turn":
						finishReason = "stop"
					case "max_tokens":
						finishReason = "length"
					case "tool_use":
						finishReason = "tool_calls"
					default:
						finishReason = "stop"
					}

					chunk := map[string]any{
						"id": messageID, "object": "chat.completion.chunk",
						"created": nowUnix(), "model": model,
						"choices": []any{
							map[string]any{
								"index":         float64(0),
								"delta":         map[string]any{},
								"finish_reason": finishReason,
							},
						},
					}

					if usageMap, ok := getMap(parsed, "usage"); ok {
						outTokens, _ := getFloat(usageMap, "output_tokens")
						chunk["usage"] = map[string]any{
							"prompt_tokens":     float64(0),
							"completion_tokens": outTokens,
							"total_tokens":      outTokens,
						}
					}

					writeDataLine(pw, chunk)
				}

			case "message_stop":
				fmt.Fprint(pw, "data: [DONE]\n\n")
			}
		}
	}()

	return pr
}

// --------------------------------------------------------------------------
// SSE helper functions
// --------------------------------------------------------------------------

// writeSSE writes an SSE event with the given event type and data payload.
func writeSSE(w io.Writer, event string, data map[string]any) {
	b, err := json.Marshal(data)
	if err != nil {
		return
	}
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, string(b))
}

// writeDataLine writes an SSE data-only line (no event type, used for OpenAI format).
func writeDataLine(w io.Writer, data map[string]any) {
	b, err := json.Marshal(data)
	if err != nil {
		return
	}
	fmt.Fprintf(w, "data: %s\n\n", string(b))
}
