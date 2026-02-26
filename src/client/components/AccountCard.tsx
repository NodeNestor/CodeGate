import React from "react";
import { Pencil, Trash2, Mail, Clock, AlertTriangle, ShieldAlert, Terminal } from "lucide-react";
import Badge, {
  getProviderVariant,
  getProviderLabel,
  getStatusVariant,
  getStatusLabel,
} from "./ui/Badge";
import Toggle from "./ui/Toggle";
import type { Account, Session } from "../lib/api";

interface AccountCardProps {
  account: Account;
  session?: Session | null;
  onToggle: (id: string) => void;
  onEdit: (account: Account) => void;
  onDelete: (id: string) => void;
  onTest?: (id: string) => void;
  testing?: boolean;
  testResult?: { ok: boolean; text: string } | null;
}

/** Format a relative time string like "5 min ago" or "2 hours ago". */
function timeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays}d ago`;
}

/** Check if a token expiry is within the next 30 minutes. */
function isExpiringsSoon(expiresAt?: number | null): boolean {
  if (!expiresAt) return false;
  return expiresAt - Date.now() < 30 * 60 * 1000;
}

export default function AccountCard({
  account,
  session,
  onToggle,
  onEdit,
  onDelete,
  onTest,
  testing,
  testResult,
}: AccountCardProps) {
  const status = account.status || "unknown";
  const tokenExpiresSoon =
    account.auth_type === "oauth" && isExpiringsSoon(account.token_expires_at);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-col hover:border-gray-700 transition-colors h-full">
      {/* Header row */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <Badge variant={getProviderVariant(account.provider)}>
            {getProviderLabel(account.provider)}
          </Badge>
          <h3 className="text-base font-semibold text-gray-100 truncate">
            {account.name}
          </h3>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Badge variant={getStatusVariant(status)} className="ml-2">
            {getStatusLabel(status)}
          </Badge>
          <button
            onClick={() => onEdit(account)}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
            title="Edit"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            onClick={() => onDelete(account.id)}
            className="p-1.5 rounded-lg text-gray-400 hover:text-red-400 hover:bg-gray-800 transition-colors"
            title="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Decrypt error warning */}
      {account.decrypt_error && (
        <div className="flex items-center gap-2 mb-3 px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20">
          <ShieldAlert className="h-3.5 w-3.5 text-red-400 shrink-0" />
          <span className="text-xs text-red-400">
            Decryption failed — re-enter API key to fix
          </span>
        </div>
      )}

      {/* Info rows - grows to fill space */}
      <div className="space-y-2 text-sm flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={account.auth_type === "oauth" ? "info" : "default"}>
            {account.auth_type === "oauth" ? "OAuth" : "API Key"}
          </Badge>
          {account.subscription_type && (
            <Badge variant="warning">{account.subscription_type}</Badge>
          )}
        </div>

        {account.account_email && (
          <div className="flex items-center gap-2 text-gray-400">
            <Mail className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{account.account_email}</span>
          </div>
        )}

        {/* OAuth token expiry */}
        {account.auth_type === "oauth" && account.token_expires_at ? (
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-gray-500 shrink-0" />
            <span
              className={
                tokenExpiresSoon ? "text-yellow-400" : "text-gray-400"
              }
            >
              Expires:{" "}
              {new Date(account.token_expires_at).toLocaleString()}
              {tokenExpiresSoon && " (soon!)"}
            </span>
          </div>
        ) : null}

        {/* Last used */}
        {account.last_used_at && (
          <div className="flex items-center gap-2 text-gray-500">
            <Clock className="h-3.5 w-3.5 shrink-0" />
            <span>Last used: {timeAgo(account.last_used_at)}</span>
          </div>
        )}

        {/* Last error */}
        {account.last_error && (
          <div className="flex items-start gap-2 text-red-400/80">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span className="truncate text-xs" title={account.last_error}>
              {account.last_error}
            </span>
          </div>
        )}

        {/* Session indicator for OAuth accounts */}
        {session && session.status === "running" && (
          <div className="flex items-center gap-2 text-gray-500">
            <Terminal className="h-3.5 w-3.5 shrink-0 text-green-500" />
            <span className="text-xs">Token refresh active</span>
            {session.port && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(`http://localhost:${session.port}`, "_blank");
                }}
                className="text-xs text-gray-500 hover:text-brand-400 transition-colors ml-auto"
              >
                Open Terminal
              </button>
            )}
          </div>
        )}
      </div>

      {/* Test result */}
      {testResult && (
        <div
          className={`text-xs px-2 py-1.5 rounded mb-2 ${
            testResult.ok
              ? "text-green-400 bg-green-500/10"
              : "text-red-400 bg-red-500/10"
          }`}
        >
          {testResult.text}
        </div>
      )}

      {/* Footer: toggle + test */}
      <div className="flex items-center justify-between pt-3 border-t border-gray-800 mt-auto">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${
              account.enabled ? "bg-green-500" : "bg-red-500"
            }`}
          />
          <span
            className={`text-sm ${
              account.enabled ? "text-green-400" : "text-red-400"
            }`}
          >
            {account.enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {onTest && (
            <button
              onClick={() => onTest(account.id)}
              disabled={testing}
              className="text-xs text-gray-500 hover:text-brand-400 transition-colors disabled:opacity-50"
            >
              {testing ? "Testing..." : "Test"}
            </button>
          )}
          <Toggle
            checked={account.enabled}
            onChange={() => onToggle(account.id)}
          />
        </div>
      </div>
    </div>
  );
}
