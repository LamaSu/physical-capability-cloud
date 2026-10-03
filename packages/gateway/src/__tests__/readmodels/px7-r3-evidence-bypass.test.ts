/**
 * Cross-family review r2 of #441 (rm-px7-441-r2-e411a9b3, CRITICAL): the capability compliance
 * report named each recent bundle's job and hash to anyone, and GET /api/evidence/:hash served
 * the whole canonical envelope (its events' sources and payloads) to anyone who had the hash.
 * Together they handed a stranger another job's raw evidence. These tests reproduce that at
 * e411a9b3 and pin the rule that replaces it:
 *   - the report is computed only from the evidence the caller may read: all of it for an admin
 *     or the kernel's operator, the bundles of its own jobs for anyone else; evidenceScope and
 *     bundlesConsidered say which;
 *   - the envelope by hash is a job record: an admin, a party to the bundle's job, or the
 *     verifier read key (PCC_VERIFIER_READ_KEY, for the settlement oracle) reads it; anyone else
 *     gets exactly the answer an unknown hash gets.
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

vi.mock("../../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({ transactionHash: "0xtest_evidence_tx", status: "submitted" }),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xtest_release_tx", status: "submitted" }),
  isWriteEnabled: vi.fn().mockReturnValue(false),
  getSignerAddress: vi.fn().mockReturnValue(undefined),
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(undefined),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn(),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  MilestoneStatus: {},
  milestoneStatusName: vi.fn().mockReturnValue("unknown"),
}));

vi.mock("../../contracts/batch-settlement.js", () => ({
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(null),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn().mockResolvedValue({ epochId: "epoch-1", totalIntents: 0, batches: [], byAgent: {}, byOperation: {}, startedAt: 0, completedAt: 0 }),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));

vi.setConfig({ testTimeout: 20000 });

const OPERATOR_NYC = "0x1111111111111111111111111111111111111111"; // seeded kernel-nyc operator
const STRANGER = "0x9999999999999999999999999999999999999999";
const ADMIN = "px7-r3-admin-key";
// The verifier read key is built at runtime, so no literal in this file looks like a secret.
const VERIFIER = ["px7", "r3", "verifier", "read", "key", "0123456789abcdef"].join("-");
const PRIVATE = "px7-r3-private-payload";
const HASH = `sha256:${"ab".repeat(32)}`;
const MISSING_HASH = `sha256:${"cd".repeat(32)}`;
const CAP = "cap-nyc-fdm"; // seeded on kernel-nyc; job-001 runs on it

const ANON = {};
const UNPROVEN = { "x-test-principal": OPERATOR_NYC };
const STRANGER_H = { "x-test-principal": STRANGER, "x-test-proven-wallet": STRANGER };
const OPERATOR_H = { "x-test-principal": OPERATOR_NYC, "x-test-proven-wallet": OPERATOR_NYC };
const ADMIN_H = { "x-admin-key": ADMIN };

let app: FastifyInstance;

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN;
  process.env.MOCK_SETTLEMENT = "true";
  const db = await import("../../db.js");
  db.initStore({ seed: true });
  const repos = db.getStore().repos as any;
  const now = new Date().toISOString();
  // job-001 (seeded, kernel-nyc) gets a bundle whose event carries a distinctive private payload.
  repos.evidence.insert({
    id: "bun-px7-r3", jobId: "job-001", stepId: "step-1", kernelId: "kernel-nyc", assuranceTier: 2,
    bundleHash: HASH, kernelSignature: { signer: OPERATOR_NYC, algorithm: "secp256k1", value: "sig_px7_r3" }, createdAt: now,
  });
  repos.evidence.insertEvents([
    {
      id: "bun-px7-r3-ev-0", bundleId: "bun-px7-r3", type: "execution_completed", timestamp: now,
      source: { deviceId: "dev-fdm-prusa-mk4", deviceType: "controller", kernelId: "kernel-nyc" },
      payload: { note: PRIVATE }, hash: "e".repeat(64),
    },
  ]);

  app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const principal = req.headers["x-test-principal"];
    if (typeof principal === "string") (req as any).operatorId = principal;
    const proven = req.headers["x-test-proven-wallet"];
    if (typeof proven === "string") (req as any).provenWallet = proven;
  });
  const { complianceRoutes } = await import("../../routes/compliance.js");
  const { settlementRoutes } = await import("../../routes/settlement.js");
  await app.register(complianceRoutes);
  await app.register(settlementRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  (await import("../../db.js")).closeStore();
  delete process.env.PCC_ADMIN_KEY;
  delete process.env.MOCK_SETTLEMENT;
  delete process.env.PCC_VERIFIER_READ_KEY;
});

const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });
const report = (headers: Record<string, string>) => get(`/api/capabilities/${CAP}/compliance`, headers);
const envelope = (headers: Record<string, string>, hash = HASH) => get(`/api/evidence/${hash}`, headers);

describe("CRITICAL (review r2 of #441): the compliance report and the envelope by hash give a stranger no job's evidence", () => {
  it("a stranger's report names no job, bundle or hash it may not read, and says what it covers", async () => {
    const res = await report(STRANGER_H);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("job-001");
    expect(res.body).not.toContain("ab".repeat(32));
    expect(res.json().recentEvidence).toEqual([]);
    expect(res.json().evidenceScope).toBe("readable_by_caller");
    expect(res.json().bundlesConsidered).toBe(0);
  });

  it("a stranger asking for the envelope by hash gets exactly what an unknown hash gets", async () => {
    const known = await envelope(STRANGER_H);
    const unknown = await envelope(STRANGER_H, MISSING_HASH);
    expect(known.statusCode).toBe(404);
    expect(known.body).not.toContain(PRIVATE);
    expect(known.body.replace("ab".repeat(32), "X")).toBe(unknown.body.replace("cd".repeat(32), "X"));
  });

  it("identity first: no credential is 401 and an unproven one 403, on both routes", async () => {
    expect([(await report(ANON)).statusCode, (await envelope(ANON)).statusCode]).toEqual([401, 401]);
    expect([(await report(UNPROVEN)).statusCode, (await envelope(UNPROVEN)).statusCode]).toEqual([403, 403]);
  });

  it("the kernel's operator and an admin read the whole report and the envelope", async () => {
    for (const headers of [OPERATOR_H, ADMIN_H]) {
      const r = (await report(headers)).json();
      expect(r.evidenceScope).toBe("all");
      expect(r.bundlesConsidered).toBeGreaterThanOrEqual(1);
      expect(r.recentEvidence.map((b: { jobId: string }) => b.jobId)).toContain("job-001");
      const e = await envelope(headers);
      expect(e.statusCode).toBe(200);
      expect(e.body).toContain(PRIVATE);
    }
  });

  it("the verifier read key reads the envelope byte for byte, and only when the gateway has one set", async () => {
    const admin = await envelope(ADMIN_H);
    expect((await envelope({ "x-verifier-key": VERIFIER })).statusCode).toBe(401); // no key configured: grants nothing
    process.env.PCC_VERIFIER_READ_KEY = VERIFIER;
    try {
      const verifier = await envelope({ "x-verifier-key": VERIFIER });
      expect(verifier.statusCode).toBe(200);
      expect(verifier.body).toBe(admin.body);
      expect(verifier.headers["content-type"]).toBe(admin.headers["content-type"]);
      expect((await envelope({ "x-verifier-key": VERIFIER + "x" })).statusCode).toBe(401);
      // The verifier key reads envelopes only: it is not an identity for the report.
      expect((await report({ "x-verifier-key": VERIFIER })).statusCode).toBe(401);
    } finally {
      delete process.env.PCC_VERIFIER_READ_KEY;
    }
  });
});
