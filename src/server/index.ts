import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";

import { initDB, getSetting, setSetting, startLogRetentionCleanup, getTenants, createTenant } from "./db.js";
import accountsRouter from "./routes/accounts.js";
import configsRouter from "./routes/configs.js";
import settingsRouter from "./routes/settings.js";
import sessionsRouter from "./routes/sessions.js";
import setupRouter from "./routes/setup.js";
import privacyRouter, { guardrailsRouter } from "./routes/privacy.js";
import logsRouter from "./routes/logs.js";
import tenantsRouter from "./routes/tenants.js";
import { initGuardrails } from "./guardrails/manager.js";
import { initSessionManager } from "./session-manager.js";
import { initModelLimitsTable } from "./model-limits.js";

// ─── Initialize database ────────────────────────────────────────────────────

initDB();

// Initialize default settings if not already set
if (!getSetting("auto_switch_on_error")) {
  setSetting("auto_switch_on_error", "true");
}
if (!getSetting("auto_switch_on_rate_limit")) {
  setSetting("auto_switch_on_rate_limit", "true");
}
if (!getSetting("request_logging")) {
  setSetting("request_logging", "false");
}
if (!getSetting("detailed_request_logging")) {
  setSetting("detailed_request_logging", "false");
}

if (!getSetting("finetune_logging")) {
  setSetting("finetune_logging", "false");
}

// Default multi_tenancy to false if not set
if (!getSetting("multi_tenancy")) {
  setSetting("multi_tenancy", "false");
}

if (getSetting("multi_tenancy") === "true") {
  // Tenant mode: auto-create Default tenant on first boot
  if (getTenants().length === 0) {
    const result = createTenant({ name: "Default", rate_limit: 0 });
    setSetting("proxy_api_key", result.raw_api_key);
    setSetting("default_tenant_id", result.tenant.id);
    console.log(`[init] Default tenant created — API key: ${result.raw_api_key.slice(0, 12)}...`);
  }
} else {
  // Simple mode: generate a random key if none exists
  if (!getSetting("proxy_api_key")) {
    const key = "cgk_" + crypto.randomBytes(16).toString("hex");
    setSetting("proxy_api_key", key);
    console.log(`[init] Proxy API key generated: ${key.slice(0, 12)}...`);
  }
}

// Initialize guardrails system (register builtins, load DB mappings, sync config)
initGuardrails();

// Initialize model limits table
initModelLimitsTable();

// ─── Configuration ──────────────────────────────────────────────────────────

const UI_PORT = parseInt(process.env.UI_PORT || "9211", 10);
const PROXY_PORT = parseInt(process.env.PROXY_PORT || "9212", 10);

// ─── UI App (port 9211) ─────────────────────────────────────────────────────

const ui = new Hono();

ui.use("/*", cors());

// Mount API routes
ui.route("/api/accounts", accountsRouter);
ui.route("/api/configs", configsRouter);
ui.route("/api/settings", settingsRouter);
ui.route("/api/sessions", sessionsRouter);
ui.route("/api/setup", setupRouter);
ui.route("/api/privacy", privacyRouter);
ui.route("/api/guardrails", guardrailsRouter);
ui.route("/api/logs", logsRouter);
ui.route("/api/tenants", tenantsRouter);

// Serve static files from dist/client for SPA
ui.use(
  "/assets/*",
  serveStatic({
    root: "./dist/client",
  })
);

// SPA fallback: serve index.html for client-side routing
// Cache the HTML at startup to avoid blocking fs.readFileSync on every request
const indexPath = path.resolve("dist/client/index.html");
const cachedIndexHtml = fs.existsSync(indexPath)
  ? fs.readFileSync(indexPath, "utf8")
  : null;

ui.get("*", (c) => {
  if (cachedIndexHtml) {
    return c.html(cachedIndexHtml);
  }
  return c.html(`<!DOCTYPE html>
<html>
<head><title>CodeGate</title></head>
<body>
  <h1>CodeGate</h1>
  <p>UI build not found. Run <code>npm run build</code> or use <code>npm run dev</code> for development.</p>
</body>
</html>`);
});

// ─── Start servers ──────────────────────────────────────────────────────────

console.log(`Starting CodeGate...`);
console.log(`  UI:    http://localhost:${UI_PORT}`);
console.log(`  Proxy: handled by Go binary on :${PROXY_PORT}`);

serve({
  fetch: ui.fetch,
  port: UI_PORT,
});

// Initialize session manager (restore active ports, restart linked sessions)
initSessionManager().catch((err) => {
  console.error("[sessions] Init failed:", err);
});

// Start automatic log retention cleanup (deletes logs older than 30 days, runs every 6 hours)
startLogRetentionCleanup();

console.log(`CodeGate is running.`);
