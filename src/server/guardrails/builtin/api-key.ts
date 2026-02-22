/**
 * API Key & Token guardrail.
 *
 * Detects 40+ vendor API key prefixes and falls back to
 * entropy-based detection for unknown key formats.
 */

import type { Guardrail, GuardrailConfig, GuardrailContext, GuardrailResult } from "../types.js";
import {
  defaultShouldRun,
  getOrCreateMapping,
  shortHash,
  shannonEntropy,
  charClassCount,
  looksLikeSecret,
} from "../shared.js";

// 40+ vendor prefix patterns
const VENDOR_PREFIXES = [
  "sk-ant-", "sk-proj-", "sk-", "ghp_", "gho_", "glpat-", "xoxb-",
  "xoxp-", "xapp-", "xoxe-", "AKIA", "AIza", "hf_", "pk_live_", "sk_live_",
  "rk_live_", "whsec_", "github_pat_", "pypi-", "npm_", "FLWSECK-",
  "sq0atp-", "SG.", "key-", "sk-or-", "r8_", "sntrys_",
  "op_", "Bearer ey",
];

// Combined regex for known prefixes
const KNOWN_PREFIX_RE =
  /(?:sk-ant-|sk-proj-|sk-|ghp_|gho_|glpat-|xoxb-|xoxp-|xapp-|xoxe-|AKIA|AIza|hf_|pk_live_|sk_live_|rk_live_|whsec_|github_pat_|pypi-|npm_|FLWSECK-|sq0atp-|SG\.|key-|sk-or-|r8_|sntrys_|op_|Bearer\s+ey)[A-Za-z0-9_\-/.+=]{10,}/g;

// Standalone high-entropy token pattern (for entropy fallback)
const STANDALONE_TOKEN_RE =
  /(?<![a-zA-Z0-9_/\-.])([A-Za-z0-9+/=_\-]{20,})(?![a-zA-Z0-9_/\-.])/g;

function generateApiKeyReplacement(original: string): string {
  let prefix = "";
  for (const p of VENDOR_PREFIXES) {
    if (original.startsWith(p)) {
      prefix = p;
      break;
    }
  }
  if (!prefix) prefix = "key-";
  const h = shortHash(original, 8);
  return `${prefix}redacted-${h}`;
}

function generateSecretReplacement(original: string): string {
  const h = shortHash(original, 8);
  const lenBucket =
    original.length < 16 ? "short" : original.length < 64 ? "med" : "long";
  return `[SECRET-${lenBucket}-${h}]`;
}

export function createApiKeyGuardrail(): Guardrail {
  const config: GuardrailConfig = {
    id: "api_key",
    name: "API Keys & Tokens",
    description: "Detect 40+ vendor API key prefixes and high-entropy tokens",
    enabled: true,
    defaultOn: true,
    lifecycles: ["pre_call"],
    priority: 4,
    category: "credentials",
    icon: "Key",
    color: "text-red-400 bg-red-600/10",
  };

  return {
    id: "api_key",
    config,

    shouldRun(context: GuardrailContext): boolean {
      return defaultShouldRun(config, context);
    },

    execute(context: GuardrailContext): GuardrailResult {
      let text = context.text;
      let count = 0;

      // Strategy 1: Known vendor prefixes
      KNOWN_PREFIX_RE.lastIndex = 0;
      text = text.replace(KNOWN_PREFIX_RE, (match) => {
        count++;
        return getOrCreateMapping(match, "api_key", generateApiKeyReplacement);
      });

      // Strategy 2: Entropy-based fallback for unknown key formats
      STANDALONE_TOKEN_RE.lastIndex = 0;
      text = text.replace(STANDALONE_TOKEN_RE, (fullMatch, token) => {
        // Skip already-replaced tokens
        if (token.startsWith("[REDACTED") || token.startsWith("[SECRET")) return fullMatch;
        if (token.startsWith("redacted-")) return fullMatch;
        if (token.includes("-redacted-")) return fullMatch;

        // Skip commit hashes / UUIDs (hex under 40 chars)
        if (/^[a-f0-9]{32,}$/i.test(token) && token.length < 40) return fullMatch;

        if (looksLikeSecret(token)) {
          count++;
          const replacement = getOrCreateMapping(
            token,
            "api_key",
            generateSecretReplacement
          );
          return fullMatch.replace(token, replacement);
        }
        return fullMatch;
      });

      return {
        guardrailId: "api_key",
        action: count > 0 ? "mask" : "allow",
        modifiedText: text,
        detectionCount: count,
      };
    },
  };
}
