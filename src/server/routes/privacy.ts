/**
 * Privacy / Guardrails API routes.
 *
 * Manages the PII anonymization layer: toggle on/off, configure categories,
 * view active mappings, test anonymization, and manage individual guardrails.
 */

import { Hono } from "hono";
import { getSetting, setSetting } from "../db.js";
import {
  isGuardrailsEnabled,
  getEnabledCategories,
  getPrivacyStats,
  getMappingsForUI,
  clearMappings,
  runGuardrails,
  getAllConfigs,
  getGuardrail,
  setGuardrailEnabled,
  syncConfigFromDB,
} from "../guardrails/manager.js";

const privacy = new Hono();

// GET / - Get privacy status, categories, stats
privacy.get("/", (c) => {
  try {
    const enabled = isGuardrailsEnabled();
    const categories = getEnabledCategories();
    const stats = getPrivacyStats();
    return c.json({ enabled, categories, stats });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// PUT / - Update privacy settings
privacy.put("/", async (c) => {
  try {
    const body = await c.req.json();

    if (body.enabled !== undefined) {
      setSetting("privacy_enabled", body.enabled ? "true" : "false");
    }

    if (body.categories !== undefined) {
      if (Array.isArray(body.categories)) {
        setSetting("privacy_categories", body.categories.join(","));
      } else if (typeof body.categories === "string") {
        setSetting("privacy_categories", body.categories);
      }
      // Re-sync guardrail enabled states from updated categories
      syncConfigFromDB();
    }

    const enabled = isGuardrailsEnabled();
    const categories = getEnabledCategories();
    const stats = getPrivacyStats();

    return c.json({ enabled, categories, stats });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /mappings - List all active mappings (with masked originals)
privacy.get("/mappings", (c) => {
  try {
    const mappings = getMappingsForUI();
    return c.json(mappings);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// DELETE /mappings - Clear all mappings
privacy.delete("/mappings", (c) => {
  try {
    clearMappings();
    return c.json({ success: true, message: "All privacy mappings cleared" });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /test - Test anonymization on sample text
privacy.post("/test", async (c) => {
  try {
    const body = await c.req.json();
    const text = body.text;

    if (typeof text !== "string") {
      return c.json({ error: "text field is required and must be a string" }, 400);
    }

    const statsBefore = getPrivacyStats();
    const { text: anonymized } = runGuardrails(text, "pre_call", {
      requestedGuardrails: body.categories,
    });
    const statsAfter = getPrivacyStats();

    const replacements_made = statsAfter.total_mappings - statsBefore.total_mappings;

    return c.json({
      original: text,
      anonymized,
      replacements_made,
      stats: statsAfter,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default privacy;

// ─── Guardrails-specific routes ──────────────────────────────────────────────

export const guardrailsRouter = new Hono();

// GET /list - Get all guardrail configs with per-guardrail stats
guardrailsRouter.get("/list", (c) => {
  try {
    const configs = getAllConfigs();
    const stats = getPrivacyStats();

    const guardrails = configs.map((config) => ({
      ...config,
      detectionCount: stats.by_category[config.id] || 0,
    }));

    return c.json({ guardrails });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// PUT /:id - Toggle individual guardrail enabled/disabled
guardrailsRouter.put("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();

    const guardrail = getGuardrail(id);
    if (!guardrail) {
      return c.json({ error: `Guardrail "${id}" not found` }, 404);
    }

    if (body.enabled !== undefined) {
      setGuardrailEnabled(id, body.enabled);
      // Persist to DB
      setSetting(`guardrail_${id}_enabled`, body.enabled ? "true" : "false");
    }

    return c.json(guardrail.config);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
