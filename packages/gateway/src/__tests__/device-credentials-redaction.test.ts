/**
 * N71 (operator item 86): device credentials were readable for ANY kernel with any
 * key. Reproduced at #326's head f76e93d5 before any code changed.
 *
 * `GET /api/devices/:kernelId` returned the raw device rows, adapterConfig
 * included. That is the connection config a device registered with: hosts,
 * tokens and API keys. Any key could read any kernel's config, and
 * `POST /api/devices/register` echoed the stored adapterConfig back. The kernel
 * route `GET /api/kernels/:kernelId/devices` already returned a public view.
 *
 * Now both /api/devices routes answer with that same public view: id, type,
 * model, status, healthStatus, adapterType and capabilities, and never
 * adapterConfig. This is WP-A-independent. Who may REGISTER a device on a kernel
 * (the owner check) follows WP-A and lives in WP-C, next to its kernel-owner guard.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.PCC_SEED_DATA = "false";

const A = "device-owner-a@x.test";
const B = "other-b@x.test";
const SECRET = "DEVICE-CRED-7f3a9c";

let app: FastifyInstance;
let getRepos: typeof import("../db.js").getRepos;
let generateApiKey: typeof import("../auth/api-key-auth.js").generateApiKey;
let seq = 0;
let ipSeq = 10;

function seedKey(operatorId: string): string {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: `n71-key-${++seq}`,
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
    remoteAddress: `10.97.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    payload: payload as never,
    headers: { authorization: `Bearer ${raw}` },
  });

let keyA: string;
let keyB: string;
let kernelId: string;
let registerBody = "";

beforeAll(async () => {
  const server = await import("../server.js");
  ({ getRepos } = await import("../db.js"));
  ({ generateApiKey } = await import("../auth/api-key-auth.js"));
  app = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();
  keyA = seedKey(A);
  keyB = seedKey(B);
  kernelId = `kernel-n71-${Date.now().toString(36)}`;
  const k = await inj("POST", "/api/kernels", keyA, { id: kernelId, name: "A's workshop" });
  expect(k.statusCode, k.body).toBeLessThan(300);
  const reg = await inj("POST", "/api/devices/register", keyA, {
    kernelId,
    id: `dev-${kernelId}`,
    type: "printer",
    model: "Model X",
    adapterType: "http",
    adapterConfig: { host: "10.0.0.5", apiKey: SECRET },
    capabilities: ["print"],
  });
  expect(reg.statusCode, reg.body).toBeLessThan(300);
  registerBody = reg.body;
});

afterAll(async () => {
  await app?.close();
});

describe("N71: no device configuration or credential leaves the API", () => {
  it("[neg] GET /api/devices/:kernelId shows another key no adapterConfig and no credential", async () => {
    const res = await inj("GET", `/api/devices/${kernelId}`, keyB);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain("adapterConfig");
  });

  it("[neg] the kernel's own owner gets the public view too (the config stays on the device)", async () => {
    const res = await inj("GET", `/api/devices/${kernelId}`, keyA);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain("adapterConfig");
  });

  it("[neg] POST /api/devices/register does not echo the stored adapterConfig", async () => {
    expect(registerBody).not.toContain(SECRET);
    expect(registerBody).not.toContain("adapterConfig");
  });

  it("control: the public view keeps what callers use (the same shape as GET /api/kernels/:kernelId/devices)", async () => {
    const mine = (await inj("GET", `/api/devices/${kernelId}`, keyB)).json() as { devices: Array<Record<string, unknown>> };
    const pub = (await inj("GET", `/api/kernels/${kernelId}/devices`, keyB)).json() as { devices: Array<Record<string, unknown>> };
    expect(mine.devices.length).toBe(1);
    expect(mine.devices).toEqual(pub.devices);
    expect(mine.devices[0]).toMatchObject({ id: `dev-${kernelId}`, type: "printer", model: "Model X", adapterType: "http" });
  });

  it("control: the stored row still holds the config, for dispatch", () => {
    const rows = getRepos().kernels.findDevicesByKernel(kernelId) as Array<{ adapterConfig?: string | null }>;
    expect(String(rows[0]?.adapterConfig ?? "")).toContain(SECRET);
  });
});
