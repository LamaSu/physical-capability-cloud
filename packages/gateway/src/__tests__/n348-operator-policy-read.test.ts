import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DEFAULT_OPERATOR_POLICY } from "@pcc/spec";
import { schema, eq, sql } from "@pcc/store";
import { apiGate } from "../middleware/api-gate.js";
import { kernelRoutes } from "../routes/kernels.js";
import { operatorRoutes } from "../routes/operator.js";
import { kernelAgentPackageRoutes } from "../routes/kernel-agent-package.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { initStore, closeStore, getStore } from "../db.js";

const PREV_DB = process.env.PCC_DB_PATH;
const PREV_ADMIN = process.env.PCC_ADMIN_KEY;
const ADMIN = "n348-synthetic-admin-secret";
const OWNER = "0xA11cE00000000000000000000000000000000348";
const STRANGER = "0xBaD0000000000000000000000000000000000348";
const CLAIMED = "operator-n348-claimed";
const KERNEL = "kernel-n348";
const CLAIMED_KERNEL = "kernel-n348-claimed";
const UNKNOWN = "kernel-n348-missing";
const UPDATED_AT = "2026-11-16T00:00:00.000Z";
const POLICY_READ_FAILED = {
  error: "read_failed",
  message: "The operator policy could not be read. Try again shortly.",
};
const KERNEL_READ_FAILED = {
  error: "read_failed",
  message: "The kernel could not be read to check who operates it. Try again shortly.",
};
const FULL = {
  ...structuredClone(DEFAULT_OPERATOR_POLICY),
  approvalMode: "n348-approval-mode",
  timezone: "Pacific/Chatham",
  emergencyStop: false,
  pricingRules: [
    { ...DEFAULT_OPERATOR_POLICY.pricingRules[0], id: "n348-enabled", label: "N348 enabled rule", enabled: true },
    { ...DEFAULT_OPERATOR_POLICY.pricingRules[1], id: "n348-disabled", label: "N348 disabled rule", enabled: false },
  ],
  toolConfig: {
    customTools: [{
      name: "n348_custom_tool",
      description: "N348 operator-authored tool",
      category: "operator",
      recommended: true,
      endpoint: { method: "POST", path: "/api/n348/custom-tool" },
      inputSchema: { type: "object", properties: {} },
    }],
  },
};

let app: FastifyInstance;
let OWNER_CLAIM: string;
let STRANGER_KEY: string;
let CLAIMED_KEY: string;

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const callers = () => ({
  admin: { ...bearer(STRANGER_KEY), "x-admin-key": ADMIN },
  owner: { ...bearer(STRANGER_KEY), "x-test-proven-wallet": OWNER },
  "owner-lower": { ...bearer(STRANGER_KEY), "x-test-proven-wallet": OWNER.toLowerCase() },
  "owner-cookie": { ...bearer(STRANGER_KEY), "x-test-proven-wallet": OWNER, "x-test-proven-carrier": "cookie" },
  stranger: bearer(STRANGER_KEY),
  "owner-claim": bearer(OWNER_CLAIM),
  "other-wallet": { ...bearer(STRANGER_KEY), "x-test-proven-wallet": STRANGER },
  claimed: bearer(CLAIMED_KEY),
});
const otherCallers = () => {
  const c = callers();
  return [c.stranger, c["owner-claim"], c["other-wallet"]];
};

function storePolicy(policy: unknown, kernelId = KERNEL) {
  const { db } = getStore();
  const values = { policy: policy as Record<string, unknown>, updatedAt: UPDATED_AT, updatedBy: "n348" };
  db.insert(schema.operatorPolicies).values({ kernelId, ...values })
    .onConflictDoUpdate({ target: schema.operatorPolicies.kernelId, set: values }).run();
}

function noPolicy(kernelId = KERNEL) {
  getStore().db.delete(schema.operatorPolicies).where(eq(schema.operatorPolicies.kernelId, kernelId)).run();
}

function unparsedPolicy(kernelId = KERNEL) {
  storePolicy(FULL, kernelId);
  getStore().db.run(sql`UPDATE operator_policies SET policy = ${"{n348"} WHERE kernel_id = ${kernelId}`);
}

function failKernelRead() {
  const { db } = getStore();
  const select = db.select.bind(db);
  return vi.spyOn(db, "select").mockImplementation(((fields?: unknown) => {
    if (fields !== null && typeof fields === "object" && "operatorAddress" in fields) {
      throw new Error("n348 kernel read unavailable");
    }
    return select(fields as never);
  }) as typeof db.select);
}

const policyGet = (headers: Record<string, string>, kernelId = KERNEL) =>
  app.inject({ method: "GET", url: `/api/operator/policy/${kernelId}`, headers });
const packageGet = (headers: Record<string, string>, kernelId = KERNEL) =>
  app.inject({ method: "GET", url: `/api/kernels/${kernelId}/agent-package?role=operator`, headers });

async function expectPolicy(headers: Record<string, string>, body: unknown, kernelId = KERNEL) {
  const res = await policyGet(headers, kernelId);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toStrictEqual(body);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runbookStop(status: number, body: unknown) {
  const stored = status === 200 && isObject(body) && body.source !== "default"
    && "updatedAt" in body && isObject(body.policy);
  return stored && (body.policy as Record<string, unknown>).emergencyStop === false ? "CLEAR" : "STOPPED";
}

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN;
  closeStore();
  initStore({ seed: true });
  app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const proven = req.headers["x-test-proven-wallet"];
    if (typeof proven === "string") {
      req.provenWallet = proven;
      req.provenWalletCarrier = (req.headers["x-test-proven-carrier"] ?? "key") as typeof req.provenWalletCarrier;
    }
  });
  await app.register(apiGate);
  await app.register(kernelRoutes);
  await app.register(operatorRoutes);
  await app.register(kernelAgentPackageRoutes);
  await app.ready();

  OWNER_CLAIM = provisionApiKey({ operatorId: OWNER, name: "n348-owner", scopes: ["*"] }).rawKey;
  STRANGER_KEY = provisionApiKey({ operatorId: STRANGER, name: "n348-stranger", scopes: ["*"] }).rawKey;
  CLAIMED_KEY = provisionApiKey({ operatorId: CLAIMED, name: "n348-claimed", scopes: ["*"] }).rawKey;
  for (const [id, key, owner] of [[KERNEL, OWNER_CLAIM, OWNER], [CLAIMED_KERNEL, CLAIMED_KEY, CLAIMED]]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/kernels",
      headers: bearer(key),
      payload: { id, name: id, location: { lat: 40.7, lng: -74 }, physicalAddress: "1 N348 St" },
    });
    expect(res.statusCode).toBe(201);
    expect(getStore().db.select().from(schema.shopKernels).where(eq(schema.shopKernels.id, id)).get()?.operatorAddress).toBe(owner);
  }
}, 60_000);

afterAll(async () => {
  await app.close();
  closeStore();
  if (PREV_DB === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = PREV_DB;
  if (PREV_ADMIN === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = PREV_ADMIN;
});

describe("GET /api/operator/policy/:kernelId", () => {
  it("OP1: the admin and the proven owner read the whole stored policy, by key or by cookie", async () => {
    storePolicy(FULL);
    const c = callers();
    for (const headers of [c.admin, c.owner, c["owner-lower"], c["owner-cookie"]]) {
      await expectPolicy(headers, { policy: FULL, updatedAt: UPDATED_AT });
    }
  });

  it("OP2: any other caller reads the emergency stop alone, set or clear", async () => {
    for (const emergencyStop of [false, true]) {
      const policy = { ...FULL, emergencyStop };
      storePolicy(policy);
      for (const headers of otherCallers()) {
        await expectPolicy(headers, { policy: { emergencyStop }, updatedAt: UPDATED_AT });
      }
      await expectPolicy(callers().admin, { policy, updatedAt: UPDATED_AT });
    }
  });

  it("OP3: a stored truthy non-boolean stop reads as true and a stored 0 as false for any other caller", async () => {
    for (const emergencyStop of ["yes", 0]) {
      const policy = { ...FULL, emergencyStop };
      storePolicy(policy);
      for (const headers of otherCallers()) {
        await expectPolicy(headers, { policy: { emergencyStop: Boolean(emergencyStop) }, updatedAt: UPDATED_AT });
      }
      await expectPolicy(callers().admin, { policy, updatedAt: UPDATED_AT });
    }
  });

  it("OP4: a stored policy that is an array or a string gives any other caller 503 with no policy", async () => {
    for (const policy of [["n348"], "n348"]) {
      storePolicy(policy);
      for (const headers of otherCallers()) {
        const res = await policyGet(headers);
        expect(res.statusCode).toBe(503);
        expect(res.json()).toStrictEqual(POLICY_READ_FAILED);
      }
      await expectPolicy(callers().admin, { policy, updatedAt: UPDATED_AT });
    }
  });

  it("OP5: with no stored policy any other caller gets the stop-only default and the owner gets the full default", async () => {
    noPolicy();
    for (const headers of otherCallers()) {
      await expectPolicy(headers, { policy: { emergencyStop: false }, source: "default" });
    }
    for (const headers of [callers().admin, callers().owner]) {
      await expectPolicy(headers, { policy: DEFAULT_OPERATOR_POLICY, source: "default" });
    }
  });

  it("OP6: an unregistered kernel reads 200 with the stop-only default for a non-admin", async () => {
    noPolicy(UNKNOWN);
    for (const headers of [callers().stranger, callers().owner]) {
      await expectPolicy(headers, { policy: { emergencyStop: false }, source: "default" }, UNKNOWN);
    }
    await expectPolicy(callers().admin, { policy: DEFAULT_OPERATOR_POLICY, source: "default" }, UNKNOWN);
  });

  it("OP7: a failed kernel read gives a non-admin 503 with no policy, and the admin still reads", async () => {
    storePolicy(FULL);
    const spy = failKernelRead();
    try {
      for (const headers of [callers().stranger, callers().owner]) {
        const res = await policyGet(headers);
        expect(res.statusCode).toBe(503);
        expect(res.json()).toStrictEqual(KERNEL_READ_FAILED);
      }
      await expectPolicy(callers().admin, { policy: FULL, updatedAt: UPDATED_AT });
    } finally {
      spy.mockRestore();
    }
  });

  it("OP8: a stored policy that does not parse gives every caller 503 with no policy", async () => {
    unparsedPolicy();
    for (const headers of [callers().stranger, callers().owner, callers().admin]) {
      const res = await policyGet(headers);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toStrictEqual(POLICY_READ_FAILED);
    }
  });

  it("OP9: the runbook stop check reads CLEAR and STOPPED from a key-only owner", async () => {
    for (const emergencyStop of [false, true]) {
      storePolicy({ ...FULL, emergencyStop }, CLAIMED_KERNEL);
      const res = await policyGet(callers().claimed, CLAIMED_KERNEL);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toStrictEqual({ policy: { emergencyStop }, updatedAt: UPDATED_AT });
      expect(runbookStop(res.statusCode, res.json())).toBe(emergencyStop ? "STOPPED" : "CLEAR");
    }
    noPolicy(CLAIMED_KERNEL);
    const missing = await policyGet(callers().claimed, CLAIMED_KERNEL);
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toStrictEqual({ policy: { emergencyStop: false }, source: "default" });
    expect(runbookStop(missing.statusCode, missing.json())).toBe("STOPPED");
    storePolicy(["n348"], CLAIMED_KERNEL);
    const unavailable = await policyGet(callers().claimed, CLAIMED_KERNEL);
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toStrictEqual(POLICY_READ_FAILED);
    expect(runbookStop(unavailable.statusCode, unavailable.json())).toBe("STOPPED");
  });

  it("OP10: an anonymous caller still gets the gate 401", async () => {
    storePolicy(FULL);
    expect((await policyGet({})).statusCode).toBe(401);
  });
});

describe("GET /api/kernels/:kernelId/agent-package", () => {
  it("AP1: the admin and the proven owner get the whole policy in the package and its prompt", async () => {
    storePolicy(FULL);
    const c = callers();
    for (const headers of [c.admin, c.owner, c["owner-cookie"]]) {
      const res = await packageGet(headers);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.operator_policy).toStrictEqual({
        approvalMode: "n348-approval-mode",
        operatingHours: FULL.operatingHours,
        timezone: "Pacific/Chatham",
        emergencyStop: false,
        pricingRules: [FULL.pricingRules[0]],
      });
      expect(body.system_prompt).toContain("## Operator Policy\n- Approval mode: n348-approval-mode\n- Operating hours: Pacific/Chatham\n- Emergency stop: inactive\n");
      expect(body.system_prompt).not.toContain("shown to this kernel's operator");
    }
  });

  it("AP2: any other caller gets the emergency stop alone in the package, and the rest of the package equals the admin's", async () => {
    storePolicy(FULL);
    const admin = await packageGet(callers().admin);
    expect(admin.statusCode).toBe(200);
    const { generated_at: adminGeneratedAt, ...adminPackage } = admin.json();
    expect(typeof adminGeneratedAt).toBe("string");
    const prompt = adminPackage.system_prompt.replace(
      "- Approval mode: n348-approval-mode\n- Operating hours: Pacific/Chatham",
      "- Approval mode and operating hours: shown to this kernel's operator and to admins only.",
    );
    for (const headers of otherCallers()) {
      const res = await packageGet(headers);
      expect(res.statusCode).toBe(200);
      const { generated_at: generatedAt, ...body } = res.json();
      expect(typeof generatedAt).toBe("string");
      expect(body.operator_policy).toStrictEqual({ emergencyStop: false });
      expect(body.system_prompt).toBe(prompt);
      expect(body).toStrictEqual({ ...adminPackage, operator_policy: { emergencyStop: false }, system_prompt: prompt });
      expect(body.tools.map((tool: { name: string }) => tool.name)).toContain("n348_custom_tool");
      expect(res.body).not.toContain("n348-approval-mode");
      expect(res.body).not.toContain("Pacific/Chatham");
    }
    storePolicy({ ...FULL, emergencyStop: true });
    for (const headers of otherCallers()) {
      const res = await packageGet(headers);
      expect(res.statusCode).toBe(200);
      expect(res.json().operator_policy).toStrictEqual({ emergencyStop: true });
      expect(res.json().system_prompt).toContain("- Emergency stop: ACTIVE");
    }
  });

  it("AP3: a stored truthy non-boolean stop is true and a stored 0 is false in a non-owner package", async () => {
    for (const emergencyStop of ["yes", 0]) {
      storePolicy({ ...FULL, emergencyStop });
      const res = await packageGet(callers().stranger);
      expect(res.statusCode).toBe(200);
      expect(res.json().operator_policy).toStrictEqual({ emergencyStop: Boolean(emergencyStop) });
      expect(res.json().system_prompt).toContain(`- Emergency stop: ${emergencyStop ? "ACTIVE" : "inactive"}`);
    }
  });

  it("AP4: a stored policy that is an array, a string or unparsed text gives a non-owner 503 with no package", async () => {
    for (const kind of ["array", "string", "unparsed"]) {
      if (kind === "unparsed") unparsedPolicy();
      else storePolicy(kind === "array" ? ["n348"] : "n348");
      for (const headers of otherCallers()) {
        const res = await packageGet(headers);
        expect(res.statusCode).toBe(503);
        expect(res.json()).toStrictEqual(POLICY_READ_FAILED);
      }
      const admin = await packageGet(callers().admin);
      expect(admin.statusCode).toBe(kind === "unparsed" ? 500 : 200);
      if (kind !== "unparsed") {
        expect(typeof admin.json().system_prompt).toBe("string");
        expect(Array.isArray(admin.json().tools)).toBe(true);
      }
    }
  });

  it("AP5: an unregistered kernel keeps the 404 for every caller", async () => {
    noPolicy(UNKNOWN);
    for (const headers of [callers().stranger, callers().owner, callers().admin]) {
      const res = await packageGet(headers, UNKNOWN);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toStrictEqual({ error: "Kernel not found" });
    }
  });

  it("AP6: a failed kernel read gives a non-admin 503 with no package", async () => {
    storePolicy(FULL);
    const spy = failKernelRead();
    try {
      for (const headers of [callers().stranger, callers().owner]) {
        const res = await packageGet(headers);
        expect(res.statusCode).toBe(503);
        expect(res.json()).toStrictEqual(KERNEL_READ_FAILED);
      }
      const admin = await packageGet(callers().admin);
      expect(admin.statusCode).toBe(200);
      expect(typeof admin.json().system_prompt).toBe("string");
      expect(Array.isArray(admin.json().tools)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
