import { describe, it, expect, beforeEach } from "vitest";
import {
  checkAndRecordRequest,
  getRequestCount,
  clearRateLimit,
} from "../rate-limiter.js";

beforeEach(() => {
  clearRateLimit("test-account");
});

describe("checkAndRecordRequest (atomic rate limiter)", () => {
  it("allows requests under the limit", () => {
    expect(checkAndRecordRequest("test-account", 5)).toBe(false);
    expect(checkAndRecordRequest("test-account", 5)).toBe(false);
    expect(getRequestCount("test-account")).toBe(2);
  });

  it("blocks requests at the limit", () => {
    for (let i = 0; i < 3; i++) {
      checkAndRecordRequest("test-account", 3);
    }
    expect(checkAndRecordRequest("test-account", 3)).toBe(true);
  });

  it("returns false (not limited) when rateLimit is 0", () => {
    expect(checkAndRecordRequest("test-account", 0)).toBe(false);
  });

  it("isolates accounts from each other", () => {
    for (let i = 0; i < 5; i++) {
      checkAndRecordRequest("account-a", 10);
    }
    expect(getRequestCount("account-a")).toBe(5);
    expect(getRequestCount("account-b")).toBe(0);
    clearRateLimit("account-a");
  });

  it("clears rate limit state", () => {
    checkAndRecordRequest("test-account", 10);
    checkAndRecordRequest("test-account", 10);
    clearRateLimit("test-account");
    expect(getRequestCount("test-account")).toBe(0);
  });
});
