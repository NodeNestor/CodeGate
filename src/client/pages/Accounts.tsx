import React, { useEffect, useState } from "react";
import AccountCard from "../components/AccountCard";
import AccountForm from "../components/AccountForm";
import ConnectAccountWizard from "../components/ConnectAccountWizard";
import Button from "../components/ui/Button";
import Badge, { getStatusVariant, getStatusLabel } from "../components/ui/Badge";
import { Plus, Search, Loader2, AlertTriangle, Users } from "lucide-react";
import {
  getAccounts,
  updateAccount,
  deleteAccount,
  toggleAccount,
  testAccount,
  getSessions,
  type Account,
  type Session,
} from "../lib/api";

export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<{
    id: string;
    ok: boolean;
    text: string;
  } | null>(null);

  useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    setLoading(true);
    try {
      const [accts, sess] = await Promise.all([getAccounts(), getSessions()]);
      setAccounts(accts);
      setSessions(sess);
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

  // Map account_id → session for OAuth session indicators
  const sessionByAccountId = new Map<string, Session>();
  for (const s of sessions) {
    if (s.account_id) sessionByAccountId.set(s.account_id, s);
  }

  function openEdit(account: Account) {
    setEditingAccount(account);
    setFormOpen(true);
  }

  async function handleSave(data: Partial<Account> & { api_key?: string }) {
    if (editingAccount) {
      await updateAccount(editingAccount.id, data);
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
        <Button onClick={() => setWizardOpen(true)}>
          <Plus className="h-4 w-4" />
          Connect Account
        </Button>
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
            Connect a provider via API key or terminal login.
          </p>
          <Button onClick={() => setWizardOpen(true)}>
            <Plus className="h-4 w-4" />
            Connect Account
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              session={sessionByAccountId.get(account.id) || null}
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

      {/* Form modal (editing existing accounts only) */}
      <AccountForm
        open={formOpen}
        account={editingAccount}
        onClose={() => setFormOpen(false)}
        onSave={handleSave}
      />

      {/* Connect Account Wizard */}
      <ConnectAccountWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onAccountCreated={loadAccounts}
      />
    </div>
  );
}
