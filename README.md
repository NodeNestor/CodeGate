# CodeGate

**One proxy. Every LLM provider. Every coding agent.**

```
                                        ┌─────────────────────────────────────────────┐
 ┌────────────────┐                     │                  CodeGate                    │                     ┌────────────┐
 │                │                     │                                              │                     │            │
 │  Claude Code   │────────────────────>│  :9212  LLM Proxy (Go)                      │────────────────────>│  Anthropic │
 │  Cursor        │                     │    Auto-detect format (Anthropic / OpenAI)   │                     │  OpenAI    │
 │  Windsurf      │────────────────────>│    Route across accounts + providers         │────────────────────>│  DeepSeek  │
 │  Copilot       │                     │    Failover with exponential backoff         │                     │  Gemini    │
 │  Continue       │────────────────────>│    Convert between formats on the fly        │────────────────────>│  GLM       │
 │  Aider         │                     │    Anonymize PII / deanonymize responses     │                     │  Cerebras  │
 │  Any Agent     │<────────────────────│    Capture datasets for fine-tuning          │                     │  OpenRouter│
 │                │                     │                                              │                     │  Minimax   │
 │                │                     │  :9211  Dashboard (Node.js)                  │                     │  Codex     │
 │                │<────────────────────│    Accounts, routing, guardrails, logs, setup │                     │  Custom    │
 └────────────────┘                     └─────────────────────────────────────────────┘                     └────────────┘
```

---

## Why CodeGate?

I have multiple Claude subscriptions (work, personal, different tiers) and even their max usage was not enough. I wanted a single endpoint that could spread requests across all of them, automatically fail over when one gets rate-limited, and let me mix in other providers like OpenAI, DeepSeek, and Gemini without reconfiguring every tool.

**One proxy URL. Every provider. Zero config changes per tool.**

CodeGate sits between your coding agents and the LLM providers, handling routing, failover, format conversion, and privacy transparently.

---

## Features

### Multi-Provider Routing

Connect **11+ providers** through a single endpoint with 4 routing strategies:

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

**Routing strategies:** Priority, Round Robin, Least Used, Budget Aware. Create named configs with tier-based routing (opus / sonnet / haiku), each mapping to specific accounts with optional model remapping.

### Automatic Failover

When a provider returns an error or hits a rate limit, CodeGate automatically tries the next account:

- Cooldown with exponential backoff (15s to 300s)
- Retry-After header parsing
- Auto-switch on error for seamless fallback
- Auto-switch on rate limit to rotate across accounts

### Bidirectional Format Conversion

CodeGate accepts both **Anthropic Messages API** and **OpenAI Chat Completions API** on the same port. It detects the inbound format from the request path and converts to whatever the target provider needs:

- Anthropic tool calls and OpenAI function calls
- System prompts, thinking blocks, multi-turn conversations
- Token usage mapping across formats
- DeepSeek reasoning content
- Image content (base64 and URL)
- Full streaming SSE support with on-the-fly conversion

### Privacy Guardrails

**15 built-in detectors** anonymize sensitive data before it reaches the LLM provider:

| Category | Detectors |
|----------|-----------|
| PII | Email, phone, SSN, names, addresses, passports |
| Financial | Credit cards (Visa/MC/Amex/Discover), IBAN |
| Credentials | API keys (40+ vendor prefixes), AWS keys, JWT, private keys (RSA/DSA/EC/PGP), URL-embedded credentials, passwords |
| Network | IP addresses |

All replacements use **AES-256-CTR deterministic encryption** so the same input always produces the same token. Conversations stay coherent across turns. Responses are automatically deanonymized before reaching your agent.

### Fine-Tune Dataset Generation

Capture request/response pairs as **JSONL datasets** for training custom coding models. This runs passively alongside normal proxy traffic.

- **Last-turn-only mode** -- avoids duplicating 200k-token context windows across every turn
- **Full context mode** -- captures complete conversations
- **Conversation tracking** with turn indices
- **Gzip compression** for storage efficiency
- **Normalized to OpenAI message format** regardless of source

Enable from the dashboard. Export anytime.

### Multi-Tenancy

Share one CodeGate instance across multiple users or teams:

- Per-tenant API keys with `cgk_` prefix
- Isolated rate limits (requests/minute per tenant)
- Per-tenant routing configs
- Settings inheritance -- tenant settings override globals with fallback
- All logs and usage tagged by tenant

### Model Limits

Override per-model token limits and capabilities when providers report them incorrectly:

- Max output tokens
- Tool calling support
- Reasoning/thinking support

### Encryption at Rest

Two independent encryption layers:

- **AES-256-GCM** for API keys and OAuth tokens
- **AES-256-CTR** (deterministic) for guardrail anonymization

Keys auto-generate on first run. Byte-compatible between the Node.js dashboard and Go proxy.

### Web Dashboard

Full management UI on port 9211:

- Add/edit/test provider accounts with OAuth flows
- Create and switch routing configurations
- Manage tenants and per-tenant settings
- Toggle individual guardrails
- View and filter request logs with cost estimation
- Configure fine-tune dataset capture
- Set model limit overrides
- One-click setup snippets for Claude Code, Cursor, Windsurf, and more

---

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/NodeNestor/CodeGate.git
cd CodeGate
docker compose up -d --build
```

**Dashboard:** http://localhost:9211 | **Proxy:** http://localhost:9212

### From Source

```bash
git clone https://github.com/NodeNestor/CodeGate.git
cd CodeGate
npm install && npm run build && npm start
```

---

## Connect Your Tools

Point your tools at the proxy. Both Anthropic and OpenAI formats work on the same port, auto-detected from the request path.

### Claude Code

```bash
claude config set --global apiUrl http://localhost:9212
```

### Cursor / Windsurf / Continue

Set the API base URL in your editor's AI settings:

```
http://localhost:9212/v1
```

### Any OpenAI-compatible client

```bash
export OPENAI_BASE_URL=http://localhost:9212/v1
export OPENAI_API_KEY=your-codegate-key
```

### Any Anthropic client

```bash
export ANTHROPIC_BASE_URL=http://localhost:9212
export ANTHROPIC_API_KEY=your-codegate-key
```

---

## Architecture

CodeGate runs as two processes sharing one SQLite database:

```
Port 9211 -- Dashboard (Node.js)             Port 9212 -- LLM Proxy (Go)
├── React SPA                                 ├── Format detection (Anthropic / OpenAI)
├── REST API                                  ├── Tenant authentication
│   ├── /api/accounts                         ├── Rate limiting (tenant + account)
│   ├── /api/configs                          ├── Guardrail anonymization
│   ├── /api/tenants                          ├── Config-based routing + failover
│   ├── /api/settings                         ├── Format conversion
│   ├── /api/guardrails                       ├── Provider dispatch
│   ├── /api/logs                             ├── SSE stream proxying
│   ├── /api/sessions                         ├── Response format conversion
│   └── /api/setup                            ├── Guardrail deanonymization
└── Setup wizard                              ├── Fine-tune dataset capture
                                              └── Usage logging
                 ┌──────────────────┐
                 │  SQLite (WAL)    │
                 │  codegate.db     │
                 └──────────────────┘
```

No external services required. One database, two processes, zero dependencies beyond what ships in the container.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `UI_PORT` | `9211` | Dashboard and API port |
| `PROXY_PORT` | `9212` | LLM proxy port |
| `DATA_DIR` | `./data` | SQLite database and encryption keys |
| `PROXY_API_KEY` | -- | Global auth key for the proxy |
| `ACCOUNT_KEY` | -- | Encryption key override for credentials |
| `GUARDRAIL_KEY` | -- | Encryption key override for guardrails |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket for terminal sessions |

---

## Development

```bash
# Install dependencies
npm install

# Development mode (hot reload for server + client)
npm run dev

# Production build
npm run build

# Run tests
npm test                    # Node.js tests (Vitest)
cd go && go test ./...      # Go tests

# Type check
npx tsc --noEmit
```

---

## Contributing

Contributions are welcome. Please open an issue first to discuss what you would like to change.

---

## License

[MIT](LICENSE)

---

Built by [NodeNestor](https://github.com/NodeNestor).
