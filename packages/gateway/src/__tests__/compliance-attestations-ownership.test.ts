/**
 * Regression test: POST /api/jobs/:jobId/attestations/aggregate ownership check
 * on the KERNEL-OPERATOR authorization path.
 *
 * Root cause (fixed in routes/compliance.ts — twin of the jobs.ts fix, PR #221):
 *   The kernel-ownership fallback compared `kernel.operatorId` — a field that
 *   does not exist on shopKernels (packages/db/src/schema/kernels.ts defines
 *   only `operatorAddress`). So `(kernel as any).operatorId` was always
 *   undefined, the comparison always failed, and a legitimate kernel operator
 *   was wrongly 403'd when aggregating attestations for their own job.
 *
 * The fix compares `kernel.operatorAddress` instead — the same email/wallet
 * identity space as the API key's operatorId:
 *   - middleware/api-gate.ts sets `req.operatorId = apiKey.operatorId`
 *   - paid-job-flow.ts `resolveOperatorPayoutAddress` already looks operators
 *     up via `repos.apiKeys.findByOperator(kernel.operatorAddress)`, treating
 *     kernel.operatorAddress and the API-key operatorId as the same space.
 *
 * Why this test is new: the existing compliance-routes.test.ts authorizes every
 * aggregate case through the `submittedBy` path (its beforeEach makes
 * kernels.findById return null), so it never exercised the buggy line — which
 * is how the IDOR slipped through. These cases drive the kernel-operator path
 * directly. The positive kernel-operator case FAILS (403) before the fix and
 * PASSES (200) after it.
 *
 * Style mirrors compliance-routes.test.ts (mocked facade + mocked repos), the
 * established idiom for this exact route, and proves the same both-sides
 * property as job-status-ownership.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { complianceRoutes } from "../routes/compliance.js";

// ── Fixture identities (email/wallet operator identity space) ────────────────
const JOB_ID = "job_attest_own_001";
const KERNEL_ID = "kernel_attest_own_001";
// The kernel's rightful operator (kernel.operatorAddress).
const KERNEL_OPERATOR = "0x1111111111111111111111111111111111111111";
// A different identity that submitted the job (job.submittedBy).
const JOB_SUBMITTER = "0x2222222222222222222222222222222222222222";
// An unrelated caller who owns neither the job nor the kernel.
const UNRELATED_OPERATOR = "0x9999999999999999999999999999999999999999";

const mockAggregatedAttestation = {
  jobId: JOB_ID,
  attestations: [],
  consensus: "no_quorum" as const,
  quorumRequired: 1,
  quorumAchieved: 0,
  aggregatedConfidence: 0,
};

// ── Mock facade (module-level; `mock`-prefixed for vi.mock hoisting) ─────────
const mockFacade = {
  generateComplianceReport: vi.fn(),
  detectDrift: vi.fn(),
  getEvidenceForJob: vi.fn(),
  getBundle: vi.fn(),
  checkTierCompliance: vi.fn(),
  aggregateAttestations: vi.fn(),
};

vi.mock("../facades/index.js", () => ({
  getComplianceFacade: () => mockFacade,
}));

// ── Mock repos — the auth gate reads jobs.findById + kernels.findById ────────
const mockJobsRepo = {
  findById: vi.fn(),
};
const mockKernelsRepo = {
  findById: vi.fn(),
};

vi.mock("../db.js", () => ({
  getRepos: () => ({
    jobs: mockJobsRepo,
    kernels: mockKernelsRepo,
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function ok<T>(data: T) {
  return { success: true as const, data };
}

/**
 * Build an app with an optionally-injected authenticated operator.
 * Omit `operatorId` to simulate an unauthenticated request (stays null → 401).
 */
async function buildApp(operatorId?: string) {
  const app = Fastify({ logger: false });
  app.decorateRequest("operatorId", null);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  if (operatorId !== undefined) {
    app.addHook("onRequest", async (req) => {
      (req as unknown as { operatorId: string }).operatorId = operatorId;
    });
  }
  await app.register(complianceRoutes);
  return app;
}

async function aggregate(app: Awaited<ReturnType<typeof buildApp>>) {
  return app.inject({
    method: "POST",
    url: `/api/jobs/${JOB_ID}/attestations/aggregate`,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ attestations: [] }),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/jobs/:jobId/attestations/aggregate — kernel-operator ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFacade.aggregateAttestations.mockResolvedValue(ok(mockAggregatedAttestation));
  });

  // ── POSITIVE: the kernel-operator path authorizes (the regression) ─────────
  it("authorizes the kernel's rightful operator (not 403) when submittedBy does NOT match", async () => {
    // Job was NOT submitted by the caller — authorization must come from the
    // kernel-operator fallback (the previously-broken line). Before the fix
    // this returned 403 because kernel.operatorId was always undefined.
    mockJobsRepo.findById.mockReturnValue({
      id: JOB_ID,
      submittedBy: JOB_SUBMITTER,
      kernelId: KERNEL_ID,
    });
    mockKernelsRepo.findById.mockReturnValue({
      id: KERNEL_ID,
      operatorAddress: KERNEL_OPERATOR,
    });

    const res = await aggregate(await buildApp(KERNEL_OPERATOR));

    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).toBe(200);
    // Confirms the kernel path was actually taken (submitter path missed).
    expect(mockKernelsRepo.findById).toHaveBeenCalledWith(KERNEL_ID);
    expect(mockFacade.aggregateAttestations).toHaveBeenCalledOnce();
  });

  // ── POSITIVE: the submitter path still authorizes (unchanged, intact) ──────
  it("still authorizes the job submitter via the submittedBy path", async () => {
    mockJobsRepo.findById.mockReturnValue({
      id: JOB_ID,
      submittedBy: JOB_SUBMITTER,
      kernelId: KERNEL_ID,
    });
    // Kernel would NOT match, proving authorization came from submittedBy.
    mockKernelsRepo.findById.mockReturnValue({
      id: KERNEL_ID,
      operatorAddress: KERNEL_OPERATOR,
    });

    const res = await aggregate(await buildApp(JOB_SUBMITTER));

    expect(res.statusCode).toBe(200);
    // submittedBy matched first → kernel lookup short-circuited, never called.
    expect(mockKernelsRepo.findById).not.toHaveBeenCalled();
  });

  // ── NEGATIVE: an unrelated caller is still 403'd (gate NOT weakened) ────────
  it("still rejects an unrelated caller with 403", async () => {
    mockJobsRepo.findById.mockReturnValue({
      id: JOB_ID,
      submittedBy: JOB_SUBMITTER,
      kernelId: KERNEL_ID,
    });
    mockKernelsRepo.findById.mockReturnValue({
      id: KERNEL_ID,
      operatorAddress: KERNEL_OPERATOR,
    });

    // Caller owns neither the job (submittedBy) nor the kernel (operatorAddress).
    const res = await aggregate(await buildApp(UNRELATED_OPERATOR));

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
    // The gate ran the kernel check and still rejected — proves it is intact,
    // not that the whole route is dead.
    expect(mockKernelsRepo.findById).toHaveBeenCalledWith(KERNEL_ID);
    expect(mockFacade.aggregateAttestations).not.toHaveBeenCalled();
  });

  // ── NEGATIVE: unauthenticated request is rejected with 401 ─────────────────
  it("rejects an unauthenticated request with 401", async () => {
    mockJobsRepo.findById.mockReturnValue({
      id: JOB_ID,
      submittedBy: JOB_SUBMITTER,
      kernelId: KERNEL_ID,
    });

    const res = await aggregate(await buildApp()); // no operator injected

    expect(res.statusCode).toBe(401);
    expect(mockFacade.aggregateAttestations).not.toHaveBeenCalled();
  });
});
