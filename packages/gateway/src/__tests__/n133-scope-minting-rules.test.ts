/**
 * Board N133 (the steward's DECISIONS 01:01, #6733): the four rules that close the self-mint door,
 * one by one. n133-scope-minting.test.ts is the repro; this file pins each rule's edges.
 *   1. The buyer is the caller's proven identity, or the admin acts for it (fast-track, the
 *      negotiation session and its commit, A2A pcc-quote/pcc-submit).
 *   2. A paid write scope goes live only on the kernel operator's acceptance, per its policy, or
 *      the operator's own decision on the scope (POST /api/operator/scopes/:scopeId/accept).
 *   3. Only on the buyer's own, real funding: never a mock escrow outside tests, never a
 *      gateway-funded one.
 *   4. Mock settlement is on only when MOCK_SETTLEMENT is exactly "true".
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { paidJobFlowRoutes, createJobFromSession, mintedScopeStatus } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { deviceRelayRoutes } from "../routes/device-relay.js";
import { operatorRoutes } from "../routes/operator.js";
import { a2aTasksRoutes, __resetA2ATasksForTest } from "../routes/a2a-tasks.js";
import { initStore, closeStore, getStore, getRepos } from "../db.js";
import { schema, eq, sql } from "@pcc/store";
import { actAsJobParty } from "./helpers/job-read-party.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { acceptanceFor, buyerFundingRefusal } from "../services/scope-acceptance.js";
import { isMockSettlement, isTestProcess, mockFundsWrites } from "../services/settlement-mode.js";
import { bindBuyer, sameIdentity } from "../auth/buyer-identity.js";

const KERNEL = "kernel-nyc"; // operator 0x1111…, default (manual) policy
const NYC_OPERATOR = "0x1111111111111111111111111111111111111111";
const LAB = "kernel-nanoclaw"; // operator 0x8888…, "policy" mode
const LAB_OPERATOR = "0x8888888888888888888888888888888888888888";
const BUYER = "0x5555555555555555555555555555555555555555";
const OTHER = "0x6666666666666666666666666666666666666666";
/** A wallet with letters, so a change of case is a real change (the stand-in gate proves it lowercase). */
const LETTERED = "0xabcdef0123456789abcdef0123456789abcdef01";
const LETTERED_MIXED = "0xABCDEF0123456789ABCDEF0123456789ABCDEF01";
const ADMIN = "n133-rules-admin";

const asKey = (id: string) => ({ "x-test-key": id });
const claimedOnly = (id: string) => ({ ...asKey(id), "x-test-proven-wallet": "none" });
const asAdmin = (id = "admin-console") => ({ ...claimedOnly(id), "x-admin-key": ADMIN });

const ENV = ["MOCK_SETTLEMENT", "PCC_GATEWAY_PRIVATE_KEY", "PCC_A2A_AUTH_DISABLED", "PCC_DB_PATH", "PCC_ADMIN_KEY"] as const;
const saved: Record<string, string | undefined> = {};
let app: FastifyInstance;

/**
 * N98 (#498): a discovery quote is the kernel's REGISTERED capability price, never a template hint. So each
 * kernel these tests submit to carries exactly one USDC-priced liquid-handler capability, registered once.
 * No test here asserts an amount; the price only has to be a valid registered one.
 */
function ensurePricedLiquidHandler(kernelId: string): void {
  const capabilities = getRepos().capabilities;
  if (capabilities.findByKernel(kernelId).some((c: { type: string }) => c.type === "liquid-handler")) return;
  capabilities.insert({
    id: `cap-liquid-handler-${kernelId}`,
    kernelId,
    type: "liquid-handler",
    name: "liquid-handler test capability",
    description: "test",
    materials: [],
    tolerances: {},
    envelope: { x: 1, y: 1, z: 1, unit: "mm" as const },
    assuranceTiers: [0, 1, 2, 3],
    pricing: { currency: "USDC", baseCost: "10.00", minimum: "0.01" } as never,
    availability: {},
    location: { lat: 40.7, lng: -74 },
  } as never);
}

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.MOCK_SETTLEMENT = "true"; // explicit: rule 4 turned the default off
  delete process.env.PCC_GATEWAY_PRIVATE_KEY;
  delete process.env.PCC_A2A_AUTH_DISABLED;
  process.env.PCC_ADMIN_KEY = ADMIN;
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  ensurePricedLiquidHandler(KERNEL);
  ensurePricedLiquidHandler(LAB);
  __resetA2ATasksForTest();

  app = Fastify({ logger: false });
  app.decorateRequest("operatorId", null);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.addHook("onRequest", async (req) => {
    const key = req.headers["x-test-key"];
    if (typeof key === "string") {
      (req as unknown as { operatorId: string }).operatorId = key;
      (req as unknown as { userId: string }).userId = key;
    }
  });
  actAsJobParty(app);
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  await app.register(deviceRelayRoutes);
  await app.register(operatorRoutes);
  await app.register(a2aTasksRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  closeStore();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const db = () => getStore().db;
const scopeRow = (id: string) => db().select().from(schema.executionScopes).where(eq(schema.executionScopes.id, id)).get()!;
const approvalFor = (jobId: string) =>
  db().select().from(schema.pendingApprovals).where(eq(schema.pendingApprovals.jobId, jobId)).get();
const queued = () => db().select().from(schema.toolCallRelay).all();

function setPolicy(kernelId: string, policy: unknown) {
  db().run(sql`INSERT OR REPLACE INTO operator_policies (kernel_id, policy, updated_at, updated_by)
    VALUES (${kernelId}, ${JSON.stringify(policy)}, ${new Date().toISOString()}, ${"test"})`);
}
/** A copy of the kernel's seeded policy (the column is a json column: it reads as an object). */
const basePolicy = (kernelId = KERNEL): Record<string, unknown> =>
  structuredClone((db().select().from(schema.operatorPolicies).where(eq(schema.operatorPolicies.kernelId, kernelId)).get()?.policy ?? {}) as Record<string, unknown>);

const submit = (headers: Record<string, string>, userAgentId: string, kernelId = KERNEL) =>
  app.inject({
    method: "POST",
    url: "/api/jobs/submit-from-discovery",
    headers,
    payload: { kernelId, capabilityType: "liquid-handler", userAgentId },
  });
const writeAs = (headers: Record<string, string>, scopeId: string, kernelId = KERNEL) =>
  app.inject({
    method: "POST",
    url: `/api/relay/${kernelId}/tool-call`,
    headers,
    payload: { scopeId, toolName: "ot2_run_protocol", args: { protocol: "x" } },
  });
/** The operator's decision on a scope (a request with no x-test-key reads as kernel-nyc's operator). */
const accept = (scopeId: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/api/operator/scopes/${scopeId}/accept`, headers });
const revoke = (kernelId: string, scopeId: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/api/relay/${kernelId}/scope/${scopeId}/revoke`, headers });
const approve = (approvalId: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/api/operator/approvals/${approvalId}/approve`, headers });

// ── Rule 1: the buyer ───────────────────────────────────────────────────────

describe("N133 rule 1: a paid job's buyer is the caller's proven identity, or the admin acts for it", () => {
  it("sameIdentity: equal strings, or the same 0x address in another case; nothing else", () => {
    expect(sameIdentity(BUYER, BUYER)).toBe(true);
    expect(sameIdentity(LETTERED_MIXED, LETTERED)).toBe(true);
    expect(sameIdentity("agent-1", "AGENT-1")).toBe(false);
    expect(sameIdentity(BUYER, OTHER)).toBe(false);
    expect(sameIdentity("", "")).toBe(false);
    expect(sameIdentity(undefined, undefined)).toBe(false);
  });

  it("bindBuyer: the admin names any buyer; a proven wallet only itself, stored as proven; a claim never", () => {
    expect(bindBuyer({ admin: true, provenWallet: null }, OTHER)).toEqual({ ok: true, buyer: OTHER });
    expect(bindBuyer({ admin: false, provenWallet: LETTERED }, LETTERED_MIXED)).toEqual({ ok: true, buyer: LETTERED });
    expect(bindBuyer({ admin: false, provenWallet: BUYER }, OTHER)).toMatchObject({ ok: false, status: 403, body: { reason: "buyer_mismatch" } });
    expect(bindBuyer({ admin: false, provenWallet: null }, BUYER)).toMatchObject({ ok: false, status: 403, body: { reason: "buyer_proof_required" } });
    expect(bindBuyer({ admin: true, provenWallet: null }, "")).toMatchObject({ ok: false });
  });

  it("the admin may submit for any buyer: the scope is that buyer's", async () => {
    const res = await submit(asAdmin(), OTHER);
    expect(res.statusCode).toBe(201);
    expect(scopeRow(res.json().scopeId).createdBy).toBe(OTHER);
  });

  it("a proven wallet naming itself in another letter case is its own buyer, stored as proven", async () => {
    const res = await submit(asKey(LETTERED), LETTERED_MIXED);
    expect(res.statusCode).toBe(201);
    expect(scopeRow(res.json().scopeId).createdBy).toBe(LETTERED);
  });

  it("a claimed key naming a capability the kernel doesn't register is refused for proof (403) before the capability lookup (404); nothing is created", async () => {
    // r4 review F2: the binding comes before N98's registered-capability lookup, so an unproven
    // caller learns nothing about what a kernel registers. Pin that order.
    const unregistered = "n133-unregistered-capability";
    const submitUnregistered = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/api/jobs/submit-from-discovery",
        headers,
        payload: { kernelId: KERNEL, capabilityType: unregistered, userAgentId: BUYER },
      });
    const counts = () => ({
      sessions: db().select().from(schema.negotiationSessions).all().length,
      escrows: db().select().from(schema.escrows).all().length,
      jobs: db().select().from(schema.jobs).all().length,
      scopes: db().select().from(schema.executionScopes).all().length,
    });
    const before = counts();

    const refused = await submitUnregistered(claimedOnly(BUYER));
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "forbidden", reason: "buyer_proof_required" });
    expect(counts()).toEqual(before);

    // Control: the same request from the buyer's proven wallet passes the binding and gets N98's 404.
    const proven = await submitUnregistered(asKey(BUYER));
    expect(proven.statusCode).toBe(404);
    expect(proven.json().error).toBe("capability_not_found");
    expect(counts()).toEqual(before);
  });

  it("negotiation: a proven buyer opens its own session; a mismatch is refused; the admin commits for the buyer", async () => {
    const mismatch = await app.inject({
      method: "POST", url: "/api/negotiate/session", headers: asKey(BUYER),
      payload: { userAgentId: OTHER, kernelId: LAB, capabilityType: "liquid-handler" },
    });
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.json().reason).toBe("buyer_mismatch");

    const created = await app.inject({
      method: "POST", url: "/api/negotiate/session", headers: asKey(BUYER),
      payload: { userAgentId: BUYER, kernelId: LAB, capabilityType: "liquid-handler" },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().session.id as string;
    expect(created.json().session.userAgentId).toBe(BUYER);
    for (const step of ["quote", "review"]) {
      expect((await app.inject({ method: "POST", url: `/api/negotiate/session/${id}/${step}`, headers: asKey(BUYER) })).statusCode).toBe(200);
    }
    // A claimed key of the buyer's own address may not commit; the admin may.
    const claimed = await app.inject({ method: "POST", url: `/api/negotiate/session/${id}/commit`, headers: claimedOnly(BUYER) });
    expect(claimed.statusCode).toBe(403);
    expect(claimed.json().reason).toBe("buyer_proof_required");
    const committed = await app.inject({ method: "POST", url: `/api/negotiate/session/${id}/commit`, headers: asAdmin() });
    expect(committed.statusCode).toBe(200);
    expect(scopeRow(committed.json().scopeId).createdBy).toBe(BUYER);
  });

  it("retry-settlement is the commit's minting again: the buyer or the admin only", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/negotiate/session", headers: asKey(BUYER),
      payload: { userAgentId: BUYER, kernelId: LAB, capabilityType: "liquid-handler" },
    });
    const id = created.json().session.id as string;
    db().update(schema.negotiationSessions).set({ status: "settlement_failed" }).where(eq(schema.negotiationSessions.id, id)).run();
    const other = await app.inject({ method: "POST", url: `/api/negotiate/session/${id}/retry-settlement`, headers: asKey(OTHER) });
    expect(other.statusCode).toBe(403);
    expect(other.json().reason).toBe("buyer_mismatch");
    expect(db().select().from(schema.executionScopes).all()).toHaveLength(0);
  });

  describe("A2A pcc-quote / pcc-submit", () => {
    const send = (headers: Record<string, string>, skill: string, params: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/a2a/tasks/send", headers, payload: { jsonrpc: "2.0", id: 1, method: "tasks/send", params: { skill, params } } });
    function siweSession(wallet: string) {
      const token = randomUUID();
      const now = new Date();
      getRepos().sessions.insert({
        id: randomUUID(), walletAddress: wallet, token, createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(), lastActiveAt: now.toISOString(),
      });
      return { authorization: `Bearer ${token}` };
    }
    const params = (userAgentId: unknown) => ({ userAgentId, kernelId: LAB, capabilityType: "liquid-handler" });

    it("present non-string buyers are refused for claimed keys, SIWE sessions and the admin before anything is created", async () => {
      // Keep capability fixtures, but start with no seeded escrows or jobs.
      db().delete(schema.escrows).run();
      db().delete(schema.jobs).run();
      const key = provisionApiKey({ operatorId: "n133-claimed-buyer" }).rawKey;
      const claimed = { authorization: `Bearer ${key}` };
      const control = await send(claimed, "pcc-submit", params(BUYER));
      expect(control.json<{ error?: unknown }>().error).toMatchObject({ code: -32001, data: { reason: "buyer_proof_required" } });

      const nonStringBuyers: unknown[] = [12345, { id: BUYER }, [BUYER], true];
      for (const buyer of nonStringBuyers) {
        const refused = await send(claimed, "pcc-submit", params(buyer));
        expect(refused.json<{ error?: unknown }>().error).toMatchObject({ code: -32001, data: { reason: "buyer_proof_required" } });
      }

      const auth = siweSession(BUYER);
      for (const buyer of nonStringBuyers) {
        const refused = await send(auth, "pcc-submit", params(buyer));
        expect(refused.json<{ error?: unknown }>().error).toMatchObject({ code: -32001, data: { reason: "buyer_mismatch" } });
      }

      const admin = await send({ ...claimed, "x-admin-key": ADMIN }, "pcc-quote", params(12345));
      expect(admin.json<{ error?: unknown }>().error).toMatchObject({ code: -32001, data: { reason: "buyer_proof_required" } });

      expect(db().select().from(schema.negotiationSessions).all()).toHaveLength(0);
      expect(db().select().from(schema.escrows).all()).toHaveLength(0);
      expect(db().select().from(schema.jobs).all()).toHaveLength(0);
      expect(db().select().from(schema.executionScopes).all()).toHaveLength(0);
    });

    it("a SIWE session's wallet submits for itself; naming someone else is refused before anything is created", async () => {
      const auth = siweSession(BUYER);
      const other = await send(auth, "pcc-submit", params(OTHER));
      expect(other.json().error).toMatchObject({ code: -32001, data: { reason: "buyer_mismatch" } });
      expect(db().select().from(schema.negotiationSessions).all()).toHaveLength(0);

      const own = await send(auth, "pcc-submit", params(BUYER));
      expect(own.json().error).toBeUndefined();
      const commit = (own.json().result.artifacts as Array<{ type: string; data: { scopeId: string; scopeStatus: string } }>).find((a) => a.type === "pcc.commit")!;
      expect(scopeRow(commit.data.scopeId).createdBy).toBe(BUYER);
      expect(commit.data.scopeStatus).toBe("awaiting_acceptance"); // kernel-nanoclaw's policy mode; BUYER is not trusted
    });

    it("the admin key acts for any buyer; with A2A auth switched off a SIWE caller still binds and an anonymous one has no proof", async () => {
      // A2A's own gate wants a key or a SIWE session; the admin secret is what lets it name any buyer.
      const key = provisionApiKey({ operatorId: "n133-admin-console" }).rawKey;
      const admin = await send({ authorization: `Bearer ${key}`, "x-admin-key": ADMIN }, "pcc-quote", params(OTHER));
      expect(admin.json().error).toBeUndefined();

      process.env.PCC_A2A_AUTH_DISABLED = "true";
      const anonymous = await send({}, "pcc-quote", params(OTHER));
      expect(anonymous.json().error).toMatchObject({ code: -32001, data: { reason: "buyer_proof_required" } });
      expect(db().select().from(schema.negotiationSessions).all()).toHaveLength(1); // the admin's only
      // "Disabled" waives the requirement, not the caller: a SIWE session presented anyway is proof.
      const own = await send(siweSession(BUYER), "pcc-quote", params(BUYER));
      expect(own.json().error).toBeUndefined();
      expect(db().select().from(schema.negotiationSessions).all()).toHaveLength(2);
    });
  });
});

// ── Rule 2: acceptance ──────────────────────────────────────────────────────

describe("N133 rule 2: a paid write scope goes live only on the kernel operator's acceptance, per its policy", () => {
  it("acceptanceFor: auto accepts, policy accepts its trusted agents, blocked is refused, silence waits", () => {
    expect(acceptanceFor({ approvalMode: "auto", blockedAgents: [], trustedAgents: [] }, BUYER)).toBe("accepted");
    expect(acceptanceFor({ approvalMode: "policy", trustedAgents: [LETTERED_MIXED] }, LETTERED)).toBe("accepted");
    expect(acceptanceFor({ approvalMode: "policy", trustedAgents: [OTHER] }, BUYER)).toBe("awaiting_operator");
    expect(acceptanceFor({ approvalMode: "manual", trustedAgents: [BUYER] }, BUYER)).toBe("awaiting_operator");
    expect(acceptanceFor({ approvalMode: "auto", blockedAgents: [BUYER] }, BUYER)).toBe("refused");
    for (const silent of [null, undefined, "auto", [], 7, {}, { approvalMode: "always" }, { trustedAgents: [BUYER] }]) {
      expect(acceptanceFor(silent, BUYER), JSON.stringify(silent)).toBe("awaiting_operator");
    }
  });

  it("an auto policy accepts at once: the buyer's scope is live and its write is admitted; no approval row is made", async () => {
    setPolicy(KERNEL, { ...basePolicy(), approvalMode: "auto" });
    const res = await submit(asKey(BUYER), BUYER);
    expect(res.json().scopeStatus).toBe("active");
    expect(approvalFor(res.json().jobId)).toBeUndefined();
    expect((await writeAs(asKey(BUYER), res.json().scopeId)).statusCode).toBe(201);
  });

  it("a policy-mode kernel accepts its trusted buyer and waits for anyone else", async () => {
    setPolicy(KERNEL, { ...basePolicy(), approvalMode: "policy", trustedAgents: [BUYER] });
    expect((await submit(asKey(BUYER), BUYER)).json().scopeStatus).toBe("active");
    expect((await submit(asKey(OTHER), OTHER)).json().scopeStatus).toBe("awaiting_acceptance");
  });

  it("a blocked buyer's scope is dead: rejected, and the operator's accept can't revive it", async () => {
    setPolicy(KERNEL, { ...basePolicy(), approvalMode: "auto", blockedAgents: [BUYER] });
    const res = await submit(asKey(BUYER), BUYER);
    expect(res.json().scopeStatus).toBe("rejected");
    expect(approvalFor(res.json().jobId)).toBeUndefined();
    const again = await accept(res.json().scopeId);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "already_decided", status: "rejected" });
    expect((await writeAs(asKey(BUYER), res.json().scopeId)).statusCode).toBe(403);
  });

  it("a default (manual) policy waits; the scope's kernel operator, proven, accepts it once; then the write is admitted", async () => {
    const res = await submit(asKey(BUYER), BUYER);
    expect(res.statusCode).toBe(201);
    const { scopeId, jobId } = res.json() as { scopeId: string; jobId: string };
    expect(res.json().scopeStatus).toBe("awaiting_acceptance");
    expect(approvalFor(jobId)).toBeUndefined(); // the decision is the scope's, not an executor job
    expect((await writeAs(asKey(BUYER), scopeId)).statusCode).toBe(403);

    const accepted = await accept(scopeId);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ accepted: true, scopeId, kernelId: KERNEL, jobId, status: "active", fundingRefusal: null });
    expect(scopeRow(scopeId).status).toBe("active");
    expect((await writeAs(asKey(BUYER), scopeId)).statusCode).toBe(201);

    // Once decided, a second accept changes nothing.
    const twice = await accept(scopeId);
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toMatchObject({ error: "already_decided", status: "active" });
  });

  it("only a decision may accept: anonymous 401, a claimed operator key 403, the buyer itself 403, an unknown scope 404", async () => {
    const { scopeId } = (await submit(asKey(BUYER), BUYER)).json() as { scopeId: string };
    const anonymous = await app.inject({ method: "POST", url: `/api/operator/scopes/${scopeId}/accept`, headers: { "x-test-principal": "", "x-test-proven-wallet": "none" } });
    expect(anonymous.statusCode).toBe(401);
    const claimed = await accept(scopeId, claimedOnly(NYC_OPERATOR));
    expect(claimed.statusCode).toBe(403);
    expect(claimed.json().reason).toBe("operator_proof_required");
    const buyer = await accept(scopeId, asKey(BUYER));
    expect(buyer.statusCode).toBe(403);
    expect(scopeRow(scopeId).status).toBe("awaiting_acceptance");
    expect((await accept("scope_does_not_exist")).statusCode).toBe(404);
  });

  it("the admin may accept on the operator's behalf", async () => {
    const { scopeId } = (await submit(asKey(BUYER), BUYER)).json() as { scopeId: string };
    const accepted = await accept(scopeId, asAdmin());
    expect(accepted.statusCode).toBe(200);
    expect(scopeRow(scopeId).status).toBe("active");
  });

  it("the operator refuses by revoking: the scope is dead and can't be accepted after", async () => {
    const { scopeId } = (await submit(asKey(BUYER), BUYER)).json() as { scopeId: string };
    const revoked = await revoke(KERNEL, scopeId);
    expect(revoked.statusCode).toBe(200);
    expect(scopeRow(scopeId).status).toBe("revoked");
    const late = await accept(scopeId);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: "already_decided", status: "revoked" });
    expect((await writeAs(asKey(BUYER), scopeId)).statusCode).toBe(403);
  });

  it("no accept while the kernel's emergency stop is engaged, or while its policy can't be read; nothing changes", async () => {
    const { scopeId } = (await submit(asKey(BUYER), BUYER)).json() as { scopeId: string };
    setPolicy(KERNEL, { ...basePolicy(), emergencyStop: true });
    const stopped = await accept(scopeId);
    expect(stopped.statusCode).toBe(409);
    expect(stopped.json().error).toBe("kernel_emergency_stopped");
    expect(scopeRow(scopeId).status).toBe("awaiting_acceptance");

    db().run(sql`INSERT OR REPLACE INTO operator_policies (kernel_id, policy, updated_at, updated_by)
      VALUES (${KERNEL}, ${"[]"}, ${new Date().toISOString()}, ${"test"})`);
    const unreadable = await accept(scopeId);
    expect(unreadable.statusCode).toBe(503);
    expect(unreadable.json().error).toBe("policy_unavailable");
    expect(scopeRow(scopeId).status).toBe("awaiting_acceptance");
  });

  it("an expired scope can't be accepted", async () => {
    const { scopeId } = (await submit(asKey(BUYER), BUYER)).json() as { scopeId: string };
    db().update(schema.executionScopes).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(schema.executionScopes.id, scopeId)).run();
    const late = await accept(scopeId);
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe("scope_expired");
    expect(scopeRow(scopeId).status).toBe("awaiting_acceptance");
  });

  // Fail closed: `new Date(x) <= new Date()` is false when x does not parse, so the accept route
  // took a scope whose window it could not read. expires_at is TEXT NOT NULL and every writer
  // stores toISOString(), so these come only from a hand edit, a restore or another writer (epoch
  // milliseconds stored as text). Each is refused as an expired window is, and nothing goes live.
  const UNREADABLE_EXPIRIES = ["", " ", "garbage", "Invalid Date", "1728400000000"];
  const setExpiry = (scopeId: string, expiresAt: string) =>
    db().update(schema.executionScopes).set({ expiresAt }).where(eq(schema.executionScopes.id, scopeId)).run();

  for (const unreadable of UNREADABLE_EXPIRIES) {
    it(`a scope whose expiry can't be read (${JSON.stringify(unreadable)}) can't be accepted either; nothing goes live`, async () => {
      const { scopeId } = (await submit(asKey(BUYER), BUYER)).json() as { scopeId: string };
      setExpiry(scopeId, unreadable);
      const late = await accept(scopeId);
      expect(late.statusCode).toBe(409);
      expect(late.json()).toEqual({ error: "scope_expired", message: "This scope expired before it was accepted; this request changed nothing." });
      expect(scopeRow(scopeId).status).toBe("awaiting_acceptance");
      expect((await writeAs(asKey(BUYER), scopeId)).statusCode).toBe(403);
      expect(queued()).toHaveLength(0);
    });
  }

  it("controls for the unreadable expiries: a readable future expiry is accepted, a readable past one is not", async () => {
    const open = (await submit(asKey(BUYER), BUYER)).json() as { scopeId: string };
    setExpiry(open.scopeId, new Date(Date.now() + 10 * 60_000).toISOString());
    const accepted = await accept(open.scopeId);
    expect(accepted.statusCode).toBe(200);
    expect(scopeRow(open.scopeId).status).toBe("active");

    const shut = (await submit(asKey(BUYER), BUYER)).json() as { scopeId: string };
    setExpiry(shut.scopeId, new Date(Date.now() - 1000).toISOString());
    const late = await accept(shut.scopeId);
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe("scope_expired");
    expect(scopeRow(shut.scopeId).status).toBe("awaiting_acceptance");
  });

  it("an approval queued through POST /api/operator/approvals can't name a scope to activate", async () => {
    const res = await submit(asKey(BUYER), BUYER);
    const forged = await app.inject({
      method: "POST", url: "/api/operator/approvals",
      payload: { kernelId: KERNEL, agentId: BUYER, parameters: { kind: "execution_scope", scopeId: res.json().scopeId } },
    });
    expect(forged.statusCode).toBe(200);
    expect((await approve(forged.json().approval.id)).statusCode).toBe(200);
    expect(scopeRow(res.json().scopeId).status).toBe("awaiting_acceptance");
  });

  it("the negotiation commit waits for the lab's operator, whose acceptance makes the scope live", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/negotiate/session", headers: asKey(BUYER),
      payload: { userAgentId: BUYER, kernelId: LAB, capabilityType: "liquid-handler" },
    });
    const id = created.json().session.id as string;
    for (const step of ["quote", "review"]) {
      await app.inject({ method: "POST", url: `/api/negotiate/session/${id}/${step}`, headers: asKey(BUYER) });
    }
    const commit = await app.inject({ method: "POST", url: `/api/negotiate/session/${id}/commit`, headers: asKey(BUYER) });
    expect(commit.json()).toMatchObject({ scopeStatus: "awaiting_acceptance" });
    const scopeId = commit.json().scopeId as string;
    expect((await writeAs(asKey(BUYER), scopeId, LAB)).statusCode).toBe(403);
    // kernel-nyc's operator can't accept for kernel-nanoclaw; the lab's own proven operator can.
    expect((await accept(scopeId, asKey(NYC_OPERATOR))).statusCode).toBe(403);
    expect(scopeRow(scopeId).status).toBe("awaiting_acceptance");
    const accepted = await accept(scopeId, asKey(LAB_OPERATOR));
    expect(accepted.json()).toMatchObject({ accepted: true, status: "active" });
    expect((await writeAs(asKey(BUYER), scopeId, LAB)).statusCode).toBe(201);
  });

  it("the mint reads the policy and the stop as they are then: an auto policy under a stop mints a scope that waits", async () => {
    // A stop that lands after the buyer's session began (the fast-track and the session refuse a
    // stopped kernel up front, so the mint itself is the last word).
    const created = await app.inject({
      method: "POST", url: "/api/negotiate/session", headers: asKey(BUYER),
      payload: { userAgentId: BUYER, kernelId: LAB, capabilityType: "liquid-handler" },
    });
    const id = created.json().session.id as string;
    setPolicy(LAB, { ...basePolicy(LAB), approvalMode: "auto", emergencyStop: true });
    const session = db().select().from(schema.negotiationSessions).where(eq(schema.negotiationSessions.id, id)).get()!;
    const minted = await createJobFromSession(session);
    expect(minted.scopeStatus).toBe("awaiting_acceptance");
    expect(scopeRow(minted.scopeId).status).toBe("awaiting_acceptance");

    // Control: the same auto policy with the stop clear is live at once.
    setPolicy(LAB, { ...basePolicy(LAB), approvalMode: "auto", emergencyStop: false });
    const created2 = await app.inject({
      method: "POST", url: "/api/negotiate/session", headers: asKey(BUYER),
      payload: { userAgentId: BUYER, kernelId: LAB, capabilityType: "liquid-handler" },
    });
    const session2 = db().select().from(schema.negotiationSessions).where(eq(schema.negotiationSessions.id, created2.json().session.id as string)).get()!;
    expect((await createJobFromSession(session2)).scopeStatus).toBe("active");
  });

  it("a policy the mint can't read accepts nothing: a non-object, or text that isn't JSON", async () => {
    for (const garbled of ["[]", '"auto"', "{not json"]) {
      setPolicy(LAB, { ...basePolicy(LAB), approvalMode: "auto" });
      const created = await app.inject({
        method: "POST", url: "/api/negotiate/session", headers: asKey(BUYER),
        payload: { userAgentId: BUYER, kernelId: LAB, capabilityType: "liquid-handler" },
      });
      const session = db().select().from(schema.negotiationSessions).where(eq(schema.negotiationSessions.id, created.json().session.id as string)).get()!;
      db().run(sql`INSERT OR REPLACE INTO operator_policies (kernel_id, policy, updated_at, updated_by)
        VALUES (${LAB}, ${garbled}, ${new Date().toISOString()}, ${"test"})`);
      expect((await createJobFromSession(session)).scopeStatus, garbled).toBe("awaiting_acceptance");
    }
  });
});

// ── Rule 3: funding ─────────────────────────────────────────────────────────

describe("N133 rule 3: write tools only on the buyer's own, real funding", () => {
  const escrow = (over: Partial<{ payer: string; status: string; contractAddress: string }>) => ({
    payer: BUYER, status: "funded", contractAddress: "mock-escrow-x", ...over,
  });

  it("buyerFundingRefusal: a mock counts only under the explicit test flag; a real escrow never yet", () => {
    expect(buyerFundingRefusal(escrow({}), BUYER)).toBeNull();
    expect(buyerFundingRefusal(undefined, BUYER)).toBe("escrow_missing");
    expect(buyerFundingRefusal(escrow({ payer: OTHER }), BUYER)).toBe("escrow_payer_not_buyer");
    expect(buyerFundingRefusal(escrow({ status: "created" }), BUYER)).toBe("escrow_not_funded");
    expect(buyerFundingRefusal(escrow({ contractAddress: "0x" + "a".repeat(40) }), BUYER)).toBe("escrow_not_buyer_funded");
    delete process.env.MOCK_SETTLEMENT;
    expect(buyerFundingRefusal(escrow({}), BUYER)).toBe("mock_escrow");
  });

  /** A manual-policy job, its escrow changed to `over`, then accepted by kernel-nyc's operator. */
  async function acceptWithEscrow(over: Partial<{ payer: string; status: string; contractAddress: string }>) {
    const res = await submit(asKey(BUYER), BUYER);
    const { escrowId, scopeId } = res.json() as { escrowId: string; scopeId: string };
    db().update(schema.escrows).set(over).where(eq(schema.escrows.id, escrowId)).run();
    const accepted = await accept(scopeId);
    expect(accepted.statusCode).toBe(200);
    return { scopeId, accepted };
  }

  for (const [label, over, refusal] of [
    ["a gateway-funded real escrow (V3 mode A funds at creation from the gateway's key)", { contractAddress: "0x" + "b".repeat(40), status: "funded" }, "escrow_not_buyer_funded"],
    ["an escrow whose payer is not the buyer", { payer: OTHER }, "escrow_payer_not_buyer"],
    ["an unfunded escrow", { status: "created" }, "escrow_not_funded"],
  ] as const) {
    it(`accepted, ${label} leaves the scope awaiting funding, and the write refused`, async () => {
      const { scopeId, accepted } = await acceptWithEscrow(over);
      expect(accepted.json()).toMatchObject({ status: "awaiting_funding", fundingRefusal: refusal });
      expect(scopeRow(scopeId).status).toBe("awaiting_funding");
      expect((await writeAs(asKey(BUYER), scopeId)).statusCode).toBe(403);
      expect(queued()).toHaveLength(0);
    });
  }

  it("mintedScopeStatus: an accepted buyer's scope is live at the mint only on its own, real funding", () => {
    setPolicy(LAB, { ...basePolicy(LAB), approvalMode: "auto" });
    const escrowRow = (id: string, over: Partial<{ payer: string; contractAddress: string }>) =>
      getRepos().escrows.insert({
        id, cwmId: `cwm-${id}`, contractAddress: "mock-escrow-n133", payer: BUYER, totalAmount: "1.00", currency: "USDC",
        status: "funded", createdAt: new Date().toISOString(), deadline: new Date(Date.now() + 3_600_000).toISOString(), version: "v2",
        ...over,
      });
    escrowRow("esc-n133-own", {});
    escrowRow("esc-n133-gateway", { contractAddress: "0x" + "b".repeat(40) });
    escrowRow("esc-n133-other", { payer: OTHER });
    expect(mintedScopeStatus(LAB, BUYER, "esc-n133-own")).toBe("active"); // the flag's mock: the test stand-in
    expect(mintedScopeStatus(LAB, BUYER, "esc-n133-gateway")).toBe("awaiting_funding");
    expect(mintedScopeStatus(LAB, BUYER, "esc-n133-other")).toBe("awaiting_funding");
    expect(mintedScopeStatus(LAB, BUYER, "esc-n133-missing")).toBe("awaiting_funding");
  });

  it("a mock escrow outside tests (the flag off) is not funding either", async () => {
    const res = await submit(asKey(BUYER), BUYER);
    delete process.env.MOCK_SETTLEMENT;
    const accepted = await accept(res.json().scopeId);
    expect(accepted.json()).toMatchObject({ status: "awaiting_funding", fundingRefusal: "mock_escrow" });
  });
});

// ── Rule 4: the mock flag ───────────────────────────────────────────────────

describe("N133 rule 4: mock settlement is on only when MOCK_SETTLEMENT is exactly \"true\"", () => {
  it("unset, false and anything but \"true\" are off", () => {
    for (const value of [undefined, "", "false", "TRUE", "True", "1", "yes", "on", " true"]) {
      if (value === undefined) delete process.env.MOCK_SETTLEMENT;
      else process.env.MOCK_SETTLEMENT = value;
      expect(isMockSettlement(), String(value)).toBe(false);
    }
    process.env.MOCK_SETTLEMENT = "true";
    expect(isMockSettlement()).toBe(true);
  });

  it("with it unset even the admin's fast-track mints no mock escrow (real settlement, unconfigured here)", async () => {
    delete process.env.MOCK_SETTLEMENT;
    const res = await submit(asAdmin(), BUYER);
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("fast_track_failed");
    expect(db().select().from(schema.escrows).where(eq(schema.escrows.payer, BUYER)).all()).toHaveLength(0);
    expect(db().select().from(schema.executionScopes).where(eq(schema.executionScopes.createdBy, BUYER)).all()).toHaveLength(0);
  });
});

// ── r1 HIGH (astra): mock funding never authorizes a write outside tests ───────────────────────

describe("N133 r1 HIGH (astra): a mock escrow never funds a physical write outside a test process", () => {
  const withNodeEnv = async (value: string, fn: () => Promise<void>) => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = value;
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved;
    }
  };
  const activeScopesOf = (holder: string) =>
    db().select().from(schema.executionScopes).where(eq(schema.executionScopes.createdBy, holder)).all().filter((s) => s.status === "active");

  it("astra's repro: NODE_ENV=production, MOCK_SETTLEMENT=true, an auto policy, a proven buyer for itself: no live scope, no write", async () => {
    setPolicy(KERNEL, { ...basePolicy(), approvalMode: "auto" });
    await withNodeEnv("production", async () => {
      const res = await submit(asKey(BUYER), BUYER);
      // Mock settlement is refused in production: the real path runs, and with no settlement key
      // here it mints nothing.
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe("fast_track_failed");
      expect(activeScopesOf(BUYER)).toHaveLength(0);
      expect(queued()).toHaveLength(0);
    });
  });

  it("a development process with MOCK_SETTLEMENT=true settles in mock, but its mock escrow funds no live scope", async () => {
    setPolicy(KERNEL, { ...basePolicy(), approvalMode: "auto" });
    await withNodeEnv("development", async () => {
      const res = await submit(asKey(BUYER), BUYER);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ escrowStatus: "funded", scopeStatus: "awaiting_funding" });
      expect((await writeAs(asKey(BUYER), res.json().scopeId)).statusCode).toBe(403);
      expect(activeScopesOf(BUYER)).toHaveLength(0);
      expect(queued()).toHaveLength(0);
    });
  });

  it("the flag alone is not enough: refused in production; a mock escrow funds writes only in a test process", () => {
    const saved = { nodeEnv: process.env.NODE_ENV, vitest: process.env.VITEST };
    process.env.MOCK_SETTLEMENT = "true";
    try {
      process.env.NODE_ENV = "production";
      expect([isMockSettlement(), mockFundsWrites()]).toEqual([false, false]);
      process.env.NODE_ENV = "development";
      expect([isMockSettlement(), isTestProcess(), mockFundsWrites()]).toEqual([true, false, false]);
      process.env.NODE_ENV = "test";
      expect([isMockSettlement(), isTestProcess(), mockFundsWrites()]).toEqual([true, true, true]);
      delete process.env.VITEST; // NODE_ENV=test alone is not a test process
      expect([isTestProcess(), mockFundsWrites()]).toEqual([false, false]);
    } finally {
      for (const [key, value] of [["NODE_ENV", saved.nodeEnv], ["VITEST", saved.vitest]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("a scope that went live on a mock escrow in a test is refused by the relay once the process is not a test", async () => {
    setPolicy(KERNEL, { ...basePolicy(), approvalMode: "auto" });
    const res = await submit(asKey(BUYER), BUYER);
    expect(res.json().scopeStatus).toBe("active"); // the test process: the mock stands in for buyer funding
    await withNodeEnv("production", async () => {
      const write = await writeAs(asKey(BUYER), res.json().scopeId);
      // The relay's escrow gate: refused 402, recorded as a rejected call, never dispatchable.
      expect(write.statusCode).toBe(402);
      expect(write.json()).toMatchObject({ reason: "escrow_not_funded", escrowStatus: "mock_escrow" });
      expect(queued().map((c) => [c.status, c.error])).toEqual([["rejected", "escrow_not_funded"]]);
    });
  });
});
