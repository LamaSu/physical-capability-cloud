/**
 * POST /api/operator/approvals/:id/consume: at-most-once CLAIM of an APPROVED
 * job (#4742, operator item 126).
 *
 * scripts/ot2-agent.py polls GET /api/operator/approvals?status=approved and
 * runs whatever it gets back on the physical robot. Without a server-side
 * claim, two machines that both poll the same approved row before either one
 * marks it locally would both run it -- a local "already ran this" marker
 * cannot stop a SECOND machine that polled before the first one's marker
 * existed. This route is that server-side, at-most-once claim: an atomic
 * compare-and-set from 'approved' to 'consumed'.
 *
 * Driven over HTTP through the REAL apiGate and real API keys, same harness
 * as operator-estop-ownership.test.ts and operator-policy-failclosed.test.ts.
 * This file imports only modules that exist before this change, so every case
 * runs unchanged on the pre-change code: the route does not exist yet, so
 * Fastify's own 404 answers every request, and every [repro] case below fails
 * (wrong status code, or the right 404 but the wrong `error` body) -- proof
 * the tests are failing-first.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { schema, eq, sql } from "@pcc/store";
import { apiGate } from "../middleware/api-gate.js";
import { kernelRoutes } from "../routes/kernels.js";
import { operatorRoutes } from "../routes/operator.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getStore, initStore } from "../db.js";

const { pendingApprovals } = schema;

let app: FastifyInstance;
/** Same routes with NO apiGate: the handler must refuse on its own (401). */
let bareApp: FastifyInstance;
let ownerKey: string;
let attackerKey: string;
const OWNER = "consume-owner";
const ATTACKER = "consume-attacker";
const ADMIN_SECRET = "consume-admin-secret";
const savedAdminKey = process.env.PCC_ADMIN_KEY;

const asOwner = () => ({ authorization: `Bearer ${ownerKey}` });
const asAttacker = () => ({ authorization: `Bearer ${attackerKey}` });
/** The admin secret behind apiGate also needs SOME valid key (apiGate admits any key). */
const asAdmin = () => ({ ...asAttacker(), "x-admin-key": ADMIN_SECRET });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

/** The policy column holds a value that parses fine but is not usable (astra pack 150). */
const UNREADABLE = "{not json";

/** Register a kernel as OWNER through the real write path. */
async function ownedKernel(prefix: string): Promise<string> {
  const id = uid(prefix);
  const res = await app.inject({
    method: "POST",
    url: "/api/kernels",
    headers: asOwner(),
    payload: { id, name: `Consume ${id}` },
  });
  expect(res.statusCode, res.body).toBe(201);
  return id;
}

/** Insert a pending_approvals row directly at a given status. */
function insertApproval(kernelId: string, status: string): string {
  const id = uid("consume-approval");
  const now = new Date().toISOString();
  getStore().db.insert(pendingApprovals).values({
    id,
    kernelId,
    jobId: uid("consume-job"),
    submittedBy: "agent-consume",
    jobSummary: { capabilityType: "liquid-handler", parameters: {} },
    status,
    createdAt: now,
    decidedAt: status === "pending" ? null : now,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  }).run();
  return id;
}

function approvalStatus(id: string): string | undefined {
  return getStore().db.select().from(pendingApprovals).where(eq(pendingApprovals.id, id)).get()?.status;
}

function consume(id: string, headers: Record<string, string>, on = app) {
  return on.inject({ method: "POST", url: `/api/operator/approvals/${id}/consume`, headers });
}

/** Overwrite the kernel's stored policy with garbage: the row exists but cannot be parsed. */
function makeUnreadable(kernelId: string): void {
  getStore().db.run(
    sql`INSERT OR REPLACE INTO operator_policies (kernel_id, policy, updated_at, updated_by)
        VALUES (${kernelId}, ${UNREADABLE}, ${new Date().toISOString()}, ${"test"})`,
  );
}

/** Overwrite the kernel's stored policy with a bare JSON array: parses fine, unusable shape. */
function makeArrayPolicy(kernelId: string): void {
  getStore().db.run(
    sql`INSERT OR REPLACE INTO operator_policies (kernel_id, policy, updated_at, updated_by)
        VALUES (${kernelId}, ${"[]"}, ${new Date().toISOString()}, ${"test"})`,
  );
}

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN_SECRET;
  initStore({ seed: false });
  ownerKey = provisionApiKey({ operatorId: OWNER, scopes: ["operator"] }).rawKey;
  attackerKey = provisionApiKey({ operatorId: ATTACKER, scopes: ["operator"] }).rawKey;

  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(kernelRoutes);
  await app.register(operatorRoutes);
  await app.ready();

  bareApp = Fastify({ logger: false });
  await bareApp.register(operatorRoutes);
  await bareApp.ready();
});

afterAll(async () => {
  await app.close();
  await bareApp.close();
  closeStore();
  if (savedAdminKey === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = savedAdminKey;
});

describe("POST /api/operator/approvals/:id/consume", () => {
  it("[repro] the OWNER consumes an approved job exactly once: 200, then 409 on the second try", async () => {
    const kernelId = await ownedKernel("consume-twice");
    const approvalId = insertApproval(kernelId, "approved");

    const first = await consume(approvalId, asOwner());
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ consumed: true, approvalId });
    expect(approvalStatus(approvalId)).toBe("consumed");

    const second = await consume(approvalId, asOwner());
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json()).toEqual({ error: "approval_not_consumable", status: "consumed" });
    expect(approvalStatus(approvalId)).toBe("consumed");
  });

  it.each(["pending", "rejected"])(
    "[repro] a '%s' approval is not consumable: 409 approval_not_consumable, status unchanged",
    async (status) => {
      const kernelId = await ownedKernel(`consume-${status}`);
      const approvalId = insertApproval(kernelId, status);
      const res = await consume(approvalId, asOwner());
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toEqual({ error: "approval_not_consumable", status });
      expect(approvalStatus(approvalId)).toBe(status);
    },
  );

  it("[repro] NO actor at the handler (apiGate absent) -> 401, nothing consumed", async () => {
    const kernelId = await ownedKernel("consume-noactor");
    const approvalId = insertApproval(kernelId, "approved");
    const res = await consume(approvalId, {}, bareApp);
    expect(res.statusCode).toBe(401);
    expect(approvalStatus(approvalId)).toBe("approved");
  });

  it("[repro] an unknown approval id is 404", async () => {
    const res = await consume(uid("consume-ghost"), asOwner());
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error).toBe("approval_not_found");
  });

  it("[repro] a NON-owner cannot consume: 403 not_kernel_owner, approval stays approved", async () => {
    const kernelId = await ownedKernel("consume-attacker-victim");
    const approvalId = insertApproval(kernelId, "approved");
    const res = await consume(approvalId, asAttacker());
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("not_kernel_owner");
    expect(approvalStatus(approvalId)).toBe("approved");
  });

  it("[repro] the admin secret can consume someone else's approval", async () => {
    const kernelId = await ownedKernel("consume-admin");
    const approvalId = insertApproval(kernelId, "approved");
    const res = await consume(approvalId, asAdmin());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ consumed: true, approvalId });
    expect(approvalStatus(approvalId)).toBe("consumed");
  });

  it("[repro] an e-stopped kernel refuses consume: 409 kernel_emergency_stopped, approval still 'approved'", async () => {
    const kernelId = await ownedKernel("consume-estop");
    const approvalId = insertApproval(kernelId, "approved");
    const stop = await app.inject({
      method: "POST",
      url: "/api/operator/emergency-stop",
      headers: asOwner(),
      payload: { kernelId, reason: "consume test" },
    });
    expect(stop.statusCode, stop.body).toBe(200);

    const res = await consume(approvalId, asOwner());
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("kernel_emergency_stopped");
    expect(approvalStatus(approvalId)).toBe("approved");
  });

  it("[repro] an unparseable policy row: 503 policy_unavailable, nothing consumed", async () => {
    const kernelId = await ownedKernel("consume-unreadable");
    const approvalId = insertApproval(kernelId, "approved");
    makeUnreadable(kernelId);
    const res = await consume(approvalId, asOwner());
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error).toBe("policy_unavailable");
    expect(approvalStatus(approvalId)).toBe("approved");
  });

  it("[repro] a bare-array policy row: 503 policy_unavailable, nothing consumed", async () => {
    const kernelId = await ownedKernel("consume-array-policy");
    const approvalId = insertApproval(kernelId, "approved");
    makeArrayPolicy(kernelId);
    const res = await consume(approvalId, asOwner());
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error).toBe("policy_unavailable");
    expect(approvalStatus(approvalId)).toBe("approved");
  });

  it("[repro] concurrency: two consumes of the same approval at once -- exactly one 200, the other 409", async () => {
    const kernelId = await ownedKernel("consume-race");
    const approvalId = insertApproval(kernelId, "approved");

    const [a, b] = await Promise.all([consume(approvalId, asOwner()), consume(approvalId, asOwner())]);
    const codes = [a.statusCode, b.statusCode].sort((x, y) => x - y);
    expect(codes, `${a.body} / ${b.body}`).toEqual([200, 409]);
    const winner = a.statusCode === 200 ? a : b;
    const loser = a.statusCode === 200 ? b : a;
    expect(winner.json()).toEqual({ consumed: true, approvalId });
    expect(loser.json()).toEqual({ error: "approval_not_consumable", status: "consumed" });
    expect(approvalStatus(approvalId)).toBe("consumed");
  });

  it("[repro] the approved listing never returns a consumed row", async () => {
    const kernelId = await ownedKernel("consume-listing");
    const approvalId = insertApproval(kernelId, "approved");
    const before = await app.inject({
      method: "GET",
      url: `/api/operator/approvals?status=approved&kernelId=${kernelId}`,
      headers: asOwner(),
    });
    expect(before.json().approvals.map((a: { id: string }) => a.id)).toContain(approvalId);

    const consumed = await consume(approvalId, asOwner());
    expect(consumed.statusCode, consumed.body).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: `/api/operator/approvals?status=approved&kernelId=${kernelId}`,
      headers: asOwner(),
    });
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().approvals.map((a: { id: string }) => a.id)).not.toContain(approvalId);
  });

  it("control: a freshly approved job, with no e-stop and a readable default policy, is consumable", async () => {
    const kernelId = await ownedKernel("consume-control");
    const approvalId = insertApproval(kernelId, "approved");
    const res = await consume(approvalId, asOwner());
    expect(res.statusCode, res.body).toBe(200);
  });
});
