/**
 * N71, its owner and echo parts (operator item 86), in WP-C next to WP-C's
 * kernel-owner guard. Reproduced at 1cdfebcc (WP-C stacked on #326) before any
 * code changed.
 *
 * - POST /api/devices/register checked only that the kernel EXISTS. Any key could
 *   register a device, with its connection config, on another operator's kernel.
 *   WP-C R3 had closed the same hole on POST /api/setup/register-device.
 * - POST /api/setup/register-device echoed the stored device row back, adapterConfig
 *   included.
 *
 * Now /api/devices/register needs a present actor (401, rule 7) who owns the named
 * kernel (403 not_kernel_owner) before any write. An unknown kernel still answers
 * 400 kernel_not_found, as before. Neither register route echoes adapterConfig.
 * The read side (GET /api/devices/:kernelId) is fixed in fix/n71-device-credentials.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.PCC_SEED_DATA = "false";

const A = "device-owner-a@x.test";
const B = "other-b@x.test";
const SECRET = "DEVICE-CRED-owner-4c1e";

let app: FastifyInstance;
let getRepos: typeof import("../db.js").getRepos;
let generateApiKey: typeof import("../auth/api-key-auth.js").generateApiKey;
let seq = 0;
let ipSeq = 10;

function seedKey(operatorId: string): string {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: `n71-owner-key-${++seq}`,
    keyHash,
    keyPrefix,
    operatorId,
    scopes: JSON.stringify(["operator"]),
    rateLimit: "1000/hour",
    usageCount: "0",
    createdAt: new Date().toISOString(),
  } as never);
  return rawKey;
}

const inj = (method: string, url: string, raw: string, payload?: unknown) =>
  app.inject({
    method: method as never,
    url,
    remoteAddress: `10.99.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    payload: payload as never,
    headers: { authorization: `Bearer ${raw}` },
  });

const device = (kernelId: string, id: string) => ({
  kernelId,
  id,
  type: "printer",
  model: "Model X",
  adapterType: "http",
  adapterConfig: { host: "10.0.0.7", apiKey: SECRET },
  capabilities: ["print"],
});

let keyA: string;
let keyB: string;
let kernelA: string;

beforeAll(async () => {
  const server = await import("../server.js");
  ({ getRepos } = await import("../db.js"));
  ({ generateApiKey } = await import("../auth/api-key-auth.js"));
  app = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();
  keyA = seedKey(A);
  keyB = seedKey(B);
  kernelA = `kernel-n71-owner-${Date.now().toString(36)}`;
  const k = await inj("POST", "/api/kernels", keyA, { id: kernelA, name: "A's workshop" });
  expect(k.statusCode, k.body).toBeLessThan(300);
});

afterAll(async () => {
  await app?.close();
});

describe("N71: only the kernel's owner registers devices on it, and no register route echoes the config", () => {
  it("[neg] another key cannot register a device on A's kernel via /api/devices/register (403, nothing written)", async () => {
    const res = await inj("POST", "/api/devices/register", keyB, device(kernelA, `dev-b-${++seq}`));
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_kernel_owner");
    expect(getRepos().kernels.findDevicesByKernel(kernelA)).toHaveLength(0);
  });

  it("[neg] the owner's /api/setup/register-device response carries no adapterConfig", async () => {
    const res = await inj("POST", "/api/setup/register-device", keyA, {
      kernelId: kernelA,
      deviceId: `dev-setup-${++seq}`,
      type: "printer",
      model: "Model X",
      adapterType: "generic-http",
      adapterConfig: { host: "10.0.0.8", apiKey: SECRET },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain("adapterConfig");
  });

  it("control: the owner registers a device via /api/devices/register; the row keeps its config for dispatch", async () => {
    const id = `dev-a-${++seq}`;
    const res = await inj("POST", "/api/devices/register", keyA, device(kernelA, id));
    expect(res.statusCode, res.body).toBe(200);
    const row = (getRepos().kernels.findDevicesByKernel(kernelA) as Array<{ id: string; adapterConfig?: string | null }>).find(
      (d) => d.id === id,
    );
    expect(String(row?.adapterConfig ?? "")).toContain(SECRET);
  });

  it("control: an unknown kernel still answers 400 kernel_not_found (unchanged)", async () => {
    const res = await inj("POST", "/api/devices/register", keyA, device("kernel-does-not-exist", `dev-x-${++seq}`));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("kernel_not_found");
  });
});

describe("N71: rule 7 at the handler (no apiGate in front, no actor)", () => {
  it("[neg] /api/devices/register with no actor is 401 and writes nothing", async () => {
    const Fastify = (await import("fastify")).default;
    const { jobSubmitRoutes } = await import("../routes/job-submit.js");
    const bare = Fastify({ logger: false });
    await bare.register(jobSubmitRoutes);
    await bare.ready();
    try {
      const id = `dev-noactor-${++seq}`;
      const res = await bare.inject({ method: "POST", url: "/api/devices/register", payload: device(kernelA, id) });
      expect(res.statusCode).toBe(401);
      expect((getRepos().kernels.findDevicesByKernel(kernelA) as Array<{ id: string }>).map((d) => d.id)).not.toContain(id);
    } finally {
      await bare.close();
    }
  });
});

