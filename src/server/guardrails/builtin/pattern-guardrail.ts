/**
 * Generic pattern guardrail factory.
 *
 * Creates a Guardrail from a PatternDef by applying regex patterns
 * and using the provided replacement generator.
 */

import type { Guardrail, GuardrailConfig, GuardrailContext, GuardrailResult, PatternDef } from "../types.js";
import { defaultShouldRun, replacePatternMatches, getOrCreateMapping } from "../shared.js";

export function createPatternGuardrail(def: PatternDef): Guardrail {
  const config: GuardrailConfig = {
    id: def.id,
    name: def.name,
    description: def.description,
    enabled: true,
    defaultOn: true,
    lifecycles: ["pre_call"],
    priority: def.priority,
    category: def.category,
    icon: def.icon,
    color: def.color,
  };

  return {
    id: def.id,
    config,

    shouldRun(context: GuardrailContext): boolean {
      // If contextPattern is set, only run when context is present
      if (def.contextPattern) {
        def.contextPattern.lastIndex = 0;
        if (!def.contextPattern.test(context.text)) return false;
      }
      return defaultShouldRun(config, context);
    },

    execute(context: GuardrailContext): GuardrailResult {
      let text = context.text;
      let count = 0;

      for (const pattern of def.patterns) {
        // Reset lastIndex for global regex
        pattern.lastIndex = 0;

        // Count matches first
        const matches = text.match(pattern);
        if (!matches) continue;

        // Filter with validator if present
        const validMatches = def.validator
          ? matches.filter((m) => def.validator!(m))
          : matches;

        if (validMatches.length === 0) continue;

        // Replace matches
        pattern.lastIndex = 0;
        text = text.replace(pattern, (match) => {
          if (def.validator && !def.validator(match)) return match;
          count++;
          return getOrCreateMapping(match, def.id, def.replacementGenerator);
        });
      }

      return {
        guardrailId: def.id,
        action: count > 0 ? "mask" : "allow",
        modifiedText: text,
        detectionCount: count,
      };
    },
  };
}
