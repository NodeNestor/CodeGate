import React, { useEffect, useState, useCallback } from "react";
import {
  Shield,
  ShieldCheck,
  ShieldOff,
  Loader2,
  Trash2,
  FlaskConical,
  Mail,
  Key,
  Lock,
  User,
  Globe,
  Phone,
  Link2,
  CreditCard,
  Landmark,
  BookOpen,
  MapPin,
  Cloud,
  KeyRound,
  FileKey,
} from "lucide-react";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Toggle from "../components/ui/Toggle";
import {
  getPrivacyStatus,
  updatePrivacySettings,
  getPrivacyMappings,
  deletePrivacyMappings,
  testPrivacyAnonymization,
  getGuardrailsList,
  updateGuardrail,
  type PrivacyStatus,
  type PrivacyMappingUI,
  type PrivacyTestResult,
  type GuardrailInfo,
} from "../lib/api";

// ── Icon mapping ─────────────────────────────────────────────────────────────

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Mail, Key, Lock, User, Globe, Phone, Link2, CreditCard,
  Landmark, BookOpen, MapPin, Cloud, KeyRound, FileKey,
};

function getIcon(name?: string): React.ComponentType<{ className?: string }> {
  if (!name) return Shield;
  return ICON_MAP[name] || Shield;
}

// ── Category group labels ────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  pii: "Personal Information",
  credentials: "Credentials & Secrets",
  network: "Network",
  financial: "Financial",
};

const CATEGORY_ORDER = ["credentials", "pii", "financial", "network"];

// ── Category badge component ────────────────────────────────────────────────

function CategoryBadge({ category, guardrails }: { category: string; guardrails: GuardrailInfo[] }) {
  const info = guardrails.find((g) => g.id === category);
  const label = info?.name || category;
  const colorClass = info?.color?.split(" ")[0] || "text-gray-400";
  const bgClass = info?.color?.split(" ")[1] || "bg-gray-600/10";

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${colorClass} ${bgClass}`}
    >
      {label}
    </span>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export default function Guardrails() {
  const [status, setStatus] = useState<PrivacyStatus | null>(null);
  const [guardrails, setGuardrails] = useState<GuardrailInfo[]>([]);
  const [mappings, setMappings] = useState<PrivacyMappingUI[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  // Test panel state
  const [testInput, setTestInput] = useState("");
  const [testResult, setTestResult] = useState<PrivacyTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [s, m, g] = await Promise.all([
        getPrivacyStatus(),
        getPrivacyMappings(),
        getGuardrailsList(),
      ]);
      setStatus(s);
      setMappings(m);
      setGuardrails(g.guardrails);
    } catch (err) {
      console.error("Failed to load guardrails data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function toggleEnabled() {
    if (!status) return;
    setUpdating(true);
    try {
      const result = await updatePrivacySettings({
        enabled: !status.enabled,
      });
      setStatus(result);
    } catch (err) {
      console.error("Failed to toggle guardrails:", err);
    } finally {
      setUpdating(false);
    }
  }

  async function toggleGuardrail(id: string) {
    setUpdating(true);
    try {
      const guardrail = guardrails.find((g) => g.id === id);
      if (!guardrail) return;
      await updateGuardrail(id, { enabled: !guardrail.enabled });
      // Refresh guardrails list
      const g = await getGuardrailsList();
      setGuardrails(g.guardrails);
      // Also refresh categories in status
      const s = await getPrivacyStatus();
      setStatus(s);
    } catch (err) {
      console.error("Failed to toggle guardrail:", err);
    } finally {
      setUpdating(false);
    }
  }

  async function handleClearMappings() {
    if (
      !window.confirm(
        "Clear all privacy mappings? This cannot be undone and future occurrences will get new anonymized values."
      )
    ) {
      return;
    }
    try {
      await deletePrivacyMappings();
      await loadData();
    } catch (err) {
      console.error("Failed to clear mappings:", err);
    }
  }

  async function handleTest() {
    if (!testInput.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testPrivacyAnonymization(testInput);
      setTestResult(result);
      // Refresh data for updated counts
      const [s, m, g] = await Promise.all([
        getPrivacyStatus(),
        getPrivacyMappings(),
        getGuardrailsList(),
      ]);
      setStatus(s);
      setMappings(m);
      setGuardrails(g.guardrails);
    } catch (err) {
      console.error("Failed to test anonymization:", err);
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
      </div>
    );
  }

  const isEnabled = status?.enabled ?? false;
  const stats = status?.stats ?? { total_mappings: 0, by_category: {} };

  // Group guardrails by category
  const grouped: Record<string, GuardrailInfo[]> = {};
  for (const g of guardrails) {
    if (!grouped[g.category]) grouped[g.category] = [];
    grouped[g.category].push(g);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-brand-600/20">
            <Shield className="h-6 w-6 text-brand-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-100">
              Guardrails
            </h1>
            <p className="text-sm text-gray-400">
              PII & credential anonymization for LLM requests
            </p>
          </div>
        </div>
      </div>

      {/* Enable/Disable Toggle */}
      <Card>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div
              className={`p-3 rounded-xl ${
                isEnabled
                  ? "bg-green-600/10"
                  : "bg-gray-800"
              }`}
            >
              {isEnabled ? (
                <ShieldCheck className="h-8 w-8 text-green-400" />
              ) : (
                <ShieldOff className="h-8 w-8 text-gray-500" />
              )}
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-100">
                {isEnabled
                  ? "Guardrails Active"
                  : "Guardrails Disabled"}
              </h2>
              <p className="text-sm text-gray-400">
                {isEnabled
                  ? "Sensitive data is being anonymized before reaching LLM providers"
                  : "All data is sent to LLM providers without modification"}
              </p>
            </div>
          </div>
          <Toggle checked={isEnabled} onChange={() => toggleEnabled()} disabled={updating} />
        </div>
      </Card>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-brand-600/10">
              <Shield className="h-5 w-5 text-brand-400" />
            </div>
            <div>
              <p className="text-sm text-gray-400">Total Mappings</p>
              <p className="text-2xl font-bold text-gray-100">
                {stats.total_mappings.toLocaleString()}
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-600/10">
              <Key className="h-5 w-5 text-purple-400" />
            </div>
            <div>
              <p className="text-sm text-gray-400">Guardrails Active</p>
              <p className="text-2xl font-bold text-gray-100">
                {guardrails.filter((g) => g.enabled).length} / {guardrails.length}
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-600/10">
              <ShieldCheck className="h-5 w-5 text-green-400" />
            </div>
            <div>
              <p className="text-sm text-gray-400">Status</p>
              <p className="text-2xl font-bold text-gray-100">
                {isEnabled ? "Protected" : "Off"}
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* Guardrail cards grouped by category */}
      {CATEGORY_ORDER.map((cat) => {
        const group = grouped[cat];
        if (!group || group.length === 0) return null;

        return (
          <Card key={cat} title={CATEGORY_LABELS[cat] || cat}>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {group.map((g) => {
                const IconComp = getIcon(g.icon);
                const [textColor, bgColor] = (g.color || "text-gray-400 bg-gray-600/10").split(" ");

                return (
                  <div
                    key={g.id}
                    className={`relative rounded-xl border p-4 transition-colors ${
                      g.enabled
                        ? "border-gray-700 bg-gray-800/50"
                        : "border-gray-800/50 bg-gray-900/50 opacity-60"
                    }`}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className={`p-2 rounded-lg ${bgColor}`}>
                        <IconComp className={`h-5 w-5 ${textColor}`} />
                      </div>
                      <Toggle checked={g.enabled} onChange={() => toggleGuardrail(g.id)} disabled={updating} />
                    </div>
                    <h3 className="text-sm font-semibold text-gray-200 mb-1">
                      {g.name}
                    </h3>
                    <p className="text-xs text-gray-500 mb-2">{g.description}</p>
                    {g.detectionCount > 0 && (
                      <span className="text-xs text-gray-400">
                        {g.detectionCount} mapping{g.detectionCount !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}

      {/* Test Panel */}
      <Card title="Test Anonymization">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Paste text to test
            </label>
            <textarea
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              placeholder={`Try pasting text with PII like:\n  Email: john.doe@company.com\n  API Key: sk-ant-abc123def456ghi789\n  Name: author: Jane Smith\n  IP: 192.168.1.100\n  Phone: (555) 123-4567\n  SSN: 123-45-6789\n  Credit Card: 4111 1111 1111 1111`}
              rows={5}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent resize-y font-mono"
            />
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={handleTest}
              loading={testing}
              disabled={!testInput.trim()}
            >
              <FlaskConical className="h-4 w-4" />
              Test Anonymization
            </Button>
          </div>

          {testResult && (
            <div className="space-y-3 pt-2">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">
                  Anonymized Output
                </label>
                <pre className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-sm text-green-400 font-mono whitespace-pre-wrap overflow-x-auto">
                  {testResult.anonymized}
                </pre>
              </div>
              <p className="text-sm text-gray-400">
                {testResult.replacements_made} new replacement
                {testResult.replacements_made !== 1 ? "s" : ""} created
              </p>
            </div>
          )}
        </div>
      </Card>

      {/* Active Mappings Table */}
      <Card
        title="Active Mappings"
        subtitle={`${mappings.length} total mapping${mappings.length !== 1 ? "s" : ""}`}
      >
        {mappings.length > 0 ? (
          <>
            <div className="flex justify-end mb-4">
              <Button
                variant="danger"
                size="sm"
                onClick={handleClearMappings}
              >
                <Trash2 className="h-4 w-4" />
                Clear All
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="text-left py-3 px-4 font-medium text-gray-400">
                      Category
                    </th>
                    <th className="text-left py-3 px-4 font-medium text-gray-400">
                      Replacement
                    </th>
                    <th className="text-left py-3 px-4 font-medium text-gray-400">
                      Original (masked)
                    </th>
                    <th className="text-left py-3 px-4 font-medium text-gray-400">
                      Created
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map((m) => (
                    <tr
                      key={m.id}
                      className="border-b border-gray-800/50 hover:bg-gray-800/30"
                    >
                      <td className="py-3 px-4">
                        <CategoryBadge category={m.category} guardrails={guardrails} />
                      </td>
                      <td className="py-3 px-4 text-green-400 font-mono text-xs">
                        {m.replacement}
                      </td>
                      <td className="py-3 px-4 text-gray-500 font-mono text-xs">
                        {m.original_masked}
                      </td>
                      <td className="py-3 px-4 text-gray-400 text-xs whitespace-nowrap">
                        {new Date(m.created_at).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="text-center py-8 text-gray-500">
            No active mappings. Mappings are created when PII is detected in
            proxy requests or via the test panel above.
          </div>
        )}
      </Card>
    </div>
  );
}
