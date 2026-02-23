package guardrails

import (
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strings"
	"sync"

	"codegate-proxy/internal/db"
)

// ─── Guardrail interface ─────────────────────────────────────────────────────

// GuardrailResult holds the outcome of running a guardrail.
type GuardrailResult struct {
	GuardrailID    string
	Action         string // "allow", "mask", "block"
	ModifiedText   string
	DetectionCount int
	Message        string
}

// GuardrailConfig holds the configuration for a guardrail.
type GuardrailConfig struct {
	ID          string
	Name        string
	Description string
	Enabled     bool
	DefaultOn   bool
	Lifecycles  []string // "pre_call", "post_call"
	Priority    int
	Category    string // "pii", "credentials", "network", "financial"
}

// Guardrail is the interface all guardrails implement.
type Guardrail interface {
	ID() string
	Config() *GuardrailConfig
	// ShouldRun returns true if this guardrail should execute on the given text
	// in the given lifecycle phase.
	ShouldRun(text string, lifecycle string) bool
	// Execute runs the guardrail on text, returning the modified text and
	// the number of detections.
	Execute(text string) (string, int)
}

// ─── Registry ────────────────────────────────────────────────────────────────

type guardrailFactory func() Guardrail

var (
	factories   = make(map[string]guardrailFactory)
	instances   = make(map[string]Guardrail)
	registryMu  sync.RWMutex
)

// registerGuardrail registers a guardrail factory. The guardrail is not
// instantiated until first use.
func registerGuardrail(id string, factory guardrailFactory) {
	registryMu.Lock()
	defer registryMu.Unlock()
	factories[id] = factory
	delete(instances, id) // clear cached instance if re-registering
}

// getGuardrailInstance returns a guardrail by ID (lazy instantiation).
func getGuardrailInstance(id string) Guardrail {
	registryMu.Lock()
	defer registryMu.Unlock()

	if inst, ok := instances[id]; ok {
		return inst
	}
	factory, ok := factories[id]
	if !ok {
		return nil
	}
	inst := factory()
	instances[id] = inst
	return inst
}

// getAllGuardrails returns all guardrails sorted by priority (lower = higher
// priority = runs first).
func getAllGuardrails() []Guardrail {
	registryMu.Lock()
	defer registryMu.Unlock()

	// Ensure all factories are instantiated
	for id, factory := range factories {
		if _, ok := instances[id]; !ok {
			instances[id] = factory()
		}
	}

	result := make([]Guardrail, 0, len(instances))
	for _, inst := range instances {
		result = append(result, inst)
	}

	sort.Slice(result, func(i, j int) bool {
		return result[i].Config().Priority < result[j].Config().Priority
	})
	return result
}

// setGuardrailEnabled updates a guardrail's enabled state.
func setGuardrailEnabled(id string, enabled bool) bool {
	g := getGuardrailInstance(id)
	if g == nil {
		return false
	}
	g.Config().Enabled = enabled
	return true
}

// ─── Reverse map (replacement -> original) ───────────────────────────────────

// reverseMap stores replacement -> original mappings populated during anonymization.
var reverseMap sync.Map

// logReplacement records a replacement in the reverse map and registers
// any sub-values that the model might extract from structured formats.
func logReplacement(category, original, replacement string) {
	reverseMap.Store(replacement, original)

	// Register inner sub-values that the model might extract from
	// structured replacement formats.
	if m := ipSubRe.FindStringSubmatch(replacement); m != nil {
		reverseMap.Store(m[1], original)
	}
	if m := phoneSubRe.FindStringSubmatch(replacement); m != nil {
		reverseMap.Store(m[1], original)
	}
}

var (
	ipSubRe    = regexp.MustCompile(`\[IP-(\d+\.\d+\.\d+\.\d+)-`)
	phoneSubRe = regexp.MustCompile(`^(\d{3}-\d{3}-\d{4})-[A-Za-z0-9_-]+$`)
)

// reverseLookup returns the original for a replacement, or "" if not found.
func reverseLookup(replacement string) string {
	if v, ok := reverseMap.Load(replacement); ok {
		return v.(string)
	}
	return ""
}

// ClearReverseMappings clears the in-memory reverse map.
func ClearReverseMappings() {
	reverseMap.Range(func(key, value any) bool {
		reverseMap.Delete(key)
		return true
	})
}

// ─── Core mapping logic ──────────────────────────────────────────────────────

// getOrCreateMapping generates a replacement for a matched value using the
// provided generator function and logs it.
func getOrCreateMapping(original, category string, generatorFn func(string) string) string {
	replacement := generatorFn(original)
	logReplacement(category, original, replacement)
	return replacement
}

// replacePatternMatches replaces all matches of a pattern with mapped replacements.
func replacePatternMatches(text string, pattern *regexp.Regexp, category string, generatorFn func(string) string) string {
	return pattern.ReplaceAllStringFunc(text, func(match string) string {
		return getOrCreateMapping(match, category, generatorFn)
	})
}

// ─── Pattern guardrail factory ───────────────────────────────────────────────

// patternGuardrail implements Guardrail for regex-based pattern detection.
type patternGuardrail struct {
	def    PatternDef
	config GuardrailConfig
}

func (pg *patternGuardrail) ID() string            { return pg.def.ID }
func (pg *patternGuardrail) Config() *GuardrailConfig { return &pg.config }

func (pg *patternGuardrail) ShouldRun(text string, lifecycle string) bool {
	if !pg.config.Enabled {
		return false
	}
	if !containsStr(pg.config.Lifecycles, lifecycle) {
		return false
	}
	// If contextPattern is set, only run when context is present
	if pg.def.ContextPattern != nil {
		if !pg.def.ContextPattern.MatchString(text) {
			return false
		}
	}
	return true
}

func (pg *patternGuardrail) Execute(text string) (string, int) {
	result := text
	count := 0

	for _, pattern := range pg.def.Patterns {
		matches := pattern.FindAllString(result, -1)
		if len(matches) == 0 {
			continue
		}

		// Filter with validator if present
		if pg.def.Validator != nil {
			hasValid := false
			for _, m := range matches {
				if pg.def.Validator(m) {
					hasValid = true
					break
				}
			}
			if !hasValid {
				continue
			}
		}

		result = pattern.ReplaceAllStringFunc(result, func(match string) string {
			if pg.def.Validator != nil && !pg.def.Validator(match) {
				return match
			}
			count++
			return getOrCreateMapping(match, pg.def.ID, pg.def.ReplacementGenerator)
		})
	}

	return result, count
}

func createPatternGuardrail(def PatternDef) Guardrail {
	return &patternGuardrail{
		def: def,
		config: GuardrailConfig{
			ID:          def.ID,
			Name:        def.Name,
			Description: def.Description,
			Enabled:     true,
			DefaultOn:   true,
			Lifecycles:  []string{"pre_call"},
			Priority:    def.Priority,
			Category:    def.Category,
		},
	}
}

// ─── API Key guardrail ───────────────────────────────────────────────────────

// vendorPrefixes lists 40+ known API key prefixes.
var vendorPrefixes = []string{
	"sk-ant-", "sk-proj-", "sk-", "ghp_", "gho_", "glpat-", "xoxb-",
	"xoxp-", "xapp-", "xoxe-", "AKIA", "AIza", "hf_", "pk_live_", "sk_live_",
	"rk_live_", "whsec_", "github_pat_", "pypi-", "npm_", "FLWSECK-",
	"sq0atp-", "SG.", "key-", "sk-or-", "r8_", "sntrys_",
	"op_", "Bearer ey",
}

var knownPrefixRe = regexp.MustCompile(
	`(?:sk-ant-|sk-proj-|sk-|ghp_|gho_|glpat-|xoxb-|xoxp-|xapp-|xoxe-|AKIA|AIza|hf_|pk_live_|sk_live_|rk_live_|whsec_|github_pat_|pypi-|npm_|FLWSECK-|sq0atp-|SG\.|key-|sk-or-|r8_|sntrys_|op_|Bearer\s+ey)[A-Za-z0-9_\-/.+=]{10,}`,
)

// standaloneTokenRe matches standalone high-entropy tokens for entropy fallback.
var standaloneTokenRe = regexp.MustCompile(
	`(?:^|[^a-zA-Z0-9_/\\\-\.])([A-Za-z0-9+/=_\-]{20,})(?:[^a-zA-Z0-9_/\\\-\.]|$)`,
)

func generateAPIKeyReplacement(original string) string {
	prefix := ""
	for _, p := range vendorPrefixes {
		if strings.HasPrefix(original, p) {
			prefix = p
			break
		}
	}
	if prefix == "" {
		prefix = "key-"
	}
	token := encryptForToken(original, "api_key")
	return fmt.Sprintf("%s[%s]", prefix, token[:12])
}

func generateAPIKeySecretReplacement(original string) string {
	token := encryptForToken(original, "secret")
	lenBucket := "med"
	if len(original) < 16 {
		lenBucket = "short"
	} else if len(original) >= 64 {
		lenBucket = "long"
	}
	return fmt.Sprintf("[SECRET-%s-%s]", lenBucket, token[:12])
}

type apiKeyGuardrail struct {
	config GuardrailConfig
}

func (g *apiKeyGuardrail) ID() string            { return "api_key" }
func (g *apiKeyGuardrail) Config() *GuardrailConfig { return &g.config }

func (g *apiKeyGuardrail) ShouldRun(text string, lifecycle string) bool {
	if !g.config.Enabled {
		return false
	}
	return containsStr(g.config.Lifecycles, lifecycle)
}

func (g *apiKeyGuardrail) Execute(text string) (string, int) {
	result := text
	count := 0

	// Strategy 1: Known vendor prefixes
	result = knownPrefixRe.ReplaceAllStringFunc(result, func(match string) string {
		count++
		return getOrCreateMapping(match, "api_key", generateAPIKeyReplacement)
	})

	// Strategy 2: Entropy-based fallback for unknown key formats
	hexShortRe := regexp.MustCompile(`^[a-f0-9]{32,}$`)

	result = standaloneTokenRe.ReplaceAllStringFunc(result, func(fullMatch string) string {
		// Extract the token (captured group) from the full match
		subs := standaloneTokenRe.FindStringSubmatch(fullMatch)
		if len(subs) < 2 {
			return fullMatch
		}
		token := subs[1]

		// Skip already-replaced tokens
		if strings.HasPrefix(token, "[") {
			return fullMatch
		}
		if strings.HasPrefix(token, "SECRET-") || strings.HasPrefix(token, "REDACTED-") {
			return fullMatch
		}
		if strings.HasPrefix(token, "redacted-") {
			return fullMatch
		}
		if strings.Contains(token, "-redacted-") {
			return fullMatch
		}

		// Skip commit hashes / UUIDs (hex under 40 chars)
		if hexShortRe.MatchString(strings.ToLower(token)) && len(token) < 40 {
			return fullMatch
		}

		if looksLikeSecret(token) {
			count++
			replacement := getOrCreateMapping(token, "secret", generateAPIKeySecretReplacement)
			return strings.Replace(fullMatch, token, replacement, 1)
		}
		return fullMatch
	})

	return result, count
}

func createAPIKeyGuardrail() Guardrail {
	return &apiKeyGuardrail{
		config: GuardrailConfig{
			ID:          "api_key",
			Name:        "API Keys & Tokens",
			Description: "Detect 40+ vendor API key prefixes and high-entropy tokens",
			Enabled:     true,
			DefaultOn:   true,
			Lifecycles:  []string{"pre_call"},
			Priority:    4,
			Category:    "credentials",
		},
	}
}

// ─── Password guardrail ─────────────────────────────────────────────────────

func generatePasswordReplacement(original string) string {
	token := encryptForToken(original, "password")
	return fmt.Sprintf("[REDACTED-%s]", token[:12])
}

func generatePasswordSecretReplacement(original string) string {
	token := encryptForToken(original, "secret")
	lenBucket := "med"
	if len(original) < 16 {
		lenBucket = "short"
	} else if len(original) >= 64 {
		lenBucket = "long"
	}
	return fmt.Sprintf("[SECRET-%s-%s]", lenBucket, token[:12])
}

var (
	// Keyword context pattern (29+ keywords)
	keywordContextRe = regexp.MustCompile(
		`(?i)(?:password|passwd|pass|pwd|secret|token|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key|secret[_-]?key|encryption[_-]?key|master[_-]?key|signing[_-]?key|client[_-]?secret|app[_-]?secret|jwt|bearer|credential|ssh[_-]?key|session[_-]?id|session[_-]?token|webhook[_-]?secret|signing[_-]?secret)\s*(?:[:=]|is|was|set\s+to)\s*["']?([^\s"',;}{)\]]{6,})["']?`,
	)

	// Standalone high-entropy token pattern
	standaloneEntropyRe = regexp.MustCompile(
		`(?:^|[^a-zA-Z0-9_/\\\-\.])([A-Za-z0-9+/=_\-]{20,})(?:[^a-zA-Z0-9_/\\\-\.]|$)`,
	)

	// Environment variable assignment with secret-sounding names
	envVarSecretRe = regexp.MustCompile(
		`([A-Z][A-Z0-9_]{2,})\s*=\s*["']?([^\s"']{12,})["']?`,
	)

	secretVarNamesRe = regexp.MustCompile(
		`(?i)(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|SIGNING|MASTER|ENCRYPTION|API|JWT)`,
	)

	trivialValuesRe = regexp.MustCompile(`(?i)^(true|false|null|undefined|none|\d+)$`)
	trivialEnvRe    = regexp.MustCompile(`(?i)^(true|false|null|undefined|none|\d+|https?:)$`)
)

type passwordGuardrail struct {
	config GuardrailConfig
}

func (g *passwordGuardrail) ID() string            { return "password" }
func (g *passwordGuardrail) Config() *GuardrailConfig { return &g.config }

func (g *passwordGuardrail) ShouldRun(text string, lifecycle string) bool {
	if !g.config.Enabled {
		return false
	}
	return containsStr(g.config.Lifecycles, lifecycle)
}

func (g *passwordGuardrail) Execute(text string) (string, int) {
	result := text
	count := 0

	// Strategy 1: Keyword context detection
	result = keywordContextRe.ReplaceAllStringFunc(result, func(fullMatch string) string {
		subs := keywordContextRe.FindStringSubmatch(fullMatch)
		if len(subs) < 2 {
			return fullMatch
		}
		value := subs[1]
		if len(value) < 6 {
			return fullMatch
		}
		if trivialValuesRe.MatchString(value) {
			return fullMatch
		}
		count++
		replacement := getOrCreateMapping(value, "password", generatePasswordReplacement)
		return strings.Replace(fullMatch, value, replacement, 1)
	})

	// Strategy 2: Standalone high-entropy string scan
	hexShortRe := regexp.MustCompile(`^[a-f0-9]{32,}$`)

	result = standaloneEntropyRe.ReplaceAllStringFunc(result, func(fullMatch string) string {
		subs := standaloneEntropyRe.FindStringSubmatch(fullMatch)
		if len(subs) < 2 {
			return fullMatch
		}
		token := subs[1]

		if strings.HasPrefix(token, "[REDACTED") || strings.HasPrefix(token, "[SECRET") {
			return fullMatch
		}
		if strings.HasPrefix(token, "SECRET-") || strings.HasPrefix(token, "REDACTED-") {
			return fullMatch
		}
		if strings.HasPrefix(token, "redacted-") {
			return fullMatch
		}
		if strings.Contains(token, "-redacted-") {
			return fullMatch
		}

		// Skip short hex strings (commit hashes, etc.)
		if hexShortRe.MatchString(strings.ToLower(token)) && len(token) < 40 {
			return fullMatch
		}

		if looksLikeSecret(token) {
			count++
			replacement := getOrCreateMapping(token, "password", generatePasswordSecretReplacement)
			return strings.Replace(fullMatch, token, replacement, 1)
		}
		return fullMatch
	})

	// Strategy 3: Environment variable assignments with secret-sounding names
	result = envVarSecretRe.ReplaceAllStringFunc(result, func(fullMatch string) string {
		subs := envVarSecretRe.FindStringSubmatch(fullMatch)
		if len(subs) < 3 {
			return fullMatch
		}
		varName := subs[1]
		value := subs[2]

		if !secretVarNamesRe.MatchString(varName) {
			return fullMatch
		}
		if trivialEnvRe.MatchString(value) {
			return fullMatch
		}
		count++
		replacement := getOrCreateMapping(value, "password", generatePasswordReplacement)
		return strings.Replace(fullMatch, value, replacement, 1)
	})

	return result, count
}

func createPasswordGuardrail() Guardrail {
	return &passwordGuardrail{
		config: GuardrailConfig{
			ID:          "password",
			Name:        "Passwords & Secrets",
			Description: "Detect values near password/secret/token keywords and env vars",
			Enabled:     true,
			DefaultOn:   true,
			Lifecycles:  []string{"pre_call"},
			Priority:    6,
			Category:    "credentials",
		},
	}
}

// ─── Name guardrail (STUB) ──────────────────────────────────────────────────

// TODO: Implement the full name guardrail with 4 detection strategies:
// 1. Known "FirstName LastName" pairs
// 2. Context keywords (name:, author:, by:, etc.)
// 3. Greeting/sign-off patterns (Hello John,)
// 4. Standalone known first names
//
// For now, this is a passthrough stub that does not modify text.

type nameGuardrail struct {
	config GuardrailConfig
}

func (g *nameGuardrail) ID() string            { return "name" }
func (g *nameGuardrail) Config() *GuardrailConfig { return &g.config }

func (g *nameGuardrail) ShouldRun(text string, lifecycle string) bool {
	if !g.config.Enabled {
		return false
	}
	return containsStr(g.config.Lifecycles, lifecycle)
}

func (g *nameGuardrail) Execute(text string) (string, int) {
	// TODO: Implement name detection and anonymization.
	// This stub passes text through unchanged.
	return text, 0
}

func createNameGuardrail() Guardrail {
	return &nameGuardrail{
		config: GuardrailConfig{
			ID:          "name",
			Name:        "Person Names",
			Description: "Detect names using dictionaries, context keywords, and greeting patterns",
			Enabled:     true,
			DefaultOn:   true,
			Lifecycles:  []string{"pre_call"},
			Priority:    50,
			Category:    "pii",
		},
	}
}

// ─── Initialization ──────────────────────────────────────────────────────────

// InitGuardrails registers all built-in guardrails and loads config from DB.
// Call once at startup after db.Open().
func InitGuardrails() {
	registerBuiltinGuardrails()
	syncConfigFromDB()
	log.Println("[guardrails] Initialized with stateless deterministic encryption")
}

// registerBuiltinGuardrails registers all built-in guardrail factories.
func registerBuiltinGuardrails() {
	// 12 pattern-based guardrails
	for _, def := range AllPatternDefs {
		d := def // capture
		registerGuardrail(d.ID, func() Guardrail {
			return createPatternGuardrail(d)
		})
	}

	// 3 complex guardrails with custom detection logic
	registerGuardrail("api_key", createAPIKeyGuardrail)
	registerGuardrail("password", createPasswordGuardrail)
	registerGuardrail("name", createNameGuardrail)
}

// syncConfigFromDB reads guardrail enabled states from DB settings.
func syncConfigFromDB() {
	all := getAllGuardrails()
	categories := getEnabledCategories()

	for _, g := range all {
		// Check per-guardrail setting first
		perSetting := db.GetSetting(fmt.Sprintf("guardrail_%s_enabled", g.ID()))
		if perSetting != "" {
			setGuardrailEnabled(g.ID(), perSetting == "true" || perSetting == "1")
			continue
		}

		// Fall back to category-based config (backward compat)
		setGuardrailEnabled(g.ID(), containsStr(categories, g.ID()))
	}
}

// getEnabledCategories returns enabled guardrail IDs from DB settings.
func getEnabledCategories() []string {
	val := db.GetSetting("privacy_categories")
	if val == "" {
		// Default: all guardrails with defaultOn=true
		all := getAllGuardrails()
		result := make([]string, 0, len(all))
		for _, g := range all {
			if g.Config().DefaultOn {
				result = append(result, g.ID())
			}
		}
		return result
	}
	parts := strings.Split(val, ",")
	result := make([]string, 0, len(parts))
	for _, s := range parts {
		s = strings.TrimSpace(s)
		if s != "" {
			result = append(result, s)
		}
	}
	return result
}

// ─── Status checks ───────────────────────────────────────────────────────────

// IsGuardrailsEnabled checks if the guardrails system is enabled.
func IsGuardrailsEnabled() bool {
	val := db.GetSetting("privacy_enabled")
	return val == "true" || val == "1"
}

// ─── Pipeline execution ──────────────────────────────────────────────────────

// RunGuardrails runs all applicable guardrails on a text string.
// Returns the modified text.
func RunGuardrails(text string) string {
	if text == "" {
		return text
	}

	currentText := text
	for _, g := range getAllGuardrails() {
		if !g.ShouldRun(currentText, "pre_call") {
			continue
		}
		modified, _ := g.Execute(currentText)
		currentText = modified
	}

	return currentText
}

// RunGuardrailsOnRequestBody walks an Anthropic-format request body and
// anonymizes text content. It handles system prompts (string or text block
// array), messages with text blocks, and tool_result content.
// Thinking blocks are SKIPPED (they have cryptographic signatures).
func RunGuardrailsOnRequestBody(body map[string]any) map[string]any {
	// Deep clone via JSON round-trip
	raw, err := json.Marshal(body)
	if err != nil {
		return body
	}
	var clone map[string]any
	if err := json.Unmarshal(raw, &clone); err != nil {
		return body
	}

	anonymize := func(text string) string {
		return RunGuardrails(text)
	}

	// Anonymize system prompt
	if sys, ok := clone["system"]; ok {
		switch v := sys.(type) {
		case string:
			clone["system"] = anonymize(v)
		case []any:
			for _, block := range v {
				if bm, ok := block.(map[string]any); ok {
					if bm["type"] == "text" {
						if t, ok := bm["text"].(string); ok {
							bm["text"] = anonymize(t)
						}
					}
				}
			}
		}
	}

	// Anonymize messages
	if msgs, ok := clone["messages"].([]any); ok {
		for _, msg := range msgs {
			m, ok := msg.(map[string]any)
			if !ok {
				continue
			}

			switch content := m["content"].(type) {
			case string:
				if result := anonymize(content); result != "" {
					m["content"] = result
				}
			case []any:
				for _, block := range content {
					bm, ok := block.(map[string]any)
					if !ok {
						continue
					}

					// Skip thinking blocks - they have signatures that must not be modified
					if bm["type"] == "thinking" {
						continue
					}

					if bm["type"] == "text" {
						if t, ok := bm["text"].(string); ok {
							if result := anonymize(t); result != "" {
								bm["text"] = result
							}
						}
					}

					if bm["type"] == "tool_result" {
						switch inner := bm["content"].(type) {
						case string:
							if result := anonymize(inner); result != "" {
								bm["content"] = result
							}
						case []any:
							for _, innerBlock := range inner {
								if ibm, ok := innerBlock.(map[string]any); ok {
									if ibm["type"] == "text" {
										if t, ok := ibm["text"].(string); ok {
											if result := anonymize(t); result != "" {
												ibm["text"] = result
											}
										}
									}
								}
							}
						}
					}
				}
			}
		}
	}

	return clone
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func containsStr(slice []string, val string) bool {
	for _, s := range slice {
		if s == val {
			return true
		}
	}
	return false
}
