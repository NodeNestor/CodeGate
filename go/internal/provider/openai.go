package provider

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
)

const openaiDefaultBase = "https://api.openai.com"

var versionPathRe = regexp.MustCompile(`/v\d+$`)

// ForwardOpenAI forwards a request to an OpenAI-compatible API.
func ForwardOpenAI(opts ForwardOptions) (*Response, error) {
	outHeaders := map[string]string{
		"Content-Type":  "application/json",
		"Authorization": "Bearer " + opts.APIKey,
	}

	if org := opts.Headers["openai-organization"]; org != "" {
		outHeaders["OpenAI-Organization"] = org
	}

	if opts.ExternalAccountID != "" {
		outHeaders["ChatGPT-Account-ID"] = opts.ExternalAccountID
		outHeaders["User-Agent"] = "codex_cli_rs/0.1.0"
		outHeaders["Originator"] = "codex_cli_rs"
	}

	isCodexSub := opts.ExternalAccountID != "" && opts.BaseURL == ""
	base := openaiDefaultBase
	if isCodexSub {
		base = "https://chatgpt.com/backend-api/codex"
	} else if opts.BaseURL != "" {
		base = opts.BaseURL
	}

	targetURL := buildOpenAIURL(base, opts.Path)

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
			extractOpenAISSETokens(tee, usage)
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

	// Non-streaming
	bodyBytes, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	var inputTokens, outputTokens int
	var model string

	var parsed map[string]any
	if err := json.Unmarshal(bodyBytes, &parsed); err == nil {
		if m, ok := parsed["model"].(string); ok {
			model = m
		}
		if u, ok := parsed["usage"].(map[string]any); ok {
			inputTokens = intFromAny(u["prompt_tokens"])
			outputTokens = intFromAny(u["completion_tokens"])
		}
	}

	return &Response{
		Status:       resp.StatusCode,
		Headers:      responseHeaders,
		Body:         io.NopCloser(strings.NewReader(string(bodyBytes))),
		InputTokens:  inputTokens,
		OutputTokens: outputTokens,
		Model:        model,
		IsStream:     false,
	}, nil
}

func extractOpenAISSETokens(r io.Reader, usage *TokenUsage) {
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

		if m, ok := ev["model"].(string); ok {
			usage.Model.Store(m)
		}
		if u, ok := ev["usage"].(map[string]any); ok {
			usage.InputTokens.Store(int64(intFromAny(u["prompt_tokens"])))
			usage.OutputTokens.Store(int64(intFromAny(u["completion_tokens"])))
		}
	}

	if err := scanner.Err(); err != nil {
		log.Printf("[openai] SSE parse error: %v", err)
	}
}

func buildOpenAIURL(base, path string) string {
	// Simple URL building
	base = strings.TrimRight(base, "/")

	// Gemini compatibility
	if strings.Contains(base, "generativelanguage.googleapis.com") {
		geminiPath := strings.Replace(path, "/v1/", "/", 1)
		return base + "/v1beta/openai" + geminiPath
	}

	// If base has a version segment, strip /v1 from path
	adjustedPath := path
	if versionPathRe.MatchString(base) {
		adjustedPath = strings.Replace(path, "/v1/", "/", 1)
	}

	return base + adjustedPath
}
