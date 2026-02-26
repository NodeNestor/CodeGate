package proxy

import (
	"codegate-proxy/internal/auth"
	"codegate-proxy/internal/convert"
	"codegate-proxy/internal/cooldown"
	"codegate-proxy/internal/db"
	"codegate-proxy/internal/guardrails"
	"codegate-proxy/internal/limits"
	"codegate-proxy/internal/models"
	"codegate-proxy/internal/provider"
	"codegate-proxy/internal/ratelimit"
	"codegate-proxy/internal/routing"
	"codegate-proxy/internal/tenant"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// Handler returns the HTTP handler for the proxy.
func Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", handleHealth)
	mux.HandleFunc("GET /v1/models", handleModels)
	mux.HandleFunc("/v1/", handleProxy)

	return withCORS(mux)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"status":"ok","timestamp":"%s","version":"2.0.0-go"}`, time.Now().UTC().Format(time.RFC3339))
}

func handleModels(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"object":"list","data":[
		{"id":"claude-sonnet-4-20250514","object":"model","created":1700000000,"owned_by":"anthropic"},
		{"id":"claude-opus-4-20250514","object":"model","created":1700000000,"owned_by":"anthropic"},
		{"id":"claude-haiku-4-20250514","object":"model","created":1700000000,"owned_by":"anthropic"}
	]}`))
}

func handleProxy(w http.ResponseWriter, r *http.Request) {
	startTime := time.Now()
	path := r.URL.Path
	method := r.Method

	// CORS preflight
	if method == "OPTIONS" {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		w.WriteHeader(204)
		return
	}

	// 1. Tenant-aware authentication
	apiKey := extractAPIKey(r)
	var tenantCtx *tenant.Tenant

	globalKey := getEnvDefault("PROXY_API_KEY", "")
	if globalKey != "" && apiKey == globalKey {
		// Global key matched — no tenant, backward compat
	} else if tenant.HasTenants() {
		tenantCtx = tenant.Resolve(apiKey)
		if tenantCtx == nil {
			writeError(w, r, "anthropic", 401, "authentication_error", "Invalid API key")
			return
		}
	} else if globalKey != "" {
		writeError(w, r, "anthropic", 401, "authentication_error", "Invalid or missing proxy API key")
		return
	}
	// else: no global key AND no tenants = open proxy (current behavior)

	// 1.5 Tenant-level rate limiting
	if tenantCtx != nil && tenantCtx.RateLimit > 0 {
		if ratelimit.CheckAndRecord("tenant:"+tenantCtx.ID, tenantCtx.RateLimit) {
			writeError(w, r, "anthropic", 429, "rate_limit_error", "Rate limit exceeded")
			return
		}
	}

	// 2. Detect inbound format from path
	inboundFormat := "anthropic"
	if strings.Contains(path, "/chat/completions") {
		inboundFormat = "openai"
	}

	// Settings helper: tenant-scoped if available
	getSetting := db.GetSetting
	if tenantCtx != nil {
		getSetting = func(key string) string {
			return tenant.GetSetting(tenantCtx, key)
		}
	}

	// 3. Read request body
	bodyBytes, err := io.ReadAll(r.Body)
	r.Body.Close()
	if err != nil {
		writeError(w, r, inboundFormat, 400, "invalid_request_error", "Failed to read request body")
		return
	}

	// 4. Parse body JSON
	var bodyJSON map[string]any
	originalModel := "claude-sonnet-4-20250514"
	isStreamRequest := false

	if len(bodyBytes) > 0 {
		if err := json.Unmarshal(bodyBytes, &bodyJSON); err != nil {
			writeError(w, r, inboundFormat, 400, "invalid_request_error", "Invalid JSON in request body")
			return
		}
		if m, ok := bodyJSON["model"].(string); ok {
			originalModel = m
		}
		if s, ok := bodyJSON["stream"].(bool); ok {
			isStreamRequest = s
		}
	}

	_ = isStreamRequest

	// 5. If inbound is OpenAI format, convert to Anthropic internally for routing
	anthropicBody := bodyJSON
	if inboundFormat == "openai" && len(bodyBytes) > 0 {
		converted := convert.OpenAIToAnthropicRequest(bodyJSON)
		if converted != nil {
			anthropicBody = converted
			// Preserve original model for routing
			if m, ok := bodyJSON["model"].(string); ok {
				anthropicBody["model"] = m
			}
		}
	}

	// 6. Guardrails: anonymize outgoing request body
	guardrailsActive := guardrails.IsGuardrailsEnabledWith(getSetting)
	if guardrailsActive && len(bodyBytes) > 0 {
		anthropicBody = guardrails.RunGuardrailsOnRequestBody(anthropicBody)
	}

	// 6.5 Clamp max_tokens to model limits
	if model, ok := anthropicBody["model"].(string); ok {
		if mt, ok := anthropicBody["max_tokens"].(float64); ok {
			v := int(mt)
			if clamped := limits.ClampMaxTokens(&v, model); clamped != nil {
				anthropicBody["max_tokens"] = float64(*clamped)
			}
		}
		if mct, ok := anthropicBody["max_completion_tokens"].(float64); ok {
			v := int(mct)
			if clamped := limits.ClampMaxTokens(&v, model); clamped != nil {
				anthropicBody["max_completion_tokens"] = float64(*clamped)
			}
		}
	}

	// 7. Detect tier
	tier := models.DetectTier(originalModel)

	// 8. Resolve route
	route, err := routing.ResolveForTenant(originalModel, tenantCtx)
	if err != nil {
		log.Printf("[proxy] Route resolution error: %v", err)
		writeError(w, r, inboundFormat, 503, "overloaded_error", "Route resolution failed")
		return
	}
	if route == nil {
		writeError(w, r, inboundFormat, 503, "overloaded_error", "No available accounts to handle this request. Configure accounts and an active routing config.")
		return
	}

	// Build candidate list: primary + fallbacks
	allCandidates := make([]routing.Candidate, 0, 1+len(route.Fallbacks))
	allCandidates = append(allCandidates, routing.Candidate{Account: route.Account, TargetModel: route.TargetModel})
	allCandidates = append(allCandidates, route.Fallbacks...)
	allCandidates = routing.SortByCooldown(allCandidates)

	autoSwitchOnError := getSetting("auto_switch_on_error") != "false"
	autoSwitchOnRateLimit := getSetting("auto_switch_on_rate_limit") != "false"

	// Collect request headers for forwarding
	reqHeaders := make(map[string]string)
	for k := range r.Header {
		reqHeaders[strings.ToLower(k)] = r.Header.Get(k)
	}

	// Try each candidate account in order (primary + fallbacks)
	for i, cand := range allCandidates {
		account := cand.Account
		targetModel := cand.TargetModel
		if targetModel == "" {
			targetModel = originalModel
		}
		isFailover := i > 0
		isLastCandidate := i == len(allCandidates)-1
		targetIsAnthropic := account.Provider == "anthropic"

		// Skip cooled-down accounts unless last candidate
		if !isLastCandidate && cooldown.IsOnCooldown(account.ID) {
			log.Printf("[proxy] Skipping %q (on cooldown), %d candidates left", account.Name, len(allCandidates)-i-1)
			continue
		}

		// Atomic rate limit check + record
		if ratelimit.CheckAndRecord(account.ID, account.RateLimit) {
			if !isLastCandidate {
				log.Printf("[proxy] Skipping %q (rate limited), %d candidates left", account.Name, len(allCandidates)-i-1)
				continue
			}
			writeError(w, r, inboundFormat, 429, "rate_limit_error",
				fmt.Sprintf("Rate limit exceeded for account %q (%d req/min)", account.Name, account.RateLimit))
			return
		}

		// ── Decide conversion path ──────────────────────────────
		var forwardPath string
		var forwardBody string

		if inboundFormat == "openai" && !targetIsAnthropic {
			// OpenAI client → OpenAI-compatible provider: forward original body with model swap
			forwardJSON := deepCopy(bodyJSON)
			forwardJSON["model"] = targetModel
			b, _ := json.Marshal(forwardJSON)
			forwardBody = string(b)
			forwardPath = "/v1/chat/completions"
		} else if inboundFormat == "openai" && targetIsAnthropic {
			// OpenAI client → Anthropic provider: use converted anthropic body
			forwardJSON := deepCopy(anthropicBody)
			forwardJSON["model"] = targetModel
			b, _ := json.Marshal(forwardJSON)
			forwardBody = string(b)
			forwardPath = "/v1/messages"
		} else if inboundFormat == "anthropic" && !targetIsAnthropic {
			// Anthropic client → OpenAI-compatible provider: convert to OpenAI format
			openaiBody := convert.AnthropicToOpenAI(anthropicBody, targetModel)
			b, _ := json.Marshal(openaiBody)
			forwardBody = string(b)
			forwardPath = "/v1/chat/completions"
		} else {
			// Anthropic client → Anthropic provider: forward as-is
			forwardJSON := deepCopy(anthropicBody)
			forwardJSON["model"] = targetModel
			b, _ := json.Marshal(forwardJSON)
			forwardBody = string(b)
			forwardPath = "/v1/messages"
			if strings.HasPrefix(path, "/v1/messages") {
				forwardPath = path
			}
		}

		strategy := "config"
		if route.ConfigID == "" {
			strategy = "direct"
		}

		action := "Routing"
		if isFailover {
			action = "Failover"
		}
		log.Printf("[proxy] %s [%s] to %q (%s/%s) model=%s", action, inboundFormat, account.Name, account.Provider, account.AuthType, targetModel)

		// OAuth token refresh before forwarding
		if account.AuthType == "oauth" {
			if err := auth.EnsureValidToken(&account); err != nil {
				log.Printf("[proxy] Token refresh failed for %q: %v", account.Name, err)
			}
		}

		// Forward to provider
		provResp, err := provider.Forward(account, provider.ForwardOptions{
			Path:              forwardPath,
			Method:            method,
			Headers:           reqHeaders,
			Body:              forwardBody,
			APIKey:            account.APIKey,
			BaseURL:           account.BaseURL,
			AuthType:          account.AuthType,
			ExternalAccountID: account.ExternalAccountID,
		})

		if err != nil {
			errMsg := err.Error()
			log.Printf("[proxy] Error forwarding to %q: %s", account.Name, errMsg)
			db.RecordAccountError(account.ID, errMsg)
			db.UpdateAccountStatus(account.ID, "error", errMsg)
			cooldown.Set(account.ID, "connection_error", 0)

			if autoSwitchOnError && !isLastCandidate {
				log.Printf("[proxy] Attempting failover (%d accounts left)...", len(allCandidates)-i-1)
				continue
			}

			writeError(w, r, inboundFormat, 502, "api_error",
				fmt.Sprintf("All provider accounts failed. Last error: %s", errMsg))
			return
		}

		// ── Check for retryable errors ──────────────────────────
		if provResp.Status == 429 {
			db.UpdateAccountStatus(account.ID, "rate_limited", "Rate limited (429)")
			db.RecordAccountError(account.ID, "Rate limited (429)")
			retryAfter := cooldown.ParseRetryAfter(provResp.Headers["retry-after"])
			cooldown.Set(account.ID, "rate_limit", retryAfter)
			if autoSwitchOnRateLimit && !isLastCandidate {
				log.Printf("[proxy] Got 429 from %q, trying failover...", account.Name)
				provResp.Body.Close()
				continue
			}
		} else if provResp.Status >= 500 {
			db.RecordAccountError(account.ID, fmt.Sprintf("Server error (%d)", provResp.Status))
			cooldown.Set(account.ID, "server_error", 0)
			if autoSwitchOnError && !isLastCandidate {
				log.Printf("[proxy] Got %d from %q, trying failover...", provResp.Status, account.Name)
				provResp.Body.Close()
				continue
			}
		}

		// ── Handle streaming response ────────────────────────────
		if provResp.IsStream {
			if provResp.Status >= 200 && provResp.Status < 300 {
				db.RecordAccountSuccess(account.ID)
				cooldown.Clear(account.ID)
			}

			responseStream := provResp.Body

			// Convert stream format if there's a mismatch
			if inboundFormat == "anthropic" && !targetIsAnthropic {
				// Provider sends OpenAI SSE, client wants Anthropic SSE
				responseStream = convert.ConvertSSEStream(provResp.Body, originalModel)
			} else if inboundFormat == "openai" && targetIsAnthropic {
				// Provider sends Anthropic SSE, client wants OpenAI SSE
				responseStream = convert.ConvertAnthropicSSEToOpenAI(provResp.Body, targetModel)
			}

			// Guardrails: deanonymize streaming response
			if guardrailsActive {
				responseStream = guardrails.CreateDeanonymizeStream(responseStream)
			}

			// Write SSE response headers
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("Connection", "keep-alive")
			w.Header().Set("X-Proxy-Account", account.Name)
			if tenantCtx != nil {
				w.Header().Set("X-Proxy-Tenant", tenantCtx.Name)
			}
			strategyLabel := strategy
			if isFailover {
				strategyLabel = strategy + "+failover"
			}
			w.Header().Set("X-Proxy-Strategy", strategyLabel)
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Headers", "*")
			w.Header().Set("Access-Control-Expose-Headers", "x-proxy-account, x-proxy-strategy, x-proxy-tenant")
			w.WriteHeader(provResp.Status)

			// Stream with flushing
			flusher, hasFlusher := w.(http.Flusher)
			buf := make([]byte, 32*1024)
			for {
				n, readErr := responseStream.Read(buf)
				if n > 0 {
					w.Write(buf[:n])
					if hasFlusher {
						flusher.Flush()
					}
				}
				if readErr != nil {
					break
				}
			}
			responseStream.Close()

			// Record usage async
			latencyMs := int(time.Since(startTime).Milliseconds())
			tenantIDForLog := ""
			if tenantCtx != nil {
				tenantIDForLog = tenantCtx.ID
			}
			go func() {
				costUSD := models.EstimateCost(targetModel, provResp.InputTokens, provResp.OutputTokens)
				db.RecordUsage(account.ID, route.ConfigID, string(tier), originalModel, targetModel,
					provResp.InputTokens, provResp.OutputTokens, provResp.CacheReadTokens, provResp.CacheWriteTokens, costUSD, tenantIDForLog)

				if getSetting("request_logging") == "true" {
					db.InsertRequestLog(method, path, inboundFormat, account.ID, account.Name, account.Provider,
						originalModel, targetModel, provResp.Status, provResp.InputTokens, provResp.OutputTokens,
						latencyMs, true, isFailover, "", tenantIDForLog)
				}
			}()

			return
		}

		// ── Handle non-streaming response ────────────────────────
		responseBodyBytes, err := io.ReadAll(provResp.Body)
		provResp.Body.Close()
		if err != nil {
			writeError(w, r, inboundFormat, 502, "api_error", "Failed to read provider response")
			return
		}
		responseBodyStr := string(responseBodyBytes)

		// OAuth 401 retry: force sync and retry once
		if provResp.Status == 401 && account.AuthType == "oauth" && !isFailover {
			if updated := auth.ForceSyncFromFile(&account); updated != nil {
				log.Printf("[proxy] Retrying with refreshed token for %q", account.Name)
				provResp2, err2 := provider.Forward(*updated, provider.ForwardOptions{
					Path:              forwardPath,
					Method:            method,
					Headers:           reqHeaders,
					Body:              forwardBody,
					APIKey:            updated.APIKey,
					BaseURL:           updated.BaseURL,
					AuthType:          updated.AuthType,
					ExternalAccountID: updated.ExternalAccountID,
				})
				if err2 == nil {
					responseBodyBytes, _ = io.ReadAll(provResp2.Body)
					provResp2.Body.Close()
					responseBodyStr = string(responseBodyBytes)
					provResp = provResp2
				}
			}
		}

		// Convert response format if there's a mismatch
		if provResp.Status >= 200 && provResp.Status < 300 {
			if inboundFormat == "anthropic" && !targetIsAnthropic {
				// Provider returned OpenAI format, client wants Anthropic
				var openaiResp map[string]any
				if err := json.Unmarshal(responseBodyBytes, &openaiResp); err == nil {
					anthropicResp := convert.OpenAIToAnthropic(openaiResp, originalModel)
					if b, err := json.Marshal(anthropicResp); err == nil {
						responseBodyStr = string(b)
					}
				}
			} else if inboundFormat == "openai" && targetIsAnthropic {
				// Provider returned Anthropic format, client wants OpenAI
				var anthropicResp map[string]any
				if err := json.Unmarshal(responseBodyBytes, &anthropicResp); err == nil {
					openaiResp := convert.AnthropicToOpenAIResponse(anthropicResp, targetModel)
					if b, err := json.Marshal(openaiResp); err == nil {
						responseBodyStr = string(b)
					}
				}
			}
		} else {
			// Error response: convert to the client's expected error format
			if inboundFormat == "openai" {
				responseBodyStr = toOpenAIError(responseBodyStr, provResp.Status, account.Provider)
			} else if !targetIsAnthropic {
				responseBodyStr = toAnthropicError(responseBodyStr, provResp.Status, account.Provider)
			}
		}

		// Guardrails: deanonymize non-streaming response
		if guardrailsActive {
			responseBodyStr = guardrails.Deanonymize(responseBodyStr)
		}

		// Track account status
		if provResp.Status >= 200 && provResp.Status < 300 {
			db.RecordAccountSuccess(account.ID)
			cooldown.Clear(account.ID)
		} else if provResp.Status == 401 {
			db.UpdateAccountStatus(account.ID, "expired", "Authentication failed (401)")
			db.RecordAccountError(account.ID, "Authentication failed (401)")
		} else if provResp.Status == 429 {
			db.UpdateAccountStatus(account.ID, "rate_limited", "Rate limited (429)")
			db.RecordAccountError(account.ID, "Rate limited (429)")
		} else if provResp.Status >= 400 {
			db.RecordAccountError(account.ID, fmt.Sprintf("HTTP %d", provResp.Status))
			db.UpdateAccountStatus(account.ID, "error", fmt.Sprintf("HTTP %d", provResp.Status))
		}

		upstreamContentType := provResp.Headers["content-type"]
		if upstreamContentType == "" {
			upstreamContentType = "application/json"
		}

		w.Header().Set("Content-Type", upstreamContentType)
		w.Header().Set("X-Proxy-Account", account.Name)
		if tenantCtx != nil {
			w.Header().Set("X-Proxy-Tenant", tenantCtx.Name)
		}
		strategyLabel := strategy
		if isFailover {
			strategyLabel = strategy + "+failover"
		}
		w.Header().Set("X-Proxy-Strategy", strategyLabel)
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		w.Header().Set("Access-Control-Expose-Headers", "x-proxy-account, x-proxy-strategy, x-proxy-tenant")
		w.WriteHeader(provResp.Status)
		w.Write([]byte(responseBodyStr))

		// Record usage async
		latencyMs := int(time.Since(startTime).Milliseconds())
		tenantIDForLog2 := ""
		if tenantCtx != nil {
			tenantIDForLog2 = tenantCtx.ID
		}
		go func() {
			costUSD := models.EstimateCost(targetModel, provResp.InputTokens, provResp.OutputTokens)
			db.RecordUsage(account.ID, route.ConfigID, string(tier), originalModel, targetModel,
				provResp.InputTokens, provResp.OutputTokens, provResp.CacheReadTokens, provResp.CacheWriteTokens, costUSD, tenantIDForLog2)

			if getSetting("request_logging") == "true" {
				errMessage := ""
				if provResp.Status >= 400 {
					if len(responseBodyStr) > 1000 {
						errMessage = responseBodyStr[:1000]
					} else {
						errMessage = responseBodyStr
					}
				}
				db.InsertRequestLog(method, path, inboundFormat, account.ID, account.Name, account.Provider,
					originalModel, targetModel, provResp.Status, provResp.InputTokens, provResp.OutputTokens,
					latencyMs, false, isFailover, errMessage, tenantIDForLog2)
			}
		}()

		return
	}

	// All candidates exhausted
	writeError(w, r, inboundFormat, 502, "api_error", "No accounts available after exhausting all candidates")
}

// ─── Error format helpers ───────────────────────────────────────────────────

func toOpenAIError(rawBody string, status int, providerName string) string {
	var parsed map[string]any
	if err := json.Unmarshal([]byte(rawBody), &parsed); err == nil {
		errMsg := extractErrorMessage(parsed, providerName, status)
		b, _ := json.Marshal(map[string]any{
			"error": map[string]any{"message": errMsg, "type": "server_error", "code": status},
		})
		return string(b)
	}
	b, _ := json.Marshal(map[string]any{
		"error": map[string]any{"message": fmt.Sprintf("Provider %s returned HTTP %d", providerName, status), "type": "server_error", "code": status},
	})
	return string(b)
}

func toAnthropicError(rawBody string, status int, providerName string) string {
	var parsed map[string]any
	errType := "api_error"
	switch {
	case status == 401:
		errType = "authentication_error"
	case status == 404:
		errType = "not_found_error"
	case status == 429:
		errType = "rate_limit_error"
	case status >= 500:
		errType = "api_error"
	default:
		errType = "invalid_request_error"
	}

	if err := json.Unmarshal([]byte(rawBody), &parsed); err == nil {
		errMsg := extractErrorMessage(parsed, providerName, status)
		b, _ := json.Marshal(map[string]any{
			"type":  "error",
			"error": map[string]any{"type": errType, "message": errMsg},
		})
		return string(b)
	}
	b, _ := json.Marshal(map[string]any{
		"type":  "error",
		"error": map[string]any{"type": errType, "message": fmt.Sprintf("Provider %s returned HTTP %d", providerName, status)},
	})
	return string(b)
}

func extractErrorMessage(parsed map[string]any, providerName string, status int) string {
	if errObj, ok := parsed["error"].(map[string]any); ok {
		if msg, ok := errObj["message"].(string); ok {
			return msg
		}
	}
	if msg, ok := parsed["message"].(string); ok {
		return msg
	}
	if detail, ok := parsed["detail"].(string); ok {
		return detail
	}
	return fmt.Sprintf("Provider %s returned HTTP %d", providerName, status)
}

// ─── Helpers ───────────────────────────────────────────────────────────────

func deepCopy(m map[string]any) map[string]any {
	b, _ := json.Marshal(m)
	var result map[string]any
	json.Unmarshal(b, &result)
	return result
}

func validateAPIKey(r *http.Request) bool {
	proxyKey := getEnvDefault("PROXY_API_KEY", "")
	if proxyKey == "" {
		return true
	}

	xAPIKey := r.Header.Get("X-Api-Key")
	authHeader := r.Header.Get("Authorization")
	bearerToken := ""
	if strings.HasPrefix(authHeader, "Bearer ") {
		bearerToken = authHeader[7:]
	}

	return xAPIKey == proxyKey || bearerToken == proxyKey
}

func writeError(w http.ResponseWriter, r *http.Request, inboundFormat string, status int, errType, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(status)

	if inboundFormat == "openai" {
		fmt.Fprintf(w, `{"error":{"message":%q,"type":%q,"code":%d}}`, message, errType, status)
	} else {
		fmt.Fprintf(w, `{"type":"error","error":{"type":%q,"message":%q}}`, errType, message)
	}
}

func extractAPIKey(r *http.Request) string {
	if key := r.Header.Get("X-Api-Key"); key != "" {
		return key
	}
	authHeader := r.Header.Get("Authorization")
	if strings.HasPrefix(authHeader, "Bearer ") {
		return authHeader[7:]
	}
	return ""
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "*")

		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}

		next.ServeHTTP(w, r)
	})
}
