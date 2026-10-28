import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  getSafetyGateway, registerMachineAdapter, resetSafetyGateway, unregisterMachineAdapter,
  type KernelConfig, type MachineAdapter,
} from "@pcc/kernel";
import { schema } from "@pcc/store";
import type { CompositionStep } from "@pcc/spec";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { EXPLICIT_CREDENTIAL_REQUIRED } from "../auth/kernel-authority.js";
import * as authority from "../auth/kernel-authority.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { getJobFacade } from "../facades/index.js";
import { apiGate } from "../middleware/api-gate.js";
import { createProductionBinding, type JobSubmitter } from "../routes/compose.js";
import { jobSubmitRoutes } from "../routes/job-submit.js";
import { kernelRoutes } from "../routes/kernels.js";
import { setupRoutes } from "../routes/setup.js";
import { walletsRoutes } from "../routes/wallets.js";
import {
  initKernelService, resetKernelService, type KernelService,
} from "../services/kernel-service.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";

// The authority, admission check, routes, JobFacade and JobRunner are real.
// Only observers and the unrelated evidence-to-settlement pipeline are stubbed.
vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: () => true, canSiweVerify: () => true,
}));
vi.mock("../services/settlement-service.js", () => ({
  getSettlementService: () => ({ processEvidence: vi.fn().mockResolvedValue({}) }),
}));
vi.mock("../sentry.js", () => ({
  Sentry: {
    startSpanManual: (_options: unknown, cb: (span: object) => void) => cb({ end() {}, setStatus() {} }),
    addBreadcrumb: vi.fn(),
  },
}));
vi.mock("../sse/stream-hub.js", () => ({
  streamHub: { publish: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

const KERNEL = "kernel-local-run-authority";
const DEVICE = "device-local-run-authority";
const SECOND = "device-local-run-authority-second";
const CAPABILITY = "cap-local-run-authority";
const ADAPTER_TYPE = "local-run-authority-recording-bench";
type Account = ReturnType<typeof privateKeyToAccount>;
type Headers = Record<string, string>;

/** Completes without a background timer and records every physical command. */
class RecordingBench implements MachineAdapter {
  readonly type = "fdm" as const;
  readonly source: MachineAdapter["source"];
  readonly commands: string[] = [];
  private listeners: Array<Parameters<MachineAdapter["onEvidence"]>[0]> = [];
  constructor(readonly id: string, kernelId: string) {
    this.source = { deviceId: id, deviceType: "controller", kernelId, simulated: false };
  }
  async getStatus(): ReturnType<MachineAdapter["getStatus"]> { return "idle"; }
  async getProgress(): Promise<number> { return 100; }
  async execute(command: Parameters<MachineAdapter["execute"]>[0]): ReturnType<MachineAdapter["execute"]> {
    this.commands.push(command.type);
    if (command.type === "start") {
      for (const type of ["execution_started", "execution_completed"] as const) {
        for (const listener of this.listeners) {
          listener({ type, timestamp: new Date().toISOString(), source: this.source, payload: {} });
        }
      }
    }
    return { success: true };
  }
  onEvidence(cb: Parameters<MachineAdapter["onEvidence"]>[0]): void { this.listeners.push(cb); }
  async quiesceEvidence(): Promise<void> {}
  async dispose(): Promise<void> { this.listeners = []; }
}

let app: FastifyInstance;
let owner: Account;
let stranger: Account;
let admin: string;
let ownerSession: { token: string };
let ownerHeaders: Headers;
let svc: KernelService;
let services: KernelService[];
let benches: RecordingBench[];

const bearer = (credential: string): Headers => ({ authorization: `Bearer ${credential}` });
const claimed = (principal: string): Headers => bearer(provisionApiKey({ operatorId: principal }).rawKey);
const cookieOnly = (): Headers => ({ cookie: `pcc_session=${app.signCookie(ownerSession.token)}` });
const commands = () => benches.flatMap(bench => bench.commands);
const rowCount = () => getRepos().jobs.findAll().length;

beforeAll(() => {
  registerMachineAdapter(ADAPTER_TYPE, (device, _config, kernelId) => {
    const bench = new RecordingBench(device.id, kernelId);
    benches.push(bench);
    return bench;
  });
});
afterAll(() => unregisterMachineAdapter(ADAPTER_TYPE));

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("PCC_JOB_SUBMIT_QUEUE_ONLY", "false");
  admin = randomUUID();
  vi.stubEnv("PCC_ADMIN_KEY", admin);
  for (const name of ["KERNEL_CONFIG", "KERNEL_CONFIG_FILE", "KERNEL_ID", "PCC_GATEWAY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY"]) {
    vi.stubEnv(name, "");
    delete process.env[name];
  }
  closeStore();
  initStore({ seed: false });
  resetKernelService();
  resetSafetyGateway();
  services = [];
  benches = [];
  owner = privateKeyToAccount(generatePrivateKey());
  stranger = privateKeyToAccount(generatePrivateKey());
  app = Fastify({ logger: false, ajv: { customOptions: { coerceTypes: false } } });
  app.decorateRequest("userId", null);
  app.decorateRequest("operatorId", null);
  app.decorateRequest("apiKeyId", null);
  await app.register(cookie, { secret: randomUUID() });
  await app.register(apiGate);
  await app.register(siweAuthPlugin);
  await app.register(kernelRoutes);
  await app.register(jobSubmitRoutes);
  await app.register(setupRoutes);
  // This non-encapsulated proof resolver also reaches its earlier sibling routes.
  await app.register(walletsRoutes);
  await app.ready();
  ownerSession = await signIn(owner);
  const minted = await app.inject({ method: "POST", url: "/api/auth/session-key", headers: bearer(ownerSession.token) });
  expect(minted.statusCode).toBe(201);
  ownerHeaders = bearer(minted.json<{ api_key: string }>().api_key);
  const registered = await app.inject({ method: "POST", url: "/api/kernels", headers: ownerHeaders,
    payload: { id: KERNEL, name: "Local authority bench" } });
  expect(registered.statusCode).toBe(201);
  expect(getRepos().kernels.findById(KERNEL)?.operatorAddress).toBe(owner.address);
  seedCapability(KERNEL, CAPABILITY);
  configure([DEVICE]);
});

afterEach(async () => {
  // A test may return as soon as a job is accepted. Drain every real runner and
  // its mocked settlement continuation before closing the shared database.
  await vi.waitFor(() => {
    for (const service of services) {
      expect((service as unknown as { runningJobs: Map<string, unknown> }).runningJobs.size).toBe(0);
    }
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  await app?.close();
  for (const bench of benches) await bench.dispose();
  resetKernelService();
  resetSafetyGateway();
  closeStore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function signIn(account: Account) {
  const host = "localhost";
  const nonce = await app.inject({ method: "GET", url: "/api/auth/nonce", headers: { host } });
  expect(nonce.statusCode).toBe(200);
  const message = [
    `${host} wants you to sign in with your Ethereum account:`, account.address,
    "", "Sign in to PCC.", "", `URI: http://${host}`, "Version: 1", "Chain ID: 8453",
    `Nonce: ${nonce.json().nonce}`, `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const verified = await app.inject({ method: "POST", url: "/api/auth/verify", headers: { host },
    payload: { message, signature: await account.signMessage({ message }) } });
  expect(verified.statusCode).toBe(200);
  return verified.json<{ token: string }>();
}

async function selfLink(headers: Headers, account = owner): Promise<Headers> {
  const path = "/api/wallets/link-requests";
  const created = await app.inject({ method: "POST", url: path, headers,
    payload: { keyType: "secp256k1", address: account.address.toLowerCase(), chainId: 84532,
      role: "agent", label: "local-run-authority" } });
  expect(created.statusCode).toBe(201);
  const request = created.json<{ requestId: string; userCode: string; message: string }>();
  const proof = await app.inject({ method: "POST", url: `${path}/${request.requestId}/proof`,
    payload: { signature: await account.signMessage({ message: request.message }) } });
  expect(proof.statusCode).toBe(200);
  const approved = await app.inject({ method: "POST", url: `${path}/${request.requestId}/approve`, headers,
    payload: { userCode: request.userCode, decision: "approve", consentSha256: CONSENT_SHA256 } });
  expect(approved.statusCode).toBe(200);
  return { ...headers, "x-pcc-wallet": account.address };
}

function seedCapability(kernelId: string, id: string) {
  getRepos().capabilities.insert({ id, kernelId, type: "fdm", name: "Authority bench",
    materials: [], assuranceTiers: [0], pricing: { currency: "USDC", baseCost: "0", minimum: "0" },
    availability: {}, location: { lat: 0, lng: 0 } });
}

function seedDevice(id: string, kernelId = KERNEL) {
  getRepos().kernels.insertDevice({ id, kernelId, type: "machine", model: "Bench", firmware: "1",
    status: "idle", contributesToCapabilities: [], lastUpdated: new Date().toISOString(),
    adapterType: ADAPTER_TYPE });
}

function configure(ids: string[], config: KernelConfig = { kernelId: KERNEL, devices: [] }) {
  getStore().db.delete(schema.kernelDevices).run();
  for (const id of ids) seedDevice(id, config.kernelId);
  resetKernelService();
  svc = initKernelService(config);
  services.push(svc);
  return svc;
}

function submit(headers: Headers, extra: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: "/api/jobs/submit", headers,
    payload: { kernelId: KERNEL, stepId: "authority-step", capabilityId: CAPABILITY, deviceId: DEVICE, ...extra } });
}

function testJob(headers: Headers, extra: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: "/api/setup/test-job", headers,
    payload: { kernelId: KERNEL, deviceId: DEVICE, ...extra } });
}

async function accepted(headers: Headers, extra: Record<string, unknown> = {}) {
  const response = await submit(headers, extra);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ jobId: expect.any(String), deviceId: DEVICE, status: "accepted" });
  await vi.waitFor(() => expect(commands()).toEqual(["load_gcode", "start"]));
  await vi.waitFor(() => expect(getRepos().jobs.findById(response.json().jobId)?.status).toBe("completed"));
}

async function queued(headers: Headers, reason = "local_run_not_authorized", extra: Record<string, unknown> = {}) {
  const response = await submit(headers, extra);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ jobId: expect.any(String), deviceId: null, status: "queued", reason });
  expect(getRepos().jobs.findById(response.json().jobId)?.status).toBe("queued");
  expect(commands()).toEqual([]);
  return response;
}

describe("POST /api/jobs/submit local execution authority", () => {
  it("T1: a stranger's key queues with R1 and leaves the row queued", async () => {
    await queued(claimed(stranger.address));
  });
  it("T2: a provisioned key claiming the operator is not decide proof", async () => {
    await queued(claimed(owner.address));
  });
  it("T3: the operator's genuinely minted session key registers the kernel and runs its named device", async () => {
    await accepted(ownerHeaders);
  });
  it("T3b: the operator's SIWE bearer session runs", async () => {
    await accepted(bearer(ownerSession.token));
  });
  it("T3c: a self-linked provisioned key with X-PCC-Wallet runs", async () => {
    await accepted(await selfLink(claimed(owner.address)));
  });
  it("T4: the admin header with an API key runs", async () => {
    await accepted({ ...claimed(stranger.address), "x-admin-key": admin });
  });
  it("T4c: the admin header takes precedence over a cookie-only session", async () => {
    await accepted({ ...cookieOnly(), "x-admin-key": admin });
  });
  it("T5: the operator's cookie-only session queues", async () => {
    await queued(cookieOnly());
  });
  it("T6: a stranger's unknown device queues with R1 before device selection", async () => {
    const select = vi.spyOn(svc as unknown as { selectDevice(id?: string): string | null }, "selectDevice");
    await queued(claimed(stranger.address), "local_run_not_authorized", { deviceId: "not-here" });
    expect(select).not.toHaveBeenCalled();
  });
  it.each(["not-here", "", 0, false, {}, []])("T7: the operator's explicit device %j is refused, fails its row, and never selects a fallback", async deviceId => {
    configure([DEVICE, SECOND]);
    const preflight = vi.spyOn(getSafetyGateway(), "validateOnly");
    const response = await submit(ownerHeaders, { deviceId });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "device_not_runnable_here", message: "This gateway does not run the named device." });
    expect(getRepos().jobs.findAll()).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(preflight).not.toHaveBeenCalled();
    expect(commands()).toEqual([]);
    const refused = svc.submitJob({ jobId: "direct-unknown", kernelId: KERNEL, stepId: "s", deviceId: deviceId as string,
      localRunAuthority: "decide" });
    // No asynchronous admission work happens before the refusal value is returned.
    expect(preflight).not.toHaveBeenCalled();
    await expect(refused).resolves.toEqual({ jobId: "direct-unknown", deviceId: null, status: "refused", reason: "device_not_runnable_here" });
    expect(commands()).toEqual([]);
  });
  it.each([undefined, null])("T8: no named device (%j) runs exactly one loaded machine", async deviceId => {
    await accepted(ownerHeaders, { deviceId });
  });
  it("T9: no named device with two loaded machines queues R3", async () => {
    configure([DEVICE, SECOND]);
    await queued(ownerHeaders, "no_device_selected", { deviceId: undefined });
  });
  it("T10: no named device with no loaded machine queues R3", async () => {
    configure([]);
    await queued(ownerHeaders, "no_device_selected", { deviceId: undefined });
  });
  it("T16: a body localRunAuthority field cannot grant authority", async () => {
    await queued(claimed(stranger.address), "local_run_not_authorized", { localRunAuthority: "decide" });
  });
  it("T17: a 503 kernel authority read refusal queues instead of granting decide", async () => {
    failAuthorityReads();
    await queued(ownerHeaders);
  });
  it.each(["", 7, null, {}])("A1: invalid kernelId %j never invokes the authority read", async kernelId => {
    const check = vi.spyOn(authority, "refuseKernelAction");
    const response = await submit(ownerHeaders, { kernelId });
    expect(response.statusCode).toBe(400);
    expect(check).not.toHaveBeenCalled();
    expect(commands()).toEqual([]);
  });
  it("A1: the authority helper's 404 is not sent and the facade receives none", async () => {
    const call = vi.spyOn(getJobFacade(), "submit");
    const response = await submit(ownerHeaders, { kernelId: "missing-kernel" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "queued", reason: "not_local" });
    expect(call.mock.calls[0]?.[1]).toBe("none");
    expect(commands()).toEqual([]);
  });
});

describe("direct KernelService calls and composition", () => {
  it("T14: missing or none authority queues R1 before selection or admission", async () => {
    const select = vi.spyOn(svc as unknown as { selectDevice(id?: string): string | null }, "selectDevice");
    const preflight = vi.spyOn(getSafetyGateway(), "validateOnly");
    const input = { jobId: "direct-no-authority", kernelId: KERNEL, stepId: "s", deviceId: "not-here" };
    // @ts-expect-error Deliberately exercise an untyped caller omitting the required authority.
    await expect(svc.submitJob(input)).resolves.toEqual({ jobId: input.jobId, deviceId: null,
      status: "queued", reason: "local_run_not_authorized" });
    await expect(svc.submitJob({ ...input, localRunAuthority: "none" })).resolves.toEqual({ jobId: input.jobId,
      deviceId: null, status: "queued", reason: "local_run_not_authorized" });
    expect(select).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect(commands()).toEqual([]);
  });
  it("T18: the production binding passes exactly none and its real local step queues R1", async () => {
    const step: CompositionStep = { index: 0, capabilityId: CAPABILITY, kernelId: KERNEL, capabilityType: "fdm",
      operatorAddress: owner.address, estimatedPriceUSD: 0, estimatedDurationMs: 1, assuranceTier: 0, dependsOn: [] };
    const record = vi.fn<Parameters<JobSubmitter["submit"]>, ReturnType<JobSubmitter["submit"]>>().mockResolvedValue({ success: true,
      data: { jobId: "composition-record", deviceId: null, status: "queued" } });
    await createProductionBinding(() => ({ submit: record })).runStep!(step);
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ kernelId: KERNEL, capabilityId: CAPABILITY }), "none");
    const realSubmit = vi.spyOn(getJobFacade(), "submit");
    await createProductionBinding(() => getJobFacade()).runStep!(step);
    expect(realSubmit).toHaveBeenCalledWith(expect.objectContaining({ kernelId: KERNEL }), "none");
    const result = await realSubmit.mock.results[0]!.value;
    expect(result).toEqual({ success: true, timestamp: expect.any(Number), data: { jobId: expect.any(String), deviceId: null,
      status: "queued", reason: "local_run_not_authorized" } });
    expect(getRepos().jobs.findAll()).toEqual([expect.objectContaining({ status: "queued" })]);
    expect(commands()).toEqual([]);
  });
});

describe("POST /api/setup/test-job retains ownership and requires local decide", () => {
  it("T11: a claimed operator gets the exact R4 before device reads, refresh or insertion", async () => {
    const before = rowCount();
    const refresh = vi.spyOn(svc, "refreshDeviceFromDb");
    const findDevice = vi.spyOn(getRepos().kernels, "findDeviceById");
    const response = await testJob(claimed(owner.address), { deviceId: undefined });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden", reason: "operator_proof_required",
      message: "This needs the gateway admin secret, or proof that you control the kernel's operator wallet (wallet sign-in proof, WP-A). An API key's claimed identity is not proof.",
      ran: false, passed: false });
    expect(rowCount()).toBe(before);
    expect(findDevice).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(commands()).toEqual([]);
  });
  it("T12: a cookie-only session gets the unchanged explicit-credential R4", async () => {
    const response = await testJob(cookieOnly());
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ...EXPLICIT_CREDENTIAL_REQUIRED, ran: false, passed: false });
    expect(rowCount()).toBe(0);
    expect(commands()).toEqual([]);
  });
  it("T13: the operator's minted session key runs and passes on its real bench", async () => {
    const response = await testJob(ownerHeaders);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ deviceId: DEVICE, ran: true, passed: true, simulated: false, status: "completed" });
    expect(commands()).toEqual(["load_gcode", "start"]);
  });
  it("T13b: admin still needs the existing claimed-owner check", async () => {
    const refused = await testJob({ ...claimed(stranger.address), "x-admin-key": admin });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "not_kernel_operator", message: "Only this kernel's operator may run its test job.", ran: false, passed: false });
    expect(rowCount()).toBe(0);
    expect(commands()).toEqual([]);
    const accepted = await testJob({ ...claimed(owner.address), "x-admin-key": admin });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ ran: true, passed: true });
    expect(commands()).toEqual(["load_gcode", "start"]);
  });
  it("T13c: wallet proof does not replace the setup route's claimed-owner check", async () => {
    const response = await testJob(await selfLink(claimed(stranger.address)));
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "not_kernel_operator", message: "Only this kernel's operator may run its test job.", ran: false, passed: false });
    expect(rowCount()).toBe(0);
    expect(commands()).toEqual([]);
  });
  it.each(["queue-only", "stopped"])("T20: a claimed owner is refused before %s can bypass the local decide predicate", async state => {
    if (state === "queue-only") vi.stubEnv("PCC_JOB_SUBMIT_QUEUE_ONLY", "true");
    else getStore().db.insert(schema.operatorPolicies).values({ kernelId: KERNEL, policy: { emergencyStop: true }, updatedAt: new Date().toISOString() }).run();
    const refresh = vi.spyOn(svc, "refreshDeviceFromDb");
    const response = await testJob(claimed(owner.address));
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "forbidden", reason: "operator_proof_required", ran: false, passed: false });
    expect(refresh).not.toHaveBeenCalled();
    expect(rowCount()).toBe(0);
    expect(commands()).toEqual([]);
  });
  it("A5: an authority read error returns its exact 503 R4", async () => {
    failAuthorityReads();
    const response = await testJob(ownerHeaders);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "read_failed", message: "The kernel could not be read to check who operates it. Try again shortly.", ran: false, passed: false });
    expect(rowCount()).toBe(0);
    expect(commands()).toEqual([]);
  });
  it("A4: a runner disappearing after setup's loaded check gets the existing 409 body", async () => {
    const originalSubmit = svc.submitJob.bind(svc);
    vi.spyOn(svc, "submitJob").mockImplementation(params => {
      (svc as unknown as { runners: Map<string, unknown> }).runners.clear();
      return originalSubmit(params);
    });
    const response = await testJob(ownerHeaders);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "device_not_runnable_here",
      message: `This gateway does not run device "${DEVICE}" on kernel "${KERNEL}". Run the test job on the node that operates this kernel (for example \`pcc-node\`), which submits real evidence back to the gateway.`,
      kernelId: KERNEL, deviceId: DEVICE, ran: false, passed: false });
    expect(commands()).toEqual([]);
  });
  it("A5: an unavailable service preserves device-check order and its existing 503", async () => {
    resetKernelService();
    const headers = claimed(owner.address);
    const missing = await testJob(headers, { deviceId: undefined });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: "device_id_required", ran: false, passed: false });
    const response = await testJob(headers);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "kernel_service_not_ready", message: "KernelService is not initialized", ran: false, passed: false });
    expect(rowCount()).toBe(0);
    expect(commands()).toEqual([]);
  });
});

describe("hosted and generated configuration replies stay unchanged", () => {
  it("T19: without explicit config both submitters queue, and a remote setup test keeps its 409", async () => {
    resetKernelService();
    svc = initKernelService();
    services.push(svc);
    expect(svc.hasExplicitConfig).toBe(false);
    await queued(claimed(stranger.address), "no_configured_local_kernel");
    await queued(ownerHeaders, "no_configured_local_kernel");
    const response = await testJob(claimed(owner.address));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "gateway_does_not_run_this_kernel",
      message: `This gateway runs kernel "kernel_dev_001", not "${KERNEL}". Run the test job on the node that operates this kernel (for example \`pcc-node\`), which submits real evidence back to the gateway.`,
      kernelId: KERNEL, ran: false, passed: false });
    expect(commands()).toEqual([]);
  });
  it.each([false, true])("T19b: placeholder setup bypasses decide with explicit config=%s", async explicit => {
    const kernelId = "kernel_dev_001";
    getRepos().kernels.insert({ ...getRepos().kernels.findById(KERNEL)!, id: kernelId });
    seedCapability(kernelId, "cap-placeholder");
    resetKernelService();
    svc = initKernelService(explicit ? { kernelId, devices: [{ id: "dev_fdm_001", type: "machine", adapterType: ADAPTER_TYPE, config: {} }] } : undefined);
    services.push(svc);
    seedDevice("dev_fdm_001", kernelId);
    const response = await testJob(claimed(owner.address), { kernelId, deviceId: "dev_fdm_001" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jobId: expect.any(String), deviceId: null, status: "queued",
      reason: "no_configured_local_kernel", ran: false, passed: false, duration: expect.any(Number) });
    expect(getRepos().jobs.findById(response.json().jobId)?.status).toBe("queued");
    expect(commands()).toEqual([]);
  });
  it("T19b: a generated non-placeholder config still bypasses decide and returns today's queue reply", async () => {
    vi.stubEnv("KERNEL_ID", KERNEL);
    resetKernelService();
    svc = initKernelService();
    services.push(svc);
    expect(svc.hasExplicitConfig).toBe(false);
    expect(svc.kernelId).toBe(KERNEL);
    seedDevice("dev_fdm_001");
    const response = await testJob(claimed(owner.address), { deviceId: "dev_fdm_001" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jobId: expect.any(String), deviceId: null, status: "queued",
      reason: "no_configured_local_kernel", ran: false, passed: false, duration: expect.any(Number) });
    expect(getRepos().jobs.findById(response.json().jobId)?.status).toBe("queued");
    expect(commands()).toEqual([]);
  });
});

function failAuthorityReads() {
  const db = getStore().db;
  const select = db.select.bind(db);
  vi.spyOn(db, "select").mockImplementation(((fields?: Record<string, unknown>) => {
    if (fields && "operatorAddress" in fields) throw new Error("authority read unavailable");
    return select(fields as never);
  }) as typeof db.select);
}
