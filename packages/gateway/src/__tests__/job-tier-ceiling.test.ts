/**
 * WP-C R7 (review round 2, LOW): the assurance ceiling also binds
 * KERNEL-SPECIFIC job contracts.
 *
 * A job names one kernel and persists the tier it was submitted at as its
 * contracted tier. Before R7, JobFacade.submit persisted any requested tier (up
 * to 3, or even an out-of-range number) for any kernel, whatever that kernel
 * was authorized for: the ceiling governed discovery and selection, not
 * contracting. Now a job at tier T > 0 on kernel K needs
 * T <= effectiveMaxAssuranceTier(K) = min(K's claimed tier, K's authorized
 * ceiling), else 400 `assurance_tier_not_authorized`; a malformed tier is 400
 * `invalid_assurance_tier`. Nothing is written on a refusal.
 *
 * Kernel rows are inserted directly with known ceilings (fixtures). The file
 * imports only modules that exist on the pre-R7 code, so it runs unchanged
 * against the pre-R7 facades/job.facade.ts to prove polarity: every [neg]
 * case fails there.
 *
 * finisher-lima2
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { jobSubmitRoutes } from "../routes/job-submit.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";
import { getJobFacade } from "../facades/index.js";
import {
  ensureKernelRow,
  SIGNED_FRESH_KERNEL_FIELDS,
  TRUSTED_KERNEL_FIELDS,
  UNSIGNED_KERNEL_FIELDS,
} from "./fixtures/authorized-kernels.js";

let app: FastifyInstance;
let buyerKey: string;
const BUYER = "r7-buyer";

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

/**
 * A kernel row with a known served tier, and the capability `cap-<id>-r7` ON it, so
 * a job's (kernel, capability) pair is consistent (N69) and these tests exercise the
 * tier alone.
 */
function kernel(prefix: string, fields: Record<string, unknown>): string {
  const id = uid(prefix);
  ensureKernelRow(id, { operatorAddress: "r7-operator@example.com", ...fields });
  getRepos().capabilities.insert({
    id: `cap-${id}-r7`,
    kernelId: id,
    type: "r7-test",
    name: "R7 test capability",
    materials: [],
    assuranceTiers: [0, 1, 2, 3],
    pricing: { baseCost: "0", minimum: "0", currency: "USDC" },
    availability: {},
    location: { lat: 0, lng: 0 },
  } as never);
  return id;
}

/** Submit through the facade, as every route and compose-execute do. */
async function submit(kernelId: string, assuranceTier: unknown) {
  const jobId = uid("r7-job");
  const res = await getJobFacade().submit(
    {
      jobId,
      stepId: uid("r7-step"),
      kernelId,
      capabilityId: `cap-${kernelId}-r7`,
      assuranceTier: assuranceTier as number,
    },
    BUYER,
  );
  return { res, jobId };
}

function expectRefused(
  out: Awaited<ReturnType<typeof submit>>,
  code: "assurance_tier_not_authorized" | "invalid_assurance_tier" | "capability_not_found",
) {
  expect(out.res.success).toBe(false);
  if (out.res.success) return;
  expect(out.res.error.httpStatus).toBe(400);
  expect(out.res.error.code).toBe(code);
  expect(getRepos().jobs.findById(out.jobId)).toBeFalsy();
}

function expectAccepted(out: Awaited<ReturnType<typeof submit>>, tier: number) {
  expect(out.res.success).toBe(true);
  expect(getRepos().jobs.findById(out.jobId)?.assuranceTier).toBe(tier);
}

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  buyerKey = provisionApiKey({ operatorId: BUYER, scopes: ["operator"] }).rawKey;
  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(jobSubmitRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
});

describe("WP-C R7: a job's tier must be within the kernel's served tier", () => {
  it("[neg] an UNSIGNED kernel claiming tier 3 (served 0) cannot be contracted at tier 1, 2 or 3; tier 0 is fine", async () => {
    const k = kernel("r7-unsigned", { ...UNSIGNED_KERNEL_FIELDS, maxAssuranceTier: 3 });
    for (const tier of [1, 2, 3]) expectRefused(await submit(k, tier), "assurance_tier_not_authorized");
    expectAccepted(await submit(k, 0), 0);
  });

  it("[neg] a SIGNED fresh kernel claiming 3 (ceiling 1, served 1) is contracted at 1 but not at 2", async () => {
    const k = kernel("r7-fresh", { ...SIGNED_FRESH_KERNEL_FIELDS, maxAssuranceTier: 3 });
    expectRefused(await submit(k, 2), "assurance_tier_not_authorized");
    expectRefused(await submit(k, 3), "assurance_tier_not_authorized");
    expectAccepted(await submit(k, 1), 1);
  });

  it("[neg] a TRUSTED kernel (ceiling 3) that CLAIMS only 2 is served at 2: tier 3 is refused, tier 2 accepted", async () => {
    const k = kernel("r7-trusted", { ...TRUSTED_KERNEL_FIELDS, maxAssuranceTier: 2 });
    expectRefused(await submit(k, 3), "assurance_tier_not_authorized");
    expectAccepted(await submit(k, 2), 2);
  });

  it("[neg] a kernel with NO row is served at 0: tier 1 is refused; tier 0 is now refused too, because no capability can be on it (N69)", async () => {
    const ghost = uid("r7-no-row");
    expectRefused(await submit(ghost, 1), "assurance_tier_not_authorized");
    // N69: the named capability does not exist, so the (kernel, capability) pair cannot
    // be consistent. Without a named capability, submission to a kernel with no
    // capabilities already failed (no_capability_found_for_kernel).
    expectRefused(await submit(ghost, 0), "capability_not_found");
  });

  it.each([
    ["5", 5],
    ["2.5", 2.5],
    ["-1", -1],
    ['"2" (string)', "2"],
    ["NaN", Number.NaN],
  ])("[neg] a malformed tier %s is 400 invalid_assurance_tier, nothing stored", async (_label, tier) => {
    const k = kernel("r7-malformed", { ...TRUSTED_KERNEL_FIELDS, maxAssuranceTier: 3 });
    expectRefused(await submit(k, tier), "invalid_assurance_tier");
  });

  it("an omitted tier is contracted at 0 (unchanged default)", async () => {
    const k = kernel("r7-default", { ...UNSIGNED_KERNEL_FIELDS, maxAssuranceTier: 3 });
    expectAccepted(await submit(k, undefined), 0);
  });

  it("[neg] over HTTP: POST /api/jobs/submit at tier 2 on an unsigned kernel -> 400 assurance_tier_not_authorized, no job", async () => {
    const k = kernel("r7-http", { ...UNSIGNED_KERNEL_FIELDS, maxAssuranceTier: 3 });
    const jobId = uid("r7-http-job");
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/submit",
      headers: { authorization: `Bearer ${buyerKey}` },
      payload: { jobId, stepId: "r7-http-step", kernelId: k, capabilityId: `cap-${k}-r7`, assuranceTier: 2 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("assurance_tier_not_authorized");
    expect(getRepos().jobs.findById(jobId)).toBeFalsy();
  });
});
