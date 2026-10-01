/**
 * POST /api/identity/session — the scope it returns is canonical.
 *
 * #361 commits sessionKeyAuthDigest = sha256(canonicalize(SessionKeyAuthorization))
 * over the scope this route returns. If the route hands back the caller's arrays
 * verbatim, one authorization has several digests ([a,b], [b,a], [a,a,b]).
 * The scope must come back sorted (UTF-16 code-unit order) and de-duplicated,
 * and it must be the SAME scope the parent signed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import nacl from "tweetnacl";
import { identitySessionRoutes } from "../routes/identity-session.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(identitySessionRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * The route derives a mock principal from the id (no wallet yet): seed = the
 * first 32 characters of principalAgentId, NUL padded. Mirror it to get the
 * parent public key that /verify needs.
 */
function parentPublicKeyFor(principalAgentId: string): Uint8Array {
  const seed = new TextEncoder().encode(principalAgentId.padEnd(32, "\0").slice(0, 32));
  return nacl.sign.keyPair.fromSeed(seed).publicKey;
}

async function issue(payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/identity/session", payload });
}

describe("POST /api/identity/session", () => {
  it("returns a sorted, de-duplicated scope for an unsorted, duplicated request", async () => {
    const res = await issue({
      principalAgentId: "agent-skey-route-1",
      scope: {
        allowedActions: ["workflow_step_complete", "evidence_submit", "evidence_submit"],
        contractIds: ["c2", "c1", "c2"],
      },
      ttlSeconds: 300,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().sessionKey.scope).toEqual({
      allowedActions: ["evidence_submit", "workflow_step_complete"],
      contractIds: ["c1", "c2"],
      maxSignatures: 1000,
    });
  });

  it("returns the same scope for requests that differ only in order or duplicates", async () => {
    const spellings = [
      { allowedActions: ["evidence_submit", "workflow_step_complete"], contractIds: ["c1", "c2"] },
      { allowedActions: ["workflow_step_complete", "evidence_submit"], contractIds: ["c2", "c1"] },
      {
        allowedActions: ["evidence_submit", "evidence_submit", "workflow_step_complete"],
        contractIds: ["c1", "c1", "c2", "c1"],
      },
    ];

    const scopes = [];
    for (const scope of spellings) {
      const res = await issue({ principalAgentId: "agent-skey-route-2", scope });
      expect(res.statusCode).toBe(200);
      scopes.push(res.json().sessionKey.scope);
    }

    expect(scopes[1]).toEqual(scopes[0]);
    expect(scopes[2]).toEqual(scopes[0]);
  });

  it("orders contract ids by UTF-16 code unit, not by locale", async () => {
    const res = await issue({
      principalAgentId: "agent-skey-route-3",
      scope: { contractIds: ["a", "B"] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().sessionKey.scope.contractIds).toEqual(["B", "a"]);
  });

  it("the returned key verifies through /verify with the scope exactly as returned", async () => {
    const principalAgentId = "agent-skey-route-4";
    const res = await issue({
      principalAgentId,
      scope: {
        allowedActions: ["workflow_step_complete", "evidence_submit", "evidence_submit"],
        contractIds: ["c2", "c1", "c2"],
      },
    });
    expect(res.statusCode).toBe(200);
    const issued = res.json();

    const eventData = new TextEncoder().encode("route-round-trip");
    const sessionSignature = nacl.sign.detached(
      eventData,
      Uint8Array.from(Buffer.from(issued.sessionPrivateKey, "hex")),
    );

    const verified = await app.inject({
      method: "POST",
      url: "/api/identity/session/verify",
      payload: {
        event: {
          eventData: hex(eventData),
          sessionSignature: hex(sessionSignature),
          proof: {
            sessionKey: issued.sessionKey,
            parentPublicKey: hex(parentPublicKeyFor(principalAgentId)),
          },
        },
        action: "evidence_submit",
      },
    });

    expect(verified.statusCode).toBe(200);
    expect(verified.json().failures).toEqual([]);
    expect(verified.json().valid).toBe(true);
  });

  describe("a malformed scope is a 400 and issues nothing", () => {
    // Each row is a request body the route's own types claim cannot happen.
    const malformed: Array<[label: string, scope: unknown, message: string]> = [
      [
        "a number in allowedActions",
        { allowedActions: ["evidence_submit", 5] },
        "scope.allowedActions[1] must be a string",
      ],
      [
        "null in contractIds",
        { contractIds: ["c1", null] },
        "scope.contractIds[1] must be a string",
      ],
      [
        "an object in contractIds",
        { contractIds: [{ id: "c1" }] },
        "scope.contractIds[0] must be a string",
      ],
      [
        "a bare string where allowedActions belongs",
        { allowedActions: "evidence_submit" },
        "scope.allowedActions must be an array of strings",
      ],
      [
        "a plain object where contractIds belongs",
        { contractIds: { 0: "c1" } },
        "scope.contractIds must be an array of strings",
      ],
    ];

    it.each(malformed)("rejects %s", async (_label, scope, message) => {
      const res = await issue({ principalAgentId: "agent-skey-route-5", scope });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_scope", message });
      // Nothing was issued: no key material in the body.
      expect(res.body).not.toContain("sessionPrivateKey");
    });
  });

  describe("absent and empty lists keep their meaning", () => {
    const DEFAULT_ACTIONS = ["evidence_submit", "workflow_step_complete"];

    it("issues the defaults when there is no scope at all", async () => {
      const res = await issue({ principalAgentId: "agent-skey-route-6" });

      expect(res.statusCode).toBe(200);
      expect(res.json().sessionKey.scope.allowedActions).toEqual(DEFAULT_ACTIONS);
      expect(res.json().sessionKey.scope.contractIds).toEqual([]);
    });

    it.each([
      ["an empty scope object", {}],
      ["null lists", { allowedActions: null, contractIds: null }],
    ])("falls back to the defaults for %s", async (_label, scope) => {
      const res = await issue({ principalAgentId: "agent-skey-route-7", scope });

      expect(res.statusCode).toBe(200);
      expect(res.json().sessionKey.scope).toEqual({
        allowedActions: DEFAULT_ACTIONS,
        contractIds: [],
        maxSignatures: 1000,
      });
    });

    it("returns explicitly empty lists as empty, not as defaults", async () => {
      const res = await issue({
        principalAgentId: "agent-skey-route-8",
        scope: { allowedActions: [], contractIds: [] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().sessionKey.scope.allowedActions).toEqual([]);
      expect(res.json().sessionKey.scope.contractIds).toEqual([]);
    });
  });
});
