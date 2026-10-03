/**
 * auth/admin-key.ts — the shared admin-secret check (WP-A A8).
 */

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyRequest } from "fastify";
import { adminKeyMatches, checkAdminKey } from "../auth/admin-key.js";

const req = (headers: Record<string, unknown>) =>
  ({ headers } as unknown as FastifyRequest);

describe("adminKeyMatches", () => {
  it("matches only the identical secret", () => {
    expect(adminKeyMatches("s3cret-value", "s3cret-value")).toBe(true);
    expect(adminKeyMatches("s3cret-valuf", "s3cret-value")).toBe(false);
    expect(adminKeyMatches("S3CRET-VALUE", "s3cret-value")).toBe(false);
  });

  it("handles different lengths without throwing (timingSafeEqual needs equal lengths)", () => {
    expect(adminKeyMatches("short", "a-much-longer-secret-value")).toBe(false);
    expect(adminKeyMatches("", "x")).toBe(false);
    expect(adminKeyMatches("x".repeat(10_000), "x")).toBe(false);
  });
});

describe("checkAdminKey", () => {
  const savedKey = process.env.PCC_ADMIN_KEY;
  const savedEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (savedKey === undefined) delete process.env.PCC_ADMIN_KEY;
    else process.env.PCC_ADMIN_KEY = savedKey;
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
  });

  it("accepts the configured key", () => {
    process.env.PCC_ADMIN_KEY = "k-123";
    expect(checkAdminKey(req({ "x-admin-key": "k-123" }))).toEqual({ ok: true, mode: "key" });
  });

  it("refuses a missing (401), repeated (401) and wrong (403) header", () => {
    process.env.PCC_ADMIN_KEY = "k-123";
    expect(checkAdminKey(req({}))).toMatchObject({ ok: false, status: 401 });
    expect(checkAdminKey(req({ "x-admin-key": ["k-123", "k-123"] }))).toMatchObject({ ok: false, status: 401 });
    expect(checkAdminKey(req({ "x-admin-key": "k-124" }))).toMatchObject({ ok: false, status: 403 });
  });

  it("fails closed (503) when unset, unless NODE_ENV is exactly test/development", () => {
    delete process.env.PCC_ADMIN_KEY;
    process.env.NODE_ENV = "production";
    expect(checkAdminKey(req({ "x-admin-key": "x" }))).toMatchObject({ ok: false, status: 503 });
    process.env.NODE_ENV = "development";
    expect(checkAdminKey(req({}))).toEqual({ ok: true, mode: "dev-open" });
    process.env.NODE_ENV = "test";
    expect(checkAdminKey(req({}))).toEqual({ ok: true, mode: "dev-open" });
  });

  it("never echoes the secret in a refusal", () => {
    process.env.PCC_ADMIN_KEY = "super-secret-admin-key";
    const r = checkAdminKey(req({ "x-admin-key": "wrong" }));
    expect(JSON.stringify(r)).not.toContain("super-secret-admin-key");
  });
});
