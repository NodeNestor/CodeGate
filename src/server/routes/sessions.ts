import { Hono } from "hono";
import {
  createTerminalSession,
  stopSession,
  removeSession,
  getSessionStatus,
  importCredentials,
  readSessionAuthUrls,
  listSessions,
} from "../session-manager.js";
import { createAccount, updateSession as dbUpdateSession, getAccounts, getConfigs, createConfig, setConfigTiers, activateConfig } from "../db.js";

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
    const autoCommand = (body as any)?.autoCommand;
    const session = await createTerminalSession(name, autoCommand);
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

sessions.get("/:id/auth-urls", async (c) => {
  try {
    const id = c.req.param("id");
    const urls = await readSessionAuthUrls(id);
    return c.json({ urls });
  } catch {
    return c.json({ urls: [] });
  }
});

sessions.get("/:id/check-credentials", async (c) => {
  try {
    const id = c.req.param("id");
    const creds = await importCredentials(id);
    if (creds) {
      return c.json({ found: true, provider: creds.provider });
    }
    return c.json({ found: false });
  } catch {
    return c.json({ found: false });
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

    // Auto-create default config when this is the first account and no configs exist
    let configCreated = false;
    try {
      const allAccounts = getAccounts();
      const allConfigs = getConfigs();
      if (allAccounts.length === 1 && allConfigs.length === 0) {
        const config = createConfig({
          name: "Default",
          description: `Auto-created for ${creds.provider}`,
          is_active: 0,
          routing_strategy: "priority",
        });
        setConfigTiers(config.id, [
          { tier: "opus", account_id: account.id, priority: 100 },
          { tier: "sonnet", account_id: account.id, priority: 100 },
          { tier: "haiku", account_id: account.id, priority: 100 },
        ]);
        activateConfig(config.id);
        configCreated = true;
      }
    } catch (err) {
      console.error("Auto-config creation failed:", err);
    }

    return c.json(
      {
        success: true,
        accountId: account.id,
        accountName: account.name,
        expiresAt: creds.expiresAt
          ? new Date(creds.expiresAt).toISOString()
          : null,
        configCreated,
      },
      201
    );
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default sessions;
