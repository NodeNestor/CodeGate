# CodeGate

**Universal LLM proxy for coding agents.**

Route Claude Code, Copilot, Cursor, Windsurf, and any OpenAI-compatible tool through multiple providers — with automatic failover, bidirectional format conversion, and built-in privacy guardrails.

```
┌──────────────────┐         ┌────────────────────────────────────────┐         ┌───────────┐
│  Claude Code     │────────▶│                CodeGate                │────────▶│ Anthropic │
│  Cursor          │         │                                        │         │ OpenAI    │
│  Windsurf        │────────▶│  :9212 Proxy                           │────────▶│ DeepSeek  │
│  Copilot         │         │    Auto-detect format (Anthropic/OAI)  │         │ Gemini    │
│  Any Agent       │────────▶│    Anonymize PII → route → convert     │────────▶│ GLM       │
│                  │         │    Failover → deanonymize → respond    │         │ Cerebras  │
│                  │         │                                        │         │ OpenRouter│
│                  │◀────────│  :9211 Dashboard                       │         │ MiniMax   │
│                  │         │    Accounts, routing, guardrails, logs  │         │ Custom    │
└──────────────────┘         └────────────────────────────────────────┘         └───────────┘
```

---

## Why CodeGate?

I have multiple Claude subscriptions — work, personal, different tiers — and even their max usage wasn't enough. I wanted a single endpoint that could spread my requests across all of them, plus connect other providers like OpenAI, DeepSeek, Gemini, GLM, Cerebras, and even local models.

**One proxy URL. Every provider. Zero config changes per tool.**

CodeGate sits between your coding agents and the LLM providers, handling everything transparently.

---

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/NodeNestor/codegate.git
cd codegate
docker compose up -d --build
```

Dashboard: **http://localhost:9211** | Proxy: **http://localhost:9212**

#### Enable the Go proxy (faster, recommended for production)

```bash
USE_GO_PROXY=true docker compose up -d --build
```

Same functionality, higher throughput. Node.js serves the dashboard, Go handles all proxy traffic.

### npm

```bash
npm install -g codegate
codegate
```

Or run directly:

```bash
npx codegate
```

### From Source

```bash
git clone https://github.com/NodeNestor/codegate.git
cd codegate
npm install && npm run build && npm start
```

For development with hot reload:

```bash
npm run dev
```

---

## Connect Your Tools

Point your tools at the proxy port. That's it.

### Claude Code

```bash
# Auto-configure from the dashboard Setup page, or:
claude config set --global apiUrl http://localhost:9212
```

### Cursor / Windsurf / Continue

Set the API base URL to `http://localhost:9212/v1` in your editor's AI settings.

### Any OpenAI-compatible client

```bash
export OPENAI_BASE_URL=http://localhost:9212/v1
export OPENAI_API_KEY=your-codegate-key    # from the dashboard
```

### Any Anthropic client

```bash
export ANTHROPIC_BASE_URL=http://localhost:9212
export ANTHROPIC_API_KEY=your-codegate-key
```

Both formats work on the same port — CodeGate auto-detects from the request path.

---

## Features

### Multi-Provider Routing

Connect **11+ providers** through a single endpoint:

| Provider | Auth | Notes |
|----------|------|-------|
| Anthropic | API Key / OAuth | Native Messages API |
| OpenAI | API Key / OAuth | Chat Completions API |
| OpenAI (Subscription) | OAuth | Codex subscription tokens |
| OpenRouter | API Key | Access 100+ models |
| Google Gemini | API Key | Gemini models |
| DeepSeek | API Key | DeepSeek-V3, R1, Coder |
| GLM (Zhipu) | API Key | GLM-4 family |
| Cerebras | API Key | Fast inference |
| Minimax | API Key | MiniMax models |
| Codex | API Key | OpenAI Codex |
| Custom | API Key | Any OpenAI-compatible endpoint |

### Automatic Format Conversion

CodeGate accepts both **Anthropic Messages API** and **OpenAI Chat Completions API** on the same port. It detects the inbound format and converts to whatever the target provider needs — including streaming SSE.

- Anthropic tool calls <-> OpenAI function calls
- System prompts, thinking blocks, multi-turn conversations
- Token usage mapping across formats
- DeepSeek reasoning content support
- Image content (base64 and URL)
- Works with both streaming and non-streaming requests

### Routing Configurations

Create named configs with **tier-based routing** (opus / sonnet / haiku). Each tier maps to specific accounts with its own priority ordering and optional model remapping.

**4 routing strategies:**

- **Priority** — Always use the highest-priority available account
- **Round Robin** — Distribute evenly across accounts
- **Least Used** — Route to the account with fewest recent requests
- **Budget Aware** — Respect monthly budget limits per account

Switch configs instantly from the dashboard.

### Automatic Failover

When a provider returns an error or hits a rate limit, CodeGate automatically tries the next account in the tier:

- **Cooldown with exponential backoff** (15s -> 300s)
- **Retry-After header** parsing
- **Auto-switch on error** — seamless fallback to backup accounts
- **Auto-switch on rate limit** — rotate when one account is throttled

### Multi-Tenancy

Share one CodeGate instance across multiple users or teams:

- **Per-tenant API keys** — Each tenant gets a unique `cgk_` prefixed key
- **Isolated rate limits** — Set requests/minute per tenant
- **Per-tenant routing** — Assign different configs to different tenants
- **Settings inheritance** — Tenant settings override globals, with fallback
- **Usage tracking** — All logs and usage tagged by tenant

Toggle multi-tenancy on/off from the dashboard. In simple mode, one API key protects the whole proxy.

### Privacy Guardrails

**15 built-in guardrails** detect and anonymize sensitive data before it reaches the LLM provider. Each can be independently enabled/disabled.

**PII:** Email, phone numbers, SSN, street addresses, passport numbers, usernames

**Financial:** Credit card numbers (Visa/MC/Amex/Discover), IBAN numbers

**Credentials:** API keys (40+ vendor prefixes + entropy), AWS keys, JWT tokens, private keys (RSA/DSA/EC/PGP), URL-embedded credentials, passwords

All replacements use **AES-256-CTR deterministic encryption** — the same input always produces the same token, so conversations stay coherent. Responses are automatically deanonymized before reaching your agent.

### Encryption

Two independent layers:

- **Account encryption** (AES-256-GCM) — API keys and OAuth tokens encrypted at rest
- **Guardrail encryption** (AES-256-CTR) — Deterministic encryption for privacy replacements

Both keys auto-generate on first run and can be rotated from the dashboard. Byte-compatible between Node.js and Go.

### Request Logging

Full request/response logging with:
- Model routing details (original -> routed model, account used)
- Token counts (input/output/cache)
- Latency tracking
- Failover history
- Cost estimation
- Configurable retention (7-90 days)
- Optional body capture for debugging
- Tenant-scoped filtering

### Fine-Tune Export

Export logged conversations as JSONL datasets for fine-tuning:
- Conversation tracking with turn indices
- Last-turn-only mode (reduces duplication)
- Optional full context mode
- Gzip compression
- Normalized to OpenAI message format

### Model Limits

Override per-model capabilities when providers report them incorrectly:
- Max output tokens
- Tool calling support
- Reasoning/thinking support

### Web Dashboard

Full management UI on port 9211:

- Add/edit/test provider accounts (with OAuth flows)
- Create and switch routing configs
- Manage tenants and per-tenant settings
- Toggle guardrails individually
- View and filter request logs
- Rotate encryption keys
- Set model limits
- One-click setup snippets for Claude Code, Cursor, Windsurf, etc.

### Go Proxy (Optional)

CodeGate ships with a high-performance Go proxy as a drop-in replacement for the Node.js proxy. Same features, same database, same API — just faster.

```bash
# Enable with one env var
USE_GO_PROXY=true docker compose up -d
```

Node.js continues serving the dashboard on 9211. The Go binary handles all proxy traffic on 9212.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `UI_PORT` | `9211` | Dashboard and API port |
| `PROXY_PORT` | `9212` | LLM proxy port |
| `DATA_DIR` | `./data` | SQLite database and encryption keys |
| `PROXY_API_KEY` | — | Global auth key for the proxy |
| `USE_GO_PROXY` | `false` | Use Go binary for proxy (recommended) |
| `ACCOUNT_KEY` | — | Encryption key for credentials (auto-generated) |
| `GUARDRAIL_KEY` | — | Encryption key for guardrails (auto-generated) |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket for terminal sessions |

---

## Architecture

**Stack:** Node.js + Hono (dashboard/API), Go (proxy), React + Tailwind (frontend), SQLite (storage).

```
Port 9211 (Dashboard — Node.js)          Port 9212 (Proxy — Go or Node.js)
├── REST API                              ├── Format detection (Anthropic/OpenAI)
│   ├── /api/accounts                     ├── Tenant authentication
│   ├── /api/configs                      ├── Rate limiting (tenant + account)
│   ├── /api/tenants                      ├── Guardrail anonymization
│   ├── /api/settings                     ├── Config-based routing + failover
│   ├── /api/guardrails                   ├── Format conversion
│   ├── /api/logs                         ├── Provider dispatch
│   └── /api/sessions                     ├── Stream proxying (SSE)
└── React SPA                             ├── Response format conversion
    ├── Account management                ├── Guardrail deanonymization
    ├── Config editor                     └── Usage logging
    ├── Tenant management
    ├── Guardrail toggles
    ├── Request log viewer
    └── Setup wizard
```

Both processes share one SQLite database. No external services required.

---

## Development

```bash
# Install dependencies
npm install

# Development mode (hot reload for both server and client)
npm run dev

# Build for production
npm run build

# Run tests
npm test                                # Node.js (Vitest)
cd go && go test ./...                  # Go

# Type check
npx tsc --noEmit

# Build Go proxy locally
cd go && CGO_ENABLED=1 go build -o codegate-proxy ./cmd/codegate-proxy
```

---

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

---

## License

[MIT](LICENSE)

---

Built by [NodeNestor](https://github.com/NodeNestor).
