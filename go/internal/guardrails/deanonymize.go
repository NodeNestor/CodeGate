package guardrails

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
)

// ─── Deanonymization patterns ────────────────────────────────────────────────

// API keys with prefixes: sk-[token], ghp_[token], etc.
var apiKeyDeanonRe = regexp.MustCompile(
	`(?i)(sk-ant-|sk-proj-|sk-|ghp_|gho_|glpat-|xoxb-|xoxp-|xapp-|xoxe-|AKIA|AIza|hf_|pk_live_|sk_live_|rk_live_|whsec_|github_pat_|pypi-|npm_|FLWSECK-|sq0atp-|SG\.|key-|sk-or-|r8_|sntrys_|op_|Bearer\s+)?\[([A-Za-z0-9_-]+)\]`,
)

// SECRET tokens: [SECRET-bucket-token]
var secretTokenDeanonRe = regexp.MustCompile(
	`(?i)\[SECRET-(short|med|long)-([A-Za-z0-9_-]+)\]`,
)

// Bracketed tokens: [CATEGORY-token] or [CATEGORY-prefix-token]
var bracketTokenDeanonRe = regexp.MustCompile(
	`\[([A-Z]+)(?:-[0-9.]+)?-([A-Za-z0-9_-]+)\]`,
)

// Email tokens: <anything>@anon.com
var emailTokenDeanonRe = regexp.MustCompile(
	`(?i)[a-zA-Z0-9._%+-]+@anon\.com`,
)

// URL redacted: [redacted-token]
var urlRedactedDeanonRe = regexp.MustCompile(
	`(?i)\[redacted-([A-Za-z0-9_-]+)\]`,
)

// Phone with token suffix: 555-123-4567-<token>
var phoneTokenDeanonRe = regexp.MustCompile(
	`\b(\d{3}-\d{3}-\d{4})-([A-Za-z0-9_-]+)\b`,
)

// Plain IPs (model may extract from bracket tokens)
var plainIPDeanonRe = regexp.MustCompile(
	`\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b`,
)

// Plain phones (model may extract from structured format)
var plainPhoneDeanonRe = regexp.MustCompile(
	`\b\d{3}-\d{3}-\d{4}\b`,
)

// URL credential extract pattern
var credExtractRe = regexp.MustCompile(`//([^:]+):([^@]+)@`)

// Category mapping for bracket prefixes.
var bracketCategoryMap = map[string]string{
	"SSN":         "ssn",
	"VISA":        "card",
	"MC":          "card",
	"AMEX":        "card",
	"DISC":        "card",
	"CARD":        "card",
	"IBAN":        "iban",
	"PASSPORT":    "passport",
	"IP":          "ip",
	"IPv6":        "ip",
	"ADDR":        "address",
	"AKIA":        "aws",
	"AWS-SECRET":  "aws",
	"JWT":         "jwt",
	"PRIVATE-KEY": "key",
	"REDACTED":    "password",
}

// Deanonymize reverses all known replacements in the text using stateless
// decryption and reverse-map lookups. The pattern matching order is important
// and matches the TypeScript version exactly.
func Deanonymize(text string) string {
	if text == "" {
		return text
	}

	result := text

	// 1. Handle API keys with prefixes: sk-[token], ghp_[token], etc.
	result = apiKeyDeanonRe.ReplaceAllStringFunc(result, func(fullMatch string) string {
		subs := apiKeyDeanonRe.FindStringSubmatch(fullMatch)
		if len(subs) < 3 {
			return fullMatch
		}
		token := subs[2]

		if decrypted := decryptToken(token, "api_key"); decrypted != "" {
			return decrypted
		}
		if decrypted := decryptToken(token, "secret"); decrypted != "" {
			return decrypted
		}
		if orig := reverseLookup(fullMatch); orig != "" {
			return orig
		}
		return fullMatch
	})

	// 2. Handle SECRET tokens: [SECRET-bucket-token]
	result = secretTokenDeanonRe.ReplaceAllStringFunc(result, func(fullMatch string) string {
		subs := secretTokenDeanonRe.FindStringSubmatch(fullMatch)
		if len(subs) < 3 {
			return fullMatch
		}
		token := subs[2]

		if decrypted := decryptToken(token, "secret"); decrypted != "" {
			return decrypted
		}
		if orig := reverseLookup(fullMatch); orig != "" {
			return orig
		}
		return fullMatch
	})

	// 3. Handle bracketed tokens: [CATEGORY-token] or [CATEGORY-prefix-token]
	result = bracketTokenDeanonRe.ReplaceAllStringFunc(result, func(fullMatch string) string {
		subs := bracketTokenDeanonRe.FindStringSubmatch(fullMatch)
		if len(subs) < 3 {
			return fullMatch
		}
		prefix := subs[1]
		token := subs[2]

		category := strings.ToLower(prefix)
		if mapped, ok := bracketCategoryMap[prefix]; ok {
			category = mapped
		}

		if decrypted := decryptToken(token, category); decrypted != "" {
			return decrypted
		}
		if orig := reverseLookup(fullMatch); orig != "" {
			return orig
		}
		return fullMatch
	})

	// 4. Handle email format: <anything>@anon.com (reverse-map lookup)
	result = emailTokenDeanonRe.ReplaceAllStringFunc(result, func(fullMatch string) string {
		if orig := reverseLookup(fullMatch); orig != "" {
			return orig
		}
		return fullMatch
	})

	// 4.5. Handle plain IPs and phone numbers registered in reverse-map
	// (The model extracts these from bracket tokens and writes them plain)
	result = plainIPDeanonRe.ReplaceAllStringFunc(result, func(fullMatch string) string {
		if orig := reverseLookup(fullMatch); orig != "" {
			return orig
		}
		return fullMatch
	})
	result = plainPhoneDeanonRe.ReplaceAllStringFunc(result, func(fullMatch string) string {
		if orig := reverseLookup(fullMatch); orig != "" {
			return orig
		}
		return fullMatch
	})

	// 5. Handle name replacements via reverse-map lookup.
	// Names are plain fake names (no tokens), so we do whole-word reverse lookups.
	reverseMap.Range(func(key, value any) bool {
		replacement := key.(string)
		original := value.(string)

		// Only process name-category replacements (skip emails, IPs, phones, etc.)
		if strings.Contains(replacement, "@") || strings.HasPrefix(replacement, "[") {
			return true
		}
		if ipPatternCheck.MatchString(replacement) {
			return true
		}
		if phonePatternCheck.MatchString(replacement) {
			return true
		}
		if !strings.Contains(result, replacement) {
			return true
		}
		// Replace all whole-word occurrences
		escaped := regexp.QuoteMeta(replacement)
		re := regexp.MustCompile(`\b` + escaped + `\b`)
		result = re.ReplaceAllString(result, original)
		return true
	})

	// 6. Handle URL redacted format: [redacted-token]
	result = urlRedactedDeanonRe.ReplaceAllStringFunc(result, func(fullMatch string) string {
		subs := urlRedactedDeanonRe.FindStringSubmatch(fullMatch)
		if len(subs) < 2 {
			return fullMatch
		}
		token := subs[1]

		if decrypted := decryptToken(token, "url"); decrypted != "" {
			if m := credExtractRe.FindStringSubmatch(decrypted); m != nil {
				return fmt.Sprintf("//[%s:[REDACTED]]@", m[1])
			}
		}
		if orig := reverseLookup(fullMatch); orig != "" {
			return orig
		}
		return fullMatch
	})

	// 7. Handle phone format: 555-123-4567-token
	result = phoneTokenDeanonRe.ReplaceAllStringFunc(result, func(fullMatch string) string {
		subs := phoneTokenDeanonRe.FindStringSubmatch(fullMatch)
		if len(subs) < 3 {
			return fullMatch
		}
		token := subs[2]

		if decrypted := decryptToken(token, "phone"); decrypted != "" {
			return decrypted
		}
		if orig := reverseLookup(fullMatch); orig != "" {
			return orig
		}
		return fullMatch
	})

	return result
}

var (
	ipPatternCheck    = regexp.MustCompile(`^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$`)
	phonePatternCheck = regexp.MustCompile(`^\d{3}-\d{3}-\d{4}$`)
)

// ─── Stream deanonymization ──────────────────────────────────────────────────

// CreateDeanonymizeStream wraps an io.Reader of SSE data and returns an
// io.ReadCloser that deanonymizes text_delta content across SSE events.
//
// Tokens can be split across multiple SSE events (each event carries a small
// text delta). We buffer text_delta content per content block and only flush
// text that cannot be part of an in-progress token. On content_block_stop
// (or stream end) we flush everything remaining.
func CreateDeanonymizeStream(r io.Reader) io.ReadCloser {
	pr, pw := io.Pipe()

	go func() {
		defer pw.Close()

		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 0, 256*1024), 256*1024)

		var sseBuffer bytes.Buffer
		textBuffers := make(map[int]string)
		jsonBuffers := make(map[int]string)

		flushBuffer := func(index int) {
			if buf, ok := textBuffers[index]; ok && buf != "" {
				deanon := Deanonymize(buf)
				writeTextDelta(pw, index, deanon)
				delete(textBuffers, index)
			}
			if buf, ok := jsonBuffers[index]; ok && buf != "" {
				deanon := Deanonymize(buf)
				writeJSONDelta(pw, index, deanon)
				delete(jsonBuffers, index)
			}
		}

		tryFlushSafe := func(index int) {
			buf, ok := textBuffers[index]
			if !ok || buf == "" {
				return
			}

			safePoint := findSafeFlushPoint(buf)
			if safePoint > 0 {
				safe := buf[:safePoint]
				remaining := buf[safePoint:]
				deanon := Deanonymize(safe)
				writeTextDelta(pw, index, deanon)
				textBuffers[index] = remaining
			}
		}

		// Process line by line, accumulating SSE events
		for scanner.Scan() {
			line := scanner.Text()
			sseBuffer.WriteString(line)
			sseBuffer.WriteByte('\n')

			// Check if we have a complete SSE event (empty line = event separator)
			if line != "" {
				continue
			}

			// Process the accumulated event
			event := sseBuffer.String()
			sseBuffer.Reset()

			if strings.TrimSpace(event) == "" {
				fmt.Fprint(pw, "\n")
				continue
			}

			// Try to parse the SSE data line
			dataLine := extractDataLine(event)
			if dataLine == "" {
				fmt.Fprint(pw, Deanonymize(event))
				continue
			}

			var parsed map[string]any
			if err := json.Unmarshal([]byte(dataLine), &parsed); err != nil {
				fmt.Fprint(pw, Deanonymize(event))
				continue
			}

			// Anthropic text_delta: buffer for cross-event deanonymization
			if parsed["type"] == "content_block_delta" {
				delta, _ := parsed["delta"].(map[string]any)
				if delta != nil && delta["type"] == "text_delta" {
					if text, ok := delta["text"].(string); ok {
						idx := getIndex(parsed)
						textBuffers[idx] += text
						tryFlushSafe(idx)
						continue
					}
				}

				// Anthropic input_json_delta: buffer for tool call deanonymization
				if delta != nil && delta["type"] == "input_json_delta" {
					if partialJSON, ok := delta["partial_json"].(string); ok {
						idx := getIndex(parsed)
						jsonBuffers[idx] += partialJSON
						continue // Don't flush until content_block_stop
					}
				}
			}

			// content_block_stop: flush remaining buffered text, then forward
			if parsed["type"] == "content_block_stop" {
				idx := getIndex(parsed)
				flushBuffer(idx)
				fmt.Fprint(pw, event)
				continue
			}

			// Everything else passes through with basic per-event deanonymization
			fmt.Fprint(pw, Deanonymize(event))
		}

		// Flush all remaining buffers on stream end
		for idx := range textBuffers {
			flushBuffer(idx)
		}
		for idx := range jsonBuffers {
			flushBuffer(idx)
		}
		if sseBuffer.Len() > 0 {
			remaining := strings.TrimSpace(sseBuffer.String())
			if remaining != "" {
				fmt.Fprint(pw, Deanonymize(remaining))
			}
		}
	}()

	return pr
}

// findSafeFlushPoint finds the latest safe cut point in text. Everything
// before this index cannot be part of a still-growing anonymised token.
func findSafeFlushPoint(text string) int {
	if text == "" {
		return 0
	}

	searchStart := len(text) - 200
	if searchStart < 0 {
		searchStart = 0
	}
	tail := text[searchStart:]

	// 1. Unclosed bracket: [CATEGORY-token... or [SECRET-med-token...
	lastOpen := strings.LastIndex(tail, "[")
	if lastOpen != -1 && !strings.Contains(tail[lastOpen:], "]") {
		return searchStart + lastOpen
	}

	// 2. Check if the buffer tail is a prefix of any known anonymized value.
	maxOverlap := 0
	reverseMap.Range(func(key, value any) bool {
		k := key.(string)
		if strings.HasPrefix(k, "[") {
			return true // bracket tokens handled above
		}
		limit := len(k) - 1
		if limit > len(text) {
			limit = len(text)
		}
		for n := limit; n >= 3; n-- {
			if n <= maxOverlap {
				break // can't beat current best
			}
			if strings.HasSuffix(text, k[:n]) {
				maxOverlap = n
				break
			}
		}
		return true
	})

	if maxOverlap > 0 {
		return len(text) - maxOverlap
	}

	return len(text)
}

// writeTextDelta writes a text_delta SSE event.
func writeTextDelta(w io.Writer, index int, text string) {
	data := map[string]any{
		"type":  "content_block_delta",
		"index": index,
		"delta": map[string]any{
			"type": "text_delta",
			"text": text,
		},
	}
	jsonBytes, _ := json.Marshal(data)
	fmt.Fprintf(w, "event: content_block_delta\ndata: %s\n\n", string(jsonBytes))
}

// writeJSONDelta writes an input_json_delta SSE event.
func writeJSONDelta(w io.Writer, index int, jsonStr string) {
	data := map[string]any{
		"type":  "content_block_delta",
		"index": index,
		"delta": map[string]any{
			"type":         "input_json_delta",
			"partial_json": jsonStr,
		},
	}
	jsonBytes, _ := json.Marshal(data)
	fmt.Fprintf(w, "event: content_block_delta\ndata: %s\n\n", string(jsonBytes))
}

// extractDataLine finds the SSE data field in an event string.
var dataLineRe = regexp.MustCompile(`(?m)^data:\s*(.+)$`)

func extractDataLine(event string) string {
	m := dataLineRe.FindStringSubmatch(event)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}

// getIndex extracts the "index" field from a parsed SSE JSON object, defaulting to 0.
func getIndex(parsed map[string]any) int {
	if v, ok := parsed["index"].(float64); ok {
		return int(v)
	}
	return 0
}
