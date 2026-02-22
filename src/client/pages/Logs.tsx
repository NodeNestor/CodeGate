import React, { useEffect, useState, useCallback } from "react";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import Toggle from "../components/ui/Toggle";
import Modal from "../components/ui/Modal";
import {
  getSettings,
  updateSettings,
  getRequestLogs,
  getRequestLogDetail,
  deleteOldLogs,
  type RequestLog,
} from "../lib/api";

export default function Logs() {
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [modelFilter, setModelFilter] = useState("");
  const [loggingEnabled, setLoggingEnabled] = useState(false);
  const [detailedLogging, setDetailedLogging] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [selectedLog, setSelectedLog] = useState<RequestLog | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const limit = 50;

  useEffect(() => {
    loadSettings();
  }, []);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const status =
        statusFilter === "success"
          ? "success"
          : statusFilter === "error"
          ? "error"
          : undefined;
      const result = await getRequestLogs({
        page,
        limit,
        status,
        model: modelFilter || undefined,
      });
      setLogs(result.logs);
      setTotal(result.total);
    } catch (err) {
      console.error("Failed to load logs:", err);
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, modelFilter]);

  useEffect(() => {
    if (settingsLoaded) loadLogs();
  }, [loadLogs, settingsLoaded]);

  async function loadSettings() {
    try {
      const s = await getSettings();
      setLoggingEnabled(s.request_logging === "true");
      setDetailedLogging(s.detailed_request_logging === "true");
    } catch {
      // ignore
    } finally {
      setSettingsLoaded(true);
    }
  }

  async function handleToggleLogging(val: boolean) {
    setSaving(true);
    try {
      await updateSettings({ request_logging: val ? "true" : "false" });
      setLoggingEnabled(val);
    } catch (err) {
      console.error("Failed to toggle logging:", err);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleDetailed(val: boolean) {
    setSaving(true);
    try {
      await updateSettings({
        detailed_request_logging: val ? "true" : "false",
      });
      setDetailedLogging(val);
    } catch (err) {
      console.error("Failed to toggle detailed logging:", err);
    } finally {
      setSaving(false);
    }
  }

  async function handleClearOldLogs() {
    if (!confirm("Delete logs older than 7 days?")) return;
    try {
      const result = await deleteOldLogs(7);
      alert(`Deleted ${result.deleted} old log entries.`);
      loadLogs();
    } catch (err) {
      console.error("Failed to clear old logs:", err);
    }
  }

  async function handleRowClick(log: RequestLog) {
    setDetailLoading(true);
    setSelectedLog(log);
    try {
      const detail = await getRequestLogDetail(log.id);
      setSelectedLog(detail);
    } catch {
      // show what we have
    } finally {
      setDetailLoading(false);
    }
  }

  function formatLatency(ms: number | null): string {
    if (ms === null || ms === undefined) return "-";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function formatTime(ts: string): string {
    try {
      const d = new Date(ts + (ts.includes("Z") ? "" : "Z"));
      return d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return ts;
    }
  }

  function formatDate(ts: string): string {
    try {
      const d = new Date(ts + (ts.includes("Z") ? "" : "Z"));
      return d.toLocaleDateString([], {
        month: "short",
        day: "numeric",
      });
    } catch {
      return "";
    }
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Request Logs</h1>
          <p className="text-sm text-gray-400 mt-1">
            Monitor proxy requests and debug issues
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="secondary" size="sm" onClick={handleClearOldLogs}>
            Clear Old Logs
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => loadLogs()}
            loading={loading}
          >
            Refresh
          </Button>
        </div>
      </div>

      {/* Logging toggles */}
      <Card title="Logging Configuration">
        <div className="space-y-4">
          <div className="flex items-center justify-between py-1">
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
              checked={loggingEnabled}
              onChange={handleToggleLogging}
              disabled={saving}
            />
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex items-center justify-between py-1">
            <div>
              <p className="text-sm font-medium text-gray-200">
                Detailed Logging
              </p>
              <p className="text-xs text-gray-500">
                Also capture full request and response bodies (increases storage
                usage)
              </p>
            </div>
            <Toggle
              checked={detailedLogging}
              onChange={handleToggleDetailed}
              disabled={saving || !loggingEnabled}
            />
          </div>
        </div>
      </Card>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1 bg-gray-800/50 rounded-lg p-1">
          {[
            { key: "all", label: "All" },
            { key: "success", label: "Success" },
            { key: "error", label: "Error" },
          ].map((f) => (
            <button
              key={f.key}
              onClick={() => {
                setStatusFilter(f.key);
                setPage(1);
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                statusFilter === f.key
                  ? "bg-gray-700 text-gray-100"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Filter by model..."
          value={modelFilter}
          onChange={(e) => {
            setModelFilter(e.target.value);
            setPage(1);
          }}
          className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-500 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none w-64"
        />
        <span className="text-xs text-gray-500 ml-auto">
          {total} total log{total !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Logs table */}
      <div className="rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-800/50 text-gray-400 text-xs uppercase tracking-wider">
              <th className="px-4 py-3 text-left font-medium">Time</th>
              <th className="px-4 py-3 text-left font-medium">Model</th>
              <th className="px-4 py-3 text-left font-medium">
                Provider / Account
              </th>
              <th className="px-4 py-3 text-center font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Tokens</th>
              <th className="px-4 py-3 text-right font-medium">Latency</th>
              <th className="px-4 py-3 text-center font-medium">Flags</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {loading && logs.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center">
                  <svg
                    className="h-6 w-6 animate-spin text-brand-500 mx-auto"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                </td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-12 text-center text-gray-500"
                >
                  {loggingEnabled
                    ? "No logs yet. Make some proxy requests to see them here."
                    : "Logging is disabled. Enable it above to start capturing requests."}
                </td>
              </tr>
            ) : (
              logs.map((log) => (
                <tr
                  key={log.id}
                  onClick={() => handleRowClick(log)}
                  className="hover:bg-gray-800/30 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="text-gray-200">
                      {formatTime(log.timestamp)}
                    </div>
                    <div className="text-xs text-gray-500">
                      {formatDate(log.timestamp)}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-gray-200 font-mono text-xs">
                      {log.routed_model || log.original_model || "-"}
                    </div>
                    {log.routed_model &&
                      log.original_model &&
                      log.routed_model !== log.original_model && (
                        <div className="text-xs text-gray-500">
                          from {log.original_model}
                        </div>
                      )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-gray-300 text-xs">
                      {log.account_name || "-"}
                    </div>
                    <div className="text-xs text-gray-500">
                      {log.provider || "-"}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Badge
                      variant={
                        log.status_code >= 200 && log.status_code < 300
                          ? "success"
                          : log.status_code === 429
                          ? "warning"
                          : "danger"
                      }
                    >
                      {log.status_code}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="text-xs text-gray-300">
                      {log.input_tokens != null ? (
                        <>
                          <span className="text-gray-500">in:</span>{" "}
                          {log.input_tokens.toLocaleString()}
                        </>
                      ) : (
                        "-"
                      )}
                    </div>
                    <div className="text-xs text-gray-300">
                      {log.output_tokens != null ? (
                        <>
                          <span className="text-gray-500">out:</span>{" "}
                          {log.output_tokens.toLocaleString()}
                        </>
                      ) : (
                        "-"
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-gray-300">
                    {formatLatency(log.latency_ms)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex items-center justify-center gap-1">
                      {log.is_stream ? (
                        <Badge variant="info">SSE</Badge>
                      ) : null}
                      {log.is_failover ? (
                        <Badge variant="warning">Failover</Badge>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-500">
            Page {page} of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Detail modal */}
      <Modal
        open={!!selectedLog}
        onClose={() => setSelectedLog(null)}
        title="Request Detail"
        maxWidth="max-w-3xl"
      >
        {selectedLog && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500">Time:</span>{" "}
                <span className="text-gray-200">
                  {selectedLog.timestamp}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Status:</span>{" "}
                <Badge
                  variant={
                    selectedLog.status_code >= 200 &&
                    selectedLog.status_code < 300
                      ? "success"
                      : "danger"
                  }
                >
                  {selectedLog.status_code}
                </Badge>
              </div>
              <div>
                <span className="text-gray-500">Method:</span>{" "}
                <span className="text-gray-200">{selectedLog.method}</span>
              </div>
              <div>
                <span className="text-gray-500">Path:</span>{" "}
                <span className="text-gray-200 font-mono text-xs">
                  {selectedLog.path}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Original Model:</span>{" "}
                <span className="text-gray-200 font-mono text-xs">
                  {selectedLog.original_model || "-"}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Routed Model:</span>{" "}
                <span className="text-gray-200 font-mono text-xs">
                  {selectedLog.routed_model || "-"}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Provider:</span>{" "}
                <span className="text-gray-200">
                  {selectedLog.provider || "-"}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Account:</span>{" "}
                <span className="text-gray-200">
                  {selectedLog.account_name || "-"}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Input Tokens:</span>{" "}
                <span className="text-gray-200">
                  {selectedLog.input_tokens?.toLocaleString() ?? "-"}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Output Tokens:</span>{" "}
                <span className="text-gray-200">
                  {selectedLog.output_tokens?.toLocaleString() ?? "-"}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Latency:</span>{" "}
                <span className="text-gray-200">
                  {formatLatency(selectedLog.latency_ms)}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Format:</span>{" "}
                <span className="text-gray-200">
                  {selectedLog.inbound_format || "-"}
                </span>
              </div>
            </div>

            {selectedLog.error_message && (
              <div>
                <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">
                  Error
                </h4>
                <pre className="text-xs text-red-400 bg-red-500/5 border border-red-500/10 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
                  {selectedLog.error_message}
                </pre>
              </div>
            )}

            {selectedLog.request_body && (
              <div>
                <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">
                  Request Body
                </h4>
                <pre className="text-xs text-gray-300 bg-gray-800 rounded-lg p-3 overflow-x-auto max-h-64 whitespace-pre-wrap">
                  {detailLoading
                    ? "Loading..."
                    : formatJsonSafe(selectedLog.request_body)}
                </pre>
              </div>
            )}

            {selectedLog.response_body && (
              <div>
                <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">
                  Response Body
                </h4>
                <pre className="text-xs text-gray-300 bg-gray-800 rounded-lg p-3 overflow-x-auto max-h-64 whitespace-pre-wrap">
                  {detailLoading
                    ? "Loading..."
                    : formatJsonSafe(selectedLog.response_body)}
                </pre>
              </div>
            )}

            {!selectedLog.request_body && !selectedLog.response_body && (
              <p className="text-sm text-gray-500 italic">
                No request/response bodies captured. Enable "Detailed Logging"
                to capture them.
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

function formatJsonSafe(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}
