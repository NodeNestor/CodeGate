/**
 * Register all built-in guardrails.
 *
 * Called once during initialization to populate the registry.
 */

import { registerGuardrail } from "../registry.js";
import { createPatternGuardrail } from "./pattern-guardrail.js";
import { ALL_PATTERN_DEFS } from "../patterns.js";
import { createApiKeyGuardrail } from "./api-key.js";
import { createPasswordGuardrail } from "./password.js";
import { createNameGuardrail } from "./name.js";

export function registerBuiltinGuardrails(): void {
  // 12 pattern-based guardrails
  for (const def of ALL_PATTERN_DEFS) {
    registerGuardrail(def.id, () => createPatternGuardrail(def));
  }

  // 3 complex guardrails with custom detection logic
  registerGuardrail("api_key", createApiKeyGuardrail);
  registerGuardrail("password", createPasswordGuardrail);
  registerGuardrail("name", createNameGuardrail);
}
