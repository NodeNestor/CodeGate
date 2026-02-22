import { Hono } from "hono";
import { getAllSettings, setSetting } from "../db.js";
import { getAllModels, getModelsForProvider, invalidateModelCache } from "../model-fetcher.js";
import { getAllModelLimits, setModelLimit, deleteModelLimit } from "../model-limits.js";

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

export default settings;
