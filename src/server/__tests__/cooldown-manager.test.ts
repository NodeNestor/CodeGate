import { describe, it, expect, beforeEach } from "vitest";
import {
  setCooldown,
  isOnCooldown,
  clearCooldown,
  sortByCooldown,
  parseRetryAfter,
} from "../cooldown-manager.js";

beforeEach(() => {
  clearCooldown("test-1");
  clearCooldown("test-2");
  clearCooldown("test-3");
});

describe("setCooldown / isOnCooldown", () => {
  it("sets and detects cooldown", () => {
    setCooldown("test-1", "rate_limit");
    expect(isOnCooldown("test-1")).toBe(true);
  });

  it("returns false for non-cooled accounts", () => {
    expect(isOnCooldown("test-1")).toBe(false);
  });

  it("clears cooldown", () => {
    setCooldown("test-1", "error");
    clearCooldown("test-1");
    expect(isOnCooldown("test-1")).toBe(false);
  });

  it("respects retry-after seconds", () => {
    setCooldown("test-1", "rate_limit", 120);
    expect(isOnCooldown("test-1")).toBe(true);
  });
});

describe("sortByCooldown", () => {
  it("puts non-cooled accounts first", () => {
    setCooldown("test-2", "error");
    const candidates = [
      { account: { id: "test-2" }, name: "B" },
      { account: { id: "test-1" }, name: "A" },
    ];

    const sorted = sortByCooldown(candidates);
    expect(sorted[0].name).toBe("A");
    expect(sorted[1].name).toBe("B");
  });

  it("preserves order when none are cooled", () => {
    const candidates = [
      { account: { id: "test-1" }, name: "first" },
      { account: { id: "test-2" }, name: "second" },
    ];
    const sorted = sortByCooldown(candidates);
    expect(sorted[0].name).toBe("first");
  });
});

describe("parseRetryAfter", () => {
  it("parses numeric seconds", () => {
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter("120")).toBe(120);
  });

  it("returns undefined for null/undefined", () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
  });

  it("returns default for unparseable values", () => {
    expect(parseRetryAfter("garbage")).toBe(60);
  });
});
