import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  getRepos: vi.fn(),
  getKernelService: vi.fn(),
  acceptExternalPlan: vi.fn(),
}));
vi.mock("../db.js", () => ({ getStore: mocks.getStore, getRepos: mocks.getRepos }));
vi.mock("../chain-client.js", () => ({ getActiveNetwork: () => "base-sepolia" }));
vi.mock("../routes/csd.js", () => ({ getCsdRegistry: vi.fn() }));
vi.mock("../services/kernel-service.js", () => ({ getKernelService: mocks.getKernelService }));
vi.mock("../facades/index.js", () => ({ getKernelFacade: vi.fn(), getJobFacade: vi.fn() }));
vi.mock("../facades/job.facade.js", () => ({ isExecutingAdapter: () => true }));
vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../services/audit-service.js", () => ({ auditService: { log: vi.fn() } }));
vi.mock("../services/funnel-tracker.js", () => ({ recordOperatorStage: vi.fn() }));
vi.mock("../routes/device-relay.js", () => ({ emergencyStopState: () => "clear" }));
vi.mock("../services/external-plan-seam.js", () => ({
  acceptExternalPlan: mocks.acceptExternalPlan,
  snapshotSubmission: () => ({ edges: [] }),
  submissionDigest: () => "digest",
}));
vi.mock("../services/agent-plan-deal.js", () => ({ bindDeal: () => ({ ok: true, bindings: [] }) }));
vi.mock("../services/plan-presentation.js", () => ({ presentPlan: () => ({}) }));

import { refuseKernelAction } from "../auth/kernel-authority.js";
import { gateJobRead, gateJobRecordRead, gateKernelRead, kernelScopeOf, jobReadScopeOf } from "../readmodels/job-read-gate.js";
import { agentPlanRoutes } from "../routes/agent-plans.js";
import { productHomeRoutes } from "../routes/product-home.js";
import { setupRoutes } from "../routes/setup.js";
import { INVALID_ID } from "../redaction.js";
import { warnInvalidSeedDataOverride } from "../config/seed-policy.js";

const SECRET = "N71-MERGE-SENTINEL";
const UNSAFE_ID = `https://user:${SECRET}@device.invalid/`;
const WALLET = `0x${"11".repeat(20)}`;

function request(overrides: Record<string, unknown> = {}) {
  return {
    headers: { "x-admin-key": "merge-test-admin" },
    operatorId: WALLET,
    provenWallet: WALLET,
    log: { error: vi.fn(), warn: vi.fn() },
    ...overrides,
  } as any;
}

function reply() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    code(code: number) { this.statusCode = code; return this; },
    send(body: unknown) { this.body = body; return body; },
    header: vi.fn(),
  };
}

async function handlers(register: (app: any) => Promise<unknown>) {
  const found = new Map<string, (req: any, reply: any) => Promise<unknown>>();
  const add = (path: string, handler: any) => found.set(path, handler);
  await register({ get: add, post: add });
  return found;
}

describe("N71 merge additions keep exception and config text out of logs and replies", () => {
  beforeEach(() => {
    vi.stubEnv("PCC_ADMIN_KEY", "merge-test-admin");
    vi.stubEnv("TENANT_ENFORCE", "false");
    mocks.getStore.mockImplementation(() => { throw new TypeError(`password=${SECRET}`); });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it.each([["production", false], ["development", true]])("invalid seed override in %s logs only the effective default", (nodeEnv, seed) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      warnInvalidSeedDataOverride(`password=${SECRET}`, nodeEnv as string);
      expect(warning).toHaveBeenCalledWith(`Invalid PCC_SEED_DATA "${INVALID_ID}"; falling back to default ${seed}.`);
      expect(JSON.stringify(warning.mock.calls)).not.toContain(SECRET);
    } finally {
      warning.mockRestore();
    }
  });

  it("kernel authorization preserves its fail-closed reply and formats ids and errors", () => {
    const req = request();
    const refusal = refuseKernelAction(req, { admin: false, provenWallet: WALLET, claimed: WALLET }, UNSAFE_ID, "operate");
    expect(refusal?.status).toBe(503);
    expect(req.log.warn).toHaveBeenCalledWith({ kernelId: INVALID_ID, err: "TypeError" }, expect.any(String));
    expect(JSON.stringify(req.log.warn.mock.calls)).not.toContain(SECRET);
  });

  it("every read-gate failure logs a closed class and formats the requested job id", () => {
    const req = request();
    expect(gateJobRead(req, UNSAFE_ID)).toEqual({ ok: false, kind: "unavailable" });
    expect(req.log.error).toHaveBeenLastCalledWith({ jobId: INVALID_ID, err: "TypeError" }, expect.any(String));
    expect(gateJobRecordRead(req, () => undefined)).toEqual({ ok: false, kind: "unavailable" });
    expect(gateKernelRead(req, () => undefined)).toEqual({ ok: false, kind: "unavailable" });
    req.headers = {};
    expect(kernelScopeOf(req)).toEqual({ ok: false, kind: "unavailable" });
    expect(jobReadScopeOf(req)).toEqual({ ok: false, kind: "unavailable" });
    mocks.getStore.mockReturnValue({
      repos: { jobs: { findById: () => ({ id: UNSAFE_ID, kernelId: "kernel" }) } },
      db: { select: () => { throw new TypeError(`password=${SECRET}`); } },
    });
    expect(gateJobRead(req, UNSAFE_ID)).toEqual({ ok: false, kind: "unavailable" });
    expect(req.log.error).toHaveBeenCalledTimes(6);
    expect(req.log.error).toHaveBeenLastCalledWith({ jobId: INVALID_ID, err: "TypeError" }, expect.any(String));
    expect(JSON.stringify(req.log.error.mock.calls)).not.toContain(SECRET);
  });

  it("product home keeps fixed source names and logs no store exception content", async () => {
    const routes = await handlers(productHomeRoutes);
    const req = request();
    const body = await routes.get("/api/product/home")!(req, reply());
    expect(req.log.error).toHaveBeenCalledWith({ err: "TypeError" }, expect.any(String));
    expect(req.log.warn.mock.calls.map(([arg]: any[]) => arg.source)).toEqual(["kernels", "jobs", "escrow"]);
    expect(JSON.stringify({ body, errors: req.log.error.mock.calls, warnings: req.log.warn.mock.calls })).not.toContain(SECRET);
  });

  it.each(["/api/agent-plans/validate", "/api/settlement/agent-plans/accept"])("%s hides thrown config from logs and replies", async (path) => {
    const routes = await handlers((app) => agentPlanRoutes(app, { deps: () => { throw new TypeError(`password=${SECRET}`); } }));
    const req = request({ body: { nodes: [] } });
    const res = reply();
    await routes.get(path)!(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "internal-error" });
    expect(req.log.error).toHaveBeenCalledWith({ err: "TypeError" }, expect.any(String));
    expect(JSON.stringify(req.log.error.mock.calls)).not.toContain(SECRET);
  });

  it("a consume rejection string cannot become raw error text in the log", async () => {
    mocks.acceptExternalPlan.mockReturnValue({ ok: true, submissionDigest: "digest", plan: { reservationId: "reservation", acceptedDealDigest: "deal" } });
    const deps = { accept: {
      seam: { now: () => 1_900_000_000 }, encodeDeal: () => [],
      consumeReservation: () => ({ ok: false, reason: `password=${SECRET}` }),
    } } as any;
    const routes = await handlers((app) => agentPlanRoutes(app, { deps: () => deps }));
    const req = request({ body: {} });
    const res = reply();
    await routes.get("/api/settlement/agent-plans/accept")!(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "internal-error" });
    expect(req.log.error).toHaveBeenCalledWith({ consumeReason: "unexpected_refusal" }, expect.any(String));
    expect(JSON.stringify(req.log.error.mock.calls)).not.toContain(SECRET);
  });

  it("the setup kernel mismatch response does not reveal the configured local identity", async () => {
    mocks.getRepos.mockReturnValue({ kernels: {
      findById: () => ({ operatorAddress: WALLET }),
      findDeviceById: () => ({ kernelId: "requested-kernel" }),
    } });
    mocks.getKernelService.mockReturnValue({ kernelId: UNSAFE_ID });
    const routes = await handlers(setupRoutes);
    const res = reply();
    await routes.get("/api/setup/test-job")!(request({ body: { kernelId: "requested-kernel", deviceId: "device" } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: "gateway_does_not_run_this_kernel", ran: false, passed: false });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify(res.body)).not.toContain(UNSAFE_ID);
  });
});
