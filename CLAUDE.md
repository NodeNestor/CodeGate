# CLAUDE.md — CodeGate Developer Guide

## What is CodeGate?

CodeGate is a universal LLM proxy. It sits between coding agents (Claude Code, Cursor, Copilot, etc.) and LLM providers (Anthropic, OpenAI, DeepSeek, etc.), handling routing, failover, format conversion, and privacy — all through a single endpoint.

**Two ports:**
- `9211` — Web dashboard + REST API (Node.js, Hono)
- `9212` — LLM proxy (Go binary)

**One database:** SQLite in WAL mode, shared between Go and Node.js processes.

---

## Quick Commands

```bash
# Development (hot reload)
npm run dev

# Build everything
npm run build

# Run tests
npm test                    # Node.js tests (Vitest)
export PATH="/c/Program Files/Go/bin:$PATH"  # Windows
cd go && go test ./...      # Go tests

# Type check
npx tsc --noEmit

# Docker
docker compose up -d --build
docker compose build proxy && docker compose up -d --no-deps proxy
```

---

## Project Structure

```
codeGate/
├── go/                        # Go proxy (port 9212)
│   ├── cmd/codegate-proxy/    # Entry point (main.go)
│   └── internal/
│       ├── auth/              # OAuth token refresh
│       ├── convert/           # Anthropic <-> OpenAI format conversion
│       ├── cooldown/          # Exponential backoff (15s -> 300s)
│       ├── db/                # SQLite queries + encryption
│       ├── guardrails/        # PII detection & anonymization
│       ├── limits/            # Per-model token limits
│       ├── models/            # Tier detection + cost estimation
│       ├── provider/          # Anthropic, OpenAI, dispatch
│       ├── proxy/             # HTTP handler (the core)
│       ├── ratelimit/         # Sliding-window rate limiting
│       ├── routing/           # Config-based routing (4 strategies)
│       └── tenant/            # Multi-tenant key resolution
├── src/
│   ├── server/                # Node.js dashboard API (port 9211)
│   │   ├── index.ts           # Hono app, dashboard server
│   │   ├── db.ts              # SQLite init, all queries
│   │   ├── encryption.ts      # AES-256-GCM (accounts) + AES-256-CTR (guardrails)
│   │   ├── config-manager.ts  # Routing config CRUD + resolution
│   │   ├── model-mapper.ts    # Model name resolution
│   │   ├── model-limits.ts    # Per-model token limits
│   │   ├── model-fetcher.ts   # Model list fetching
│   │   ├── rate-limiter.ts    # Rate limiting logic
│   │   ├── session-manager.ts # Docker terminal sessions (ttyd)
│   │   ├── finetune.ts        # JSONL export for fine-tuning datasets
│   │   ├── guardrails/        # Manager, registry, builtins, patterns, types, shared, names-data
│   │   ├── routes/            # accounts, configs, settings, sessions, setup, privacy, logs, tenants
│   │   └── __tests__/         # model-mapper, rate-limiter, multi-tenant tests
│   └── client/                # React 18 + Tailwind dashboard
│       ├── App.tsx            # Router with sidebar nav
│       ├── pages/             # Accounts, Configs, Tenants, Guardrails, Logs, Settings, Setup
│       ├── components/        # AccountCard, ConfigEditor, ConnectAccountWizard, etc.
│       └── lib/api.ts         # 60+ typed API functions
├── Dockerfile                 # Multi-stage: Node.js build + Go build
├── Dockerfile.session         # ttyd terminal session image
├── docker-compose.yml         # Proxy + session-image services
├── start.sh                   # Startup script: Node.js (9211) + Go (9212)
├── package.json               # npm scripts, dependencies
├── vite.config.ts             # Frontend build config
└── vitest.config.ts           # Test config
```

---

## Architecture at a Glance

```
Request flow (Go proxy, port 9212):

  Client request
      │
      ├─ Extract API key → resolve tenant (if multi-tenant)
      ├─ Tenant rate limit check
      ├─ Detect format (OpenAI or Anthropic, from URL path)
      ├─ Parse body, extract model
      ├─ Convert to Anthropic internal format (if OpenAI inbound)
      ├─ Guardrails: anonymize PII/secrets in request
      ├─ Clamp max_tokens to model limits
      ├─ Detect tier (opus/sonnet/haiku)
      ├─ Resolve route → primary account + fallbacks
      │
      └─ For each candidate account:
           ├─ Skip if on cooldown (unless last)
           ├─ Rate limit check
           ├─ Convert body to provider's format
           ├─ OAuth token refresh if needed
           ├─ Forward to provider
           ├─ On 429/5xx: cooldown + try next (if auto-switch on)
           └─ On success:
                ├─ Convert response back to client's format
                ├─ Guardrails: deanonymize response
                ├─ Record usage + log (async)
                └─ Return to client
```

---

## Database

**SQLite** at `DATA_DIR/codegate.db` (default: `./data/codegate.db`). WAL mode for concurrent reads.

**11 tables:** `accounts`, `configs`, `config_tiers`, `usage`, `settings`, `privacy_mappings`, `request_logs`, `sessions`, `tenants`, `tenant_settings`, `model_limits`

Key queries live in:
- Node.js: `src/server/db.ts` (all in one file)
- Go: `go/internal/db/db.go` (read-only main conn, separate write conns)

---

## Encryption

Two independent keys, both stored as hex-encoded 32-byte files in `DATA_DIR/`:

| Key | File | Algorithm | Purpose |
|-----|------|-----------|---------|
| Account key | `.account-key` | AES-256-GCM | API keys, OAuth tokens |
| Guardrail key | `.guardrail-key` | AES-256-CTR (deterministic) | PII anonymization |

The Go proxy reads `.account-key` (falls back to `.master-key` for legacy). Both Node.js and Go produce byte-compatible encrypted output.

**Encrypted value format:** `base64(iv[16] + ciphertext + authTag[16])`

Environment overrides: `ACCOUNT_KEY`, `GUARDRAIL_KEY` (derived via scrypt if set).

---

## Providers

All providers are dispatched through the Go proxy. Format conversion happens automatically.

| Provider | Go package | Auth |
|----------|-----------|------|
| Anthropic | `provider/anthropic.go` | API key or OAuth |
| OpenAI | `provider/openai.go` | API key or OAuth |
| OpenRouter | `provider/openai.go` (OpenAI-compat) | API key |
| GLM, Cerebras, DeepSeek, Gemini, Minimax | `provider/openai.go` (OpenAI-compat) | API key |
| Codex (subscription) | `provider/openai.go` (OpenAI-compat) | OAuth |
| Custom | `provider/openai.go` (OpenAI-compat) | API key |

**Format conversion matrix** (Go: `internal/convert/`):
- OpenAI client -> OpenAI provider: forward as-is, swap model
- OpenAI client -> Anthropic provider: convert request + convert response back
- Anthropic client -> OpenAI provider: convert request + convert response back
- Anthropic client -> Anthropic provider: forward as-is

SSE streams are converted on-the-fly with proper event sequencing.

---

## Multi-Tenancy

Toggle: `multi_tenancy` setting (true/false). When enabled:

- Each tenant gets a unique API key (`cgk_` prefix)
- Keys are hashed (SHA-256) for lookup, stored encrypted
- Tenants can have their own: routing config, rate limit, settings overrides
- Settings cascade: tenant setting -> global setting

Tenant resolution: `go/internal/tenant/`

---

## Routing Strategies

Defined in `configs` + `config_tiers` tables. Four strategies:

1. **priority** — Highest priority account first
2. **round-robin** — Rotate through accounts
3. **least-used** — Route to least-spent account this month
4. **budget-aware** — Route to account with most remaining budget

Resolution: `go/internal/routing/`

Each config has 3 tiers (opus/sonnet/haiku) with account assignments and optional model remapping (`target_model` field).

---

## Guardrails (15 Built-in)

Located in `go/internal/guardrails/` (proxy-side) and `src/server/guardrails/` (dashboard-side config).

**Categories:** email, phone, ssn, credit_card, iban, ip, api_key, aws_key, jwt, private_key, url_credentials, password, name, address, passport

All use deterministic AES-256-CTR encryption so the same input always produces the same anonymized token. Responses are deanonymized before returning to the client. Works with both streaming and non-streaming.

---

## Fine-Tune Dataset Generation

The `src/server/finetune.ts` module captures request/response conversation pairs as JSONL for fine-tuning.

- **Last-turn-only mode** (default): stores system prompt + last user message + assistant response per entry. Avoids massive duplication since coding sessions repeat full 200k context.
- **Full context mode**: set `finetune_full_context=true` to store the complete conversation history.
- **Conversation tracking**: entries include `conversation_id` and `turn_index` for ordering.
- **Gzip compression**: export supports compressed output.
- **Toggle**: enable via `finetune_logging` setting in dashboard.

Output format: `data/finetune-export.jsonl`

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `UI_PORT` | `9211` | Dashboard port |
| `PROXY_PORT` | `9212` | Proxy port |
| `DATA_DIR` | `./data` | Database + key files |
| `PROXY_API_KEY` | — | Global auth key (simple mode) |
| `ACCOUNT_KEY` | — | Override account encryption key |
| `GUARDRAIL_KEY` | — | Override guardrail encryption key |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | For terminal sessions |
| `SESSION_NETWORK` | — | Docker network for sessions |

---

## API Endpoints (port 9211)

| Endpoint | Description |
|----------|-------------|
| `GET/POST/PUT/DELETE /api/accounts` | Account CRUD |
| `GET/POST/PUT/DELETE /api/configs` | Routing config CRUD |
| `GET/PUT /api/settings` | Global settings |
| `GET/POST/PUT/DELETE /api/tenants` | Tenant management |
| `GET/PUT /api/privacy` | Guardrail status + toggle |
| `GET/PUT /api/guardrails` | Individual guardrail control |
| `GET/DELETE /api/logs` | Request log viewer |
| `GET/POST/DELETE /api/sessions` | Docker terminal sessions |
| `GET /api/setup/*` | Setup snippets for tools |

---

## Common Tasks

### Add a new provider
1. If OpenAI-compatible: add the provider name to the switch in `go/internal/provider/dispatch.go`
2. If custom protocol: create a new `Forward*()` function in `go/internal/provider/`

### Add a new guardrail
1. Create pattern in `go/internal/guardrails/builtin.go`
2. Register it in the guardrails manager/registry
3. Add a DB migration if it needs a new settings key

### Add a new API endpoint
1. Create route file in `src/server/routes/`
2. Mount it in `src/server/index.ts`
3. Add API functions in `src/client/lib/api.ts`
4. Create/update page in `src/client/pages/`

### Add a new database table
1. Add `CREATE TABLE IF NOT EXISTS` in `src/server/db.ts` `initDB()`
2. Add matching queries in `go/internal/db/db.go` if Go needs access
3. Both read from the same SQLite file

---

## Testing

```bash
# Node.js (Vitest)
npm test

# Go
cd go && go test ./...
```

**Test suites:**
- `src/server/__tests__/model-mapper.test.ts`
- `src/server/__tests__/rate-limiter.test.ts`
- `src/server/__tests__/multi-tenant.test.ts`
- `go/internal/*/` (tests alongside implementation)

---

## Docker

```bash
# Build everything (Node.js + Go)
docker compose build

# Run
docker compose up -d

# View logs
docker compose logs -f proxy

# Rebuild and redeploy
docker compose build proxy && docker compose up -d --no-deps proxy
```

The `start.sh` script handles dual-process orchestration: Node.js serves the dashboard on 9211, the Go binary serves the proxy on 9212.

---

## Gotchas

- **Windows line endings:** `start.sh` must have LF endings. The Dockerfile runs `sed -i 's/\r$//'` to handle this automatically.
- **Go encryption compat:** Go reads the Node.js `.account-key` file and supports both base64 (Node.js) and hex-colon (legacy Go) encrypted value formats.
- **SQLite WAL:** Go opens the DB read-only for queries; writes use separate short-lived connections. Don't hold write locks.
- **Guardrail determinism:** AES-256-CTR with fixed IVs derived from content. Same input = same output. This is intentional for conversation coherence.
- **OAuth tokens:** Stored encrypted in the DB. Background refresh loop runs every 15 minutes in the Go proxy. Also syncs from Claude credential files on disk.
