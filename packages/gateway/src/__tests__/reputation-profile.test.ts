import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance, type HTTPMethods } from "fastify";
import fastifySwagger from "@fastify/swagger";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { schema } from "@pcc/store";
import { getRepos, getStore, initStore, closeStore } from "../db.js";
import {
  reputationRoutes,
  _clearReputationForTests,
  _seedReputationForTests,
} from "../routes/reputation.js";
import {
  getJobOffersStore,
  initJobOffersStore,
  _resetJobOffersStoreForTests,
  type SqliteDatabaseLike,
} from "../services/job-offers-store.js";
import { createOperationIdTransform } from "../openapi/operation-id.js";
import {
  buildReputationProfile,
  PROFILE_RULES,
} from "../readmodels/reputation-profile.js";

const RULE_COMPOSITION = "The composition reputation record: a 0-1000 score that starts at 500 and moves with finalized composition step outcomes and dispute rulings. GET /api/reputation/:agentId/deltas lists its recorded changes. This read never creates a record.";
const RULE_ASSURANCE = "The maximum assurance tier stored on the kernel's record. This read reports that record and does not check it.";
const RULE_EVIDENCE_TIERS = "This kernel's evidence bundles created in the window, counted by tier. These are stored records; this count does not check whether any was verified.";
const RULE_LIVENESS = "Current liveness, not uptime: the kernel's status and last heartbeat. Only status online can be stale: its heartbeat age must exceed 5 minutes, or 24 hours if it lists at least one capability. A missing or invalid heartbeat is stale.";
const RULE_RESPONSE = "Seconds from an offer's posting to this kernel's claim, over offers posted in the window that this kernel claimed. Offers it did not claim count for nothing, so this is not a response rate. Offers this kernel posted are left out; self-posted offers the gateway cannot tie to the kernel, such as a DID poster's, are still counted.";
const RULE_COMPLETENESS = "Of this kernel's jobs with status completed and a completion time in the window, how many have an evidence bundle stored for this kernel at or above the job's assurance tier (a job with no tier counts as tier 0). A completion is a recorded status, and this count does not check whether any bundle was verified. Jobs that finish through settlement (evidence_submitted, evidence_stored, settled) are not counted yet.";
const SUMMARY = "One reputation read for a kernel or composition agent";
const DESCRIPTION = "Reports, field by field, what PCC records about a kernel or composition agent: its composition score, declared assurance tier, evidence bundles by tier, liveness, offer response time and evidence completeness. Each field names its basis and rule, or says why it is unavailable; there is no blended score. The record fields use evidence created, offers posted, or jobs completed in the last 30 days; completeness can use evidence stored at any time. Each needs at least 5 eligible records and is withheld while tenant isolation is on. Quality rating is not read here, and uptime is not measured yet. This profile handler changes no domain records and reads no chain.";
const NOT_FOUND = "No kernel or composition reputation record has this id.";
const QUALITY_SEE = "GET /api/registry/reputation/:entityId";

const DAY = 86_400_000;
let clock = Date.now();
let app: FastifyInstance;
let offerCounter = 0;

function inWindowIso(): string {
  return new Date(Date.now() - DAY).toISOString();
}
function oldIso(): string {
  return new Date(Date.now() - 31 * DAY).toISOString();
}
function isoMs(ms: number): string {
  return new Date(ms).toISOString();
}

function seedKernel(
  id: string,
  opts: { status: string; lastHeartbeat: string | null; maxAssuranceTier: number },
): void {
  getRepos().kernels.insert({
    id,
    name: `Kernel ${id}`,
    operatorAddress: `0x${id}`,
    location: { lat: 0, lng: 0 },
    physicalAddress: "1 Test St",
    maxAssuranceTier: opts.maxAssuranceTier,
    publicKey: "pk",
    reputation: 0,
    totalJobsCompleted: 0,
    status: opts.status,
    registeredAt: new Date().toISOString(),
    lastHeartbeat: opts.lastHeartbeat,
    version: "1.0.0",
  } as never);
}

function seedCapability(id: string, kernelId: string): void {
  getRepos().capabilities.insert({
    id,
    kernelId,
    type: "fdm",
    name: `Cap ${id}`,
    materials: ["PLA"],
    assuranceTiers: [0, 1],
    pricing: { currency: "USDC", baseCost: "10", minimum: "5" },
    availability: {},
    location: { lat: 0, lng: 0 },
  } as never);
}

function seedJob(
  id: string,
  kernelId: string,
  capabilityId: string,
  opts: { status: string; assuranceTier: number | null; completedAt: string | null },
): void {
  getRepos().jobs.insert({
    id,
    stepId: `step-${id}`,
    cwmId: `cwm-${id}`,
    capabilityId,
    kernelId,
    status: opts.status,
    assignedDevices: [],
    startedAt: new Date().toISOString(),
    progress: 0,
    assuranceTier: opts.assuranceTier,
    completedAt: opts.completedAt,
  } as never);
}

function seedBundle(id: string, jobId: string, kernelId: string, tier: number, createdAt: string): void {
  getRepos().evidence.insert({
    id,
    jobId,
    stepId: "step-0",
    kernelId,
    assuranceTier: tier,
    bundleHash: `sha256:${id}`,
    kernelSignature: { signer: kernelId, algorithm: "ed25519", value: "sig-test" },
    createdAt,
  } as never);
}

async function createOffer(postMs: number, posterKernelId?: string): Promise<string> {
  clock = postMs;
  offerCounter += 1;
  const input: Record<string, unknown> = {
    capabilityType: "courier.dispatch",
    requirements: { externalRef: `ref-${offerCounter}-${postMs}` },
    pricing: { amount: 6.7, currency: "USD", model: "fixed" },
  };
  if (posterKernelId !== undefined) input.posterKernelId = posterKernelId;
  const created = await getJobOffersStore().create(input as never);
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("offer create failed");
  return created.offer.id;
}

async function createAndClaim(postMs: number, delaySec: number, kernelId: string, posterKernelId?: string): Promise<string> {
  const offerId = await createOffer(postMs, posterKernelId);
  clock = postMs + delaySec * 1000;
  const claimed = await getJobOffersStore().claim(offerId, { kernelId });
  expect(claimed.ok).toBe(true);
  return offerId;
}

async function getProfile(id: string) {
  return app.inject({ method: "GET", url: `/api/reputation/${id}/profile` });
}

beforeEach(async () => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("TENANT_ENFORCE", "");
  closeStore();
  initStore({ seed: false });
  _clearReputationForTests();
  _resetJobOffersStoreForTests();
  clock = Date.now();
  initJobOffersStore({ now: () => new Date(clock) });
  app = Fastify({ logger: false });
  await app.register(reputationRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  closeStore();
  _resetJobOffersStoreForTests();
});

describe("reputation profile", () => {
  it("RP1 returns the counts for a kernel with mixed records", async () => {
    expect(PROFILE_RULES).toEqual({
      compositionScore: RULE_COMPOSITION,
      assuranceTier: RULE_ASSURANCE,
      evidenceTiers: RULE_EVIDENCE_TIERS,
      liveness: RULE_LIVENESS,
      responseTime: RULE_RESPONSE,
      evidenceCompleteness: RULE_COMPLETENESS,
    });
    const heartbeat = isoMs(Date.now() - 60_000);
    seedKernel("K1", { status: "online", lastHeartbeat: heartbeat, maxAssuranceTier: 2 });
    seedCapability("C1", "K1");
    seedKernel("K2", { status: "online", lastHeartbeat: heartbeat, maxAssuranceTier: 2 });
    seedCapability("C2", "K2");
    const inw = inWindowIso();
    const old = oldIso();
    seedJob("J1", "K1", "C1", { status: "completed", assuranceTier: 0, completedAt: inw });
    seedBundle("B1", "J1", "K1", 0, inw);
    seedJob("J2", "K1", "C1", { status: "completed", assuranceTier: 1, completedAt: inw });
    seedBundle("B2", "J2", "K1", 2, inw);
    seedJob("J3", "K1", "C1", { status: "completed", assuranceTier: 2, completedAt: inw });
    seedBundle("B3", "J3", "K1", 1, inw);
    seedJob("J4", "K1", "C1", { status: "completed", assuranceTier: 1, completedAt: inw });
    seedJob("J5", "K1", "C1", { status: "completed", assuranceTier: null, completedAt: inw });
    seedBundle("B5", "J5", "K1", 0, inw);
    seedJob("J6", "K1", "C1", { status: "completed", assuranceTier: 0, completedAt: inw });
    seedBundle("B6", "J6", "K2", 0, inw);
    seedJob("J7", "K1", "C1", { status: "completed", assuranceTier: 0, completedAt: old });
    seedBundle("B7", "J7", "K1", 0, old);
    seedJob("J8", "K1", "C1", { status: "failed", assuranceTier: 0, completedAt: null });
    seedBundle("B8", "J8", "K1", 3, inw);
    seedJob("J9", "K1", "C1", { status: "settled", assuranceTier: 0, completedAt: null });

    const res = await getProfile("K1");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body.subject).toEqual({ id: "K1", kind: "kernel" });
    expect(body.window.days).toBe(30);
    expect(body.window.to).toBe(body.asOf);
    expect(Date.parse(body.window.to) - Date.parse(body.window.from)).toBe(30 * DAY);
    expect(body.assuranceTier).toEqual({ state: "declared", tier: 2, basis: "kernel_record", rule: RULE_ASSURANCE });
    expect(body.compositionScore).toEqual({ state: "unavailable", reason: "no_record" });
    expect(body.evidenceTiers).toEqual({ state: "measured", byTier: { "0": 2, "1": 1, "2": 1, "3": 1 }, total: 5, basis: "stored_records", rule: RULE_EVIDENCE_TIERS });
    expect(body.evidenceCompleteness).toEqual({ state: "measured", completed: 6, withEvidence: 3, ratio: 0.5, basis: "stored_records", rule: RULE_COMPLETENESS });
    expect(body.responseTime).toEqual({ state: "unavailable", reason: "insufficient_sample" });
    expect(body.uptime).toEqual({ state: "unavailable", reason: "no_heartbeat_history", liveness: { status: "online", lastHeartbeat: heartbeat, isStale: false, rule: RULE_LIVENESS } });
  });

  it("RP2 enforces the sample floor across the record fields", async () => {
    const NOW = Date.parse("2025-06-15T12:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const heartbeat = isoMs(NOW - 60_000);
    seedKernel("K3", { status: "online", lastHeartbeat: heartbeat, maxAssuranceTier: 1 });
    seedCapability("C3", "K3");
    const inw = inWindowIso();
    const asOf = new Date(NOW).toISOString();
    const from = new Date(NOW - 30 * DAY).toISOString();
    const belowFloor = {
      subject: { id: "K3", kind: "kernel" },
      asOf,
      window: { days: 30, from, to: asOf },
      compositionScore: { state: "unavailable", reason: "no_record" },
      assuranceTier: { state: "declared", tier: 1, basis: "kernel_record", rule: RULE_ASSURANCE },
      evidenceTiers: { state: "unavailable", reason: "insufficient_sample" },
      qualityRating: { state: "unavailable", reason: "not_read", see: QUALITY_SEE },
      uptime: { state: "unavailable", reason: "no_heartbeat_history", liveness: { status: "online", lastHeartbeat: heartbeat, isStale: false, rule: RULE_LIVENESS } },
      responseTime: { state: "unavailable", reason: "insufficient_sample" },
      evidenceCompleteness: { state: "unavailable", reason: "insufficient_sample" },
    };
    let res = await getProfile("K3");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(belowFloor);
    for (let i = 1; i <= 4; i++) {
      seedJob(`KJ${i}`, "K3", "C3", { status: "completed", assuranceTier: 0, completedAt: inw });
      seedBundle(`KB${i}`, `KJ${i}`, "K3", 0, inw);
      await createAndClaim(Date.now() - 2 * DAY, 30, "K3");
      res = await getProfile("K3");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(belowFloor);
    }
    seedJob("KJ5", "K3", "C3", { status: "completed", assuranceTier: 0, completedAt: inw });
    seedBundle("KB5", "KJ5", "K3", 0, inw);
    await createAndClaim(Date.now() - 2 * DAY, 30, "K3");
    res = await getProfile("K3");
    const body = res.json();
    expect(body).toEqual({
      subject: { id: "K3", kind: "kernel" },
      asOf,
      window: { days: 30, from, to: asOf },
      compositionScore: { state: "unavailable", reason: "no_record" },
      assuranceTier: { state: "declared", tier: 1, basis: "kernel_record", rule: RULE_ASSURANCE },
      evidenceTiers: { state: "measured", byTier: { "0": 5 }, total: 5, basis: "stored_records", rule: RULE_EVIDENCE_TIERS },
      qualityRating: { state: "unavailable", reason: "not_read", see: QUALITY_SEE },
      uptime: { state: "unavailable", reason: "no_heartbeat_history", liveness: { status: "online", lastHeartbeat: heartbeat, isStale: false, rule: RULE_LIVENESS } },
      responseTime: { state: "measured", medianSeconds: 30, p90Seconds: 30, sampleSize: 5, basis: "job_offer_claims", rule: RULE_RESPONSE },
      evidenceCompleteness: { state: "measured", completed: 5, withEvidence: 5, ratio: 1, basis: "stored_records", rule: RULE_COMPLETENESS },
    });
  });

  it("RP3 computes response time medians and percentile", async () => {
    const heartbeat = isoMs(Date.now() - 60_000);
    seedKernel("K4", { status: "online", lastHeartbeat: heartbeat, maxAssuranceTier: 1 });
    seedCapability("C4", "K4");
    seedKernel("K5", { status: "online", lastHeartbeat: heartbeat, maxAssuranceTier: 1 });
    seedCapability("C5", "K5");
    const post = Date.now() - 2 * DAY;
    for (const delay of [60, 120, 180, 240, 600]) {
      await createAndClaim(post, delay, "K4");
    }
    await createAndClaim(post, 1, "K4", "K4");
    await createOffer(post);
    await createAndClaim(Date.now() - 31 * DAY, 5, "K4");
    for (const delay of [10, 20, 30, 40, 50, 60]) {
      await createAndClaim(post, delay, "K5");
    }
    const res4 = await getProfile("K4");
    const body4 = res4.json();
    expect(body4.responseTime).toEqual({ state: "measured", medianSeconds: 180, p90Seconds: 600, sampleSize: 5, basis: "job_offer_claims", rule: RULE_RESPONSE });
    const res5 = await getProfile("K5");
    const body5 = res5.json();
    expect(body5.responseTime).toEqual({ state: "measured", medianSeconds: 35, p90Seconds: 60, sampleSize: 6, basis: "job_offer_claims", rule: RULE_RESPONSE });
  });

  it("RP4 reports liveness and never uptime", async () => {
    const cases: Array<{ id: string; status: string; heartbeatMs: number; hasCap: boolean; stale: boolean }> = [
      { id: "KL1", status: "online", heartbeatMs: Date.now() - 60_000, hasCap: false, stale: false },
      { id: "KL2", status: "online", heartbeatMs: Date.now() - 10 * 60_000, hasCap: false, stale: true },
      { id: "KL3", status: "online", heartbeatMs: Date.now() - 10 * 60_000, hasCap: true, stale: false },
      { id: "KL4", status: "online", heartbeatMs: Date.now() - 25 * 60 * 60_000, hasCap: true, stale: true },
      { id: "KL5", status: "offline", heartbeatMs: Date.now() - 60_000, hasCap: false, stale: false },
      { id: "KL6", status: "maintenance", heartbeatMs: Date.now() - 60_000, hasCap: false, stale: false },
    ];
    for (const c of cases) {
      const hb = isoMs(c.heartbeatMs);
      seedKernel(c.id, { status: c.status, lastHeartbeat: hb, maxAssuranceTier: 1 });
      if (c.hasCap) seedCapability(`CC-${c.id}`, c.id);
      const res = await getProfile(c.id);
      const body = res.json();
      expect(body.uptime.liveness.isStale).toBe(c.stale);
      expect(body.uptime).toEqual({ state: "unavailable", reason: "no_heartbeat_history", liveness: { status: c.status, lastHeartbeat: hb, isStale: c.stale, rule: RULE_LIVENESS } });
      expect(JSON.stringify(body)).not.toContain("uptimePercent");
    }
  });

  it("RP5 never reads quality rating or the chain", async () => {
    seedKernel("KQ", { status: "online", lastHeartbeat: isoMs(Date.now() - 60_000), maxAssuranceTier: 1 });
    seedCapability("CQ", "KQ");
    const res = await getProfile("KQ");
    const body = res.json();
    expect(body.qualityRating).toEqual({ state: "unavailable", reason: "not_read", see: "GET /api/registry/reputation/:entityId" });
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../readmodels/reputation-profile.ts"), "utf8");
    const specifiers: string[] = [];
    const re = /(?:from\s+|import\s+|import\s*\(\s*|require\(\s*)["'`]([^"'`]+)["'`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specifiers.push(m[1]);
    expect(specifiers).toEqual(["../facades/populators/staleness.js"]);
    expect(source).not.toMatch(/import\s*\(/);
    expect(source).not.toMatch(/require\s*\(/);
    for (const s of specifiers) {
      expect(s).not.toMatch(/ethers|viem|web3|registry|erc8004|chain|rpc|contracts|wallet/i);
    }
    function moduleLoads(source: string): { specifiers: string[]; loaders: string[] } {
      const tree = ts.createSourceFile("m.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const specifiers: string[] = [];
      const loaders: string[] = [];
      const walk = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            specifiers.push(node.moduleSpecifier.text);
          }
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
          const expression = node.moduleReference.expression;
          if (expression && ts.isStringLiteral(expression)) specifiers.push(expression.text);
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
          specifiers.push(node.argument.literal.text);
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          loaders.push("import");
        } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === "meta") {
          loaders.push("import.meta");
        } else if (ts.isIdentifier(node) && ["require", "eval", "Function", "createRequire"].includes(node.text)) {
          loaders.push(node.text);
        }
        ts.forEachChild(node, walk);
      };
      walk(tree);
      return { specifiers, loaders };
    }
    expect(moduleLoads(source)).toEqual({ specifiers: ["../facades/populators/staleness.js"], loaders: [] });
    for (const control of [
      'export const a = () => import /* c */ ("../x.js");',
      'export const a = () => import // c\n("../x.js");',
      'const p = "../x.js"; export const a = () => import(p);',
      'export const a = () => require /* c */ ("../x.js");',
      'export * from "../x.js";',
      'import x = require("../x.js");',
    ]) {
      const loads = moduleLoads(control);
      expect(loads.loaders.length > 0 || loads.specifiers.some((s) => s !== "../facades/populators/staleness.js")).toBe(true);
    }
    expect(moduleLoads('import { a } from "../facades/populators/staleness.js"; export const b = a;')).toEqual({
      specifiers: ["../facades/populators/staleness.js"], loaders: [],
    });
  });

  it("RP6 resolves subjects by kind", async () => {
    let res = await getProfile("unknown-id");
    expect(res.statusCode).toBe(404);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ error: "unknown_subject", message: NOT_FOUND });

    const lastUpdatedAt = new Date().toISOString();
    _seedReputationForTests({ agentId: "agent-x", kind: "composer", score: 640, positiveContributions: 3, negativeContributions: 1, disputesUpheld: 0, disputesRejected: 1, lastUpdatedAt });
    res = await getProfile("agent-x");
    expect(res.statusCode).toBe(200);
    let body = res.json();
    expect(body.subject).toEqual({ id: "agent-x", kind: "composer" });
    expect(body.compositionScore).toEqual({ state: "measured", score: 640, positiveContributions: 3, negativeContributions: 1, disputesUpheld: 0, disputesRejected: 1, lastUpdatedAt, basis: "composition_deltas", rule: RULE_COMPOSITION });
    expect(body.assuranceTier).toEqual({ state: "unavailable", reason: "not_a_kernel" });
    expect(body.evidenceTiers).toEqual({ state: "unavailable", reason: "not_a_kernel" });
    expect(body.uptime).toEqual({ state: "unavailable", reason: "not_a_kernel" });
    expect(body.responseTime).toEqual({ state: "unavailable", reason: "not_a_kernel" });
    expect(body.evidenceCompleteness).toEqual({ state: "unavailable", reason: "not_a_kernel" });

    seedKernel("K6", { status: "online", lastHeartbeat: isoMs(Date.now() - 60_000), maxAssuranceTier: 3 });
    seedCapability("C6", "K6");
    const kUpdated = new Date().toISOString();
    _seedReputationForTests({ agentId: "K6", kind: "operator-kernel", score: 700, positiveContributions: 2, negativeContributions: 0, disputesUpheld: 1, disputesRejected: 0, lastUpdatedAt: kUpdated });
    res = await getProfile("K6");
    body = res.json();
    expect(body.subject).toEqual({ id: "K6", kind: "kernel" });
    expect(body.compositionScore).toEqual({ state: "measured", score: 700, positiveContributions: 2, negativeContributions: 0, disputesUpheld: 1, disputesRejected: 0, lastUpdatedAt: kUpdated, basis: "composition_deltas", rule: RULE_COMPOSITION });
  });

  it("RP7 changes no domain records on a read", async () => {
    _seedReputationForTests({ agentId: "agent-only", kind: "composer", score: 500, positiveContributions: 0, negativeContributions: 0, disputesUpheld: 0, disputesRejected: 0, lastUpdatedAt: new Date().toISOString() });
    seedKernel("K7", { status: "online", lastHeartbeat: isoMs(Date.now() - 60_000), maxAssuranceTier: 1 });
    seedCapability("C7", "K7");
    const inw = inWindowIso();
    const offerIds: string[] = [];
    for (let i = 1; i <= 5; i++) {
      seedJob(`WJ${i}`, "K7", "C7", { status: "completed", assuranceTier: 0, completedAt: inw });
      seedBundle(`WB${i}`, `WJ${i}`, "K7", 0, inw);
      offerIds.push(await createAndClaim(Date.now() - 2 * DAY, 30, "K7"));
    }
    const raw = (getStore().db as unknown as { $client?: SqliteDatabaseLike }).$client;
    if (!raw) throw new Error("test rig: no raw SQLite handle on the store");
    const catalogBefore = raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master").all();
    const tableNames = (catalogBefore as Array<{ type: string; name: string }>).filter((r) => r.type === "table").map((r) => r.name).filter((n) => n !== "api_keys");
    const snapshotTables = (): Record<string, unknown[]> => {
      const out: Record<string, unknown[]> = {};
      for (const name of tableNames) {
        const rows = raw.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all() as unknown[];
        out[name] = [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }
      return out;
    };
    const tablesBefore = snapshotTables();
    const totalBefore = (raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const offersBefore = new Map(offerIds.map((id) => [id, { offer: structuredClone(getJobOffersStore().get(id)), events: structuredClone(getJobOffersStore().getEvents(id)) }]));
    const offerCountBefore = getJobOffersStore().size();
    for (const id of ["unknown-7", "agent-only", "K7"]) {
      await getProfile(id);
      await getProfile(id);
    }
    const res = await getProfile("unknown-7");
    expect(res.statusCode).toBe(404);
    const catalogAfter = raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master").all();
    expect(catalogAfter).toEqual(catalogBefore);
    expect(snapshotTables()).toEqual(tablesBefore);
    const totalAfter = (raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    expect(totalAfter - totalBefore).toBe(0);
    expect(getJobOffersStore().size()).toBe(offerCountBefore);
    for (const id of offerIds) {
      expect(getJobOffersStore().get(id)).toEqual(offersBefore.get(id)?.offer);
      expect(getJobOffersStore().getEvents(id)).toEqual(offersBefore.get(id)?.events);
    }
  });

  it("RP8 withholds record fields under tenant isolation", async () => {
    const NOW = Date.parse("2025-06-15T12:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const heartbeat = isoMs(NOW - 60_000);
    const compUpdated = new Date(NOW).toISOString();
    _seedReputationForTests({ agentId: "K8", kind: "composer", score: 640, positiveContributions: 3, negativeContributions: 1, disputesUpheld: 0, disputesRejected: 1, lastUpdatedAt: compUpdated });
    seedKernel("K8", { status: "online", lastHeartbeat: heartbeat, maxAssuranceTier: 2 });
    seedCapability("C8", "K8");
    const inw = inWindowIso();
    const jobsSpy = vi.spyOn(getRepos().jobs, "findByKernel");
    const bundlesSpy = vi.spyOn(getRepos().evidence, "findByKernel");
    const offersSpy = vi.spyOn(getJobOffersStore(), "listClaimedBy");
    const spies: Array<{ mockClear(): unknown; mockRestore(): unknown }> = [jobsSpy, bundlesSpy, offersSpy];
    for (const target of [getRepos().jobs, getRepos().evidence, getJobOffersStore()]) {
      const seen = new Set<PropertyKey>();
      for (let current: object | null = target; current && current !== Object.prototype; current = Object.getPrototypeOf(current)) {
        for (const key of Reflect.ownKeys(current)) {
          if (seen.has(key)) continue;
          seen.add(key);
          if (key === "constructor") continue;
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (descriptor && "value" in descriptor && typeof descriptor.value === "function" && !vi.isMockFunction(descriptor.value)) {
            spies.push(vi.spyOn(target as unknown as Record<PropertyKey, (...args: never[]) => unknown>, key));
          }
        }
      }
    }
    try {
      const asOf = new Date(NOW).toISOString();
      const from = new Date(NOW - 30 * DAY).toISOString();
      const isolated = {
        subject: { id: "K8", kind: "kernel" },
        asOf,
        window: { days: 30, from, to: asOf },
        compositionScore: { state: "measured", score: 640, positiveContributions: 3, negativeContributions: 1, disputesUpheld: 0, disputesRejected: 1, lastUpdatedAt: compUpdated, basis: "composition_deltas", rule: RULE_COMPOSITION },
        assuranceTier: { state: "declared", tier: 2, basis: "kernel_record", rule: RULE_ASSURANCE },
        evidenceTiers: { state: "unavailable", reason: "tenant_scoped" },
        qualityRating: { state: "unavailable", reason: "not_read", see: QUALITY_SEE },
        uptime: { state: "unavailable", reason: "no_heartbeat_history", liveness: { status: "online", lastHeartbeat: heartbeat, isStale: false, rule: RULE_LIVENESS } },
        responseTime: { state: "unavailable", reason: "tenant_scoped" },
        evidenceCompleteness: { state: "unavailable", reason: "tenant_scoped" },
      };
      vi.stubEnv("TENANT_ENFORCE", "true");
      for (const spy of spies) spy.mockClear();
      const readA = await getProfile("K8");
      expect(readA.statusCode).toBe(200);
      expect(jobsSpy).not.toHaveBeenCalled();
      expect(bundlesSpy).not.toHaveBeenCalled();
      expect(offersSpy).not.toHaveBeenCalled();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(readA.json()).toEqual(isolated);

      for (let i = 1; i <= 5; i++) {
        seedJob(`TJ${i}`, "K8", "C8", { status: "completed", assuranceTier: 0, completedAt: inw });
        seedBundle(`TB${i}`, `TJ${i}`, "K8", 0, inw);
        await createAndClaim(Date.now() - 2 * DAY, 30, "K8");
      }
      seedKernel("K9", { status: "online", lastHeartbeat: heartbeat, maxAssuranceTier: 2 });
      seedCapability("C9", "K9");
      for (let i = 1; i <= 2; i++) {
        seedJob(`T9J${i}`, "K9", "C9", { status: "completed", assuranceTier: 0, completedAt: inw });
        seedBundle(`T9B${i}`, `T9J${i}`, "K9", 0, inw);
        await createAndClaim(Date.now() - 2 * DAY, 30, "K9");
      }
      for (const spy of spies) spy.mockClear();
      const readB = await getProfile("K8");
      expect(readB.statusCode).toBe(200);
      expect(jobsSpy).not.toHaveBeenCalled();
      expect(bundlesSpy).not.toHaveBeenCalled();
      expect(offersSpy).not.toHaveBeenCalled();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      const bodyOn = readB.json();
      expect(bodyOn).toEqual(isolated);
      const withoutHeaders = (headers: typeof readA.headers, excluded: string[]) =>
        Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.includes(name)));
      expect({ status: readB.statusCode, body: bodyOn, headers: withoutHeaders(readB.headers, ["date"]) }).toEqual({
        status: readA.statusCode, body: readA.json(), headers: withoutHeaders(readA.headers, ["date"]),
      });
      expect(withoutHeaders(readB.headers, ["date", "connection", "keep-alive", "content-length"])).toEqual({
        "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      });

      vi.stubEnv("TENANT_ENFORCE", "");
      for (const spy of spies) spy.mockClear();
      const readC = await getProfile("K8");
      expect(readC.statusCode).toBe(200);
      expect(jobsSpy).toHaveBeenCalled();
      expect(bundlesSpy).toHaveBeenCalled();
      expect(offersSpy).toHaveBeenCalled();
      const bodyOff = readC.json();
      expect(bodyOff).toEqual({
        subject: { id: "K8", kind: "kernel" },
        asOf,
        window: { days: 30, from, to: asOf },
        compositionScore: { state: "measured", score: 640, positiveContributions: 3, negativeContributions: 1, disputesUpheld: 0, disputesRejected: 1, lastUpdatedAt: compUpdated, basis: "composition_deltas", rule: RULE_COMPOSITION },
        assuranceTier: { state: "declared", tier: 2, basis: "kernel_record", rule: RULE_ASSURANCE },
        evidenceTiers: { state: "measured", byTier: { "0": 5 }, total: 5, basis: "stored_records", rule: RULE_EVIDENCE_TIERS },
        qualityRating: { state: "unavailable", reason: "not_read", see: QUALITY_SEE },
        uptime: { state: "unavailable", reason: "no_heartbeat_history", liveness: { status: "online", lastHeartbeat: heartbeat, isStale: false, rule: RULE_LIVENESS } },
        responseTime: { state: "measured", medianSeconds: 30, p90Seconds: 30, sampleSize: 5, basis: "job_offer_claims", rule: RULE_RESPONSE },
        evidenceCompleteness: { state: "measured", completed: 5, withEvidence: 5, ratio: 1, basis: "stored_records", rule: RULE_COMPLETENESS },
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("RP9 exposes the profile in the OpenAPI spec", async () => {
    const swaggerApp = Fastify({ logger: false });
    await swaggerApp.register(fastifySwagger, {
      transform: createOperationIdTransform(),
      openapi: { info: { title: "Test", version: "0.1.0" } },
    });
    await swaggerApp.register(reputationRoutes);
    await swaggerApp.ready();
    try {
      const doc = (swaggerApp as unknown as { swagger(): unknown }).swagger() as {
        paths: Record<string, { get?: Record<string, unknown> }>;
      };
      const op = doc.paths["/api/reputation/{subjectId}/profile"]?.get as
        | {
            operationId?: string;
            tags?: string[];
            summary?: string;
            description?: string;
            parameters?: Array<{ name?: string; in?: string; required?: boolean }>;
            responses?: Record<string, unknown>;
          }
        | undefined;
      expect(op).toBeDefined();
      expect(op?.operationId).toBe("get_api_reputation_by_subjectid_profile");
      expect(op?.tags).toEqual(["reputation"]);
      expect(op?.summary).toBe(SUMMARY);
      expect(op?.description).toBe(DESCRIPTION);
      expect(op?.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: "subjectId", in: "path", required: true })]));
      expect(op?.responses).toHaveProperty("200");
      expect(op?.responses).toHaveProperty("404");
      expect(doc.paths["/api/reputation/leaderboard"]).toBeDefined();
      expect(doc.paths["/api/reputation/{agentId}"]).toBeDefined();
      expect(doc.paths["/api/reputation/{agentId}/deltas"]).toBeDefined();
    } finally {
      await swaggerApp.close();
    }
  });

  it("RP10 marks unreadable sources per field", async () => {
    seedKernel("K10", { status: "online", lastHeartbeat: isoMs(Date.now() - 60_000), maxAssuranceTier: 1 });
    seedCapability("C10", "K10");
    const inw = inWindowIso();
    for (let i = 1; i <= 5; i++) {
      seedJob(`UJ${i}`, "K10", "C10", { status: "completed", assuranceTier: 0, completedAt: inw });
      seedBundle(`UB${i}`, `UJ${i}`, "K10", 0, inw);
    }
    _resetJobOffersStoreForTests();
    let res = await getProfile("K10");
    let body = res.json();
    expect(body.responseTime).toEqual({ state: "unavailable", reason: "source_unreadable" });
    expect(body.evidenceTiers.state).toBe("measured");
    expect(body.evidenceCompleteness.state).toBe("measured");

    const now = new Date();
    const kernelObj = { id: "KD", status: "online", lastHeartbeat: now.toISOString(), maxAssuranceTier: 1 };
    const jobsArr = Array.from({ length: 5 }, (_, i) => ({ id: `DJ${i}`, kernelId: "KD", status: "completed", completedAt: now.toISOString(), assuranceTier: 0 }));
    const bundlesArr = Array.from({ length: 5 }, (_, i) => ({ jobId: `DJ${i}`, kernelId: "KD", assuranceTier: 0, createdAt: now.toISOString() }));
    const offersArr = Array.from({ length: 5 }, () => ({ postedAt: now.toISOString(), claimedAt: new Date(now.getTime() + 30_000).toISOString(), claimedByKernelId: "KD", posterKernelId: null }));
    const base = {
      kernel: () => kernelObj,
      reputation: () => undefined,
      capabilityCount: () => 0,
      tenantEnforced: false,
    };
    let dto = buildReputationProfile("KD", { ...base, jobs: () => jobsArr, bundles: () => { throw new Error("boom"); }, claimedOffers: () => offersArr }, now);
    expect(dto?.evidenceTiers).toEqual({ state: "unavailable", reason: "source_unreadable" });
    expect(dto?.evidenceCompleteness).toEqual({ state: "unavailable", reason: "source_unreadable" });
    expect(dto?.responseTime).toEqual({ state: "measured", medianSeconds: 30, p90Seconds: 30, sampleSize: 5, basis: "job_offer_claims", rule: RULE_RESPONSE });
    dto = buildReputationProfile("KD", { ...base, jobs: () => { throw new Error("boom"); }, bundles: () => bundlesArr, claimedOffers: () => offersArr }, now);
    expect(dto?.evidenceCompleteness).toEqual({ state: "unavailable", reason: "source_unreadable" });
    expect(dto?.evidenceTiers.state).toBe("measured");
  });

  it("RP11 readers are gated by isolation and subject kind", async () => {
    const now = new Date();
    const kernelObj = { id: "KS", status: "online", lastHeartbeat: now.toISOString(), maxAssuranceTier: 1 };
    const jobsArr = Array.from({ length: 5 }, (_, i) => ({ id: `SJ${i}`, kernelId: "KS", status: "completed", completedAt: now.toISOString(), assuranceTier: 0 }));
    const bundlesArr = Array.from({ length: 5 }, (_, i) => ({ jobId: `SJ${i}`, kernelId: "KS", assuranceTier: 0, createdAt: now.toISOString() }));
    const offersArr = Array.from({ length: 5 }, () => ({ postedAt: now.toISOString(), claimedAt: new Date(now.getTime() + 30_000).toISOString(), claimedByKernelId: "KS", posterKernelId: null }));
    const makeSources = (tenantEnforced: boolean, isKernel: boolean) => ({
      kernel: vi.fn(() => (isKernel ? kernelObj : undefined)),
      reputation: vi.fn(() => (isKernel ? undefined : { agentId: "agent-spy", kind: "composer", score: 500, positiveContributions: 0, negativeContributions: 0, disputesUpheld: 0, disputesRejected: 0, lastUpdatedAt: now.toISOString() })),
      capabilityCount: vi.fn(() => 0),
      jobs: vi.fn(() => jobsArr),
      bundles: vi.fn(() => bundlesArr),
      claimedOffers: vi.fn(() => offersArr),
      tenantEnforced,
    });
    let src = makeSources(true, true);
    buildReputationProfile("KS", src, now);
    expect(src.jobs).toHaveBeenCalledTimes(0);
    expect(src.bundles).toHaveBeenCalledTimes(0);
    expect(src.claimedOffers).toHaveBeenCalledTimes(0);
    src = makeSources(false, true);
    buildReputationProfile("KS", src, now);
    expect(src.jobs).toHaveBeenCalledTimes(1);
    expect(src.bundles).toHaveBeenCalledTimes(1);
    expect(src.claimedOffers).toHaveBeenCalledTimes(1);
    src = makeSources(false, false);
    buildReputationProfile("agent-spy", src, now);
    expect(src.capabilityCount).toHaveBeenCalledTimes(0);
    expect(src.jobs).toHaveBeenCalledTimes(0);
    expect(src.bundles).toHaveBeenCalledTimes(0);
    expect(src.claimedOffers).toHaveBeenCalledTimes(0);
  });
  it("RP12 the window edges are inclusive", async () => {
    const NOW = Date.parse("2025-06-15T12:00:00.000Z");
    const FROM = NOW - 30 * DAY;
    const times = [FROM, FROM, NOW, NOW, NOW - DAY];
    const iso = (ms: number) => new Date(ms).toISOString();
    const bundles = [
      ...times.map((ms, i) => ({ jobId: `JW${i}`, kernelId: "KW", assuranceTier: 0, createdAt: iso(ms) })),
      { jobId: "JW-out1", kernelId: "KW", assuranceTier: 0, createdAt: iso(FROM - 1) },
      { jobId: "JW-out2", kernelId: "KW", assuranceTier: 0, createdAt: iso(NOW + 1) },
      { jobId: "JW-out3", kernelId: "KW", assuranceTier: 0, createdAt: "not-a-time" },
      { jobId: "JW-out4", kernelId: "KW", assuranceTier: 0, createdAt: "" },
    ];
    const jobs = [
      ...times.map((ms, i) => ({ id: `JW${i}`, kernelId: "KW", status: "completed", completedAt: iso(ms), assuranceTier: 0 })),
      { id: "JW-out1", kernelId: "KW", status: "completed", completedAt: iso(FROM - 1), assuranceTier: 0 },
      { id: "JW-out2", kernelId: "KW", status: "completed", completedAt: iso(NOW + 1), assuranceTier: 0 },
      { id: "JW-out3", kernelId: "KW", status: "completed", completedAt: "not-a-time", assuranceTier: 0 },
      { id: "JW-out4", kernelId: "KW", status: "completed", completedAt: null, assuranceTier: 0 },
    ];
    const claimedOffers = [
      ...times.map((ms) => ({ postedAt: iso(ms), claimedAt: iso(ms + 30_000), claimedByKernelId: "KW", posterKernelId: null })),
      { postedAt: iso(FROM - 1), claimedAt: iso(FROM - 1 + 30_000), claimedByKernelId: "KW", posterKernelId: null },
      { postedAt: iso(NOW + 1), claimedAt: iso(NOW + 1 + 30_000), claimedByKernelId: "KW", posterKernelId: null },
      { postedAt: "not-a-time", claimedAt: iso(NOW), claimedByKernelId: "KW", posterKernelId: null },
      { postedAt: "", claimedAt: iso(NOW), claimedByKernelId: "KW", posterKernelId: null },
    ];
    const dto = buildReputationProfile("KW", {
      kernel: () => ({ id: "KW", status: "online", lastHeartbeat: iso(NOW - 60_000), maxAssuranceTier: 1 }),
      reputation: () => undefined,
      capabilityCount: () => 0,
      jobs: () => jobs,
      bundles: () => bundles,
      claimedOffers: () => claimedOffers,
      tenantEnforced: false,
    }, new Date(NOW));
    expect(dto?.evidenceTiers).toEqual({ state: "measured", byTier: { "0": 5 }, total: 5, basis: "stored_records", rule: RULE_EVIDENCE_TIERS });
    expect(dto?.evidenceCompleteness).toEqual({ state: "measured", completed: 5, withEvidence: 5, ratio: 1, basis: "stored_records", rule: RULE_COMPLETENESS });
    expect(dto?.responseTime).toEqual({ state: "measured", medianSeconds: 30, p90Seconds: 30, sampleSize: 5, basis: "job_offer_claims", rule: RULE_RESPONSE });
  });

  it("RP13 the kernel checks and evidence of any age", async () => {
    seedKernel("KA", { status: "online", lastHeartbeat: isoMs(Date.now() - 60_000), maxAssuranceTier: 1 });
    seedCapability("CA", "KA");
    const inw = inWindowIso();
    for (let i = 1; i <= 5; i++) {
      seedJob(`AJ${i}`, "KA", "CA", { status: "completed", assuranceTier: 0, completedAt: inw });
      seedBundle(`AB${i}`, `AJ${i}`, "KA", 0, oldIso());
    }
    const res = await getProfile("KA");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.evidenceCompleteness).toEqual({ state: "measured", completed: 5, withEvidence: 5, ratio: 1, basis: "stored_records", rule: RULE_COMPLETENESS });
    expect(body.evidenceTiers).toEqual({ state: "unavailable", reason: "insufficient_sample" });

    const NOW = Date.parse("2025-06-15T12:00:00.000Z");
    const iso = (ms: number) => new Date(ms).toISOString();
    const inWin = iso(NOW - DAY);
    const jobs = [
      ...[1, 2, 3, 4, 5].map((i) => ({ id: `J${i}`, kernelId: "KX", status: "completed", completedAt: inWin, assuranceTier: 0 })),
      ...[1, 2, 3, 4, 5].map((i) => ({ id: `F${i}`, kernelId: "KY", status: "completed", completedAt: inWin, assuranceTier: 0 })),
    ];
    const bundles = [
      ...[1, 2, 3].map((i) => ({ jobId: `J${i}`, kernelId: "KX", assuranceTier: 0, createdAt: inWin })),
      ...[4, 5].flatMap((i) => [0, 1, 2, 3].map((tier) => ({ jobId: `J${i}`, kernelId: "KY", assuranceTier: tier, createdAt: inWin }))),
      ...[1, 2, 3, 4, 5].map((i) => ({ jobId: `F${i}`, kernelId: "KY", assuranceTier: 0, createdAt: inWin })),
    ];
    const claimedOffers = [
      ...[1, 2, 3, 4, 5].map(() => ({ postedAt: inWin, claimedAt: iso(NOW - DAY + 30_000), claimedByKernelId: "KX", posterKernelId: null })),
      ...[1, 2, 3, 4, 5].map(() => ({ postedAt: inWin, claimedAt: iso(NOW - DAY + 90_000), claimedByKernelId: "KY", posterKernelId: null })),
    ];
    const dto = buildReputationProfile("KX", {
      kernel: () => ({ id: "KX", status: "online", lastHeartbeat: iso(NOW - 60_000), maxAssuranceTier: 1 }),
      reputation: () => undefined,
      capabilityCount: () => 0,
      jobs: () => jobs,
      bundles: () => bundles,
      claimedOffers: () => claimedOffers,
      tenantEnforced: false,
    }, new Date(NOW));
    expect(dto?.evidenceTiers).toEqual({ state: "unavailable", reason: "insufficient_sample" });
    expect(dto?.evidenceCompleteness).toEqual({ state: "measured", completed: 5, withEvidence: 3, ratio: 0.6, basis: "stored_records", rule: RULE_COMPLETENESS });
    expect(dto?.responseTime).toEqual({ state: "measured", medianSeconds: 30, p90Seconds: 30, sampleSize: 5, basis: "job_offer_claims", rule: RULE_RESPONSE });

    const oldTimes = [NOW - 31 * DAY, NOW - 400 * DAY, NOW - 5 * 365 * DAY, NOW - 30 * 365 * DAY, 0];
    const oldEvidence = buildReputationProfile("KO", {
      kernel: () => ({ id: "KO", status: "online", lastHeartbeat: iso(NOW - 60_000), maxAssuranceTier: 1 }),
      reputation: () => undefined,
      capabilityCount: () => 0,
      jobs: () => [1, 2, 3, 4, 5].map((i) => ({ id: `O${i}`, kernelId: "KO", status: "completed", completedAt: inWin, assuranceTier: 0 })),
      bundles: () => oldTimes.map((ms, i) => ({ jobId: `O${i + 1}`, kernelId: "KO", assuranceTier: 0, createdAt: new Date(ms).toISOString() })),
      claimedOffers: () => [],
      tenantEnforced: false,
    }, new Date(NOW));
    expect(oldEvidence?.evidenceCompleteness).toEqual({ state: "measured", completed: 5, withEvidence: 5, ratio: 1, basis: "stored_records", rule: RULE_COMPLETENESS });
    expect(oldEvidence?.evidenceTiers).toEqual({ state: "unavailable", reason: "insufficient_sample" });
    expect(oldEvidence?.responseTime).toEqual({ state: "unavailable", reason: "insufficient_sample" });
  });

  it("RP14 the liveness rule edges", async () => {
    const NOW = Date.parse("2025-06-15T12:00:00.000Z");
    const iso = (ms: number) => new Date(ms).toISOString();
    const cases: Array<{ status: string; lastHeartbeat: string | null; hasCap: boolean; isStale: boolean }> = [
      { status: "online", lastHeartbeat: iso(NOW - 5 * 60_000), hasCap: false, isStale: false },
      { status: "online", lastHeartbeat: iso(NOW - 5 * 60_000 - 1), hasCap: false, isStale: true },
      { status: "online", lastHeartbeat: iso(NOW - 5 * 60_000 - 1), hasCap: true, isStale: false },
      { status: "online", lastHeartbeat: iso(NOW - 24 * 60 * 60_000), hasCap: true, isStale: false },
      { status: "online", lastHeartbeat: iso(NOW - 24 * 60 * 60_000 - 1), hasCap: true, isStale: true },
      { status: "online", lastHeartbeat: iso(NOW + 60_000), hasCap: false, isStale: false },
      { status: "online", lastHeartbeat: iso(NOW + 60_000), hasCap: true, isStale: false },
      { status: "online", lastHeartbeat: null, hasCap: false, isStale: true },
      { status: "online", lastHeartbeat: null, hasCap: true, isStale: true },
      { status: "online", lastHeartbeat: "not-a-time", hasCap: false, isStale: true },
      { status: "online", lastHeartbeat: "not-a-time", hasCap: true, isStale: true },
      { status: "online", lastHeartbeat: "", hasCap: false, isStale: true },
      { status: "online", lastHeartbeat: "", hasCap: true, isStale: true },
      { status: "offline", lastHeartbeat: null, hasCap: false, isStale: false },
      { status: "offline", lastHeartbeat: null, hasCap: true, isStale: false },
      { status: "ONLINE", lastHeartbeat: null, hasCap: false, isStale: false },
      { status: "ONLINE", lastHeartbeat: null, hasCap: true, isStale: false },
      { status: "maintenance", lastHeartbeat: iso(NOW - 2 * DAY), hasCap: false, isStale: false },
      { status: "maintenance", lastHeartbeat: iso(NOW - 2 * DAY), hasCap: true, isStale: false },
    ];
    for (const c of cases) {
      const dto = buildReputationProfile("KL", {
        kernel: () => ({ id: "KL", status: c.status, lastHeartbeat: c.lastHeartbeat, maxAssuranceTier: 1 }),
        reputation: () => undefined,
        capabilityCount: () => (c.hasCap ? 1 : 0),
        jobs: () => [],
        bundles: () => [],
        claimedOffers: () => [],
        tenantEnforced: false,
      }, new Date(NOW));
      expect(dto?.uptime).toEqual({ state: "unavailable", reason: "no_heartbeat_history", liveness: { status: c.status, lastHeartbeat: c.lastHeartbeat, isStale: c.isStale, rule: RULE_LIVENESS } });
    }
  });

  it("RP15 no-store on a 500 before the handler", async () => {
    const app2 = Fastify({ logger: false });
    const routes: Array<{ method: HTTPMethods | HTTPMethods[]; url: string }> = [];
    app2.addHook("onRoute", (route) => {
      routes.push({ method: route.method, url: route.url });
    });
    app2.addHook("onRequest", async (req, reply) => {
      const status = req.headers["x-test-status"];
      if (status !== undefined) {
        const statusCode = Number(status);
        if (req.headers["x-test-mode"] === "send") {
          return reply.code(statusCode).send({ error: "test_refusal", message: "refused before the handler" });
        }
        throw Object.assign(new Error("key lookup failed"), { statusCode });
      }
      throw new Error("key lookup failed");
    });
    await app2.register(reputationRoutes);
    await app2.ready();
    try {
      const resProfile = await app2.inject({ method: "GET", url: "/api/reputation/KZ/profile" });
      expect(resProfile.statusCode).toBe(500);
      expect(resProfile.headers["cache-control"]).toBe("no-store");
      const resBoard = await app2.inject({ method: "GET", url: "/api/reputation/leaderboard" });
      expect(resBoard.statusCode).toBe(500);
      expect(resBoard.headers["cache-control"]).toBeUndefined();

      for (const status of [500, 401, 403, 429, 503]) {
        const headers = { "x-test-status": String(status) };
        const profile = await app2.inject({ method: "GET", url: "/api/reputation/KZ/profile", headers });
        const board = await app2.inject({ method: "GET", url: "/api/reputation/leaderboard", headers });
        expect(profile.statusCode).toBe(status);
        expect(profile.headers["cache-control"]).toBe("no-store");
        expect(profile.json()).toEqual(board.json());
        expect(profile.json().message).toBe("key lookup failed");
        expect(board.statusCode).toBe(status);
        expect(board.headers["cache-control"]).toBeUndefined();
      }
      for (const status of [401, 429]) {
        const headers = { "x-test-status": String(status), "x-test-mode": "send" };
        const profile = await app2.inject({ method: "GET", url: "/api/reputation/KZ/profile", headers });
        const board = await app2.inject({ method: "GET", url: "/api/reputation/leaderboard", headers });
        expect(profile.statusCode).toBe(status);
        expect(profile.headers["cache-control"]).toBe("no-store");
        expect(profile.json()).toEqual({ error: "test_refusal", message: "refused before the handler" });
        expect(board.statusCode).toBe(status);
        expect(board.json()).toEqual(profile.json());
        expect(board.headers["cache-control"]).toBeUndefined();
      }
      expect(routes.map((route) => route.url)).toEqual(expect.arrayContaining([
        "/api/reputation/:subjectId/profile", "/api/reputation/leaderboard", "/api/reputation/:agentId/deltas", "/api/reputation/:agentId",
      ]));
      for (const route of routes) {
        if (route.url === "/api/reputation/:subjectId/profile") continue;
        for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
          const res = await app2.inject({ method, url: route.url.replace(/:[^/]+/g, "KZ") });
          expect(res.statusCode).toBe(500);
          expect(res.headers["cache-control"]).toBeUndefined();
        }
      }
    } finally {
      await app2.close();
    }
  });

});
