import React, { useEffect, useState } from "react";
import {
  Plus,
  Loader2,
  Check,
  Pencil,
  Trash2,
  FolderOpen,
} from "lucide-react";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Modal from "../components/ui/Modal";
import { Input, Select, Textarea } from "../components/ui/Input";
import ConfigEditor from "../components/ConfigEditor";
import {
  getConfigs,
  getAccounts,
  createConfig,
  updateConfig,
  deleteConfig,
  activateConfig,
  getConfigTiers,
  setConfigTiers,
  type Config,
  type ConfigTier,
  type Account,
} from "../lib/api";

const ROUTING_STRATEGIES = [
  { value: "priority", label: "Priority" },
  { value: "round-robin", label: "Round Robin" },
  { value: "least-used", label: "Least Used" },
  { value: "budget-aware", label: "Budget Aware" },
];

export default function Configs() {
  const [configs, setConfigs] = useState<Config[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);

  // Create modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newStrategy, setNewStrategy] = useState("priority");
  const [creating, setCreating] = useState(false);

  // Editor state
  const [editingConfig, setEditingConfig] = useState<Config | null>(null);
  const [editTiers, setEditTiers] = useState<ConfigTier[]>([]);
  const [loadingTiers, setLoadingTiers] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const [c, a] = await Promise.all([getConfigs(), getAccounts()]);
      setConfigs(c);
      setAccounts(a);
    } catch (err) {
      console.error("Failed to load configs:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    setCreating(true);
    try {
      await createConfig({
        name: newName,
        description: newDesc || undefined,
        routing_strategy: newStrategy,
      });
      setCreateOpen(false);
      setNewName("");
      setNewDesc("");
      setNewStrategy("priority");
      await loadData();
    } catch (err) {
      console.error("Create failed:", err);
    } finally {
      setCreating(false);
    }
  }

  async function handleActivate(id: string) {
    try {
      await activateConfig(id);
      await loadData();
    } catch (err) {
      console.error("Activate failed:", err);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this configuration?")) return;
    try {
      await deleteConfig(id);
      setConfigs((prev) => prev.filter((c) => c.id !== id));
      if (editingConfig?.id === id) setEditingConfig(null);
    } catch (err) {
      console.error("Delete failed:", err);
    }
  }

  async function openEditor(config: Config) {
    setLoadingTiers(true);
    setEditingConfig(config);
    try {
      const tiers = await getConfigTiers(config.id);
      setEditTiers(tiers);
    } catch {
      setEditTiers([]);
    } finally {
      setLoadingTiers(false);
    }
  }

  async function handleSaveTiers(
    routingStrategy: string,
    tiers: Omit<ConfigTier, "id" | "config_id">[]
  ) {
    if (!editingConfig) return;
    // Update config strategy if changed
    if (routingStrategy !== editingConfig.routing_strategy) {
      await updateConfig(editingConfig.id, {
        routing_strategy: routingStrategy as Config["routing_strategy"],
      });
    }
    await setConfigTiers(editingConfig.id, tiers);
    setEditingConfig(null);
    await loadData();
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
        <h1 className="text-2xl font-bold text-gray-100">Configurations</h1>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Create Config
        </Button>
      </div>

      {/* Config list or empty state */}
      {configs.length === 0 && !editingConfig ? (
        <div className="flex flex-col items-center justify-center h-64 text-gray-500 space-y-4">
          <FolderOpen className="h-12 w-12 text-gray-600" />
          <p className="text-lg">No configurations.</p>
          <p className="text-sm">Create one to start routing requests.</p>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            Create Config
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {configs.map((config) => (
            <div
              key={config.id}
              className={`bg-gray-900 border rounded-xl p-5 ${
                config.is_active
                  ? "border-green-500/40 ring-1 ring-green-500/20"
                  : "border-gray-800"
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-3 mb-1">
                    <h3 className="text-lg font-semibold text-gray-100">
                      {config.name}
                    </h3>
                    {config.is_active && (
                      <Badge variant="success">Active</Badge>
                    )}
                    <Badge variant="info">{config.routing_strategy}</Badge>
                  </div>
                  {config.description && (
                    <p className="text-sm text-gray-400">
                      {config.description}
                    </p>
                  )}

                  {/* Show tier summary if tiers are available */}
                  {config.tiers && config.tiers.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-3 text-sm">
                      {(["opus", "sonnet", "haiku"] as const).map((tier) => {
                        const entries = config.tiers?.filter(
                          (t) => t.tier === tier
                        );
                        if (!entries?.length) return null;
                        return (
                          <div
                            key={tier}
                            className="flex items-center gap-1.5"
                          >
                            <span className="text-gray-500 capitalize font-medium">
                              {tier}:
                            </span>
                            <span className="text-gray-300">
                              {entries
                                .map((t) => t.account_name || "Account")
                                .join(" > ")}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 ml-4 shrink-0">
                  {!config.is_active && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleActivate(config.id)}
                    >
                      <Check className="h-4 w-4" />
                      Activate
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openEditor(config)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(config.id)}
                  >
                    <Trash2 className="h-4 w-4 text-red-400" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Config editor */}
      {editingConfig && (
        <Card
          title={`Edit: ${editingConfig.name}`}
          subtitle="Configure tier assignments and routing"
        >
          {loadingTiers ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-brand-500" />
            </div>
          ) : (
            <ConfigEditor
              config={editingConfig}
              accounts={accounts}
              tiers={editTiers}
              onSave={handleSaveTiers}
              onCancel={() => setEditingConfig(null)}
            />
          )}
        </Card>
      )}

      {/* Create modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create Configuration"
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
            placeholder="Production Config"
            required
          />
          <Textarea
            label="Description"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Optional description..."
            rows={2}
          />
          <Select
            label="Routing Strategy"
            value={newStrategy}
            onChange={(e) => setNewStrategy(e.target.value)}
            options={ROUTING_STRATEGIES}
          />
        </div>
      </Modal>
    </div>
  );
}
