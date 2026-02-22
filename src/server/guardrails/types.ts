/**
 * Core types for the guardrails system.
 *
 * Inspired by LiteLLM's CustomGuardrail pattern: lifecycle hooks,
 * a registry, per-guardrail gating, and individual guardrail modules.
 */

export type GuardrailLifecycle = "pre_call" | "post_call";
export type GuardrailAction = "allow" | "mask" | "block";

export interface GuardrailResult {
  guardrailId: string;
  action: GuardrailAction;
  modifiedText?: string;
  detectionCount: number;
  message?: string;
}

export interface GuardrailContext {
  text: string;
  lifecycle: GuardrailLifecycle;
  model?: string;
  path?: string;
  requestedGuardrails?: string[];
}

export interface GuardrailConfig {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  defaultOn: boolean;
  lifecycles: GuardrailLifecycle[];
  priority: number;
  category: "pii" | "credentials" | "network" | "financial";
  icon?: string;
  color?: string;
}

export interface Guardrail {
  readonly id: string;
  readonly config: GuardrailConfig;
  shouldRun(context: GuardrailContext): boolean;
  execute(context: GuardrailContext): GuardrailResult;
}

/**
 * Pattern definition for regex-based guardrails.
 * Each definition creates a guardrail via createPatternGuardrail().
 */
export interface PatternDef {
  id: string;
  name: string;
  description: string;
  category: "pii" | "credentials" | "network" | "financial";
  icon: string;
  color: string;
  priority: number;
  patterns: RegExp[];
  replacementGenerator: (original: string) => string;
  contextPattern?: RegExp;
  validator?: (match: string) => boolean;
}
