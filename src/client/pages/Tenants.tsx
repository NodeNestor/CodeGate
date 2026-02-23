import React, { useEffect, useState, useCallback } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  Key,
  Copy,
  Check,
  Shield,
  Users,
  RefreshCw,
  Settings,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import Modal from "../components/ui/Modal";
import Toggle from "../components/ui/Toggle";
import { Input, Select } from "../components/ui/Input";
import {
  getTenants,
  createTenant,
  updateTenant,
  deleteTenant,
  rotateTenantKey,
  getTenantDetail,
  updateTenantSettings,
  deleteTenantSetting,
  getConfigs,
  type Tenant,
  type Config,
} from "../lib/api";

export default function Tenants() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [configs, setConfigs] = useState<Config[]>([]);
  const [loading, setLoading] = useState(true);

  // Create modal
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newConfigId, setNewConfigId] = useState("");
  const [newRateLimit, setNewRateLimit] = useState("0");
  const [creating, setCreating] = useState(false);

  // Edit modal
  const [editOpen, setEditOpen] = useState(false);
  const [editTenant, setEditTenant] = useState<Tenant | null>(null);
  const [editName, setEditName] = useState("");
  const [editConfigId, setEditConfigId] = useState("");
  const [editRateLimit, setEditRateLimit] = useState("0");
  const [editEnabled, setEditEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  // API key display modal
  const [keyModalOpen, setKeyModalOpen] = useState(false);
  const [displayKey, setDisplayKey] = useState("");
  const [keyWarning, setKeyWarning] = useState("");
  const [copied, setCopied] = useState(false);

  // Delete confirmation
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingTenant, setDeletingTenant] = useState<Tenant | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Rotate key
  const [rotatingId, setRotatingId] = useState<string | null>(null);

  // Settings panel
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTenant, setSettingsTenant] = useState<Tenant | null>(null);
  const [tenantSettings, setTenantSettings] = useState<Record<string, string>>({});
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [newSettingKey, setNewSettingKey] = useState("");
  const [newSettingValue, setNewSettingValue] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);

  // Error state
  const [error, setError] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [t, c] = await Promise.all([getTenants(), getConfigs()]);
      setTenants(t);
      setConfigs(c);
    } catch (err: any) {
      console.error("Failed to load tenants:", err);
      setError(err.message || "Failed to load tenants");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function getConfigName(configId: string | null): string {
    if (!configId) return "Global Config";
    const config = configs.find((c) => c.id === configId);
    return config ? config.name : "Unknown Config";
  }

  // ── Create ──────────────────────────────────────────────────────────────────

  function openCreate() {
    setNewName("");
    setNewConfigId("");
    setNewRateLimit("0");
    setCreateOpen(true);
  }

  async function handleCreate() {
    setCreating(true);
    setError("");
    try {
      const result = await createTenant({
        name: newName,
        config_id: newConfigId || undefined,
        rate_limit: parseInt(newRateLimit, 10) || 0,
      });
      setCreateOpen(false);
      setDisplayKey(result.api_key);
      setKeyWarning(result.warning);
      setKeyModalOpen(true);
      await loadData();
    } catch (err: any) {
      setError(err.message || "Failed to create tenant");
    } finally {
      setCreating(false);
    }
  }

  // ── Edit ─────────────────────────────────────────────────────────────────────

  function openEdit(tenant: Tenant) {
    setEditTenant(tenant);
    setEditName(tenant.name);
    setEditConfigId(tenant.config_id || "");
    setEditRateLimit(String(tenant.rate_limit));
    setEditEnabled(tenant.enabled === 1);
    setEditOpen(true);
  }

  async function handleSaveEdit() {
    if (!editTenant) return;
    setSaving(true);
    setError("");
    try {
      await updateTenant(editTenant.id, {
        name: editName,
        config_id: editConfigId || null,
        rate_limit: parseInt(editRateLimit, 10) || 0,
        enabled: editEnabled ? 1 : 0,
      });
      setEditOpen(false);
      setEditTenant(null);
      await loadData();
    } catch (err: any) {
      setError(err.message || "Failed to update tenant");
    } finally {
      setSaving(false);
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  function openDelete(tenant: Tenant) {
    setDeletingTenant(tenant);
    setDeleteOpen(true);
  }

  async function handleDelete() {
    if (!deletingTenant) return;
    setDeleting(true);
    setError("");
    try {
      await deleteTenant(deletingTenant.id);
      setDeleteOpen(false);
      setDeletingTenant(null);
      setTenants((prev) => prev.filter((t) => t.id !== deletingTenant.id));
    } catch (err: any) {
      setError(err.message || "Failed to delete tenant");
    } finally {
      setDeleting(false);
    }
  }

  // ── Rotate Key ──────────────────────────────────────────────────────────────

  async function handleRotateKey(tenant: Tenant) {
    setRotatingId(tenant.id);
    setError("");
    try {
      const result = await rotateTenantKey(tenant.id);
      setDisplayKey(result.api_key);
      setKeyWarning(result.warning);
      setKeyModalOpen(true);
      await loadData();
    } catch (err: any) {
      setError(err.message || "Failed to rotate key");
    } finally {
      setRotatingId(null);
    }
  }

  // ── Copy Key ────────────────────────────────────────────────────────────────

  async function handleCopyKey() {
    try {
      await navigator.clipboard.writeText(displayKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for insecure contexts
      const ta = document.createElement("textarea");
      ta.value = displayKey;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  async function openSettings(tenant: Tenant) {
    setSettingsTenant(tenant);
    setSettingsOpen(true);
    setLoadingSettings(true);
    setNewSettingKey("");
    setNewSettingValue("");
    try {
      const detail = await getTenantDetail(tenant.id);
      setTenantSettings(detail.settings || {});
    } catch {
      setTenantSettings({});
    } finally {
      setLoadingSettings(false);
    }
  }

  async function handleAddSetting() {
    if (!settingsTenant || !newSettingKey.trim()) return;
    setSavingSettings(true);
    try {
      const updated = await updateTenantSettings(settingsTenant.id, {
        ...tenantSettings,
        [newSettingKey.trim()]: newSettingValue,
      });
      setTenantSettings(updated);
      setNewSettingKey("");
      setNewSettingValue("");
    } catch (err: any) {
      setError(err.message || "Failed to add setting");
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleDeleteSetting(key: string) {
    if (!settingsTenant) return;
    try {
      await deleteTenantSetting(settingsTenant.id, key);
      setTenantSettings((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (err: any) {
      setError(err.message || "Failed to delete setting");
    }
  }

  // ── Config options for dropdowns ────────────────────────────────────────────

  const configOptions = [
    { value: "", label: "Use Global Config" },
    ...configs.map((c) => ({ value: c.id, label: c.name })),
  ];

  // ── Loading state ──────────────────────────────────────────────────────────

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
          <h1 className="text-2xl font-bold text-gray-100">Tenants</h1>
          {tenants.length > 0 && (
            <span className="text-sm text-gray-500">
              {tenants.length} tenant{tenants.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" />
          Create Tenant
        </Button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
          <button
            onClick={() => setError("")}
            className="ml-auto text-red-400 hover:text-red-300"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Status summary */}
      {tenants.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5">
            <Badge variant="success">Enabled</Badge>
            <span className="text-sm text-gray-400">
              {tenants.filter((t) => t.enabled === 1).length}
            </span>
          </div>
          {tenants.some((t) => t.enabled === 0) && (
            <div className="flex items-center gap-1.5">
              <Badge variant="default">Disabled</Badge>
              <span className="text-sm text-gray-400">
                {tenants.filter((t) => t.enabled === 0).length}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Tenant list or empty state */}
      {tenants.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-gray-500 space-y-4">
          <Users className="h-12 w-12 text-gray-600" />
          <p className="text-lg">No tenants configured.</p>
          <p className="text-sm">
            Create a tenant to issue API keys for external access.
          </p>
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" />
            Create Tenant
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {tenants.map((tenant) => (
            <div
              key={tenant.id}
              className={`bg-gray-900 border rounded-xl p-5 transition-colors ${
                tenant.enabled === 1
                  ? "border-gray-800"
                  : "border-gray-800 opacity-60"
              }`}
            >
              {/* Card header */}
              <div className="flex items-start justify-between mb-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-base font-semibold text-gray-100 truncate">
                      {tenant.name}
                    </h3>
                    <Badge
                      variant={tenant.enabled === 1 ? "success" : "default"}
                    >
                      {tenant.enabled === 1 ? "Enabled" : "Disabled"}
                    </Badge>
                  </div>
                </div>
              </div>

              {/* Details */}
              <div className="space-y-2 mb-4">
                <div className="flex items-center gap-2 text-sm">
                  <Key className="h-3.5 w-3.5 text-gray-500 shrink-0" />
                  <span className="text-gray-400">Key:</span>
                  <Badge variant="info">{tenant.api_key_prefix}...</Badge>
                </div>

                <div className="flex items-center gap-2 text-sm">
                  <Shield className="h-3.5 w-3.5 text-gray-500 shrink-0" />
                  <span className="text-gray-400">Config:</span>
                  <span className="text-gray-200">
                    {getConfigName(tenant.config_id)}
                  </span>
                </div>

                <div className="flex items-center gap-2 text-sm">
                  <RefreshCw className="h-3.5 w-3.5 text-gray-500 shrink-0" />
                  <span className="text-gray-400">Rate limit:</span>
                  <span className="text-gray-200">
                    {tenant.rate_limit > 0
                      ? `${tenant.rate_limit} req/min`
                      : "Unlimited"}
                  </span>
                </div>

                <div className="text-xs text-gray-600">
                  Created {new Date(tenant.created_at).toLocaleDateString()}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1.5 border-t border-gray-800 pt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openEdit(tenant)}
                  title="Edit tenant"
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRotateKey(tenant)}
                  loading={rotatingId === tenant.id}
                  title="Rotate API key"
                >
                  <Key className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openSettings(tenant)}
                  title="Tenant settings"
                >
                  <Settings className="h-4 w-4" />
                </Button>
                <div className="flex-1" />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openDelete(tenant)}
                  title="Delete tenant"
                >
                  <Trash2 className="h-4 w-4 text-red-400" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Create Tenant Modal ─────────────────────────────────────────────── */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create Tenant"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              loading={creating}
              disabled={!newName.trim()}
            >
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="My Tenant"
            required
          />
          <Select
            label="Configuration"
            value={newConfigId}
            onChange={(e) => setNewConfigId(e.target.value)}
            options={configOptions}
          />
          <Input
            label="Rate Limit (req/min, 0 = unlimited)"
            type="number"
            value={newRateLimit}
            onChange={(e) => setNewRateLimit(e.target.value)}
            min={0}
          />
        </div>
      </Modal>

      {/* ── Edit Tenant Modal ───────────────────────────────────────────────── */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit Tenant"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveEdit}
              loading={saving}
              disabled={!editName.trim()}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Name"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder="Tenant name"
            required
          />
          <Select
            label="Configuration"
            value={editConfigId}
            onChange={(e) => setEditConfigId(e.target.value)}
            options={configOptions}
          />
          <Input
            label="Rate Limit (req/min, 0 = unlimited)"
            type="number"
            value={editRateLimit}
            onChange={(e) => setEditRateLimit(e.target.value)}
            min={0}
          />
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-300">Enabled</span>
            <Toggle
              checked={editEnabled}
              onChange={setEditEnabled}
            />
          </div>
        </div>
      </Modal>

      {/* ── API Key Display Modal ───────────────────────────────────────────── */}
      <Modal
        open={keyModalOpen}
        onClose={() => {
          setKeyModalOpen(false);
          setDisplayKey("");
          setKeyWarning("");
          setCopied(false);
        }}
        title="API Key"
        footer={
          <Button
            variant="secondary"
            onClick={() => {
              setKeyModalOpen(false);
              setDisplayKey("");
              setKeyWarning("");
              setCopied(false);
            }}
          >
            Done
          </Button>
        }
      >
        <div className="space-y-4">
          <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/20 p-3 text-sm text-yellow-400 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              {keyWarning ||
                "This API key will only be shown once. Copy it now and store it securely."}
            </span>
          </div>

          <div className="relative">
            <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 font-mono text-sm text-gray-100 break-all select-all">
              {displayKey}
            </div>
            <button
              onClick={handleCopyKey}
              className="absolute top-2 right-2 p-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-gray-100 transition-colors"
              title="Copy to clipboard"
            >
              {copied ? (
                <Check className="h-4 w-4 text-green-400" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </Modal>

      {/* ── Delete Confirmation Modal ───────────────────────────────────────── */}
      <Modal
        open={deleteOpen}
        onClose={() => {
          setDeleteOpen(false);
          setDeletingTenant(null);
        }}
        title="Delete Tenant"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDeleteOpen(false);
                setDeletingTenant(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} loading={deleting}>
              Delete
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-gray-300">
            Are you sure you want to delete tenant{" "}
            <span className="font-semibold text-gray-100">
              {deletingTenant?.name}
            </span>
            ?
          </p>
          <p className="text-sm text-gray-400">
            This will revoke the tenant's API key and remove all associated
            settings. This action cannot be undone.
          </p>
        </div>
      </Modal>

      {/* ── Settings Modal ──────────────────────────────────────────────────── */}
      <Modal
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsTenant(null);
          setTenantSettings({});
        }}
        title={`Settings: ${settingsTenant?.name || ""}`}
        maxWidth="max-w-xl"
        footer={
          <Button
            variant="secondary"
            onClick={() => {
              setSettingsOpen(false);
              setSettingsTenant(null);
              setTenantSettings({});
            }}
          >
            Close
          </Button>
        }
      >
        {loadingSettings ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-brand-500" />
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-gray-400">
              Override global settings for this tenant. These settings take
              precedence over the global configuration.
            </p>

            {/* Existing settings */}
            {Object.keys(tenantSettings).length > 0 ? (
              <div className="space-y-2">
                {Object.entries(tenantSettings).map(([key, value]) => (
                  <div
                    key={key}
                    className="flex items-center gap-3 bg-gray-800 rounded-lg px-3 py-2"
                  >
                    <span className="text-sm font-mono text-brand-400 min-w-0 truncate">
                      {key}
                    </span>
                    <span className="text-gray-600">=</span>
                    <span className="text-sm text-gray-200 flex-1 min-w-0 truncate">
                      {value}
                    </span>
                    <button
                      onClick={() => handleDeleteSetting(key)}
                      className="text-gray-500 hover:text-red-400 shrink-0 transition-colors"
                      title="Remove setting"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-gray-500 py-2">
                No setting overrides. This tenant uses global defaults.
              </div>
            )}

            {/* Add new setting */}
            <div className="border-t border-gray-800 pt-4">
              <p className="text-sm font-medium text-gray-300 mb-2">
                Add Setting Override
              </p>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Input
                    label="Key"
                    value={newSettingKey}
                    onChange={(e) => setNewSettingKey(e.target.value)}
                    placeholder="e.g. privacy_enabled"
                  />
                </div>
                <div className="flex-1">
                  <Input
                    label="Value"
                    value={newSettingValue}
                    onChange={(e) => setNewSettingValue(e.target.value)}
                    placeholder="e.g. true"
                  />
                </div>
                <Button
                  size="sm"
                  onClick={handleAddSetting}
                  disabled={!newSettingKey.trim()}
                  loading={savingSettings}
                >
                  <Plus className="h-4 w-4" />
                  Add
                </Button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
