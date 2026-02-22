import { Hono } from "hono";
import {
  getAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  type AccountDecrypted,
} from "../db.js";

const accounts = new Hono();

/**
 * Mask an API key for safe display: first 8 chars + "..." + last 4 chars.
 * Returns null for null/undefined keys.
 */
function maskApiKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 12) return "***";
  return key.substring(0, 8) + "..." + key.substring(key.length - 4);
}

/**
 * Mask sensitive fields in an account for API response.
 */
function maskAccount(account: AccountDecrypted): any {
  return {
    ...account,
    api_key: maskApiKey(account.api_key),
    refresh_token: account.refresh_token ? "***" : null,
  };
}

// GET /api/accounts - list all accounts (masked)
accounts.get("/", (c) => {
  try {
    const allAccounts = getAccounts();
    return c.json(allAccounts.map(maskAccount));
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/accounts - create new account
accounts.post("/", async (c) => {
  try {
    const body = await c.req.json();

    if (!body.name || !body.provider) {
      return c.json({ error: "name and provider are required" }, 400);
    }

    const validProviders = [
      "anthropic", "openai", "openai_sub", "openrouter",
      "glm", "cerebras", "deepseek", "gemini", "minimax", "custom",
    ];
    if (!validProviders.includes(body.provider)) {
      return c.json(
        { error: `provider must be one of: ${validProviders.join(", ")}` },
        400
      );
    }

    const account = createAccount({
      name: body.name,
      provider: body.provider,
      auth_type: body.auth_type,
      api_key: body.api_key,
      refresh_token: body.refresh_token,
      token_expires_at: body.token_expires_at,
      base_url: body.base_url,
      priority: body.priority,
      rate_limit: body.rate_limit,
      monthly_budget: body.monthly_budget,
      enabled: body.enabled,
      subscription_type: body.subscription_type,
      account_email: body.account_email,
    });

    return c.json(maskAccount(account), 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/accounts/:id - get single account (masked)
accounts.get("/:id", (c) => {
  try {
    const id = c.req.param("id");
    const account = getAccount(id);
    if (!account) {
      return c.json({ error: "Account not found" }, 404);
    }
    return c.json(maskAccount(account));
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// PUT /api/accounts/:id - update account
accounts.put("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();

    const account = updateAccount(id, body);
    if (!account) {
      return c.json({ error: "Account not found" }, 404);
    }

    return c.json(maskAccount(account));
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// DELETE /api/accounts/:id - delete account
accounts.delete("/:id", (c) => {
  try {
    const id = c.req.param("id");
    const deleted = deleteAccount(id);
    if (!deleted) {
      return c.json({ error: "Account not found" }, 404);
    }
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/accounts/:id/test - test account connectivity
accounts.post("/:id/test", async (c) => {
  try {
    const id = c.req.param("id");
    const account = getAccount(id);
    if (!account) {
      return c.json({ success: false, message: "Account not found" }, 404);
    }

    // Build a minimal test request to the provider
    const baseUrl =
      account.base_url ||
      (account.provider === "anthropic"
        ? "https://api.anthropic.com"
        : account.provider === "openrouter"
          ? "https://openrouter.ai/api"
          : account.provider === "openai"
            ? "https://api.openai.com"
            : account.provider === "deepseek"
              ? "https://api.deepseek.com"
              : account.provider === "cerebras"
                ? "https://api.cerebras.ai"
                : account.provider === "glm"
                  ? "https://api.z.ai/api/coding/paas/v4"
                  : null);

    if (!baseUrl) {
      return c.json({ success: false, message: "No base URL configured for this provider" });
    }

    // Try a lightweight request to verify credentials work
    const apiKey = account.api_key || "";

    if (account.provider === "anthropic") {
      // Use Anthropic messages endpoint with a tiny request
      // OAuth accounts need Bearer token + beta headers, API key accounts use x-api-key
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      };

      if (account.auth_type === "oauth") {
        headers["authorization"] = `Bearer ${apiKey}`;
        headers["anthropic-beta"] = "oauth-2025-04-20";
        headers["anthropic-dangerous-direct-browser-access"] = "true";
      } else {
        headers["x-api-key"] = apiKey;
      }

      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      if (res.ok || res.status === 200) {
        return c.json({ success: true, message: "Connection successful" });
      }
      const errText = await res.text().catch(() => "");
      return c.json({
        success: false,
        message: `${res.status} ${res.statusText}${errText ? `: ${errText.slice(0, 200)}` : ""}`,
      });
    } else {
      // OpenAI-compatible: try listing models
      // If base URL already ends with a version segment (e.g. /v4), use /models directly
      const cleanBase = baseUrl.replace(/\/+$/, "");
      const modelsUrl = /\/v\d+$/.test(cleanBase)
        ? `${cleanBase}/models`
        : `${cleanBase}/v1/models`;
      const res = await fetch(modelsUrl, {
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      });
      if (res.ok) {
        return c.json({ success: true, message: "Connection successful" });
      }
      const errText = await res.text().catch(() => "");
      return c.json({
        success: false,
        message: `${res.status} ${res.statusText}${errText ? `: ${errText.slice(0, 200)}` : ""}`,
      });
    }
  } catch (err: any) {
    return c.json({
      success: false,
      message: err.message || "Connection test failed",
    });
  }
});

// POST /api/accounts/:id/toggle - enable/disable account
accounts.post("/:id/toggle", (c) => {
  try {
    const id = c.req.param("id");
    const account = getAccount(id);
    if (!account) {
      return c.json({ error: "Account not found" }, 404);
    }

    const updated = updateAccount(id, {
      enabled: account.enabled ? 0 : 1,
    });

    return c.json(maskAccount(updated!));
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default accounts;
