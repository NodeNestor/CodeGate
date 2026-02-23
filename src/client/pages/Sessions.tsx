import React, { useEffect, useState } from "react";
import { Plus, Terminal, Loader2 } from "lucide-react";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import {
  getSessions,
  getAccounts,
  createSession,
  deleteSession,
  stopSession,
  importCredentials,
  type Session,
  type Account,
} from "../lib/api";

function getSessionStatusVariant(
  status: string
): "success" | "warning" | "default" {
  switch (status) {
    case "running":
      return "success";
    case "starting":
      return "warning";
    case "stopped":
    default:
      return "default";
  }
}

function getSessionStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "Running";
    case "starting":
      return "Starting";
    case "stopped":
      return "Stopped";
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

export default function Sessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);

  useEffect(() => {
    loadSessions();
  }, []);

  async function loadSessions() {
    setLoading(true);
    try {
      const [s, a] = await Promise.all([getSessions(), getAccounts()]);
      setSessions(s);
      setAccounts(a);
    } catch (err) {
      console.error("Failed to load sessions:", err);
    } finally {
      setLoading(false);
    }
  }

  function getLinkedAccountName(accountId: string | null): string | null {
    if (!accountId) return null;
    const account = accounts.find((a) => a.id === accountId);
    return account?.name || accountId.slice(0, 8);
  }

  async function handleCreate() {
    const name = prompt("Enter a name for the new session:");
    if (!name || !name.trim()) return;
    try {
      await createSession(name.trim());
      await loadSessions();
    } catch (err) {
      console.error("Failed to create session:", err);
      alert("Failed to create session. Check the console for details.");
    }
  }

  async function handleStop(id: string) {
    const session = sessions.find((s) => s.id === id);
    const linkedName = session?.account_id ? getLinkedAccountName(session.account_id) : null;
    const msg = linkedName
      ? `This session is linked to account "${linkedName}" for token refresh. Stop it anyway?`
      : "Are you sure you want to stop this session?";
    if (!confirm(msg)) return;
    setStoppingId(id);
    try {
      await deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      console.error("Failed to stop session:", err);
    } finally {
      setStoppingId(null);
    }
  }

  async function handleImportCredentials(id: string) {
    setImportingId(id);
    try {
      const result = await importCredentials(id);
      if (result.success) {
        alert(
          result.account
            ? `Credentials imported successfully for account: ${result.account.name || result.account.id}`
            : "Credentials imported successfully."
        );
      } else {
        alert(`Import failed: ${result.error || "Unknown error"}`);
      }
    } catch (err: any) {
      alert(`Import failed: ${err.message || "Unknown error"}`);
    } finally {
      setImportingId(null);
    }
  }

  function handleOpenTerminal(port: number | null) {
    if (!port) {
      alert("No port assigned to this session yet.");
      return;
    }
    window.open(`http://localhost:${port}`, "_blank");
  }

  function formatTime(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleString();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-gray-100">Sessions</h1>
          {sessions.length > 0 && (
            <span className="text-sm text-gray-500">
              {sessions.length} session{sessions.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <Button onClick={handleCreate}>
          <Plus className="h-4 w-4" />
          New Session
        </Button>
      </div>

      {/* Session list or empty state */}
      {sessions.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-gray-500 space-y-4">
          <Terminal className="h-12 w-12 text-gray-600" />
          <p className="text-lg">No active sessions.</p>
          <p className="text-sm">
            Create a new terminal session to get started.
          </p>
          <Button onClick={handleCreate}>
            <Plus className="h-4 w-4" />
            New Session
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {sessions.map((session) => (
            <Card key={session.id} className="hover:border-gray-700 transition-colors">
              <div className="flex items-start justify-between mb-3">
                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-semibold text-gray-100 truncate">
                    {session.name}
                  </h3>
                  <p className="text-xs text-gray-500 mt-1">
                    Created {formatTime(session.created_at)}
                  </p>
                </div>
                <Badge variant={getSessionStatusVariant(session.status)}>
                  {getSessionStatusLabel(session.status)}
                </Badge>
              </div>

              {session.account_id && (
                <p className="text-xs text-gray-500 mb-1">
                  Linked to:{" "}
                  <span className="text-brand-400 font-medium">
                    {getLinkedAccountName(session.account_id)}
                  </span>
                </p>
              )}

              {session.port && (
                <p className="text-xs text-gray-500 mb-4">
                  Port:{" "}
                  <span className="text-gray-300 font-mono">
                    {session.port}
                  </span>
                </p>
              )}

              <div className="flex items-center gap-2 mt-auto pt-3 border-t border-gray-800">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => handleOpenTerminal(session.port)}
                  disabled={!session.port || session.status !== "running"}
                >
                  <Terminal className="h-3.5 w-3.5" />
                  Open Terminal
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => handleImportCredentials(session.id)}
                  loading={importingId === session.id}
                  disabled={session.status !== "running"}
                >
                  Import Credentials
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => handleStop(session.id)}
                  loading={stoppingId === session.id}
                >
                  Stop
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
