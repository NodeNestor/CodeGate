package routing

import (
	"codegate-proxy/internal/cooldown"
	"codegate-proxy/internal/db"
	"codegate-proxy/internal/models"
	"codegate-proxy/internal/ratelimit"
	"codegate-proxy/internal/tenant"
	"sort"
	"sync"
	"time"
)

// ResolvedRoute contains the primary account and fallback candidates.
type ResolvedRoute struct {
	Account             db.Account
	TargetModel         string
	NeedsFormatConvert  bool
	Tier                models.Tier
	ConfigID            string
	Fallbacks           []Candidate
}

// Candidate is an account+model pair for failover.
type Candidate struct {
	Account     db.Account
	TargetModel string
}

var (
	roundRobinMu       sync.Mutex
	roundRobinCounters = make(map[string]int)
)

// Resolve resolves a route for a given model using the global active config.
func Resolve(model string) (*ResolvedRoute, error) {
	return resolveWithConfigID(model, "")
}

// ResolveForTenant resolves a route with tenant-scoped config.
func ResolveForTenant(model string, t *tenant.Tenant) (*ResolvedRoute, error) {
	if t == nil || t.ConfigID == "" {
		return Resolve(model)
	}
	return resolveWithConfigID(model, t.ConfigID)
}

func resolveWithConfigID(model string, configID string) (*ResolvedRoute, error) {
	tier := models.DetectTier(model)

	var activeConfig *db.Config
	var err error
	if configID != "" {
		activeConfig, err = db.GetConfigByID(configID)
	} else {
		activeConfig, err = db.GetActiveConfig()
	}
	if err != nil {
		return nil, err
	}

	enabledAccounts, err := db.GetEnabledAccounts()
	if err != nil {
		return nil, err
	}

	if activeConfig == nil {
		// No active config: pick first enabled account
		if len(enabledAccounts) == 0 {
			return nil, nil
		}

		// Prefer Anthropic accounts
		var account db.Account
		for _, a := range enabledAccounts {
			if a.Provider == "anthropic" {
				account = a
				break
			}
		}
		if account.ID == "" {
			account = enabledAccounts[0]
		}

		return &ResolvedRoute{
			Account:            account,
			TargetModel:        "",
			NeedsFormatConvert: account.Provider != "anthropic",
			Tier:               tier,
			ConfigID:           "",
			Fallbacks:          nil,
		}, nil
	}

	// Get tier assignments
	allTiers, err := db.GetConfigTiers(activeConfig.ID)
	if err != nil {
		return nil, err
	}

	var tierAssignments []db.ConfigTier
	if tier != "" {
		for _, t := range allTiers {
			if models.Tier(t.Tier) == tier {
				tierAssignments = append(tierAssignments, t)
			}
		}
	} else {
		tierAssignments = allTiers
	}

	if len(tierAssignments) == 0 {
		// Fall back to any enabled account
		if len(enabledAccounts) == 0 {
			return nil, nil
		}
		return &ResolvedRoute{
			Account:            enabledAccounts[0],
			TargetModel:        "",
			NeedsFormatConvert: enabledAccounts[0].Provider != "anthropic",
			Tier:               tier,
			ConfigID:           activeConfig.ID,
			Fallbacks:          nil,
		}, nil
	}

	// Build account map
	accountMap := make(map[string]db.Account, len(enabledAccounts))
	for _, a := range enabledAccounts {
		accountMap[a.ID] = a
	}

	// Filter candidates
	var candidates []candidate
	for _, assignment := range tierAssignments {
		account, ok := accountMap[assignment.AccountID]
		if !ok {
			continue
		}
		if ratelimit.IsRateLimited(account.ID, account.RateLimit) {
			continue
		}
		if account.MonthlyBudget.Valid && account.MonthlyBudget.Float64 > 0 {
			spend := db.GetMonthlySpend(account.ID)
			if spend >= account.MonthlyBudget.Float64 {
				continue
			}
		}
		tm := assignment.TargetModel
		candidates = append(candidates, candidate{account: account, targetModel: tm, priority: assignment.Priority})
	}

	if len(candidates) == 0 {
		return nil, nil
	}

	// Apply routing strategy
	ordered := selectByStrategy(activeConfig.RoutingStrategy, candidates, activeConfig.ID, string(tier))

	primary := ordered[0]
	var fallbacks []Candidate
	for _, c := range ordered[1:] {
		fallbacks = append(fallbacks, Candidate{Account: c.account, TargetModel: c.targetModel})
	}

	return &ResolvedRoute{
		Account:            primary.account,
		TargetModel:        primary.targetModel,
		NeedsFormatConvert: primary.account.Provider != "anthropic",
		Tier:               tier,
		ConfigID:           activeConfig.ID,
		Fallbacks:          fallbacks,
	}, nil
}

type candidate struct {
	account     db.Account
	targetModel string
	priority    int
}

func selectByStrategy(strategy string, candidates []candidate, configID, tier string) []candidate {
	switch strategy {
	case "round-robin":
		key := configID + ":" + tier
		roundRobinMu.Lock()
		counter := roundRobinCounters[key]
		roundRobinCounters[key] = counter + 1
		roundRobinMu.Unlock()

		idx := counter % len(candidates)
		result := make([]candidate, len(candidates))
		copy(result, candidates[idx:])
		copy(result[len(candidates)-idx:], candidates[:idx])
		return result

	case "least-used":
		type withSpend struct {
			candidate
			spend float64
		}
		ws := make([]withSpend, len(candidates))
		for i, c := range candidates {
			ws[i] = withSpend{candidate: c, spend: db.GetMonthlySpend(c.account.ID)}
		}
		sort.Slice(ws, func(i, j int) bool { return ws[i].spend < ws[j].spend })
		result := make([]candidate, len(ws))
		for i, w := range ws {
			result[i] = w.candidate
		}
		return result

	case "budget-aware":
		type withRemaining struct {
			candidate
			remaining float64
		}
		wr := make([]withRemaining, len(candidates))
		for i, c := range candidates {
			budget := 1e18 // effectively infinity
			if c.account.MonthlyBudget.Valid && c.account.MonthlyBudget.Float64 > 0 {
				budget = c.account.MonthlyBudget.Float64
			}
			spend := db.GetMonthlySpend(c.account.ID)
			wr[i] = withRemaining{candidate: c, remaining: budget - spend}
		}
		sort.Slice(wr, func(i, j int) bool { return wr[i].remaining > wr[j].remaining })
		result := make([]candidate, len(wr))
		for i, w := range wr {
			result[i] = w.candidate
		}
		return result

	default: // "priority"
		sorted := make([]candidate, len(candidates))
		copy(sorted, candidates)
		sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].priority > sorted[j].priority })
		return sorted
	}
}

// SortByCooldown sorts candidates so non-cooled-down accounts come first.
func SortByCooldown(candidates []Candidate) []Candidate {
	now := time.Now()
	sorted := make([]Candidate, len(candidates))
	copy(sorted, candidates)

	sort.SliceStable(sorted, func(i, j int) bool {
		cdI := cooldown.CooldownUntil(sorted[i].Account.ID)
		cdJ := cooldown.CooldownUntil(sorted[j].Account.ID)
		cooledI := !cdI.IsZero() && cdI.After(now)
		cooledJ := !cdJ.IsZero() && cdJ.After(now)

		if !cooledI && !cooledJ {
			return false
		}
		if !cooledI {
			return true
		}
		if !cooledJ {
			return false
		}
		return cdI.Before(cdJ)
	})
	return sorted
}
