import { describe, it, expect } from "vitest";
import { detectTier, getDefaultModel } from "../model-mapper.js";

describe("detectTier", () => {
  it("detects opus tier", () => {
    expect(detectTier("claude-opus-4-20250514")).toBe("opus");
    expect(detectTier("claude-opus-4-6-20250219")).toBe("opus");
  });

  it("detects sonnet tier", () => {
    expect(detectTier("claude-sonnet-4-20250514")).toBe("sonnet");
    expect(detectTier("claude-sonnet-4-6-20250219")).toBe("sonnet");
  });

  it("detects haiku tier", () => {
    expect(detectTier("claude-haiku-4-5-20251001")).toBe("haiku");
  });

  it("returns null for non-Claude models", () => {
    expect(detectTier("gpt-4o")).toBeNull();
    expect(detectTier("deepseek-r1")).toBeNull();
    expect(detectTier("o3")).toBeNull();
  });

  it("is case insensitive", () => {
    expect(detectTier("Claude-OPUS-4")).toBe("opus");
  });
});

describe("getDefaultModel", () => {
  it("returns defaults for each tier", () => {
    expect(getDefaultModel("opus")).toContain("opus");
    expect(getDefaultModel("sonnet")).toContain("sonnet");
    expect(getDefaultModel("haiku")).toContain("haiku");
  });
});
