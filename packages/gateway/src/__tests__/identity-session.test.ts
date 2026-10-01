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
});
