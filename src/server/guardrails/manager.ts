/**
 * Guardrails manager (orchestrator).
 *
 * Handles initialization, pipeline execution, and request body processing.
 * This is the main public API for the guardrails system.
 */

import { getSetting, setSetting } from "../db.js";
import { registerBuiltinGuardrails } from "./builtin/index.js";
import { getAllGuardrails, getAllConfigs, getGuardrail, setGuardrailEnabled } from "./registry.js";
import {
  loadMappingsFromDB,
  deanonymize,
  createDeanonymizeStream,
  getPrivacyStats,
  clearMappings,
  getMappingsForUI,
} from "./shared.js";
import type { GuardrailContext, GuardrailConfig, GuardrailResult } from "./types.js";

// ─── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize the guardrails system.
 * Call once at startup after initDB().
 */
export function initGuardrails(): void {
  registerBuiltinGuardrails();
  loadMappingsFromDB();
  syncConfigFromDB();
}

/**
 * Sync guardrail enabled states from DB settings.
 * Reads `privacy_enabled` + `privacy_categories` for backward compat,
 * plus per-guardrail settings like `guardrail_<id>_enabled`.
 */
export function syncConfigFromDB(): void {
  const categories = getEnabledCategories();
  const allGuardrails = getAllGuardrails();

  for (const g of allGuardrails) {
    // Check per-guardrail setting first
    const perGuardrailSetting = getSetting(`guardrail_${g.id}_enabled`);
    if (perGuardrailSetting !== null && perGuardrailSetting !== undefined) {
      setGuardrailEnabled(g.id, perGuardrailSetting === "true" || perGuardrailSetting === "1");
      continue;
    }

    // Fall back to category-based config (backward compat)
    setGuardrailEnabled(g.id, categories.includes(g.id));
  }
}

// ─── Status checks ───────────────────────────────────────────────────────────

/**
 * Check if the guardrails system is enabled (backward-compat with privacy_enabled).
 */
export function isGuardrailsEnabled(): boolean {
  const val = getSetting("privacy_enabled");
  return val === "true" || val === "1";
}

/**
 * Get enabled categories from DB settings (backward compat).
 */
export function getEnabledCategories(): string[] {
  const val = getSetting("privacy_categories");
  if (!val) {
    return getAllGuardrails()
      .filter((g) => g.config.defaultOn)
      .map((g) => g.id);
  }
  return val
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── Pipeline execution ──────────────────────────────────────────────────────

/**
 * Run all applicable guardrails on a text string.
 * Chains text modifications through each guardrail in priority order.
 */
export function runGuardrails(
  text: string,
  lifecycle: "pre_call" | "post_call" = "pre_call",
  opts?: { requestedGuardrails?: string[]; model?: string; path?: string }
): { text: string; results: GuardrailResult[] } {
  if (!text) return { text, results: [] };

  const context: GuardrailContext = {
    text,
    lifecycle,
    model: opts?.model,
    path: opts?.path,
    requestedGuardrails: opts?.requestedGuardrails,
  };

  const results: GuardrailResult[] = [];
  let currentText = text;

  for (const guardrail of getAllGuardrails()) {
    if (!guardrail.shouldRun({ ...context, text: currentText })) continue;

    const result = guardrail.execute({ ...context, text: currentText });
    results.push(result);

    if (result.modifiedText !== undefined) {
      currentText = result.modifiedText;
    }
  }

  return { text: currentText, results };
}

/**
 * Run guardrails on an Anthropic-format request body.
 * Walks system, messages, tool_use, tool_result fields.
 */
export function runGuardrailsOnRequestBody(body: any, opts?: { requestedGuardrails?: string[] }): any {
  const clone = JSON.parse(JSON.stringify(body));

  const anonymize = (text: string): string => {
    const { text: result } = runGuardrails(text, "pre_call", opts);
    return result;
  };

  // Anonymize system prompt
  if (clone.system) {
    if (typeof clone.system === "string") {
      clone.system = anonymize(clone.system);
    } else if (Array.isArray(clone.system)) {
      for (const block of clone.system) {
        if (block.type === "text" && typeof block.text === "string") {
          block.text = anonymize(block.text);
        }
      }
    }
  }

  // Anonymize messages
  // For assistant messages: anonymize text blocks but NEVER touch thinking blocks
  // (thinking blocks have cryptographic signatures that must stay intact)
  if (Array.isArray(clone.messages)) {
    for (const msg of clone.messages) {
      if (typeof msg.content === "string") {
        msg.content = anonymize(msg.content) || msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          // Skip thinking blocks — they have signatures that must not be modified
          if (block.type === "thinking") continue;

          if (block.type === "text" && typeof block.text === "string") {
            const result = anonymize(block.text);
            if (result) block.text = result;
          }
          if (
            block.type === "tool_result" &&
            typeof block.content === "string"
          ) {
            block.content = anonymize(block.content) || block.content;
          }
          if (
            block.type === "tool_result" &&
            Array.isArray(block.content)
          ) {
            for (const inner of block.content) {
              if (inner.type === "text" && typeof inner.text === "string") {
                const result = anonymize(inner.text);
                if (result) inner.text = result;
              }
            }
          }
        }
      }
    }
  }

  return clone;
}

// ─── Re-exports for convenience ──────────────────────────────────────────────

export {
  deanonymize,
  createDeanonymizeStream,
  getPrivacyStats,
  clearMappings,
  getMappingsForUI,
} from "./shared.js";

export {
  getAllConfigs,
  getGuardrail,
  setGuardrailEnabled,
} from "./registry.js";

export type { GuardrailConfig, GuardrailResult } from "./types.js";
