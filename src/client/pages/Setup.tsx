import React, { useState, useEffect } from "react";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import { autoSetup } from "../lib/api";

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
  proxyKey: string;
  tools: Record<string, ToolInfo>;
}

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

  useEffect(() => {
    fetch("/api/setup")
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
  }, []);

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
      const result = await autoSetup(toolKey);
      setAutoSetupResult({ tool: toolKey, ...result });
      // Refresh data to update configured status
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

  const toolEntries = Object.entries(data.tools);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-100">Setup</h1>
        <p className="text-sm text-gray-400 mt-1">
          Configure your AI coding tools to use CodeProxy
        </p>
      </div>

      {/* Proxy Info Card */}
      <Card className="border-brand-500/30 bg-brand-500/5">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex-1">
            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2">
              Proxy URL
            </h3>
            <div className="flex items-center gap-3">
              <code className="text-lg font-mono text-brand-400 bg-gray-800 px-3 py-1.5 rounded-lg">
                {data.proxyUrl}
              </code>
              <Button size="sm" variant="ghost" onClick={handleCopyProxy}>
                {copiedProxy ? (
                  <svg
                    className="h-4 w-4 text-green-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4.5 12.75l6 6 9-13.5"
                    />
                  </svg>
                ) : (
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"
                    />
                  </svg>
                )}
              </Button>
            </div>
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2">
              API Key
            </h3>
            <code className="text-lg font-mono text-gray-300 bg-gray-800 px-3 py-1.5 rounded-lg inline-block">
              {data.proxyKey}
            </code>
            <p className="text-xs text-gray-500 mt-1">
              Set in Settings, or use any value if authentication is disabled
            </p>
          </div>
        </div>
      </Card>

      {/* Tool Configuration Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {toolEntries.map(([key, tool]) => (
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
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                      Configured
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant={tool.configured ? "secondary" : "primary"}
                    loading={autoSetupLoading === key}
                    onClick={() => handleAutoSetup(key)}
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
                  {tool.snippet}
                </code>
              </pre>
              <Button
                size="sm"
                variant="ghost"
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => handleCopy(tool.snippet, key)}
              >
                {copiedIdx === key ? (
                  <svg
                    className="h-4 w-4 text-green-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4.5 12.75l6 6 9-13.5"
                    />
                  </svg>
                ) : (
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"
                    />
                  </svg>
                )}
                <span className="text-xs">
                  {copiedIdx === key ? "Copied" : "Copy"}
                </span>
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
