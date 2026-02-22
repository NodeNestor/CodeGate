export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
  body: string | ReadableStream<Uint8Array>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
  isStream: boolean;
}

export interface ForwardOptions {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  apiKey: string;
  baseUrl?: string | null;
  authType?: string;
  externalAccountId?: string | null;
}
