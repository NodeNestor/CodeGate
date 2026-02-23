package provider

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
)

const anthropicDefaultBase = "https://api.anthropic.com"

// ForwardAnthropic forwards a request to the Anthropic API.
func ForwardAnthropic(opts ForwardOptions) (*Response, error) {
	outHeaders := map[string]string{
		"Content-Type":      "application/json",
		"Anthropic-Version": "2023-06-01",
	}

	if v := opts.Headers["anthropic-version"]; v != "" {
		outHeaders["Anthropic-Version"] = v
	}

	if opts.AuthType == "oauth" {
		outHeaders["Authorization"] = "Bearer " + opts.APIKey
		beta := opts.Headers["anthropic-beta"]
		parts := splitBeta(beta)
		if !containsBeta(parts, "oauth-2025-04-20") {
			parts = append(parts, "oauth-2025-04-20")
		}
		if !containsBeta(parts, "claude-code-20250219") {
			parts = append(parts, "claude-code-20250219")
		}
		outHeaders["Anthropic-Beta"] = strings.Join(parts, ",")
		outHeaders["Anthropic-Dangerous-Direct-Browser-Access"] = "true"
		if ua := opts.Headers["user-agent"]; ua != "" {
			outHeaders["User-Agent"] = ua
		}
		if xapp := opts.Headers["x-app"]; xapp != "" {
			outHeaders["X-App"] = xapp
		}
	} else {
		outHeaders["X-Api-Key"] = opts.APIKey
	}

	if beta := opts.Headers["anthropic-beta"]; beta != "" && outHeaders["Anthropic-Beta"] == "" {
		outHeaders["Anthropic-Beta"] = beta
	}

	targetURL := buildURL(opts.BaseURL, anthropicDefaultBase, opts.Path)

	req, err := http.NewRequest(strings.ToUpper(opts.Method), targetURL, strings.NewReader(opts.Body))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	for k, v := range outHeaders {
		req.Header.Set(k, v)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("send request: %w", err)
	}

	responseHeaders := make(map[string]string)
	for k := range resp.Header {
		responseHeaders[strings.ToLower(k)] = resp.Header.Get(k)
	}

	contentType := responseHeaders["content-type"]
	isSSE := strings.Contains(contentType, "text/event-stream")

	if isSSE {
		pr, pw := io.Pipe()
		usage := &TokenUsage{}

		go func() {
			defer pw.Close()
			tee := io.TeeReader(resp.Body, pw)
			extractAnthropicSSETokens(tee, usage)
			resp.Body.Close()
		}()

		return &Response{
			Status:   resp.StatusCode,
			Headers:  responseHeaders,
			Body:     pr,
			IsStream: true,
			Usage:    usage,
		}, nil
	}

	// Non-streaming: read the full body
	bodyBytes, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	var inputTokens, outputTokens, cacheRead, cacheWrite int
	var model string

	var parsed map[string]any
	if err := json.Unmarshal(bodyBytes, &parsed); err == nil {
		if m, ok := parsed["model"].(string); ok {
			model = m
		}
		if u, ok := parsed["usage"].(map[string]any); ok {
			inputTokens = intFromAny(u["input_tokens"])
			outputTokens = intFromAny(u["output_tokens"])
			cacheRead = intFromAny(u["cache_read_input_tokens"])
			cacheWrite = intFromAny(u["cache_creation_input_tokens"])
		}
	}

	return &Response{
		Status:           resp.StatusCode,
		Headers:          responseHeaders,
		Body:             io.NopCloser(strings.NewReader(string(bodyBytes))),
		InputTokens:      inputTokens,
		OutputTokens:     outputTokens,
		CacheReadTokens:  cacheRead,
		CacheWriteTokens: cacheWrite,
		Model:            model,
		IsStream:         false,
	}, nil
}

func extractAnthropicSSETokens(r io.Reader, usage *TokenUsage) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 256*1024), 256*1024)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		jsonStr := line[6:]
		if jsonStr == "[DONE]" {
			continue
		}

		var ev map[string]any
		if err := json.Unmarshal([]byte(jsonStr), &ev); err != nil {
			continue
		}

		evType, _ := ev["type"].(string)
		switch evType {
		case "message_start":
			if msg, ok := ev["message"].(map[string]any); ok {
				if m, ok := msg["model"].(string); ok {
					usage.Model.Store(m)
				}
				if u, ok := msg["usage"].(map[string]any); ok {
					usage.InputTokens.Store(int64(intFromAny(u["input_tokens"])))
					usage.CacheReadTokens.Store(int64(intFromAny(u["cache_read_input_tokens"])))
					usage.CacheWriteTokens.Store(int64(intFromAny(u["cache_creation_input_tokens"])))
				}
			}
		case "message_delta":
			if u, ok := ev["usage"].(map[string]any); ok {
				usage.OutputTokens.Store(int64(intFromAny(u["output_tokens"])))
			}
		}
	}

	if err := scanner.Err(); err != nil {
		log.Printf("[anthropic] SSE parse error: %v", err)
	}
}

func splitBeta(beta string) []string {
	if beta == "" {
		return nil
	}
	parts := strings.Split(beta, ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

func containsBeta(parts []string, target string) bool {
	for _, p := range parts {
		if p == target {
			return true
		}
	}
	return false
}

func buildURL(baseURL, defaultBase, path string) string {
	base := defaultBase
	if baseURL != "" {
		base = baseURL
	}

	parsed, err := url.Parse(base)
	if err != nil {
		return defaultBase + path
	}

	basePath := strings.TrimRight(parsed.Path, "/")
	return fmt.Sprintf("%s://%s%s%s", parsed.Scheme, parsed.Host, basePath, path)
}

func intFromAny(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	default:
		return 0
	}
}
