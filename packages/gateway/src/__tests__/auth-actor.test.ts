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

describe("sameIdentity (ASCII case fold only)", () => {
  it("matches ASCII case-insensitively", () => {
    expect(sameIdentity("Alice@Example.com", "alice@example.com")).toBe(true);
    expect(sameIdentity("0xABCdef", "0xabcDEF")).toBe(true);
    // A non-ASCII id still matches itself, exactly.
    expect(sameIdentity("jos\u00e9@example.com", "jos\u00e9@example.com")).toBe(true);
  });

  it("never Unicode-folds or trims: a lookalike or padded id is a different principal (kits #395; cf. #461 HIGH 2)", () => {
    // U+212A KELVIN SIGN lower-cases to ASCII "k" under String#toLowerCase.
    expect(sameIdentity("\u212Aate@example.com", "kate@example.com")).toBe(false);
    expect(sameIdentity("\u212A", "k")).toBe(false);
    // U+0130 lower-cases to "i" + U+0307.
    expect(sameIdentity("\u0130", "i\u0307")).toBe(false);
    for (const pad of [" ", "\u00A0", "\uFEFF", "\u3000", "\t"]) {
      expect(sameIdentity(`${pad}alice@example.com`, "alice@example.com"), JSON.stringify(pad)).toBe(false);
      expect(sameIdentity("alice@example.com", `alice@example.com${pad}`), JSON.stringify(pad)).toBe(false);
    }
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
