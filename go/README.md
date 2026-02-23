# CodeGate Go Proxy

High-performance Go replacement for the Node.js proxy handler (port 9212).

## Architecture

```
Coding Agents (Claude Code, Cursor, etc.)
      |
  [Go binary :9212]  <-- hot path, streaming, routing, failover
      | reads/writes
  [SQLite DB ./data/codegate.db]  <-- shared state
      ^ writes
  [Node.js :9211]  <-- dashboard UI, config CRUD, sessions
```

The Go proxy reads accounts, configs, and settings from the same SQLite database
that the Node.js dashboard manages. Both processes can run simultaneously.

## Building

```bash
cd go
go build -o ../bin/codegate-proxy ./cmd/codegate-proxy/
```

Or using Make:

```bash
cd go
make build
```

## Running

1. Start the Node.js dashboard (handles UI on port 9211):
   ```bash
   npm run dev  # or: node dist/server/index.js
   ```

2. Start the Go proxy (handles LLM requests on port 9212):
   ```bash
   cd go
   make run
   ```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | `9212` | Port for the LLM proxy |
| `DATA_DIR` | `./data` | Path to the SQLite database directory |
| `PROXY_API_KEY` | (empty) | Optional API key for proxy authentication |

## What's Implemented

- [x] Health check endpoint (`/health`)
- [x] Models endpoint (`/v1/models`)
- [x] Anthropic Messages API proxy (`/v1/messages`)
- [x] OpenAI Chat Completions proxy (`/v1/chat/completions`)
- [x] SQLite database access (shared with Node.js)
- [x] Account decryption (AES-256-GCM)
- [x] Config-based routing with tier detection
- [x] Routing strategies (priority, round-robin, least-used, budget-aware)
- [x] Sliding-window rate limiting
- [x] Exponential backoff cooldown
- [x] Multi-account failover
- [x] SSE streaming passthrough with token extraction
- [x] Provider dispatch (Anthropic, OpenAI, OpenRouter, custom)
- [x] Async usage recording
- [x] Request logging
- [x] Format conversion (Anthropic <-> OpenAI, both directions)
- [x] Stream format conversion (Anthropic SSE <-> OpenAI SSE)
- [x] Guardrails pipeline (anonymize/deanonymize)
- [x] 12 pattern-based guardrails (email, phone, SSN, credit card, etc.)
- [x] API key detection (40+ vendor prefixes + entropy analysis)
- [x] Password detection (key-value, URL, connection string)
- [x] Deterministic AES-256-CTR encryption for guardrails
- [x] SSE stream deanonymization

## TODO (next phases)

- [ ] Name guardrail (full dictionary port)
- [ ] OAuth token refresh
- [ ] Model limits / max_tokens clamping
