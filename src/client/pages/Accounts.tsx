import React, { useEffect, useState } from "react";
import AccountCard from "../components/AccountCard";
import AccountForm from "../components/AccountForm";
import Button from "../components/ui/Button";
import Modal from "../components/ui/Modal";
import Badge, { getStatusVariant, getStatusLabel } from "../components/ui/Badge";
import { Plus, Search, Terminal, Loader2, AlertTriangle, Users } from "lucide-react";
import {
  getAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  toggleAccount,
  testAccount,
  createSession,
  deleteSession,
  importCredentials,
  type Account,
} from "../lib/api";

export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [search, setSearch] = useState("");
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<{
    id: string;
    ok: boolean;
    text: string;
  } | null>(null);

  // Terminal login flow state
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [loginSessionId, setLoginSessionId] = useState<string | null>(null);
  const [loginSessionPort, setLoginSessionPort] = useState<number | null>(null);
  const [loginStarting, setLoginStarting] = useState(false);
  const [loginImporting, setLoginImporting] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loginSuccess, setLoginSuccess] = useState("");

  useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    setLoading(true);
    try {
      setAccounts(await getAccounts());
    } catch (err) {
      console.error("Failed to load accounts:", err);
    } finally {
      setLoading(false);
    }
  }

  // Status counts
  const statusCounts: Record<string, number> = {};
  for (const a of accounts) {
    const s = a.status || "unknown";
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }

  // Filtered accounts
  const filtered = search.trim()
    ? accounts.filter(
        (a) =>
          a.name.toLowerCase().includes(search.toLowerCase()) ||
          a.provider.toLowerCase().includes(search.toLowerCase()) ||
          (a.account_email || "").toLowerCase().includes(search.toLowerCase())
      )
    : accounts;

  function openCreate() {
    setEditingAccount(null);
    setFormOpen(true);
  }

  function openEdit(account: Account) {
    setEditingAccount(account);
    setFormOpen(true);
  }

  async function handleSave(data: Partial<Account> & { api_key?: string }) {
    if (editingAccount) {
      await updateAccount(editingAccount.id, data);
    } else {
      await createAccount(data);
    }
    await loadAccounts();
  }

  async function handleToggle(id: string) {
    try {
      const updated = await toggleAccount(id);
      setAccounts((prev) =>
        prev.map((a) => (a.id === id ? { ...a, enabled: updated.enabled } : a))
      );
    } catch (err) {
      console.error("Toggle failed:", err);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this account?")) return;
    try {
      await deleteAccount(id);
      setAccounts((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      console.error("Delete failed:", err);
    }
  }

  async function handleTest(id: string) {
    setTestingId(id);
    setTestMsg(null);
    try {
      const res = await testAccount(id);
      setTestMsg({ id, ok: res.success, text: res.message });
    } catch (err: any) {
      setTestMsg({ id, ok: false, text: err.message || "Test failed" });
    } finally {
      setTestingId(null);
    }
  }

  // ── Terminal Login Flow ──────────────────────────────────────────────────

  async function startLoginSession() {
    setLoginStarting(true);
    setLoginError("");
    setLoginSuccess("");
    try {
      const session = await createSession("oauth-login");
      setLoginSessionId(session.id);
      setLoginSessionPort(session.port);
      setLoginModalOpen(true);
    } catch (err: any) {
      setLoginError(err.message || "Failed to start terminal session");
      setLoginModalOpen(true);
    } finally {
      setLoginStarting(false);
    }
  }

  async function handleImportFromSession() {
    if (!loginSessionId) return;
    setLoginImporting(true);
    setLoginError("");
    try {
      const result = await importCredentials(loginSessionId);
      if (result.success) {
        setLoginSuccess(
          `Account imported successfully${result.account?.name ? `: ${result.account.name}` : ""}! The session will keep running to refresh tokens automatically.`
        );
        await loadAccounts();
      } else {
        setLoginError(
          result.error ||
            "No credentials found. Run 'claude login' in the terminal first."
        );
      }
    } catch (err: any) {
      setLoginError(err.message || "Import failed");
    } finally {
      setLoginImporting(false);
    }
  }

  async function closeLoginModal() {
    // Only delete the session if credentials were NOT imported.
    // If credentials were imported, the session stays alive for persistent token refresh.
    if (loginSessionId && !loginSuccess) {
      try {
        await deleteSession(loginSessionId);
      } catch {
        // Already gone, that's fine
      }
    }
    setLoginModalOpen(false);
    setLoginSessionId(null);
    setLoginSessionPort(null);
    setLoginError("");
    setLoginSuccess("");
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
          <h1 className="text-2xl font-bold text-gray-100">Accounts</h1>
          {accounts.length > 0 && (
            <span className="text-sm text-gray-500">
              {accounts.length} account{accounts.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={startLoginSession} loading={loginStarting}>
            <Terminal className="h-4 w-4" />
            Login via Terminal
          </Button>
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" />
            Add Account
          </Button>
        </div>
      </div>

      {/* Status summary */}
      {accounts.length > 0 && Object.keys(statusCounts).length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          {Object.entries(statusCounts)
            .sort(([a], [b]) => {
              if (a === "active") return -1;
              if (b === "active") return 1;
              return a.localeCompare(b);
            })
            .map(([status, count]) => (
              <div key={status} className="flex items-center gap-1.5">
                <Badge variant={getStatusVariant(status)}>
                  {getStatusLabel(status)}
                </Badge>
                <span className="text-sm text-gray-400">{count}</span>
              </div>
            ))}
        </div>
      )}

      {/* Decrypt error warning */}
      {accounts.some((a) => a.decrypt_error) && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Some accounts have decryption errors. Their API keys could not be read — re-enter the key or rotate the account encryption key in{" "}
            <a href="/settings" className="underline hover:text-red-300">Settings</a>.
          </span>
        </div>
      )}

      {/* Search */}
      {accounts.length > 3 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search accounts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="block w-full rounded-lg border border-gray-700 bg-gray-800 pl-10 pr-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
          />
        </div>
      )}

      {/* Account list or empty state */}
      {accounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-gray-500 space-y-4">
          <Users className="h-12 w-12 text-gray-600" />
          <p className="text-lg">No accounts configured.</p>
          <p className="text-sm">
            Add an API key account or login via terminal for OAuth.
          </p>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={startLoginSession} loading={loginStarting}>
              Login via Terminal
            </Button>
            <Button onClick={openCreate}>Add Account</Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              onToggle={handleToggle}
              onEdit={openEdit}
              onDelete={handleDelete}
              onTest={handleTest}
              testing={testingId === account.id}
              testResult={testMsg?.id === account.id ? testMsg : null}
            />
          ))}
        </div>
      )}

      {/* Form modal (API key accounts) */}
      <AccountForm
        open={formOpen}
        account={editingAccount}
        onClose={() => setFormOpen(false)}
        onSave={handleSave}
      />

      {/* Terminal Login Modal */}
      <Modal
        open={loginModalOpen}
        onClose={closeLoginModal}
        title="Login via Terminal"
        maxWidth="max-w-4xl"
        footer={
          <>
            <Button variant="secondary" onClick={closeLoginModal}>
              Close
            </Button>
            <Button
              onClick={handleImportFromSession}
              loading={loginImporting}
              disabled={!loginSessionId}
            >
              Import Credentials
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="rounded-lg bg-blue-500/10 border border-blue-500/20 p-3 text-sm text-blue-300">
            <p className="font-medium mb-2">Choose a service to log into:</p>
            <div className="space-y-3">
              <div>
                <p className="font-medium text-blue-200">Claude (Anthropic)</p>
                <ol className="list-decimal list-inside space-y-0.5 text-blue-300/80 ml-2">
                  <li>Run <code className="bg-blue-500/20 px-1 rounded">claude login</code></li>
                  <li>Complete the OAuth flow in the browser that opens</li>
                  <li>Click <strong className="text-blue-300">Import Credentials</strong> above</li>
                </ol>
              </div>
              <div>
                <p className="font-medium text-blue-200">Codex (OpenAI / ChatGPT)</p>
                <ol className="list-decimal list-inside space-y-0.5 text-blue-300/80 ml-2">
                  <li>First, enable <strong className="text-blue-300">cross-device login</strong> in your <a href="https://chatgpt.com/settings" target="_blank" rel="noopener noreferrer" className="underline hover:text-blue-200">ChatGPT security settings</a></li>
                  <li>Run <code className="bg-blue-500/20 px-1 rounded">codex login --device-auth</code></li>
                  <li>Open the link shown, sign in, and enter the code</li>
                  <li>Click <strong className="text-blue-300">Import Credentials</strong> above</li>
                </ol>
              </div>
            </div>
            <p className="text-xs text-blue-400/60 mt-2">
              Tip: Select text with your mouse to copy. Right-click to paste.
            </p>
          </div>

          {loginError && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
              {loginError}
            </div>
          )}

          {loginSuccess && (
            <div className="rounded-lg bg-green-500/10 border border-green-500/20 p-3 text-sm text-green-400">
              {loginSuccess}
            </div>
          )}

          {/* Embedded terminal */}
          {loginSessionPort ? (
            <div className="rounded-lg overflow-hidden border border-gray-700">
              <iframe
                src={`http://localhost:${loginSessionPort}`}
                className="w-full bg-black"
                style={{ height: "400px" }}
                title="Login Terminal"
              />
            </div>
          ) : loginError ? (
            <div className="flex items-center justify-center h-64 text-gray-500">
              <p>Failed to start terminal session.</p>
            </div>
          ) : (
            <div className="flex items-center justify-center h-64 text-gray-500">
              <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
