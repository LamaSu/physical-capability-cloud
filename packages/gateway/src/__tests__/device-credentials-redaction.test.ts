/**
 * N71 (operator item 86): stored device configuration, and configuration the
 * gateway holds for itself, were readable through the API.
 *
 * Round 1 (reproduced at #326's head f76e93d5 before any code changed):
 * `GET /api/devices/:kernelId` returned the raw device rows, adapterConfig
 * included. That is the connection config a device registered with: hosts,
 * tokens and API keys. Any key could read any kernel's config, and
 * `POST /api/devices/register` echoed the stored adapterConfig back. The kernel
 * route `GET /api/kernels/:kernelId/devices` already returned a public view.
 * Now `GET /api/devices/:kernelId` answers with that public view (id, type,
 * model, status, healthStatus, adapterType, capabilities: seven fields).
 *
 * `POST /api/devices/register` is NOT the same shape. It answers with an explicit
 * registration view that carries more fields (id, kernelId, type, model, firmware,
 * status, healthStatus, adapterType, capabilities, contributesToCapabilities,
 * lastUpdated, lastHealthCheck, emits) and never adapterConfig.
 *
 * Round 2 (astra's verdict on pack 83): the same material was still readable
 * through other doors, reproduced below before they were closed:
 *   - GET /api/setup/detect echoed KERNEL_CONFIG (the server's own device
 *     config, API keys and URL credentials included) in `envVars`;
 *   - POST /api/setup/validate defaults to KERNEL_CONFIG and put URLs, hosts,
 *     endpoints and URIs (and JSON parse errors, which quote the source) into
 *     its messages;
 *   - POST /api/setup/register-device returned the whole stored row, including
 *     the PRESERVED adapterConfig on an update that omits it;
 *   - POST /api/devices/register spread the stored row, so any column added
 *     later would have become public;
 *   - POST /api/devices/:deviceId/health forwarded adapter exception text.
 *
 * Scope: this branch carries REDACTION only. WHO may register or update a device
 * (kernel/device ownership) is WP-C's (PR #445). Where a test below drives that
 * path it asserts only what the response contains, not whether the caller was
 * allowed.
 *
 * Not changed: POST /api/setup/generate-config echoes the caller's OWN input
 * (an apiKey the caller just sent). That is not a stored or server-held
 * credential, so it is not covered by "never leaves the API" below; the control
 * test at the end pins that behaviour.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.PCC_SEED_DATA = "false";

const A = "device-owner-a@x.test";
const B = "other-b@x.test";
const SECRET = "DEVICE-CRED-7f3a9c";
/** Synthetic sentinel. Every value below that must never leave the API starts with it. */
const SENTINEL = "N71-SENTINEL";
/** A column the device row does not have today. */
const FUTURE = `${SENTINEL}-future-column`;

/** Every column of the device row except adapterConfig, spelled out (sorted). */
const REGISTRATION_VIEW_KEYS = [
  "adapterType",
  "capabilities",
  "contributesToCapabilities",
  "emits",
  "firmware",
  "healthStatus",
  "id",
  "kernelId",
  "lastHealthCheck",
  "lastUpdated",
  "model",
  "status",
  "type",
];

let app: FastifyInstance;
let getRepos: typeof import("../db.js").getRepos;
let generateApiKey: typeof import("../auth/api-key-auth.js").generateApiKey;
let getKernelService: typeof import("../services/kernel-service.js").getKernelService;
let MockFDMAdapter: typeof import("@pcc/kernel").MockFDMAdapter;
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

/** Run `fn` with the given env vars set (undefined = unset); every one is restored afterwards. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const name of Object.keys(vars)) saved[name] = process.env[name];
  try {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** None of the named values may appear anywhere in the body; the name labels the failure. */
function expectNoLeak(body: string, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) expect(body, name).not.toContain(value);
}

const bodyOf = (res: LightMyRequestResponse) => res.json() as Record<string, any>;
const deviceIdsOf = (res: LightMyRequestResponse) =>
  (res.json() as { devices: Array<{ id: string }> }).devices.map((d) => d.id);

let keyA: string;
let keyB: string;
let kernelId: string;
let deviceId: string;
let registerBody = "";

beforeAll(async () => {
  const server = await import("../server.js");
  ({ getRepos } = await import("../db.js"));
  ({ generateApiKey } = await import("../auth/api-key-auth.js"));
  ({ getKernelService } = await import("../services/kernel-service.js"));
  ({ MockFDMAdapter } = await import("@pcc/kernel"));
  app = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();
  keyA = seedKey(A);
  keyB = seedKey(B);
  kernelId = `kernel-n71-${Date.now().toString(36)}`;
  deviceId = `dev-${kernelId}`;
  const k = await inj("POST", "/api/kernels", keyA, { id: kernelId, name: "A's workshop" });
  expect(k.statusCode, k.body).toBeLessThan(300);
  const reg = await inj("POST", "/api/devices/register", keyA, {
    kernelId,
    id: deviceId,
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

// ─────────────────────────────────────────────────────────────────────────────
// /api/devices: the stored adapterConfig never leaves
// ─────────────────────────────────────────────────────────────────────────────

describe("N71: stored device configuration never leaves the /api/devices routes", () => {
  it("[neg] GET /api/devices/:kernelId shows another key no adapterConfig and no credential", async () => {
    const res = await inj("GET", `/api/devices/${kernelId}`, keyB);
    expect(res.statusCode).toBe(200);
    expect(deviceIdsOf(res)).toContain(deviceId);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain("adapterConfig");
  });

  it("[neg] the kernel's own owner gets the public view too (the config stays on the device)", async () => {
    // An error body is credential-free too, so the status and the device's identity
    // come first: without them this test would also pass on a 403/500 (astra, MEDIUM 4).
    const res = await inj("GET", `/api/devices/${kernelId}`, keyA);
    expect(res.statusCode).toBe(200);
    expect(deviceIdsOf(res)).toContain(deviceId);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain("adapterConfig");
  });

  it("[neg] POST /api/devices/register does not echo the stored adapterConfig", () => {
    const reg = JSON.parse(registerBody) as { device?: { id?: string } };
    expect(reg.device?.id).toBe(deviceId);
    expect(registerBody).not.toContain(SECRET);
    expect(registerBody).not.toContain("adapterConfig");
  });

  it("POST /api/devices/register answers with an explicit registration view (exact key set)", () => {
    const { device } = JSON.parse(registerBody) as { device: Record<string, unknown> };
    expect(Object.keys(device).sort()).toEqual(REGISTRATION_VIEW_KEYS);
    expect(device).toMatchObject({
      id: deviceId,
      kernelId,
      type: "printer",
      model: "Model X",
      adapterType: "http",
      status: "idle",
      capabilities: ["print"],
    });
  });

  it("[neg] a column added to the device row later is not published by POST /api/devices/register", async () => {
    // The repository is made to return a row with a column that does not exist today.
    // A rest-spread response would publish it; an explicit view cannot.
    const kernels = getRepos().kernels;
    const realInsert = kernels.insertDevice.bind(kernels);
    const spy = vi
      .spyOn(kernels, "insertDevice")
      .mockImplementation((d) => ({ ...realInsert(d), futureColumn: FUTURE }) as never);
    try {
      const res = await inj("POST", "/api/devices/register", keyA, {
        kernelId,
        id: `dev-future-${kernelId}`,
        type: "printer",
        model: "Model Y",
        adapterType: "http",
        adapterConfig: { apiKey: SECRET },
      });
      expect(res.statusCode, res.body).toBe(200);
      const { device } = bodyOf(res);
      expect(device.id).toBe(`dev-future-${kernelId}`);
      expect(Object.keys(device).sort()).toEqual(REGISTRATION_VIEW_KEYS);
      expect(res.body).not.toContain(FUTURE);
      expect(res.body).not.toContain(SECRET);
      expect(res.body).not.toContain("adapterConfig");
    } finally {
      spy.mockRestore();
    }
  });

  it("control: the public view keeps what callers use (the same shape as GET /api/kernels/:kernelId/devices)", async () => {
    const mine = (await inj("GET", `/api/devices/${kernelId}`, keyB)).json() as { devices: Array<Record<string, unknown>> };
    const pub = (await inj("GET", `/api/kernels/${kernelId}/devices`, keyB)).json() as { devices: Array<Record<string, unknown>> };
    expect(mine.devices.length).toBeGreaterThanOrEqual(1);
    expect(mine.devices).toEqual(pub.devices);
    expect(mine.devices.find((d) => d.id === deviceId)).toMatchObject({ id: deviceId, type: "printer", model: "Model X", adapterType: "http" });
  });

  it("control: the stored row still holds the config, for dispatch", () => {
    const rows = getRepos().kernels.findDevicesByKernel(kernelId) as Array<{ id: string; adapterConfig?: string | null }>;
    expect(String(rows.find((r) => r.id === deviceId)?.adapterConfig ?? "")).toContain(SECRET);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/devices/:deviceId/health: the error channel
// ─────────────────────────────────────────────────────────────────────────────

describe("N71: the device health error channel does not forward credentials", () => {
  // A machine adapter whose status call fails with a message that quotes the URL it
  // was configured with, userinfo included (fetch itself does this for URLs that
  // carry credentials). The in-tree adapters swallow their own errors, but
  // MachineAdapter.getStatus is allowed to throw and the service forwards the message.
  const ADAPTER_ERROR = `connect failed for http://u:${SENTINEL}@printer.invalid:5000/api/printer?apikey=${SENTINEL}-q`;
  const DEVICE = "dev_fdm_001"; // the default mock machine of the gateway's KernelService

  it("[neg] POST /api/devices/:deviceId/health strips URL credentials from an adapter exception", async () => {
    const spy = vi.spyOn(MockFDMAdapter.prototype, "getStatus").mockRejectedValue(new Error(ADAPTER_ERROR));
    try {
      const res = await inj("POST", `/api/devices/${DEVICE}/health`, keyB);
      expect(res.statusCode).toBe(200);
      const body = bodyOf(res);
      expect(body.healthy).toBe(false);
      expect(String(body.details)).toContain("printer.invalid"); // still a usable diagnostic
      expect(res.body).not.toContain(SENTINEL);
    } finally {
      spy.mockRestore();
    }
  });

  it("[neg] KernelService.checkDeviceHealth does not return URL credentials in details", async () => {
    const spy = vi.spyOn(MockFDMAdapter.prototype, "getStatus").mockRejectedValue(new Error(ADAPTER_ERROR));
    try {
      const result = await getKernelService().checkDeviceHealth(DEVICE);
      expect(result.healthy).toBe(false);
      expect(result.details).toContain("printer.invalid");
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
    } finally {
      spy.mockRestore();
    }
  });

  it("[neg] the facade scrubs details whatever the service returned", async () => {
    const spy = vi
      .spyOn(getKernelService(), "checkDeviceHealth")
      .mockResolvedValue({ healthy: false, details: ADAPTER_ERROR });
    try {
      const res = await inj("POST", `/api/devices/${DEVICE}/health`, keyB);
      expect(res.statusCode).toBe(200);
      expect(bodyOf(res).healthy).toBe(false);
      expect(res.body).not.toContain(SENTINEL);
    } finally {
      spy.mockRestore();
    }
  });

  it("control: a healthy device still reports its status, and an unknown one is device_not_found", async () => {
    const ok = bodyOf(await inj("POST", `/api/devices/${DEVICE}/health`, keyB));
    expect(ok.healthy).toBe(true);
    expect(ok.details).toBe("idle");
    const missing = bodyOf(await inj("POST", "/api/devices/dev-n71-missing/health", keyB));
    expect(missing).toEqual({ healthy: false, details: "device_not_found" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/setup/detect and /api/setup/validate: server-held configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Values that live in the SERVER's KERNEL_CONFIG; none may appear in any response. */
const HELD = {
  octoUserinfo: `${SENTINEL}-octo-userinfo`,
  octoHost: `${SENTINEL}-octo-host`,
  octoQuery: `${SENTINEL}-octo-query`,
  octoApiKey: `${SENTINEL}-octo-apikey`,
  modbusHost: `${SENTINEL}-modbus-host`,
  opcuaEndpoint: `${SENTINEL}-opcua-endpoint`,
  silaUrl: `${SENTINEL}-sila-url`,
  ippUri: `${SENTINEL}-ipp-uri`,
  ippBadUserinfo: `${SENTINEL}-ipp-bad-userinfo`,
  adapterTypeTypo: `${SENTINEL}-adapter-type`,
  deviceTypeTypo: `${SENTINEL}-device-type`,
};

/** One device per adapter kind, plus three misconfigured ones (a wrong adapterType, type and ipp uri). */
const HELD_CONFIG = JSON.stringify({
  kernelId: "kernel-n71-env",
  devices: [
    {
      id: "dev_octo",
      type: "machine",
      adapterType: "octoprint",
      config: { url: `http://user:${HELD.octoUserinfo}@${HELD.octoHost}.invalid:5000/api?token=${HELD.octoQuery}`, apiKey: HELD.octoApiKey },
    },
    { id: "dev_modbus", type: "sensor", adapterType: "modbus", config: { host: `${HELD.modbusHost}.invalid`, port: 502 } },
    { id: "dev_opcua", type: "machine", adapterType: "opcua", config: { endpoint: `opc.tcp://${HELD.opcuaEndpoint}.invalid:4840` } },
    { id: "dev_sila", type: "machine", adapterType: "sila", config: { url: `https://${HELD.silaUrl}.invalid` } },
    { id: "dev_ipp", type: "machine", adapterType: "ipp", config: { uri: `ipp://${HELD.ippUri}.invalid:631/ipp/print` } },
    { id: "dev_ipp_bad", type: "machine", adapterType: "ipp", config: { uri: `http://user:${HELD.ippBadUserinfo}@printer.invalid/ipp` } },
    { id: "dev_bad_adapter", type: "machine", adapterType: `http://user:${HELD.adapterTypeTypo}@printer.invalid`, config: {} },
    { id: "dev_bad_type", type: `http://user:${HELD.deviceTypeTypo}@printer.invalid`, adapterType: "mock", config: {} },
  ],
});

type Check = { name: string; status: string; message: string };

describe("N71: GET /api/setup/detect does not return server-held configuration", () => {
  it("[neg] KERNEL_CONFIG is reported as present, never as its value", async () => {
    await withEnv({ KERNEL_CONFIG: HELD_CONFIG }, async () => {
      const res = await inj("GET", "/api/setup/detect", keyB);
      expect(res.statusCode).toBe(200);
      const entry = (bodyOf(res).envVars as Array<{ name: string; set: boolean; value?: string }>).find(
        (v) => v.name === "KERNEL_CONFIG",
      );
      expect(entry).toMatchObject({ name: "KERNEL_CONFIG", set: true });
      expect(entry?.value).toBeUndefined();
      expectNoLeak(res.body, HELD);
    });
  });

  it("[neg] a URL-valued variable does not carry its credentials out", async () => {
    const userinfo = `${SENTINEL}-facilitator-userinfo`;
    const query = `${SENTINEL}-facilitator-query`;
    await withEnv({ X402_FACILITATOR_URL: `https://svc:${userinfo}@facilitator.invalid/v1?apikey=${query}` }, async () => {
      const res = await inj("GET", "/api/setup/detect", keyB);
      expect(res.statusCode).toBe(200);
      const entry = (bodyOf(res).envVars as Array<{ name: string; set: boolean; value?: string }>).find(
        (v) => v.name === "X402_FACILITATOR_URL",
      );
      expect(entry?.set).toBe(true);
      expect(entry?.value).toContain("facilitator.invalid"); // the location itself is still useful
      expectNoLeak(res.body, { userinfo, query });
    });
  });

  it("control: a variable that is not a secret still shows its value", async () => {
    const res = await inj("GET", "/api/setup/detect", keyB);
    expect(res.statusCode).toBe(200);
    const nodeEnv = (bodyOf(res).envVars as Array<{ name: string; value?: string }>).find((v) => v.name === "NODE_ENV");
    expect(nodeEnv?.value).toBe("test");
  });
});

describe("N71: POST /api/setup/validate does not echo connection values", () => {
  it("[neg] validating the server's own KERNEL_CONFIG (no body) names devices and fields, never their values", async () => {
    await withEnv({ KERNEL_CONFIG: HELD_CONFIG }, async () => {
      const res = await inj("POST", "/api/setup/validate", keyB, {});
      expect(res.statusCode).toBe(200);
      const body = bodyOf(res);
      // The checks really ran against that config, one branch each ...
      const byName = new Map((body.checks as Check[]).map((c) => [c.name, c]));
      expect(byName.get("device:dev_octo:url")?.status).toBe("pass");
      expect(byName.get("device:dev_modbus:host")?.status).toBe("pass");
      expect(byName.get("device:dev_opcua:endpoint")?.status).toBe("pass");
      expect(byName.get("device:dev_sila:url")?.status).toBe("pass");
      expect(byName.get("device:dev_ipp:uri")?.status).toBe("pass");
      expect(byName.get("device:dev_ipp_bad:uri")?.status).toBe("fail");
      expect(byName.get("device:dev_bad_adapter:adapterType")?.status).toBe("fail");
      expect(byName.get("device:dev_bad_type:type")?.status).toBe("fail");
      expect(body.valid).toBe(false);
      // ... and none of the connection values (or misplaced ones) came back.
      expectNoLeak(res.body, HELD);
    });
  });

  it("[neg] a config the caller sends is not echoed back either (one policy, whatever the source)", async () => {
    const res = await inj("POST", "/api/setup/validate", keyB, { config: HELD_CONFIG });
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res);
    expect((body.checks as Check[]).some((c) => c.name === "device:dev_octo:url" && c.status === "pass")).toBe(true);
    expectNoLeak(res.body, HELD);
  });

  // V8's JSON.parse error QUOTES the text it choked on: all of it when the source is
  // short (under 21 characters), else ten characters either side of the error. So a
  // value that is not JSON (a key pasted into the wrong variable) comes back whole, and
  // a stray token next to a secret brings the secret's neighbours with it.
  const SHORT_SOURCE = `u:${SENTINEL}@h`;
  const WINDOWED = "N71-KEY";
  const WINDOWED_SOURCE = `{"kernelId":"k","apiKey": ${WINDOWED}}`;

  const expectUnparseable = (res: LightMyRequestResponse) => {
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res);
    expect(body.valid).toBe(false);
    expect((body.checks as Check[]).find((c) => c.name === "config_parseable")?.status).toBe("fail");
    expect(body.errors.length).toBeGreaterThan(0);
  };

  it("[neg] a JSON parse error does not quote the server's KERNEL_CONFIG (a value that is not JSON)", async () => {
    await withEnv({ KERNEL_CONFIG: SHORT_SOURCE }, async () => {
      const res = await inj("POST", "/api/setup/validate", keyB, {});
      expectUnparseable(res);
      expect(res.body).not.toContain(SENTINEL);
    });
  });

  it("[neg] a JSON parse error does not quote the server's KERNEL_CONFIG (a stray token next to a secret)", async () => {
    await withEnv({ KERNEL_CONFIG: WINDOWED_SOURCE }, async () => {
      const res = await inj("POST", "/api/setup/validate", keyB, {});
      expectUnparseable(res);
      expect(res.body).not.toContain(WINDOWED);
    });
  });

  it("[neg] a JSON parse error does not quote a config the caller sent", async () => {
    const res = await inj("POST", "/api/setup/validate", keyB, { config: SHORT_SOURCE });
    expectUnparseable(res);
    expect(res.body).not.toContain(SENTINEL);
  });

  it("control: the diagnostics that name a device and a field are kept", async () => {
    const res = await inj("POST", "/api/setup/validate", keyB, {
      config: JSON.stringify({
        kernelId: "kernel-n71-ctl",
        devices: [
          { id: "dev_ctl_octo", type: "machine", adapterType: "octoprint", config: { url: "http://printer.invalid:5000" } },
          { id: "dev_ctl_ipp", type: "machine", adapterType: "ipp", config: {} },
        ],
      }),
    });
    const body = bodyOf(res);
    const byName = new Map((body.checks as Check[]).map((c) => [c.name, c]));
    expect(byName.get("kernel_id")?.message).toContain("kernel-n71-ctl");
    expect(byName.get("device:dev_ctl_octo:apiKey")).toMatchObject({ status: "warn" });
    expect(byName.get("device:dev_ctl_octo:apiKey")?.message).toContain("dev_ctl_octo");
    expect(byName.get("device:dev_ctl_ipp:uri")).toMatchObject({ status: "fail" });
    expect(byName.get("device:dev_ctl_ipp:uri")?.message).toContain("dev_ctl_ipp");
    expect(body.valid).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/setup/register-device: the upsert answers with a credential-free view
// ─────────────────────────────────────────────────────────────────────────────

describe("N71: POST /api/setup/register-device returns a credential-free device view", () => {
  const SETUP_SECRET = `${SENTINEL}-setup-adapter-config`;
  const REPLACED_SECRET = `${SENTINEL}-setup-adapter-config-replaced`;
  let setupDeviceId: string;
  let createBody: Record<string, any>;

  const setupBody = (extra: Record<string, unknown> = {}) => ({
    kernelId,
    deviceId: setupDeviceId,
    type: "sensor",
    adapterType: "mock",
    ...extra,
  });
  const storedConfig = () =>
    String(getRepos().kernels.findDeviceById(setupDeviceId)?.adapterConfig ?? "");

  beforeAll(async () => {
    setupDeviceId = `dev-setup-${kernelId}`;
    // A registers device D with a credential.
    const res = await inj("POST", "/api/setup/register-device", keyA, {
      ...setupBody({ model: "Setup Sensor", adapterConfig: { apiKey: SETUP_SECRET } }),
    });
    expect(res.statusCode, res.body).toBe(201);
    createBody = bodyOf(res);
  });

  it("[neg] the create response (201) names the device and carries no adapterConfig", () => {
    expect(createBody).toMatchObject({ registered: true, action: "created" });
    expect(createBody.device).toMatchObject({ id: setupDeviceId, kernelId, type: "sensor", model: "Setup Sensor", adapterType: "mock" });
    expect(Object.keys(createBody.device).sort()).toEqual(REGISTRATION_VIEW_KEYS);
    expect(JSON.stringify(createBody)).not.toContain(SETUP_SECRET);
    expect(JSON.stringify(createBody)).not.toContain("adapterConfig");
  });

  it("[neg] another key that omits adapterConfig does not get A's stored credential back", async () => {
    // Ownership of the kernel and device is WP-C's (PR #445). On this branch B's update
    // is accepted (200); with WP-C's guard it is refused (403). Only the REDACTION is
    // asserted here: whichever it is, the stored credential must not be in the body.
    const res = await inj("POST", "/api/setup/register-device", keyB, setupBody());
    expect([200, 403], res.body).toContain(res.statusCode);
    expect(res.body).not.toContain(SETUP_SECRET);
    expect(res.body).not.toContain("adapterConfig");
    if (res.statusCode === 200) {
      const body = bodyOf(res);
      expect(body).toMatchObject({ registered: true, action: "updated" });
      expect(body.device).toMatchObject({ id: setupDeviceId, kernelId, adapterType: "mock", model: "Setup Sensor" });
      expect(Object.keys(body.device).sort()).toEqual(REGISTRATION_VIEW_KEYS);
      // The update really took the "preserve the stored config" path; it is only the response that is redacted.
      expect(storedConfig()).toContain(SETUP_SECRET);
    }
  });

  it("[neg] the owner's own successful update (200) returns the device, not its configuration", async () => {
    const res = await inj("POST", "/api/setup/register-device", keyA, setupBody({ model: "Setup Sensor v2", adapterConfig: { apiKey: REPLACED_SECRET } }));
    expect(res.statusCode, res.body).toBe(200);
    const body = bodyOf(res);
    expect(body).toMatchObject({ registered: true, action: "updated" });
    expect(body.device).toMatchObject({ id: setupDeviceId, kernelId, model: "Setup Sensor v2" });
    expect(Object.keys(body.device).sort()).toEqual(REGISTRATION_VIEW_KEYS);
    expect(res.body).not.toContain(SETUP_SECRET);
    expect(res.body).not.toContain(REPLACED_SECRET);
    expect(res.body).not.toContain("adapterConfig");
    // ... while the new config is what dispatch will read.
    expect(storedConfig()).toContain(REPLACED_SECRET);
  });

  it("[neg] a column added to the device row later is not published, on create or on update", async () => {
    const kernels = getRepos().kernels;
    const realInsert = kernels.insertDevice.bind(kernels);
    const realUpdate = kernels.updateDevice.bind(kernels);
    const insertSpy = vi.spyOn(kernels, "insertDevice").mockImplementation((d) => ({ ...realInsert(d), futureColumn: FUTURE }) as never);
    const updateSpy = vi.spyOn(kernels, "updateDevice").mockImplementation((id, d) => ({ ...realUpdate(id, d), futureColumn: FUTURE }) as never);
    try {
      const futureId = `dev-setup-future-${kernelId}`;
      const created = await inj("POST", "/api/setup/register-device", keyA, setupBody({ deviceId: futureId, adapterConfig: { apiKey: SETUP_SECRET } }));
      expect(created.statusCode, created.body).toBe(201);
      expect(bodyOf(created).device.id).toBe(futureId);
      expect(Object.keys(bodyOf(created).device).sort()).toEqual(REGISTRATION_VIEW_KEYS);
      expect(created.body).not.toContain(FUTURE);

      const updated = await inj("POST", "/api/setup/register-device", keyA, setupBody({ deviceId: futureId }));
      expect(updated.statusCode, updated.body).toBe(200);
      expect(bodyOf(updated).device.id).toBe(futureId);
      expect(Object.keys(bodyOf(updated).device).sort()).toEqual(REGISTRATION_VIEW_KEYS);
      expect(updated.body).not.toContain(FUTURE);
      expect(updated.body).not.toContain(SETUP_SECRET);
    } finally {
      insertSpy.mockRestore();
      updateSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/setup/generate-config: unchanged on purpose
// ─────────────────────────────────────────────────────────────────────────────

describe("N71: POST /api/setup/generate-config is unchanged (it returns the caller's own input)", () => {
  it("control: a credential the caller sends comes back in what it generated, and nothing stored does", async () => {
    const mine = `${SENTINEL}-caller-supplied`;
    const res = await inj("POST", "/api/setup/generate-config", keyB, {
      kernelId: "kernel-n71-gen",
      devices: [{ name: "My Printer", type: "machine", adapterType: "octoprint", url: "http://printer.invalid:5000", apiKey: mine }],
    });
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res);
    expect(body.config.devices[0].config.apiKey).toBe(mine);
    expect(body.configJson).toContain(mine);
    expect(body.envLine).toContain(mine);
    // It is not a window onto anything the gateway stores.
    expect(res.body).not.toContain(SECRET);
  });
});
