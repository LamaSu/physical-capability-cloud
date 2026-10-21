/**
 * CODE #35 (N145): each listed operator job's buyer-funding projection, guarded by
 * decide-strength authority, is read only from its kernel's scopes and Q9 records.
 * No chain lookup or host-side guess of the funding block's timestamp is involved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { eq, schema } from "@pcc/store";
import { getJobFacade } from "../facades/index.js";
import { getRepos, getStore } from "../db.js";
import { AUTHENTICATION_REQUIRED } from "../auth/kernel-authority.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { paidScopeActivationTerms } from "../services/paid-scope-activation-terms.js";
import type { FundingVerificationRecord } from "../services/funding-record-port.js";
import type { FundingStatusDTO } from "../readmodels/funding-status.js";
import { actAsJobParty, SEED_OPERATORS } from "./helpers/job-read-party.js";
import { installTestFundingRecordStore, type TestFundingRecordStore } from "./helpers/test-funding-record-store.js";
import {
  ADMIN,
  BUYER,
  ESCROW_A,
  ESCROW_B,
  KERNEL,
  T0,
  basePolicy,
  installActivationTerms,
  iso,
  paidScope,
  scopeRow,
  setPolicy,
  setUpFixture,
  tearDownFixture,
  verification,
  type Fixture,
} from "./helpers/paid-scope-fixture.js";

// Hoisted, but otherwise fully transparent: keep the fixture's test-source setter.
// T4b observes the real activation-terms entry point; it does not replace its logic.
vi.mock("../services/paid-scope-activation-terms.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/paid-scope-activation-terms.js")>();
  return { ...actual, paidScopeActivationTerms: vi.fn(actual.paidScopeActivationTerms) };
});

const operator = SEED_OPERATORS[KERNEL];
const ADMIN_HEADERS = { "x-admin-key": ADMIN };
const PROVEN_HEADERS = { "x-test-principal": operator };
const CLAIMED_HEADERS = { "x-test-principal": operator, "x-test-proven-wallet": "none" };
const SECOND_SCOPE = "scope-operator-jobs-funding-second";
const OTHER_KERNEL = "kernel-sf";

let fixture: Fixture;
let relay: FastifyInstance;

beforeEach(async () => {
  fixture = await setUpFixture();
  installActivationTerms();
  relay = Fastify({ logger: false });
  // Nothing in this app provisions a key or writes req.provenWallet. The single
  // stand-in job-party hook distinguishes proven wallets from claimed identities.
  actAsJobParty(relay, null);
  await relay.register(operatorRelayRoutes);
  await relay.ready();
  vi.mocked(paidScopeActivationTerms).mockClear();
});

afterEach(async () => {
  await relay.close();
  await tearDownFixture(fixture);
  vi.restoreAllMocks();
  vi.mocked(paidScopeActivationTerms).mockClear();
  vi.unstubAllEnvs();
});

function poll(headers: Record<string, string> = ADMIN_HEADERS, kernelId = KERNEL, status = "queued") {
  return relay.inject({
    method: "GET",
    url: `/api/operator/jobs?kernelId=${encodeURIComponent(kernelId)}&status=${encodeURIComponent(status)}`,
    headers,
  });
}

type PollResponse = Awaited<ReturnType<typeof poll>>;

function listedJob(res: PollResponse, jobId: string): Record<string, unknown> {
  const job = (res.json().jobs as Array<Record<string, unknown>>).find((item) => item.id === jobId);
  if (!job) throw new Error(`expected job ${jobId} in poll`);
  return job;
}

function okFunding(job: Record<string, unknown>): { read: "ok"; scopes: FundingStatusDTO[] } {
  const funding = job.funding as { read?: string; scopes?: FundingStatusDTO[] } | undefined;
  if (funding?.read !== "ok" || !Array.isArray(funding.scopes)) throw new Error("expected readable funding");
  return { read: "ok", scopes: funding.scopes };
}

async function listedPaidScope(real = ESCROW_A) {
  const job = await paidScope(fixture, { real });
  // Dispatch mode may create this job queued, active, or pending. The poll is a
  // status-filtered read, so make the job's listed status explicit.
  getRepos().jobs.update(job.jobId, { status: "queued" });
  return job;
}

function plantRecord(store: TestFundingRecordStore, scopeId: string, over: Partial<FundingVerificationRecord> = {}) {
  const record = verification(scopeId, over);
  store.plant(record);
  return record;
}

function cloneQueuedJob(sourceId: string, id: string): void {
  const original = getRepos().jobs.findById(sourceId);
  if (!original) throw new Error("fixture job missing");
  getRepos().jobs.insert({
    ...original,
    id,
    cwmId: `cwm-${id}`,
    status: "queued",
    completedAt: null,
    evidenceBundleId: null,
  });
}

describe("GET /api/operator/jobs funding readmodel (N145)", () => {
  it("T3: a listed accepted scope has the verified record's fundedAt, operator and funding block", async () => {
    const paid = await listedPaidScope();
    const store = installTestFundingRecordStore();
    // Deliberately differ from the poll clock: fundedAt belongs to the funding
    // block, not to the gateway's read time or the verifier's write time.
    const record = plantRecord(store, paid.scopeId, { fundedAt: Math.floor(T0 / 1000) - 600 });
    const res = await poll(PROVEN_HEADERS);

    expect(res.statusCode).toBe(200);
    expect(res.json().emergencyStop).toBe("clear");
    const { scopes, read } = okFunding(listedJob(res, paid.jobId));
    expect(read).toBe("ok");
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({
      scopeId: paid.scopeId,
      jobId: paid.jobId,
      binding: "bound",
      state: "funded_verified",
      asOf: iso(T0),
      verification: {
        escrowAddress: record.escrowAddress,
        operator: record.operator,
        chainId: record.chainId,
        fundingBlockNumber: record.fundingBlockNumber,
        fundingBlockHash: record.fundingBlockHash,
        fundedAt: record.fundedAt,
      },
    });
    expect(scopes[0]!.verification).not.toHaveProperty("buyer");
  });

  it("T4: without a store, every scope is no_record and no opt-in environment changes the reply", async () => {
    const paid = await listedPaidScope();
    vi.stubEnv("PCC_VNEXT_RECORD_NETWORK", undefined);
    vi.stubEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", undefined);
    vi.stubEnv("PCC_VNEXT_TESTNET_BUYERS", undefined);
    const before = await poll();

    expect(before.statusCode).toBe(200);
    const funding = okFunding(listedJob(before, paid.jobId));
    expect(funding.scopes).toHaveLength(1);
    expect(funding.scopes[0]).toMatchObject({ binding: "no_record", verification: null });
    expect(funding.scopes[0]!.state).not.toBe("funded_verified");
    expect(vi.mocked(paidScopeActivationTerms)).not.toHaveBeenCalled();

    vi.stubEnv("PCC_VNEXT_RECORD_NETWORK", "base-sepolia");
    vi.stubEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", "1");
    vi.stubEnv("PCC_VNEXT_TESTNET_BUYERS", BUYER);
    const after = await poll();
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual(before.json());
    expect(vi.mocked(paidScopeActivationTerms)).not.toHaveBeenCalled();
  });

  it("T4b: terms are never consulted for no-record scopes and exactly once for a recorded scope", async () => {
    const paid = await listedPaidScope();
    const store = installTestFundingRecordStore();
    const terms = vi.mocked(paidScopeActivationTerms);
    terms.mockClear();

    const unfunded = await poll();
    expect(unfunded.statusCode).toBe(200);
    expect(okFunding(listedJob(unfunded, paid.jobId)).scopes[0]).toMatchObject({ binding: "no_record", verification: null });
    expect(terms).not.toHaveBeenCalled();

    plantRecord(store, paid.scopeId);
    const recorded = await poll();
    expect(recorded.statusCode).toBe(200);
    expect(okFunding(listedJob(recorded, paid.jobId)).scopes[0]).toMatchObject({ binding: "bound", state: "funded_verified" });
    expect(terms).toHaveBeenCalledTimes(1);
    expect(terms).toHaveBeenCalledWith({ id: paid.scopeId, jobId: paid.jobId, kernelId: KERNEL });
  });

  it("T5: one throwing funding read marks only its job failed, leaving a second job and stop unchanged", async () => {
    const first = await listedPaidScope(ESCROW_A);
    const second = await listedPaidScope(ESCROW_B);
    const store = installTestFundingRecordStore();
    plantRecord(store, first.scopeId);
    const secondRecord = plantRecord(store, second.scopeId, { escrowAddress: ESCROW_B });
    const read = store.findByScope.bind(store);
    vi.spyOn(store, "findByScope").mockImplementation((handle, scopeId) => {
      if (scopeId === first.scopeId) throw new Error("synthetic internal failure; do not log");
      return read(handle, scopeId);
    });

    const res = await poll();
    expect(res.statusCode).toBe(200);
    expect(res.json().emergencyStop).toBe("clear");
    expect(listedJob(res, first.jobId).funding).toEqual({ read: "failed" });
    const unaffected = okFunding(listedJob(res, second.jobId));
    expect(unaffected.scopes).toHaveLength(1);
    expect(unaffected.scopes[0]).toMatchObject({
      scopeId: second.scopeId,
      binding: "bound",
      state: "funded_verified",
      verification: { fundedAt: secondRecord.fundedAt, operator: secondRecord.operator },
    });
  });

  it("T6: a no-scope job has [], even when another kernel has a scope for that job id", async () => {
    const paid = await listedPaidScope();
    const noScopeJob = "job-funding-with-no-local-scope";
    cloneQueuedJob(paid.jobId, noScopeJob);
    const initial = await poll();
    expect(initial.statusCode).toBe(200);
    expect(listedJob(initial, noScopeJob).funding).toEqual({ read: "ok", scopes: [] });

    // Deliberately insert the same job id under a different kernel; query must
    // filter by BOTH kernel_id and job_id, regardless of the supplied job id.
    getStore().db.insert(schema.executionScopes).values({
      ...scopeRow(paid.scopeId),
      id: "scope-funding-foreign-kernel",
      jobId: noScopeJob,
      kernelId: OTHER_KERNEL,
    }).run();
    const res = await poll();
    expect(res.statusCode).toBe(200);
    expect(listedJob(res, noScopeJob).funding).toEqual({ read: "ok", scopes: [] });
    expect(okFunding(listedJob(res, paid.jobId)).scopes.map((scope) => scope.scopeId)).toEqual([paid.scopeId]);
  });

  it("T7: stop withholds queued jobs before any funding read", async () => {
    const paid = await listedPaidScope();
    const store = installTestFundingRecordStore();
    plantRecord(store, paid.scopeId);
    const read = vi.spyOn(store, "findByScope");
    const before = await poll();
    expect(before.statusCode).toBe(200);
    expect(okFunding(listedJob(before, paid.jobId)).scopes).toHaveLength(1);
    expect(read).toHaveBeenCalledWith(getStore().db, paid.scopeId);
    read.mockClear();

    setPolicy(KERNEL, { ...basePolicy(), emergencyStop: true });
    const stopped = await poll();
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toEqual({ jobs: [], emergencyStop: "stopped" });
    expect(read).not.toHaveBeenCalled();
  });

  it("T8: removing the new key exactly restores each base job (including order), and list failure keeps its old body", async () => {
    const paid = await listedPaidScope();
    cloneQueuedJob(paid.jobId, "job-funding-shape-control");
    const store = installTestFundingRecordStore();
    plantRecord(store, paid.scopeId);
    const base = await poll(CLAIMED_HEADERS);
    const decided = await poll(ADMIN_HEADERS);
    expect(base.statusCode).toBe(200);
    expect(decided.statusCode).toBe(200);
    expect(base.json().emergencyStop).toBe(decided.json().emergencyStop);
    const baseJobs = base.json().jobs as Array<Record<string, unknown>>;
    const newJobs = decided.json().jobs as Array<Record<string, unknown>>;
    expect(newJobs).toHaveLength(baseJobs.length);
    expect(newJobs.map((job) => {
      const unchanged = { ...job };
      delete unchanged.funding;
      return unchanged;
    })).toEqual(baseJobs);
    expect(newJobs.map((job) => job.id)).toEqual(baseJobs.map((job) => job.id));

    const facade = getJobFacade();
    vi.spyOn(facade, "list").mockResolvedValue({ success: false } as never);
    const failedList = await poll();
    expect(failedList.statusCode).toBe(200);
    expect(failedList.json()).toEqual({ jobs: [], emergencyStop: "clear" });
  });

  it("T9: anonymous 401 and another kernel's operator 403 preserve refusal and never read funding", async () => {
    const paid = await listedPaidScope();
    const store = installTestFundingRecordStore();
    plantRecord(store, paid.scopeId);
    const read = vi.spyOn(store, "findByScope");
    const anonymous = await poll({});
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual(AUTHENTICATION_REQUIRED);
    expect(read).not.toHaveBeenCalled();

    const otherOperator = await poll({ "x-test-principal": SEED_OPERATORS[OTHER_KERNEL] });
    expect(otherOperator.statusCode).toBe(403);
    expect(otherOperator.json()).toEqual({
      error: "forbidden",
      reason: "not_kernel_operator",
      message: "Only this kernel's operator or the gateway admin may do this.",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("T10: two scopes sort by created_at then id, and only the bound scope has verification", async () => {
    const paid = await listedPaidScope();
    const store = installTestFundingRecordStore();
    const record = plantRecord(store, paid.scopeId);
    // Insert second, but give it an earlier created_at. Database insertion order
    // must not dictate the poll's chronological scope order.
    getStore().db.insert(schema.executionScopes).values({
      ...scopeRow(paid.scopeId),
      id: SECOND_SCOPE,
      createdAt: iso(T0 - 60_000),
    }).run();
    const res = await poll();
    expect(res.statusCode).toBe(200);
    const scopes = okFunding(listedJob(res, paid.jobId)).scopes;
    expect(scopes.map((scope) => scope.scopeId)).toEqual([SECOND_SCOPE, paid.scopeId]);
    expect(scopes[0]).toMatchObject({ binding: "no_record", verification: null });
    expect(scopes[1]).toMatchObject({
      binding: "bound", state: "funded_verified",
      verification: { fundedAt: record.fundedAt, operator: record.operator },
    });
    expect(scopes[0]!.asOf).toBe(scopes[1]!.asOf);

    // Also pin the second sort key: with equal creation times the order is by id.
    getStore().db.update(schema.executionScopes).set({ createdAt: iso(T0) })
      .where(eq(schema.executionScopes.id, SECOND_SCOPE)).run();
    const tied = await poll();
    expect(okFunding(listedJob(tied, paid.jobId)).scopes.map((scope) => scope.scopeId))
      .toEqual([SECOND_SCOPE, paid.scopeId].sort());
  });

  it("T11: a claimed-only operator reads the base shape without a funding lookup; proven and admin read funding", async () => {
    const paid = await listedPaidScope();
    const store = installTestFundingRecordStore();
    plantRecord(store, paid.scopeId);
    const read = vi.spyOn(store, "findByScope");
    const claimed = await poll(CLAIMED_HEADERS);
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().emergencyStop).toBe("clear");
    expect(listedJob(claimed, paid.jobId)).not.toHaveProperty("funding");
    expect(read).not.toHaveBeenCalled();

    const proven = await poll(PROVEN_HEADERS);
    expect(proven.statusCode).toBe(200);
    expect(okFunding(listedJob(proven, paid.jobId)).scopes[0]).toMatchObject({ state: "funded_verified", binding: "bound" });
    expect(read).toHaveBeenCalledTimes(1);

    read.mockClear();
    const admin = await poll(ADMIN_HEADERS);
    expect(admin.statusCode).toBe(200);
    expect(okFunding(listedJob(admin, paid.jobId)).scopes[0]).toMatchObject({ state: "funded_verified", binding: "bound" });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
