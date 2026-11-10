/** N297 FINAL r0: recorded deployment joins, route parity, pure agreement and shipped-reader guards. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";
import { eq, schema, sql } from "@pcc/store";
import { getRepos, getStore } from "../db.js";
import { fundingStateOf, projectFundingStatus, type FundingStatusDTO } from "../readmodels/funding-status.js";
import {
  CHAIN_CLASSES, chainClassOf, recordedDeployment, recordedDeploymentOf,
  type PrepareIdentityRow, type RecordedDeployment,
} from "../readmodels/recorded-deployment.js";
import {
  shippedVNextDeploymentRecord, vnextDeploymentRecord, type VNextDeploymentRecord,
} from "../services/paid-scope-activation-terms.js";
import type { FundingVerificationRecord } from "../services/funding-record-port.js";
import { jobFundingRoutes } from "../routes/job-funding.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { actAsJobParty } from "./helpers/job-read-party.js";
import { installTestFundingRecordStore, type TestFundingRecordStore } from "./helpers/test-funding-record-store.js";
import {
  ACTIVATION_TTL, ADMIN, BUYER, ESCROW_A, KERNEL, OTHER, T0,
  installActivationTerms, iso, paidScope, scopeRow, setUpFixture, tearDownFixture, verification,
  type Fixture,
} from "./helpers/paid-scope-fixture.js";

vi.mock("../readmodels/recorded-deployment.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../readmodels/recorded-deployment.js")>();
  return { ...actual, recordedDeployment: vi.fn(actual.recordedDeployment) };
});
vi.mock("../services/paid-scope-activation-terms.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/paid-scope-activation-terms.js")>();
  return { ...actual, shippedVNextDeploymentRecord: vi.fn(actual.shippedVNextDeploymentRecord) };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync), readFileSync: vi.fn(actual.readFileSync) };
});

// Independent oracle: committed bytes and parsed fields, never the reader under test.
const contractsRoot = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const committedBytes = readFileSync(join(contractsRoot, "deployments/vnext/base-sepolia/CANONICAL.json"));
const committed = JSON.parse(committedBytes.toString("utf8"));
const shipped: VNextDeploymentRecord = {
  chainId: committed.chainId,
  factory: committed.factory.toLowerCase(), implementation: committed.implementation.toLowerCase(), usdc: committed.usdc.toLowerCase(),
  scheduleId: committed.scheduleId, scheduleTestnetOnly: committed.scheduleTestnetOnly,
  challengeWindowSec: committed.challengeWindowSec, appealWindowSec: committed.appealWindowSec,
  backupWindowSec: committed.backupWindowSec, emergencyReviewWindowSec: committed.emergencyReviewWindowSec,
  minReclaimDelaySec: committed.minReclaimDelaySec, maxReclaimDelaySec: committed.maxReclaimDelaySec,
  recordSha256: createHash("sha256").update(committedBytes).digest("hex"),
};
const recorded: RecordedDeployment = {
  chainId: shipped.chainId, scheduleId: shipped.scheduleId,
  scheduleTestnetOnly: shipped.scheduleTestnetOnly, recordSha256: shipped.recordSha256,
};
const RECORDED = { basis: "recorded", network: "base-sepolia", chainClass: "testnet", ...recorded };
const NO_TESTNET = { testnetOnly: false, buyers: undefined };
const WRONG = "0x7777777777777777777777777777777777777777";
const hash = (byte: string) => `0x${byte.repeat(32)}`;
const BUYER_HEADERS = { "x-test-principal": BUYER };
const ADMIN_HEADERS = { "x-admin-key": ADMIN };
const OPT_INS = {
  PCC_VNEXT_RECORD_NETWORK: "base-sepolia", PCC_VNEXT_ALLOW_TESTNET_RECORD: "1", PCC_VNEXT_TESTNET_BUYERS: BUYER,
};
const dirs: string[] = [];
let fixture: Fixture;
let app: FastifyInstance;

function setEnv(name: string, value: string | undefined): void {
  vi.stubEnv(name, value ?? "");
  if (value === undefined) delete process.env[name];
}

beforeEach(async () => {
  for (const name of [...Object.keys(OPT_INS), "PCC_VNEXT_RECORD_LABEL", "TENANT_ENFORCE"]) setEnv(name, undefined);
  fixture = await setUpFixture();
  app = Fastify({ logger: false });
  actAsJobParty(app, null);
  await app.register(jobFundingRoutes);
  await app.register(operatorRelayRoutes);
  await app.ready();
  vi.mocked(recordedDeployment).mockClear();
  vi.mocked(shippedVNextDeploymentRecord).mockClear();
});

afterEach(async () => {
  await app.close();
  await tearDownFixture(fixture);
  for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.mocked(recordedDeployment).mockClear();
  vi.mocked(shippedVNextDeploymentRecord).mockClear();
  vi.unstubAllEnvs();
});

function plantRecord(store: TestFundingRecordStore, scopeId: string) {
  const record = verification(scopeId);
  store.plant(record);
  return record;
}
const setScopeStatus = (scopeId: string, status: string) =>
  getStore().db.update(schema.executionScopes).set({ status }).where(eq(schema.executionScopes.id, scopeId)).run();

function identityRow(record: FundingVerificationRecord): PrepareIdentityRow {
  return {
    scopeId: record.scopeId, chainId: record.chainId, escrow: record.escrowAddress.toLowerCase(), state: "served",
    s01RecordSha256: shipped.recordSha256, s01ScheduleId: shipped.scheduleId,
    s01ScheduleTestnetOnly: Number(shipped.scheduleTestnetOnly),
    factory: shipped.factory, implementation: shipped.implementation, usdc: shipped.usdc,
  };
}

type Prepare = typeof schema.fundingPrepares.$inferInsert;
function insertPrepare(record: FundingVerificationRecord, jobId: string, over: Partial<Prepare> = {}): void {
  getStore().db.insert(schema.fundingPrepares).values({
    id: `prepare-${record.scopeId}`, ...identityRow(record), jobId, jobIdHash: hash("10"),
    payer: BUYER.toLowerCase(), operator: record.operator.toLowerCase(), termsHash: hash("11"), policyNonce: "1",
    prePolicyRoot: hash("12"), acceptedPolicyDigest: hash("13"), totalGross: "10000000",
    quoteSnapshot: "{}", configs: "[]", unitIds: "[]", expiry: T0 / 1000 + 900,
    scopeExpiresAt: scopeRow(record.scopeId).expiresAt, finalityFS: 120, marginMS: 300,
    // Also satisfy the mainnet-only CHECK when N6(g) changes just the flag.
    reclaimAtEarliest: T0 / 1000 + 900000, reclaimAtLatest: T0 / 1000 + 901000,
    reconcileUntil: T0 / 1000 + 3600, typedDataDigest: hash("14"), operatorSignature: "0x1234",
    signatureVerifiedAt: iso(T0), signedAt: iso(T0 - 600000),
    servedPayload: Buffer.from("fixture"), servedPayloadSha256: "cd".repeat(32), createdAt: iso(T0),
    ...over,
  }).run();
}

async function setupRecorded(over: Partial<Prepare> = {}, status = "active") {
  const job = await paidScope(fixture);
  const record = plantRecord(installTestFundingRecordStore(), job.scopeId);
  insertPrepare(record, job.jobId, over);
  setScopeStatus(job.scopeId, status);
  return { ...job, record };
}
async function read(jobId: string): Promise<FundingStatusDTO> {
  const res = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/funding`, headers: BUYER_HEADERS });
  expect(res.statusCode).toBe(200);
  expect(res.json().scopes).toHaveLength(1);
  return res.json().scopes[0];
}
function expectVerification(dto: FundingStatusDTO, record: FundingVerificationRecord): void {
  const { scopeId: _scopeId, buyer: _buyer, finality: _finality, ...expected } = record;
  expect(dto.verification).toEqual(expected);
}
function expectUnknown(dto: FundingStatusDTO): void {
  expect(dto).toMatchObject({ binding: "expected_chain_unavailable", state: "unknown", verification: null, deployment: null });
}
const escrow = { contractAddress: ESCROW_A, payer: BUYER, status: "funded" };

describe("N297 recorded funding", () => {
  it.each(["active", "expired", "suspended_rogue"])("N1: closed-window funding stays verified on recorded deployment, %s", async (status) => {
    const j = await setupRecorded({}, status);
    const dto = await read(j.jobId);
    expect(dto).toMatchObject({ state: "funded_verified", binding: "bound" });
    expect(dto.deployment).toEqual(RECORDED);
    expectVerification(dto, j.record);
  });

  it("N2 (neg-configured-wins): configured mainnet wins without a recorded lookup", async () => {
    const j = await setupRecorded();
    installActivationTerms({ expectedChainId: 8453, postActivationTtlMs: ACTIVATION_TTL, testnetOnly: false });
    const dto = await read(j.jobId);
    expect(dto).toMatchObject({ state: "unknown", binding: "record_chain_mismatch", verification: null });
    expect(dto.deployment).toEqual({
      basis: "configured", chainId: 8453, network: "base", chainClass: "mainnet",
      scheduleTestnetOnly: false, scheduleId: null, recordSha256: null,
    });
    expect(recordedDeployment).not.toHaveBeenCalled();
  });

  it("N2b (neg-configured-wins-pure): even a valid recorded input cannot override configured mainnet", () => {
    const record = verification("scope-pure");
    const scope = { id: record.scopeId, jobId: "job-pure", createdBy: BUYER, status: "active", createdAt: iso(T0), expiresAt: iso(T0 + 3600000) };
    const dto = projectFundingStatus(scope, record, escrow, 8453, iso(T0), NO_TESTNET, recorded);
    expect(dto).toMatchObject({ binding: "record_chain_mismatch", state: "unknown", verification: null, deployment: { basis: "configured", chainId: 8453 } });
    expect(fundingStateOf(scope, record, escrow, 8453, iso(T0), NO_TESTNET, recorded)).toBe(dto.state);
  });

  it("N3 (neg-readiness-configured-only): bound recorded funding never supplies activation readiness", async () => {
    const j = await setupRecorded({}, "awaiting_funding");
    const dto = await read(j.jobId);
    expect(dto).toMatchObject({ state: "unknown", binding: "bound" });
    expect(dto.state).not.toBe("funded_verified");
    expect(dto.deployment).toEqual(RECORDED);
    expectVerification(dto, j.record);
  });

  it("N4: elapsed pre-activation window is expired with bound verification", async () => {
    const j = await setupRecorded({}, "awaiting_funding");
    getStore().db.update(schema.executionScopes).set({ expiresAt: iso(T0 - 1) }).where(eq(schema.executionScopes.id, j.scopeId)).run();
    const dto = await read(j.jobId);
    expect(dto).toMatchObject({ state: "expired", binding: "bound" });
    expect(dto.deployment).toEqual(RECORDED);
    expectVerification(dto, j.record);
  });

  it("N5 (neg-no-prepare): no row supplies no identity and reads no file", async () => {
    const j = await paidScope(fixture);
    plantRecord(installTestFundingRecordStore(), j.scopeId);
    setScopeStatus(j.scopeId, "active");
    expectUnknown(await read(j.jobId));
    expect(shippedVNextDeploymentRecord).not.toHaveBeenCalled();
  });

  it("N5b (neg-db-error): a failed prepare read is a 503, never a reading", async () => {
    const j = await paidScope(fixture);
    plantRecord(installTestFundingRecordStore(), j.scopeId);
    setScopeStatus(j.scopeId, "active");
    getStore().db.run(sql`DROP TABLE funding_prepares`);
    const res = await app.inject({ method: "GET", url: `/api/jobs/${j.jobId}/funding`, headers: BUYER_HEADERS });
    expect(res.statusCode).toBe(503);
  });

  it.each([
    ["a-scope", { scopeId: "scope-another" }],
    ["b-superseded", { state: "superseded", endedAt: iso(T0), supersededBy: "prepare-new" }],
    ["c-pending", { state: "pending_signature" }],
    ["d-schedule", { s01ScheduleId: "vnext-mainnet-v1" }],
    ["e-sha", { s01RecordSha256: "ab".repeat(32) }],
    ["f-factory", { factory: WRONG }],
    ["f-implementation", { implementation: WRONG }],
    ["f-usdc", { usdc: WRONG }],
    ["g-testnet-flag", { s01ScheduleTestnetOnly: 0 }],
  ] as const)("N6 (neg-join-%s): reject a different or unaccepted frozen identity", async (_name, over) => {
    const j = await setupRecorded(over);
    expectUnknown(await read(j.jobId));
  });

  it("N6(h): an expired prepare still vouches for recorded funding", async () => {
    const j = await setupRecorded({ state: "expired", endedAt: iso(T0) });
    const dto = await read(j.jobId);
    expect(dto).toMatchObject({ binding: "bound", state: "funded_verified" });
    expect(dto.deployment).toEqual(RECORDED);
    expectVerification(dto, j.record);
  });

  it("N6(i) (neg-escrow-case): a checksummed record escrow still joins its lower-case row", async () => {
    const j = await paidScope(fixture);
    const record = verification(j.scopeId, { escrowAddress: getAddress(ESCROW_A) });
    expect(record.escrowAddress).not.toBe(ESCROW_A);
    installTestFundingRecordStore().plant(record);
    insertPrepare(record, j.jobId);
    setScopeStatus(j.scopeId, "active");
    const dto = await read(j.jobId);
    expect(dto).toMatchObject({ binding: "bound", state: "funded_verified" });
    expect(dto.deployment).toEqual(RECORDED);
  });

  it("N6(j) (neg-other-chain): a row on another chain is checked against that chain's shipped record only", async () => {
    const j = await paidScope(fixture);
    const record = verification(j.scopeId, { chainId: 8453 });
    installTestFundingRecordStore().plant(record);
    insertPrepare(record, j.jobId);
    setScopeStatus(j.scopeId, "active");
    expectUnknown(await read(j.jobId));
    expect(vi.mocked(shippedVNextDeploymentRecord).mock.calls.map(([, network]) => network)).toEqual(["base"]);
  });

  it.each([
    ["a-unset-list", true, undefined], ["b-buyer-excluded", true, getAddress(OTHER)], ["c-terms-flag", false, undefined],
  ] as const)("N7(%s) (neg-current-terms): recorded check 4a passed at write time", async (_name, testnetOnly, buyers) => {
    const j = await setupRecorded();
    installActivationTerms({ expectedChainId: null, postActivationTtlMs: null, testnetOnly });
    setEnv("PCC_VNEXT_TESTNET_BUYERS", buyers);
    const dto = await read(j.jobId);
    expect(dto).toMatchObject({ binding: "bound", state: "funded_verified" });
    expect(dto.deployment).toEqual(RECORDED);
    expectVerification(dto, j.record);
  });

  it("N8 (neg-class-from-flag): chainClassOf uses only the chain id", () => {
    expect(CHAIN_CLASSES).toEqual(["mainnet", "testnet", "local", "unknown"]);
    for (const [id, expected] of [[8453, "mainnet"], [84532, "testnet"], [31337, "local"], [1, "unknown"], [545, "unknown"], [11155111, "unknown"]] as const) {
      expect(chainClassOf(id)).toBe(expected);
    }
    const record = verification("scope-class");
    const scope = { id: record.scopeId, jobId: "job-class", createdBy: BUYER, status: "active", createdAt: iso(T0), expiresAt: iso(T0 + 3600000) };
    const dto = projectFundingStatus(scope, record, escrow, null, iso(T0), NO_TESTNET, { ...recorded, scheduleId: "vnext-mainnet-v1", scheduleTestnetOnly: false });
    expect(dto.deployment).toMatchObject({ basis: "recorded", chainClass: "testnet", scheduleTestnetOnly: false });
  });

  it.each([[84532, "testnet"], [31337, "local"]] as const)("N8 (neg-configured-class-%i): false schedule flag does not change %s", async (chainId, chainClass) => {
    const j = await setupRecorded();
    installActivationTerms({ expectedChainId: chainId, postActivationTtlMs: ACTIVATION_TTL, testnetOnly: false });
    expect((await read(j.jobId)).deployment).toMatchObject({ basis: "configured", chainId, chainClass, scheduleTestnetOnly: false });
  });

  it("N8 (neg-configured-flag): a configured testnet-only schedule reads scheduleTestnetOnly true", async () => {
    const j = await setupRecorded();
    installActivationTerms({ expectedChainId: 84532, postActivationTtlMs: ACTIVATION_TTL, testnetOnly: true });
    expect((await read(j.jobId)).deployment).toEqual({
      basis: "configured", chainId: 84532, network: "base-sepolia", chainClass: "testnet", scheduleTestnetOnly: true, scheduleId: null, recordSha256: null,
    });
  });

  it.each([[8453, "base", "mainnet"], [31337, "anvil", "local"], [545, "chain-545", "unknown"]] as const)("N8 (neg-recorded-chain-%i): the recorded basis names its own chain's network and class", (chainId, network, chainClass) => {
    const record = verification("scope-class", { chainId });
    const scope = { id: record.scopeId, jobId: "job-class", createdBy: BUYER, status: "active", createdAt: iso(T0), expiresAt: iso(T0 + 3600000) };
    const dto = projectFundingStatus(scope, record, escrow, null, iso(T0), NO_TESTNET, { ...recorded, chainId });
    expect(dto).toMatchObject({ binding: "bound", state: "funded_verified" });
    expect(dto.deployment).toEqual({ ...RECORDED, chainId, network, chainClass });
  });

  it("N9 (neg-no-record): opt-ins set then unset give equal replies and no lookup", async () => {
    const j = await paidScope(fixture);
    for (const [name, value] of Object.entries(OPT_INS)) setEnv(name, value);
    const withOptIns = await read(j.jobId);
    expect(withOptIns.deployment).toBeNull();
    for (const name of Object.keys(OPT_INS)) setEnv(name, undefined);
    const withoutOptIns = await read(j.jobId);
    expect(withoutOptIns.deployment).toBeNull();
    expect(withoutOptIns).toEqual(withOptIns);
    expect(recordedDeployment).not.toHaveBeenCalled();
  });

  it("N10: relay parity includes the recorded deployment", async () => {
    const j = await setupRecorded();
    getRepos().jobs.update(j.jobId, { status: "queued" });
    const dto = await read(j.jobId);
    const poll = await app.inject({ method: "GET", url: `/api/operator/jobs?kernelId=${KERNEL}&status=queued`, headers: ADMIN_HEADERS });
    expect(poll.statusCode).toBe(200);
    const listed = poll.json().jobs.find((job: { id: string }) => job.id === j.jobId);
    expect(listed.funding.read).toBe("ok");
    expect(listed.funding.scopes).toEqual([dto]);
    expect(listed.funding.scopes[0]).toMatchObject({ binding: "bound", state: "funded_verified", deployment: RECORDED });
  });

  it("N12 (neg-callers): recorded readers have only the authorized production callers and no projection cycle", () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    function sources(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === "__tests__") return [];
        const path = join(dir, entry.name);
        return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
      });
    }
    const contents = sources(root).map((path) => ({ path: relative(root, path), text: readFileSync(path, "utf8") }));
    expect(contents.filter(({ text }) => /\bshippedVNextDeploymentRecord\b/.test(text)).map(({ path }) => path).sort())
      .toEqual(["readmodels/recorded-deployment.ts", "services/paid-scope-activation-terms.ts"]);
    expect(contents.filter(({ text }) => /\brecordedDeployment\s*\(/.test(text)).map(({ path }) => path).sort())
      .toEqual(["readmodels/job-funding.ts", "readmodels/recorded-deployment.ts"]);
    const module = contents.find(({ path }) => path === "readmodels/recorded-deployment.ts")!.text;
    expect(module).not.toMatch(/(?:from|import\s*\()\s*["'][^"']*(?:funding-status|job-funding)\.js/);
  });

  it.each([
    ["chainId", 8453], ["s01RecordSha256", "ab".repeat(32)], ["s01ScheduleId", "vnext-mainnet-v1"],
    ["s01ScheduleTestnetOnly", 0], ["factory", WRONG], ["implementation", WRONG], ["usdc", WRONG],
  ] as const)("N13(a) (neg-disagree-%s): every row's identity must agree", (key, value) => {
    const record = verification("scope-agreement");
    const row = identityRow(record);
    expect(recordedDeploymentOf(record, [row, { ...row, [key]: value }], shipped)).toBeNull();
  });

  it("N13(b): agreeing superseded and served rows supply the deployment", () => {
    const record = verification("scope-agreement");
    const row = identityRow(record);
    expect(recordedDeploymentOf(record, [{ ...row, state: "superseded" }, row], shipped)).toEqual(recorded);
  });

  it.each([
    ["chain", { chainId: 8453 }], ["escrow", { escrow: WRONG }], ["scope", { scopeId: "scope-other" }],
  ])("N13(c) (neg-row-%s): every row must name this record", (_name, over) => {
    const record = verification("scope-agreement");
    expect(recordedDeploymentOf(record, [{ ...identityRow(record), ...over }], shipped)).toBeNull();
  });

  it("N13(d,e) (neg-no-identity): no rows or no shipped record fails closed", () => {
    const record = verification("scope-agreement");
    expect(recordedDeploymentOf(record, [], shipped)).toBeNull();
    expect(recordedDeploymentOf(record, [identityRow(record)], null)).toBeNull();
  });

  it("N13(f) (neg-shipped-other-chain): another chain's shipped record never vouches", () => {
    const record = verification("scope-agreement", { chainId: 31337 });
    expect(recordedDeploymentOf(record, [identityRow(record)], shipped)).toBeNull();
  });

  it("N13 (neg-malformed-record): malformed records cause no query", () => {
    const select = vi.spyOn(getStore().db, "select");
    expect(recordedDeployment(getStore().db, verification("scope-malformed", { chainId: 0 }))).toBeNull();
    expect(select).not.toHaveBeenCalled();
    expect(shippedVNextDeploymentRecord).not.toHaveBeenCalled();
  });

  it("N13: fundingStateOf matches the projection on recorded and configured inputs", () => {
    const record = verification("scope-state");
    for (const status of ["active", "expired", "suspended_rogue", "awaiting_funding", "awaiting_acceptance", "revoked", "rejected", "unknown"]) {
      for (const chain of [null, 8453, 84532]) for (const r of [record, null]) for (const deployment of [recorded, null]) {
        const scope = { id: record.scopeId, jobId: "job-state", createdBy: BUYER, status, createdAt: iso(T0), expiresAt: iso(T0 + 3600000) };
        expect(fundingStateOf(scope, r, escrow, chain, iso(T0), NO_TESTNET, deployment))
          .toBe(projectFundingStatus(scope, r, escrow, chain, iso(T0), NO_TESTNET, deployment).state);
      }
    }
  });
});

function writeRecord(network: string, content: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "n297-record-"));
  dirs.push(root);
  const directory = join(root, "deployments/vnext", network);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "CANONICAL.json"), JSON.stringify(content));
  return root;
}
function clearReads(): void {
  vi.mocked(openSync).mockClear();
  vi.mocked(readFileSync).mockClear();
}
function expectReads(count: number): void {
  expect(vi.mocked(openSync).mock.calls).toHaveLength(count);
  expect(vi.mocked(readFileSync).mock.calls).toHaveLength(count);
  expect(vi.mocked(readFileSync).mock.calls.every(([target]) => typeof target === "number")).toBe(true);
}

describe("N14 shipped reader", () => {
  it("N14 (neg-opt-in-regression): only the shipped reader skips R-c, with one open and read per call", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clearReads();
    const actual = shippedVNextDeploymentRecord(contractsRoot, "base-sepolia");
    expect(actual).toStrictEqual(shipped);
    expect(warn).not.toHaveBeenCalled();
    expectReads(1);
    expect(shippedVNextDeploymentRecord(contractsRoot, "base-sepolia")).toStrictEqual(actual);
    expectReads(2);
    setEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", "1");
    expect(vnextDeploymentRecord(contractsRoot, "base-sepolia")).toStrictEqual(actual);
    expectReads(3);
    setEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", undefined);
    expect(vnextDeploymentRecord(contractsRoot, "base-sepolia")).toBeNull();
    expectReads(4);
    expect(warn.mock.calls).toEqual([["vnext_record_refused R-c"]]);
  });

  it.each([
    ["R-a", "base-sepolia", { specVersion: 1 }],
    ["R-b", "base", { chainId: 8453 }],
    ["R-d", "base-sepolia", { challengeWindowSec: committed.challengeWindowSec + 1 }],
  ] as const)("N14 (neg-shipped-%s): the shipped reader preserves the other guard", (rule, network, change) => {
    const root = writeRecord(network, { ...committed, ...change });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clearReads();
    expect(shippedVNextDeploymentRecord(root, network)).toBeNull();
    expectReads(1);
    expect(warn.mock.calls).toEqual([[`vnext_record_refused ${rule}`]]);
  });
});
