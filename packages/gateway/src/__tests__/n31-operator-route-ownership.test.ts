/**
 * Board N31 (bus #6272; the steward's ruling #6278): routes/operator.ts changed ANY kernel's
 * emergency stop, policy and approvals for ANY authenticated caller. A stranger's key could
 * resume a kernel its operator had stopped, approve or reject that kernel's jobs, rewrite its
 * guardrails (PATCH {emergencyStop:false} is a resume by another name), or submit an
 * already-approved approval that the OT-2 executor then runs.
 *
 * The rule now, per route:
 *   - approve, reject, emergency-resume, PUT and PATCH of the policy, and an approval submitted
 *     with autoApprove: the gateway admin secret, or a wallet the caller PROVED that is the
 *     kernel's operator. WP-A (#326) sets req.provenWallet; nothing sets it before that merges,
 *     so until then only the admin decides. A key's claimed identity never decides: anyone can
 *     provision a key naming any wallet.
 *   - emergency-stop, and a PENDING approval: also the kernel's own claimed principal (the identity
 *     its operatorAddress records), so an operator never loses their own e-stop.
 *
 * Mounted as production mounts it: apiGate, then the routes, with the kernel registered by the
 * operator's own key through POST /api/kernels. The proven-wallet case is simulated by an
 * onRequest hook that sets req.provenWallet from a test header, the field WP-A will set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { schema, eq } from "@pcc/store";
import { apiGate } from "../middleware/api-gate.js";
import { kernelRoutes } from "../routes/kernels.js";
import { operatorRoutes } from "../routes/operator.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { initStore, closeStore, getStore } from "../db.js";

const PREV_DB = process.env.PCC_DB_PATH;
const PREV_ADMIN = process.env.PCC_ADMIN_KEY;
const ADMIN = "n31-admin-secret";
const OPERATOR = "0xA11cE00000000000000000000000000000000031";
const STRANGER = "0xBAD0000000000000000000000000000000000031";
const ZERO = "0x0000000000000000000000000000000000000000";
const KERNEL = "kernel-n31";
const LEGACY = "kernel-n31-unowned";

let app: FastifyInstance;
const keys = { operator: "", operatorLower: "", stranger: "", zero: "" };

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const asOperator = () => bearer(keys.operator);
const asStranger = () => bearer(keys.stranger);
const asAdmin = () => ({ ...bearer(keys.stranger), "x-admin-key": ADMIN });
/** WP-A's proven wallet, simulated: any key plus the wallet the caller proved. */
const asProvenOperator = () => ({ ...bearer(keys.stranger), "x-test-proven-wallet": OPERATOR });
const ANON = { "x-forwarded-for": "10.31.0.1" };

function policyRow(kernelId: string) {
  const { db } = getStore();
  return db.select().from(schema.operatorPolicies).where(eq(schema.operatorPolicies.kernelId, kernelId)).get();
}
function approvalRow(id: string) {
  const { db } = getStore();
  return db.select().from(schema.pendingApprovals).where(eq(schema.pendingApprovals.id, id)).get();
}
function approvalCount() {
  const { db } = getStore();
  return db.select().from(schema.pendingApprovals).all().length;
}

/** Leaves a STORED policy with the stop set or clear (a resume needs a stored policy: 404 without one). */
async function setStop(stopped: boolean) {
  const urls = stopped ? ["/api/operator/emergency-stop"] : ["/api/operator/emergency-stop", "/api/operator/emergency-resume"];
  for (const url of urls) {
    const res = await app.inject({ method: "POST", url, headers: asAdmin(), payload: { kernelId: KERNEL } });
    expect(res.statusCode, `admin ${url}`).toBe(200);
  }
  expect((policyRow(KERNEL)?.policy as { emergencyStop?: boolean }).emergencyStop).toBe(stopped);
}

async function pendingApproval(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/operator/approvals",
    headers: asAdmin(),
    payload: { kernelId: KERNEL, agentId: "agent-n31" },
  });
  expect(res.statusCode).toBe(200);
  const id = res.json().approval.id as string;
  expect(approvalRow(id)?.status).toBe("pending");
  return id;
}

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN;
  closeStore();
  initStore({ seed: true });
  app = Fastify({ logger: false });
  // WP-A's field, simulated. Root-level, so it runs before the gate and every route.
  app.addHook("onRequest", async (req) => {
    const proven = req.headers["x-test-proven-wallet"];
    if (typeof proven === "string") (req as unknown as { provenWallet: string }).provenWallet = proven;
  });
  await app.register(apiGate);
  await app.register(kernelRoutes);
  await app.register(operatorRoutes);
  await app.ready();

  keys.operator = provisionApiKey({ operatorId: OPERATOR, name: "n31-operator", scopes: ["*"] }).rawKey;
  keys.operatorLower = provisionApiKey({ operatorId: OPERATOR.toLowerCase(), name: "n31-operator-2", scopes: ["*"] }).rawKey;
  keys.stranger = provisionApiKey({ operatorId: STRANGER, name: "n31-stranger", scopes: ["*"] }).rawKey;
  keys.zero = provisionApiKey({ operatorId: ZERO, name: "n31-zero", scopes: ["*"] }).rawKey;

  // The operator's own key registers the kernel, so its operatorAddress is the operator's identity.
  const reg = await app.inject({
    method: "POST",
    url: "/api/kernels",
    headers: asOperator(),
    payload: { id: KERNEL, name: "N31 kernel", location: { lat: 40.7, lng: -74 }, physicalAddress: "1 N31 St" },
  });
  expect(reg.statusCode).toBe(201);
  const { db } = getStore();
  expect(db.select().from(schema.shopKernels).where(eq(schema.shopKernels.id, KERNEL)).get()?.operatorAddress).toBe(OPERATOR);
  // A legacy kernel whose operatorAddress is the historical zero placeholder: nobody owns it.
  const legacy = await app.inject({
    method: "POST",
    url: "/api/kernels",
    headers: asAdmin(),
    payload: { id: LEGACY, name: "N31 legacy", location: { lat: 1, lng: 1 }, physicalAddress: "x" },
  });
  expect(legacy.statusCode).toBe(201);
  db.update(schema.shopKernels).set({ operatorAddress: ZERO }).where(eq(schema.shopKernels.id, LEGACY)).run();
}, 60_000);

afterAll(async () => {
  await app.close();
  closeStore();
  if (PREV_DB === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = PREV_DB;
  if (PREV_ADMIN === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = PREV_ADMIN;
});

describe("N31 POST /api/operator/emergency-stop: the kernel's operator (even by claim) or the admin", () => {
  const stop = (headers: Record<string, string>, kernelId = KERNEL) =>
    app.inject({ method: "POST", url: "/api/operator/emergency-stop", headers, payload: { kernelId, reason: "n31" } });

  it("anonymous is 401", async () => {
    expect((await stop(ANON)).statusCode).toBe(401);
  });

  it("a stranger is 403: the stop is not set and the kernel's pending approvals are not cancelled", async () => {
    await setStop(false);
    const pending = await pendingApproval();
    const res = await stop(asStranger());
    expect(res.statusCode).toBe(403);
    expect((policyRow(KERNEL)?.policy as { emergencyStop?: boolean }).emergencyStop).toBe(false);
    expect(approvalRow(pending)?.status).toBe("pending");
  });

  it("a key whose claimed identity is the kernel's operator stops it (an operator never loses their e-stop)", async () => {
    await setStop(false);
    const res = await stop(asOperator());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stopped: true, kernelId: KERNEL });
    expect((policyRow(KERNEL)?.policy as { emergencyStop?: boolean }).emergencyStop).toBe(true);
  });

  it("the operator's other key with a lower-cased wallet stops it too", async () => {
    await setStop(false);
    expect((await stop(bearer(keys.operatorLower))).statusCode).toBe(200);
  });

  it("the admin stops it", async () => {
    await setStop(false);
    expect((await stop(asAdmin())).statusCode).toBe(200);
  });

  it("an unknown kernel is 404 for a non-admin, and nothing is written", async () => {
    const res = await stop(asOperator(), "kernel-n31-missing");
    expect(res.statusCode).toBe(404);
    expect(policyRow("kernel-n31-missing")).toBeUndefined();
  });

  it("a key claiming the zero address does not own an unowned legacy kernel", async () => {
    expect((await stop(bearer(keys.zero), LEGACY)).statusCode).toBe(403);
    expect(policyRow(LEGACY)).toBeUndefined();
  });
});

describe("N31 POST /api/operator/emergency-resume: the admin, or the operator's PROVEN wallet", () => {
  const resume = (headers: Record<string, string>) =>
    app.inject({ method: "POST", url: "/api/operator/emergency-resume", headers, payload: { kernelId: KERNEL } });
  const stopped = () => (policyRow(KERNEL)?.policy as { emergencyStop?: boolean }).emergencyStop;

  it("anonymous is 401", async () => {
    await setStop(true);
    expect((await resume(ANON)).statusCode).toBe(401);
    expect(stopped()).toBe(true);
  });

  it("a stranger is 403 and the kernel stays stopped", async () => {
    await setStop(true);
    expect((await resume(asStranger())).statusCode).toBe(403);
    expect(stopped()).toBe(true);
  });

  it("a key that only CLAIMS the operator's wallet is 403: a claim is not proof", async () => {
    await setStop(true);
    const res = await resume(asOperator());
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "forbidden", reason: "operator_proof_required" });
    expect(stopped()).toBe(true);
  });

  it("the operator's proven wallet (WP-A's field) resumes it", async () => {
    await setStop(true);
    expect((await resume(asProvenOperator())).statusCode).toBe(200);
    expect(stopped()).toBe(false);
  });

  it("a proven wallet that is not the operator's is 403", async () => {
    await setStop(true);
    const res = await resume({ ...bearer(keys.operator), "x-test-proven-wallet": STRANGER });
    expect(res.statusCode).toBe(403);
    expect(stopped()).toBe(true);
  });

  it("the admin resumes it", async () => {
    await setStop(true);
    expect((await resume(asAdmin())).statusCode).toBe(200);
    expect(stopped()).toBe(false);
  });
});

describe("N31 PUT and PATCH /api/operator/policy/:kernelId: the admin, or the operator's PROVEN wallet", () => {
  const patch = (headers: Record<string, string>, payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `/api/operator/policy/${KERNEL}`, headers, payload });
  const put = (headers: Record<string, string>, payload: Record<string, unknown>) =>
    app.inject({ method: "PUT", url: `/api/operator/policy/${KERNEL}`, headers, payload });
  const stopped = () => (policyRow(KERNEL)?.policy as { emergencyStop?: boolean }).emergencyStop;

  it("anonymous is 401 for both", async () => {
    await setStop(true);
    expect((await patch(ANON, { emergencyStop: false })).statusCode).toBe(401);
    expect((await put(ANON, { version: 1, emergencyStop: false })).statusCode).toBe(401);
    expect(stopped()).toBe(true);
  });

  it("a stranger's PATCH {emergencyStop:false} is 403: it is a resume by another name", async () => {
    await setStop(true);
    expect((await patch(asStranger(), { emergencyStop: false })).statusCode).toBe(403);
    expect(stopped()).toBe(true);
  });

  it("a stranger's PUT is 403 and the stored policy is unchanged", async () => {
    await setStop(true);
    const before = JSON.stringify(policyRow(KERNEL)?.policy);
    expect((await put(asStranger(), { version: 1, emergencyStop: false })).statusCode).toBe(403);
    expect(JSON.stringify(policyRow(KERNEL)?.policy)).toBe(before);
  });

  it("the operator's claimed key is 403 for both", async () => {
    await setStop(true);
    expect((await patch(asOperator(), { emergencyStop: false })).statusCode).toBe(403);
    expect((await put(asOperator(), { version: 1, emergencyStop: false })).statusCode).toBe(403);
    expect(stopped()).toBe(true);
  });

  it("the operator's proven wallet and the admin may change it", async () => {
    await setStop(true);
    expect((await patch(asProvenOperator(), { emergencyStop: false })).statusCode).toBe(200);
    expect(stopped()).toBe(false);
    expect((await put(asAdmin(), { version: 1, emergencyStop: true })).statusCode).toBe(200);
    expect(stopped()).toBe(true);
  });

  it("an unknown kernel is 404 for a non-admin and nothing is written", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/operator/policy/kernel-n31-missing",
      headers: asProvenOperator(),
      payload: { emergencyStop: false },
    });
    expect(res.statusCode).toBe(404);
    expect(policyRow("kernel-n31-missing")).toBeUndefined();
  });
});

describe("N31 POST /api/operator/approvals: the kernel's operator or the admin; autoApprove needs proof", () => {
  const submit = (headers: Record<string, string>, extra: Record<string, unknown> = {}, kernelId = KERNEL) =>
    app.inject({ method: "POST", url: "/api/operator/approvals", headers, payload: { kernelId, agentId: "agent-n31", ...extra } });

  it("anonymous is 401 and nothing is created", async () => {
    const before = approvalCount();
    expect((await submit(ANON)).statusCode).toBe(401);
    expect(approvalCount()).toBe(before);
  });

  it("a stranger is 403 and nothing is created", async () => {
    const before = approvalCount();
    expect((await submit(asStranger())).statusCode).toBe(403);
    expect(approvalCount()).toBe(before);
  });

  it("a stranger's autoApprove is 403: no pre-approved work reaches the executor", async () => {
    const before = approvalCount();
    expect((await submit(asStranger(), { autoApprove: true })).statusCode).toBe(403);
    expect(approvalCount()).toBe(before);
  });

  it("the kernel's own (claimed) principal may queue a PENDING approval", async () => {
    const res = await submit(asOperator());
    expect(res.statusCode).toBe(200);
    expect(res.json().approval.status).toBe("pending");
  });

  it("the kernel's claimed principal may NOT submit it pre-approved: that is an approval decision", async () => {
    const before = approvalCount();
    const res = await submit(asOperator(), { autoApprove: true });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "forbidden", reason: "operator_proof_required" });
    expect(approvalCount()).toBe(before);
  });

  it("the operator's proven wallet and the admin may submit it pre-approved", async () => {
    for (const headers of [asProvenOperator(), asAdmin()]) {
      const res = await submit(headers, { autoApprove: true });
      expect(res.statusCode).toBe(200);
      expect(res.json().approval.status).toBe("approved");
    }
  });

  it("a non-boolean autoApprove is 400, never a truthy approval", async () => {
    const before = approvalCount();
    for (const autoApprove of ["yes", 1, "true", {}]) {
      const res = await submit(asOperator(), { autoApprove });
      expect(res.statusCode, JSON.stringify(autoApprove)).toBe(400);
    }
    expect(approvalCount()).toBe(before);
  });

  it("an unknown kernel is 404 for a non-admin and nothing is created", async () => {
    const before = approvalCount();
    expect((await submit(asOperator(), {}, "kernel-n31-missing")).statusCode).toBe(404);
    expect(approvalCount()).toBe(before);
  });
});

describe("N31 POST /api/operator/approvals/:id/approve and /reject: the admin, or the operator's PROVEN wallet", () => {
  for (const action of ["approve", "reject"] as const) {
    const decide = (id: string, headers: Record<string, string>) =>
      app.inject({ method: "POST", url: `/api/operator/approvals/${id}/${action}`, headers, payload: {} });

    it(`${action}: anonymous is 401 and the approval stays pending`, async () => {
      const id = await pendingApproval();
      expect((await decide(id, ANON)).statusCode).toBe(401);
      expect(approvalRow(id)?.status).toBe("pending");
    });

    it(`${action}: a stranger is 403 and the approval stays pending`, async () => {
      const id = await pendingApproval();
      expect((await decide(id, asStranger())).statusCode).toBe(403);
      expect(approvalRow(id)?.status).toBe("pending");
    });

    it(`${action}: the operator's claimed key is 403 (a claim is not proof)`, async () => {
      const id = await pendingApproval();
      const res = await decide(id, asOperator());
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "forbidden", reason: "operator_proof_required" });
      expect(approvalRow(id)?.status).toBe("pending");
    });

    it(`${action}: the operator's proven wallet decides it`, async () => {
      const id = await pendingApproval();
      expect((await decide(id, asProvenOperator())).statusCode).toBe(200);
      expect(approvalRow(id)?.status).toBe(action === "approve" ? "approved" : "rejected");
    });

    it(`${action}: the admin decides it, and a second decision is 409`, async () => {
      const id = await pendingApproval();
      expect((await decide(id, asAdmin())).statusCode).toBe(200);
      const again = await decide(id, asAdmin());
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: "already_decided" });
    });

    it(`${action}: an unknown approval is 404`, async () => {
      expect((await decide("approval-n31-missing", asAdmin())).statusCode).toBe(404);
    });
  }
});
