import { describe, it, expect, beforeEach } from "vitest";
import {
  checkAndRecordRequest,
  clearRateLimit,
  getRequestCount,
} from "../rate-limiter.js";
import { resolveRoute, resolveRouteForConfig } from "../config-manager.js";

// ─── Tenant-scoped rate limiting ────────────────────────────────────────────

describe("tenant-scoped rate limiting", () => {
  const tenantKey = "tenant:test-tenant-id";
  const accountKey = "account-123";

  beforeEach(() => {
    clearRateLimit(tenantKey);
    clearRateLimit(accountKey);
  });

  it("rate limits tenant independently from accounts", () => {
    // Tenant limit of 2
    expect(checkAndRecordRequest(tenantKey, 2)).toBe(false);
    expect(checkAndRecordRequest(tenantKey, 2)).toBe(false);
    expect(checkAndRecordRequest(tenantKey, 2)).toBe(true); // blocked

    // Account should still be fine
    expect(checkAndRecordRequest(accountKey, 10)).toBe(false);
  });

  it("tenant rate limit of 0 means unlimited", () => {
    expect(checkAndRecordRequest(tenantKey, 0)).toBe(false);
    expect(checkAndRecordRequest(tenantKey, 0)).toBe(false);
    expect(checkAndRecordRequest(tenantKey, 0)).toBe(false);
  });

  it("different tenants are independent", () => {
    const tenant1 = "tenant:t1";
    const tenant2 = "tenant:t2";

    for (let i = 0; i < 5; i++) {
      checkAndRecordRequest(tenant1, 10);
    }
    expect(getRequestCount(tenant1)).toBe(5);
    expect(getRequestCount(tenant2)).toBe(0);

    clearRateLimit(tenant1);
    clearRateLimit(tenant2);
  });
});

// ─── resolveRouteForConfig (exported function shape) ───────────────────────

describe("resolveRouteForConfig", () => {
  it("is exported and callable", () => {
    expect(typeof resolveRouteForConfig).toBe("function");
  });

  it("has the correct function signature (model, configId)", () => {
    // Verify the function accepts 2 args (model + configId)
    expect(resolveRouteForConfig.length).toBe(2);
  });
});
