import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const h = vi.hoisted(() => ({
  isWriteEnabled: vi.fn().mockReturnValue(false),
  driveSettlement: vi.fn(),
  submitEvidenceV3: vi.fn().mockResolvedValue({ transactionHash: "0xev3", status: "submitted" }),
  submitAttestationV3: vi.fn().mockResolvedValue({ transactionHash: "0xat3", status: "submitted" }),
  waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }),
  easUid: ("0x" + "ea".repeat(32)) as `0x${string}`,
}));

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafywire", metadataCid: "bafymeta" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafyenc", metadataCid: "bafyencmeta" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({ transactionHash: "0xev", status: "submitted" }),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xrel", status: "submitted" }),
  isWriteEnabled: h.isWriteEnabled,
  submitEvidenceV3: h.submitEvidenceV3,
  submitAttestationV3: h.submitAttestationV3,
  waitForReceipt: h.waitForReceipt,
  getSignerAddress: vi.fn().mockReturnValue(undefined),
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(undefined),
  MilestoneStatus: {},
  milestoneStatusName: vi.fn().mockReturnValue("unknown"),
  resolveMockUSDCAddress: vi.fn().mockReturnValue("0x18bef3dee9f4f97f7cec16db0c4a0a930f478470"),
}));

vi.mock("../contracts/batch-settlement.js", () => ({
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(null),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn().mockResolvedValue({ epochId: "e", totalIntents: 0, batches: [], byAgent: {}, byOperation: {}, startedAt: 0, completedAt: 0 }),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));

vi.mock("../services/oracle-client.js", () => ({
  verifyWithOracle: vi.fn().mockResolvedValue({
    result: { verified: true, reason: "mock", checks: [] },
    attestation: { signature: "0xsig", nonce: "1", timestamp: 1 },
    easAttestation: { easUid: h.easUid, schemaUid: "0x" + "5a".repeat(32) },
  }),
  buildEasAttestationMetadata: vi.fn().mockReturnValue({
    schema: "pcc.evidence.v1",
    schemaUid: "0x" + "5a".repeat(32),
    recipient: "0x" + "ab".repeat(20),
    encoded: "0x",
  }),
}));

vi.mock("../services/settlement-crank.js", () => ({
  driveSettlement: h.driveSettlement,
}));

import { paidJobFlowRoutes, refusedEscrowDrive } from "../routes/paid-job-flow.js";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { buildCanonicalEvidenceEnvelope } from "../services/evidence-envelope.js";
import { createHash } from "node:crypto";
import { schema, eq } from "@pcc/store";
import { getAddress } from "viem";
import { verifyWithOracle } from "../services/oracle-client.js";
import { pipelineTelemetry } from "../telemetry.js";
import { BUYER_FUNDED_ESCROW_VERSION } from "../services/buyer-funded-escrow.js";
import * as gate from "../services/escrow-drive-gate.js";

const KERNEL = "kernel-biolab-01";
const CAP = "liquid-handler";
const ADMIN = "escrow-drive-gate-admin";
const CWM = "cwm-route-gate";
const addressFor = (n: number) => `0x${n.toString(16).padStart(4, "0")}${"abcdef".repeat(6)}`;
const REAL_ESCROW = addressFor(20);
const ORIG = { v2: process.env.PCC_USE_EAS_V2, mock: process.env.MOCK_SETTLEMENT, admin: process.env.PCC_ADMIN_KEY };

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  process.env.PCC_ADMIN_KEY = ADMIN;
  delete process.env.PCC_USE_EAS_V2;
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.ready();
  return app;
}

type Row = { id: string; cwmId: string; contractAddress: string; version?: string | null };

function insertRow(row: Row) {
  getRepos().escrows.insert({
    ...row, payer: "gate-buyer", totalAmount: "10.00", currency: "USDC", status: "funded",
    createdAt: new Date().toISOString(), deadline: new Date(Date.now() + 86_400_000).toISOString(),
  });
}

async function makeJobWithRealEscrow(
  escrowAddress = REAL_ESCROW,
  cwmId: string | null = CWM,
  rows: Row[] = [{ id: "esc-default", cwmId: cwmId ?? "cwm-other", contractAddress: escrowAddress }],
): Promise<{ jobId: string }> {
  const ft = await app.inject({
    method: "POST", url: "/api/jobs/submit-from-discovery", headers: { "x-admin-key": ADMIN },
    payload: { kernelId: KERNEL, capabilityType: CAP, userAgentId: "gate-buyer" },
  });
  expect(ft.statusCode).toBe(201);
  const jobId = ft.json().jobId as string;
  getStore().db.update(schema.negotiationSessions)
    .set({ escrowAddress, cwmId, contractTerms: { assuranceTier: 0 } })
    .where(eq(schema.negotiationSessions.jobId, jobId)).run();
  rows.forEach(insertRow);
  return { jobId };
}

function trap(jobId: string, agent: string): void {
  const repos = getRepos();
  const job = repos.jobs.findById(jobId)!;
  const meta = {
    id: `bundle-${agent}`, jobId, stepId: job.stepId, kernelId: job.kernelId, assuranceTier: 0,
    createdAt: new Date().toISOString(),
    kernelSignature: { signer: "0x0000000000000000000000000000000000000000", algorithm: "ed25519", value: "gateway-auto-sign" },
  };
  const bundleHash = `sha256:${createHash("sha256").update(buildCanonicalEvidenceEnvelope(meta as any, [])).digest("hex")}`;
  repos.evidence.insert({ ...meta, bundleHash } as any);
  repos.jobs.update(jobId, { evidenceBundleId: `bundle-${agent}`, status: "evidence_submitted" });
}

let app: FastifyInstance;

const pending = () => ({
  escrowAddress: REAL_ESCROW, milestoneIdx: 0, finalStatus: "Evidenced", outcome: "needs_input",
  needs: "eas_uid", settled: false, stepId: "0x" + "11".repeat(32),
  steps: [{ action: "submitEvidence", result: "landed", txHash: "0xev" }],
});
const released = () => ({
  escrowAddress: REAL_ESCROW, milestoneIdx: 0, finalStatus: "Released", outcome: "released", settled: true,
  steps: [{ action: "submitAttestation", result: "landed", txHash: "0xat" }, { action: "release", result: "landed", txHash: "0xrel" }],
});
const oracleResult = () => ({
  result: { verified: true, reason: "mock", checks: [] },
  attestation: { signature: "0xsig", nonce: "1", timestamp: 1 },
  easAttestation: { easUid: h.easUid, schemaUid: "0x" + "5a".repeat(32) },
});

beforeEach(async () => {
  vi.clearAllMocks();
  h.isWriteEnabled.mockReset().mockReturnValue(false);
  h.driveSettlement.mockReset().mockResolvedValue(pending());
  h.submitEvidenceV3.mockReset().mockResolvedValue({ transactionHash: "0xev3", status: "submitted" });
  h.waitForReceipt.mockReset().mockResolvedValue({ status: "success" });
  h.submitAttestationV3.mockReset().mockResolvedValue({ transactionHash: "0xat3", status: "submitted" });
  vi.mocked(verifyWithOracle).mockReset().mockResolvedValue(oracleResult() as any);
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  closeStore();
  for (const spy of [gate.resolveEscrowDrive, gate.escrowDriveReads.rowsOnCwm, gate.escrowDriveReads.rowsAtAddress, pipelineTelemetry.emit]) {
    if (vi.isMockFunction(spy)) spy.mockRestore();
  }
  if (ORIG.v2 === undefined) delete process.env.PCC_USE_EAS_V2;
  else process.env.PCC_USE_EAS_V2 = ORIG.v2;
  if (ORIG.mock === undefined) delete process.env.MOCK_SETTLEMENT;
  else process.env.MOCK_SETTLEMENT = ORIG.mock;
  if (ORIG.admin === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = ORIG.admin;
});

function enableChain() {
  h.isWriteEnabled.mockReturnValue(true);
  process.env.PCC_USE_EAS_V2 = "true";
  process.env.MOCK_SETTLEMENT = "false";
}
const complete = (jobId: string) => app.inject({
  method: "PUT", url: `/api/jobs/${jobId}/complete`, headers: { "x-admin-key": ADMIN }, payload: {},
});
const resume = (jobId: string) => app.inject({
  method: "POST", url: `/api/jobs/${jobId}/resume-settlement`, headers: { "x-admin-key": ADMIN },
});
function digest() {
  const request = vi.mocked(verifyWithOracle).mock.calls[0][0];
  expect(request.evidenceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  return "0x" + request.evidenceHash.slice("sha256:".length);
}
function noV3() {
  expect(h.submitEvidenceV3).not.toHaveBeenCalled();
  expect(h.waitForReceipt).not.toHaveBeenCalled();
  expect(h.submitAttestationV3).not.toHaveBeenCalled();
}
function assertRefused(res: { statusCode: number; json(): any }, jobId: string, route: "complete" | "resume") {
  expect(res.statusCode).toBe(200);
  expect(h.driveSettlement).not.toHaveBeenCalled();
  noV3();
  const body = res.json();
  expect(body.status).toBe("evidence_submitted");
  expect(body.settledAt).toBe(null);
  if (route === "complete") {
    expect(body.eas.submitted).toBe(false);
    expect(body.eas.evidenceTxHash).toBe(null);
    expect(body.eas.attestationTxHash).toBe(null);
    expect(body.eas.driveOutcome).toBe("blocked");
    expect(body.eas.settledOnChain).toBe(false);
    expect(body.eas.escrowVersion).toBe(null);
  } else {
    expect(body.resumed).toBe(true);
    expect(body.chainOutcome).toBe("blocked");
    expect(body.chainSettled).toBe(false);
  }
  expect(getRepos().jobs.findById(jobId)!.status).toBe("evidence_submitted");
  expect(verifyWithOracle).toHaveBeenCalledTimes(1);
  const request = vi.mocked(verifyWithOracle).mock.calls[0][0];
  expect(request.mintEasAttestation).toBe(true);
  expect(request.stepId).toBe(getRepos().jobs.findById(jobId)!.stepId);
}

const refusedCases = [
  { name: "a buyer-funded", n: 1, version: BUYER_FUNDED_ESCROW_VERSION, reason: "escrow_buyer_funded" },
  { name: "b unknown version", n: 2, version: "v9", reason: "escrow_version_unknown" },
  { name: "c missing row", n: 3, version: "v2", reason: "escrow_row_missing" },
  { name: "d address read unavailable", n: 4, version: "v2", reason: "escrow_lookup_unavailable" },
  { name: "e two cwm rows", n: 5, version: "v2", reason: "escrow_rows_ambiguous" },
  { name: "f two address spellings", n: 6, version: "v2", reason: "escrow_rows_ambiguous" },
];
const resumeCases = [...refusedCases,
  { name: "g v3 two cwm rows", n: 7, version: "v3", reason: "escrow_rows_ambiguous" },
  { name: "h v3 cwm read unavailable", n: 8, version: "v3", reason: "escrow_lookup_unavailable" },
];

async function seedRefusal(cell: typeof resumeCases[number]) {
  const address = addressFor(cell.n);
  const rows: Row[] = [{ id: "esc-first", cwmId: CWM, contractAddress: address, version: cell.version }];
  if (cell.n === 3) rows.length = 0;
  if (cell.n === 5 || cell.n === 7) rows.push({ id: "esc-second", cwmId: CWM, contractAddress: addressFor(cell.n + 100), version: "v2" });
  if (cell.n === 6) {
    expect(getAddress(address)).not.toBe(address);
    rows.push({ id: "esc-second", cwmId: "cwm-second", contractAddress: getAddress(address), version: "v2" });
  }
  const { jobId } = await makeJobWithRealEscrow(address, CWM, rows);
  if (rows.length) getRepos().escrows.insertMilestone({
    id: "ms-first", escrowId: rows[0].id, stepId: "step-gate", amount: "10", status: "pending", bondAmount: "0",
  });
  if (cell.n === 4) vi.spyOn(gate.escrowDriveReads, "rowsAtAddress").mockImplementation(() => { throw new Error("read unavailable"); });
  if (cell.n === 8) vi.spyOn(gate.escrowDriveReads, "rowsOnCwm").mockImplementation(() => { throw new Error("read unavailable"); });
  return { jobId, address, rows };
}

it.each(refusedCases)("ER1 /complete makes no chain call for a refused row and leaves the job resumable: $name", async cell => {
  const { jobId, address, rows } = await seedRefusal(cell);
  enableChain();
  const resolution = vi.spyOn(gate, "resolveEscrowDrive");
  const telemetry = vi.spyOn(pipelineTelemetry, "emit");
  const res = await complete(jobId);
  assertRefused(res, jobId, "complete");
  expect(resolution.mock.calls).toStrictEqual([[{ cwmId: CWM, address }]]);
  expect(resolution.mock.results[0].value).toStrictEqual({ drive: false, reason: cell.reason });
  expect(telemetry).toHaveBeenCalledWith(jobId, "settlement_claim", "completed", expect.anything());
  expect(telemetry).toHaveBeenCalledWith(jobId, "settlement_complete", "completed", expect.anything());
  if (rows.length) expect(getRepos().escrows.findMilestonesByEscrow(rows[0].id)[0].status).toBe("evidence_submitted");
});

it.each(resumeCases)("ER2 resume makes no chain call for a refused row and leaves the job resumable: $name", async cell => {
  const { jobId, address } = await seedRefusal(cell);
  trap(jobId, "refused");
  enableChain();
  const resolution = vi.spyOn(gate, "resolveEscrowDrive");
  const res = await resume(jobId);
  assertRefused(res, jobId, "resume");
  expect(resolution.mock.calls).toStrictEqual([[{ cwmId: CWM, address }]]);
  expect(resolution.mock.results[0].value).toStrictEqual({ drive: false, reason: cell.reason });
});

it("ER3 a job refused at /complete is driven by a later resume once its rows read right", async () => {
  const address = addressFor(3);
  const { jobId } = await makeJobWithRealEscrow(address, CWM, []);
  enableChain();
  assertRefused(await complete(jobId), jobId, "complete");
  const hash = digest();
  insertRow({ id: "esc-repaired", cwmId: CWM, contractAddress: address, version: "v2" });
  h.driveSettlement.mockResolvedValue(released());
  const res = await resume(jobId);
  expect(res.statusCode).toBe(200);
  expect(h.driveSettlement.mock.calls).toStrictEqual([[address, 0, { evidenceBundleHash: hash }]]);
  noV3();
  expect(res.json().status).toBe("settled");
  expect(getRepos().jobs.findById(jobId)!.status).toBe("settled");
});

it.each(["v2", null])('ER4 /complete drives a "v2" or null row on today\'s V2 path: %s', async version => {
  const { jobId } = await makeJobWithRealEscrow(REAL_ESCROW, CWM, [{ id: "esc-v2", cwmId: CWM, contractAddress: REAL_ESCROW, version }]);
  enableChain();
  const read = vi.spyOn(gate.escrowDriveReads, "rowsAtAddress");
  const res = await complete(jobId);
  expect(res.statusCode).toBe(200);
  expect(h.driveSettlement.mock.calls).toStrictEqual([[REAL_ESCROW, 0, { evidenceBundleHash: digest(), easUid: h.easUid }]]);
  noV3();
  expect(res.json().eas.escrowVersion).toBe("v2");
  expect(read.mock.calls).toStrictEqual([[REAL_ESCROW]]);
});

function assertV3(address: string, res: { statusCode: number; json(): any }) {
  expect(res.statusCode).toBe(200);
  expect(h.driveSettlement.mock.calls).toStrictEqual([[address, 0, {}]]);
  expect(h.submitEvidenceV3.mock.calls).toStrictEqual([[0, digest(), address]]);
  expect(h.waitForReceipt.mock.calls).toStrictEqual([["0xev3"]]);
  expect(h.submitAttestationV3.mock.calls).toStrictEqual([[0, h.easUid, address]]);
  const order = [h.driveSettlement, h.submitEvidenceV3, h.waitForReceipt, h.submitAttestationV3].map(fn => fn.mock.invocationCallOrder[0]);
  expect(order[0]).toBeLessThan(order[1]);
  expect(order[1]).toBeLessThan(order[2]);
  expect(order[2]).toBeLessThan(order[3]);
  expect(res.json().eas.escrowVersion).toBe("v3");
  expect(res.json().eas.submitted).toBe(true);
}

it('ER5 /complete drives a "v3" row on today\'s V3 path', async () => {
  const { jobId } = await makeJobWithRealEscrow(REAL_ESCROW, CWM, [{ id: "esc-v3", cwmId: CWM, contractAddress: REAL_ESCROW, version: "v3" }]);
  enableChain();
  const read = vi.spyOn(gate.escrowDriveReads, "rowsAtAddress");
  assertV3(REAL_ESCROW, await complete(jobId));
  expect(read.mock.calls).toStrictEqual([[REAL_ESCROW]]);
});

it.each(["v2", null, "v3"])('ER6 resume drives a "v2", null or "v3" row with today\'s two passes: %s', async version => {
  const { jobId } = await makeJobWithRealEscrow(REAL_ESCROW, CWM, [{ id: "esc-two-pass", cwmId: CWM, contractAddress: REAL_ESCROW, version }]);
  trap(jobId, "two-pass");
  enableChain();
  const read = vi.spyOn(gate.escrowDriveReads, "rowsAtAddress");
  h.driveSettlement.mockResolvedValueOnce(pending()).mockResolvedValueOnce(released());
  const res = await resume(jobId);
  expect(res.statusCode).toBe(200);
  expect(h.driveSettlement).toHaveBeenCalledTimes(2);
  expect(h.driveSettlement).toHaveBeenNthCalledWith(1, REAL_ESCROW, 0, { evidenceBundleHash: digest() });
  expect(h.driveSettlement).toHaveBeenNthCalledWith(2, REAL_ESCROW, 0, { evidenceBundleHash: digest(), easUid: h.easUid });
  expect(res.json().chainOutcome).toBe("released");
  expect(res.json().chainSettled).toBe(true);
  expect(read.mock.calls).toStrictEqual([[REAL_ESCROW]]);
  noV3();
});

it.each(["complete v3", "complete v2", "resume v3"])("ER7 a row stored in another letter case still drives on its own version's path: %s", async path => {
  const lower = addressFor(30);
  const sum = getAddress(lower);
  expect(sum).not.toBe(lower);
  const address = path === "complete v2" ? sum : lower;
  const { jobId } = await makeJobWithRealEscrow(address, CWM, [{
    id: "esc-case", cwmId: "cwm-other", contractAddress: path === "complete v2" ? lower : sum,
    version: path === "complete v2" ? "v2" : "v3",
  }]);
  if (path === "resume v3") trap(jobId, "case");
  enableChain();
  const read = vi.spyOn(gate.escrowDriveReads, "rowsAtAddress");
  if (path === "complete v3") assertV3(address, await complete(jobId));
  else if (path === "complete v2") {
    const res = await complete(jobId);
    expect(res.statusCode).toBe(200);
    expect(h.driveSettlement.mock.calls).toStrictEqual([[address, 0, { evidenceBundleHash: digest(), easUid: h.easUid }]]);
    expect(res.json().eas.escrowVersion).toBe("v2");
    noV3();
  } else {
    h.driveSettlement.mockResolvedValueOnce(pending()).mockResolvedValueOnce(released());
    const res = await resume(jobId);
    expect(res.statusCode).toBe(200);
    expect(h.driveSettlement).toHaveBeenCalledTimes(2);
    expect(h.driveSettlement).toHaveBeenNthCalledWith(1, address, 0, { evidenceBundleHash: digest() });
    expect(h.driveSettlement).toHaveBeenNthCalledWith(2, address, 0, { evidenceBundleHash: digest(), easUid: h.easUid });
    noV3();
  }
  expect(read.mock.calls).toStrictEqual([[address]]);
});

it.each(refusedCases)("ER8 /complete resolves at 4c when it is the first eligible drive site: $name", async cell => {
  const { jobId, address } = await seedRefusal(cell);
  enableChain();
  h.isWriteEnabled.mockReturnValueOnce(false);
  const resolution = vi.spyOn(gate, "resolveEscrowDrive");
  assertRefused(await complete(jobId), jobId, "complete");
  expect(resolution.mock.calls).toStrictEqual([[{ cwmId: CWM, address }]]);
  expect(resolution.mock.results[0].value).toStrictEqual({ drive: false, reason: cell.reason });
  expect(h.isWriteEnabled.mock.invocationCallOrder.at(-1)!).toBeLessThan(resolution.mock.invocationCallOrder[0]);
});

it.each(["v2", "v3"])("ER9 /complete resolves known versions at 4c when it is the first eligible drive site: %s", async version => {
  const { jobId } = await makeJobWithRealEscrow(REAL_ESCROW, CWM, [{ id: "esc-first", cwmId: CWM, contractAddress: REAL_ESCROW, version }]);
  enableChain();
  h.isWriteEnabled.mockReturnValueOnce(false);
  const read = vi.spyOn(gate.escrowDriveReads, "rowsAtAddress");
  const res = await complete(jobId);
  expect(res.statusCode).toBe(200);
  expect(res.json().eas.escrowVersion).toBe(version);
  expect(read.mock.calls).toStrictEqual([[REAL_ESCROW]]);
  if (version === "v2") {
    expect(h.driveSettlement.mock.calls).toStrictEqual([[REAL_ESCROW, 0, { evidenceBundleHash: digest(), easUid: h.easUid }]]);
    noV3();
  } else {
    expect(h.driveSettlement).not.toHaveBeenCalled();
    expect(h.submitEvidenceV3.mock.calls).toStrictEqual([[0, digest(), REAL_ESCROW]]);
    expect(h.waitForReceipt.mock.calls).toStrictEqual([["0xev3"]]);
    expect(h.submitAttestationV3.mock.calls).toStrictEqual([[0, h.easUid, REAL_ESCROW]]);
    expect(res.json().eas.submitted).toBe(true);
  }
});

it.each(["v2", "v3"])("ER10 /complete retains its answer after the evidence drive throws: %s", async version => {
  const { jobId } = await makeJobWithRealEscrow(REAL_ESCROW, CWM, [{ id: "esc-cached", cwmId: CWM, contractAddress: REAL_ESCROW, version }]);
  enableChain();
  const resolution = vi.spyOn(gate, "resolveEscrowDrive");
  const read = vi.spyOn(gate.escrowDriveReads, "rowsAtAddress");
  h.driveSettlement.mockImplementationOnce(async () => {
    getStore().db.update(schema.escrows).set({ version: BUYER_FUNDED_ESCROW_VERSION }).where(eq(schema.escrows.id, "esc-cached")).run();
    throw new Error("drive unavailable");
  });
  const res = await complete(jobId);
  expect(res.statusCode).toBe(200);
  expect(res.json().eas.escrowVersion).toBe(version);
  expect(resolution).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
  if (version === "v2") {
    expect(h.driveSettlement.mock.calls).toStrictEqual([
      [REAL_ESCROW, 0, { evidenceBundleHash: digest(), easUid: h.easUid }],
      [REAL_ESCROW, 0, { evidenceBundleHash: digest(), easUid: h.easUid }],
    ]);
    noV3();
  } else {
    assertV3(REAL_ESCROW, res);
  }
});

it.each(["submitEvidenceV3", "waitForReceipt", "submitAttestationV3"] as const)(
  "ER11 /complete catches V3 failures and retains its answer: %s", async call => {
    const { jobId } = await makeJobWithRealEscrow(REAL_ESCROW, CWM, [{ id: "esc-v3-throw", cwmId: CWM, contractAddress: REAL_ESCROW, version: "v3" }]);
    enableChain();
    const resolution = vi.spyOn(gate, "resolveEscrowDrive");
    h[call].mockRejectedValueOnce(new Error("chain unavailable"));
    const res = await complete(jobId);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("evidence_submitted");
    expect(resolution).toHaveBeenCalledTimes(1);
    expect(h.driveSettlement.mock.calls).toStrictEqual([[REAL_ESCROW, 0, {}]]);
    expect(h.submitEvidenceV3).toHaveBeenCalledTimes(1);
    expect(h.waitForReceipt).toHaveBeenCalledTimes(call === "submitEvidenceV3" ? 0 : 1);
    expect(h.submitAttestationV3).toHaveBeenCalledTimes(1);
  },
);

it.each(["v2", null, "v3"])("ER12 resume retains its answer after d1 throws: %s", async version => {
  const { jobId } = await makeJobWithRealEscrow(REAL_ESCROW, CWM, [{ id: "esc-d1-throw", cwmId: CWM, contractAddress: REAL_ESCROW, version }]);
  trap(jobId, "d1-throw");
  enableChain();
  const resolution = vi.spyOn(gate, "resolveEscrowDrive");
  const read = vi.spyOn(gate.escrowDriveReads, "rowsAtAddress");
  h.driveSettlement.mockImplementationOnce(async () => {
    getStore().db.update(schema.escrows).set({ version: "v9" }).where(eq(schema.escrows.id, "esc-d1-throw")).run();
    throw new Error("d1 unavailable");
  }).mockResolvedValueOnce(released());
  const res = await resume(jobId);
  expect(res.statusCode).toBe(200);
  expect(h.driveSettlement.mock.calls).toStrictEqual([
    [REAL_ESCROW, 0, { evidenceBundleHash: digest() }],
    [REAL_ESCROW, 0, { evidenceBundleHash: digest(), easUid: h.easUid }],
  ]);
  expect(resolution).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
  expect(res.json().chainSettled).toBe(true);
  expect(vi.mocked(verifyWithOracle).mock.calls[0][0].stepId).toBe(getRepos().jobs.findById(jobId)!.stepId);
});

it("ER13 resume catches a d2 failure and leaves the job resumable", async () => {
  const { jobId } = await makeJobWithRealEscrow();
  trap(jobId, "d2-throw");
  enableChain();
  const resolution = vi.spyOn(gate, "resolveEscrowDrive");
  h.driveSettlement.mockResolvedValueOnce(pending()).mockRejectedValueOnce(new Error("d2 unavailable"));
  const res = await resume(jobId);
  expect(res.statusCode).toBe(200);
  expect(res.json().status).toBe("evidence_submitted");
  expect(res.json().chainSettled).toBe(false);
  expect(getRepos().jobs.findById(jobId)!.status).toBe("evidence_submitted");
  expect(resolution).toHaveBeenCalledTimes(1);
  expect(h.driveSettlement).toHaveBeenCalledTimes(2);
});

it.each(["complete writes disabled", "complete bridge disabled", "resume writes disabled", "resume bridge disabled"])(
  "ER14 a request with no eligible drive site does not resolve: %s", async path => {
    const { jobId } = await makeJobWithRealEscrow();
    if (path.startsWith("resume")) trap(jobId, "no-drive");
    enableChain();
    if (path.endsWith("writes disabled")) h.isWriteEnabled.mockReturnValue(false);
    else process.env.PCC_USE_EAS_V2 = "false";
    const resolution = vi.spyOn(gate, "resolveEscrowDrive");
    const res = await (path.startsWith("resume") ? resume(jobId) : complete(jobId));
    expect(res.statusCode).toBe(200);
    expect(resolution).not.toHaveBeenCalled();
    expect(h.driveSettlement).not.toHaveBeenCalled();
    noV3();
  },
);

it.each(["escrow_buyer_funded", "escrow_version_unknown", "escrow_row_missing", "escrow_lookup_unavailable", "escrow_rows_ambiguous"])(
  "ER15 a refused drive uses the crank's blocked result fields: %s", reason => {
    expect(refusedEscrowDrive(REAL_ESCROW, reason)).toStrictEqual({
      escrowAddress: REAL_ESCROW, milestoneIdx: 0, finalStatus: "Unfunded", outcome: "blocked",
      settled: false, steps: [], reason,
    });
  },
);

it.each(["/complete evidence leg", "/complete 4c", "resume d1"])(
  "ER16 the gate answers for the escrow the route drives, never for the address the session stored: %s", async path => {
    const { jobId, address } = await seedRefusal(refusedCases[0]);
    const storedAddress = addressFor(40);
    expect(storedAddress.toLowerCase()).not.toBe(address.toLowerCase());
    getStore().db.update(schema.negotiationSessions).set({ escrowAddress: storedAddress })
      .where(eq(schema.negotiationSessions.jobId, jobId)).run();
    insertRow({ id: "esc-stored", cwmId: "cwm-stored-address", contractAddress: storedAddress, version: "v2" });
    if (path === "resume d1") trap(jobId, "stored-address");
    enableChain();
    if (path === "/complete 4c") h.isWriteEnabled.mockReturnValueOnce(false);
    const resolution = vi.spyOn(gate, "resolveEscrowDrive");
    const route = path === "resume d1" ? "resume" : "complete";
    const res = await (route === "resume" ? resume(jobId) : complete(jobId));
    expect(resolution.mock.calls).toStrictEqual([[{ cwmId: CWM, address }]]);
    expect(resolution.mock.results[0].value).toStrictEqual({ drive: false, reason: "escrow_buyer_funded" });
    assertRefused(res, jobId, route);
    if (path === "/complete 4c") {
      expect(h.isWriteEnabled.mock.invocationCallOrder.at(-1)!).toBeLessThan(resolution.mock.invocationCallOrder[0]);
    }
  },
);
