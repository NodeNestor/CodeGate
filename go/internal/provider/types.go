package provider

import (
	"io"
	"sync/atomic"
)

// TokenUsage tracks token counts, populated asynchronously for streams.
type TokenUsage struct {
	InputTokens      atomic.Int64
	OutputTokens     atomic.Int64
	CacheReadTokens  atomic.Int64
	CacheWriteTokens atomic.Int64
	Model            atomic.Value // string
}

// Response represents a response from an LLM provider.
type Response struct {
	Status   int
	Headers  map[string]string
	Body     io.ReadCloser
	IsStream bool

	// For non-streaming responses, token counts are set directly.
	// For streaming responses, read from Usage after stream completes.
	InputTokens      int
	OutputTokens     int
	CacheReadTokens  int
	CacheWriteTokens int
	Model            string

	// Usage is populated asynchronously for streaming responses.
	Usage *TokenUsage
}

// ForwardOptions contains the parameters for forwarding a request.
type ForwardOptions struct {
	Path              string
	Method            string
	Headers           map[string]string
	Body              string
	APIKey            string
	BaseURL           string
	AuthType          string
	ExternalAccountID string
}
