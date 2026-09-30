/**
 * N69, second round (astra pack 92b, HIGH): JobFacade.submit validates the
 * (kernel, capability) pair, but the PAID paths (createJobFromSession: commit,
 * retry-settlement, submit-from-discovery, A2A pcc-submit) bypassed it and
 * substituted a synthetic "cap-default" when the kernel had no capability —
 * storing a nonexistent or foreign capability and creating execution authority
 * for it, after escrow.
 *
 * Reproduced at 8c77b505 before any code changed: submit-from-discovery to a
 * kernel with no capability stored a job with capabilityId "cap-default".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { paidJobFlowRoutes, createJobFromSession } from "../routes/paid-job-flow.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { schema, eq } from "@pcc/store";

const { jobs } = schema;

let app: FastifyInstance;
const KERNEL_EMPTY = `kernel-n69paid-empty-${Date.now().toString(36)}`;
const KERNEL_OK = `kernel-n69paid-ok-${Date.now().toString(36)}`;
const CAP_TYPE = "fdm-printer";
const savedMock = process.env.MOCK_SETTLEMENT;

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true"; // synthetic escrow; the capability check runs regardless
  initStore({ seed: false });
  const { getKernelFacade } = await import("../facades/index.js");
  expect((await getKernelFacade().register({ id: KERNEL_EMPTY, name: "Empty kernel" }, "op-empty@x.test")).success).toBe(true);
  expect((await getKernelFacade().register({ id: KERNEL_OK, name: "OK kernel" }, "op-ok@x.test")).success).toBe(true);
  getRepos().capabilities.insert({
    id: `cap-${KERNEL_OK}-fdm`,
    kernelId: KERNEL_OK,
    type: CAP_TYPE,
    name: "FDM",
    materials: ["PLA"],
    assuranceTiers: [0],
    pricing: { currency: "USDC", baseCost: "10", minimum: "5" },
    availability: {},
    location: { lat: 0, lng: 0 },
  } as never);
  app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
  if (savedMock === undefined) delete process.env.MOCK_SETTLEMENT;
  else process.env.MOCK_SETTLEMENT = savedMock;
});

const discover = (kernelId: string, userAgentId: string) =>
  app.inject({
    method: "POST",
    url: "/api/jobs/submit-from-discovery",
    payload: { kernelId, capabilityType: CAP_TYPE, userAgentId },
  });

describe("N69 paid path: submit-from-discovery validates the (kernel, capability) pair (pack 92b)", () => {
  it("[neg] a kernel with NO capability is refused, and no job — least of all a 'cap-default' one — is stored", async () => {
    const res = await discover(KERNEL_EMPTY, "n69paid-buyer-a");
    expect(res.statusCode, res.body).not.toBe(201);
    const all = getStore().db.select().from(jobs).all() as Array<{ kernelId: string; capabilityId: string | null }>;
    expect(all.some((j) => j.kernelId === KERNEL_EMPTY), "no job on the empty kernel").toBe(false);
    expect(all.some((j) => j.capabilityId === "cap-default"), "no synthetic cap-default job anywhere").toBe(false);
  });

  it("[neg] a session naming a capability that belongs to ANOTHER kernel is refused (capability_not_on_kernel), before escrow", async () => {
    // The session's kernel is the empty one, but it names KERNEL_OK's capability.
    const session = {
      id: `sess-n69paid-foreign-${Date.now().toString(36)}`,
      kernelId: KERNEL_EMPTY,
      capabilityType: CAP_TYPE,
      capabilityId: `cap-${KERNEL_OK}-fdm`,
      quote: { totalPrice: "10.00" },
      contractTerms: { milestones: [{ stepId: "s1", amount: "10.00", bondAmount: "0.00", challengeWindowSeconds: 0 }] },
      userAgentId: "n69paid-foreign-buyer",
      cwmId: null,
      jobId: null,
    };
    await expect(createJobFromSession(session as never)).rejects.toThrow(/capability_not_on_kernel|not on kernel/);
    const all = getStore().db.select().from(jobs).all() as Array<{ kernelId: string }>;
    expect(all.some((j) => j.kernelId === KERNEL_EMPTY)).toBe(false);
  });

  it("control: a kernel WITH the capability creates a job bound to that real capability", async () => {
    const res = await discover(KERNEL_OK, "n69paid-buyer-b");
    expect(res.statusCode, res.body).toBe(201);
    const jobId = res.json().jobId as string;
    const row = getStore().db.select().from(jobs).where(eq(jobs.id, jobId)).get() as { capabilityId: string };
    expect(row.capabilityId).toBe(`cap-${KERNEL_OK}-fdm`);
  });
});
