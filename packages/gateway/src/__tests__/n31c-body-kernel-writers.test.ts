/**
 * Board N31c (stacked on #579; the steward's ruling #6540): writes that name their kernel in the
 * BODY, or through the job they name, had no kernel ownership check. Any key could:
 *   - publish a capability on any operator's kernel (POST /api/capabilities; N43 closed only the
 *     anonymous path);
 *   - register a device on it (POST /api/setup/register-device);
 *   - heartbeat it, setting its status (POST /api/operator/heartbeat);
 *   - store evidence for any job (POST /api/operator/evidence), which feeds the money path;
 *   - set any job's status (POST /api/operator/job-status).
 * Now each takes the kernel-ownership guard (auth/kernel-authority.ts): "operate" (the kernel's
 * own principal, its proven wallet, or the admin) for capability, device, heartbeat and job
 * status; "decide" (the admin or the PROVEN operator wallet) for evidence.
 *
 * Mounted behind apiGate. Seeded kernel-nyc's operator is 0x1111…; job-001 runs on kernel-nyc.
 * The proven wallet (WP-A's field) is simulated by a test header.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { schema, eq } from "@pcc/store";

vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn(), shutdownPostHog: vi.fn() }));

const PREV_DB = process.env.PCC_DB_PATH;
const PREV_ADMIN = process.env.PCC_ADMIN_KEY;
const ADMIN = "n31c-admin-secret";
const OPERATOR = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x9999999999999999999999999999999999993100";
const KERNEL = "kernel-nyc";
const JOB = "job-001";

let app: FastifyInstance;
let getStore: typeof import("../db.js").getStore;
const keys = { operator: "", stranger: "" };
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
const asOperator = () => bearer(keys.operator);
const asStranger = () => bearer(keys.stranger);
const asAdmin = () => ({ ...bearer(keys.stranger), "x-admin-key": ADMIN });
const asProvenOperator = () => ({ ...bearer(keys.stranger), "x-test-proven-wallet": OPERATOR });
const ANON = { "x-forwarded-for": "10.31.12.1" };

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN;
  const db = await import("../db.js");
  getStore = db.getStore;
  db.closeStore();
  db.initStore({ seed: true });
  const { provisionApiKey } = await import("../auth/api-key-auth.js");
  keys.operator = provisionApiKey({ operatorId: OPERATOR, name: "n31c-operator", scopes: ["*"] }).rawKey;
  keys.stranger = provisionApiKey({ operatorId: STRANGER, name: "n31c-stranger", scopes: ["*"] }).rawKey;
  app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const proven = req.headers["x-test-proven-wallet"];
    if (typeof proven === "string") (req as unknown as { provenWallet: string }).provenWallet = proven;
  });
  const { apiGate } = await import("../middleware/api-gate.js");
  const { capabilityRoutes } = await import("../routes/capabilities.js");
  const { setupRoutes } = await import("../routes/setup.js");
  const { operatorRelayRoutes } = await import("../routes/operator-relay.js");
  await app.register(apiGate);
  await app.register(capabilityRoutes);
  await app.register(setupRoutes);
  await app.register(operatorRelayRoutes);
  await app.ready();
  expect(getStore().db.select().from(schema.shopKernels).where(eq(schema.shopKernels.id, KERNEL)).get()?.operatorAddress.toLowerCase()).toBe(OPERATOR);
}, 60_000);

afterAll(async () => {
  await app.close();
  (await import("../db.js")).closeStore();
  if (PREV_DB === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = PREV_DB;
  if (PREV_ADMIN === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = PREV_ADMIN;
});

const capCount = () => getStore().db.select().from(schema.capabilities).where(eq(schema.capabilities.kernelId, KERNEL)).all().length;
const kernelStatus = () => getStore().db.select().from(schema.shopKernels).where(eq(schema.shopKernels.id, KERNEL)).get()?.status;
const jobStatus = () => (getStore().repos.jobs.findById(JOB) as { status?: string } | undefined)?.status;

describe("N31c POST /api/capabilities: only the kernel's operator or the admin publishes on it", () => {
  const create = (headers: Record<string, string>, kernelId = KERNEL, type = "n31c-cap") =>
    app.inject({ method: "POST", url: "/api/capabilities", headers, payload: { kernelId, type, name: "N31c capability" } });

  it("anonymous is 401", async () => {
    expect((await create(ANON)).statusCode).toBe(401);
  });

  it("a stranger is 403 and nothing is published on the kernel", async () => {
    const before = capCount();
    const res = await create(asStranger(), KERNEL, "n31c-stranger-cap");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: "not_kernel_operator" });
    expect(capCount()).toBe(before);
  });

  it("an unknown kernel is 404 for a non-admin", async () => {
    expect((await create(asOperator(), "kernel-n31c-missing")).statusCode).toBe(404);
  });

  it("the kernel's operator (its own key) and the admin publish", async () => {
    expect((await create(asOperator(), KERNEL, "n31c-operator-cap")).statusCode).toBeLessThan(300);
    expect((await create(asAdmin(), KERNEL, "n31c-admin-cap")).statusCode).toBeLessThan(300);
  });
});

describe("N31c POST /api/setup/register-device: only the kernel's operator or the admin", () => {
  const register = (headers: Record<string, string>, deviceId: string, kernelId = KERNEL) =>
    app.inject({
      method: "POST",
      url: "/api/setup/register-device",
      headers,
      payload: { kernelId, deviceId, type: "machine", adapterType: "mock", capabilities: [] },
    });
  const device = (id: string) => getStore().repos.kernels.findDeviceById(id);

  it("a stranger is 403 and no device is registered", async () => {
    const res = await register(asStranger(), "dev-n31c-stranger");
    expect(res.statusCode).toBe(403);
    expect(device("dev-n31c-stranger")).toBeFalsy();
  });

  it("the kernel's operator (its own key) registers a device", async () => {
    expect((await register(asOperator(), "dev-n31c-operator")).statusCode).toBeLessThan(300);
    expect(device("dev-n31c-operator")).toBeTruthy();
  });
});

describe("N31c POST /api/operator/heartbeat: only the kernel's operator or the admin", () => {
  it("a stranger cannot set another operator's kernel status", async () => {
    const before = kernelStatus();
    const res = await app.inject({ method: "POST", url: "/api/operator/heartbeat", headers: asStranger(), payload: { kernelId: KERNEL, status: "maintenance" } });
    expect(res.statusCode).toBe(403);
    expect(kernelStatus()).toBe(before);
  });

  it("the kernel's operator (its own key) heartbeats it", async () => {
    expect((await app.inject({ method: "POST", url: "/api/operator/heartbeat", headers: asOperator(), payload: { kernelId: KERNEL, status: "online" } })).statusCode).toBe(200);
  });
});

describe("N31c POST /api/operator/evidence: a decision (admin or the PROVEN operator wallet), evidence feeds the money path", () => {
  const evidence = (headers: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: "/api/operator/evidence",
      headers,
      payload: { jobId: JOB, evidence: { bundleHash: "sha256:n31c", events: [{ type: "execution_completed", timestamp: new Date().toISOString(), payload: {} }] } },
    });

  it("a stranger is 403", async () => {
    const res = await evidence(asStranger());
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: "operator_proof_required" });
  });

  it("the operator's claimed key is 403: storing evidence is a decision", async () => {
    const res = await evidence(asOperator());
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: "operator_proof_required" });
  });

  it("the operator's proven wallet and the admin pass the guard", async () => {
    for (const headers of [asProvenOperator(), asAdmin()]) {
      const res = await evidence(headers);
      expect(res.json()?.reason).not.toBe("operator_proof_required");
      expect(res.json()?.reason).not.toBe("not_kernel_operator");
      expect(res.statusCode).not.toBe(401);
    }
  });
});

describe("N31c POST /api/operator/job-status: only the job's kernel operator or the admin", () => {
  it("a stranger cannot set another operator's job status", async () => {
    const before = jobStatus();
    const res = await app.inject({ method: "POST", url: "/api/operator/job-status", headers: asStranger(), payload: { jobId: JOB, status: "failed" } });
    expect(res.statusCode).toBe(403);
    expect(jobStatus()).toBe(before);
  });

  it("an unknown job keeps its old answer (not found, nothing updated)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/operator/job-status", headers: asStranger(), payload: { jobId: "job-n31c-missing", status: "failed" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ updated: false, warning: "job_not_found" });
  });

  it("the kernel's operator (its own key) updates its job", async () => {
    const res = await app.inject({ method: "POST", url: "/api/operator/job-status", headers: asOperator(), payload: { jobId: JOB, status: "in_progress" } });
    expect(res.statusCode).not.toBe(403);
  });
});
