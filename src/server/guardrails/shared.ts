/**
 * Shared utilities for the guardrails system.
 *
 * HMAC, entropy analysis, in-memory caches, core mapping logic,
 * deanonymization, and DB persistence.
 */

import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getMasterKey, encrypt, decrypt } from "../encryption.js";
import {
  getSetting,
  getPrivacyMapping,
  getPrivacyMappingByReplacement,
  createPrivacyMapping,
  getAllPrivacyMappings,
  deletePrivacyMappings,
  getPrivacyMappingCount,
  type PrivacyMapping,
} from "../db.js";
import type { GuardrailConfig, GuardrailContext } from "./types.js";

// ─── In-memory caches ────────────────────────────────────────────────────────

/** hash(original) -> { replacement, category } */
export const hashToReplacement = new Map<
  string,
  { replacement: string; category: string }
>();

/** replacement -> original plaintext */
export const replacementToOriginal = new Map<string, string>();

// ─── HMAC helper ─────────────────────────────────────────────────────────────

export function hmac(value: string): string {
  return crypto
    .createHmac("sha256", getMasterKey())
    .update(value)
    .digest("hex");
}

export function shortHash(value: string, len = 4): string {
  return hmac(value).slice(0, len);
}

// ─── Entropy analysis ────────────────────────────────────────────────────────

/**
 * Calculate Shannon entropy (bits per character) of a string.
 * High entropy (>3.5) indicates randomness - likely a secret.
 */
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

/**
 * Count distinct character classes in a string.
 */
export function charClassCount(s: string): number {
  let classes = 0;
  if (/[a-z]/.test(s)) classes++;
  if (/[A-Z]/.test(s)) classes++;
  if (/[0-9]/.test(s)) classes++;
  if (/[^a-zA-Z0-9]/.test(s)) classes++;
  return classes;
}

/**
 * Determine if a string looks like a high-entropy secret.
 */
export function looksLikeSecret(s: string): boolean {
  if (s.length < 8) return false;

  const entropy = shannonEntropy(s);
  const classes = charClassCount(s);

  if (entropy >= 4.0 && classes >= 3) return true;
  if (entropy >= 3.5 && classes >= 3 && s.length >= 16) return true;
  if (entropy >= 3.0 && s.length >= 32) return true;
  if (/^[0-9a-f]{32,}$/i.test(s) && s.length >= 32) return true;
  if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(s) && entropy >= 3.5) return true;

  return false;
}

// ─── Core mapping logic ──────────────────────────────────────────────────────

export function getOrCreateMapping(
  original: string,
  category: string,
  generatorFn: (orig: string) => string
): string {
  const origHash = hmac(original);

  // Check in-memory cache first
  const cached = hashToReplacement.get(origHash);
  if (cached) return cached.replacement;

  // Check DB
  const existing = getPrivacyMapping(origHash);
  if (existing) {
    const decryptedOriginal = decrypt(existing.original_enc);
    hashToReplacement.set(origHash, {
      replacement: existing.replacement,
      category: existing.category,
    });
    replacementToOriginal.set(existing.replacement, decryptedOriginal);
    return existing.replacement;
  }

  // Generate new replacement
  let replacement = generatorFn(original);

  // Ensure uniqueness
  let attempts = 0;
  while (replacementToOriginal.has(replacement) && attempts < 10) {
    replacement = generatorFn(original + String(attempts));
    attempts++;
  }

  // Persist to DB
  createPrivacyMapping({
    id: uuidv4(),
    category,
    original_hash: origHash,
    original_enc: encrypt(original),
    replacement,
  });

  // Update caches
  hashToReplacement.set(origHash, { replacement, category });
  replacementToOriginal.set(replacement, original);

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

// ─── Deanonymization ─────────────────────────────────────────────────────────

/**
 * Reverse all known replacements in the text.
 */
export function deanonymize(text: string): string {
  if (!text) return text;

  let result = text;

  // Sort replacements by length descending to avoid partial matches
  const sortedReplacements = [...replacementToOriginal.entries()].sort(
    (a, b) => b[0].length - a[0].length
  );

  for (const [replacement, original] of sortedReplacements) {
    while (result.includes(replacement)) {
      result = result.replace(replacement, original);
    }
  }

  return result;
}

/**
 * Create a ReadableStream that deanonymises each SSE chunk.
 */
export function createDeanonymizeStream(
  inputStream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = inputStream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.length > 0) {
              const deanon = deanonymize(buffer);
              controller.enqueue(encoder.encode(deanon));
            }
            controller.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE events
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            if (!part.trim()) {
              controller.enqueue(encoder.encode("\n\n"));
              continue;
            }
            const deanon = deanonymize(part);
            controller.enqueue(encoder.encode(deanon + "\n\n"));
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

// ─── Default gating logic ────────────────────────────────────────────────────

/**
 * Shared shouldRun logic: check lifecycle match + enabled + requested list.
 */
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
  hashToReplacement.clear();
  replacementToOriginal.clear();
}

/**
 * Load all existing mappings from DB into memory caches.
 * Call once at startup after initDB().
 */
export function loadMappingsFromDB(): void {
  const all = getAllPrivacyMappings();
  for (const m of all) {
    try {
      const original = decrypt(m.original_enc);
      hashToReplacement.set(m.original_hash, {
        replacement: m.replacement,
        category: m.category,
      });
      replacementToOriginal.set(m.replacement, original);
    } catch {
      console.warn(
        `[guardrails] Could not decrypt mapping ${m.id}, skipping`
      );
    }
  }
  console.log(
    `[guardrails] Loaded ${all.length} mappings from DB into memory cache`
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
    try {
      const original = decrypt(m.original_enc);
      if (original.length <= 6) {
        originalMasked = original.charAt(0) + "***" + original.charAt(original.length - 1);
      } else {
        originalMasked = `${original.slice(0, 3)}...${original.slice(-3)}`;
      }
    } catch {
      originalMasked = "[decrypt error]";
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
