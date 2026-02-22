import { Hono } from "hono";
import { getRequestLogs, getRequestLog, deleteOldRequestLogs } from "../db.js";

const logs = new Hono();

// GET /api/logs - list logs with filtering and pagination
logs.get("/", (c) => {
  try {
    const page = parseInt(c.req.query("page") || "1", 10);
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const status = c.req.query("status"); // "success" | "error" | undefined
    const account = c.req.query("account");
    const model = c.req.query("model");

    const result = getRequestLogs({ page, limit, status, account, model });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/logs/:id - single log detail
logs.get("/:id", (c) => {
  try {
    const log = getRequestLog(c.req.param("id"));
    if (!log) return c.json({ error: "Log not found" }, 404);
    return c.json(log);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// DELETE /api/logs - cleanup old logs
logs.delete("/", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const daysOld = (body as any)?.days_old ?? 7;
    const deleted = deleteOldRequestLogs(daysOld);
    return c.json({ deleted });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default logs;
