// ── Types ──────────────────────────────────────────────────────────────────

export interface Account {
  id: string;
  name: string;
  provider:
    | "anthropic"
    | "openai"
    | "openai_sub"
    | "openrouter"
    | "glm"
    | "cerebras"
    | "deepseek"
    | "gemini"
    | "minimax"
    | "custom";
  auth_type: "api_key" | "oauth";
  api_key_enc?: string; // masked in responses
  base_url?: string;
  priority: number;
  rate_limit: number;
  monthly_budget?: number;
  enabled: boolean;
  subscription_type?: string;
  account_email?: string;
  token_expires_at?: number | null;
  last_used_at?: string | null;
  last_error?: string | null;
  last_error_at?: string | null;
  error_count?: number;
  status?: string; // unknown | active | expired | error | rate_limited
  decrypt_error?: boolean;
  created_at: string;
  updated_at: string;
}

export interface Config {
  id: string;
  name: string;
  description?: string;
  is_active: boolean;
  routing_strategy: "priority" | "round-robin" | "least-used" | "budget-aware";
  created_at: string;
  tiers?: ConfigTier[];
}

export interface ConfigTier {
  id: string;
  config_id: string;
  tier: "opus" | "sonnet" | "haiku";
  account_id: string;
  priority: number;
  target_model?: string;
  account_name?: string; // joined from accounts
}

export interface Session {
  id: string;
  container_id: string | null;
  name: string;
  status: string;
  port: number | null;
  account_id: string | null;
  created_at: string;
  last_active_at: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  owned_by?: string;
}

export interface SetupSnippet {
  auto: boolean;
  snippet: string;
  instructions: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || `Request failed: ${res.status} ${res.statusText}`);
  }
  // Handle 204 No Content
  if (res.status === 204) return undefined as unknown as T;
  return res.json();
}

// ── Accounts ───────────────────────────────────────────────────────────────

export async function getAccounts(): Promise<Account[]> {
  return request<Account[]>("/accounts");
}

export async function createAccount(
  data: Partial<Account> & { api_key?: string }
): Promise<Account> {
  return request<Account>("/accounts", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateAccount(
  id: string,
  data: Partial<Account>
): Promise<Account> {
  return request<Account>(`/accounts/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteAccount(id: string): Promise<void> {
  return request<void>(`/accounts/${id}`, { method: "DELETE" });
}

export async function toggleAccount(id: string): Promise<Account> {
  return request<Account>(`/accounts/${id}/toggle`, { method: "POST" });
}

export async function testAccount(id: string): Promise<{ success: boolean; message: string }> {
  return request(`/accounts/${id}/test`, { method: "POST" });
}

// ── Configs ────────────────────────────────────────────────────────────────

export async function getConfigs(): Promise<Config[]> {
  return request<Config[]>("/configs");
}

export async function createConfig(data: {
  name: string;
  description?: string;
  routing_strategy?: string;
}): Promise<Config> {
  return request<Config>("/configs", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateConfig(
  id: string,
  data: Partial<Config>
): Promise<Config> {
  return request<Config>(`/configs/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteConfig(id: string): Promise<void> {
  return request<void>(`/configs/${id}`, { method: "DELETE" });
}

export async function activateConfig(id: string): Promise<void> {
  return request<void>(`/configs/${id}/activate`, { method: "POST" });
}

export async function getConfigTiers(configId: string): Promise<ConfigTier[]> {
  return request<ConfigTier[]>(`/configs/${configId}/tiers`);
}

export async function setConfigTiers(
  configId: string,
  tiers: Omit<ConfigTier, "id" | "config_id">[]
): Promise<void> {
  return request<void>(`/configs/${configId}/tiers`, {
    method: "PUT",
    body: JSON.stringify(tiers),
  });
}

// ── Sessions ───────────────────────────────────────────────────────────────

export async function getSessions(): Promise<Session[]> {
  return request<Session[]>("/sessions");
}

export async function createSession(name: string, autoCommand?: string): Promise<Session> {
  return request<Session>("/sessions", {
    method: "POST",
    body: JSON.stringify({ name, autoCommand }),
  });
}

export async function stopSession(id: string): Promise<void> {
  return request<void>(`/sessions/${id}/stop`, { method: "POST" });
}

export async function deleteSession(id: string): Promise<void> {
  return request<void>(`/sessions/${id}`, { method: "DELETE" });
}

export async function importCredentials(
  sessionId: string,
  name?: string
): Promise<{ success: boolean; accountId?: string; accountName?: string; configCreated?: boolean; error?: string }> {
  return request(`/sessions/${sessionId}/import-credentials`, {
    method: "POST",
    body: JSON.stringify(name ? { name } : {}),
  });
}

export async function checkSessionCredentials(
  sessionId: string
): Promise<{ found: boolean; provider?: string }> {
  return request(`/sessions/${sessionId}/check-credentials`);
}

export async function getSessionAuthUrls(
  sessionId: string
): Promise<{ urls: string[] }> {
  return request(`/sessions/${sessionId}/auth-urls`);
}

// ── Setup ──────────────────────────────────────────────────────────────────

export async function getSetupSnippets(): Promise<Record<string, SetupSnippet>> {
  return request<Record<string, SetupSnippet>>("/setup/snippets");
}

export async function autoSetup(
  tool: string,
  apiKey?: string
): Promise<{ success: boolean; message: string }> {
  return request(`/setup/auto`, {
    method: "POST",
    body: JSON.stringify({ tool, apiKey }),
  });
}

// ── Settings ───────────────────────────────────────────────────────────────

export async function getSettings(): Promise<Record<string, string>> {
  return request<Record<string, string>>("/settings");
}

export async function getModelCatalog(provider?: string): Promise<ModelInfo[]> {
  const qs = provider ? `?provider=${encodeURIComponent(provider)}` : "";
  return request<ModelInfo[]>(`/settings/models${qs}`);
}

export async function refreshModelCatalog(provider?: string): Promise<ModelInfo[]> {
  return request<ModelInfo[]>("/settings/models/refresh", {
    method: "POST",
    body: JSON.stringify(provider ? { provider } : {}),
  });
}

export async function updateSettings(
  settings: Record<string, string>
): Promise<void> {
  return request<void>("/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

// ── Encryption ──────────────────────────────────────────────────────────────

export interface EncryptionKeyInfo {
  fingerprint: string;
  source: "env" | "file" | "generated";
}

export interface EncryptionInfo {
  account_key: EncryptionKeyInfo;
  guardrail_key: EncryptionKeyInfo;
  decrypt_errors: number;
}

export async function getEncryptionInfo(): Promise<EncryptionInfo> {
  return request<EncryptionInfo>("/settings/encryption");
}

export async function rotateAccountKey(): Promise<{
  fingerprint: string;
  re_encrypted: number;
  failed: number;
}> {
  return request("/settings/encryption/rotate-account-key", {
    method: "POST",
  });
}

export async function rotateGuardrailKey(): Promise<{
  fingerprint: string;
}> {
  return request("/settings/encryption/rotate-guardrail-key", {
    method: "POST",
  });
}

// ── Privacy ─────────────────────────────────────────────────────────────────

export interface PrivacyStatus {
  enabled: boolean;
  categories: string[];
  stats: {
    total_mappings: number;
    by_category: Record<string, number>;
  };
}

export interface PrivacyMappingUI {
  id: string;
  category: string;
  replacement: string;
  original_masked: string;
  created_at: string;
}

export interface PrivacyTestResult {
  original: string;
  anonymized: string;
  replacements_made: number;
  stats: {
    total_mappings: number;
    by_category: Record<string, number>;
  };
}

export async function getPrivacyStatus(): Promise<PrivacyStatus> {
  return request<PrivacyStatus>("/privacy");
}

export async function updatePrivacySettings(data: {
  enabled?: boolean;
  categories?: string[];
}): Promise<PrivacyStatus> {
  return request<PrivacyStatus>("/privacy", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function getPrivacyMappings(): Promise<PrivacyMappingUI[]> {
  return request<PrivacyMappingUI[]>("/privacy/mappings");
}

export async function deletePrivacyMappings(): Promise<void> {
  return request<void>("/privacy/mappings", { method: "DELETE" });
}

export async function testPrivacyAnonymization(
  text: string,
  categories?: string[]
): Promise<PrivacyTestResult> {
  return request<PrivacyTestResult>("/privacy/test", {
    method: "POST",
    body: JSON.stringify({ text, categories }),
  });
}

// ── Guardrails ──────────────────────────────────────────────────────────────

export interface GuardrailInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  defaultOn: boolean;
  lifecycles: string[];
  priority: number;
  category: "pii" | "credentials" | "network" | "financial";
  icon?: string;
  color?: string;
  detectionCount: number;
}

export interface GuardrailsListResponse {
  guardrails: GuardrailInfo[];
}

export async function getGuardrailsList(): Promise<GuardrailsListResponse> {
  return request<GuardrailsListResponse>("/guardrails/list");
}

export async function updateGuardrail(
  id: string,
  data: { enabled: boolean }
): Promise<GuardrailInfo> {
  return request<GuardrailInfo>(`/guardrails/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

// ── Request Logs ────────────────────────────────────────────────────────────

export interface RequestLog {
  id: string;
  timestamp: string;
  method: string | null;
  path: string | null;
  inbound_format: string | null;
  account_id: string | null;
  account_name: string | null;
  provider: string | null;
  original_model: string | null;
  routed_model: string | null;
  status_code: number;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  is_stream: boolean;
  is_failover: boolean;
  error_message: string | null;
  request_body?: string | null;
  response_body?: string | null;
}

export async function getRequestLogs(opts?: {
  page?: number;
  limit?: number;
  status?: string;
  model?: string;
}): Promise<{ logs: RequestLog[]; total: number }> {
  const params = new URLSearchParams();
  if (opts?.page) params.set("page", String(opts.page));
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.status) params.set("status", opts.status);
  if (opts?.model) params.set("model", opts.model);
  const qs = params.toString();
  return request<{ logs: RequestLog[]; total: number }>(
    `/logs${qs ? `?${qs}` : ""}`
  );
}

export async function getRequestLogDetail(id: string): Promise<RequestLog> {
  return request<RequestLog>(`/logs/${id}`);
}

export async function deleteOldLogs(
  daysOld: number
): Promise<{ deleted: number }> {
  return request<{ deleted: number }>("/logs", {
    method: "DELETE",
    body: JSON.stringify({ days_old: daysOld }),
  });
}

export async function clearAllLogs(): Promise<{ deleted: number }> {
  return request<{ deleted: number }>("/logs", {
    method: "DELETE",
    body: JSON.stringify({ clear_all: true }),
  });
}

// ── Fine-tune Export ─────────────────────────────────────────────────────────

export interface FinetuneInfo {
  enabled: boolean;
  full_context: boolean;
  file_exists: boolean;
  file_size_bytes: number;
  entry_count: number;
  file_path: string;
}

export async function getFinetuneInfo(): Promise<FinetuneInfo> {
  return request<FinetuneInfo>("/settings/finetune");
}

export async function downloadFinetuneExport(): Promise<void> {
  const res = await fetch(`${BASE}/settings/finetune/download`);
  if (!res.ok) throw new Error("Download failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "finetune-export.jsonl.gz";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function clearFinetuneData(): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>("/settings/finetune", {
    method: "DELETE",
  });
}

// ── Model Limits ────────────────────────────────────────────────────────────

export interface ModelLimitsInfo {
  maxOutputTokens: number;
  supportsToolCalling: boolean;
  supportsReasoning: boolean;
}

export async function getModelLimits(): Promise<
  Record<string, ModelLimitsInfo>
> {
  return request<Record<string, ModelLimitsInfo>>("/settings/model-limits");
}

export async function setModelLimit(
  modelId: string,
  limits: Partial<ModelLimitsInfo>
): Promise<Record<string, ModelLimitsInfo>> {
  return request<Record<string, ModelLimitsInfo>>(
    `/settings/model-limits/${encodeURIComponent(modelId)}`,
    { method: "PUT", body: JSON.stringify(limits) }
  );
}

export async function deleteModelLimit(
  modelId: string
): Promise<Record<string, ModelLimitsInfo>> {
  return request<Record<string, ModelLimitsInfo>>(
    `/settings/model-limits/${encodeURIComponent(modelId)}`,
    { method: "DELETE" }
  );
}

// ── Tenants ──────────────────────────────────────────────────────────────────

export interface Tenant {
  id: string;
  name: string;
  api_key_prefix: string;
  api_key_raw?: string | null;
  config_id: string | null;
  rate_limit: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface TenantWithSettings extends Tenant {
  settings: Record<string, string>;
}

export interface TenantCreateResponse {
  tenant: Tenant;
  api_key: string;
  warning: string;
}

export async function getTenants(): Promise<Tenant[]> {
  return request<Tenant[]>("/tenants");
}

export async function createTenant(data: {
  name: string;
  config_id?: string;
  rate_limit?: number;
}): Promise<TenantCreateResponse> {
  return request<TenantCreateResponse>("/tenants", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getTenantDetail(id: string): Promise<TenantWithSettings> {
  return request<TenantWithSettings>(`/tenants/${id}`);
}

export async function updateTenant(
  id: string,
  data: Partial<{ name: string; config_id: string | null; rate_limit: number; enabled: number }>
): Promise<Tenant> {
  return request<Tenant>(`/tenants/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteTenant(id: string): Promise<void> {
  return request<void>(`/tenants/${id}`, { method: "DELETE" });
}

export async function getTenantSettings(id: string): Promise<Record<string, string>> {
  return request<Record<string, string>>(`/tenants/${id}/settings`);
}

export async function updateTenantSettings(
  id: string,
  settings: Record<string, string>
): Promise<Record<string, string>> {
  return request<Record<string, string>>(`/tenants/${id}/settings`, {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function deleteTenantSetting(id: string, key: string): Promise<void> {
  return request<void>(`/tenants/${id}/settings/${key}`, { method: "DELETE" });
}

export async function rotateTenantKey(id: string): Promise<TenantCreateResponse> {
  return request<TenantCreateResponse>(`/tenants/${id}/rotate-key`, { method: "POST" });
}

export async function regenerateProxyKey(): Promise<{ key: string }> {
  return request<{ key: string }>("/settings/regenerate-proxy-key", { method: "POST" });
}
