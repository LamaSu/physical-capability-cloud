/**
 * Board N133 (CRITICAL; the steward's DECISIONS 01:01, #6733): the self-mint door.
 *
 * Since f6359711 a PROVEN holder of the scope a write names may make that write. So whoever can
 * obtain an active write scope can actuate a kernel. Three routes mint one, through
 * createJobFromSession: POST /api/jobs/submit-from-discovery, the negotiation commit, and the
 * A2A pcc-submit skill. Each mints it for whatever userAgentId the request names, on any kernel,
 * with no decision by the kernel's operator, and mock settlement (on unless MOCK_SETTLEMENT is
 * "false") marks its escrow funded without anyone paying.
 *
 * This file was committed FAILING, before the fix (the steward asked for the repro first). It
 * asserts what must hold after N133:
 *   1. a buyer is the caller's PROVEN identity (or the admin acts for it); a claim or a mismatch
 *      is refused before anything is created;
 *   2. a write scope goes live only on the kernel operator's acceptance, per its policy;
 *   3. write tools only on the buyer's own, real funding, never a mock one outside tests;
 *   4. mock settlement is off unless MOCK_SETTLEMENT is exactly "true".
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { deviceRelayRoutes } from "../routes/device-relay.js";
import { operatorRoutes } from "../routes/operator.js";
import { a2aTasksRoutes, __resetA2ATasksForTest } from "../routes/a2a-tasks.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { initStore, closeStore, getStore } from "../db.js";
import { schema, eq } from "@pcc/store";
import { actAsJobParty } from "./helpers/job-read-party.js";

const KERNEL = "kernel-nyc"; // operator 0x1111…, default (manual) policy
const LAB = "kernel-nanoclaw"; // operator 0x8888…, "policy" mode, the seeded liquid-handler kernel
/** A wallet the stand-in gate proves, with no relation to either kernel. */
const STRANGER = "0x5555555555555555555555555555555555555555";
const VICTIM = "0x6666666666666666666666666666666666666666";

/** A wallet principal: the stand-in gate (actAsJobParty) treats it as proven. */
const asKey = (id: string) => ({ "x-test-key": id });
/** The same identity, merely claimed through a key, with no proof. */
const claimedOnly = (id: string) => ({ ...asKey(id), "x-test-proven-wallet": "none" });

const ENV = ["MOCK_SETTLEMENT", "PCC_GATEWAY_PRIVATE_KEY", "PCC_A2A_AUTH_DISABLED", "PCC_DB_PATH"] as const;
const saved: Record<string, string | undefined> = {};
let app: FastifyInstance;

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  // The door as found: MOCK_SETTLEMENT unset, no settlement key, A2A auth on.
  delete process.env.MOCK_SETTLEMENT;
  delete process.env.PCC_GATEWAY_PRIVATE_KEY;
  delete process.env.PCC_A2A_AUTH_DISABLED;
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  __resetA2ATasksForTest();

  app = Fastify({ logger: false });
  // Stand-in for apiGate, as in paid-job-flow.test.ts: a key sets operatorId and userId.
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
  // A request with no x-test-key reads as kernel-nyc's operator; a wallet principal is proven.
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
const scopesOf = (holder: string) =>
  db().select().from(schema.executionScopes).where(eq(schema.executionScopes.createdBy, holder)).all();
const scopeRow = (id: string) =>
  db().select().from(schema.executionScopes).where(eq(schema.executionScopes.id, id)).get();
const escrowsOf = (payer: string) =>
  db().select().from(schema.escrows).where(eq(schema.escrows.payer, payer)).all();
const queued = () => db().select().from(schema.toolCallRelay).all();
const counts = () => ({
  sessions: db().select().from(schema.negotiationSessions).all().length,
  escrows: db().select().from(schema.escrows).all().length,
  scopes: db().select().from(schema.executionScopes).all().length,
  approvals: db().select().from(schema.pendingApprovals).all().length,
});

const submit = (headers: Record<string, string>, userAgentId: string, kernelId = KERNEL) =>
  app.inject({
    method: "POST",
    url: "/api/jobs/submit-from-discovery",
    headers,
    payload: { kernelId, capabilityType: "liquid-handler", userAgentId },
  });

/** A write tool call (ot2_run_protocol is a liquid-handler write tool, never a safe one). */
const writeAs = (headers: Record<string, string>, scopeId: unknown, kernelId = KERNEL) =>
  app.inject({
    method: "POST",
    url: `/api/relay/${kernelId}/tool-call`,
    headers,
    payload: { ...(typeof scopeId === "string" ? { scopeId } : {}), toolName: "ot2_run_protocol", args: { protocol: "x" } },
  });

/** Create, quote and review a negotiation session as `headers`, for `userAgentId`. */
async function negotiate(headers: Record<string, string>, userAgentId: string) {
  const created = await app.inject({
    method: "POST",
    url: "/api/negotiate/session",
    headers,
    payload: { userAgentId, kernelId: LAB, capabilityType: "liquid-handler" },
  });
  if (created.statusCode !== 200) return { created, sessionId: null as string | null };
  const sessionId = created.json().session.id as string;
  expect((await app.inject({ method: "POST", url: `/api/negotiate/session/${sessionId}/quote`, headers })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: `/api/negotiate/session/${sessionId}/review`, headers })).statusCode).toBe(200);
  return { created, sessionId };
}

describe("N133: nobody can mint a live write scope for itself on another operator's kernel", () => {
  it("the door as found: a proven stranger's fast-track for itself gets no funded escrow, no live scope and no write", async () => {
    const sub = await submit(asKey(STRANGER), STRANGER);
    // Before N133: 201, a mock escrow marked "funded" and an ACTIVE scope with every write tool.
    expect(sub.statusCode).not.toBe(201);
    expect(escrowsOf(STRANGER).filter((e) => e.status === "funded")).toHaveLength(0);
    expect(scopesOf(STRANGER).filter((s) => s.status === "active")).toHaveLength(0);

    // Before N133 the stranger's own write on kernel-nyc was queued for its executor (201).
    const write = await writeAs(asKey(STRANGER), sub.json().scopeId);
    expect(write.statusCode).toBe(403);
    expect(queued()).toHaveLength(0);
  });

  it("a claimed key may not name a buyer, its own or anyone else's: 403 before anything is created", async () => {
    process.env.MOCK_SETTLEMENT = "true"; // isolate the binding from the mock default
    const before = counts();
    for (const [headers, buyer] of [
      [claimedOnly("0xbad0000000000000000000000000000000000bad"), VICTIM], // someone else's
      [claimedOnly(VICTIM), VICTIM], // the key's own claimed identity, unproven
    ] as const) {
      const res = await submit(headers, buyer);
      expect(res.statusCode, buyer).toBe(403);
      expect(res.json().reason, buyer).toBe("buyer_proof_required");
    }
    expect(counts()).toEqual(before);
  });

  it("a proven wallet may not name someone else as the buyer: 403 before anything is created", async () => {
    process.env.MOCK_SETTLEMENT = "true";
    const before = counts();
    const res = await submit(asKey(STRANGER), VICTIM);
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe("buyer_mismatch");
    expect(counts()).toEqual(before);
  });

  it("a proven buyer's own write scope goes live only when the kernel's operator accepts it", async () => {
    process.env.MOCK_SETTLEMENT = "true"; // explicit, as tests must now set it
    const sub = await submit(asKey(STRANGER), STRANGER);
    expect(sub.statusCode).toBe(201);
    const { scopeId, jobId } = sub.json() as { scopeId: string; jobId: string };

    // kernel-nyc's policy is the default (manual): nothing is accepted for the operator.
    expect(scopeRow(scopeId)!.status).not.toBe("active");
    expect((await writeAs(asKey(STRANGER), scopeId)).statusCode).toBe(403);
    expect(queued()).toHaveLength(0);

    // The operator's decision: the pending approval for this job, accepted by kernel-nyc's
    // proven operator wallet (a request with no x-test-key reads as that operator).
    const approval = db().select().from(schema.pendingApprovals).where(eq(schema.pendingApprovals.jobId, jobId)).get();
    expect(approval?.status).toBe("pending");
    const accepted = await app.inject({ method: "POST", url: `/api/operator/approvals/${approval!.id}/approve` });
    expect(accepted.statusCode).toBe(200);

    expect(scopeRow(scopeId)!.status).toBe("active");
    expect((await writeAs(asKey(STRANGER), scopeId)).statusCode).toBe(201);
  });
});

describe("N133: the negotiation path mints the same scope", () => {
  it("a claimed key may not open a session in someone else's name", async () => {
    process.env.MOCK_SETTLEMENT = "true";
    const before = counts();
    const { created } = await negotiate(claimedOnly("0xbad0000000000000000000000000000000000bad"), VICTIM);
    expect(created.statusCode).toBe(403);
    expect(created.json().reason).toBe("buyer_proof_required");
    expect(counts()).toEqual(before);
  });

  it("the door as found: a proven stranger's own committed session gets no funded escrow and no live scope", async () => {
    const { sessionId } = await negotiate(asKey(STRANGER), STRANGER);
    expect(sessionId).not.toBeNull();
    const commit = await app.inject({ method: "POST", url: `/api/negotiate/session/${sessionId}/commit`, headers: asKey(STRANGER) });
    // Before N133: 200 with a mock escrow marked "funded" and an ACTIVE scope.
    expect(commit.statusCode).not.toBe(200);
    expect(escrowsOf(STRANGER).filter((e) => e.status === "funded")).toHaveLength(0);
    expect(scopesOf(STRANGER).filter((s) => s.status === "active")).toHaveLength(0);
    expect((await writeAs(asKey(STRANGER), commit.json().scopeId, LAB)).statusCode).toBe(403);
    expect(queued()).toHaveLength(0);
  });

  it("nobody but the session's buyer may commit it", async () => {
    process.env.MOCK_SETTLEMENT = "true";
    const { sessionId } = await negotiate(asKey(VICTIM), VICTIM);
    expect(sessionId).not.toBeNull();
    const before = counts();
    const commit = await app.inject({ method: "POST", url: `/api/negotiate/session/${sessionId}/commit`, headers: asKey(STRANGER) });
    expect(commit.statusCode).toBe(403);
    expect(counts()).toEqual(before);
  });

  it("A2A pcc-submit: a key may not commit a session in someone else's name", async () => {
    process.env.MOCK_SETTLEMENT = "true";
    const key = provisionApiKey({ operatorId: "mallory-a2a" }).rawKey;
    const before = counts();
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      headers: { authorization: `Bearer ${key}` },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: { skill: "pcc-submit", params: { userAgentId: VICTIM, kernelId: LAB, capabilityType: "liquid-handler" } },
      },
    });
    // JSON-RPC answers 200 with an error object; before N133 it committed and minted a scope.
    expect(res.json().error).toBeDefined();
    expect(counts()).toEqual(before);
    expect(scopesOf(VICTIM)).toHaveLength(0);
  });
});
