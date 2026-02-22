/**
 * Shared utilities for the guardrails system.
 *
 * Stateless deterministic encryption - replacements contain encrypted originals,
 * so deanonymization needs no DB lookups. The DB is just a log for the UI.
 */

import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getGuardrailKey } from "../encryption.js";
import {
  createPrivacyMapping,
  getAllPrivacyMappings,
  deletePrivacyMappings,
  getPrivacyMappingCount,
} from "../db.js";
import type { GuardrailConfig, GuardrailContext } from "./types.js";

// ─── Deterministic encryption for stateless deanonymization ───────────────────

/**
 * Derive a deterministic IV from the value and a domain-specific salt.
 * This ensures the same value always produces the same ciphertext.
 */
function deriveIv(value: string, domain: string): Buffer {
  const key = getGuardrailKey();
  const salt = crypto
    .createHmac("sha256", key)
    .update(domain)
    .digest();
  return crypto
    .createHmac("sha256", salt)
    .update(value)
    .digest()
    .slice(0, 16);
}

/**
 * Encrypt a value for embedding in a replacement token.
 * Deterministic: same input always produces the same token.
 * Format: base64url( IV(16) + ciphertext + checksum(4) )
 * The IV is included so decryption doesn't need the plaintext.
 */
export function encryptForToken(value: string, domain: string): string {
  const key = getGuardrailKey();
  const iv = deriveIv(value, domain);

  const cipher = crypto.createCipheriv("aes-256-ctr", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);

  const checksum = crypto
    .createHmac("sha256", key)
    .update(value + domain)
    .digest()
    .slice(0, 4);

  return Buffer.concat([iv, encrypted, checksum])
    .toString("base64url")
    .replace(/=/g, "");
}

/**
 * Decrypt a token back to the original value.
 * Extracts the IV from the first 16 bytes of the token.
 * Returns null if decryption fails or checksum doesn't match.
 */
export function decryptToken(token: string, domain: string): string | null {
  try {
    const key = getGuardrailKey();
    const data = Buffer.from(token, "base64url");

    // Format: IV(16) + ciphertext(1+) + checksum(4) = minimum 21 bytes
    if (data.length < 21) return null;

    const iv = data.slice(0, 16);
    const encrypted = data.slice(16, -4);
    const checksum = data.slice(-4);

    const decipher = crypto.createDecipheriv("aes-256-ctr", key, iv);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    const plaintext = decrypted.toString("utf8");

    const expectedChecksum = crypto
      .createHmac("sha256", key)
      .update(plaintext + domain)
      .digest()
      .slice(0, 4);

    if (!checksum.equals(expectedChecksum)) {
      return null;
    }

    return plaintext;
  } catch {
    return null;
  }
}

// ─── HMAC helper (for deterministic selection) ────────────────────────────────

export function hmac(value: string): string {
  return crypto
    .createHmac("sha256", getGuardrailKey())
    .update(value)
    .digest("hex");
}

export function shortHash(value: string, len = 4): string {
  return hmac(value).slice(0, len);
}

// ─── Entropy analysis ────────────────────────────────────────────────────────

export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) || 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function charClassCount(s: string): number {
  let classes = 0;
  if (/[a-z]/.test(s)) classes++;
  if (/[A-Z]/.test(s)) classes++;
  if (/[0-9]/.test(s)) classes++;
  if (/[^a-zA-Z0-9]/.test(s)) classes++;
  return classes;
}

export function looksLikeSecret(s: string): boolean {
  if (s.length < 8) return false;

  // Skip file paths and slash-separated text (torch/torchaudio/pyannote)
  if (s.includes("/")) return false;

  // Skip kebab-case identifiers (model IDs like claude-haiku-4-5-20251001)
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+){2,}$/.test(s)) return false;

  // Skip our own anonymization tokens
  if (s.startsWith("SECRET-") || s.startsWith("REDACTED-")) return false;

  const entropy = shannonEntropy(s);
  const classes = charClassCount(s);

  if (entropy >= 4.0 && classes >= 3) return true;
  if (entropy >= 3.5 && classes >= 3 && s.length >= 16) return true;
  if (entropy >= 3.0 && s.length >= 32) return true;
  if (/^[0-9a-f]{32,}$/i.test(s) && s.length >= 32) return true;
  if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(s) && entropy >= 3.5) return true;

  return false;
}

// ─── Stateless replacement generation ─────────────────────────────────────────

/**
 * Create a stateless replacement that embeds the encrypted original.
 * Format: <fakeValue>-<encryptedToken>
 * The encrypted token can be decrypted on the way back with no DB lookup.
 */
export function createStatelessReplacement(
  original: string,
  category: string,
  fakeValue: string
): string {
  const token = encryptForToken(original, category);
  const replacement = `${fakeValue}-${token}`;

  // Log to DB for UI visibility (but don't depend on it for decryption)
  logReplacement(category, original, replacement);

  return replacement;
}

// ─── Logging + reverse map ────────────────────────────────────────────────────

let recentReplacements: Array<{
  category: string;
  original: string;
  replacement: string;
  timestamp: number;
}> = [];

const MAX_RECENT = 1000;

/**
 * Reverse map: replacement → original.
 * Populated during anonymization, used during deanonymization.
 * Works within a single request cycle (anonymize request → deanonymize response).
 * Also persists across requests since the full conversation is re-anonymized each turn.
 */
const reverseMap = new Map<string, string>();

export function reverseLookup(replacement: string): string | null {
  return reverseMap.get(replacement) ?? null;
}

function logReplacement(
  category: string,
  original: string,
  replacement: string
): void {
  reverseMap.set(replacement, original);

  // Also register inner sub-values that the model might extract from
  // structured replacement formats. Without this, the model extracts e.g.
  // "80.226.116.71" from "[IP-80.226.116.71-oeVI73]" and writes it plain,
  // causing deanonymization failure and re-anonymization loops.
  const ipMatch = replacement.match(/\[IP-(\d+\.\d+\.\d+\.\d+)-/);
  if (ipMatch) {
    reverseMap.set(ipMatch[1], original);
  }
  const phoneMatch = replacement.match(/^(\d{3}-\d{3}-\d{4})-[A-Za-z0-9_-]+$/);
  if (phoneMatch) {
    reverseMap.set(phoneMatch[1], original);
  }

  recentReplacements.push({
    category,
    original,
    replacement,
    timestamp: Date.now(),
  });

  // Keep only recent
  if (recentReplacements.length > MAX_RECENT) {
    recentReplacements = recentReplacements.slice(-MAX_RECENT);
  }

  // Also persist to DB for long-term storage
  try {
    const h = hmac(original);
    createPrivacyMapping({
      id: uuidv4(),
      category,
      original_hash: h,
      original_enc: "", // We don't need this anymore, but DB schema requires it
      replacement,
    });
  } catch {
    // Ignore DB errors - logging is optional
  }
}

// ─── Core mapping logic (stateless version) ───────────────────────────────────

/**
 * Generate a replacement for a matched value.
 * Generators already embed encrypted tokens — just call and log.
 */
export function getOrCreateMapping(
  original: string,
  category: string,
  generatorFn: (orig: string) => string
): string {
  const replacement = generatorFn(original);
  logReplacement(category, original, replacement);
  return replacement;
}

/**
 * Replace all matches of a pattern with mapped replacements.
 */
export function replacePatternMatches(
  text: string,
  pattern: RegExp,
  category: string,
  generatorFn: (orig: string) => string
): string {
  pattern.lastIndex = 0;
  return text.replace(pattern, (match) =>
    getOrCreateMapping(match, category, generatorFn)
  );
}

// ─── Stateless deanonymization ────────────────────────────────────────────────

// Pattern for bracketed tokens: [CATEGORY-<token>] or [CATEGORY-prefix-<token>]
const BRACKET_TOKEN_PATTERN = /\[([A-Z]+)(?:-[0-9.]+)?-([A-Za-z0-9_-]+)\]/g;

// Pattern for SECRET tokens: [SECRET-bucket-token]
const SECRET_TOKEN_PATTERN = /\[SECRET-(short|med|long)-([A-Za-z0-9_-]+)\]/gi;

// Pattern for email tokens: <anything>@anon.com (reverse-map lookup)
const EMAIL_TOKEN_PATTERN = /[a-zA-Z0-9._%+-]+@anon\.com/gi;

// Name deanonymization uses reverse-map (no bracket tokens anymore)

// Pattern for URL redacted: [redacted-<token>]
const URL_REDACTED_PATTERN = /\[redacted-([A-Za-z0-9_-]+)\]/gi;

// Pattern for phone with token suffix: 555-123-4567-<token>
const PHONE_TOKEN_PATTERN = /\b(\d{3}-\d{3}-\d{4})-([A-Za-z0-9_-]+)\b/g;

// Pattern for API keys with prefix: sk-[token], ghp_[token], etc.
const API_KEY_PATTERN = /(sk-ant-|sk-proj-|sk-|ghp_|gho_|glpat-|xoxb-|xoxp-|xapp-|xoxe-|AKIA|AIza|hf_|pk_live_|sk_live_|rk_live_|whsec_|github_pat_|pypi-|npm_|FLWSECK-|sq0atp-|SG\.|key-|sk-or-|r8_|sntrys_|op_|Bearer\s+)?\[([A-Za-z0-9_-]+)\]/gi;

// Category mapping for bracket prefixes
const BRACKET_CATEGORY_MAP: Record<string, string> = {
  SSN: "ssn",
  VISA: "card",
  MC: "card",
  AMEX: "card",
  DISC: "card",
  CARD: "card",
  IBAN: "iban",
  PASSPORT: "passport",
  IP: "ip",
  IPv6: "ip",
  ADDR: "address",
  AKIA: "aws",
  "AWS-SECRET": "aws",
  JWT: "jwt",
  "PRIVATE-KEY": "key",
  REDACTED: "password",
};

/**
 * Reverse all known replacements in the text using stateless decryption.
 */
export function deanonymize(text: string): string {
  if (!text) return text;

  let result = text;

  // 1. Handle API keys with prefixes: sk-[token], ghp_[token], etc.
  API_KEY_PATTERN.lastIndex = 0;
  result = result.replace(API_KEY_PATTERN, (fullMatch, prefix, token) => {
    const decrypted = decryptToken(token, "api_key");
    if (decrypted) return decrypted;
    const decryptedSecret = decryptToken(token, "secret");
    if (decryptedSecret) return decryptedSecret;
    return reverseLookup(fullMatch) || fullMatch;
  });

  // 2. Handle SECRET tokens: [SECRET-bucket-token]
  SECRET_TOKEN_PATTERN.lastIndex = 0;
  result = result.replace(SECRET_TOKEN_PATTERN, (fullMatch, _bucket, token) => {
    const decrypted = decryptToken(token, "secret");
    return decrypted || reverseLookup(fullMatch) || fullMatch;
  });

  // 3. Handle bracketed tokens: [CATEGORY-token] or [CATEGORY-prefix-token]
  BRACKET_TOKEN_PATTERN.lastIndex = 0;
  result = result.replace(BRACKET_TOKEN_PATTERN, (fullMatch, prefix, token) => {
    const category = BRACKET_CATEGORY_MAP[prefix] || prefix.toLowerCase();
    const decrypted = decryptToken(token, category);
    return decrypted || reverseLookup(fullMatch) || fullMatch;
  });

  // 4. Handle email format: <anything>@anon.com (reverse-map lookup)
  EMAIL_TOKEN_PATTERN.lastIndex = 0;
  result = result.replace(EMAIL_TOKEN_PATTERN, (fullMatch) => {
    return reverseLookup(fullMatch) || fullMatch;
  });

  // 4.5. Handle plain IPs and phone numbers registered in reverse-map
  // (The model extracts these from bracket tokens and writes them plain)
  const PLAIN_IP_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
  PLAIN_IP_PATTERN.lastIndex = 0;
  result = result.replace(PLAIN_IP_PATTERN, (fullMatch) => {
    return reverseLookup(fullMatch) || fullMatch;
  });
  const PLAIN_PHONE_PATTERN = /\b\d{3}-\d{3}-\d{4}\b/g;
  PLAIN_PHONE_PATTERN.lastIndex = 0;
  result = result.replace(PLAIN_PHONE_PATTERN, (fullMatch) => {
    return reverseLookup(fullMatch) || fullMatch;
  });

  // 5. Handle name replacements via reverse-map lookup
  // Names are plain fake names (no tokens), so we do whole-word reverse lookups
  for (const [replacement, original] of reverseMap) {
    // Only process name-category replacements (skip emails, IPs, phones, etc.)
    // Name replacements are plain words without special chars like @ [ ] . -
    if (replacement.includes("@") || replacement.startsWith("[")) continue;
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(replacement)) continue; // skip IPs
    if (/^\d{3}-\d{3}-\d{4}$/.test(replacement)) continue; // skip phones
    if (!result.includes(replacement)) continue;
    // Replace all whole-word occurrences
    const escaped = replacement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`\\b${escaped}\\b`, "g"), original);
  }

  // 6. Handle URL redacted format: [redacted-token]
  URL_REDACTED_PATTERN.lastIndex = 0;
  result = result.replace(URL_REDACTED_PATTERN, (fullMatch, token) => {
    const decrypted = decryptToken(token, "url");
    if (decrypted) {
      const credMatch = decrypted.match(/\/\/([^:]+):([^@]+)@/);
      if (credMatch) {
        return `//[${credMatch[1]}:[REDACTED]]@`;
      }
    }
    return reverseLookup(fullMatch) || fullMatch;
  });

  // 7. Handle phone format: 555-123-4567-token
  PHONE_TOKEN_PATTERN.lastIndex = 0;
  result = result.replace(PHONE_TOKEN_PATTERN, (fullMatch, _fakePhone, token) => {
    const decrypted = decryptToken(token, "phone");
    return decrypted || reverseLookup(fullMatch) || fullMatch;
  });

  return result;
}

/**
 * Create a ReadableStream that deanonymises SSE streaming responses.
 *
 * Tokens can be split across multiple SSE events (each event carries a small
 * text delta). We buffer text_delta content per content block and only flush
 * text that can't be part of an in-progress token. On content_block_stop
 * (or stream end) we flush everything remaining.
 */
export function createDeanonymizeStream(
  inputStream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let sseBuffer = "";
  const textBuffers = new Map<number, string>();
  const jsonBuffers = new Map<number, string>();

  /**
   * Find the latest safe cut point in text — everything before this index
   * cannot be part of a still-growing anonymised token.
   *
   * Uses the reverseMap to check if the buffer's tail matches the START
   * of any known anonymized value. This prevents flushing partial tokens
   * like "dakota.chen35" when "dakota.chen35@anon.com" hasn't arrived yet.
   */
  function findSafeFlushPoint(text: string): number {
    if (!text) return 0;

    const searchStart = Math.max(0, text.length - 200);
    const tail = text.slice(searchStart);

    // 1. Unclosed bracket: [CATEGORY-token... or [SECRET-med-token...
    const lastOpen = tail.lastIndexOf("[");
    if (lastOpen !== -1 && tail.indexOf("]", lastOpen) === -1) {
      return searchStart + lastOpen;
    }

    // 2. Check if the buffer tail is a prefix of any known anonymized value.
    //    This catches partial emails (e.g., "dakota.chen35" when full token
    //    is "dakota.chen35@anon.com") and partial names/other tokens.
    let maxOverlap = 0;
    for (const key of reverseMap.keys()) {
      if (key.startsWith("[")) continue; // Bracket tokens handled above
      const limit = Math.min(key.length - 1, text.length);
      for (let k = limit; k >= 3; k--) {
        if (k <= maxOverlap) break; // Can't beat current best
        if (text.endsWith(key.slice(0, k))) {
          maxOverlap = k;
          break;
        }
      }
    }

    if (maxOverlap > 0) {
      return text.length - maxOverlap;
    }

    return text.length;
  }

  function makeTextDelta(index: number, text: string): string {
    return (
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text },
      })}\n\n`
    );
  }

  function makeJsonDelta(index: number, json: string): string {
    return (
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: json },
      })}\n\n`
    );
  }

  function flushBuffer(
    index: number,
    controller: ReadableStreamDefaultController<Uint8Array>
  ): void {
    const buf = textBuffers.get(index);
    if (buf) {
      const deanon = deanonymize(buf);
      controller.enqueue(encoder.encode(makeTextDelta(index, deanon)));
      textBuffers.delete(index);
    }
    const jsonBuf = jsonBuffers.get(index);
    if (jsonBuf) {
      const deanon = deanonymize(jsonBuf);
      controller.enqueue(encoder.encode(makeJsonDelta(index, deanon)));
      jsonBuffers.delete(index);
    }
  }

  function tryFlushSafe(
    index: number,
    controller: ReadableStreamDefaultController<Uint8Array>
  ): void {
    const buf = textBuffers.get(index) || "";
    if (!buf) return;

    const safePoint = findSafeFlushPoint(buf);
    if (safePoint > 0) {
      const safe = buf.slice(0, safePoint);
      const remaining = buf.slice(safePoint);
      const deanon = deanonymize(safe);
      controller.enqueue(encoder.encode(makeTextDelta(index, deanon)));
      textBuffers.set(index, remaining);
    }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = inputStream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Flush all remaining buffers
            const allIndices = new Set([...textBuffers.keys(), ...jsonBuffers.keys()]);
            for (const idx of allIndices) {
              flushBuffer(idx, controller);
            }
            if (sseBuffer.trim()) {
              const deanon = deanonymize(sseBuffer);
              controller.enqueue(encoder.encode(deanon));
            }
            controller.close();
            break;
          }

          sseBuffer += decoder.decode(value, { stream: true });

          // Process complete SSE events (separated by \n\n)
          const parts = sseBuffer.split("\n\n");
          sseBuffer = parts.pop() || "";

          for (const part of parts) {
            if (!part.trim()) {
              controller.enqueue(encoder.encode("\n\n"));
              continue;
            }

            // Try to parse the SSE data line
            const dataMatch = part.match(/^data:\s*(.+)$/m);
            if (!dataMatch) {
              controller.enqueue(encoder.encode(deanonymize(part) + "\n\n"));
              continue;
            }

            let parsed: any;
            try {
              parsed = JSON.parse(dataMatch[1]);
            } catch {
              controller.enqueue(encoder.encode(deanonymize(part) + "\n\n"));
              continue;
            }

            // Anthropic text_delta → buffer for cross-event deanonymization
            if (
              parsed.type === "content_block_delta" &&
              parsed.delta?.type === "text_delta" &&
              typeof parsed.delta.text === "string"
            ) {
              const idx: number = parsed.index ?? 0;
              const existing = textBuffers.get(idx) || "";
              textBuffers.set(idx, existing + parsed.delta.text);
              tryFlushSafe(idx, controller);
              continue;
            }

            // Anthropic input_json_delta → buffer for tool call deanonymization
            if (
              parsed.type === "content_block_delta" &&
              parsed.delta?.type === "input_json_delta" &&
              typeof parsed.delta.partial_json === "string"
            ) {
              const idx: number = parsed.index ?? 0;
              const existing = jsonBuffers.get(idx) || "";
              jsonBuffers.set(idx, existing + parsed.delta.partial_json);
              continue; // Don't flush until content_block_stop
            }

            // content_block_stop → flush remaining buffered text, then forward
            if (parsed.type === "content_block_stop") {
              const idx: number = parsed.index ?? 0;
              flushBuffer(idx, controller);
              controller.enqueue(encoder.encode(part + "\n\n"));
              continue;
            }

            // Everything else (message_start, thinking, tool_use, ping, …)
            // passes through with basic per-event deanonymization
            controller.enqueue(encoder.encode(deanonymize(part) + "\n\n"));
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

// ─── Default gating logic ────────────────────────────────────────────────────

export function defaultShouldRun(
  config: GuardrailConfig,
  context: GuardrailContext
): boolean {
  if (!config.enabled) return false;
  if (!config.lifecycles.includes(context.lifecycle)) return false;
  if (
    context.requestedGuardrails &&
    context.requestedGuardrails.length > 0 &&
    !context.requestedGuardrails.includes(config.id)
  ) {
    return false;
  }
  return true;
}

// ─── Stats / admin ───────────────────────────────────────────────────────────

export function getPrivacyStats(): {
  total_mappings: number;
  by_category: Record<string, number>;
} {
  const { total, by_category } = getPrivacyMappingCount();
  return { total_mappings: total, by_category };
}

export function clearMappings(): void {
  deletePrivacyMappings();
  recentReplacements = [];
  reverseMap.clear();
}

/**
 * Load all existing mappings from DB into memory (for backward compatibility).
 * No longer needed for stateless decryption, but kept for migration.
 */
export function loadMappingsFromDB(): void {
  const all = getAllPrivacyMappings();
  console.log(
    `[guardrails] Stateless mode - ${all.length} historical mappings in DB (not loaded, using decryption)`
  );
}

/**
 * Get all mappings with masked originals (for the UI).
 */
export function getMappingsForUI(): Array<{
  id: string;
  category: string;
  replacement: string;
  original_masked: string;
  created_at: string;
}> {
  const all = getAllPrivacyMappings();
  return all.map((m) => {
    let originalMasked = "***";
    // Strip brackets then extract the last token segment
    const stripped = m.replacement.replace(/^\[|\]$/g, "");
    const match = stripped.match(/-([A-Za-z0-9_-]{8,})$/);
    if (match) {
      // Try multiple domains since different guardrails use different ones
      const domains = [m.category, "secret", "password", "api_key", "ip", "phone"];
      let decrypted: string | null = null;
      for (const domain of domains) {
        decrypted = decryptToken(match[1], domain);
        if (decrypted) break;
      }
      if (decrypted) {
        if (decrypted.length <= 6) {
          originalMasked = decrypted.charAt(0) + "***" + decrypted.charAt(decrypted.length - 1);
        } else {
          originalMasked = `${decrypted.slice(0, 3)}...${decrypted.slice(-3)}`;
        }
      }
    }
    // Fallback: check reverse map for non-encrypted tokens (names, emails)
    if (originalMasked === "***") {
      const original = reverseLookup(m.replacement);
      if (original) {
        if (original.length <= 6) {
          originalMasked = original.charAt(0) + "***" + original.charAt(original.length - 1);
        } else {
          originalMasked = `${original.slice(0, 3)}...${original.slice(-3)}`;
        }
      }
    }
    return {
      id: m.id,
      category: m.category,
      replacement: m.replacement,
      original_masked: originalMasked,
      created_at: m.created_at,
    };
  });
}
