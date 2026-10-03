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
    expect(deviceIdsOf(res)).toEqual([deviceId]);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain("adapterConfig");
  });

  it("[neg] the kernel's own owner gets the public view too (the config stays on the device)", async () => {
    // An error body is credential-free too, so the status and the device's identity
    // come first: without them this test would also pass on a 403/500 (astra, MEDIUM 4).
    const res = await inj("GET", `/api/devices/${kernelId}`, keyA);
    expect(res.statusCode).toBe(200);
    expect(deviceIdsOf(res)).toEqual([deviceId]);
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
    // (A kernel of its own, so the other tests on `kernelId` keep seeing exactly one device.)
    const ownKernel = `${kernelId}-future`;
    const made = await inj("POST", "/api/kernels", keyA, { id: ownKernel, name: "A's second workshop" });
    expect(made.statusCode, made.body).toBeLessThan(300);
    const kernels = getRepos().kernels;
    const realInsert = kernels.insertDevice.bind(kernels);
    const spy = vi
      .spyOn(kernels, "insertDevice")
      .mockImplementation((d) => ({ ...realInsert(d), futureColumn: FUTURE }) as never);
    try {
      const res = await inj("POST", "/api/devices/register", keyA, {
        kernelId: ownKernel,
        id: `dev-future-${ownKernel}`,
        type: "printer",
        model: "Model Y",
        adapterType: "http",
        adapterConfig: { apiKey: SECRET },
      });
      expect(res.statusCode, res.body).toBe(200);
      const { device } = bodyOf(res);
      expect(device.id).toBe(`dev-future-${ownKernel}`);
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
    expect(mine.devices.length).toBe(1);
    expect(mine.devices).toEqual(pub.devices);
    expect(mine.devices[0]).toMatchObject({ id: deviceId, type: "printer", model: "Model X", adapterType: "http" });
  });

  it("control: the stored row still holds the config, for dispatch", () => {
    const rows = getRepos().kernels.findDevicesByKernel(kernelId) as Array<{ adapterConfig?: string | null }>;
    expect(String(rows[0]?.adapterConfig ?? "")).toContain(SECRET);
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

  it("[neg] POST /api/devices/:deviceId/health returns a fixed code for an adapter exception, never its text", async () => {
    // Round 3 (astra pack 83b) supersedes round 2's "still a usable diagnostic" scrub:
    // astra showed scrubbing can never be complete (free text like "password=..." has
    // no URL to catch), so the fix is a fixed code, not a better scrub. See the N71
    // round 3 describe block below for the full astra-pack-83b coverage of this path.
    const spy = vi.spyOn(MockFDMAdapter.prototype, "getStatus").mockRejectedValue(new Error(ADAPTER_ERROR));
    try {
      const res = await inj("POST", `/api/devices/${DEVICE}/health`, keyB);
      expect(res.statusCode).toBe(200);
      expect(bodyOf(res)).toEqual({ healthy: false, details: "adapter_error" });
      expect(res.body).not.toContain(SENTINEL);
      expect(res.body).not.toContain("printer.invalid"); // not even the location, anymore
    } finally {
      spy.mockRestore();
    }
  });

  it("[neg] KernelService.checkDeviceHealth returns a fixed code for an adapter exception, never its text", async () => {
    const spy = vi.spyOn(MockFDMAdapter.prototype, "getStatus").mockRejectedValue(new Error(ADAPTER_ERROR));
    try {
      const result = await getKernelService().checkDeviceHealth(DEVICE);
      expect(result).toEqual({ healthy: false, details: "adapter_error" });
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
    // Round 3 (astra pack 83b) supersedes round 2's "the location itself is still
    // useful" scrub-and-keep: astra's remediation for this field is presence-only
    // (see the dedicated N71 round 3 describe block below for the full X402_FACILITATOR_URL
    // coverage, apostrophe cases included). No "value" key survives JSON serialization
    // of an undefined property, so envEntryOf's result carries only name/category/set.
    const userinfo = `${SENTINEL}-facilitator-userinfo`;
    const query = `${SENTINEL}-facilitator-query`;
    await withEnv({ X402_FACILITATOR_URL: `https://svc:${userinfo}@facilitator.invalid/v1?apikey=${query}` }, async () => {
      const res = await inj("GET", "/api/setup/detect", keyB);
      expect(res.statusCode).toBe(200);
      const entry = (bodyOf(res).envVars as Array<{ name: string; set: boolean; value?: string }>).find(
        (v) => v.name === "X402_FACILITATOR_URL",
      );
      expect(entry?.set).toBe(true);
      expect(entry?.value).toBeUndefined();
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
  let setupKernel: string; // A's kernel for these tests
  let setupDeviceId: string;
  let createBody: Record<string, any>;

  const setupBody = (extra: Record<string, unknown> = {}) => ({
    kernelId: setupKernel,
    deviceId: setupDeviceId,
    type: "sensor",
    adapterType: "mock",
    ...extra,
  });
  const storedConfig = () =>
    String(getRepos().kernels.findDeviceById(setupDeviceId)?.adapterConfig ?? "");

  beforeAll(async () => {
    setupKernel = `${kernelId}-setup`;
    setupDeviceId = `dev-setup-${setupKernel}`;
    const made = await inj("POST", "/api/kernels", keyA, { id: setupKernel, name: "A's setup workshop" });
    expect(made.statusCode, made.body).toBeLessThan(300);
    // A registers device D on it with a credential.
    const res = await inj("POST", "/api/setup/register-device", keyA, {
      ...setupBody({ model: "Setup Sensor", adapterConfig: { apiKey: SETUP_SECRET } }),
    });
    expect(res.statusCode, res.body).toBe(201);
    createBody = bodyOf(res);
  });

  it("[neg] the create response (201) names the device and carries no adapterConfig", () => {
    expect(createBody).toMatchObject({ registered: true, action: "created" });
    expect(createBody.device).toMatchObject({ id: setupDeviceId, kernelId: setupKernel, type: "sensor", model: "Setup Sensor", adapterType: "mock" });
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
      expect(body.device).toMatchObject({ id: setupDeviceId, kernelId: setupKernel, adapterType: "mock", model: "Setup Sensor" });
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
    expect(body.device).toMatchObject({ id: setupDeviceId, kernelId: setupKernel, model: "Setup Sensor v2" });
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
      const futureId = `dev-setup-future-${setupKernel}`;
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

// ═════════════════════════════════════════════════════════════════════════════
// Round 3: astra's verdict on pack 83b (DO-NOT-SHIP at b7106adc)
// ═════════════════════════════════════════════════════════════════════════════
//
// Round 2 put a REGEX (redactUrlCredentials) in front of the values that leave the gateway. The
// regex treated an apostrophe as a delimiter, and an apostrophe is legal in URI userinfo, query and
// fragment, so `http://u:pa'ss@host.invalid/x` came back unchanged. It guarded /detect's
// non-sensitive variables and the text of a failed health check. Beyond it, the same verdict listed
// the other places a configuration value or an exception message still reached a response.
//
// The rule these tests pin: a response carries a FIXED code, an enumerated value, or "present"
// (set: true); never a configuration value and never exception text, however well scrubbed.
//   - /detect and /setup/status: presence only, or a value from a fixed set (a network, a storage
//     type, a port that parses as an integer).
//   - /validate: an identifier is echoed only when it is a plain identifier ([invalid id] otherwise).
//   - health, the setup catch blocks, BaseFacade: a fixed code. The detail is logged, scrubbed.
//   - a device's emitter manifest (emits[].params, via) is a public matching artifact: a manifest
//     that carries credentials is refused at registration (400 invalid_emitter_manifest).
//
// Every disclosure test embeds the synthetic sentinel; none of them uses a real credential.

const REDACTED_MARK = "[redacted]";
const INVALID_ID = "[invalid id]";

type EnvEntry = { name: string; category: string; set: boolean; value?: string };
const envEntryOf = (res: LightMyRequestResponse, name: string) =>
  (bodyOf(res).envVars as EnvEntry[]).find((v) => v.name === name);
const categoryOf = (res: LightMyRequestResponse, name: string) =>
  (bodyOf(res).categories as Array<{ name: string; status: string; details: string }>).find((c) => c.name === name);

// ─────────────────────────────────────────────────────────────────────────────
// Health: a fixed code, never exception text
// ─────────────────────────────────────────────────────────────────────────────

describe("N71 round 3 (astra pack 83b): the health response carries a fixed code, never exception text", () => {
  const DEVICE = "dev_fdm_001"; // the default mock machine of the gateway's KernelService
  const ADAPTER_ERROR_BODY = { healthy: false, details: "adapter_error" };

  /** What an adapter's exception can say. The first three are valid URL characters (astra's V8 table); the rest have no URL at all. */
  const ADAPTER_ERRORS: Array<[string, string]> = [
    ["an apostrophe in a URL's password", `connect failed for http://u:pa'${SENTINEL}@printer.invalid:5000/api/printer`],
    ["an apostrophe in a URL's query value", `GET https://printer.invalid/v1/status?token=abc'${SENTINEL} failed`],
    ["an apostrophe in a URL's fragment", `GET https://printer.invalid/v1/status#abc'${SENTINEL} failed`],
    ["a credential outside any URL (astra: survives both helpers)", `authentication failed: password=${SENTINEL}`],
    ["a credential in a header line", `401 from upstream, x-api-key: ${SENTINEL}-key`],
  ];

  async function whileAdapterFails<T>(failure: unknown, fn: () => Promise<T>): Promise<T> {
    const spy = vi.spyOn(MockFDMAdapter.prototype, "getStatus").mockRejectedValue(failure);
    try {
      return await fn();
    } finally {
      spy.mockRestore();
    }
  }

  it.each(ADAPTER_ERRORS)("[neg] POST /api/devices/:deviceId/health, adapter throws with %s", async (_what, text) => {
    await whileAdapterFails(new Error(text), async () => {
      const res = await inj("POST", `/api/devices/${DEVICE}/health`, keyB);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(SENTINEL);
      expect(bodyOf(res)).toEqual(ADAPTER_ERROR_BODY);
    });
  });

  it("[neg] KernelService.checkDeviceHealth returns the fixed code for an Error and for a thrown string", async () => {
    for (const failure of [new Error(ADAPTER_ERRORS[0][1]), `thrown string with password=${SENTINEL}`]) {
      await whileAdapterFails(failure, async () => {
        const result = await getKernelService().checkDeviceHealth(DEVICE);
        expect(JSON.stringify(result)).not.toContain(SENTINEL);
        expect(result).toEqual(ADAPTER_ERROR_BODY);
      });
    }
  });

  it.each<[string, unknown]>([
    ["an object", { nested: `${SENTINEL}-object` }],
    ["an array", [`${SENTINEL}-array`]],
    ["free text", `${SENTINEL}-free text, not a status`],
    ["a number", 42],
  ])("[neg] the facade drops a service `details` that is not a fixed code: %s", async (_what, details) => {
    const spy = vi.spyOn(getKernelService(), "checkDeviceHealth").mockResolvedValue({ healthy: true, details } as never);
    try {
      const res = await inj("POST", `/api/devices/${DEVICE}/health`, keyB);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(SENTINEL);
      expect(bodyOf(res)).toEqual({ healthy: true, details: null });
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["idle", "busy", "maintenance", "error", "offline"])("control: the adapter's own status %s still reaches the response", async (status) => {
    const spy = vi.spyOn(MockFDMAdapter.prototype, "getStatus").mockResolvedValue(status as never);
    try {
      const body = bodyOf(await inj("POST", `/api/devices/${DEVICE}/health`, keyB));
      expect(body).toEqual({ healthy: status !== "error" && status !== "offline", details: status });
    } finally {
      spy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/setup/detect: URL-valued variables are present or not, never a value
// ─────────────────────────────────────────────────────────────────────────────

describe("N71 round 3 (astra pack 83b): GET /api/setup/detect reports URL-valued variables as present, never as a value", () => {
  /** [what, the variable's value, a fragment that must not come back]. */
  const URL_VALUES: Array<[string, string, string]> = [
    ["astra's reproduction, verbatim", "http://u:pa'ss@host.invalid/x", "pa'ss"],
    ["an apostrophe in the password", `http://u:pa'${SENTINEL}@host.invalid/x`, SENTINEL],
    ["an apostrophe in the query", `https://host.invalid/?token=abc'${SENTINEL}`, SENTINEL],
    ["an apostrophe in the fragment", `https://host.invalid/#abc'${SENTINEL}`, SENTINEL],
    ["a double quote in the password", `http://u:pa"${SENTINEL}@host.invalid/x`, SENTINEL],
    ["ordinary credentials", `https://svc:${SENTINEL}@facilitator.invalid/v1?apikey=${SENTINEL}-q`, SENTINEL],
    ["no credentials at all", "https://facilitator.invalid/v1", "facilitator.invalid"],
  ];

  it.each(URL_VALUES)("[neg] X402_FACILITATOR_URL with %s is {set: true} and nothing more", async (_what, value, leak) => {
    await withEnv({ X402_FACILITATOR_URL: value }, async () => {
      const res = await inj("GET", "/api/setup/detect", keyB);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(leak);
      expect(envEntryOf(res, "X402_FACILITATOR_URL")).toEqual({ name: "X402_FACILITATOR_URL", category: "payments", set: true });
    });
  });

  it("control: a variable that is not set is reported as not set", async () => {
    await withEnv({ X402_FACILITATOR_URL: undefined }, async () => {
      const entry = envEntryOf(await inj("GET", "/api/setup/detect", keyB), "X402_FACILITATOR_URL");
      expect(entry).toEqual({ name: "X402_FACILITATOR_URL", category: "payments", set: false });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/setup/detect and /api/setup/status: network, storage, port and account
// ─────────────────────────────────────────────────────────────────────────────

describe("N71 round 3 (astra pack 83b): /api/setup/detect and /api/setup/status do not echo environment values", () => {
  // A credential-bearing URL (or a bare token) in a variable that should hold a name, a type, a port or
  // an address: what an operator pastes into the wrong variable. None of it may come back.
  const MISPLACED = {
    PCC_NETWORK: `https://u:${SENTINEL}-net@rpc.invalid/?apikey=${SENTINEL}-netq`,
    EVIDENCE_STORAGE: `http://u:pa'${SENTINEL}-store@storage.invalid`,
    PORT: `http://u:${SENTINEL}-port@host.invalid:8080`,
    STARKNET_ACCOUNT_ADDRESS: `${SENTINEL}-account`,
    ESCROW_CONTRACT_ADDRESS: `${SENTINEL}-escrow`,
    NODE_ENV: `${SENTINEL}-node-env`,
    PCC_GATEWAY_PRIVATE_KEY: `${SENTINEL}-gateway-key`,
  };

  it("[neg] /detect: network, storage type and account address are withheld, and the booleans keep their meaning", async () => {
    await withEnv(MISPLACED, async () => {
      const res = await inj("GET", "/api/setup/detect", keyB);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(SENTINEL);
      const body = bodyOf(res);
      expect(body.chain).toEqual({ connected: true, network: REDACTED_MARK });
      expect(body.storage).toEqual({ type: REDACTED_MARK, configured: false });
      expect(body.identity).toEqual({ configured: true, accountAddress: REDACTED_MARK });
      // Every variable is still listed as set, and none carries a value.
      for (const name of ["PCC_NETWORK", "EVIDENCE_STORAGE", "PORT", "STARKNET_ACCOUNT_ADDRESS", "ESCROW_CONTRACT_ADDRESS", "NODE_ENV"]) {
        const entry = envEntryOf(res, name);
        expect(entry?.set, name).toBe(true);
        expect(entry?.value, name).toBeUndefined();
      }
    });
  });

  it("control: /detect still names a network and a storage type from the fixed sets, and a port that is a number", async () => {
    await withEnv({ PCC_NETWORK: "base-sepolia", EVIDENCE_STORAGE: "helia", PORT: "4321", NODE_ENV: "test", STARKNET_ACCOUNT_ADDRESS: undefined }, async () => {
      const res = await inj("GET", "/api/setup/detect", keyB);
      const body = bodyOf(res);
      expect(body.chain.network).toBe("base-sepolia");
      expect(body.storage).toEqual({ type: "helia", configured: true });
      expect(body.identity).toEqual({ configured: false, accountAddress: null });
      expect(envEntryOf(res, "PCC_NETWORK")?.value).toBe("base-sepolia");
      expect(envEntryOf(res, "PORT")?.value).toBe("4321");
      expect(envEntryOf(res, "NODE_ENV")?.value).toBe("test");
    });
  });

  it("control: /detect with nothing set reports the defaults", async () => {
    await withEnv({ PCC_NETWORK: undefined, EVIDENCE_STORAGE: undefined, STARKNET_ACCOUNT_ADDRESS: undefined }, async () => {
      const body = bodyOf(await inj("GET", "/api/setup/detect", keyB));
      expect(body.chain).toEqual({ connected: false, network: null });
      expect(body.storage).toEqual({ type: "local", configured: true });
    });
  });

  it("[neg] /status: port, network, storage type and account are withheld, and the categories keep their meaning", async () => {
    await withEnv(MISPLACED, async () => {
      const res = await inj("GET", "/api/setup/status", keyB);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(SENTINEL);
      expect(categoryOf(res, "gateway")).toMatchObject({ status: "ready", details: `Gateway running on port ${REDACTED_MARK}` });
      expect(categoryOf(res, "chain")).toMatchObject({ status: "ready", details: `Chain: ${REDACTED_MARK}, escrow configured` });
      expect(categoryOf(res, "storage")).toMatchObject({ status: "partial", details: `Unknown storage type: ${REDACTED_MARK}` });
      expect(categoryOf(res, "identity")?.status).toBe("ready");
    });
  });

  it("control: /status still names a port that is a number, a network and a storage type from the fixed sets", async () => {
    await withEnv(
      {
        PORT: "4321",
        PCC_NETWORK: "base-sepolia",
        PCC_GATEWAY_PRIVATE_KEY: `${SENTINEL}-gateway-key`,
        ESCROW_CONTRACT_ADDRESS: `0x${"ab".repeat(20)}`,
        EVIDENCE_STORAGE: "helia",
        STARKNET_ACCOUNT_ADDRESS: undefined,
      },
      async () => {
        const res = await inj("GET", "/api/setup/status", keyB);
        expect(categoryOf(res, "gateway")?.details).toBe("Gateway running on port 4321");
        expect(categoryOf(res, "chain")).toMatchObject({ status: "ready", details: "Chain: base-sepolia, escrow configured" });
        expect(categoryOf(res, "storage")).toMatchObject({ status: "ready", details: "Evidence storage: helia" });
        expect(categoryOf(res, "identity")?.status).toBe("unconfigured");
      },
    );
  });

  it("control: /status with no PORT set says 3200", async () => {
    await withEnv({ PORT: undefined }, async () => {
      expect(categoryOf(await inj("GET", "/api/setup/status", keyB), "gateway")?.details).toBe("Gateway running on port 3200");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/setup/validate: identifiers
// ─────────────────────────────────────────────────────────────────────────────

describe("N71 round 3 (astra pack 83b): POST /api/setup/validate echoes an identifier only when it is a plain identifier", () => {
  /** Identifiers a misconfigured KERNEL_CONFIG can hold; one per branch of the validator. */
  const IDS = {
    kernel: `http://u:${SENTINEL}-kernel@h.invalid/x`,
    octoprint: `https://u:${SENTINEL}-octo@h.invalid/'q`,
    modbus: `ftp://u:${SENTINEL}-modbus@h.invalid`,
    opcua: `opc.tcp://u:pa'${SENTINEL}-opcua@h.invalid:4840`,
    sila: `x'${SENTINEL}-sila`,
    ipp: `ipp://u:${SENTINEL}-ipp@h.invalid`,
    mock: `sk-${SENTINEL}-0123456789`, // an identifier-shaped string that is also a vendor key shape
    badType: `http://u:${SENTINEL}-bad-type@h.invalid`,
    badAdapter: `http://u:${SENTINEL}-bad-adapter@h.invalid`,
  };

  const CONFIG = JSON.stringify({
    kernelId: IDS.kernel,
    devices: [
      { id: IDS.octoprint, type: "machine", adapterType: "octoprint", config: { url: "http://printer.invalid" } },
      { id: IDS.modbus, type: "sensor", adapterType: "modbus", config: {} },
      { id: IDS.opcua, type: "machine", adapterType: "opcua", config: {} },
      { id: IDS.sila, type: "machine", adapterType: "sila", config: {} },
      { id: IDS.ipp, type: "machine", adapterType: "ipp", config: {} },
      { id: IDS.mock, type: "machine", adapterType: "mock", config: {} },
      { id: IDS.badType, type: "bogus", adapterType: "mock", config: {} },
      { id: IDS.badAdapter, type: "machine", adapterType: "bogus", config: {} },
    ],
  });

  it("[neg] no identifier from the config comes back (names, messages, errors, warnings), and every device was still checked", async () => {
    const res = await inj("POST", "/api/setup/validate", keyB, { config: CONFIG });
    expect(res.statusCode).toBe(200);
    expectNoLeak(res.body, IDS);
    expect(res.body).not.toContain(SENTINEL);
    const body = bodyOf(res);
    // The validator really walked every branch (a leak-free body must not be an empty one) ...
    const checkNames = (body.checks as Check[]).map((c) => c.name);
    expect(checkNames.filter((n) => n.endsWith(":url")).length).toBeGreaterThanOrEqual(2); // octoprint + sila
    expect(checkNames.some((n) => n.endsWith(":uri"))).toBe(true); // ipp
    expect(checkNames.some((n) => n.endsWith(":host"))).toBe(true); // modbus
    expect(checkNames.some((n) => n.endsWith(":endpoint"))).toBe(true); // opcua
    expect(checkNames.some((n) => n.endsWith(":type"))).toBe(true);
    expect(checkNames.some((n) => n.endsWith(":adapterType"))).toBe(true);
    expect(body.valid).toBe(false);
    // ... and says that an identifier was withheld.
    expect(res.body).toContain(INVALID_ID);
  });

  it("[neg] the same, when the server validates its own KERNEL_CONFIG", async () => {
    await withEnv({ KERNEL_CONFIG: CONFIG }, async () => {
      const res = await inj("POST", "/api/setup/validate", keyB, {});
      expect(res.statusCode).toBe(200);
      expectNoLeak(res.body, IDS);
    });
  });

  it("[neg] an identifier that is not a string is not echoed either (an array stringifies to its contents)", async () => {
    const res = await inj("POST", "/api/setup/validate", keyB, {
      config: JSON.stringify({
        kernelId: [SENTINEL],
        devices: [{ id: [`${SENTINEL}-device`], type: "machine", adapterType: "ipp", config: {} }],
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SENTINEL);
    expect(res.body).toContain(INVALID_ID);
  });

  it("control: plain identifiers are echoed, so a device can still be told from another", async () => {
    const res = await inj("POST", "/api/setup/validate", keyB, {
      config: JSON.stringify({
        kernelId: "kernel_ctl-3",
        devices: [
          { id: "dev_a-1", type: "machine", adapterType: "ipp", config: {} },
          { id: "dev_b-2", type: "machine", adapterType: "bogus", config: {} },
        ],
      }),
    });
    const body = bodyOf(res);
    const byName = new Map((body.checks as Check[]).map((c) => [c.name, c]));
    expect(byName.get("kernel_id")?.message).toBe("kernelId: kernel_ctl-3");
    expect(byName.get("device:dev_a-1:uri")?.message).toContain('"dev_a-1"');
    expect(byName.get("device:dev_b-2:adapterType")?.message).toContain('"dev_b-2"');
    expect(body.errors).toContain("Device dev_b-2: invalid adapterType");
    expect(res.body).not.toContain(INVALID_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The setup catch blocks
// ─────────────────────────────────────────────────────────────────────────────

describe("N71 round 3 (astra pack 83b): the setup catch blocks answer with fixed codes", () => {
  const THROWN = `failed near http://u:pa'${SENTINEL}@db.invalid/x password=${SENTINEL}-pw`;
  let catchKernel: string;

  beforeAll(async () => {
    catchKernel = `${kernelId}-catch`;
    const made = await inj("POST", "/api/kernels", keyA, { id: catchKernel, name: "A's catch workshop" });
    expect(made.statusCode, made.body).toBeLessThan(300);
  });

  it("[neg] POST /api/setup/register-device: an exception from the repository is not returned", async () => {
    const kernels = getRepos().kernels;
    const spy = vi.spyOn(kernels, "insertDevice").mockImplementation(() => {
      throw new Error(THROWN);
    });
    try {
      const res = await inj("POST", "/api/setup/register-device", keyA, {
        kernelId: catchKernel,
        deviceId: `dev-catch-${catchKernel}`,
        type: "sensor",
        adapterType: "mock",
      });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain(SENTINEL);
      // toMatchObject, not toEqual: the gateway's onSend hook decorates every 5xx
      // JSON body with a report_hint block (traceId, how-to-report), same as the
      // sibling test-job assertion below pins it.
      expect(bodyOf(res)).toMatchObject({ error: "upsert_failed", message: "Device registration failed" });
      // ...and NOTHING else but that decoration: no exception text or other field rides along.
      expect(Object.keys(bodyOf(res) as Record<string, unknown>).sort()).toEqual(["error", "message", "report_hint"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("[neg] POST /api/setup/test-job: an exception from the job submission is not returned", async () => {
    const spy = vi.spyOn(getKernelService(), "submitJob").mockRejectedValue(new Error(THROWN));
    try {
      const res = await inj("POST", "/api/setup/test-job", keyB, { deviceId: "dev_fdm_001" });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain(SENTINEL);
      const body = bodyOf(res);
      expect(body).toMatchObject({ error: "job_submission_failed", message: "Test job submission failed" });
      expect(typeof body.jobId).toBe("string"); // the rest of the shape is unchanged
      expect(typeof body.duration).toBe("number");
    } finally {
      spy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BaseFacade: unexpected exceptions
// ─────────────────────────────────────────────────────────────────────────────

describe("N71 round 3 (astra pack 83b): an unexpected exception inside a facade does not reach the response", () => {
  const THROWN = `database trouble near http://u:pa'${SENTINEL}@db.invalid/x`;

  it("[neg] an unexpected exception answers with the generic internal error", async () => {
    const kernels = getRepos().kernels;
    const spy = vi.spyOn(kernels, "findDevicesByKernel").mockImplementation(() => {
      throw new Error(THROWN);
    });
    try {
      const res = await inj("GET", `/api/devices/${kernelId}`, keyB);
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain(SENTINEL);
      expect(bodyOf(res)).toMatchObject({ error: "INTERNAL_ERROR", message: "internal_error" });
    } finally {
      spy.mockRestore();
    }
  });

  it("[neg] a transient failure (an RPC URL with a key in it) answers with the transient code and no text", async () => {
    const kernels = getRepos().kernels;
    const spy = vi.spyOn(kernels, "findDevicesByKernel").mockImplementation(() => {
      throw new Error(`fetch failed: https://rpc.invalid/v2/${SENTINEL}-rpc-key`);
    });
    try {
      const res = await inj("GET", `/api/devices/${kernelId}`, keyB);
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain(SENTINEL);
      expect(bodyOf(res)).toMatchObject({ error: "TRANSIENT_ERROR", message: "transient_error" });
    } finally {
      spy.mockRestore();
    }
  });

  it("[neg] the telemetry feed (GET /api/telemetry/pipeline/:jobId) does not carry the exception text either", async () => {
    const { pipelineTelemetry } = await import("../telemetry.js");
    const kernels = getRepos().kernels;
    const spy = vi.spyOn(kernels, "findDevicesByKernel").mockImplementation(() => {
      throw new Error(THROWN);
    });
    try {
      await inj("GET", `/api/devices/${kernelId}`, keyB);
    } finally {
      spy.mockRestore();
    }
    const timelines = pipelineTelemetry.getAllJobIds().map((id) => ({ id, events: pipelineTelemetry.getTimeline(id) }));
    // The failure WAS recorded ...
    const failed = timelines.flatMap((t) => t.events).filter((e) => e.status === "failed" && e.metadata.operation === "getDevicesForKernel");
    expect(failed.length).toBeGreaterThan(0);
    // ... and no timeline holds the text.
    expect(JSON.stringify(timelines)).not.toContain(SENTINEL);
    const feed = await inj("GET", `/api/telemetry/pipeline/${failed[0].jobId}`, keyB);
    expect(feed.body).not.toContain(SENTINEL);
  });

  it("control: a typed, expected error keeps its message (400 and 404)", async () => {
    const bad = await inj("POST", "/api/devices/register", keyA, { kernelId });
    expect(bad.statusCode).toBe(400);
    expect(bodyOf(bad)).toMatchObject({ error: "missing_required_fields", message: "kernelId, id, type, model, adapterType are all required" });
    const missing = await inj("GET", "/api/jobs/job-n71-missing/status", keyB);
    expect(missing.statusCode).toBe(404);
    expect(String(bodyOf(missing).message)).toContain("job-n71-missing");
  });

  it("control: registering the same device twice is still a 409 device_already_exists", async () => {
    const payload = { kernelId, id: `dev-dup-${kernelId}`, type: "machine", model: "Dup", adapterType: "mock" };
    expect((await inj("POST", "/api/devices/register", keyA, payload)).statusCode).toBeLessThan(300);
    const again = await inj("POST", "/api/devices/register", keyA, payload);
    expect(again.statusCode).toBe(409);
    expect(bodyOf(again)).toEqual({ error: "device_already_exists" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Q3: the emitter manifest is a public matching artifact, so it may not carry credentials
// ─────────────────────────────────────────────────────────────────────────────

describe("N71 round 3 (astra pack 83b, Q3): a device's emitter manifest that carries credentials is refused at registration", () => {
  let emitsKernel: string;
  let seq3 = 0;

  beforeAll(async () => {
    emitsKernel = `${kernelId}-emits`;
    const made = await inj("POST", "/api/kernels", keyA, { id: emitsKernel, name: "A's emitter workshop" });
    expect(made.statusCode, made.body).toBeLessThan(300);
  });

  const register = (emits: unknown, deviceId = `dev-emits-${++seq3}-${emitsKernel}`) =>
    inj("POST", "/api/setup/register-device", keyA, { kernelId: emitsKernel, deviceId, type: "sensor", adapterType: "mock", emits });
  const stored = (deviceId: string) => getRepos().kernels.findDeviceById(deviceId);

  /** [what the manifest carries, the emits array]. Each embeds the sentinel. */
  const CREDENTIAL_MANIFESTS: Array<[string, unknown]> = [
    ["a secret-named param", [{ id: "decl.self_attested", params: { apiKey: SENTINEL } }]],
    ["a secret-named param, other spellings", [{ id: "decl.self_attested", params: { client_secret: SENTINEL } }]],
    ["a secret-named param, nested in an object", [{ id: "decl.self_attested", params: { upstream: { auth: { token: SENTINEL } } } }]],
    ["a secret-named param, nested in an array", [{ id: "decl.self_attested", params: { hops: [{ ok: 1 }, { password: SENTINEL }] } }]],
    ["a URL with userinfo in a param", [{ id: "decl.self_attested", params: { endpoint: `http://u:${SENTINEL}@h.invalid/x` } }]],
    ["a URL with an apostrophe in its userinfo", [{ id: "decl.self_attested", params: { endpoint: `http://u:pa'${SENTINEL}@h.invalid/x` } }]],
    ["a URL with userinfo in via", [{ id: "decl.self_attested", via: `https://svc:${SENTINEL}@h.invalid/hook` }]],
    ["a URL with userinfo in bind", [{ id: "decl.self_attested", bind: `https://svc:${SENTINEL}@h.invalid/hook` }]],
    ["a URL whose query names a secret", [{ id: "decl.self_attested", params: { callback: `https://h.invalid/cb?api_key=${SENTINEL}` } }]],
    ["a URL with userinfo in the second declaration", [{ id: "decl.self_attested" }, { id: "capture.photo_nonced", params: { media: "photo", src: `ftp://u:${SENTINEL}@h.invalid` } }]],
  ];

  it.each(CREDENTIAL_MANIFESTS)("[neg] %s: 400 invalid_emitter_manifest, nothing written, nothing echoed", async (_what, emits) => {
    const deviceId = `dev-emits-refused-${++seq3}-${emitsKernel}`;
    const res = await register(emits, deviceId);
    expect(res.body).not.toContain(SENTINEL);
    expect(res.statusCode, res.body).toBe(400);
    expect(bodyOf(res).error).toBe("invalid_emitter_manifest");
    expect(stored(deviceId)).toBeUndefined(); // refused before any write
  });

  it("[neg] an update that PRESERVES a stored manifest which carries credentials is refused too", async () => {
    // A manifest stored before the check existed. The caller sends no emits; the update would keep it,
    // and the registration view would hand it back.
    const deviceId = `dev-emits-legacy-${emitsKernel}`;
    getRepos().kernels.insertDevice({
      id: deviceId,
      kernelId: emitsKernel,
      type: "sensor",
      model: "Legacy",
      firmware: "unknown",
      status: "idle",
      contributesToCapabilities: [],
      lastUpdated: new Date().toISOString(),
      adapterType: "mock",
      capabilities: [],
      healthStatus: "healthy",
      emits: [{ id: "decl.self_attested", params: { apiKey: SENTINEL } }],
    } as never);
    const res = await inj("POST", "/api/setup/register-device", keyA, { kernelId: emitsKernel, deviceId, type: "sensor", adapterType: "mock" });
    expect(res.body).not.toContain(SENTINEL);
    expect(res.statusCode, res.body).toBe(400);
    expect(bodyOf(res).error).toBe("invalid_emitter_manifest");
    // Re-registering with a clean manifest is the way out, and it replaces the stored one.
    const fixed = await inj("POST", "/api/setup/register-device", keyA, { kernelId: emitsKernel, deviceId, type: "sensor", adapterType: "mock", emits: [{ id: "decl.self_attested" }] });
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect(fixed.body).not.toContain(SENTINEL);
  });

  it("control: a manifest without credentials is accepted and comes back as sent (the public contract is unchanged)", async () => {
    const emits = [
      { id: "decl.self_attested" },
      { id: "capture.photo_nonced", params: { media: "photo", minClass: "CC1", callback: "https://h.invalid/cb?id=7" }, bind: "capturePhotoCid", via: "captureSnapshot" },
    ];
    const res = await register(emits);
    expect(res.statusCode, res.body).toBe(201);
    expect(bodyOf(res).device.emits).toEqual(emits);
  });

  it("control: an email-looking string and a path with an @ are not credentials", async () => {
    const emits = [{ id: "decl.self_attested", params: { contact: "ops@example.com", profile: "https://medium.invalid/@user" } }];
    const res = await register(emits);
    expect(res.statusCode, res.body).toBe(201);
  });
});
