package provider

import (
	"codegate-proxy/internal/db"
	"fmt"
)

// Forward dispatches a request to the appropriate provider based on the account.
func Forward(account db.Account, opts ForwardOptions) (*Response, error) {
	// Codex subscription accounts
	if (account.Provider == "openai" || account.Provider == "openai_sub") &&
		account.ExternalAccountID != "" && account.AuthType == "oauth" {
		return ForwardOpenAI(opts)
	}

	switch account.Provider {
	case "anthropic":
		return ForwardAnthropic(opts)

	case "openai", "openai_sub", "glm", "cerebras", "deepseek", "gemini", "minimax":
		return ForwardOpenAI(opts)

	case "openrouter":
		return ForwardOpenAI(opts) // OpenRouter is OpenAI-compatible

	default:
		if account.BaseURL != "" {
			return ForwardOpenAI(opts) // Custom provider treated as OpenAI-compatible
		}
		return nil, fmt.Errorf("unknown provider %q with no base_url configured", account.Provider)
	}
}
