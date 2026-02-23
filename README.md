# CodeGate

**Universal LLM proxy for coding agents.**

Route Claude Code, Copilot, Cursor, Windsurf, and any OpenAI-compatible tool through multiple providers — with automatic failover, bidirectional format conversion, and built-in privacy guardrails.

---

## Why I Built This

I have multiple Claude subscriptions — work, personal, different tiers — and even their max usage wasn't enough. I wanted a single endpoint that could spread my requests across all of them, plus connect other providers like OpenAI, DeepSeek, Gemini, GLM, Cerebras, and even local models. One proxy URL, every provider, zero config changes per tool.

CodeGate is what came out of that. It sits between your coding agents and the LLM providers, handling everything transparently.

---

## Features

### Multi-Provider Routing

Connect **11+ providers** through a single proxy endpoint:

| Provider | Auth | Notes |
|----------|------|-------|
| Anthropic | API Key | Native Messages API |
| OpenAI | API Key | Chat Completions API |
| OpenAI (Subscription) | OAuth | Uses Claude subscription tokens |
| OpenRouter | API Key | Access 100+ models |
| Google Gemini | API Key | Gemini models |
| DeepSeek | API Key | DeepSeek-V3, Coder |
| GLM (Zhipu) | API Key | GLM-4 family |
| Cerebras | API Key | Fast inference |
| Minimax | API Key | MiniMax models |
| Codex | API Key | OpenAI Codex |
| Custom | API Key | Any OpenAI-compatible endpoint |

### Automatic Format Conversion

CodeGate accepts both **Anthropic Messages API** and **OpenAI Chat Completions API** formats on the same port. It detects the inbound format and converts to whatever the target provider needs — including streaming SSE responses.

- Anthropic tool calls ↔ OpenAI function calls
- System prompts, thinking blocks, multi-turn conversations
- Token usage mapping across formats
- Works with both streaming and non-streaming requests

### Routing Configurations

Create named configs with **tier-based routing** (opus / sonnet / haiku). Each tier maps to specific accounts with its own priority ordering.

**4 routing strategies:**

- **Priority** — Always use the highest-priority available account
- **Round Robin** — Distribute evenly across accounts
- **Least Used** — Route to the account with fewest recent requests
- **Budget Aware** — Respect monthly budget limits per account

Switch between configs instantly from the dashboard. One click to go from "personal dev" to "heavy workload" routing.

### Automatic Failover

When a provider returns an error or hits a rate limit, CodeGate automatically tries the next account in the tier. Configurable per-account:

- **Cooldown with exponential backoff** (15s → 300s)
- **Retry-After header** parsing
- **Auto-switch on error** — seamless fallback to backup accounts
- **Auto-switch on rate limit** — rotate when one account is throttled

### Privacy Guardrails

**15 built-in guardrails** that detect and anonymize sensitive data before it reaches the LLM provider. Each guardrail can be independently enabled/disabled from the dashboard.

**PII:**
- Email addresses → realistic fake emails
- Phone numbers → fake formatted numbers
- Social Security Numbers → encrypted tokens
- Street addresses → encrypted tokens
- Passport numbers (context-aware) → encrypted tokens
- Usernames in conversations → consistent pseudonyms

**Financial:**
- Credit card numbers (Visa/MC/Amex/Discover) → type-tagged tokens
- IBAN bank account numbers → encrypted tokens

**Credentials:**
- API keys (OpenAI, Anthropic, AWS, GCP, etc.) → redacted
- AWS access keys and secrets → redacted
- JWT tokens → redacted
- Private keys (RSA/DSA/EC/PGP) → redacted
- URL-embedded credentials → stripped
- Passwords in common patterns → redacted

All replacements use **AES-256-CTR deterministic encryption** — the same input always produces the same token, so conversations stay coherent. Responses are automatically deanonymized back to original values before reaching your agent.

### Encryption

Two independent encryption layers:

- **Account encryption** (AES-256-GCM) — All API keys and OAuth tokens encrypted at rest. Key derived from environment variable, file, or auto-generated on first run.
- **Guardrail encryption** (AES-256-CTR) — Deterministic encryption for privacy replacements. Separate key, separately rotatable.

Both keys can be rotated from the dashboard. The account key re-encrypts all stored credentials during rotation.

### Request Logging

Full request/response logging with:
- Model routing details (original → routed model)
- Token counts (input/output)
- Latency tracking
- Failover history
- Configurable retention (7–90 days)
- Body capture (opt-in for debugging)

### Model Limits

Override per-model capabilities when providers report them incorrectly:
- Max output tokens
- Tool calling support
- Reasoning/thinking support

### Web Dashboard

Full management UI on port 9211:
- Add/edit/test accounts
- Create and switch routing configs
- Toggle guardrails individually
- View request logs with filtering
- Rotate encryption keys
- One-click setup snippets for Claude Code, Cursor, Windsurf, etc.

---

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/NodeNestor/codegate.git
cd codegate
docker compose up -d --build
```

Dashboard at `http://localhost:9211`, proxy at `http://localhost:9212`.

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
npm install
npm run build
npm start
```

For development with hot reload:

```bash
npm run dev
```

---

## Connect Your Tools

Once CodeGate is running, point your tools at the proxy port:

### Claude Code

```bash
# Automatic (from the dashboard Setup page):
# Click "Auto Configure" for Claude Code

# Manual:
claude config set --global apiUrl http://localhost:9212
```

### Cursor / Windsurf / Continue

Set the API base URL to `http://localhost:9212/v1` in your editor's AI settings.

### Any OpenAI-compatible client

```bash
export OPENAI_API_BASE=http://localhost:9212/v1
export OPENAI_API_KEY=your-proxy-key
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `UI_PORT` | `9211` | Dashboard and API port |
| `PROXY_PORT` | `9212` | LLM proxy port |
| `DATA_DIR` | `./data` | SQLite database location |
| `PROXY_API_KEY` | — | Optional auth key for the proxy endpoint |
| `ACCOUNT_KEY` | — | Encryption key for stored credentials (auto-generated if not set) |
| `GUARDRAIL_KEY` | — | Encryption key for privacy guardrails (auto-generated if not set) |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket for OAuth session management |

---

## Architecture

```
┌─────────────────┐     ┌──────────────────────────────────────┐
│  Claude Code     │────▶│                                      │
│  Cursor          │     │            CodeGate                  │
│  Windsurf        │────▶│                                      │
│  Any Agent       │     │  Port 9212 (Proxy)                   │
└─────────────────┘     │  ├─ Format detection (Anthropic/OAI) │
                        │  ├─ Guardrail anonymization           │
                        │  ├─ Config-based routing              │
                        │  ├─ Failover + cooldown               │
                        │  ├─ Format conversion                 │
                        │  ├─ Stream proxying (SSE)             │
                        │  └─ Guardrail deanonymization         │
                        │                                      │
                        │  Port 9211 (Dashboard)                │
                        │  ├─ Account management                │
                        │  ├─ Config editor                     │
                        │  ├─ Guardrail toggles                 │
                        │  ├─ Request logs                      │
                        │  └─ Setup wizard                      │
                        └──────────┬───────────────────────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
              ┌──────────┐  ┌──────────┐  ┌──────────┐
              │ Anthropic │  │  OpenAI  │  │ DeepSeek │  ...
              └──────────┘  └──────────┘  └──────────┘
```

**Stack:** Hono + Node.js server, React + Tailwind dashboard, SQLite (WAL mode) for storage. 5 production dependencies. Single binary, no external services required.

---

## Roadmap

- [ ] Multi-tenant mode with per-user API keys and usage tracking
- [ ] Horizontal scaling with shared state
- [ ] Plugin system for custom guardrails
- [ ] Usage analytics and cost dashboards
- [ ] Webhook notifications for errors and budget alerts

---

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

```bash
# Run tests
npm test

# Dev mode (hot reload)
npm run dev

# Type check
npx tsc --noEmit
```

---

## License

[MIT](LICENSE)

---

## Author

Built by [NodeNestor](https://github.com/NodeNestor).