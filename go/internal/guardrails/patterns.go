package guardrails

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// PatternDef defines a regex-based guardrail pattern.
// Each definition creates a guardrail via createPatternGuardrail().
type PatternDef struct {
	ID          string
	Name        string
	Description string
	Category    string // "pii", "credentials", "network", "financial"
	Priority    int
	Patterns    []*regexp.Regexp
	// ReplacementGenerator creates a replacement string for the matched original.
	ReplacementGenerator func(original string) string
	// ContextPattern, if set, requires a match in the full text before running.
	ContextPattern *regexp.Regexp
	// Validator, if set, filters matches (return true to accept).
	Validator func(match string) bool
}

// Short fake-name pools for realistic email local parts.
var emailFirst = []string{
	"alex", "jordan", "casey", "taylor", "morgan", "riley", "quinn", "avery",
	"dakota", "skyler", "jamie", "parker", "rowan", "finley", "sage", "emery",
}

var emailLast = []string{
	"morgan", "lee", "rivera", "chen", "bailey", "brooks", "foster", "hayes",
	"kim", "patel", "cruz", "diaz", "ellis", "grant", "harper", "huang",
}

// hexToInt parses a hex substring to uint64, returning 0 on error.
func hexToInt(hex string) uint64 {
	v, _ := strconv.ParseUint(hex, 16, 64)
	return v
}

// ─── PII Patterns ────────────────────────────────────────────────────────────

var emailPatternDef = PatternDef{
	ID:          "email",
	Name:        "Email Addresses",
	Description: "Detect and anonymize email addresses",
	Category:    "pii",
	Priority:    10,
	Patterns: []*regexp.Regexp{
		regexp.MustCompile(`[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}`),
	},
	Validator: func(match string) bool {
		// Skip already-anonymized emails
		if strings.HasSuffix(strings.ToLower(match), "@anon.com") {
			return false
		}
		if strings.Contains(strings.ToLower(match), "[email-") {
			return false
		}
		return true
	},
	ReplacementGenerator: func(original string) string {
		// Generate a realistic-looking fake email (reverse-map handles deanonymization)
		h := hmacHash(original)
		first := emailFirst[hexToInt(h[0:4])%uint64(len(emailFirst))]
		last := emailLast[hexToInt(h[4:8])%uint64(len(emailLast))]
		num := hexToInt(h[8:10]) % 100
		return fmt.Sprintf("%s.%s%d@anon.com", first, last, num)
	},
}

var phonePatternDef = PatternDef{
	ID:          "phone",
	Name:        "Phone Numbers",
	Description: "Detect US and international phone number formats",
	Category:    "pii",
	Priority:    20,
	Patterns: []*regexp.Regexp{
		regexp.MustCompile(`(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}`),
		regexp.MustCompile(`\+\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}`),
	},
	ReplacementGenerator: func(original string) string {
		token := encryptForToken(original, "phone")
		h := hmacHash(original)
		area := (hexToInt(h[0:2])%800 + 200)
		exchange := (hexToInt(h[2:4])%800 + 100)
		line := (hexToInt(h[4:8])%9000 + 1000)
		return fmt.Sprintf("%d-%d-%d-%s", area, exchange, line, token[:8])
	},
}

var ssnPatternDef = PatternDef{
	ID:          "ssn",
	Name:        "Social Security Numbers",
	Description: "Detect SSN formats (XXX-XX-XXXX)",
	Category:    "pii",
	Priority:    5,
	Patterns: []*regexp.Regexp{
		regexp.MustCompile(`\b\d{3}-\d{2}-\d{4}\b`),
		regexp.MustCompile(`\b(?:(?:[0-5][0-9]{2}|6[0-5][0-9]|66[0-5]|66[7-9]|6[7-9][0-9]|[7-8][0-9]{2})(?:[0-9][1-9]|[1-9][0-9])(?:[0-9]{3}[1-9]|[0-9]{2}[1-9][0-9]|[0-9][1-9][0-9]{2}|[1-9][0-9]{3}))\b`),
	},
	Validator: func(match string) bool {
		digits := strings.ReplaceAll(match, "-", "")
		if len(digits) != 9 {
			return false
		}
		area := digits[0:3]
		group := digits[3:5]
		serial := digits[5:]
		if area == "000" || area == "666" || area[0] == '9' {
			return false
		}
		if group == "00" {
			return false
		}
		if serial == "0000" {
			return false
		}
		return true
	},
	ReplacementGenerator: func(original string) string {
		token := encryptForToken(original, "ssn")
		return fmt.Sprintf("[SSN-%s]", token[:12])
	},
}

var creditCardPatternDef = PatternDef{
	ID:          "credit_card",
	Name:        "Credit Cards",
	Description: "Detect Visa, Mastercard, Amex, and Discover card numbers",
	Category:    "financial",
	Priority:    5,
	Patterns: []*regexp.Regexp{
		regexp.MustCompile(`\b4\d{3}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b`),
		regexp.MustCompile(`\b5[1-5]\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b`),
		regexp.MustCompile(`\b3[47]\d{2}[\s-]?\d{6}[\s-]?\d{5}\b`),
		regexp.MustCompile(`\b6(?:011|5\d{2})[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b`),
	},
	ReplacementGenerator: func(original string) string {
		token := encryptForToken(original, "card")
		digits := strings.NewReplacer(" ", "", "-", "").Replace(original)
		typ := "CARD"
		if strings.HasPrefix(digits, "4") {
			typ = "VISA"
		} else if len(digits) >= 2 && digits[0] == '5' && digits[1] >= '1' && digits[1] <= '5' {
			typ = "MC"
		} else if len(digits) >= 2 && digits[0] == '3' && (digits[1] == '4' || digits[1] == '7') {
			typ = "AMEX"
		} else if strings.HasPrefix(digits, "6") {
			typ = "DISC"
		}
		return fmt.Sprintf("[%s-%s]", typ, token[:12])
	},
}

var ibanPatternDef = PatternDef{
	ID:          "iban",
	Name:        "Bank Account Numbers",
	Description: "Detect IBAN format bank account numbers",
	Category:    "financial",
	Priority:    15,
	Patterns: []*regexp.Regexp{
		regexp.MustCompile(`\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b`),
	},
	ReplacementGenerator: func(original string) string {
		token := encryptForToken(original, "iban")
		return fmt.Sprintf("[IBAN-%s]", token[:12])
	},
}

var passportPatternDef = PatternDef{
	ID:          "passport",
	Name:        "Passport Numbers",
	Description: "Detect passport numbers from multiple countries",
	Category:    "pii",
	Priority:    25,
	Patterns: []*regexp.Regexp{
		regexp.MustCompile(`\b[0-9]{9}\b`),
		regexp.MustCompile(`\bC[A-Z0-9]{8}\b`),
		regexp.MustCompile(`\b\d{2}[A-Z]{2}\d{5}\b`),
		regexp.MustCompile(`\b[A-Z]{2}\d{6}[A-Z]\b`),
		regexp.MustCompile(`\b[A-Z]{2}\d{6}\b`),
	},
	ContextPattern: regexp.MustCompile(`(?i)(?:passport|travel\s+document|document\s+number|passport\s+no)`),
	ReplacementGenerator: func(original string) string {
		token := encryptForToken(original, "passport")
		return fmt.Sprintf("[PASSPORT-%s]", token[:12])
	},
}

var ipAddressPatternDef = PatternDef{
	ID:          "ip_address",
	Name:        "IP Addresses",
	Description: "Detect and anonymize IPv4 and IPv6 addresses",
	Category:    "network",
	Priority:    30,
	Patterns: []*regexp.Regexp{
		regexp.MustCompile(`\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b`),
		regexp.MustCompile(`\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b`),
		regexp.MustCompile(`\b(?:[0-9a-fA-F]{1,4}:){1,7}:\b`),
		regexp.MustCompile(`\b::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b`),
	},
	ReplacementGenerator: func(original string) string {
		token := encryptForToken(original, "ip")
		if strings.Contains(original, ":") {
			return fmt.Sprintf("[IPv6-%s]", token[:12])
		}
		// Generate a fake IP for display
		h := hmacHash(original)
		o1 := (hexToInt(h[0:2])%223 + 1)
		o2 := hexToInt(h[2:4]) % 256
		o3 := hexToInt(h[4:6]) % 256
		o4 := (hexToInt(h[6:8])%254 + 1)
		return fmt.Sprintf("[IP-%d.%d.%d.%d-%s]", o1, o2, o3, o4, token[:6])
	},
}

var streetAddressPatternDef = PatternDef{
	ID:          "street_address",
	Name:        "Street Addresses",
	Description: "Detect physical street addresses",
	Category:    "pii",
	Priority:    35,
	Patterns: []*regexp.Regexp{
		regexp.MustCompile(`(?i)\b\d{1,6}\s+[A-Za-z0-9][\w\s.'\-]*\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Circle|Cir|Terrace|Ter|Highway|Hwy|Parkway|Pkwy|Trail|Trl)\b\.?`),
	},
	ReplacementGenerator: func(original string) string {
		token := encryptForToken(original, "address")
		return fmt.Sprintf("[ADDR-%s]", token)
	},
}

// ─── Credential Patterns ─────────────────────────────────────────────────────

var awsKeysPatternDef = PatternDef{
	ID:          "aws_keys",
	Name:        "AWS Credentials",
	Description: "Detect AWS access keys and secret keys",
	Category:    "credentials",
	Priority:    3,
	Patterns: []*regexp.Regexp{
		regexp.MustCompile(`\b(AKIA[0-9A-Z]{16})\b`),
		regexp.MustCompile(`(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|secret_?key)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?`),
	},
	ReplacementGenerator: func(original string) string {
		token := encryptForToken(original, "aws")
		if strings.HasPrefix(original, "AKIA") {
			return fmt.Sprintf("[AKIA-%s]", token[:12])
		}
		return fmt.Sprintf("[AWS-SECRET-%s]", token[:12])
	},
}

var jwtPatternDef = PatternDef{
	ID:          "jwt",
	Name:        "JWT Tokens",
	Description: "Detect JSON Web Tokens",
	Category:    "credentials",
	Priority:    8,
	Patterns: []*regexp.Regexp{
		regexp.MustCompile(`\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`),
	},
	ReplacementGenerator: func(original string) string {
		token := encryptForToken(original, "jwt")
		return fmt.Sprintf("[JWT-%s]", token[:12])
	},
}

var privateKeyPatternDef = PatternDef{
	ID:          "private_key",
	Name:        "Private Keys",
	Description: "Detect PEM-format private key blocks",
	Category:    "credentials",
	Priority:    2,
	Patterns: []*regexp.Regexp{
		regexp.MustCompile(`(?s)-----BEGIN\s+(?:RSA\s+|DSA\s+|EC\s+|OPENSSH\s+|PGP\s+)?PRIVATE KEY-----.*?-----END\s+(?:RSA\s+|DSA\s+|EC\s+|OPENSSH\s+|PGP\s+)?PRIVATE KEY-----`),
	},
	ReplacementGenerator: func(original string) string {
		token := encryptForToken(original, "key")
		return fmt.Sprintf("[PRIVATE-KEY-%s]", token[:12])
	},
}

var urlAuthPatternDef = PatternDef{
	ID:          "url_auth",
	Name:        "URL Auth",
	Description: "Strip credentials from URLs with embedded authentication",
	Category:    "credentials",
	Priority:    12,
	Patterns: []*regexp.Regexp{
		regexp.MustCompile(`https?://[^:\s]+:[^@\s]+@[^\s]+`),
	},
	ReplacementGenerator: func(original string) string {
		token := encryptForToken(original, "url")
		re := regexp.MustCompile(`//([^:]+):([^@]+)@`)
		return re.ReplaceAllString(original, fmt.Sprintf("//[redacted-%s]@", token[:8]))
	},
}

// AllPatternDefs contains all 12 pattern definitions, ordered by priority
// (credentials first, then PII, financial, network).
var AllPatternDefs = []PatternDef{
	// Credentials (highest priority - run first)
	privateKeyPatternDef,
	awsKeysPatternDef,
	ssnPatternDef,
	creditCardPatternDef,
	jwtPatternDef,
	emailPatternDef,
	urlAuthPatternDef,
	ibanPatternDef,
	phonePatternDef,
	passportPatternDef,
	ipAddressPatternDef,
	streetAddressPatternDef,
}
