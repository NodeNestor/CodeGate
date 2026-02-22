import { Hono } from "hono";
import {
  getConfigs,
  getConfig,
  createConfig,
  updateConfig,
  deleteConfig,
  activateConfig,
  getConfigTiers,
  setConfigTiers,
} from "../db.js";

const configs = new Hono();

// GET /api/configs - list all configs
configs.get("/", (c) => {
  try {
    const allConfigs = getConfigs();
    return c.json(allConfigs);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/configs - create config
configs.post("/", async (c) => {
  try {
    const body = await c.req.json();

    if (!body.name) {
      return c.json({ error: "name is required" }, 400);
    }

    const validStrategies = ["priority", "round-robin", "least-used", "budget-aware"];
    if (body.routing_strategy && !validStrategies.includes(body.routing_strategy)) {
      return c.json(
        { error: `routing_strategy must be one of: ${validStrategies.join(", ")}` },
        400
      );
    }

    const config = createConfig({
      name: body.name,
      description: body.description,
      is_active: body.is_active,
      routing_strategy: body.routing_strategy,
    });

    return c.json(config, 201);
  } catch (err: any) {
    if (err.message?.includes("UNIQUE constraint failed")) {
      return c.json({ error: "A config with that name already exists" }, 409);
    }
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/configs/:id - get config with tiers
configs.get("/:id", (c) => {
  try {
    const id = c.req.param("id");
    const config = getConfig(id);
    if (!config) {
      return c.json({ error: "Config not found" }, 404);
    }

    const tiers = getConfigTiers(id);
    return c.json({ ...config, tiers });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// PUT /api/configs/:id - update config
configs.put("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();

    const validStrategies = ["priority", "round-robin", "least-used", "budget-aware"];
    if (body.routing_strategy && !validStrategies.includes(body.routing_strategy)) {
      return c.json(
        { error: `routing_strategy must be one of: ${validStrategies.join(", ")}` },
        400
      );
    }

    const config = updateConfig(id, body);
    if (!config) {
      return c.json({ error: "Config not found" }, 404);
    }

    return c.json(config);
  } catch (err: any) {
    if (err.message?.includes("UNIQUE constraint failed")) {
      return c.json({ error: "A config with that name already exists" }, 409);
    }
    return c.json({ error: err.message }, 500);
  }
});

// DELETE /api/configs/:id - delete config
configs.delete("/:id", (c) => {
  try {
    const id = c.req.param("id");
    const deleted = deleteConfig(id);
    if (!deleted) {
      return c.json({ error: "Config not found" }, 404);
    }
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/configs/:id/activate - set as active config
configs.post("/:id/activate", (c) => {
  try {
    const id = c.req.param("id");
    const config = activateConfig(id);
    if (!config) {
      return c.json({ error: "Config not found" }, 404);
    }
    return c.json(config);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/configs/:id/tiers - get tier assignments
configs.get("/:id/tiers", (c) => {
  try {
    const id = c.req.param("id");
    const config = getConfig(id);
    if (!config) {
      return c.json({ error: "Config not found" }, 404);
    }

    const tiers = getConfigTiers(id);
    return c.json(tiers);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// PUT /api/configs/:id/tiers - set tier assignments
configs.put("/:id/tiers", async (c) => {
  try {
    const id = c.req.param("id");
    const config = getConfig(id);
    if (!config) {
      return c.json({ error: "Config not found" }, 404);
    }

    const body = await c.req.json();

    if (!Array.isArray(body)) {
      return c.json({ error: "Body must be an array of tier assignments" }, 400);
    }

    // Validate each tier assignment
    const validTiers = ["opus", "sonnet", "haiku"];
    for (const tier of body) {
      if (!tier.tier || !tier.account_id) {
        return c.json({ error: "Each tier assignment must have tier and account_id" }, 400);
      }
      if (!validTiers.includes(tier.tier)) {
        return c.json(
          { error: `tier must be one of: ${validTiers.join(", ")}` },
          400
        );
      }
    }

    const tiers = setConfigTiers(
      id,
      body.map((t: any) => ({
        tier: t.tier,
        account_id: t.account_id,
        priority: t.priority,
        target_model: t.target_model,
      }))
    );

    return c.json(tiers);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default configs;
