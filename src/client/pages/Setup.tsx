import React, { useState, useEffect } from "react";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import { autoSetup } from "../lib/api";
import { Copy, Check, ChevronDown } from "lucide-react";

interface TenantInfo {
  id: string;
  name: string;
  api_key_prefix: string;
  api_key: string | null;
}

interface ToolInfo {
  name: string;
  description: string;
  autoSetup: boolean;
  configured?: boolean;
  snippet: string;
  docs: string | null;
}

interface SetupData {
  proxyUrl: string;
  tenants: TenantInfo[];
  defaultTenantId: string | null;
  defaultTenantKey: string;
  envApiKey: string;
  multiTenancy: boolean;
  tools: Record<string, ToolInfo>;
}

const KEY_PLACEHOLDER = "{{API_KEY}}";

export default function Setup() {
  const [data, setData] = useState<SetupData | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<string | null>(null);
  const [copiedProxy, setCopiedProxy] = useState(false);
  const [autoSetupLoading, setAutoSetupLoading] = useState<string | null>(null);
  const [autoSetupResult, setAutoSetupResult] = useState<{
    tool: string;
    success: boolean;
    message: string;
  } | null>(null);

  // Tenant selection
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [customKey, setCustomKey] = useState("");

  useEffect(() => {
    fetch("/api/setup")
      .then((r) => r.json())
      .then((d: SetupData) => {
        setData(d);
        setSelectedTenantId(d.defaultTenantId);
      })
      .catch(() => {});
  }, []);

  // Resolve the active API key based on mode
  function getActiveKey(): string {
    if (!data) return "";
    // Multi-tenancy ON → use selected tenant's key
    if (data.multiTenancy) {
      if (!selectedTenantId) return customKey || "";
      const tenant = data.tenants.find((t) => t.id === selectedTenantId);
      if (tenant?.api_key) return tenant.api_key;
      return customKey || "";
    }
    // Simple mode: env var takes precedence, then stored key
    if (data.envApiKey) return data.envApiKey;
    return data.defaultTenantKey || "";
  }

  // Replace placeholder in snippet with actual key
  function resolveSnippet(snippet: string): string {
    const key = getActiveKey();
    return snippet.replace(new RegExp(KEY_PLACEHOLDER.replace(/[{}]/g, "\\$&"), "g"), key || "<YOUR_API_KEY>");
  }

  function handleCopy(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedIdx(key);
      setTimeout(() => setCopiedIdx(null), 2000);
    });
  }

  function handleCopyProxy() {
    if (!data) return;
    navigator.clipboard.writeText(data.proxyUrl).then(() => {
      setCopiedProxy(true);
      setTimeout(() => setCopiedProxy(false), 2000);
    });
  }

  async function handleAutoSetup(toolKey: string) {
    setAutoSetupLoading(toolKey);
    setAutoSetupResult(null);
    try {
      const activeKey = getActiveKey();
      const result = await autoSetup(toolKey, activeKey || undefined);
      setAutoSetupResult({ tool: toolKey, ...result });
      const refreshed = await fetch("/api/setup").then((r) => r.json());
      setData(refreshed);
    } catch (err: any) {
      setAutoSetupResult({
        tool: toolKey,
        success: false,
        message: err.message || "Auto-setup failed",
      });
    } finally {
      setAutoSetupLoading(null);
    }
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">
        Loading setup info...
      </div>
    );
  }

  const activeKey = getActiveKey();
  const envMode = !!data.envApiKey;
  const multiTenancy = data.multiTenancy;
  const selectedTenant = data.tenants.find((t) => t.id === selectedTenantId);
  const isDefaultTenant = selectedTenantId === data.defaultTenantId;
  const selectedTenantKey = selectedTenant?.api_key || null;
  const needsCustomKey = multiTenancy && selectedTenantId && !selectedTenantKey && !customKey;
  const toolEntries = Object.entries(data.tools);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-100">Setup</h1>
        <p className="text-sm text-gray-400 mt-1">
          Configure your AI coding tools to use CodeGate
        </p>
      </div>

      {/* Connection Info */}
      <Card className="border-brand-500/30 bg-brand-500/5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Proxy URL */}
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">Proxy URL</p>
            <div className="flex items-center gap-2">
              <code className="text-sm font-mono text-brand-400 bg-gray-800 px-3 py-1.5 rounded-lg">
                {data.proxyUrl}
              </code>
              <Button size="sm" variant="ghost" onClick={handleCopyProxy}>
                {copiedProxy ? (
                  <Check className="h-4 w-4 text-green-400" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          {/* API Key — only show in simple (non-tenant) mode */}
          {!multiTenancy && (
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                API Key
                {envMode && <span className="ml-2 text-yellow-500/80 normal-case">(env var)</span>}
              </p>
              <div className="flex items-center gap-2">
                <code className="text-sm font-mono text-gray-300 bg-gray-800 px-3 py-1.5 rounded-lg break-all">
                  {activeKey || "Not configured"}
                </code>
                {activeKey && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleCopy(activeKey, "active-key")}
                  >
                    {copiedIdx === "active-key" ? (
                      <Check className="h-4 w-4 text-green-400" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Tenant selector — when multi-tenancy is on */}
        {multiTenancy && data.tenants.length > 0 && (
          <>
            <div className="border-t border-gray-800/50 mt-4 pt-4">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Tenant</p>
              <div className="flex items-start gap-4 flex-wrap">
                <div className="relative">
                  <select
                    value={selectedTenantId || ""}
                    onChange={(e) => {
                      setSelectedTenantId(e.target.value || null);
                      setCustomKey("");
                    }}
                    className="appearance-none bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2 pr-8 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
                  >
                    {data.tenants.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}{t.id === data.defaultTenantId ? " (Default)" : ""}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500 pointer-events-none" />
                </div>

                {/* Show tenant key */}
                {selectedTenantKey ? (
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-mono text-gray-300 bg-gray-800 px-3 py-1.5 rounded-lg break-all">
                      {selectedTenantKey}
                    </code>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleCopy(selectedTenantKey, "tenant-key")}
                    >
                      {copiedIdx === "tenant-key" ? (
                        <Check className="h-4 w-4 text-green-400" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                ) : (
                  /* Key not stored (legacy tenant) — paste manually */
                  <div className="flex-1 min-w-[280px]">
                    <div className="flex items-center gap-2 mb-1.5">
                      <Badge variant="info">{selectedTenant?.api_key_prefix}...</Badge>
                      <span className="text-xs text-gray-500">Paste this tenant's full key</span>
                    </div>
                    <input
                      type="text"
                      value={customKey}
                      onChange={(e) => setCustomKey(e.target.value)}
                      placeholder={`${selectedTenant?.api_key_prefix || "cgk_"}...`}
                      className="w-full bg-gray-800 border border-gray-700 text-gray-200 text-sm font-mono rounded-lg px-3 py-2 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none placeholder:text-gray-600"
                    />
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </Card>

      {/* Warning if non-default tenant has no key pasted */}
      {needsCustomKey && (
        <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/20 p-3 text-sm text-yellow-400">
          Paste this tenant's API key above to populate the snippets below. Tenant keys are only shown once when created.
        </div>
      )}

      {/* Tool Configuration Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {toolEntries.map(([key, tool]) => {
          const resolved = resolveSnippet(tool.snippet);
          return (
            <Card key={key}>
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-base font-semibold text-gray-100">
                    {tool.name}
                  </h3>
                  <p className="text-sm text-gray-400 mt-0.5">
                    {tool.description}
                  </p>
                </div>
                {tool.autoSetup && (
                  <div className="flex items-center gap-2 shrink-0 ml-3">
                    {tool.configured && (
                      <span className="inline-flex items-center gap-1 text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5">
                        <Check className="h-3 w-3" />
                        Configured
                      </span>
                    )}
                    <Button
                      size="sm"
                      variant={tool.configured ? "secondary" : "primary"}
                      loading={autoSetupLoading === key}
                      onClick={() => handleAutoSetup(key)}
                      disabled={!activeKey}
                    >
                      {tool.configured ? "Reconfigure" : "Auto Setup"}
                    </Button>
                  </div>
                )}
              </div>

              {/* Auto-setup result message */}
              {autoSetupResult && autoSetupResult.tool === key && (
                <div
                  className={`mb-3 rounded-lg border p-2.5 text-sm ${
                    autoSetupResult.success
                      ? "bg-green-500/10 border-green-500/20 text-green-400"
                      : "bg-red-500/10 border-red-500/20 text-red-400"
                  }`}
                >
                  {autoSetupResult.message}
                </div>
              )}

              <div className="relative group">
                <pre className="bg-gray-950 border border-gray-800 rounded-lg p-4 overflow-x-auto text-sm">
                  <code className="text-gray-300 whitespace-pre">
                    {resolved}
                  </code>
                </pre>
                <Button
                  size="sm"
                  variant="ghost"
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => handleCopy(resolved, key)}
                >
                  {copiedIdx === key ? (
                    <Check className="h-4 w-4 text-green-400" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                  <span className="text-xs">
                    {copiedIdx === key ? "Copied" : "Copy"}
                  </span>
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
