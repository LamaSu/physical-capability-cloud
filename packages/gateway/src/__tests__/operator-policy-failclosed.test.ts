/**
 * Operator policy reads fail closed (adk #4446).
 *
 * A read of a kernel's operator policy has three outcomes and only two of them
 * may produce a policy:
 *
 *   - a stored row   -> that policy;
 *   - no row         -> DEFAULT_OPERATOR_POLICY, marked `source: "default"`;
 *   - the read FAILS -> no policy at all. A store error is not "no row": the
 *                       caller (a node, a runtime, the dashboard) must never be
 *                       able to read it as the default, which has
 *                       `emergencyStop: false`.
 *
 * GET /api/operator/policy/:kernelId used to answer 200 with the default policy
 * when the store threw. It now answers 503 `policy_unavailable`.
 *
 * The same rule is checked at every other server-side read of the policy:
 *   - routes that gate on it must refuse when the read fails (503 or an error
 *     status), never proceed on the default;
 *   - routes that read-modify-write it must not write a default over a stored
 *     policy that could not be read.
 * POST /api/jobs/submit read the policy for its capture-verification gate and
 * continued without it on a read error; that is now a 503 too.
 *
 * Three ways of making the read fail are used, so that the answer does not
 * depend on where it breaks:
 *   - getStore() throws (the store cannot be opened);
 *   - the policy query throws (the table cannot be read: a real SQLite error);
 *   - the stored row cannot be parsed (the JSON column holds garbage).
 *
 * Driven over HTTP through the REAL apiGate and real API keys where the route
 * is owner-guarded. Authorization runs on the kernel row (repos), not on the
 * policy table, so an unauthorized caller is refused before the read ever runs.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DEFAULT_OPERATOR_POLICY } from "@pcc/spec";
import { schema, sql } from "@pcc/store";
import { apiGate } from "../middleware/api-gate.js";
import { kernelRoutes } from "../routes/kernels.js";
import { operatorRoutes } from "../routes/operator.js";
import { kernelAgentPackageRoutes } from "../routes/kernel-agent-package.js";
import { jobSubmitRoutes } from "../routes/job-submit.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { createPccQuote } from "../routes/a2a-tasks.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import * as dbModule from "../db.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";

const { pendingApprovals, negotiationSessions, jobs } = schema;

const OWNER = "policy-failclosed-owner@x.test";
const STRANGER = "policy-failclosed-stranger@x.test";
const ADMIN_SECRET = "policy-failclosed-admin-secret";
const savedAdminKey = process.env.PCC_ADMIN_KEY;
const savedMockSettlement = process.env.MOCK_SETTLEMENT;

/** apiGate in front: the production shape (owner-guarded routes). */
let app: FastifyInstance;
/** No apiGate: routes that carry no identity of their own. */
let jobSubmitApp: FastifyInstance;
let negotiationApp: FastifyInstance;
let paidJobApp: FastifyInstance;
let ownerKey = "";
let strangerKey = "";
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

const asOwner = () => ({ authorization: `Bearer ${ownerKey}` });
const asStranger = () => ({ authorization: `Bearer ${strangerKey}` });
/** The admin secret behind apiGate also needs SOME valid key (apiGate admits any key). */
const asAdmin = () => ({ ...asStranger(), "x-admin-key": ADMIN_SECRET });

/** What an unreadable stored policy looks like: the JSON column holds garbage. */
const UNREADABLE = "{not json";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Register a kernel as OWNER through the real write path, with one fdm capability. */
async function ownedKernel(prefix: string): Promise<string> {
  const id = uid(prefix);
  const res = await app.inject({
    method: "POST",
    url: "/api/kernels",
    headers: asOwner(),
    payload: { id, name: `Policy ${id}` },
  });
  expect(res.statusCode, res.body).toBe(201);
  expect(getRepos().kernels.findById(id)?.operatorAddress).toBe(OWNER);
  getRepos().capabilities.insert({
    id: `cap-${id}-fdm`,
    kernelId: id,
    type: "fdm",
    name: "FDM",
    materials: ["PLA"],
    assuranceTiers: [0],
    pricing: { currency: "USDC", baseCost: "10", minimum: "5" },
    availability: {},
    location: { lat: 0, lng: 0 },
  } as never);
  return id;
}

/** The owner stores a policy through the real write path. */
async function putPolicy(kernelId: string, policy: Record<string, unknown>): Promise<void> {
  const res = await app.inject({
    method: "PUT",
    url: `/api/operator/policy/${kernelId}`,
    headers: asOwner(),
    payload: { version: 1, ...policy },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Overwrite the stored policy with garbage: the row exists but cannot be read. */
function makeUnreadable(kernelId: string): void {
  getStore().db.run(
    sql`INSERT OR REPLACE INTO operator_policies (kernel_id, policy, updated_at, updated_by)
        VALUES (${kernelId}, ${UNREADABLE}, ${new Date().toISOString()}, ${"test"})`,
  );
}

/** The raw policy column, bypassing the JSON parse (so garbage can be read back). */
function rawPolicy(kernelId: string): string | undefined {
  return getStore().db.get<{ policy: string }>(
    sql`SELECT policy FROM operator_policies WHERE kernel_id = ${kernelId}`,
  )?.policy;
}

/** getStore() throws for the duration of `fn`. Nothing else may use the store inside `fn`. */
async function whileStoreThrows<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(dbModule, "getStore").mockImplementation(() => {
    throw new Error("store unavailable");
  });
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

/** The policy table cannot be queried for the duration of `fn` (a real SQLite error). */
async function whileTableUnavailable<T>(fn: () => Promise<T>): Promise<T> {
  const { db } = getStore();
  db.run(sql`ALTER TABLE operator_policies RENAME TO operator_policies_unavailable`);
  try {
    return await fn();
  } finally {
    db.run(sql`ALTER TABLE operator_policies_unavailable RENAME TO operator_policies`);
  }
}

function approvalsFor(kernelId: string): number {
  return getStore().db.select().from(pendingApprovals).all().filter((a) => a.kernelId === kernelId).length;
}
function sessionsFor(kernelId: string): Array<typeof negotiationSessions.$inferSelect> {
  return getStore().db.select().from(negotiationSessions).all().filter((s) => s.kernelId === kernelId);
}
function jobsFor(kernelId: string): number {
  return getStore().db.select().from(jobs).all().filter((j) => j.kernelId === kernelId).length;
}

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN_SECRET;
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: false });
  ownerKey = provisionApiKey({ operatorId: OWNER, scopes: ["operator"] }).rawKey;
  strangerKey = provisionApiKey({ operatorId: STRANGER, scopes: ["operator"] }).rawKey;

  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(kernelRoutes);
  await app.register(operatorRoutes);
  await app.register(kernelAgentPackageRoutes);
  await app.ready();

  jobSubmitApp = Fastify({ logger: false });
  await jobSubmitApp.register(jobSubmitRoutes);
  await jobSubmitApp.ready();

  negotiationApp = Fastify({ logger: false });
  await negotiationApp.register(negotiationRoutes);
  await negotiationApp.ready();

  paidJobApp = Fastify({ logger: false });
  await paidJobApp.register(paidJobFlowRoutes);
  await paidJobApp.ready();
});

afterAll(async () => {
  await app.close();
  await jobSubmitApp.close();
  await negotiationApp.close();
  await paidJobApp.close();
  closeStore();
  if (savedAdminKey === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = savedAdminKey;
  if (savedMockSettlement === undefined) delete process.env.MOCK_SETTLEMENT;
  else process.env.MOCK_SETTLEMENT = savedMockSettlement;
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/operator/policy/:kernelId
// ═════════════════════════════════════════════════════════════════════════════

/** Each way the policy read can fail, as "run `fn` while it does". */
const READ_FAILURES: Array<[string, (kernelId: string, fn: () => Promise<unknown>) => Promise<unknown>]> = [
  ["getStore() throws", (_k, fn) => whileStoreThrows(fn)],
  ["the policy query throws (table unavailable)", (_k, fn) => whileTableUnavailable(fn)],
  [
    "the stored row cannot be parsed",
    async (k, fn) => {
      makeUnreadable(k);
      return fn();
    },
  ],
];

describe("GET /api/operator/policy/:kernelId: a failed read is never a policy", () => {
  const read = (headers: Record<string, string>, kernelId: string) =>
    app.inject({ method: "GET", url: `/api/operator/policy/${kernelId}`, headers });

  describe.each(READ_FAILURES)("when %s", (_name, during) => {
    it("[repro] the OWNER gets 503 policy_unavailable, not the default policy", async () => {
      const kernelId = await ownedKernel("get-owner");
      let res!: Awaited<ReturnType<typeof read>>;
      await during(kernelId, async () => {
        res = await read(asOwner(), kernelId);
      });
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json()).toEqual({ error: "policy_unavailable" });
    });

    it("[repro] a kernel in e-stop never reads as clear: no policy, no emergencyStop field", async () => {
      const kernelId = await ownedKernel("get-estop");
      await putPolicy(kernelId, { approvalMode: "manual", emergencyStop: true });
      let res!: Awaited<ReturnType<typeof read>>;
      await during(kernelId, async () => {
        res = await read(asOwner(), kernelId);
      });
      expect(res.statusCode, res.body).not.toBe(200);
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain("emergencyStop");
      expect(res.json().policy).toBeUndefined();
      expect(res.json().source).toBeUndefined();
    });

    it("[repro] the ADMIN gets the same answer", async () => {
      const kernelId = await ownedKernel("get-admin");
      let res!: Awaited<ReturnType<typeof read>>;
      await during(kernelId, async () => {
        res = await read(asAdmin(), kernelId);
      });
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json()).toEqual({ error: "policy_unavailable" });
    });
  });

  it("a non-owner is still refused 403 before the read runs, even while the store is down", async () => {
    const kernelId = await ownedKernel("get-stranger");
    let res!: Awaited<ReturnType<typeof read>>;
    await whileTableUnavailable(async () => {
      res = await read(asStranger(), kernelId);
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("not_kernel_owner");
  });

  it("an unknown kernel is still 404 while the store is down (authorization is unchanged)", async () => {
    let res!: Awaited<ReturnType<typeof read>>;
    await whileTableUnavailable(async () => {
      res = await read(asOwner(), "kernel-does-not-exist");
    });
    expect(res.statusCode, res.body).toBe(404);
  });

  it("control: no stored row is the default policy, marked source 'default'", async () => {
    const kernelId = await ownedKernel("get-norow");
    const res = await read(asOwner(), kernelId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().source).toBe("default");
    expect(res.json().policy).toEqual(JSON.parse(JSON.stringify(DEFAULT_OPERATOR_POLICY)));
    expect(res.json().policy.emergencyStop).toBe(false);
  });

  it("control: a stored row is returned as stored, with its e-stop, and is not marked default", async () => {
    const kernelId = await ownedKernel("get-stored");
    await putPolicy(kernelId, { approvalMode: "manual", emergencyStop: true });
    const res = await read(asOwner(), kernelId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().policy.emergencyStop).toBe(true);
    expect(res.json().policy.approvalMode).toBe("manual");
    expect(res.json().source).not.toBe("default");
    expect(res.json().updatedAt).toBeTruthy();
  });

  it("[repro] the failure is not remembered: 503 while the store is down, the stored policy once it is back", async () => {
    const kernelId = await ownedKernel("get-recover");
    await putPolicy(kernelId, { approvalMode: "manual", emergencyStop: true });
    const during503 = await whileTableUnavailable(() => read(asOwner(), kernelId));
    expect(during503.statusCode).toBe(503);
    const after = await read(asOwner(), kernelId);
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().policy.emergencyStop).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The other reads of the policy in routes/operator.ts
// ═════════════════════════════════════════════════════════════════════════════

describe("operator.ts: read-modify-write routes never write a default over an unreadable policy", () => {
  it("PATCH policy: a read error is a 500 and the stored policy is left as it was", async () => {
    const kernelId = await ownedKernel("patch");
    makeUnreadable(kernelId);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/operator/policy/${kernelId}`,
      headers: asOwner(),
      payload: { approvalMode: "auto" },
    });
    expect(res.statusCode, res.body).toBe(500);
    expect(rawPolicy(kernelId)).toBe(UNREADABLE);
  });

  it("emergency-stop: a read error is a 500, the stored policy is untouched and pending approvals stay pending", async () => {
    const kernelId = await ownedKernel("estop-activate");
    const submitted = await app.inject({
      method: "POST",
      url: "/api/operator/approvals",
      headers: asOwner(),
      payload: { kernelId, capabilityType: "liquid-handler" },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    makeUnreadable(kernelId);
    const res = await app.inject({
      method: "POST",
      url: "/api/operator/emergency-stop",
      headers: asOwner(),
      payload: { kernelId, reason: "test" },
    });
    expect(res.statusCode, res.body).toBe(500);
    expect(rawPolicy(kernelId)).toBe(UNREADABLE);
    const rows = getStore().db.select().from(pendingApprovals).all().filter((a) => a.kernelId === kernelId);
    expect(rows.map((a) => a.status)).toEqual(["pending"]);
  });

  it("emergency-resume: a read error is a 500 and nothing is cleared", async () => {
    const kernelId = await ownedKernel("estop-resume");
    makeUnreadable(kernelId);
    const res = await app.inject({
      method: "POST",
      url: "/api/operator/emergency-resume",
      headers: asOwner(),
      payload: { kernelId },
    });
    expect(res.statusCode, res.body).toBe(500);
    expect(rawPolicy(kernelId)).toBe(UNREADABLE);
  });
});

describe("operator.ts: POST /api/operator/approvals does not decide on a default when the policy cannot be read", () => {
  it("refuses (not 2xx) and stores no approval, for the owner and for anyone else", async () => {
    const kernelId = await ownedKernel("approvals");
    await putPolicy(kernelId, { approvalMode: "auto", emergencyStop: true });
    makeUnreadable(kernelId);
    for (const headers of [asOwner(), asStranger()]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/approvals",
        headers,
        payload: { kernelId, capabilityType: "liquid-handler" },
      });
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(500);
    }
    expect(approvalsFor(kernelId)).toBe(0);
  });

  it("control: with no stored row a manual-approval default applies and the approval is stored pending", async () => {
    const kernelId = await ownedKernel("approvals-norow");
    const res = await app.inject({
      method: "POST",
      url: "/api/operator/approvals",
      headers: asOwner(),
      payload: { kernelId, capabilityType: "liquid-handler" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().approval.status).toBe("pending");
    expect(approvalsFor(kernelId)).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/jobs/submit: the capture-verification gate reads the policy
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/jobs/submit: a policy that cannot be read refuses the job", () => {
  const submit = (kernelId: string, extra: Record<string, unknown> = {}) =>
    jobSubmitApp.inject({
      method: "POST",
      url: "/api/jobs/submit",
      payload: { kernelId, stepId: uid("step"), capabilityId: `cap-${kernelId}-fdm`, ...extra },
    });

  it("control: the gate works while the store is up (a policy that needs a capture verdict refuses a job without one)", async () => {
    const kernelId = await ownedKernel("submit-gate");
    await putPolicy(kernelId, { minCaptureClass: "CC3" });
    const res = await submit(kernelId);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("capture_verdict_required");
    expect(jobsFor(kernelId)).toBe(0);
  });

  it("[repro] a policy that needs a capture verdict, unreadable: 503 policy_unavailable, no job created", async () => {
    const kernelId = await ownedKernel("submit-down");
    await putPolicy(kernelId, { minCaptureClass: "CC3" });
    const res = await whileTableUnavailable(() => submit(kernelId));
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error).toBe("policy_unavailable");
    expect(jobsFor(kernelId)).toBe(0);
  });

  it("[repro] an unparseable stored row: 503 policy_unavailable, no job created", async () => {
    const kernelId = await ownedKernel("submit-garbage");
    makeUnreadable(kernelId);
    const res = await submit(kernelId);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error).toBe("policy_unavailable");
    expect(jobsFor(kernelId)).toBe(0);
  });

  it("control: no stored row is not an error; the job is accepted", async () => {
    const kernelId = await ownedKernel("submit-norow");
    const res = await submit(kernelId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe("queued");
    expect(jobsFor(kernelId)).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Negotiation, the fast-track flow and the A2A adapter: they read the policy
// for e-stop and pricing, and already refuse when the read fails
// ═════════════════════════════════════════════════════════════════════════════

describe("negotiation / fast-track / A2A: a policy that cannot be read creates no session", () => {
  it("POST /api/negotiate/session: refused (500), no session stored", async () => {
    const kernelId = await ownedKernel("neg-create");
    await putPolicy(kernelId, { approvalMode: "manual", emergencyStop: true });
    makeUnreadable(kernelId);
    const res = await negotiationApp.inject({
      method: "POST",
      url: "/api/negotiate/session",
      payload: { userAgentId: "agent-failclosed", kernelId, capabilityType: "fdm" },
    });
    expect(res.statusCode, res.body).toBe(500);
    expect(sessionsFor(kernelId)).toHaveLength(0);
  });

  it("POST /api/negotiate/session/:id/quote: refused (500), the session stays un-quoted", async () => {
    const kernelId = await ownedKernel("neg-quote");
    const created = await negotiationApp.inject({
      method: "POST",
      url: "/api/negotiate/session",
      payload: { userAgentId: "agent-failclosed", kernelId, capabilityType: "fdm" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const sessionId = created.json().session.id as string;
    makeUnreadable(kernelId);
    const res = await negotiationApp.inject({ method: "POST", url: `/api/negotiate/session/${sessionId}/quote` });
    expect(res.statusCode, res.body).toBe(500);
    const row = sessionsFor(kernelId).find((s) => s.id === sessionId);
    expect(row?.status).toBe("created");
    expect(row?.quote).toBeNull();
  });

  it("POST /api/jobs/submit-from-discovery: refused (500), no session stored", async () => {
    const kernelId = await ownedKernel("fast-track");
    await putPolicy(kernelId, { approvalMode: "manual", emergencyStop: true });
    makeUnreadable(kernelId);
    const res = await paidJobApp.inject({
      method: "POST",
      url: "/api/jobs/submit-from-discovery",
      payload: { kernelId, capabilityType: "fdm", userAgentId: "agent-failclosed" },
    });
    expect(res.statusCode, res.body).toBe(500);
    expect(sessionsFor(kernelId)).toHaveLength(0);
    expect(jobsFor(kernelId)).toBe(0);
  });

  it("A2A pcc-quote (createPccQuote): rejects, and the error is not an e-stop-clear quote; no session stored", async () => {
    const kernelId = await ownedKernel("a2a-quote");
    await putPolicy(kernelId, { approvalMode: "manual", emergencyStop: true });
    makeUnreadable(kernelId);
    await expect(
      createPccQuote({ userAgentId: "agent-failclosed", kernelId, capabilityType: "fdm" }),
    ).rejects.toThrow();
    expect(sessionsFor(kernelId)).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The per-kernel agent package reads the policy for its description and tool set
// ═════════════════════════════════════════════════════════════════════════════

describe("kernel-agent-package.ts: a policy that cannot be read is not described as the default", () => {
  it("GET /api/kernels/:id/agent-package: owner gets 500, never a package carrying a default operator_policy", async () => {
    const kernelId = await ownedKernel("pkg-get");
    await putPolicy(kernelId, { approvalMode: "manual", emergencyStop: true });
    makeUnreadable(kernelId);
    const res = await app.inject({
      method: "GET",
      url: `/api/kernels/${kernelId}/agent-package`,
      headers: asOwner(),
    });
    expect(res.statusCode, res.body).toBe(500);
    expect(res.body).not.toContain("operator_policy");
    expect(res.body).not.toContain("emergencyStop");
  });

  it("PUT /api/kernels/:id/agent-package/configure: a read error is a 500 and the stored policy is left as it was", async () => {
    const kernelId = await ownedKernel("pkg-configure");
    makeUnreadable(kernelId);
    const res = await app.inject({
      method: "PUT",
      url: `/api/kernels/${kernelId}/agent-package/configure`,
      headers: asOwner(),
      payload: { enabledTools: ["x"] },
    });
    expect(res.statusCode, res.body).toBe(500);
    expect(rawPolicy(kernelId)).toBe(UNREADABLE);
  });

  it("control: with no stored row the owner's package carries the default policy", async () => {
    const kernelId = await ownedKernel("pkg-norow");
    const res = await app.inject({
      method: "GET",
      url: `/api/kernels/${kernelId}/agent-package`,
      headers: asOwner(),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().operator_policy.emergencyStop).toBe(false);
  });
});
