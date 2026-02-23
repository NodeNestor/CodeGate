package models

import "strings"

type Tier string

const (
	TierOpus   Tier = "opus"
	TierSonnet Tier = "sonnet"
	TierHaiku  Tier = "haiku"
)

// DetectTier detects the model tier from a model name string.
func DetectTier(model string) Tier {
	lower := strings.ToLower(model)
	switch {
	case strings.Contains(lower, "opus"):
		return TierOpus
	case strings.Contains(lower, "sonnet"):
		return TierSonnet
	case strings.Contains(lower, "haiku"):
		return TierHaiku
	default:
		return ""
	}
}

// CostRates maps model names to per-million-token costs.
var CostRates = map[string][2]float64{
	"claude-opus-4-6-20250219":   {15.0, 75.0},
	"claude-sonnet-4-6-20250219": {3.0, 15.0},
	"claude-haiku-4-5-20251001":  {0.25, 1.25},
	"claude-opus-4-20250514":     {15.0, 75.0},
	"claude-sonnet-4-20250514":   {3.0, 15.0},
	"claude-opus-4-6":            {15.0, 75.0},
	"claude-sonnet-4-6":          {3.0, 15.0},
	"gpt-4o":                     {2.5, 10.0},
	"gpt-4o-mini":                {0.15, 0.6},
	"gpt-4.1":                    {2.0, 8.0},
	"o3":                         {10.0, 40.0},
	"o4-mini":                    {1.1, 4.4},
	"deepseek-r1":                {0.55, 2.19},
}

var DefaultCostRate = [2]float64{2.0, 8.0}

// EstimateCost estimates the cost of a request in USD.
func EstimateCost(model string, inputTokens, outputTokens int) float64 {
	rates, ok := CostRates[model]
	if !ok {
		rates = DefaultCostRate
	}
	return float64(inputTokens)/1_000_000*rates[0] + float64(outputTokens)/1_000_000*rates[1]
}
