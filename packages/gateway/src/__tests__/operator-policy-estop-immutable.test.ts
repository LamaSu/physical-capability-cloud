/**
 * A policy PUT/PATCH may not change emergencyStop (gap found by lane
 * refvertical alongside astra pack 150, same files: routes/operator.ts).
 *
 * Before this fix, PUT or PATCH /api/operator/policy/:kernelId could set or
 * clear emergencyStop directly, as an ordinary field of the policy object.
 * Only POST /api/operator/emergency-stop runs the stop's side effects
 * (rejecting PENDING approvals for the kernel); a PATCH that merely flips the
 * flag skips them entirely. A PATCH stop immediately followed by a PATCH
 * resume — both before any poller ever observes the stopped state — could
 * leave queued work completely undisturbed, as if the stop had never run.
 *
 * A full-replace PUT has an even sharper version of the same gap: a client
 * that PUTs "the whole policy" but forgets to carry `emergencyStop` forward
 * would silently CLEAR a real, active stop the moment the write landed,
 * because the column would then hold an object with no `emergencyStop` key at
 * all (reads as falsy).
 *
 * Fix: PUT and PATCH refuse a body whose (boolean-coerced) emergencyStop
 * differs from the CURRENTLY STORED (boolean-coerced) value — 400
 * emergency_stop_immutable_via_policy_write. For PUT this check applies
 * whether or not the body includes the field at all, since omitting it in a
 * full replace is itself a change (to falsy). Stopping and resuming go ONLY
 * through POST /api/operator/emergency-stop and /api/operator/emergency-resume.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { kernelRoutes } from "../routes/kernels.js";
import { operatorRoutes } from "../routes/operator.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, initStore } from "../db.js";

const OWNER = "policy-immutable-owner@x.test";
const savedDbPath = process.env.PCC_DB_PATH;

let app: FastifyInstance;
let ownerKey = "";
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const asOwner = () => ({ authorization: `Bearer ${ownerKey}` });

async function ownedKernel(prefix: string): Promise<string> {
  const id = uid(prefix);
  const res = await app.inject({
    method: "POST",
    url: "/api/kernels",
    headers: asOwner(),
    payload: { id, name: `Immutable ${id}` },
  });
  expect(res.statusCode, res.body).toBe(201);
  return id;
}

const getPolicy = (kernelId: string) =>
  app.inject({ method: "GET", url: `/api/operator/policy/${kernelId}`, headers: asOwner() });
const putPolicy = (kernelId: string, body: Record<string, unknown>) =>
  app.inject({
    method: "PUT",
    url: `/api/operator/policy/${kernelId}`,
    headers: asOwner(),
    payload: { version: 1, ...body },
  });
const patchPolicy = (kernelId: string, body: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url: `/api/operator/policy/${kernelId}`, headers: asOwner(), payload: body });
const stop = (kernelId: string) =>
  app.inject({
    method: "POST",
    url: "/api/operator/emergency-stop",
    headers: asOwner(),
    payload: { kernelId, reason: "t" },
  });
const resume = (kernelId: string) =>
  app.inject({ method: "POST", url: "/api/operator/emergency-resume", headers: asOwner(), payload: { kernelId } });

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  ownerKey = provisionApiKey({ operatorId: OWNER, scopes: ["operator"] }).rawKey;

  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(kernelRoutes);
  await app.register(operatorRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
  if (savedDbPath === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = savedDbPath;
});

describe("PATCH /api/operator/policy/:kernelId cannot change emergencyStop", () => {
  it("[repro] cannot activate emergencyStop via PATCH on a kernel with no existing policy", async () => {
    const kernelId = await ownedKernel("patch-activate-norow");
    const res = await patchPolicy(kernelId, { emergencyStop: true });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe("emergency_stop_immutable_via_policy_write");
    const read = await getPolicy(kernelId);
    expect(read.json().policy.emergencyStop).toBe(false);
  });

  it("[repro] cannot clear a stop the dedicated route activated", async () => {
    const kernelId = await ownedKernel("patch-clear-real-stop");
    expect((await stop(kernelId)).statusCode).toBe(200);

    const res = await patchPolicy(kernelId, { emergencyStop: false, approvalMode: "auto" });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe("emergency_stop_immutable_via_policy_write");

    const read = await getPolicy(kernelId);
    expect(read.json().policy.emergencyStop).toBe(true);
    // The rest of the patch did not partially apply either (atomic refusal).
    expect(read.json().policy.approvalMode).not.toBe("auto");
  });

  it("control: omitting emergencyStop, or restating the current value, still applies normally", async () => {
    const kernelId = await ownedKernel("patch-omit-ok");
    const res1 = await patchPolicy(kernelId, { approvalMode: "auto" });
    expect(res1.statusCode, res1.body).toBe(200);
    expect(res1.json().policy.emergencyStop).toBe(false);

    const res2 = await patchPolicy(kernelId, { emergencyStop: false, approvalMode: "manual" });
    expect(res2.statusCode, res2.body).toBe(200);
    expect(res2.json().policy.approvalMode).toBe("manual");
  });

  it("control: once resumed through the dedicated route, a PATCH restating false is accepted", async () => {
    const kernelId = await ownedKernel("patch-after-resume");
    expect((await stop(kernelId)).statusCode).toBe(200);
    expect((await resume(kernelId)).statusCode).toBe(200);
    const res = await patchPolicy(kernelId, { emergencyStop: false, approvalMode: "auto" });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe("PUT /api/operator/policy/:kernelId cannot change emergencyStop", () => {
  it("[repro] a full-replace PUT that omits emergencyStop must not silently clear a real stop", async () => {
    const kernelId = await ownedKernel("put-omit-clears-stop");
    expect((await stop(kernelId)).statusCode).toBe(200);

    // A client PUTting "a whole new policy" forgets to carry the flag forward.
    const res = await putPolicy(kernelId, { approvalMode: "auto" });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe("emergency_stop_immutable_via_policy_write");

    const read = await getPolicy(kernelId);
    expect(read.json().policy.emergencyStop).toBe(true);
  });

  it("[repro] a full-replace PUT explicitly setting emergencyStop:false is refused the same way", async () => {
    const kernelId = await ownedKernel("put-explicit-false");
    expect((await stop(kernelId)).statusCode).toBe(200);
    const res = await putPolicy(kernelId, { approvalMode: "auto", emergencyStop: false });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe("emergency_stop_immutable_via_policy_write");
  });

  it("control: a PUT that restates the current (stopped) value is accepted", async () => {
    const kernelId = await ownedKernel("put-restate-stopped");
    expect((await stop(kernelId)).statusCode).toBe(200);
    const res = await putPolicy(kernelId, { approvalMode: "auto", emergencyStop: true });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("[repro] a brand-new kernel's first PUT may set other fields freely, but not emergencyStop:true", async () => {
    const kernelId = await ownedKernel("put-first-ever");
    const blocked = await putPolicy(kernelId, { approvalMode: "auto", emergencyStop: true });
    expect(blocked.statusCode, blocked.body).toBe(400);
    const ok = await putPolicy(kernelId, { approvalMode: "auto" });
    expect(ok.statusCode, ok.body).toBe(200);
  });
});
