/**
 * Name guardrail.
 *
 * 4 detection strategies:
 * 1. Known "FirstName LastName" pairs
 * 2. Context keywords (name:, author:, by:, etc.)
 * 3. Greeting/sign-off patterns (Hello John,)
 * 4. Standalone known first names
 *
 * Replaces with plain fake names (no bracket tokens) so file paths stay valid.
 * Deanonymization uses the reverse-map populated during anonymization.
 */

import type { Guardrail, GuardrailConfig, GuardrailContext, GuardrailResult } from "../types.js";
import { defaultShouldRun, getOrCreateMapping, hmac } from "../shared.js";
import {
  COMMON_FIRST_NAMES,
  COMMON_LAST_NAMES,
  NAME_STOPWORDS,
  FAKE_FIRST_NAMES,
  FAKE_LAST_NAMES,
  FAKE_NAMES_LOWER,
} from "../names-data.js";

function generateNameReplacement(original: string): string {
  const h = hmac(original);
  const firstIdx = parseInt(h.slice(0, 8), 16) % FAKE_FIRST_NAMES.length;
  const lastIdx = parseInt(h.slice(8, 16), 16) % FAKE_LAST_NAMES.length;

  if (original.includes(" ")) {
    return `${FAKE_FIRST_NAMES[firstIdx]} ${FAKE_LAST_NAMES[lastIdx]}`;
  }
  return FAKE_FIRST_NAMES[firstIdx];
}

export function createNameGuardrail(): Guardrail {
  const config: GuardrailConfig = {
    id: "name",
    name: "Person Names",
    description: "Detect names using dictionaries, context keywords, and greeting patterns",
    enabled: true,
    defaultOn: true,
    lifecycles: ["pre_call"],
    priority: 50,
    category: "pii",
    icon: "User",
    color: "text-green-400 bg-green-600/10",
  };

  return {
    id: "name",
    config,

    shouldRun(context: GuardrailContext): boolean {
      return defaultShouldRun(config, context);
    },

    execute(context: GuardrailContext): GuardrailResult {
      let result = context.text;
      let count = 0;

      // Strategy 1: Known "FirstName LastName" pairs
      const nameMatches: Array<{ start: number; end: number; text: string }> = [];
      const pairRe = /\b([a-zA-ZÀ-ÿ]{2,16})\s+([a-zA-ZÀ-ÿ]{2,20})\b/g;
      let pairMatch: RegExpExecArray | null;
      while ((pairMatch = pairRe.exec(result)) !== null) {
        const [fullMatch, first, last] = pairMatch;
        const firstLower = first.toLowerCase();
        const lastLower = last.toLowerCase();

        if (NAME_STOPWORDS.has(firstLower) || NAME_STOPWORDS.has(lastLower)) {
          pairRe.lastIndex = pairMatch.index + first.length;
          continue;
        }

        if (!COMMON_FIRST_NAMES.has(firstLower)) {
          pairRe.lastIndex = pairMatch.index + first.length;
          continue;
        }

        const lastIsKnown =
          COMMON_LAST_NAMES.has(lastLower) || COMMON_FIRST_NAMES.has(lastLower);
        if (!lastIsKnown) {
          pairRe.lastIndex = pairMatch.index + first.length;
          continue;
        }

        nameMatches.push({
          start: pairMatch.index,
          end: pairMatch.index + fullMatch.length,
          text: fullMatch,
        });
      }

      // Replace in reverse order to preserve indices
      for (let i = nameMatches.length - 1; i >= 0; i--) {
        const { start, end, text } = nameMatches[i];
        const replacement = getOrCreateMapping(text, "name", generateNameReplacement);
        result = result.slice(0, start) + replacement + result.slice(end);
        count++;
      }

      // Strategy 2: Context keywords (name:, author:, by:, etc.)
      result = result.replace(
        /(?:name|full[_-]?name|display[_-]?name|first[_-]?name|last[_-]?name|author|by|from|contact|assignee|owner|creator|reviewer|committer|signed[_-]?off[_-]?by|co[_-]?authored[_-]?by|reported[_-]?by|assigned[_-]?to)\s*[:=]\s*["']?([A-Z][a-zÀ-ÿ]+(?:\s+[A-Z][a-zÀ-ÿ]+){0,3})["']?/gi,
        (fullMatch, nameValue) => {
          const trimmed = nameValue.trim();
          if (trimmed.length < 2) return fullMatch;
          if (NAME_STOPWORDS.has(trimmed.toLowerCase())) return fullMatch;
          count++;
          const replacement = getOrCreateMapping(
            trimmed,
            "name",
            generateNameReplacement
          );
          return fullMatch.replace(trimmed, replacement);
        }
      );

      // Strategy 3: Greeting/sign-off patterns
      result = result.replace(
        /(?:(?:hello|hi|hey|dear|thanks|thank you|cheers|regards|sincerely|best|cc|@)\s*,?\s*)([A-Z][a-zÀ-ÿ]{1,15})\b/gi,
        (fullMatch, name) => {
          if (COMMON_FIRST_NAMES.has(name.toLowerCase()) && !NAME_STOPWORDS.has(name.toLowerCase())) {
            count++;
            const replacement = getOrCreateMapping(
              name,
              "name",
              generateNameReplacement
            );
            return fullMatch.replace(name, replacement);
          }
          return fullMatch;
        }
      );

      // Strategy 4: Standalone known first names (including inside paths)
      result = result.replace(
        /\b([a-zA-ZÀ-ÿ]{2,16})\b/g,
        (fullMatch, word) => {
          const lower = word.toLowerCase();
          if (!COMMON_FIRST_NAMES.has(lower)) return fullMatch;
          if (NAME_STOPWORDS.has(lower)) return fullMatch;
          if (FAKE_NAMES_LOWER.has(lower)) return fullMatch;
          count++;
          const replacement = getOrCreateMapping(
            word,
            "name",
            generateNameReplacement
          );
          return replacement;
        }
      );

      return {
        guardrailId: "name",
        action: count > 0 ? "mask" : "allow",
        modifiedText: result,
        detectionCount: count,
      };
    },
  };
}
