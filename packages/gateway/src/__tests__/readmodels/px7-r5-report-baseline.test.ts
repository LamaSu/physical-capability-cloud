/**
 * Cross-family review r4 of #441 (rm-px7-441-r4-3c6783bc), MEDIUM 3: a compliance report computed
 * for a caller over a mix of readable and unreadable bundles must equal, in EVERY field it derives
 * (ALCOA+, tier compliance, standards, drift alerts, the assurance score, the capture-verification
 * summary, the evidence list and the bundle count), the report over a dataset that holds only the
 * readable bundles. A kernel of its own keeps the seed's evidence out of both datasets.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../../services/posthog-service.js", () => ({ trackServerEvent: vi.fn(), shutdownPostHog: vi.fn() }));
vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest123", metadataCid: "bafymeta456" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafyenc789", metadataCid: "bafyencmeta012" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.setConfig({ testTimeout: 20000 });

const OPERATOR = "0x7777777777777777777777777777777777777777";
const BUYER = "0x5555555555555555555555555555555555555555";
const OTHER_BUYER = "0x6666666666666666666666666666666666666666";
const ADMIN = "px7-r5-baseline-admin-key";
const KERNEL = "kernel-px7r5";
const CAP = "cap-px7r5";
const READABLE_JOB = "job-r5-readable";
const HIDDEN_JOB = "job-r5-hidden";

const BUYER_H = { "x-test-principal": BUYER, "x-test-proven-wallet": BUYER };
const ADMIN_H = { "x-admin-key": ADMIN };

let app: FastifyInstance;
let store: any;
let schema: any;
let eq: any;
const hiddenBundleIds: string[] = [];

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN;
  delete process.env.TENANT_ENFORCE;
  const db = await import("../../db.js");
  db.initStore({ seed: true });
  store = db.getStore();
  ({ schema, eq } = await import("@pcc/store"));
  const repos = store.repos;

  // A kernel, capability and two jobs of their own, cloned from the seed's rows.
  repos.kernels.insert({ ...repos.kernels.findById("kernel-nyc"), id: KERNEL, operatorAddress: OPERATOR });
  repos.capabilities.insert({ ...repos.capabilities.findById("cap-nyc-fdm"), id: CAP, kernelId: KERNEL });
  for (const id of [READABLE_JOB, HIDDEN_JOB]) {
    repos.jobs.insert({ ...repos.jobs.findById("job-001"), id, kernelId: KERNEL, capabilityId: CAP, tenantId: null });
  }
  const now = new Date().toISOString();
  for (const [jobId, buyer] of [[READABLE_JOB, BUYER], [HIDDEN_JOB, OTHER_BUYER]] as const) {
    store.db.insert(schema.negotiationSessions).values({
      id: `neg-${jobId}`, status: "committed", userAgentId: buyer, kernelId: KERNEL, capabilityType: "fdm",
      operatorConstraints: {}, jobId, createdAt: now, expiresAt: now,
    } as never).run();
  }

  // The hidden bundles carry every event type the tiers ask for (spec DEFAULT_TIER_REQUIREMENTS) and
  // a power profile; the readable ones only a completion. So counting a hidden bundle changes the
  // derived fields, not only the list and the count.
  const RICH = ["gcode_hash_verified", "execution_started", "power_profile_summary", "camera_snapshot", "cv_inspection_result", "execution_completed"];
  const eventsOf = (types: string[], timestamp: string) =>
    types.map((type) => ({
      type, timestamp, hash: "e".repeat(64),
      source: { deviceId: "dev-fdm-prusa-mk4", deviceType: "controller", kernelId: KERNEL },
      payload: type === "power_profile_summary" ? { avgWatts: 950, peakWatts: 4100, expectedWatts: 180, durationSec: 9000 } : { note: type },
    }));
  const bundle = (id: string, jobId: string, tier: number, createdAt: string, events: Record<string, unknown>[]) => {
    repos.evidence.insert({
      id, jobId, stepId: "step-1", kernelId: KERNEL, assuranceTier: tier, tenantId: null, bundleHash: `sha256:${id.padEnd(64, "0").slice(0, 64)}`,
      kernelSignature: { signer: OPERATOR, algorithm: "secp256k1", value: "sig" }, createdAt,
    });
    repos.evidence.insertEvents(events.map((e, i) => ({ ...e, id: `${id}-ev-${i}`, bundleId: id })));
  };
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  bundle("bun-r5-readable-1", READABLE_JOB, 1, at(50), eventsOf(["execution_completed"], at(50)));
  bundle("bun-r5-readable-2", READABLE_JOB, 1, at(40), eventsOf(["execution_completed"], at(40)));
  // Newer than the readable ones, so they would sit at the top of the recent five.
  for (const [i, minutesAgo] of [30, 20, 10].entries()) {
    const id = `bun-r5-hidden-${i}`;
    bundle(id, HIDDEN_JOB, 3, at(minutesAgo), eventsOf(RICH, at(minutesAgo)));
    hiddenBundleIds.push(id);
  }
  const verdict = (id: string, jobId: string, verdict: string, cls: number) =>
    store.db.insert(schema.captureVerdicts).values({
      id, jobId, operatorId: OPERATOR, captureHash: `sha256:${"c".repeat(64)}`, manifestHash: `sha256:${"d".repeat(64)}`,
      declaredClass: cls, verifiedClass: cls, verdict, gatesPassed: [1, 2, 3], gatesFailed: [], warnings: [], anchorCandidate: 0,
      resultJson: {}, declaredClassStr: `CC${cls}`, verifiedClassStr: `CC${cls}`, createdAt: now,
    } as never).run();
  verdict("cv-r5-readable", READABLE_JOB, "PARTIAL", 2);
  verdict("cv-r5-hidden", HIDDEN_JOB, "PASS", 5);

  app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const principal = req.headers["x-test-principal"];
    if (typeof principal === "string") (req as any).operatorId = principal;
    const proven = req.headers["x-test-proven-wallet"];
    if (typeof proven === "string") (req as any).provenWallet = proven;
  });
  const { complianceRoutes } = await import("../../routes/compliance.js");
  await app.register(complianceRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  (await import("../../db.js")).closeStore();
  delete process.env.PCC_ADMIN_KEY;
});

const report = async (headers: Record<string, string>) => {
  const res = await app.inject({ method: "GET", url: `/api/capabilities/${CAP}/compliance`, headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Record<string, unknown>;
};
/** Every field of a report except evidenceScope, which says whose evidence it is. */
const derived = ({ evidenceScope: _scope, ...rest }: Record<string, unknown>) => rest;

describe("MEDIUM 3 (review r4 of #441): a report over readable and unreadable bundles equals the report over the readable ones alone", () => {
  it("in every derived field, while the unreadable bundles would have changed them", async () => {
    // The clock is held still: a drift alert for a missing event is stamped when the report is made,
    // and the two reports are made at different moments. Every evidence-derived value is compared.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-03T08:00:00.000Z") });
    try {
      await compareReports();
    } finally {
      vi.useRealTimers();
    }
  });
});

async function compareReports() {
  {
    const mixed = await report(BUYER_H);
    expect(mixed.evidenceScope).toBe("readable_by_caller");
    expect((mixed.recentEvidence as { jobId: string }[]).map((b) => b.jobId)).toEqual([READABLE_JOB, READABLE_JOB]);

    // Counted, the hidden bundles change more than the list and the count: the test can see a leak.
    const everything = derived(await report(ADMIN_H));
    const changed = Object.keys(everything).filter((k) => JSON.stringify(everything[k]) !== JSON.stringify(derived(mixed)[k]));
    expect(changed).toEqual(
      expect.arrayContaining(["recentEvidence", "bundlesConsidered", "tierCompliance", "captureVerification", "assuranceScore"]),
    );

    // The equivalent dataset: the same kernel with only the readable bundles (and their job's verdict).
    for (const id of hiddenBundleIds) {
      store.db.delete(schema.evidenceEvents).where(eq(schema.evidenceEvents.bundleId, id)).run();
      store.db.delete(schema.evidenceBundles).where(eq(schema.evidenceBundles.id, id)).run();
    }
    store.db.delete(schema.captureVerdicts).where(eq(schema.captureVerdicts.jobId, HIDDEN_JOB)).run();
    const baseline = await report(ADMIN_H);
    expect(baseline.evidenceScope).toBe("all");

    expect(derived(mixed)).toEqual(derived(baseline));
  }
}
