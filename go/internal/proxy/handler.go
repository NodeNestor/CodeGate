package proxy

import (
	"codegate-proxy/internal/cooldown"
	"codegate-proxy/internal/db"
	"codegate-proxy/internal/models"
	"codegate-proxy/internal/provider"
	"codegate-proxy/internal/ratelimit"
	"codegate-proxy/internal/routing"
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

	// Validate proxy API key
	if !validateAPIKey(r) {
		writeError(w, r, "anthropic", 401, "authentication_error", "Invalid or missing proxy API key")
		return
	}

	// Detect inbound format
	inboundFormat := "anthropic"
	if strings.Contains(path, "/chat/completions") {
		inboundFormat = "openai"
	}

	// Read request body
	bodyBytes, err := io.ReadAll(r.Body)
	r.Body.Close()
	if err != nil {
		writeError(w, r, inboundFormat, 400, "invalid_request_error", "Failed to read request body")
		return
	}

	// Parse body JSON
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

	_ = isStreamRequest // used for logging later

	// Detect tier
	tier := models.DetectTier(originalModel)

	// Resolve route
	route, err := routing.Resolve(originalModel)
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

	autoSwitchOnError := db.GetSetting("auto_switch_on_error") != "false"
	autoSwitchOnRateLimit := db.GetSetting("auto_switch_on_rate_limit") != "false"

	// Collect request headers
	reqHeaders := make(map[string]string)
	for k := range r.Header {
		reqHeaders[strings.ToLower(k)] = r.Header.Get(k)
	}

	// Try each candidate
	for i, cand := range allCandidates {
		account := cand.Account
		targetModel := cand.TargetModel
		if targetModel == "" {
			targetModel = originalModel
		}
		isFailover := i > 0
		isLastCandidate := i == len(allCandidates)-1

		targetIsAnthropic := account.Provider == "anthropic"

		// Skip cooled-down accounts
		if !isLastCandidate && cooldown.IsOnCooldown(account.ID) {
			log.Printf("[proxy] Skipping %q (on cooldown), %d candidates left", account.Name, len(allCandidates)-i-1)
			continue
		}

		// Rate limit check
		if ratelimit.CheckAndRecord(account.ID, account.RateLimit) {
			if !isLastCandidate {
				log.Printf("[proxy] Skipping %q (rate limited), %d candidates left", account.Name, len(allCandidates)-i-1)
				continue
			}
			writeError(w, r, inboundFormat, 429, "rate_limit_error",
				fmt.Sprintf("Rate limit exceeded for account %q (%d req/min)", account.Name, account.RateLimit))
			return
		}

		// Determine forward path and body based on format conversion needs
		var forwardPath string
		var forwardBody string

		if inboundFormat == "openai" && !targetIsAnthropic {
			// OpenAI → OpenAI: forward as-is with model swap
			bodyJSON["model"] = targetModel
			b, _ := json.Marshal(bodyJSON)
			forwardBody = string(b)
			forwardPath = "/v1/chat/completions"
		} else if inboundFormat == "openai" && targetIsAnthropic {
			// OpenAI → Anthropic: TODO format conversion (for now, basic pass-through)
			bodyJSON["model"] = targetModel
			b, _ := json.Marshal(bodyJSON)
			forwardBody = string(b)
			forwardPath = "/v1/chat/completions" // Will need conversion
		} else if inboundFormat == "anthropic" && !targetIsAnthropic {
			// Anthropic → OpenAI: TODO format conversion (for now, basic pass-through)
			bodyJSON["model"] = targetModel
			b, _ := json.Marshal(bodyJSON)
			forwardBody = string(b)
			forwardPath = "/v1/chat/completions"
		} else {
			// Anthropic → Anthropic: forward as-is with model swap
			bodyJSON["model"] = targetModel
			b, _ := json.Marshal(bodyJSON)
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

		// Check for retryable errors
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

		// Success tracking
		if provResp.Status >= 200 && provResp.Status < 300 {
			db.RecordAccountSuccess(account.ID)
			cooldown.Clear(account.ID)
		}

		// Write response headers
		if provResp.IsStream {
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("Connection", "keep-alive")
		} else {
			ct := provResp.Headers["content-type"]
			if ct == "" {
				ct = "application/json"
			}
			w.Header().Set("Content-Type", ct)
		}

		w.Header().Set("X-Proxy-Account", account.Name)
		strategyLabel := strategy
		if isFailover {
			strategyLabel = strategy + "+failover"
		}
		w.Header().Set("X-Proxy-Strategy", strategyLabel)
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		w.Header().Set("Access-Control-Expose-Headers", "x-proxy-account, x-proxy-strategy")

		w.WriteHeader(provResp.Status)

		// Stream/copy response body
		if provResp.IsStream {
			// Use flusher for SSE
			flusher, ok := w.(http.Flusher)
			buf := make([]byte, 32*1024)
			for {
				n, readErr := provResp.Body.Read(buf)
				if n > 0 {
					w.Write(buf[:n])
					if ok {
						flusher.Flush()
					}
				}
				if readErr != nil {
					break
				}
			}
		} else {
			io.Copy(w, provResp.Body)
		}
		provResp.Body.Close()

		// Record usage asynchronously
		latencyMs := int(time.Since(startTime).Milliseconds())
		go func() {
			costUSD := models.EstimateCost(targetModel, provResp.InputTokens, provResp.OutputTokens)
			db.RecordUsage(account.ID, route.ConfigID, string(tier), originalModel, targetModel,
				provResp.InputTokens, provResp.OutputTokens, provResp.CacheReadTokens, provResp.CacheWriteTokens, costUSD)

			if db.GetSetting("request_logging") == "true" {
				db.InsertRequestLog(method, path, inboundFormat, account.ID, account.Name, account.Provider,
					originalModel, targetModel, provResp.Status, provResp.InputTokens, provResp.OutputTokens,
					latencyMs, provResp.IsStream, isFailover, "")
			}
		}()

		return
	}

	// All candidates exhausted
	writeError(w, r, inboundFormat, 502, "api_error", "No accounts available after exhausting all candidates")
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
