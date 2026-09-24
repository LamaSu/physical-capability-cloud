/**
 * WP-C / N31 (operator-ux #2348, steward #2450): the operator control surface
 * is OWNER-ONLY. Setting or clearing a kernel's emergency stop, writing its
 * policy (which carries `emergencyStop`), and deciding its pending approvals
 * require a PRESENT actor who is the kernel's recorded operator. Unknown
 * kernel -> 404. Non-owner -> 403, with the e-stop state and approvals unchanged.
 *
 * Driven over HTTP through the REAL apiGate and real API keys. The file imports
 * only modules that exist on the pre-change code, so it runs unchanged there to
 * prove polarity (every [neg] case fails on the base).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { schema, eq } from "@pcc/store";
import { apiGate } from "../middleware/api-gate.js";
import { kernelRoutes } from "../routes/kernels.js";
import { operatorRoutes } from "../routes/operator.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";

const { operatorPolicies, pendingApprovals } = schema;

let app: FastifyInstance;
/** Same routes with NO apiGate: the handlers must refuse on their own. */
let bareApp: FastifyInstance;
let ownerKey: string;
let attackerKey: string;
const OWNER = "n31-operator-owner";
const ATTACKER = "n31-operator-attacker";
const ZERO = "0x0000000000000000000000000000000000000000";

const asOwner = () => ({ authorization: `Bearer ${ownerKey}` });
const asAttacker = () => ({ authorization: `Bearer ${attackerKey}` });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

/** Register a kernel as OWNER through the real write path. */
async function ownedKernel(prefix: string): Promise<string> {
  const id = uid(prefix);
  const res = await app.inject({
    method: "POST",
    url: "/api/kernels",
    headers: asOwner(),
    payload: { id, name: `N31 ${id}` },
  });
  expect(res.statusCode).toBe(201);
  expect(getRepos().kernels.findById(id)?.operatorAddress).toBe(OWNER);
  return id;
}

/** A legacy row whose owner is the unowned zero-address placeholder. */
function placeholderKernel(prefix: string): string {
  const id = uid(prefix);
  getRepos().kernels.insert({
    id,
    name: `Legacy ${id}`,
    operatorAddress: ZERO,
    location: { lat: 0, lng: 0 },
    physicalAddress: "",
    maxAssuranceTier: 0,
    publicKey: `0x${"00".repeat(32)}`,
    reputation: 0,
    totalJobsCompleted: 0,
    status: "online",
    registeredAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    version: "0.1.0",
  } as never);
  return id;
}

function policyRow(kernelId: string) {
  return getStore().db.select().from(operatorPolicies).where(eq(operatorPolicies.kernelId, kernelId)).get();
}

function eStopOf(kernelId: string): boolean | undefined {
  return (policyRow(kernelId)?.policy as { emergencyStop?: boolean } | undefined)?.emergencyStop;
}

function insertApproval(kernelId: string): string {
  const id = uid("n31-approval");
  const now = new Date().toISOString();
  getStore().db.insert(pendingApprovals).values({
    id,
    kernelId,
    jobId: uid("n31-job"),
    submittedBy: "agent-n31",
    jobSummary: { capabilityType: "liquid-handler", parameters: {} },
    status: "pending",
    createdAt: now,
    decidedAt: null,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  }).run();
  return id;
}

function approvalStatus(id: string): string | undefined {
  return getStore().db.select().from(pendingApprovals).where(eq(pendingApprovals.id, id)).get()?.status;
}

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
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
});

// ── Emergency stop / resume ─────────────────────────────────────────────────

describe("N31 emergency stop / resume: owner-only", () => {
  it("[neg] a NON-owner cannot stop someone else's kernel: 403, no policy written, approvals untouched", async () => {
    const kernelId = await ownedKernel("n31-stop-victim");
    const approvalId = insertApproval(kernelId);
    const res = await app.inject({
      method: "POST",
      url: "/api/operator/emergency-stop",
      headers: asAttacker(),
      payload: { kernelId, reason: "hostile" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_kernel_owner");
    expect(policyRow(kernelId)).toBeFalsy();
    expect(approvalStatus(approvalId)).toBe("pending");
  });

  it("[neg] a NON-owner cannot clear the owner's e-stop: 403, the kernel stays stopped", async () => {
    const kernelId = await ownedKernel("n31-resume-victim");
    const stop = await app.inject({
      method: "POST",
      url: "/api/operator/emergency-stop",
      headers: asOwner(),
      payload: { kernelId, reason: "maintenance" },
    });
    expect(stop.statusCode).toBe(200);
    expect(eStopOf(kernelId)).toBe(true);

    const res = await app.inject({
      method: "POST",
      url: "/api/operator/emergency-resume",
      headers: asAttacker(),
      payload: { kernelId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_kernel_owner");
    expect(eStopOf(kernelId)).toBe(true);
  });

  it("[neg] an UNKNOWN kernel -> 404 kernel_not_found for stop and resume, nothing written", async () => {
    const kernelId = uid("n31-ghost");
    for (const url of ["/api/operator/emergency-stop", "/api/operator/emergency-resume"]) {
      const res = await app.inject({ method: "POST", url, headers: asOwner(), payload: { kernelId } });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("kernel_not_found");
    }
    expect(policyRow(kernelId)).toBeFalsy();
  });

  it("[neg] a legacy UNOWNED placeholder kernel cannot be stopped by anyone: 403", async () => {
    const kernelId = placeholderKernel("n31-legacy");
    const res = await app.inject({
      method: "POST",
      url: "/api/operator/emergency-stop",
      headers: asOwner(),
      payload: { kernelId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_kernel_owner");
    expect(policyRow(kernelId)).toBeFalsy();
  });

  it("[neg] NO actor at the handler (apiGate absent) -> 401 for stop and resume, nothing written", async () => {
    const kernelId = await ownedKernel("n31-noactor");
    const stop = await bareApp.inject({
      method: "POST",
      url: "/api/operator/emergency-stop",
      payload: { kernelId },
    });
    expect(stop.statusCode).toBe(401);
    expect(policyRow(kernelId)).toBeFalsy();

    // Owner stops it; an anonymous resume must not clear it.
    expect(
      (await app.inject({ method: "POST", url: "/api/operator/emergency-stop", headers: asOwner(), payload: { kernelId } }))
        .statusCode,
    ).toBe(200);
    const resume = await bareApp.inject({
      method: "POST",
      url: "/api/operator/emergency-resume",
      payload: { kernelId },
    });
    expect(resume.statusCode).toBe(401);
    expect(eStopOf(kernelId)).toBe(true);
  });

  it("the OWNER can stop (pending approvals rejected) and resume (positive control)", async () => {
    const kernelId = await ownedKernel("n31-owner");
    const approvalId = insertApproval(kernelId);
    const stop = await app.inject({
      method: "POST",
      url: "/api/operator/emergency-stop",
      headers: asOwner(),
      payload: { kernelId, reason: "drill" },
    });
    expect(stop.statusCode).toBe(200);
    expect(stop.json().stopped).toBe(true);
    expect(eStopOf(kernelId)).toBe(true);
    expect(approvalStatus(approvalId)).toBe("rejected");

    const resume = await app.inject({
      method: "POST",
      url: "/api/operator/emergency-resume",
      headers: asOwner(),
      payload: { kernelId },
    });
    expect(resume.statusCode).toBe(200);
    expect(eStopOf(kernelId)).toBe(false);
  });

  it("a missing kernelId is still 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/operator/emergency-stop", headers: asOwner(), payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

// ── Policy writes carry emergencyStop: not a side door ──────────────────────

describe("N31 policy writes: owner-only (a policy carries emergencyStop)", () => {
  it("[neg] a NON-owner PATCH cannot clear the e-stop: 403, still stopped", async () => {
    const kernelId = await ownedKernel("n31-patch");
    expect(
      (await app.inject({ method: "POST", url: "/api/operator/emergency-stop", headers: asOwner(), payload: { kernelId } }))
        .statusCode,
    ).toBe(200);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/operator/policy/${kernelId}`,
      headers: asAttacker(),
      payload: { emergencyStop: false },
    });
    expect(res.statusCode).toBe(403);
    expect(eStopOf(kernelId)).toBe(true);
  });

  it("[neg] a NON-owner PUT cannot replace the policy: 403, still stopped", async () => {
    const kernelId = await ownedKernel("n31-put");
    expect(
      (await app.inject({ method: "POST", url: "/api/operator/emergency-stop", headers: asOwner(), payload: { kernelId } }))
        .statusCode,
    ).toBe(200);
    const res = await app.inject({
      method: "PUT",
      url: `/api/operator/policy/${kernelId}`,
      headers: asAttacker(),
      payload: { version: 1, emergencyStop: false },
    });
    expect(res.statusCode).toBe(403);
    expect(eStopOf(kernelId)).toBe(true);
  });

  it("the OWNER can PATCH its own policy (positive control)", async () => {
    const kernelId = await ownedKernel("n31-patch-owner");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/operator/policy/${kernelId}`,
      headers: asOwner(),
      payload: { requireAnchor: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().policy.requireAnchor).toBe(true);
  });
});

// ── Approvals approve / reject ──────────────────────────────────────────────

describe("N31 approvals approve / reject: owner-only", () => {
  it("[neg] a NON-owner cannot approve or reject: 403, the approval stays pending", async () => {
    const kernelId = await ownedKernel("n31-appr");
    const approvalId = insertApproval(kernelId);
    for (const action of ["approve", "reject"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/operator/approvals/${approvalId}/${action}`,
        headers: asAttacker(),
        payload: { reason: "hostile" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("not_kernel_owner");
    }
    expect(approvalStatus(approvalId)).toBe("pending");
  });

  it("[neg] an approval whose kernel does not exist -> 404 kernel_not_found, stays pending", async () => {
    const approvalId = insertApproval(uid("n31-appr-ghost-kernel"));
    const res = await app.inject({
      method: "POST",
      url: `/api/operator/approvals/${approvalId}/approve`,
      headers: asOwner(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("kernel_not_found");
    expect(approvalStatus(approvalId)).toBe("pending");
  });

  it("[neg] NO actor at the handler (apiGate absent) -> 401, stays pending", async () => {
    const kernelId = await ownedKernel("n31-appr-noactor");
    const approvalId = insertApproval(kernelId);
    const res = await bareApp.inject({ method: "POST", url: `/api/operator/approvals/${approvalId}/approve` });
    expect(res.statusCode).toBe(401);
    expect(approvalStatus(approvalId)).toBe("pending");
  });

  it("the OWNER can approve one and reject another (positive control)", async () => {
    const kernelId = await ownedKernel("n31-appr-owner");
    const a = insertApproval(kernelId);
    const b = insertApproval(kernelId);
    const ok = await app.inject({ method: "POST", url: `/api/operator/approvals/${a}/approve`, headers: asOwner() });
    expect(ok.statusCode).toBe(200);
    expect(approvalStatus(a)).toBe("approved");
    const no = await app.inject({
      method: "POST",
      url: `/api/operator/approvals/${b}/reject`,
      headers: asOwner(),
      payload: { reason: "not today" },
    });
    expect(no.statusCode).toBe(200);
    expect(approvalStatus(b)).toBe("rejected");
  });

  it("an unknown approval id is still 404", async () => {
    const res = await app.inject({ method: "POST", url: "/api/operator/approvals/no-such-approval/approve", headers: asOwner() });
    expect(res.statusCode).toBe(404);
  });
});

// ── WP-C R2: approval SUBMISSION is not a side door ────────────────────────
// Review round 2 (HIGH, probe P2): POST /api/operator/approvals took
// `autoApprove: true` from the body and created an ALREADY-APPROVED job for any
// kernel, from any key, with `submittedBy` copied from the body.
// scripts/ot2-agent.py polls `status=approved&kernelId=K` and runs those jobs.

describe("R2 approval submission and listing: no side door", () => {
  async function submit(headers: Record<string, string>, body: Record<string, unknown>, on = app) {
    return on.inject({ method: "POST", url: "/api/operator/approvals", headers, payload: body });
  }

  function approvalsFor(kernelId: string) {
    return getStore().db.select().from(pendingApprovals).where(eq(pendingApprovals.kernelId, kernelId)).all();
  }

  it("[neg] P2: a NON-owner's {autoApprove:true} creates only a PENDING approval, submitted as the authenticated actor; the OT-2 poll never sees it", async () => {
    const kernelId = await ownedKernel("r2-p2-victim");
    const res = await submit(asAttacker(), {
      kernelId,
      agentId: "attacker-agent",
      autoApprove: true,
      capabilityType: "liquid-handler",
      parameters: { task: "attacker-chosen protocol" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().approval.status).toBe("pending");
    expect(res.json().approval.submittedBy).toBe(ATTACKER);

    // Exactly the query scripts/ot2-agent.py polls before running a job.
    const poll = await app.inject({
      method: "GET",
      url: `/api/operator/approvals?status=approved&kernelId=${kernelId}`,
      headers: asOwner(),
    });
    expect(poll.statusCode).toBe(200);
    expect(poll.json().approvals).toEqual([]);
  });

  it("[neg] a NON-owner creates only 'pending' even when the owner's policy is approvalMode 'auto'", async () => {
    const kernelId = await ownedKernel("r2-auto-victim");
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/operator/policy/${kernelId}`,
      headers: asOwner(),
      payload: { approvalMode: "auto" },
    });
    expect(patch.statusCode).toBe(200);
    const res = await submit(asAttacker(), { kernelId, agentId: "a", autoApprove: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().approval.status).toBe("pending");
  });

  it("[neg] the OWNER's body autoApprove is ignored too: under the default 'manual' policy the job is pending", async () => {
    const kernelId = await ownedKernel("r2-owner-manual");
    const res = await submit(asOwner(), { kernelId, agentId: "mine", autoApprove: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().approval.status).toBe("pending");
    expect(res.json().approval.submittedBy).toBe(OWNER);
  });

  it("the OWNER under its own approvalMode 'auto' policy gets an approved job (derived from policy, not the body)", async () => {
    const kernelId = await ownedKernel("r2-owner-auto");
    await app.inject({
      method: "PATCH",
      url: `/api/operator/policy/${kernelId}`,
      headers: asOwner(),
      payload: { approvalMode: "auto" },
    });
    const res = await submit(asOwner(), { kernelId });
    expect(res.statusCode).toBe(200);
    expect(res.json().approval.status).toBe("approved");
    expect(res.json().approval.decidedAt).toBeTruthy();
  });

  it("[neg] an e-stopped kernel refuses new approvals: 503, nothing stored (owner and non-owner)", async () => {
    const kernelId = await ownedKernel("r2-estop");
    const stop = await app.inject({
      method: "POST",
      url: "/api/operator/emergency-stop",
      headers: asOwner(),
      payload: { kernelId, reason: "maintenance" },
    });
    expect(stop.statusCode).toBe(200);
    for (const headers of [asAttacker(), asOwner()]) {
      const res = await submit(headers, { kernelId, agentId: "x", autoApprove: true });
      expect(res.statusCode).toBe(503);
    }
    expect(approvalsFor(kernelId)).toEqual([]);
  });

  it("[neg] an UNKNOWN kernel -> 404 kernel_not_found, nothing stored", async () => {
    const kernelId = uid("r2-ghost");
    const res = await submit(asAttacker(), { kernelId, agentId: "x", autoApprove: true });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("kernel_not_found");
    expect(approvalsFor(kernelId)).toEqual([]);
  });

  it("[neg] NO actor at the handler (apiGate absent) -> 401 for submit and list, nothing stored", async () => {
    const kernelId = await ownedKernel("r2-noactor");
    const res = await submit({}, { kernelId, agentId: "x", autoApprove: true }, bareApp);
    expect(res.statusCode).toBe(401);
    expect(approvalsFor(kernelId)).toEqual([]);
    const list = await bareApp.inject({ method: "GET", url: `/api/operator/approvals?kernelId=${kernelId}` });
    expect(list.statusCode).toBe(401);
  });

  it("[neg] GET /api/operator/approvals is owner-scoped: a non-owner gets 403 for the victim's kernel and never sees its rows", async () => {
    const kernelId = await ownedKernel("r2-list-victim");
    const approvalId = insertApproval(kernelId);

    const direct = await app.inject({
      method: "GET",
      url: `/api/operator/approvals?kernelId=${kernelId}`,
      headers: asAttacker(),
    });
    expect(direct.statusCode).toBe(403);
    expect(direct.json().error).toBe("not_kernel_owner");

    const all = await app.inject({ method: "GET", url: "/api/operator/approvals?status=pending", headers: asAttacker() });
    expect(all.statusCode).toBe(200);
    expect(all.json().approvals.map((a: { id: string }) => a.id)).not.toContain(approvalId);

    // The owner sees it, filtered or not (positive control).
    const mine = await app.inject({ method: "GET", url: "/api/operator/approvals?status=pending", headers: asOwner() });
    expect(mine.json().approvals.map((a: { id: string }) => a.id)).toContain(approvalId);
    const byKernel = await app.inject({
      method: "GET",
      url: `/api/operator/approvals?kernelId=${kernelId}`,
      headers: asOwner(),
    });
    expect(byKernel.statusCode).toBe(200);
    expect(byKernel.json().approvals.map((a: { id: string }) => a.id)).toContain(approvalId);
  });
});
