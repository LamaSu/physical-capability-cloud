/**
 * Astra pack 83 HIGH 3, the wizard's door: "the device-builder wizard registers
 * devices on ANY existing kernel".
 *
 * POST /api/wizard/sessions/:id/complete on track "device-builder" ends in
 * orchestrateDeviceBuilder (routes/wizard.ts). It takes `kernelId` from the
 * session's merged step data, looks the kernel up, and when the row exists
 * inserts `dev-<kernelId>-000` on it. Nothing compared the session's owner with
 * the kernel's owner (its `operatorAddress`): stranger B could name A's kernel
 * in a step and a device row (B's adapter type and model) appeared on A's
 * kernel. Same class as POST /api/devices/register (n71-device-register-authority)
 * and POST /api/setup/register-device (owner-only since WP-C R3), by a different
 * door onto the same rows.
 *
 * The rule pinned here: a device-builder session may name only a kernel its
 * owner operates (`ownsKernel`: a placeholder owner, "" or the zero address,
 * owns nothing) or a kernel that does not exist yet (today's honest skip). A
 * refusal is 403 not_kernel_owner, sent BEFORE the session is claimed, so the
 * session is neither completed, recorded nor stuck "in flight", and a corrected
 * session still completes.
 *
 * Reproduced at 1012024a before any code changed: the file imports only
 * modules that exist there, so it runs unchanged on that base and every [neg]
 * case fails there.
 *
 * Driven over HTTP through the REAL apiGate and real API keys ("app"), and
 * through the same routes with no apiGate ("bareApp"), where the identity is
 * whatever a hook puts on the request: nothing, or a dashboard (SIWE) principal
 * that carries only `userId`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { wizardRoutes, _clearSessionsForTesting } from "../routes/wizard.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";

const A = "wiz-devb-owner-a@x.test";
const B = "wiz-devb-stranger-b@x.test";
const ZERO = "0x0000000000000000000000000000000000000000";
/** Dashboard (SIWE) principals: EVM addresses, mixed case as a wallet reports them. */
const SIWE_OWNER = "0xAbC0000000000000000000000000000000000A01";
const SIWE_OTHER = "0xdEf0000000000000000000000000000000000B02";

/** apiGate in front: the production shape. */
let app: FastifyInstance;
/** The same routes with NO apiGate; a hook sets `userId` from x-test-user (a SIWE-style principal) or nothing. */
let bareApp: FastifyInstance;
let keyA = "";
let keyB = "";
let keyZero = "";
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

type Headers = Record<string, string>;
const asKey = (k: string): Headers => ({ authorization: `Bearer ${k}` });
const asUser = (address: string): Headers => ({ "x-test-user": address });

/** Kernel `id` registered through the kernel facade by `owner` (the facade stamps the actor as operatorAddress). */
async function ownedKernel(owner: string, label: string): Promise<string> {
  const id = uid(`kernel-wizdevb-${label}`);
  const { getKernelFacade } = await import("../facades/index.js");
  const res = await getKernelFacade().register({ id, name: `Wizard device-builder ${label}` }, owner);
  expect(res.success, JSON.stringify(res)).toBe(true);
  return id;
}

/** A legacy kernel row whose recorded owner is a placeholder ("" or the zero address). */
function placeholderKernel(placeholder: string, label: string): string {
  const id = uid(`kernel-wizdevb-${label}`);
  getRepos().kernels.insert({
    id,
    name: `Legacy placeholder-owned kernel ${label}`,
    operatorAddress: placeholder,
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

/** The ids of every device row on `kernelId`. */
const devicesOn = (kernelId: string) =>
  (getRepos().kernels.findDevicesByKernel(kernelId) as Array<{ id: string }>).map((d) => d.id);

const DEVICE_STEP = { deviceName: "Wizard Test Printer", deviceType: "machine" };

async function putStep(
  on: FastifyInstance,
  headers: Headers,
  sessionId: string,
  step: number,
  data: Record<string, unknown>,
) {
  return on.inject({
    method: "PUT",
    url: `/api/wizard/sessions/${sessionId}/steps/${step}`,
    headers,
    payload: { data },
  });
}

/**
 * A session with all five steps saved. Step 0 carries the device (`step0`, a
 * device by default); step 4 carries `step4` (the kernel it names, plus extras).
 */
async function buildSession(
  on: FastifyInstance,
  headers: Headers,
  step4: Record<string, unknown>,
  step0: Record<string, unknown> = DEVICE_STEP,
  track = "device-builder",
): Promise<string> {
  const created = await on.inject({ method: "POST", url: "/api/wizard/sessions", headers, payload: { track } });
  expect(created.statusCode, created.body).toBe(201);
  const id: string = created.json().session.id;
  await putStep(on, headers, id, 0, step0);
  await putStep(on, headers, id, 1, { adapterType: "mock" });
  await putStep(on, headers, id, 2, { capabilities: ["fdm"] });
  await putStep(on, headers, id, 3, { connectionTested: true });
  await putStep(on, headers, id, 4, step4);
  return id;
}

const complete = (on: FastifyInstance, headers: Headers, sessionId: string) =>
  on.inject({ method: "POST", url: `/api/wizard/sessions/${sessionId}/complete`, headers });

const getSession = (on: FastifyInstance, headers: Headers, sessionId: string) =>
  on.inject({ method: "GET", url: `/api/wizard/sessions/${sessionId}`, headers });

const registerStep = (res: { json(): any }) =>
  (res.json().result.executedSteps as Array<{ name: string; status: string; message: string }>).find(
    (s) => s.name === "register-devices",
  );

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  keyA = provisionApiKey({ operatorId: A, scopes: ["operator"] }).rawKey;
  keyB = provisionApiKey({ operatorId: B, scopes: ["operator"] }).rawKey;
  keyZero = provisionApiKey({ operatorId: ZERO, scopes: ["operator"] }).rawKey;

  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(wizardRoutes);
  await app.ready();

  bareApp = Fastify({ logger: false });
  bareApp.addHook("onRequest", async (req) => {
    const h = req.headers["x-test-user"];
    if (typeof h === "string" && h) (req as unknown as { userId?: string }).userId = h;
  });
  await bareApp.register(wizardRoutes);
  await bareApp.ready();
});

afterAll(async () => {
  await app?.close();
  await bareApp?.close();
  closeStore();
});

beforeEach(() => {
  _clearSessionsForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wizard device-builder: devices are registered only on a kernel the session's owner operates", () => {
  // ── The hole ──────────────────────────────────────────────────────────────

  it("[neg] a STRANGER names the owner's kernel: 403 not_kernel_owner, NO device row on that kernel, and the owner's identity is not echoed", async () => {
    const kernelId = await ownedKernel(A, "a1");
    const sid = await buildSession(app, asKey(keyB), { kernelId });
    const res = await complete(app, asKey(keyB), sid);
    // At 1012024a this is 200 and `dev-<kernel>-000` exists on A's kernel.
    expect(devicesOn(kernelId), `B registered a device on A's kernel: ${res.statusCode} ${res.body}`).toEqual([]);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ error: "not_kernel_owner", kernelId });
    expect(res.body).not.toContain(A);
  });

  it("[neg] a refused completion does not consume the session: it stays in_progress, is not claimed, and once corrected to B's own kernel the SAME session completes", async () => {
    const foreign = await ownedKernel(A, "a2");
    const own = await ownedKernel(B, "b2");
    const hdr = asKey(keyB);
    const sid = await buildSession(app, hdr, { kernelId: foreign });

    const first = await complete(app, hdr, sid);
    expect(devicesOn(foreign), `B registered a device on A's kernel: ${first.statusCode} ${first.body}`).toEqual([]);
    expect(first.statusCode, first.body).toBe(403);

    // Not consumed: not completed, and no recorded outcome.
    const state = await getSession(app, hdr, sid);
    expect(state.statusCode, state.body).toBe(200);
    expect(state.json().session.status).toBe("in_progress");
    expect(state.json().session.completionResult).toBeUndefined();

    // Not claimed: asking again is the same refusal, never 409 completion_in_progress.
    const again = await complete(app, hdr, sid);
    expect(again.statusCode, again.body).toBe(403);
    expect(again.json().error).toBe("not_kernel_owner");

    // Corrected to B's own kernel, the SAME session completes and registers there.
    const fix = await putStep(app, hdr, sid, 4, { kernelId: own });
    expect(fix.statusCode, fix.body).toBe(200);
    const done = await complete(app, hdr, sid);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().session.status).toBe("completed");
    expect(done.json().result.registeredDevices).toEqual([`dev-${own}-000`]);
    expect(devicesOn(own)).toEqual([`dev-${own}-000`]);
    expect(devicesOn(foreign)).toEqual([]);
  });

  it("[neg] a kernel whose recorded owner is a placeholder (the zero address, or empty) is nobody's: even a normal key holder gets 403 and no row", async () => {
    for (const [label, placeholder] of [["zero", ZERO], ["blank", ""]] as const) {
      const kernelId = placeholderKernel(placeholder, `ph-${label}`);
      const sid = await buildSession(app, asKey(keyA), { kernelId });
      const res = await complete(app, asKey(keyA), sid);
      expect(devicesOn(kernelId), `${label}: ${res.statusCode} ${res.body}`).toEqual([]);
      expect(res.statusCode, `${label}: ${res.body}`).toBe(403);
      expect(res.json().error, label).toBe("not_kernel_owner");
    }
  });

  it("[neg] a zero-address PRINCIPAL does not own a zero-address-owned kernel either: equal strings are not ownership", async () => {
    const kernelId = placeholderKernel(ZERO, "zero-principal");
    const sid = await buildSession(app, asKey(keyZero), { kernelId });
    const res = await complete(app, asKey(keyZero), sid);
    expect(devicesOn(kernelId), `${res.statusCode} ${res.body}`).toEqual([]);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("not_kernel_owner");
  });

  it("[neg] a session nobody owns (no identity at all) cannot register devices on an existing kernel: 403, no row", async () => {
    const kernelId = await ownedKernel(A, "a5");
    const sid = await buildSession(bareApp, {}, { kernelId });
    const res = await complete(bareApp, {}, sid);
    expect(devicesOn(kernelId), `${res.statusCode} ${res.body}`).toEqual([]);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("not_kernel_owner");
  });

  it("[neg] a dashboard (SIWE) principal that is not the kernel's operator is refused too: 403, no row", async () => {
    const kernelId = await ownedKernel(SIWE_OWNER, "siwe-owner");
    const sid = await buildSession(bareApp, asUser(SIWE_OTHER), { kernelId });
    const res = await complete(bareApp, asUser(SIWE_OTHER), sid);
    expect(devicesOn(kernelId), `${res.statusCode} ${res.body}`).toEqual([]);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("not_kernel_owner");
  });

  it("[neg] an operator named in the step data is a claim, not an identity: B listing A as the operator is still refused", async () => {
    const kernelId = await ownedKernel(A, "a6");
    const claims = { operatorAddress: A, operatorId: A, owner: A, operator: { walletAddress: A, displayName: "A" } };
    const sid = await buildSession(app, asKey(keyB), { kernelId, ...claims }, { ...DEVICE_STEP, ...claims });
    const res = await complete(app, asKey(keyB), sid);
    expect(devicesOn(kernelId), `${res.statusCode} ${res.body}`).toEqual([]);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("not_kernel_owner");
  });

  it("[neg] a kernelId that is not a string is the kernel it coerces to: [K] is refused like K, and writes no row", async () => {
    // The registration builds its kernel with String(kernelId): [K] becomes K and
    // finds A's row (the n71 type-confusion class). The guard must see the same kernel.
    const kernelId = await ownedKernel(A, "a7");
    const sid = await buildSession(app, asKey(keyB), { kernelId: [kernelId] });
    const res = await complete(app, asKey(keyB), sid);
    expect(devicesOn(kernelId), `${res.statusCode} ${res.body}`).toEqual([]);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("not_kernel_owner");
  });

  it("[neg] the guard reads the SAME merged step data the registration does: a later step's kernelId overrides an earlier one, so naming B's own kernel early does not hide A's kernel named last", async () => {
    const own = await ownedKernel(B, "b8");
    const foreign = await ownedKernel(A, "a8");
    const sid = await buildSession(app, asKey(keyB), { kernelId: foreign }, { ...DEVICE_STEP, kernelId: own });
    const res = await complete(app, asKey(keyB), sid);
    expect(devicesOn(foreign), `${res.statusCode} ${res.body}`).toEqual([]);
    expect(devicesOn(own)).toEqual([]);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("not_kernel_owner");
  });

  it("[neg] the rule is about the kernel a session targets, not about this one write: a session with no device that names the owner's kernel is refused too", async () => {
    const kernelId = await ownedKernel(A, "a9");
    const sid = await buildSession(app, asKey(keyB), { kernelId }, { note: "no device in this session" });
    const res = await complete(app, asKey(keyB), sid);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("not_kernel_owner");
    expect(devicesOn(kernelId)).toEqual([]);
  });

  it("[neg] ownership that cannot be verified fails closed: a failed kernel lookup is 502 kernel_lookup_failed, writes no row (not even for the real owner), and the session can be retried", async () => {
    const kernelId = await ownedKernel(A, "a10");
    const hdr = asKey(keyA);
    const sid = await buildSession(app, hdr, { kernelId });
    // The FIRST lookup fails (a transient store error); a second would succeed.
    // A guard that treats "could not look it up" as "no such kernel" lets the
    // registration's own lookup find the row and write to it.
    const spy = vi.spyOn(getRepos().kernels, "findById").mockImplementationOnce(() => {
      throw new Error("synthetic store failure");
    });
    const res = await complete(app, hdr, sid);
    spy.mockRestore();
    expect(devicesOn(kernelId), `${res.statusCode} ${res.body}`).toEqual([]);
    expect(res.statusCode, res.body).toBe(502);
    expect(res.json().error).toBe("kernel_lookup_failed");

    const state = await getSession(app, hdr, sid);
    expect(state.json().session.status).toBe("in_progress");
    const retry = await complete(app, hdr, sid);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(devicesOn(kernelId)).toEqual([`dev-${kernelId}-000`]);
  });

  // ── Controls: nothing that was legitimate is refused ─────────────────────

  it("control: the OWNER registers a device on its own kernel (a real row from the steps) and the session is completed", async () => {
    const kernelId = await ownedKernel(A, "c1");
    const sid = await buildSession(app, asKey(keyA), { kernelId });
    const res = await complete(app, asKey(keyA), sid);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().session.status).toBe("completed");
    expect(res.json().result.success).toBe(true);
    expect(registerStep(res)?.status).toBe("success");
    expect(res.json().result.registeredDevices).toEqual([`dev-${kernelId}-000`]);
    const row = getRepos().kernels.findDeviceById(`dev-${kernelId}-000`);
    expect(row).toMatchObject({ kernelId, adapterType: "mock", model: "Wizard Test Printer", type: "machine" });
  });

  it("control: a stranger registers devices on the stranger's OWN kernel (the rule compares owners, it does not refuse by identity)", async () => {
    const kernelId = await ownedKernel(B, "c2");
    const sid = await buildSession(app, asKey(keyB), { kernelId });
    const res = await complete(app, asKey(keyB), sid);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result.registeredDevices).toEqual([`dev-${kernelId}-000`]);
    expect(devicesOn(kernelId)).toEqual([`dev-${kernelId}-000`]);
  });

  it("control: a kernel that does not exist keeps today's honest skip for everyone (owner key, stranger key, no identity), and writes no rows", async () => {
    for (const [label, on, headers] of [
      ["owner", app, asKey(keyA)],
      ["stranger", app, asKey(keyB)],
      ["no identity", bareApp, {}],
    ] as const) {
      const ghost = uid("kernel-wizdevb-ghost");
      const sid = await buildSession(on, headers, { kernelId: ghost });
      const res = await complete(on, headers, sid);
      expect(res.statusCode, `${label}: ${res.body}`).toBe(200);
      expect(res.json().result.success, label).toBe(true);
      expect(registerStep(res)?.status, label).toBe("skipped");
      expect(registerStep(res)?.message, label).toContain("is not registered yet");
      expect(res.json().result.registeredDevices, label).toEqual([]);
      expect(devicesOn(ghost), label).toEqual([]);
      expect(getRepos().kernels.findDeviceById(`dev-${ghost}-000`), label).toBeUndefined();
    }
  });

  it("control: a session that names no kernel at all gets a generated kernel id and the same honest skip", async () => {
    const sid = await buildSession(app, asKey(keyA), {});
    const res = await complete(app, asKey(keyA), sid);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result.kernelConfig.kernelId).toMatch(/^kernel_wizard_/);
    expect(registerStep(res)?.status).toBe("skipped");
    expect(registerStep(res)?.message).toContain("is not registered yet");
    expect(res.json().result.registeredDevices).toEqual([]);
  });

  it("control: a dashboard (SIWE) principal that carries only userId, in any letter case, registers on the kernel it operates", async () => {
    const kernelId = await ownedKernel(SIWE_OWNER, "c5");
    const principal = SIWE_OWNER.toLowerCase();
    expect(principal).not.toBe(SIWE_OWNER);
    const sid = await buildSession(bareApp, asUser(principal), { kernelId });
    const res = await complete(bareApp, asUser(principal), sid);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result.registeredDevices).toEqual([`dev-${kernelId}-000`]);
    expect(devicesOn(kernelId)).toEqual([`dev-${kernelId}-000`]);
  });

  it("control: a legacy session nobody owns, completed by the operator of the kernel it names, registers (the write is the caller's own)", async () => {
    const kernelId = await ownedKernel(SIWE_OWNER, "c6");
    const sid = await buildSession(bareApp, {}, { kernelId });
    const res = await complete(bareApp, asUser(SIWE_OWNER), sid);
    expect(res.statusCode, res.body).toBe(200);
    expect(devicesOn(kernelId)).toEqual([`dev-${kernelId}-000`]);
  });

  it("control: the rule is the device-builder track's: a stranger's platform-setup session that carries a kernelId in its step data still completes", async () => {
    const kernelId = await ownedKernel(A, "c7");
    const sid = await buildSession(app, asKey(keyB), { kernelId }, { kernelId }, "platform-setup");
    const res = await complete(app, asKey(keyB), sid);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().session.status).toBe("completed");
    expect(devicesOn(kernelId)).toEqual([]);
  });
});

// Keep this block LAST: the gateway store is a per-process singleton and this
// test closes it (afterAll's closeStore() is then a no-op).
describe("wizard device-builder: a process with no store", () => {
  it("control: with no store at all nothing is guarded and nothing is written, so the honest 'no database' skip stays", async () => {
    closeStore();
    const sid = await buildSession(bareApp, {}, { kernelId: uid("kernel-wizdevb-nostore") });
    const res = await complete(bareApp, {}, sid);
    expect(res.statusCode, res.body).toBe(200);
    expect(registerStep(res)?.status).toBe("skipped");
    expect(registerStep(res)?.message).toContain("no database available");
    expect(res.json().result.registeredDevices).toEqual([]);
  });
});
