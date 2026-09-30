/**
 * N31 / astra pack 110 F1 (CRITICAL): GET /api/kernels/:kernelId/agent-package
 * disclosed the operator's protected policy — approvalMode, emergencyStop,
 * operatingHours and pricingRules, plus the same fields inside the generated
 * system_prompt — to ANY authenticated key, for ANY kernel. The direct policy
 * read (GET /api/operator/policy/:kernelId) was already made owner-or-admin;
 * this route bypassed it.
 *
 * Reproduced at 4b504624 before any code changed. Now a non-owner gets the
 * public package (kernel, devices, capabilities, tools) with NO operator_policy
 * and a policy-free system prompt; the owner and the admin still get the full
 * policy.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { kernelAgentPackageRoutes } from "../routes/kernel-agent-package.js";
import { kernelRoutes } from "../routes/kernels.js";
import { operatorRoutes } from "../routes/operator.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";

process.env.PCC_DB_PATH = ":memory:";
const SECRET = "agent-pkg-policy-leak-admin-key";
process.env.PCC_ADMIN_KEY = SECRET;

const OWNER = "agentpkg-owner@x.test";
const ATTACKER = "agentpkg-attacker@x.test";
let app: FastifyInstance;
let ownerKey: string;
let attackerKey: string;
let seq = 0;
const KERNEL = `kernel-agentpkg-${Date.now().toString(36)}`;

const get = (url: string, key: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${key}`, ...headers } });

beforeAll(async () => {
  initStore({ seed: false });
  ownerKey = provisionApiKey({ operatorId: OWNER, scopes: ["operator"] }).rawKey;
  attackerKey = provisionApiKey({ operatorId: ATTACKER, scopes: ["operator"] }).rawKey;
  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(kernelRoutes);
  await app.register(operatorRoutes);
  await app.register(kernelAgentPackageRoutes);
  await app.ready();

  const { getKernelFacade } = await import("../facades/index.js");
  const reg = await getKernelFacade().register({ id: KERNEL, name: "Owner's kernel" }, OWNER);
  expect(reg.success).toBe(true);
  // The owner sets a distinctive policy (via the owner-only write path).
  const put = await app.inject({
    method: "PUT",
    url: `/api/operator/policy/${KERNEL}`,
    headers: { authorization: `Bearer ${ownerKey}` },
    payload: { version: 1, approvalMode: "manual", emergencyStop: true },
  });
  expect(put.statusCode, put.body).toBeLessThan(300);
});

afterAll(async () => {
  await app.close();
  closeStore();
  delete process.env.PCC_ADMIN_KEY;
});

describe("agent-package does not leak the operator policy across owners (pack 110 F1)", () => {
  it("[neg] a non-owner's agent-package carries no operator_policy and no e-stop in the system prompt", async () => {
    const res = await get(`/api/kernels/${KERNEL}/agent-package`, attackerKey);
    expect(res.statusCode, res.body).toBe(200); // public discovery of tools stays available
    const pkg = res.json();
    expect(pkg.operator_policy, "operator_policy must be absent for a non-owner").toBeUndefined();
    // The owner's REAL policy values must not surface anywhere (a non-owner may
    // see default-policy boilerplate, but never the owner's actual settings).
    // The owner set emergencyStop:true (default is false), so the owner's REAL
    // value is detectable: a non-owner must see neither the JSON key nor the
    // "ACTIVE" e-stop text — only default boilerplate ("inactive").
    expect(res.body).not.toContain("emergencyStop"); // the JSON policy key (operator_policy omitted)
    expect(String(pkg.system_prompt ?? "")).not.toMatch(/ACTIVE — all jobs suspended/i);
    // The public package still describes the kernel.
    expect(pkg.kernel?.id).toBe(KERNEL);
  });

  it("control: the owner sees the full operator_policy, including emergencyStop", async () => {
    const res = await get(`/api/kernels/${KERNEL}/agent-package`, ownerKey);
    expect(res.statusCode, res.body).toBe(200);
    const pkg = res.json();
    expect(pkg.operator_policy?.approvalMode).toBe("manual");
    expect(pkg.operator_policy?.emergencyStop).toBe(true);
  });

  it("control: the admin secret also sees the full operator_policy", async () => {
    const res = await get(`/api/kernels/${KERNEL}/agent-package`, attackerKey, { "x-admin-key": SECRET });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().operator_policy?.emergencyStop).toBe(true);
  });
});
