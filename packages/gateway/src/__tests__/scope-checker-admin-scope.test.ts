/**
 * hasAdminScope: the TMP task route's admin exception (the steward's ruling on #6182). Only an API key
 * listing the literal "admin" scope is an admin. The wildcard is not: self-service sign-up
 * (routes/provision.ts) mints every key with ["*"] from an unverified email or wallet address.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";

let keyScopes: string;

vi.mock("../db.js", () => ({
  getRepos: () => ({
    governance: { findAllEndpointScopes: () => [] },
    apiKeys: { findById: () => ({ id: "key-1", scopes: keyScopes }) },
  }),
}));

const { hasAdminScope } = await import("../middleware/scope-checker.js");

const keyCaller = { apiKeyId: "key-1" } as unknown as FastifyRequest;

describe("hasAdminScope", () => {
  beforeEach(() => {
    keyScopes = JSON.stringify([]);
  });

  it("is true for a key listing the literal admin scope", () => {
    keyScopes = JSON.stringify(["admin"]);
    expect(hasAdminScope(keyCaller)).toBe(true);
    keyScopes = JSON.stringify(["operator", "admin"]);
    expect(hasAdminScope(keyCaller)).toBe(true);
  });

  it("the wildcard is NOT admin: self-service sign-up mints every key with it", () => {
    keyScopes = JSON.stringify(["*"]);
    expect(hasAdminScope(keyCaller)).toBe(false);
  });

  it("is false for other scopes, a malformed scope set, and a caller without an API key", () => {
    keyScopes = JSON.stringify(["operator", "verifier", "administrator", "Admin"]);
    expect(hasAdminScope(keyCaller)).toBe(false);
    keyScopes = "{}";
    expect(hasAdminScope(keyCaller)).toBe(false);
    keyScopes = JSON.stringify(["admin"]);
    expect(hasAdminScope({} as FastifyRequest)).toBe(false);
  });
});
