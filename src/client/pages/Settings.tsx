import React, { useEffect, useState } from "react";
import { Copy, Check, Loader2 } from "lucide-react";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import Toggle from "../components/ui/Toggle";
import { Input, Select } from "../components/ui/Input";
import {
  getSettings,
  updateSettings,
  getModelLimits,
  setModelLimit,
  deleteModelLimit,
  getEncryptionInfo,
  rotateAccountKey,
  rotateGuardrailKey,
  getTenants,
  type ModelLimitsInfo,
  type EncryptionInfo,
} from "../lib/api";

export default function Settings() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Model limits
  const [modelLimits, setModelLimits] = useState<
    Record<string, ModelLimitsInfo>
  >({});
  const [newModelId, setNewModelId] = useState("");
  const [newMaxTokens, setNewMaxTokens] = useState("");
  const [newToolCalling, setNewToolCalling] = useState<string>("unset");
  const [newReasoning, setNewReasoning] = useState<string>("unset");

  // Encryption keys
  const [encryptionInfo, setEncryptionInfo] = useState<EncryptionInfo | null>(null);
  const [rotatingAccount, setRotatingAccount] = useState(false);
  const [rotatingGuardrail, setRotatingGuardrail] = useState(false);
  const [rotateMsg, setRotateMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Editable ports
  const [editProxyPort, setEditProxyPort] = useState("");
  const [editUiPort, setEditUiPort] = useState("");
  const [portSaving, setPortSaving] = useState(false);
  const [portMsg, setPortMsg] = useState("");

  // Tenant count
  const [tenantCount, setTenantCount] = useState<number | null>(null);

  useEffect(() => {
    loadSettings();
    loadModelLimits();
    loadEncryptionInfo();
    loadTenantCount();
  }, []);

  async function loadSettings() {
    setLoading(true);
    try {
      setSettings(await getSettings());
    } catch (err) {
      console.error("Failed to load settings:", err);
    } finally {
      setLoading(false);
    }
  }

  async function loadModelLimits() {
    try {
      setModelLimits(await getModelLimits());
    } catch {
      // ignore
    }
  }

  async function loadEncryptionInfo() {
    try {
      setEncryptionInfo(await getEncryptionInfo());
    } catch {
      // ignore
    }
  }

  async function loadTenantCount() {
    try {
      const t = await getTenants();
      setTenantCount(t.length);
    } catch {
      // ignore
    }
  }

  async function handleRotateAccountKey() {
    if (!confirm("Rotate account encryption key? All accounts will be re-encrypted with the new key.")) return;
    setRotatingAccount(true);
    setRotateMsg(null);
    try {
      const result = await rotateAccountKey();
      setRotateMsg({
        ok: true,
        text: `Account key rotated. ${result.re_encrypted} account(s) re-encrypted${result.failed ? `, ${result.failed} failed` : ""}.`,
      });
      await loadEncryptionInfo();
    } catch (err: any) {
      setRotateMsg({ ok: false, text: err.message || "Rotation failed" });
    } finally {
      setRotatingAccount(false);
      setTimeout(() => setRotateMsg(null), 5000);
    }
  }

  async function handleRotateGuardrailKey() {
    if (!confirm("Reroll guardrail seed? This only affects new anonymizations — existing tokens will no longer decrypt.")) return;
    setRotatingGuardrail(true);
    setRotateMsg(null);
    try {
      const result = await rotateGuardrailKey();
      setRotateMsg({ ok: true, text: `Guardrail seed rerolled. New fingerprint: ${result.fingerprint}` });
      await loadEncryptionInfo();
    } catch (err: any) {
      setRotateMsg({ ok: false, text: err.message || "Reroll failed" });
    } finally {
      setRotatingGuardrail(false);
      setTimeout(() => setRotateMsg(null), 5000);
    }
  }

  async function handleSave(updates: Record<string, string>) {
    setSaving(true);
    setSaveMsg(null);
    try {
      await updateSettings(updates);
      setSettings((prev) => ({ ...prev, ...updates }));
      setSaveMsg({ ok: true, text: "Settings saved." });
      setTimeout(() => setSaveMsg(null), 3000);
    } catch (err: any) {
      setSaveMsg({
        ok: false,
        text: err.message || "Failed to save settings.",
      });
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (settings.proxy_port) setEditProxyPort(settings.proxy_port);
    else setEditProxyPort("9112");
    if (settings.ui_port) setEditUiPort(settings.ui_port);
    else setEditUiPort("9111");
  }, [settings]);

  async function handleSavePorts() {
    setPortSaving(true);
    setPortMsg("");
    try {
      const updates: Record<string, string> = {};
      if (editProxyPort !== proxyPort) updates.proxy_port = editProxyPort;
      if (editUiPort !== uiPort) updates.ui_port = editUiPort;
      if (Object.keys(updates).length > 0) {
        await updateSettings(updates);
        setSettings((prev) => ({ ...prev, ...updates }));
        setPortMsg("Port change takes effect after server restart");
        setTimeout(() => setPortMsg(""), 5000);
      }
    } catch (err: any) {
      setPortMsg(err.message || "Failed to save ports");
    } finally {
      setPortSaving(false);
    }
  }

  async function handleToggle(key: string, value: boolean) {
    await handleSave({ [key]: value ? "true" : "false" });
  }

  async function handleAddModelLimit() {
    if (!newModelId.trim()) return;
    try {
      const limits: Partial<ModelLimitsInfo> = {};
      if (newMaxTokens) limits.maxOutputTokens = parseInt(newMaxTokens, 10);
      if (newToolCalling !== "unset")
        limits.supportsToolCalling = newToolCalling === "true";
      if (newReasoning !== "unset")
        limits.supportsReasoning = newReasoning === "true";
      const updated = await setModelLimit(newModelId.trim(), limits);
      setModelLimits(updated);
      setNewModelId("");
      setNewMaxTokens("");
      setNewToolCalling("unset");
      setNewReasoning("unset");
    } catch (err: any) {
      setSaveMsg({ ok: false, text: err.message || "Failed to add limit" });
    }
  }

  async function handleDeleteModelLimit(modelId: string) {
    try {
      const updated = await deleteModelLimit(modelId);
      setModelLimits(updated);
    } catch (err: any) {
      setSaveMsg({ ok: false, text: err.message || "Failed to delete limit" });
    }
  }

  function maskApiKey(key: string): string {
    if (!key || key.length < 8) return key || "Not set";
    return key.slice(0, 4) + "****" + key.slice(-4);
  }

  function handleCopyApiKey() {
    const key = settings.proxy_api_key || settings.api_key || "";
    if (!key) return;
    navigator.clipboard.writeText(key).then(() => {
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
      </div>
    );
  }

  const proxyPort = settings.proxy_port || "9112";
  const uiPort = settings.ui_port || "9111";
  const apiKey = settings.proxy_api_key || settings.api_key || "";
  const autoSwitchOnError =
    (settings.auto_switch_on_error || "true") === "true";
  const autoSwitchOnRateLimit =
    (settings.auto_switch_on_rate_limit || "true") === "true";
  const requestLogging = settings.request_logging === "true";
  const detailedLogging = settings.detailed_request_logging === "true";

  const modelLimitEntries = Object.entries(modelLimits);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-100">Settings</h1>
        <p className="text-sm text-gray-400 mt-1">
          Manage proxy configuration and routing behavior
        </p>
      </div>

      {/* Save feedback */}
      {saveMsg && (
        <div
          className={`text-sm px-4 py-2 rounded-lg ${
            saveMsg.ok
              ? "text-green-400 bg-green-500/10 border border-green-500/20"
              : "text-red-400 bg-red-500/10 border border-red-500/20"
          }`}
        >
          {saveMsg.text}
        </div>
      )}

      {/* Proxy Configuration */}
      <Card title="Proxy Configuration" subtitle="Network ports and endpoints">
        <div className="space-y-4">
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium text-gray-200">Proxy Port</p>
              <p className="text-xs text-gray-500">
                The port the proxy server listens on for API requests
              </p>
            </div>
            <input
              type="number"
              value={editProxyPort}
              onChange={(e) => setEditProxyPort(e.target.value)}
              className="w-24 text-sm font-mono text-gray-300 bg-gray-800 px-3 py-1.5 rounded-lg border border-gray-700 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
            />
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium text-gray-200">UI Port</p>
              <p className="text-xs text-gray-500">
                The port the web dashboard is served on
              </p>
            </div>
            <input
              type="number"
              value={editUiPort}
              onChange={(e) => setEditUiPort(e.target.value)}
              className="w-24 text-sm font-mono text-gray-300 bg-gray-800 px-3 py-1.5 rounded-lg border border-gray-700 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
            />
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium text-gray-200">Proxy URL</p>
              <p className="text-xs text-gray-500">
                Use this URL in your AI tools
              </p>
            </div>
            <code className="text-sm font-mono text-brand-400 bg-gray-800 px-3 py-1.5 rounded-lg">
              http://localhost:{proxyPort}
            </code>
          </div>
          {(editProxyPort !== proxyPort || editUiPort !== uiPort) && (
            <>
              <div className="border-t border-gray-800" />
              <div className="flex items-center justify-between py-2">
                <div>
                  {portMsg && (
                    <p className="text-sm text-yellow-400">{portMsg}</p>
                  )}
                </div>
                <Button size="sm" onClick={handleSavePorts} loading={portSaving}>
                  Save Ports
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>

      {/* API Key */}
      <Card title="API Key" subtitle="Authentication key for proxy access">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <code className="text-sm font-mono text-gray-300 bg-gray-800 px-3 py-1.5 rounded-lg">
              {apiKey ? maskApiKey(apiKey) : "Not configured"}
            </code>
            {apiKey && (
              <Button size="sm" variant="ghost" onClick={handleCopyApiKey}>
                {copiedKey ? (
                  <>
                    <Check className="h-4 w-4 text-green-400" />
                    <span className="text-xs text-green-400">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" />
                    <span className="text-xs">Copy</span>
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* Encryption Keys */}
      {encryptionInfo && (
        <Card title="Encryption Keys" subtitle="Manage encryption keys for account data and guardrail anonymization">
          <div className="space-y-4">
            {/* Decrypt error banner */}
            {encryptionInfo.decrypt_errors > 0 && (
              <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
                {encryptionInfo.decrypt_errors} account(s) have decryption errors. Re-enter their API keys or rotate the account key.
              </div>
            )}

            {/* Rotate feedback */}
            {rotateMsg && (
              <div className={`text-sm px-4 py-2 rounded-lg ${
                rotateMsg.ok
                  ? "text-green-400 bg-green-500/10 border border-green-500/20"
                  : "text-red-400 bg-red-500/10 border border-red-500/20"
              }`}>
                {rotateMsg.text}
              </div>
            )}

            {/* Account Key */}
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium text-gray-200">Account Key</p>
                <p className="text-xs text-gray-500">
                  Encrypts API keys and tokens stored in the database
                </p>
                <div className="flex items-center gap-3 mt-1">
                  <code className="text-xs font-mono text-gray-400 bg-gray-800 px-2 py-0.5 rounded">
                    {encryptionInfo.account_key.fingerprint}
                  </code>
                  <span className="text-xs text-gray-500">
                    Source: {encryptionInfo.account_key.source}
                  </span>
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={handleRotateAccountKey}
                loading={rotatingAccount}
                disabled={encryptionInfo.account_key.source === "env"}
              >
                Rotate
              </Button>
            </div>

            <div className="border-t border-gray-800" />

            {/* Guardrail Seed */}
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium text-gray-200">Guardrail Seed</p>
                <p className="text-xs text-gray-500">
                  Deterministic encryption for privacy anonymization
                </p>
                <div className="flex items-center gap-3 mt-1">
                  <code className="text-xs font-mono text-gray-400 bg-gray-800 px-2 py-0.5 rounded">
                    {encryptionInfo.guardrail_key.fingerprint}
                  </code>
                  <span className="text-xs text-gray-500">
                    Source: {encryptionInfo.guardrail_key.source}
                  </span>
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={handleRotateGuardrailKey}
                loading={rotatingGuardrail}
                disabled={encryptionInfo.guardrail_key.source === "env"}
              >
                Reroll
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Model Limits */}
      <Card
        title="Model Limits"
        subtitle="Set max output tokens and capability flags per model. The proxy will clamp max_tokens before forwarding."
      >
        <div className="space-y-4">
          {/* Existing limits */}
          {modelLimitEntries.length > 0 && (
            <div className="rounded-lg border border-gray-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-800/50 text-gray-400 text-xs uppercase tracking-wider">
                    <th className="px-3 py-2 text-left font-medium">
                      Model ID
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      Max Output
                    </th>
                    <th className="px-3 py-2 text-center font-medium">
                      Capabilities
                    </th>
                    <th className="px-3 py-2 text-right font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {modelLimitEntries.map(([modelId, lim]) => (
                    <tr key={modelId}>
                      <td className="px-3 py-2 font-mono text-xs text-gray-200">
                        {modelId}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-gray-300">
                        {lim.maxOutputTokens != null
                          ? lim.maxOutputTokens.toLocaleString()
                          : "-"}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <div className="flex items-center justify-center gap-1">
                          {lim.supportsToolCalling === true && (
                            <Badge variant="success">Tools</Badge>
                          )}
                          {lim.supportsToolCalling === false && (
                            <Badge variant="warning">No Tools</Badge>
                          )}
                          {lim.supportsReasoning === true && (
                            <Badge variant="purple">Reasoning</Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => handleDeleteModelLimit(modelId)}
                          className="text-gray-500 hover:text-red-400 text-xs"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {modelLimitEntries.length === 0 && (
            <p className="text-sm text-gray-500 italic">
              No model limits configured. Add one below to cap max_tokens for a
              specific model.
            </p>
          )}

          {/* Add new limit */}
          <div className="bg-gray-800/30 rounded-lg p-3 space-y-3">
            <p className="text-xs text-gray-400 font-medium uppercase tracking-wider">
              Add Model Limit
            </p>
            <div className="flex items-end gap-3 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <Input
                  label="Model ID (prefix match)"
                  type="text"
                  placeholder="e.g. deepseek-chat"
                  value={newModelId}
                  onChange={(e) => setNewModelId(e.target.value)}
                />
              </div>
              <div className="w-32">
                <Input
                  label="Max Output Tokens"
                  type="number"
                  placeholder="e.g. 8192"
                  value={newMaxTokens}
                  onChange={(e) => setNewMaxTokens(e.target.value)}
                />
              </div>
              <div className="w-28">
                <Select
                  label="Tools"
                  value={newToolCalling}
                  onChange={(e) => setNewToolCalling(e.target.value)}
                  options={[
                    { value: "unset", label: "-" },
                    { value: "true", label: "Yes" },
                    { value: "false", label: "No" },
                  ]}
                />
              </div>
              <div className="w-28">
                <Select
                  label="Reasoning"
                  value={newReasoning}
                  onChange={(e) => setNewReasoning(e.target.value)}
                  options={[
                    { value: "unset", label: "-" },
                    { value: "true", label: "Yes" },
                    { value: "false", label: "No" },
                  ]}
                />
              </div>
              <Button
                size="sm"
                onClick={handleAddModelLimit}
                disabled={!newModelId.trim()}
              >
                Add
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* Request Logging */}
      <Card
        title="Request Logging"
        subtitle="Log proxy requests for debugging and monitoring"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium text-gray-200">
                Enable Request Logging
              </p>
              <p className="text-xs text-gray-500">
                Log all proxy requests with metadata (model, status, tokens,
                latency)
              </p>
            </div>
            <Toggle
              checked={requestLogging}
              onChange={(val) => handleToggle("request_logging", val)}
              disabled={saving}
            />
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium text-gray-200">
                Detailed Request Logging
              </p>
              <p className="text-xs text-gray-500">
                Also capture full request and response bodies (increases storage)
              </p>
            </div>
            <Toggle
              checked={detailedLogging}
              onChange={(val) =>
                handleToggle("detailed_request_logging", val)
              }
              disabled={saving || !requestLogging}
            />
          </div>
        </div>
      </Card>

      {/* Routing */}
      <Card
        title="Routing"
        subtitle="Control how requests are routed across accounts"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium text-gray-200">
                Auto-switch on Error
              </p>
              <p className="text-xs text-gray-500">
                Automatically try the next account when an API error occurs
              </p>
            </div>
            <Toggle
              checked={autoSwitchOnError}
              onChange={(val) => handleToggle("auto_switch_on_error", val)}
              disabled={saving}
            />
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium text-gray-200">
                Auto-switch on Rate Limit
              </p>
              <p className="text-xs text-gray-500">
                Automatically try the next account when rate-limited (429
                response)
              </p>
            </div>
            <Toggle
              checked={autoSwitchOnRateLimit}
              onChange={(val) =>
                handleToggle("auto_switch_on_rate_limit", val)
              }
              disabled={saving}
            />
          </div>
        </div>
      </Card>

      {/* Multi-Tenancy */}
      <Card title="Multi-Tenancy" subtitle="Manage external API access with tenant keys">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-300">
              {tenantCount !== null
                ? `${tenantCount} tenant${tenantCount !== 1 ? "s" : ""} configured`
                : "Loading..."}
            </p>
          </div>
          <a href="/tenants">
            <Button variant="secondary" size="sm">
              Manage Tenants
            </Button>
          </a>
        </div>
      </Card>
    </div>
  );
}
