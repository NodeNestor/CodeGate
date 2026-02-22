import { Hono } from "hono";
import {
  createTerminalSession,
  stopSession,
  removeSession,
  getSessionStatus,
  importCredentials,
  listSessions,
} from "../session-manager.js";
import { createAccount, updateSession as dbUpdateSession } from "../db.js";

const sessions = new Hono();

sessions.get("/", (c) => {
  try {
    return c.json(listSessions());
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

sessions.post("/", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const name = (body as any)?.name;
    const session = await createTerminalSession(name);
    return c.json(session, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

sessions.get("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const status = await getSessionStatus(id);
    return c.json(status);
  } catch (err: any) {
    return c.json({ error: err.message }, 404);
  }
});

sessions.delete("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    await removeSession(id);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

sessions.post("/:id/stop", async (c) => {
  try {
    const id = c.req.param("id");
    await stopSession(id);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

sessions.post("/:id/import-credentials", async (c) => {
  try {
    const id = c.req.param("id");
    const creds = await importCredentials(id);

    if (!creds) {
      return c.json(
        { error: "No credentials found in session. Run 'claude login' first." },
        404
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const accountName = (body as any)?.name || "Imported from session";

    const account = createAccount({
      name: accountName,
      provider: creds.provider,
      auth_type: "oauth",
      api_key: creds.accessToken,
      refresh_token: creds.refreshToken,
      token_expires_at: creds.expiresAt,
      priority: 0,
      rate_limit: 60,
      enabled: 1,
      external_account_id: creds.externalAccountId,
    });

    // Link this session to the newly created account for persistent token refresh
    dbUpdateSession(id, { account_id: account.id });

    return c.json(
      {
        success: true,
        accountId: account.id,
        accountName: account.name,
        expiresAt: creds.expiresAt
          ? new Date(creds.expiresAt).toISOString()
          : null,
      },
      201
    );
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default sessions;
