import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import path from "node:path";
import fs from "node:fs";

import { initDB, getSetting, setSetting, startLogRetentionCleanup } from "./db.js";
import accountsRouter from "./routes/accounts.js";
import configsRouter from "./routes/configs.js";
import settingsRouter from "./routes/settings.js";
import sessionsRouter from "./routes/sessions.js";
import setupRouter from "./routes/setup.js";
import proxyRouter from "./routes/proxy.js";
import privacyRouter, { guardrailsRouter } from "./routes/privacy.js";
import logsRouter from "./routes/logs.js";
import { startTokenRefreshLoop } from "./auth-refresh.js";
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
<head><title>CodeProxy</title></head>
<body>
  <h1>CodeProxy</h1>
  <p>UI build not found. Run <code>npm run build</code> or use <code>npm run dev</code> for development.</p>
</body>
</html>`);
});

// ─── Proxy App (port 9212) ──────────────────────────────────────────────────

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

const proxy = new Hono();
proxy.use("/*", cors());
proxy.use("/*", bodyLimit({ maxSize: MAX_BODY_SIZE }));
proxy.route("/", proxyRouter);

// ─── Start servers ──────────────────────────────────────────────────────────

console.log(`Starting CodeProxy...`);
console.log(`  UI:    http://localhost:${UI_PORT}`);
console.log(`  Proxy: http://localhost:${PROXY_PORT}`);

serve({
  fetch: ui.fetch,
  port: UI_PORT,
});

serve({
  fetch: proxy.fetch,
  port: PROXY_PORT,
});

// Initialize session manager (restore active ports, restart linked sessions)
initSessionManager().catch((err) => {
  console.error("[sessions] Init failed:", err);
});

// Start background OAuth token refresh loop (every 15 minutes)
startTokenRefreshLoop();

// Start automatic log retention cleanup (deletes logs older than 30 days, runs every 6 hours)
startLogRetentionCleanup();

console.log(`CodeProxy is running.`);
