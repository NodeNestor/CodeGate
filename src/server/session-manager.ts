/**
 * Docker terminal session management.
 *
 * Uses dockerode to manage lightweight containers running ttyd for web terminal access.
 * Sessions are used to log into Claude, Codex, or other services and import credentials.
 *
 * Persistent sessions:
 *   - Sessions linked to accounts stay running for automatic token refresh.
 *   - On startup, dead linked sessions are restarted automatically.
 *   - A periodic sync loop reads fresh tokens from running sessions and updates accounts.
 */

import Docker from "dockerode";
import { v4 as uuidv4 } from "uuid";
import {
  createSession as dbCreateSession,
  updateSession as dbUpdateSession,
  getSessions as dbGetSessions,
  getSession as dbGetSession,
  deleteSession as dbDeleteSession,
  getLinkedSessions,
  updateAccountTokens,
} from "./db.js";

const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
});

const SESSION_IMAGE = process.env.SESSION_IMAGE || "code-proxy-session";
const SESSION_NETWORK = process.env.SESSION_NETWORK || "code-proxy_proxy-net";
const BASE_PORT = parseInt(process.env.SESSION_BASE_PORT || "7700", 10);
const CREDENTIAL_SYNC_INTERVAL = 10 * 60 * 1000; // 10 minutes

const usedPorts = new Set<number>();
let syncInterval: ReturnType<typeof setInterval> | null = null;

function allocatePort(): number {
  let port = BASE_PORT;
  while (usedPorts.has(port)) port++;
  usedPorts.add(port);
  return port;
}

function releasePort(port: number): void {
  usedPorts.delete(port);
}

export async function createTerminalSession(name?: string): Promise<{
  id: string;
  name: string;
  port: number;
  status: string;
}> {
  const id = uuidv4();
  const sessionName = name || `session-${id.slice(0, 8)}`;
  const port = allocatePort();

  try {
    const container = await docker.createContainer({
      Image: SESSION_IMAGE,
      name: `codeproxy-session-${id.slice(0, 8)}`,
      ExposedPorts: { "7681/tcp": {} },
      HostConfig: {
        PortBindings: {
          "7681/tcp": [{ HostPort: String(port) }],
        },
        NetworkMode: SESSION_NETWORK,
        RestartPolicy: { Name: "unless-stopped" },
      },
      Env: [
        `PROXY_URL=http://proxy:9212`,
        `SESSION_ID=${id}`,
      ],
    });

    await container.start();

    dbCreateSession({
      id,
      container_id: container.id,
      name: sessionName,
      status: "running",
      port,
      account_id: null,
    });

    return { id, name: sessionName, port, status: "running" };
  } catch (err) {
    releasePort(port);
    throw err;
  }
}

/**
 * Restart a stopped/dead session container.
 * Used on startup to revive linked sessions.
 */
async function restartSession(sessionId: string): Promise<boolean> {
  const session = dbGetSession(sessionId);
  if (!session) return false;

  // Try to start existing container first
  if (session.container_id) {
    try {
      const container = docker.getContainer(session.container_id);
      const info = await container.inspect();
      if (!info.State?.Running) {
        await container.start();
        dbUpdateSession(sessionId, { status: "running" });
        if (session.port) usedPorts.add(session.port);
        console.log(`[sessions] Restarted existing container for session "${session.name}"`);
        return true;
      }
      // Already running
      dbUpdateSession(sessionId, { status: "running" });
      if (session.port) usedPorts.add(session.port);
      return true;
    } catch {
      // Container gone, need to recreate
    }
  }

  // Recreate container
  const port = session.port || allocatePort();
  try {
    // Remove old container if it exists
    if (session.container_id) {
      try {
        await docker.getContainer(session.container_id).remove({ force: true });
      } catch { /* already gone */ }
    }

    const container = await docker.createContainer({
      Image: SESSION_IMAGE,
      name: `codeproxy-session-${sessionId.slice(0, 8)}`,
      ExposedPorts: { "7681/tcp": {} },
      HostConfig: {
        PortBindings: {
          "7681/tcp": [{ HostPort: String(port) }],
        },
        NetworkMode: SESSION_NETWORK,
        RestartPolicy: { Name: "unless-stopped" },
      },
      Env: [
        `PROXY_URL=http://proxy:9212`,
        `SESSION_ID=${sessionId}`,
      ],
    });

    await container.start();
    dbUpdateSession(sessionId, {
      container_id: container.id,
      status: "running",
      port,
    });
    usedPorts.add(port);
    console.log(`[sessions] Recreated container for session "${session.name}" on port ${port}`);
    return true;
  } catch (err) {
    console.error(`[sessions] Failed to restart session "${session.name}":`, err);
    dbUpdateSession(sessionId, { status: "error" });
    return false;
  }
}

export async function stopSession(id: string): Promise<void> {
  const session = dbGetSession(id);
  if (!session) throw new Error("Session not found");
  if (!session.container_id) throw new Error("No container associated");

  try {
    const container = docker.getContainer(session.container_id);
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
  } catch {
    // Container may already be stopped/removed
  }

  if (session.port) releasePort(session.port);
  dbUpdateSession(id, { status: "stopped" });
}

export async function removeSession(id: string): Promise<void> {
  const session = dbGetSession(id);
  if (!session) throw new Error("Session not found");

  if (session.container_id) {
    try {
      const container = docker.getContainer(session.container_id);
      await container.stop({ t: 5 }).catch(() => {});
      await container.remove({ force: true }).catch(() => {});
    } catch {
      // Container may already be gone
    }
  }

  if (session.port) releasePort(session.port);
  dbDeleteSession(id);
}

export async function getSessionStatus(id: string): Promise<{
  id: string;
  status: string;
  running: boolean;
}> {
  const session = dbGetSession(id);
  if (!session) throw new Error("Session not found");

  if (session.container_id) {
    try {
      const container = docker.getContainer(session.container_id);
      const info = await container.inspect();
      const running = info.State?.Running ?? false;
      const dbStatus = running ? "running" : "stopped";

      if (session.status !== dbStatus) {
        dbUpdateSession(id, { status: dbStatus });
      }

      return { id, status: dbStatus, running };
    } catch {
      dbUpdateSession(id, { status: "error" });
      return { id, status: "error", running: false };
    }
  }

  return { id, status: session.status, running: false };
}

/**
 * Read credentials from a session container.
 * Supports Claude (.claude/.credentials.json) and Codex (.codex/credentials.json).
 */
export async function importCredentials(id: string): Promise<{
  provider: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  externalAccountId?: string;
} | null> {
  const session = dbGetSession(id);
  if (!session?.container_id) throw new Error("Session not found or no container");

  const container = docker.getContainer(session.container_id);

  // Try Claude credentials first
  const claudeCreds = await readContainerFile(container, "/home/node/.claude/.credentials.json");
  if (claudeCreds) {
    try {
      const json = JSON.parse(claudeCreds);
      const oauth = json.claudeAiOauth;
      if (oauth?.accessToken) {
        return {
          provider: "anthropic",
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken || "",
          expiresAt: oauth.expiresAt || 0,
        };
      }
    } catch { /* not valid JSON */ }
  }

  // Try Codex credentials (~/.codex/auth.json)
  const codexCreds = await readContainerFile(container, "/home/node/.codex/auth.json");
  if (codexCreds) {
    try {
      const json = JSON.parse(codexCreds);
      // Codex stores: { tokens: { access_token, refresh_token, id_token, account_id }, last_refresh }
      const tokens = json.tokens || json;
      if (tokens.access_token) {
        return {
          provider: "openai",
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || "",
          expiresAt: 0, // Codex doesn't store expiry, refreshed on demand
          externalAccountId: tokens.account_id || undefined,
        };
      }
    } catch { /* not valid JSON */ }
  }

  return null;
}

/**
 * Read a file from inside a container. Returns null if not found.
 */
async function readContainerFile(container: Docker.Container, filePath: string): Promise<string | null> {
  try {
    const exec = await container.exec({
      Cmd: ["cat", filePath],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ Detach: false, Tty: false });
    const chunks: Buffer[] = [];

    return new Promise((resolve) => {
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString("utf-8");
        const jsonStart = text.indexOf("{");
        if (jsonStart === -1) {
          resolve(null);
          return;
        }
        resolve(text.slice(jsonStart));
      });
      stream.on("error", () => resolve(null));
    });
  } catch {
    return null;
  }
}

/**
 * Sync credentials from all linked running sessions to their accounts.
 * Called periodically to keep tokens fresh.
 */
async function syncLinkedSessions(): Promise<void> {
  const linked = getLinkedSessions();
  if (linked.length === 0) return;

  for (const session of linked) {
    if (!session.account_id || !session.container_id) continue;

    try {
      const creds = await importCredentials(session.id);
      if (creds && creds.accessToken) {
        updateAccountTokens(
          session.account_id,
          creds.accessToken,
          creds.refreshToken || "",
          creds.expiresAt || 0,
          creds.externalAccountId,
        );
        dbUpdateSession(session.id, {}); // touch last_active_at
        console.log(`[sessions] Synced tokens from session "${session.name}" → account ${session.account_id}`);
      }
    } catch (err) {
      console.error(`[sessions] Failed to sync session "${session.name}":`, err);
    }
  }
}

export function listSessions() {
  return dbGetSessions();
}

export async function initSessionManager(): Promise<void> {
  const sessions = dbGetSessions();

  // Track used ports and restart linked sessions
  let restarted = 0;
  for (const s of sessions) {
    if (s.port && s.status === "running") {
      usedPorts.add(s.port);
    }

    // Restart linked sessions that should be running
    if (s.account_id && s.status !== "stopped") {
      const ok = await restartSession(s.id);
      if (ok) restarted++;
    }
  }

  console.log(`[sessions] Initialized with ${usedPorts.size} active ports, restarted ${restarted} linked sessions`);

  // Start periodic credential sync
  syncInterval = setInterval(() => {
    syncLinkedSessions().catch((err) => {
      console.error("[sessions] Credential sync error:", err);
    });
  }, CREDENTIAL_SYNC_INTERVAL);

  // Run first sync after a short delay
  setTimeout(() => syncLinkedSessions().catch(() => {}), 5000);
}
