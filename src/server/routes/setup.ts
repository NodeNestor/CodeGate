import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { getSetting, getTenants } from "../db.js";

const setup = new Hono();

const HOST_CLAUDE_RW = process.env.HOST_CLAUDE_RW || "/host-claude-rw";

function getProxyUrl(): string {
  return `http://localhost:${process.env.PROXY_PORT || "9212"}`;
}

// Key placeholder used in snippet templates — replaced client-side
const K = "{{API_KEY}}";

setup.get("/", (c) => {
  const proxyUrl = getProxyUrl();

  // Tenant info for the frontend selector
  const tenants = getTenants().map((t: any) => ({
    id: t.id,
    name: t.name,
    api_key_prefix: t.api_key_prefix,
    api_key: t.api_key_raw || null,
  }));
  const defaultTenantId = getSetting("default_tenant_id") || null;
  const defaultTenantKey = getSetting("proxy_api_key") || "";

  // Check if Claude Code is already configured
  let claudeConfigured = false;
  try {
    const settingsPath = path.join(HOST_CLAUDE_RW, "settings.json");
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw);
    const baseUrl = settings?.env?.ANTHROPIC_BASE_URL;
    if (typeof baseUrl === "string" && (baseUrl.includes("9212") || baseUrl.includes("9211"))) {
      claudeConfigured = true;
    }
  } catch {
    // Not configured
  }

  // Snippets use {{API_KEY}} placeholder — replaced client-side with selected tenant key
  const tools = {
    "claude-code": {
      name: "Claude Code",
      description: "Anthropic's official CLI for Claude",
      autoSetup: true,
      configured: claudeConfigured,
      snippet: `# Add to your shell profile (.bashrc, .zshrc, etc.)\nexport ANTHROPIC_BASE_URL="${proxyUrl}"\nexport ANTHROPIC_API_KEY="${K}"`,
      docs: "https://docs.anthropic.com/en/docs/claude-code",
    },
    "codex-cli": {
      name: "Codex CLI",
      description: "OpenAI's CLI coding agent",
      autoSetup: false,
      snippet: `# ~/.codex/config.toml\n[provider]\nname = "openai-compatible"\nbase_url = "${proxyUrl}/v1"\napi_key = "${K}"`,
      docs: "https://github.com/openai/codex",
    },
    opencode: {
      name: "OpenCode",
      description: "Open-source AI coding assistant",
      autoSetup: false,
      snippet: `// opencode.json\n{\n  "provider": {\n    "type": "openai",\n    "url": "${proxyUrl}/v1",\n    "apiKey": "${K}"\n  }\n}`,
      docs: "https://github.com/opencode-ai/opencode",
    },
    cline: {
      name: "Cline",
      description: "VS Code AI coding assistant",
      autoSetup: false,
      snippet: `// VS Code settings.json - add to your settings:\n{\n  "cline.apiProvider": "openai-compatible",\n  "cline.openAiBaseUrl": "${proxyUrl}/v1",\n  "cline.openAiApiKey": "${K}",\n  "cline.openAiModelId": "claude-sonnet-4-20250514"\n}`,
      docs: "https://github.com/cline/cline",
    },
    aider: {
      name: "Aider",
      description: "AI pair programming in your terminal",
      autoSetup: false,
      snippet: `# ~/.aider.conf.yml\nopenai-api-base: ${proxyUrl}/v1\nopenai-api-key: ${K}\n\n# Or use CLI flags:\n# aider --openai-api-base ${proxyUrl}/v1 --openai-api-key ${K}`,
      docs: "https://aider.chat",
    },
    continue: {
      name: "Continue.dev",
      description: "Open-source AI code assistant for VS Code & JetBrains",
      autoSetup: false,
      snippet: `// ~/.continue/config.yaml - add a model:\nmodels:\n  - title: "Claude via CodeGate"\n    provider: openai\n    model: claude-sonnet-4-20250514\n    apiBase: ${proxyUrl}/v1\n    apiKey: ${K}`,
      docs: "https://continue.dev",
    },
    generic: {
      name: "Generic / curl",
      description: "Works with any OpenAI or Anthropic compatible client",
      autoSetup: false,
      snippet: `# Anthropic format (Claude Code)\ncurl ${proxyUrl}/v1/messages \\\n  -H "x-api-key: ${K}" \\\n  -H "content-type: application/json" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -d '{\n    "model": "claude-sonnet-4-20250514",\n    "max_tokens": 1024,\n    "messages": [{"role": "user", "content": "Hello!"}]\n  }'\n\n# OpenAI format (Cline, Aider, Codex, etc.)\ncurl ${proxyUrl}/v1/chat/completions \\\n  -H "Authorization: Bearer ${K}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "claude-sonnet-4-20250514",\n    "messages": [{"role": "user", "content": "Hello!"}]\n  }'`,
      docs: null,
    },
  };

  // If PROXY_API_KEY env var is set, proxy runs in legacy single-key mode
  const envApiKey = process.env.PROXY_API_KEY || "";

  const multiTenancy = getSetting("multi_tenancy") === "true";

  return c.json({ proxyUrl, tenants, defaultTenantId, defaultTenantKey, envApiKey, multiTenancy, tools });
});

// Auto-setup Claude Code: writes to the host's settings.json
setup.post("/auto", async (c) => {
  try {
    const body = await c.req.json();
    const { tool, apiKey } = body as { tool: string; apiKey?: string };

    if (tool !== "claude-code") {
      return c.json({ success: false, message: `Auto-setup not supported for ${tool}` }, 400);
    }

    const proxyUrl = getProxyUrl();
    const proxyKey = apiKey || getSetting("proxy_api_key") || "";
    if (!proxyKey) {
      return c.json({ success: false, message: "No API key provided and no default tenant key found" }, 400);
    }
    const settingsPath = path.join(HOST_CLAUDE_RW, "settings.json");

    // Read existing settings or start fresh
    let settings: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(settingsPath, "utf-8");
      settings = JSON.parse(raw);
    } catch {
      // File doesn't exist or is invalid -- start fresh
    }

    // Ensure env object exists
    if (!settings.env || typeof settings.env !== "object") {
      settings.env = {};
    }

    const env = settings.env as Record<string, string>;

    // Set the proxy URL and API key.
    // ANTHROPIC_API_KEY must be set to force Claude Code into API-key auth mode.
    // Without it, Claude Code uses OAuth and talks directly to Anthropic,
    // completely ignoring ANTHROPIC_BASE_URL.
    env.ANTHROPIC_BASE_URL = proxyUrl;
    env.ANTHROPIC_API_KEY = proxyKey;

    // Ensure directory exists
    if (!fs.existsSync(HOST_CLAUDE_RW)) {
      fs.mkdirSync(HOST_CLAUDE_RW, { recursive: true });
    }

    // Write settings back
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

    // Clear OAuth session from .credentials.json so Claude Code doesn't
    // bypass the proxy by talking directly to Anthropic via OAuth.
    const credPath = path.join(HOST_CLAUDE_RW, ".credentials.json");
    try {
      const raw = fs.readFileSync(credPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.claudeAiOauth) {
        delete parsed.claudeAiOauth;
        fs.writeFileSync(credPath, JSON.stringify(parsed, null, 2), "utf-8");
      }
    } catch {
      // File doesn't exist -- nothing to clear
    }

    console.log(`[setup] Configured Claude Code to use proxy at ${proxyUrl}`);
    return c.json({
      success: true,
      message: `Claude Code configured! Restart Claude Code to use the proxy at ${proxyUrl}`,
    });
  } catch (err: any) {
    return c.json({ success: false, message: err.message || "Auto-setup failed" }, 500);
  }
});

setup.post("/test", async (c) => {
  try {
    const proxyUrl = getProxyUrl();
    const res = await fetch(`${proxyUrl}/health`).catch(() => null);
    if (res && res.ok) {
      return c.json({ success: true, message: "Proxy is reachable" });
    }
    return c.json({ success: false, message: "Proxy is not reachable" });
  } catch {
    return c.json({ success: false, message: "Connection test failed" });
  }
});

export default setup;
