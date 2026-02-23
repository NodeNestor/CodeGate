import { Hono } from "hono";
import {
  createTenant,
  getTenants,
  getTenant,
  updateTenant,
  deleteTenant,
  rotateTenantKey,
  getTenantSettings,
  setTenantSetting,
  deleteTenantSetting,
  getConfig,
} from "../db.js";

const router = new Hono();

router.get("/", (c) => {
  try {
    return c.json(getTenants());
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

router.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { name, config_id, rate_limit } = body;
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return c.json({ error: "name is required" }, 400);
    }
    if (config_id) {
      if (!getConfig(config_id)) return c.json({ error: "Config not found" }, 404);
    }
    const result = createTenant({
      name: name.trim(),
      config_id: config_id || undefined,
      rate_limit: typeof rate_limit === "number" ? rate_limit : undefined,
    });
    return c.json({
      tenant: result.tenant,
      api_key: result.raw_api_key,
      warning: "Store this API key securely. It will not be shown again.",
    }, 201);
  } catch (err: any) {
    if (err.message?.includes("UNIQUE constraint")) {
      return c.json({ error: "A tenant with this name already exists" }, 409);
    }
    return c.json({ error: err.message }, 500);
  }
});

router.get("/:id", (c) => {
  try {
    const tenant = getTenant(c.req.param("id"));
    if (!tenant) return c.json({ error: "Tenant not found" }, 404);
    return c.json(tenant);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

router.put("/:id", async (c) => {
  try {
    const body = await c.req.json();
    const { name, config_id, rate_limit, enabled } = body;
    if (config_id) {
      if (!getConfig(config_id)) return c.json({ error: "Config not found" }, 404);
    }
    const tenant = updateTenant(c.req.param("id"), {
      ...(name !== undefined && { name }),
      ...(config_id !== undefined && { config_id }),
      ...(rate_limit !== undefined && { rate_limit }),
      ...(enabled !== undefined && { enabled }),
    });
    if (!tenant) return c.json({ error: "Tenant not found" }, 404);
    return c.json(tenant);
  } catch (err: any) {
    if (err.message?.includes("UNIQUE constraint")) {
      return c.json({ error: "A tenant with this name already exists" }, 409);
    }
    return c.json({ error: err.message }, 500);
  }
});

router.delete("/:id", (c) => {
  try {
    if (!deleteTenant(c.req.param("id"))) return c.json({ error: "Tenant not found" }, 404);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

router.get("/:id/settings", (c) => {
  try {
    return c.json(getTenantSettings(c.req.param("id")));
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

router.put("/:id/settings", async (c) => {
  try {
    const id = c.req.param("id");
    if (!getTenant(id)) return c.json({ error: "Tenant not found" }, 404);
    const body = await c.req.json();
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "Body must be an object of key-value pairs" }, 400);
    }
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") setTenantSetting(id, key, value);
    }
    return c.json(getTenantSettings(id));
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

router.delete("/:id/settings/:key", (c) => {
  try {
    if (!deleteTenantSetting(c.req.param("id"), c.req.param("key"))) {
      return c.json({ error: "Setting not found" }, 404);
    }
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

router.post("/:id/rotate-key", (c) => {
  try {
    const result = rotateTenantKey(c.req.param("id"));
    if (!result) return c.json({ error: "Tenant not found" }, 404);
    return c.json({
      tenant: result.tenant,
      api_key: result.raw_api_key,
      warning: "Store this API key securely. It will not be shown again.",
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default router;
