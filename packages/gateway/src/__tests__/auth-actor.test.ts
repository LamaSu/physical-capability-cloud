import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";

import { authenticatedActor, sameIdentity } from "../auth/actor.js";

const req = (fields: Record<string, unknown>) => fields as unknown as FastifyRequest;

describe("authenticatedActor", () => {
  it("takes the API key's operatorId, then the SIWE userId", () => {
    expect(authenticatedActor(req({ operatorId: "op-1", userId: "0xabc" }))).toBe("op-1");
    expect(authenticatedActor(req({ userId: "0xabc" }))).toBe("0xabc");
  });

  it("is null when authentication established no principal, or only a blank one", () => {
    expect(authenticatedActor(req({}))).toBeNull();
    expect(authenticatedActor(req({ operatorId: "   ", userId: "" }))).toBeNull();
    expect(authenticatedActor(req({ operatorId: 42 }))).toBeNull();
  });
});

describe("sameIdentity (WP-A semantics)", () => {
  it("matches trimmed, case-insensitive ids", () => {
    expect(sameIdentity(" Alice@Example.com ", "alice@example.com")).toBe(true);
    expect(sameIdentity("0xABCdef", "0xabcDEF")).toBe(true);
  });

  it("never matches ids that fold to empty, including whitespace-only ones", () => {
    expect(sameIdentity("", "")).toBe(false);
    expect(sameIdentity("   ", " ")).toBe(false);
    expect(sameIdentity("  ", "")).toBe(false);
    expect(sameIdentity(null, null)).toBe(false);
    expect(sameIdentity(undefined, "")).toBe(false);
  });

  it("does not match different ids", () => {
    expect(sameIdentity("alice", "alice2")).toBe(false);
    expect(sameIdentity("alice", null)).toBe(false);
  });
});
