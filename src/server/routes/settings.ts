import { Hono } from "hono";
import crypto from "node:crypto";
import fs from "node:fs";
import { getAllSettings, getSetting, setSetting, getAccountsWithDecryptErrors, reEncryptAllAccounts, rotateTenantKey, getTenants, createTenant } from "../db.js";
import { getFinetuneInfo, clearFinetuneData, getFinetuneFilePath, gzipFinetuneFile } from "../finetune.js";
import { getAllModels, getModelsForProvider, invalidateModelCache } from "../model-fetcher.js";
import { getAllModelLimits, setModelLimit, deleteModelLimit } from "../model-limits.js";
import {
  getAccountKey,
  getGuardrailKey,
  getKeyFingerprint,
  getAccountKeySource,
  getGuardrailKeySource,
  rotateAccountKey as rotateAccountKeyFn,
  rotateGuardrailKey as rotateGuardrailKeyFn,
} from "../encryption.js";

const settings = new Hono();

// GET /api/settings - get all settings
settings.get("/", (c) => {
  try {
    const allSettings = getAllSettings();

    // Inject proxy API key: env var takes precedence over DB value
    const envKey = process.env.PROXY_API_KEY;
    if (envKey) {
      allSettings.proxy_api_key = envKey;
      allSettings.proxy_api_key_source = "env";
    } else if (!allSettings.proxy_api_key_source) {
      allSettings.proxy_api_key_source = allSettings.proxy_api_key ? "db" : "none";
    }

    return c.json(allSettings);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// PUT /api/settings - update settings (body is key-value object)
settings.put("/", async (c) => {
  try {
    const body = await c.req.json();

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "Body must be a key-value object" }, 400);
    }

    for (const [key, value] of Object.entries(body)) {
      if (typeof value !== "string") {
        setSetting(key, JSON.stringify(value));
      } else {
        setSetting(key, value);
      }
    }

    // Auto-create Default tenant when multi-tenancy is turned on
    if (body.multi_tenancy === "true") {
      const tenants = getTenants();
      if (tenants.length === 0) {
        const result = createTenant({ name: "Default", rate_limit: 0 });
        setSetting("proxy_api_key", result.raw_api_key);
        setSetting("default_tenant_id", result.tenant.id);
      }
    }

    const allSettings = getAllSettings();
    return c.json(allSettings);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/settings/models - fetch live models from all enabled providers
settings.get("/models", async (c) => {
  try {
    const provider = c.req.query("provider");
    const models = provider
      ? await getModelsForProvider(provider)
      : await getAllModels();
    return c.json(models);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/settings/models/refresh - force refresh model cache
settings.post("/models/refresh", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const provider = (body as any)?.provider;
    invalidateModelCache(provider || undefined);
    const models = provider
      ? await getModelsForProvider(provider)
      : await getAllModels();
    return c.json(models);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/settings/model-limits - return all user-configured model limits
settings.get("/model-limits", (c) => {
  try {
    return c.json(getAllModelLimits());
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// PUT /api/settings/model-limits/:modelId - set limits for a model
settings.put("/model-limits/:modelId", async (c) => {
  try {
    const modelId = decodeURIComponent(c.req.param("modelId"));
    const body = await c.req.json();
    setModelLimit(modelId, {
      maxOutputTokens: body.maxOutputTokens ?? null,
      supportsToolCalling: body.supportsToolCalling ?? null,
      supportsReasoning: body.supportsReasoning ?? null,
    });
    return c.json(getAllModelLimits());
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// DELETE /api/settings/model-limits/:modelId - remove limits for a model
settings.delete("/model-limits/:modelId", (c) => {
  try {
    const modelId = decodeURIComponent(c.req.param("modelId"));
    deleteModelLimit(modelId);
    return c.json(getAllModelLimits());
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ─── Encryption key management ───────────────────────────────────────────────

// GET /api/settings/encryption — key fingerprints, sources, error count
settings.get("/encryption", (c) => {
  try {
    return c.json({
      account_key: {
        fingerprint: getKeyFingerprint(getAccountKey()),
        source: getAccountKeySource(),
      },
      guardrail_key: {
        fingerprint: getKeyFingerprint(getGuardrailKey()),
        source: getGuardrailKeySource(),
      },
      decrypt_errors: getAccountsWithDecryptErrors(),
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/settings/encryption/rotate-account-key — rotate + re-encrypt
settings.post("/encryption/rotate-account-key", (c) => {
  try {
    const oldKey = getAccountKey();
    const newKey = rotateAccountKeyFn();
    const result = reEncryptAllAccounts(oldKey, newKey);
    return c.json({
      fingerprint: getKeyFingerprint(newKey),
      re_encrypted: result.success,
      failed: result.failed,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/settings/encryption/rotate-guardrail-key — just rotate
settings.post("/encryption/rotate-guardrail-key", (c) => {
  try {
    const newKey = rotateGuardrailKeyFn();
    return c.json({
      fingerprint: getKeyFingerprint(newKey),
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/settings/regenerate-proxy-key - regenerate the proxy API key
settings.post("/regenerate-proxy-key", (c) => {
  try {
    const tenantId = getSetting("default_tenant_id");
    if (tenantId) {
      // Tenant mode: rotate the default tenant's key
      const result = rotateTenantKey(tenantId);
      if (!result) {
        return c.json({ error: "Default tenant not found" }, 404);
      }
      setSetting("proxy_api_key", result.raw_api_key);
      return c.json({ key: result.raw_api_key });
    } else {
      // Simple mode: generate a new random key
      const key = "cgk_" + crypto.randomBytes(16).toString("hex");
      setSetting("proxy_api_key", key);
      return c.json({ key });
    }
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ─── Fine-tune export ────────────────────────────────────────────────────────

// GET /api/settings/finetune — info about the finetune export
settings.get("/finetune", (c) => {
  try {
    return c.json(getFinetuneInfo());
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/settings/finetune/download — download gzipped JSONL file
settings.get("/finetune/download", (c) => {
  try {
    const compressed = gzipFinetuneFile();
    if (!compressed) {
      return c.json({ error: "No finetune export file found" }, 404);
    }
    return new Response(new Uint8Array(compressed), {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        "content-disposition": 'attachment; filename="finetune-export.jsonl.gz"',
        "content-encoding": "identity",
      },
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// DELETE /api/settings/finetune — clear the JSONL file
settings.delete("/finetune", (c) => {
  try {
    clearFinetuneData();
    return c.json({ deleted: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default settings;
