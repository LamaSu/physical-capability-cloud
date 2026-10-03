/**
 * agent-introspection scopeSatisfied — narrow keys must report the truth.
 *
 * This endpoint exists so an agent learns what to ask for instead of just
 * failing ("failing a request is not an interface. needs_scope:operator.write
 * is"). It advertises a DOTTED vocabulary (operator.write, jobs.read,
 * settlement.read) while middleware/scope-checker.ts enforces a FLAT one
 * (operator, settlement, admin, ...). The two sets are disjoint.
 *
 * That was invisible while every key carried "*" — the function's own docstring
 * says it was written for exactly that world. PR #309 mints self-service keys
 * as ["operator"], at which point a brand-new key satisfied NOTHING here and
 * this endpoint told every fresh agent it could reach nothing, while the actual
 * requests would have succeeded. These tests pin the bridge between the two
 * vocabularies so that regression cannot come back silently.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  scopeSatisfied,
  operationReachable,
  agentIntrospectionRoutes,
  AGENT_OPERATIONS,
} from "../routes/agent-introspection.js";
import { generateApiKey } from "../auth/api-key-auth.js";
import { initStore, closeStore, getRepos } from "../db.js";

describe("scopeSatisfied — dotted advertisement vs flat enforcement", () => {
  it("still honours the legacy wildcard", () => {
    expect(scopeSatisfied(["*"], "operator.write")).toBe(true);
    expect(scopeSatisfied(["*"], "settlement.read")).toBe(true);
  });

  it("treats a null requirement as always satisfied", () => {
    expect(scopeSatisfied([], null)).toBe(true);
  });

  // The regression PR #309 would otherwise have shipped.
  it("a flat `operator` key satisfies the operator family", () => {
    expect(scopeSatisfied(["operator"], "operator.read")).toBe(true);
    expect(scopeSatisfied(["operator"], "operator.write")).toBe(true);
  });

  it("a flat `settlement` key satisfies the settlement family", () => {
    expect(scopeSatisfied(["operator", "settlement"], "settlement.read")).toBe(true);
  });

  it("`admin` satisfies everything, as it does in the scope-checker", () => {
    expect(scopeSatisfied(["admin"], "operator.write")).toBe(true);
    expect(scopeSatisfied(["admin"], "settlement.read")).toBe(true);
    expect(scopeSatisfied(["admin"], "jobs.write")).toBe(true);
  });

  it("still honours an explicit dotted grant and a family wildcard", () => {
    expect(scopeSatisfied(["operator.read"], "operator.read")).toBe(true);
    expect(scopeSatisfied(["operator.*"], "operator.write")).toBe(true);
  });

  // The load-bearing negatives: bridging the vocabularies must not make this
  // endpoint claim reachability it does not have.
  it("does NOT let one family satisfy another", () => {
    expect(scopeSatisfied(["operator"], "settlement.read")).toBe(false);
    expect(scopeSatisfied(["operator"], "jobs.write")).toBe(false);
    expect(scopeSatisfied(["settlement"], "operator.write")).toBe(false);
  });

  it("reports nothing reachable for a key with no scopes", () => {
    expect(scopeSatisfied([], "operator.read")).toBe(false);
    expect(scopeSatisfied([], "settlement.read")).toBe(false);
  });

  it("does not treat a partial family-name match as a hit", () => {
    expect(scopeSatisfied(["oper"], "operator.read")).toBe(false);
    expect(scopeSatisfied(["operatorx"], "operator.read")).toBe(false);
  });
});

// ── WP-A A1: the endpoint must report what the scope-checker ENFORCES ──
//
// A legacy "*" is no longer money or admin authority in
// middleware/scope-checker.ts. If this endpoint kept telling a wildcard key it
// could reach a money write or an admin route, it would be lying in exactly the
// way it exists to prevent.
describe("operationReachable — mirrors the enforced money/admin rules", () => {
  const moneyWrite = { method: "POST" as const, path: "/api/escrow/{unitId}/release", scope: "settlement.write" };
  const moneyDelete = { method: "DELETE" as const, path: "/api/escrow/{unitId}", scope: "settlement.write" };
  const adminRead = { method: "GET" as const, path: "/api/admin/keys/wildcard-audit", scope: null };
  const moneyRead = { method: "GET" as const, path: "/api/escrow/{unitId}", scope: null };
  const setup = { method: "POST" as const, path: "/api/fiat-ramp/cdp/wallet", scope: "operator.write" };

  it("a legacy wildcard does NOT reach a money write, and is told to ask for settlement", () => {
    expect(operationReachable(["*"], moneyWrite)).toEqual({ reachable: false, needs: "settlement" });
  });

  it("a legacy wildcard does NOT reach the admin namespace", () => {
    expect(operationReachable(["*"], adminRead)).toEqual({ reachable: false, needs: "admin" });
  });

  it("a money DELETE needs explicit admin — settlement is not enough", () => {
    expect(operationReachable(["settlement"], moneyDelete)).toEqual({ reachable: false, needs: "admin" });
    expect(operationReachable(["admin"], moneyDelete)).toEqual({ reachable: true });
  });

  it("explicit settlement / admin reach what they should", () => {
    expect(operationReachable(["settlement"], moneyWrite)).toEqual({ reachable: true });
    expect(operationReachable(["admin"], moneyWrite)).toEqual({ reachable: true });
    expect(operationReachable(["admin"], adminRead)).toEqual({ reachable: true });
    expect(operationReachable(["*", "settlement"], moneyWrite)).toEqual({ reachable: true });
  });

  // WP-A repair R3. Old assertion: "*" reaches EVERY advertised operation
  // ("none of today's advertised operations is a money write or admin route").
  // New: every one EXCEPT the /api/operator/** writes (operator.emergencyStop),
  // which answer needs_scope:operator. Why: the scope-checker now refuses "*"
  // on operator-control writes, and this endpoint must report what is enforced.
  it("the wildcard still reaches money READS, setup, and every non-operator-control operation", () => {
    expect(operationReachable(["*"], moneyRead)).toEqual({ reachable: true });
    expect(operationReachable(["*"], setup)).toEqual({ reachable: true });
    for (const op of AGENT_OPERATIONS) {
      const isOperatorWrite = op.method !== "GET" && op.path.startsWith("/api/operator/");
      expect(operationReachable(["*"], op), op.id).toEqual(
        isOperatorWrite ? { reachable: false, needs: "operator" } : { reachable: true },
      );
    }
  });
});

describe("operationReachable — mirrors the enforced /api/operator/** write floor (R3)", () => {
  const eStop = AGENT_OPERATIONS.find((op) => op.id === "operator.emergencyStop")!;
  const machines = AGENT_OPERATIONS.find((op) => op.id === "operator.machines")!;

  it("a legacy wildcard does NOT reach the emergency stop, and is told to ask for operator", () => {
    expect(eStop).toBeDefined();
    expect(operationReachable(["*"], eStop)).toEqual({ reachable: false, needs: "operator" });
  });

  it("only the FLAT scopes the floor enforces count (a dotted operator.write does not)", () => {
    expect(operationReachable(["operator.write"], eStop)).toEqual({ reachable: false, needs: "operator" });
    expect(operationReachable(["contributor:write"], eStop)).toEqual({ reachable: false, needs: "operator" });
  });

  it("explicit operator / admin reach it, with or without a wildcard alongside", () => {
    expect(operationReachable(["operator"], eStop)).toEqual({ reachable: true });
    expect(operationReachable(["admin"], eStop)).toEqual({ reachable: true });
    expect(operationReachable(["*", "operator"], eStop)).toEqual({ reachable: true });
  });

  it("operator READS are unaffected: the wildcard still reaches them", () => {
    expect(operationReachable(["*"], machines)).toEqual({ reachable: true });
  });
});

describe("GET /api/agent/capabilities — the wildcard note is truthful", () => {
  let app: FastifyInstance;
  let wildcardKey: string;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    // A LEGACY row: keys can no longer be minted with "*".
    const { rawKey, keyHash, keyPrefix } = generateApiKey();
    getRepos().apiKeys.insert({
      id: "legacy-wildcard-introspection",
      keyHash,
      keyPrefix,
      operatorId: "legacy@example.com",
      name: "legacy",
      description: null,
      scopes: JSON.stringify(["*"]),
      rateLimit: "1000/hour",
      usageCount: "0",
      createdAt: new Date().toISOString(),
      expiresAt: null,
      metadata: null,
      publicKey: null,
    } as never);
    wildcardKey = rawKey;
    app = Fastify({ logger: false });
    await app.register(agentIntrospectionRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  it("does not claim a wildcard key can reach every operation", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/agent/capabilities",
      headers: { authorization: `Bearer ${wildcardKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { caller: { wildcard: boolean; wildcard_note?: string } };
    expect(body.caller.wildcard).toBe(true);
    expect(body.caller.wildcard_note).toBeDefined();
    expect(body.caller.wildcard_note).not.toMatch(/every operation/i);
    expect(body.caller.wildcard_note).not.toMatch(/not yet enforced/i);
    expect(body.caller.wildcard_note).toMatch(/NOT money or admin authority/);
    // R3: the note must also say the wildcard is not operator control.
    expect(body.caller.wildcard_note).toMatch(/NOT operator-control authority/);
  });

  // R6 parity: scopes are read with the scope-checker's own parser. The old
  // local parse stringified a mixed array ([42,"operator"] -> ["42","operator"])
  // and reported the emergency stop reachable, while the enforced layer grants
  // such a malformed key nothing and refuses it.
  it("a key whose scopes column is a MIXED array is reported as holding nothing", async () => {
    const { rawKey, keyHash, keyPrefix } = generateApiKey();
    getRepos().apiKeys.insert({
      id: "mixed-array-introspection",
      keyHash,
      keyPrefix,
      operatorId: "mixed@example.com",
      name: "mixed",
      description: null,
      scopes: JSON.stringify([42, "operator"]),
      rateLimit: "1000/hour",
      usageCount: "0",
      createdAt: new Date().toISOString(),
      expiresAt: null,
      metadata: null,
      publicKey: null,
    } as never);
    const res = await app.inject({
      method: "GET",
      url: "/api/agent/capabilities",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    const body = res.json() as { caller: { scopes: string[] }; tools: Array<{ id: string; reachability: string }> };
    expect(body.caller.scopes).toEqual([]);
    expect(body.tools.find((t) => t.id === "operator.emergencyStop")?.reachability).toBe("needs_scope:operator");
  });

  it("reports the emergency stop as needs_scope:operator for a wildcard key (R3)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/agent/capabilities",
      headers: { authorization: `Bearer ${wildcardKey}` },
    });
    const tools = (res.json() as { tools: Array<{ id: string; reachability: string }> }).tools;
    expect(tools.find((t) => t.id === "operator.emergencyStop")?.reachability).toBe("needs_scope:operator");
    expect(tools.find((t) => t.id === "operator.machines")?.reachability).toBe("reachable");
  });
});
