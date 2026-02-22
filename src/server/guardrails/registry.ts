/**
 * Guardrail registry.
 *
 * Stores guardrail factories, lazily instantiates them,
 * and provides lookup by ID or sorted list.
 */

import type { Guardrail, GuardrailConfig } from "./types.js";

type GuardrailFactory = () => Guardrail;

const factories = new Map<string, GuardrailFactory>();
const instances = new Map<string, Guardrail>();

/**
 * Register a guardrail factory. The guardrail is not instantiated until first use.
 */
export function registerGuardrail(id: string, factory: GuardrailFactory): void {
  factories.set(id, factory);
  // Clear cached instance if re-registering
  instances.delete(id);
}

/**
 * Get a guardrail by ID (lazy instantiation).
 */
export function getGuardrail(id: string): Guardrail | undefined {
  let instance = instances.get(id);
  if (instance) return instance;

  const factory = factories.get(id);
  if (!factory) return undefined;

  instance = factory();
  instances.set(id, instance);
  return instance;
}

/**
 * Get all guardrails sorted by priority (lower = higher priority = runs first).
 */
export function getAllGuardrails(): Guardrail[] {
  // Ensure all factories are instantiated
  for (const [id, factory] of factories) {
    if (!instances.has(id)) {
      instances.set(id, factory());
    }
  }

  return [...instances.values()].sort(
    (a, b) => a.config.priority - b.config.priority
  );
}

/**
 * Get all guardrail configs (for the API/UI).
 */
export function getAllConfigs(): GuardrailConfig[] {
  return getAllGuardrails().map((g) => g.config);
}

/**
 * Check if a guardrail ID is registered.
 */
export function hasGuardrail(id: string): boolean {
  return factories.has(id);
}

/**
 * Update a guardrail's enabled state.
 */
export function setGuardrailEnabled(id: string, enabled: boolean): boolean {
  const guardrail = getGuardrail(id);
  if (!guardrail) return false;
  // GuardrailConfig is mutable on the instance
  (guardrail.config as { enabled: boolean }).enabled = enabled;
  return true;
}
