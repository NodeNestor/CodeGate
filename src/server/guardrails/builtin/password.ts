/**
 * Password & Secrets guardrail.
 *
 * 3 detection strategies:
 * 1. Keyword context (password=, secret:, token is, etc.)
 * 2. Standalone high-entropy string scan
 * 3. Env var assignments with secret-sounding names
 */

import type { Guardrail, GuardrailConfig, GuardrailContext, GuardrailResult } from "../types.js";
import {
  defaultShouldRun,
  getOrCreateMapping,
  encryptForToken,
  looksLikeSecret,
} from "../shared.js";

function generatePasswordReplacement(original: string): string {
  const token = encryptForToken(original, "password");
  return `[REDACTED-${token.slice(0, 12)}]`;
}

function generateSecretReplacement(original: string): string {
  const token = encryptForToken(original, "secret");
  const lenBucket =
    original.length < 16 ? "short" : original.length < 64 ? "med" : "long";
  return `[SECRET-${lenBucket}-${token.slice(0, 12)}]`;
}

// Keyword context pattern (29+ keywords)
const KEYWORD_CONTEXT_RE =
  /(?:password|passwd|pass|pwd|secret|token|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key|secret[_-]?key|encryption[_-]?key|master[_-]?key|signing[_-]?key|client[_-]?secret|app[_-]?secret|jwt|bearer|credential|ssh[_-]?key|session[_-]?id|session[_-]?token|webhook[_-]?secret|signing[_-]?secret)\s*(?:[:=]|is|was|set\s+to)\s*["']?([^\s"',;}{)\]]{6,})["']?/gi;

// Standalone high-entropy token pattern
const STANDALONE_ENTROPY_RE =
  /(?<![a-zA-Z0-9_/\-.])([A-Za-z0-9+/=_\-]{20,})(?![a-zA-Z0-9_/\-.])/g;

// Environment variable assignment with secret-sounding names
const ENV_VAR_SECRET_RE =
  /([A-Z][A-Z0-9_]{2,})\s*=\s*["']?([^\s"']{12,})["']?/g;

const SECRET_VAR_NAMES_RE =
  /(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|SIGNING|MASTER|ENCRYPTION|API|JWT)/i;

export function createPasswordGuardrail(): Guardrail {
  const config: GuardrailConfig = {
    id: "password",
    name: "Passwords & Secrets",
    description: "Detect values near password/secret/token keywords and env vars",
    enabled: true,
    defaultOn: true,
    lifecycles: ["pre_call"],
    priority: 6,
    category: "credentials",
    icon: "Lock",
    color: "text-orange-400 bg-orange-600/10",
  };

  return {
    id: "password",
    config,

    shouldRun(context: GuardrailContext): boolean {
      return defaultShouldRun(config, context);
    },

    execute(context: GuardrailContext): GuardrailResult {
      let text = context.text;
      let count = 0;

      // Strategy 1: Keyword context detection
      KEYWORD_CONTEXT_RE.lastIndex = 0;
      text = text.replace(
        KEYWORD_CONTEXT_RE,
        (fullMatch, value) => {
          if (!value || value.length < 6) return fullMatch;
          if (/^(true|false|null|undefined|none|\d+)$/i.test(value)) return fullMatch;
          count++;
          const replacement = getOrCreateMapping(
            value,
            "password",
            generatePasswordReplacement
          );
          return fullMatch.replace(value, replacement);
        }
      );

      // Strategy 2: Standalone high-entropy string scan
      STANDALONE_ENTROPY_RE.lastIndex = 0;
      text = text.replace(STANDALONE_ENTROPY_RE, (fullMatch, token) => {
        if (token.startsWith("[REDACTED") || token.startsWith("[SECRET")) return fullMatch;
        // Skip content inside bracket tokens (regex captures without brackets)
        if (token.startsWith("SECRET-") || token.startsWith("REDACTED-")) return fullMatch;
        if (token.startsWith("redacted-")) return fullMatch;
        if (token.includes("-redacted-")) return fullMatch;

        // Skip short hex strings (commit hashes, etc.)
        if (/^[a-f0-9]{32,}$/i.test(token) && token.length < 40) return fullMatch;

        if (looksLikeSecret(token)) {
          count++;
          const replacement = getOrCreateMapping(
            token,
            "password",
            generateSecretReplacement
          );
          return fullMatch.replace(token, replacement);
        }
        return fullMatch;
      });

      // Strategy 3: Environment variable assignments with secret-sounding names
      ENV_VAR_SECRET_RE.lastIndex = 0;
      text = text.replace(ENV_VAR_SECRET_RE, (fullMatch, varName, value) => {
        if (!SECRET_VAR_NAMES_RE.test(varName)) return fullMatch;
        if (/^(true|false|null|undefined|none|\d+|https?:)$/i.test(value)) return fullMatch;
        count++;
        const replacement = getOrCreateMapping(
          value,
          "password",
          generatePasswordReplacement
        );
        return fullMatch.replace(value, replacement);
      });

      return {
        guardrailId: "password",
        action: count > 0 ? "mask" : "allow",
        modifiedText: text,
        detectionCount: count,
      };
    },
  };
}
