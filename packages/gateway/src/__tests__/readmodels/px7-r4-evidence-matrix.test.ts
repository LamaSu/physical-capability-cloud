/**
 * Cross-family review r3 of #441 (rm-px7-441-r3-01ed0dac), MEDIUM: the negative tests on the evidence
 * path were narrower than the attack list. This file pins the rest of it against the real routes:
 *   - every hash form the route accepts (bare, 0x, sha256:, mixed case, wrapped in spaces);
 *   - a forbidden hash answers exactly as an unknown one: status, content-type, body, and repository
 *     reads (the events are never read);
 *   - the verifier header: name case, value case, a repeated header, and a configured key one
 *     character short of the 32 minimum;
 *   - bundles of another tenant, and a bundle whose job row does not exist;
 *   - compliance reports over a mix of readable and unreadable bundles.
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
  submitEvidence: vi.fn(),
  releaseMilestone: vi.fn(),
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
  flushSettlements: vi.fn(),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));

vi.setConfig({ testTimeout: 20000 });

const OPERATOR_NYC = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x9999999999999999999999999999999999999999";
const BUYER_003 = "0x3333333333333333333333333333333333333333";
const ADMIN = "px7-r4-admin-key";
// Built at runtime, so no literal here looks like a secret. 32 characters exactly.
const VERIFIER = ["px7", "r4", "verifier", "0123456789abcdef"].join("-").padEnd(32, "x").slice(0, 32);
const HEX_A = "ab".repeat(32);
const HEX_B = "cd".repeat(32);
const PRIVATE_A = "px7-r4-private-a";
const PRIVATE_B = "px7-r4-private-b";
const CAP = "cap-nyc-fdm";

const STRANGER_H = { "x-test-principal": STRANGER, "x-test-proven-wallet": STRANGER };
const BUYER_H = { "x-test-principal": BUYER_003, "x-test-proven-wallet": BUYER_003 };
const OPERATOR_H = { "x-test-principal": OPERATOR_NYC, "x-test-proven-wallet": OPERATOR_NYC };
const ADMIN_H = { "x-admin-key": ADMIN };

let app: FastifyInstance;
let repos: any;
let danglingStored = false;

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN;
  process.env.MOCK_SETTLEMENT = "true";
  delete process.env.TENANT_ENFORCE;
  delete process.env.PCC_VERIFIER_READ_KEY;
  const db = await import("../../db.js");
  db.initStore({ seed: true });
  const store = db.getStore();
  repos = store.repos as any;
  const { schema, eq } = await import("@pcc/store");
  const now = new Date().toISOString();
  store.db.update(schema.jobs).set({ tenantId: "tenant-a" } as never).where(eq(schema.jobs.id, "job-001")).run();
  store.db.update(schema.jobs).set({ tenantId: "tenant-b" } as never).where(eq(schema.jobs.id, "job-003")).run();
  // job-003's only negotiation session names BUYER_003.
  store.db.insert(schema.negotiationSessions).values({
    id: "neg-px7-r4-003", status: "committed", userAgentId: BUYER_003, kernelId: "kernel-nyc", capabilityType: "fdm",
    operatorConstraints: {}, jobId: "job-003", createdAt: now, expiresAt: now,
  } as never).run();
  const bundle = (id: string, jobId: string, hash: string, tenantId: string | null, note: string) => {
    repos.evidence.insert({
      id, jobId, stepId: "step-1", kernelId: "kernel-nyc", assuranceTier: 1, tenantId, bundleHash: hash,
      kernelSignature: { signer: OPERATOR_NYC, algorithm: "secp256k1", value: "sig" }, createdAt: now,
    });
    repos.evidence.insertEvents([
      { id: `${id}-ev`, bundleId: id, type: "execution_completed", timestamp: now,
        source: { deviceId: "dev-fdm-prusa-mk4", deviceType: "controller", kernelId: "kernel-nyc" }, payload: { note }, hash: "e".repeat(64) },
    ]);
  };
  bundle("bun-r4-a", "job-001", `sha256:${HEX_A}`, "tenant-a", PRIVATE_A);
  // Stored in the 0x form: the route must match it from any accepted form.
  bundle("bun-r4-b", "job-003", `0x${HEX_B}`, "tenant-b", PRIVATE_B);
  try {
    bundle("bun-r4-ghost", "job-ghost", `sha256:${"ef".repeat(32)}`, null, "px7-r4-ghost");
    danglingStored = true;
  } catch {
    danglingStored = false; // the store enforces the job foreign key: no dangling bundle can exist
  }

  app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const principal = req.headers["x-test-principal"];
    if (typeof principal === "string") (req as any).operatorId = principal;
    const proven = req.headers["x-test-proven-wallet"];
    if (typeof proven === "string") (req as any).provenWallet = proven;
    const tenant = req.headers["x-test-tenant"];
    if (typeof tenant === "string") (req as any).tenantId = tenant;
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
  delete process.env.TENANT_ENFORCE;
});

const get = (url: string, headers: Record<string, string | string[]>) => app.inject({ method: "GET", url, headers: headers as never });
const envelope = (form: string, headers: Record<string, string | string[]>) => get(`/api/evidence/${encodeURIComponent(form)}`, headers);
/** A body with the requested hash form replaced, so a forbidden and an unknown answer compare. */
const masked = (body: string, form: string) => body.split(form).join("<hash>");

const FORMS_A = [
  HEX_A,
  `0x${HEX_A}`,
  `sha256:${HEX_A}`,
  `0X${HEX_A.toUpperCase()}`,
  `sha256:${HEX_A.slice(0, 32).toUpperCase()}${HEX_A.slice(32)}`,
  `  sha256:${HEX_A}  `,
];

describe("MEDIUM (review r3 of #441): every accepted hash form resolves, and refuses a stranger as an unknown hash would", () => {
  it("an admin reads bundle A from each form; bundle B, stored in its 0x form, from its sha256: form", async () => {
    for (const form of FORMS_A) {
      const res = await envelope(form, ADMIN_H);
      expect(res.statusCode, JSON.stringify(form)).toBe(200);
      expect(res.body, JSON.stringify(form)).toContain(PRIVATE_A);
    }
    expect((await envelope(`sha256:${HEX_B}`, ADMIN_H)).body).toContain(PRIVATE_B);
  });

  it("for each form, a stranger's answer equals an unknown hash's: status, content-type and body", async () => {
    for (const form of FORMS_A) {
      const unknownForm = form.replace(/ab/gi, (m) => (m === "ab" ? "12" : "12"));
      const known = await envelope(form, STRANGER_H);
      const unknown = await envelope(unknownForm, STRANGER_H);
      expect(known.statusCode, JSON.stringify(form)).toBe(404);
      expect([known.statusCode, known.headers["content-type"]]).toEqual([unknown.statusCode, unknown.headers["content-type"]]);
      expect(masked(known.body, encodeURIComponent(form).length ? form.trim() : form)).not.toContain(PRIVATE_A);
      expect(masked(known.body, form.trim())).toBe(masked(unknown.body, unknownForm.trim()));
    }
  });

  it("a stranger's forbidden hash and an unknown hash make the same repository reads, and never read the events", async () => {
    const byHash = vi.spyOn(repos.evidence, "findByHash");
    const events = vi.spyOn(repos.evidence, "findEventsByBundle");
    const jobs = vi.spyOn(repos.jobs, "findById");
    try {
      const calls = () => [byHash.mock.calls.length, events.mock.calls.length, jobs.mock.calls.length];
      for (const s of [byHash, events, jobs]) s.mockClear();
      await envelope(`sha256:${HEX_A}`, STRANGER_H);
      const forbidden = calls();
      for (const s of [byHash, events, jobs]) s.mockClear();
      await envelope(`sha256:${"12".repeat(32)}`, STRANGER_H);
      const unknown = calls();
      expect(forbidden).toEqual(unknown);
      expect(forbidden[1]).toBe(0);
    } finally {
      byHash.mockRestore();
      events.mockRestore();
      jobs.mockRestore();
    }
  });
});

describe("MEDIUM (review r3 of #441): the verifier header is exact, and a short configured key grants nothing", () => {
  it("the configured key opens the envelope whatever the header name's case; any other value is no credential", async () => {
    process.env.PCC_VERIFIER_READ_KEY = VERIFIER;
    try {
      expect((await envelope(`sha256:${HEX_A}`, { "x-verifier-key": VERIFIER })).statusCode).toBe(200);
      expect((await envelope(`sha256:${HEX_A}`, { "X-VERIFIER-KEY": VERIFIER })).statusCode).toBe(200);
      expect((await envelope(`sha256:${HEX_A}`, { "x-verifier-key": VERIFIER.toUpperCase() })).statusCode).toBe(401);
      expect((await envelope(`sha256:${HEX_A}`, { "x-verifier-key": ` ${VERIFIER}` })).statusCode).toBe(401);
      expect((await envelope(`sha256:${HEX_A}`, { "x-verifier-key": [VERIFIER, VERIFIER] })).statusCode).toBe(401);
    } finally {
      delete process.env.PCC_VERIFIER_READ_KEY;
    }
  });

  it("a configured key of 31 characters grants nothing, even to an exact header", async () => {
    const short = VERIFIER.slice(0, 31);
    process.env.PCC_VERIFIER_READ_KEY = short;
    try {
      expect((await envelope(`sha256:${HEX_A}`, { "x-verifier-key": short })).statusCode).toBe(401);
    } finally {
      delete process.env.PCC_VERIFIER_READ_KEY;
    }
  });
});

describe("MEDIUM (review r3 of #441): tenants, and bundles whose job row is gone", () => {
  it("under TENANT_ENFORCE, tenant A's admin gets the unknown-hash answer for tenant B's bundle, and tenant B's admin reads it", async () => {
    process.env.TENANT_ENFORCE = "true";
    try {
      const a = await envelope(`sha256:${HEX_B}`, { ...ADMIN_H, "x-test-tenant": "tenant-a" });
      const unknown = await envelope(`sha256:${"12".repeat(32)}`, { ...ADMIN_H, "x-test-tenant": "tenant-a" });
      expect(a.statusCode).toBe(404);
      expect(a.body).not.toContain(PRIVATE_B);
      expect(masked(a.body, `sha256:${HEX_B}`)).toBe(masked(unknown.body, `sha256:${"12".repeat(32)}`));
      const b = await envelope(`sha256:${HEX_B}`, { ...ADMIN_H, "x-test-tenant": "tenant-b" });
      expect(b.statusCode).toBe(200);
      expect(b.body).toContain(PRIVATE_B);
    } finally {
      delete process.env.TENANT_ENFORCE;
    }
  });

  it("a bundle whose job row does not exist is an unknown hash to an admin and to a stranger", async () => {
    if (!danglingStored) return; // the store refused it: nothing to pin
    for (const headers of [ADMIN_H, STRANGER_H]) {
      const res = await envelope(`sha256:${"ef".repeat(32)}`, headers);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("px7-r4-ghost");
    }
  });
});

describe("MEDIUM (review r3 of #441): a report over readable and unreadable bundles uses only the readable ones", () => {
  it("job-003's buyer: only bundle B, scope readable_by_caller, nothing of bundle A", async () => {
    const res = await get(`/api/capabilities/${CAP}/compliance`, BUYER_H);
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.evidenceScope).toBe("readable_by_caller");
    expect(r.recentEvidence.map((b: { jobId: string }) => b.jobId)).toEqual(["job-003"]);
    expect(r.bundlesConsidered).toBe(1);
    expect(res.body).not.toContain("job-001");
    expect(res.body).not.toContain(HEX_A);
  });

  it("under TENANT_ENFORCE, tenant A's admin: only tenant A's bundles, scope readable_by_caller", async () => {
    process.env.TENANT_ENFORCE = "true";
    try {
      const res = await get(`/api/capabilities/${CAP}/compliance`, { ...ADMIN_H, "x-test-tenant": "tenant-a" });
      expect(res.statusCode).toBe(200);
      const r = res.json();
      expect(r.evidenceScope).toBe("readable_by_caller");
      // The seed has its own job-001 bundles on this kernel: every listed bundle is tenant A's job.
      expect([...new Set(r.recentEvidence.map((b: { jobId: string }) => b.jobId))]).toEqual(["job-001"]);
      expect(res.body).not.toContain(HEX_B);
    } finally {
      delete process.env.TENANT_ENFORCE;
    }
  });

  it("the kernel's operator, without a tenant: every bundle, scope all", async () => {
    const r = (await get(`/api/capabilities/${CAP}/compliance`, OPERATOR_H)).json();
    expect(r.evidenceScope).toBe("all");
    const jobs = [...new Set(r.recentEvidence.map((b: { jobId: string }) => b.jobId))].sort();
    expect(jobs).toEqual(danglingStored ? ["job-001", "job-003", "job-ghost"] : ["job-001", "job-003"]);
  });
});
