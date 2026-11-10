/**
 * Board N31 (#575 r2): auth/kernel-authority.ts fails closed on its own, not only behind apiGate.
 *   - Mounted WITHOUT apiGate, every operator-control write refuses an anonymous caller with 401
 *     from the route itself (the gate is defense in front of it, not the only check).
 *   - A kernel read that fails is 503 for a non-admin, never a pass, for both kinds of action.
 * The production-mounted cases are in n31-operator-route-ownership.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { EXPLICIT_CREDENTIAL_REQUIRED, provenByCookieOnly, refuseKernelAction, type KernelAuthority } from "../auth/kernel-authority.js";
import { operatorRoutes } from "../routes/operator.js";
import { kernelAgentPackageRoutes } from "../routes/kernel-agent-package.js";
import { initStore, closeStore } from "../db.js";

const PREV_DB = process.env.PCC_DB_PATH;
const WALLET = "0x1111111111111111111111111111111111111111"; // seeded kernel-nyc's operator

describe("N31 without apiGate in front, the routes themselves refuse an anonymous caller", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    closeStore();
    initStore({ seed: true });
    app = Fastify({ logger: false });
    await app.register(operatorRoutes);
    await app.register(kernelAgentPackageRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    if (PREV_DB === undefined) delete process.env.PCC_DB_PATH;
    else process.env.PCC_DB_PATH = PREV_DB;
  });

  const WRITES: Array<[string, string, Record<string, unknown>]> = [
    ["POST", "/api/operator/emergency-stop", { kernelId: "kernel-nyc" }],
    ["POST", "/api/operator/emergency-resume", { kernelId: "kernel-nyc" }],
    ["PUT", "/api/operator/policy/kernel-nyc", { version: 1 }],
    ["PATCH", "/api/operator/policy/kernel-nyc", { emergencyStop: false }],
    ["POST", "/api/operator/approvals", { kernelId: "kernel-nyc", agentId: "agent-anon" }],
    ["POST", "/api/operator/approvals/approval-anon/approve", {}],
    ["POST", "/api/operator/approvals/approval-anon/reject", {}],
    ["PUT", "/api/kernels/kernel-nyc/agent-package/configure", { customTools: [] }],
  ];

  for (const [method, url, payload] of WRITES) {
    it(`${method} ${url}: 401 authentication_required`, async () => {
      const res = await app.inject({ method: method as "POST", url, payload });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: "authentication_required" });
    });
  }
});

describe("N31 a kernel read that fails is 503, never a pass", () => {
  const req = { headers: {}, log: { warn: () => undefined } } as never;
  const proven: KernelAuthority = { admin: false, provenWallet: WALLET, provenWalletCarrier: "key", claimed: WALLET };

  it("for a decision and for a stop, while the store cannot be read", () => {
    closeStore(); // getStore() now throws, as a failed read would
    for (const action of ["decide", "stop_or_submit"] as const) {
      const refusal = refuseKernelAction(req, proven, "kernel-nyc", action);
      expect(refusal?.status, action).toBe(503);
      expect(refusal?.body).toMatchObject({ error: "read_failed" });
    }
  });

  it("the admin does not read the kernel, so it still proceeds", () => {
    closeStore();
    expect(refuseKernelAction(req, { admin: true, provenWallet: null, claimed: null }, "kernel-nyc", "decide")).toBeNull();
  });
});

describe("N176 decisions require an explicit carrier for a proven wallet", () => {
  const req = { headers: {}, log: { warn: () => undefined } } as never;
  const proven: KernelAuthority = { admin: false, provenWallet: WALLET, claimed: WALLET };

  beforeAll(() => {
    process.env.PCC_DB_PATH = ":memory:";
    closeStore();
    initStore({ seed: true });
  });

  afterAll(() => {
    closeStore();
    if (PREV_DB === undefined) delete process.env.PCC_DB_PATH;
    else process.env.PCC_DB_PATH = PREV_DB;
  });

  it.each([undefined, null, "cookie"] as const)("refuses a proven wallet carried by %s", carrier => {
    const authority = { ...proven, provenWalletCarrier: carrier };
    expect(provenByCookieOnly(authority)).toBe(true);
    expect(refuseKernelAction(req, authority, "kernel-nyc", "decide")).toEqual({
      status: 403, body: EXPLICIT_CREDENTIAL_REQUIRED,
    });
    expect(refuseKernelAction(req, authority, "kernel-nyc", "read")).toBeNull();
    expect(refuseKernelAction(req, authority, "kernel-nyc", "stop_or_submit")).toBeNull();
  });

  it.each(["key", "bearer-session"] as const)("allows a proven operator carried by %s", carrier => {
    const authority = { ...proven, provenWalletCarrier: carrier };
    expect(provenByCookieOnly(authority)).toBe(false);
    expect(refuseKernelAction(req, authority, "kernel-nyc", "decide")).toBeNull();
  });

  it("refuses an unknown carrier", () => {
    const authority = { ...proven, provenWalletCarrier: "unknown" as never };
    expect(provenByCookieOnly(authority)).toBe(true);
    expect(refuseKernelAction(req, authority, "kernel-nyc", "decide")).toEqual({
      status: 403, body: EXPLICIT_CREDENTIAL_REQUIRED,
    });
  });

  it.each([undefined, null, "cookie"] as const)("preserves the admin exemption with carrier %s", carrier => {
    const authority = { ...proven, admin: true, provenWalletCarrier: carrier };
    expect(provenByCookieOnly(authority)).toBe(false);
    expect(refuseKernelAction(req, authority, "kernel-nyc", "decide")).toBeNull();
  });

  it("leaves a caller without wallet proof to the ownership refusal", () => {
    const authority = { ...proven, provenWallet: null };
    expect(provenByCookieOnly(authority)).toBe(false);
    expect(refuseKernelAction(req, authority, "kernel-nyc", "decide")).toMatchObject({
      status: 403, body: { reason: "operator_proof_required" },
    });
  });
});
