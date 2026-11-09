import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import { eq, schema } from "@pcc/store";
import { getRepos, getStore } from "../db.js";
import { createOperationIdTransform } from "../openapi/operation-id.js";
import { JOB_READ_REFUSAL } from "../readmodels/job-execution.js";
import { jobFundingOf } from "../readmodels/job-funding.js";
import { jobFundingRoutes } from "../routes/job-funding.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { reconcilePaidScope } from "../services/reconcile-paid-scope.js";
import type { FundingVerificationRecord } from "../services/funding-record-port.js";
import type { FundingStatusDTO } from "../readmodels/funding-status.js";
import { actAsJobParty, SEED_OPERATORS } from "./helpers/job-read-party.js";
import { installTestFundingRecordStore, type TestFundingRecordStore } from "./helpers/test-funding-record-store.js";
import {
  ADMIN, BUYER, ESCROW_A, KERNEL, OTHER, T0, TERMS,
  installActivationTerms, iso, paidScope, scopeRow, setUpFixture, tearDownFixture, verification,
  type Fixture,
} from "./helpers/paid-scope-fixture.js";

// Transparent spy: refusals must never reach the funding readmodel.
vi.mock("../readmodels/job-funding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../readmodels/job-funding.js")>();
  return { ...actual, jobFundingOf: vi.fn(actual.jobFundingOf) };
});

const BUYER_HEADERS = { "x-test-principal": BUYER };
const ADMIN_HEADERS = { "x-admin-key": ADMIN };
const OPERATOR_HEADERS = { "x-test-principal": SEED_OPERATORS[KERNEL] };
const OTHER_HEADERS = { "x-test-principal": OTHER };
const UNPROVEN_HEADERS = { "x-test-principal": BUYER, "x-test-proven-wallet": "none" };
const MISSING = "job-n268-4-missing";
const SECOND_SCOPE = "scope-n268-4-second";
const OTHER_KERNEL = "kernel-sf";
const READ_FAILED = {
  error: "read_model_unavailable",
  message: "The job record could not be read. Try again shortly.",
};

let fixture: Fixture;
let app: FastifyInstance;

// Vitest 1 may assign undefined through process.env: delete it explicitly.
function setEnv(name: string, value: string | undefined): void {
  vi.stubEnv(name, value ?? "");
  if (value === undefined) delete process.env[name];
}

beforeEach(async () => {
  for (const name of ["PCC_VNEXT_RECORD_NETWORK", "PCC_VNEXT_ALLOW_TESTNET_RECORD", "PCC_VNEXT_TESTNET_BUYERS", "TENANT_ENFORCE"]) {
    setEnv(name, undefined);
  }
  fixture = await setUpFixture();
  app = Fastify({ logger: false });
  actAsJobParty(app, null);
  await app.register(jobFundingRoutes);
  await app.register(operatorRelayRoutes);
  await app.ready();
  vi.mocked(jobFundingOf).mockClear();
});

afterEach(async () => {
  await app.close();
  await tearDownFixture(fixture);
  vi.restoreAllMocks();
  vi.mocked(jobFundingOf).mockClear();
  vi.unstubAllEnvs();
});

function read(jobId: string, headers: Record<string, string> = BUYER_HEADERS) {
  return app.inject({ method: "GET", url: `/api/jobs/${jobId}/funding`, headers });
}

function plantRecord(store: TestFundingRecordStore, scopeId: string, over: Partial<FundingVerificationRecord> = {}) {
  const record = verification(scopeId, over);
  store.plant(record);
  return record;
}

function cloneJob(sourceId: string, id: string): void {
  const original = getRepos().jobs.findById(sourceId);
  if (!original) throw new Error("fixture job missing");
  getRepos().jobs.insert({ ...original, id, cwmId: `cwm-${id}`, status: "queued", completedAt: null, evidenceBundleId: null });
}

/** Let the gate's job lookup succeed, then fail the scopes query itself. */
function failScopesQuery(): void {
  const db = getStore().db;
  const select = db.select.bind(db);
  vi.spyOn(db, "select").mockImplementationOnce(select).mockImplementation(() => {
    throw new Error("synthetic scope read failure");
  });
}

describe("GET /api/jobs/:jobId/funding (N268-4)", () => {
  it("F1: the recorded buyer reads awaiting funding, verified funding, then the active source status", async () => {
    installActivationTerms();
    const { jobId, scopeId } = await paidScope(fixture);
    const awaiting = await read(jobId);
    expect(awaiting.statusCode).toBe(200);
    expect(awaiting.json().scopes).toHaveLength(1);
    expect(awaiting.json().scopes[0]).toMatchObject({ state: "awaiting_funding", binding: "no_record", verification: null });

    const record = plantRecord(installTestFundingRecordStore(), scopeId);
    const funded = await read(jobId);
    expect(funded.statusCode).toBe(200);
    expect(funded.json().scopes[0]).toMatchObject({
      state: "funded_verified", binding: "bound", scope: { sourceStatus: "awaiting_funding" },
      verification: { escrowAddress: ESCROW_A, chainId: record.chainId, fundedAt: record.fundedAt },
    });
    expect(funded.json().scopes[0].verification).not.toBeNull();

    expect(reconcilePaidScope(scopeId, record, TERMS)).toMatchObject({ kind: "activated", scopeId, record });
    expect(scopeRow(scopeId).status).toBe("active");
    const active = await read(jobId);
    expect(active.statusCode).toBe(200);
    expect(active.json().scopes[0]).toMatchObject({ state: "funded_verified", binding: "bound", scope: { sourceStatus: "active" } });
  });

  it("F2 (neg-stranger): another proven wallet gets the missing job's byte-identical 404", async () => {
    const { jobId } = await paidScope(fixture);
    const stranger = await read(jobId, OTHER_HEADERS);
    const missing = await read(MISSING, OTHER_HEADERS);
    expect(stranger.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(stranger.body).toBe(missing.body);
    expect(stranger.json()).toEqual({ error: "job_not_found" });
  });

  it.each(["no record", "bound record", "other chain", "activated", "two scopes"])("F3c: admin scope parity with the operator listing: %s", async (state) => {
    installActivationTerms();
    const { jobId, scopeId } = await paidScope(fixture);
    getRepos().jobs.update(jobId, { status: "queued" });
    if (state !== "no record") {
      const record = plantRecord(installTestFundingRecordStore(), scopeId, state === "other chain" ? { chainId: 545 } : {});
      if (state === "activated") expect(reconcilePaidScope(scopeId, record, TERMS).kind).toBe("activated");
    }
    if (state === "two scopes") {
      getStore().db.insert(schema.executionScopes).values({ ...scopeRow(scopeId), id: SECOND_SCOPE, createdAt: iso(T0 - 60_000) }).run();
      // A foreign kernel's scope must be absent from BOTH views as well.
      getStore().db.insert(schema.executionScopes).values({ ...scopeRow(scopeId), id: "scope-n268-4-parity-foreign", kernelId: OTHER_KERNEL }).run();
    }
    const res = await read(jobId, ADMIN_HEADERS);
    const poll = await app.inject({ method: "GET", url: `/api/operator/jobs?kernelId=${KERNEL}&status=queued`, headers: ADMIN_HEADERS });
    expect(res.statusCode).toBe(200);
    expect(poll.statusCode).toBe(200);
    const listed = (poll.json().jobs as Array<{ id: string; funding: { read: string; scopes: FundingStatusDTO[] } }>).find((job) => job.id === jobId);
    expect(listed).toBeDefined();
    expect(listed!.funding.read).toBe("ok");
    expect(res.json().scopes).toEqual(listed!.funding.scopes);
    expect(res.json().scopes[0].asOf).toBe(iso(T0));
    if (state === "other chain") expect(res.json().scopes[0].binding).toBe("record_chain_mismatch");
    if (state === "two scopes") expect(res.json().scopes.map((s: FundingStatusDTO) => s.scopeId)).toEqual([SECOND_SCOPE, scopeId]);
  });

  it("F4a (neg-opt-ins-unset-no-record): no installed store reads awaiting_funding without verification", async () => {
    const { jobId } = await paidScope(fixture);
    const res = await read(jobId);
    expect(res.statusCode).toBe(200);
    expect(res.json().scopes[0]).toMatchObject({ binding: "no_record", verification: null, state: "awaiting_funding" });
    expect(res.json().scopes[0].state).not.toBe("funded_verified");
    expect(res.json().scopes[0].scope.sourceStatus).not.toBe("active");
  });

  it("F4b (neg-opt-ins-unset-record): a stored record with no expected chain reads unknown", async () => {
    const { jobId, scopeId } = await paidScope(fixture);
    plantRecord(installTestFundingRecordStore(), scopeId);
    const res = await read(jobId);
    expect(res.statusCode).toBe(200);
    expect(res.json().scopes[0]).toMatchObject({ binding: "expected_chain_unavailable", verification: null, state: "unknown" });
    expect(res.json().scopes[0].state).not.toBe("funded_verified");
  });

  it("G1: the kernel operator and admin read the buyer's scopes", async () => {
    installActivationTerms();
    const { jobId, scopeId } = await paidScope(fixture);
    plantRecord(installTestFundingRecordStore(), scopeId);
    const buyer = await read(jobId);
    expect(buyer.statusCode).toBe(200);
    expect(buyer.json().scopes).toHaveLength(1);
    for (const headers of [OPERATOR_HEADERS, ADMIN_HEADERS]) {
      const res = await read(jobId, headers);
      expect(res.statusCode).toBe(200);
      expect(res.json().scopes).toEqual(buyer.json().scopes);
    }
  });

  it.each([
    ["anonymous", {}, "unauthenticated"],
    ["unproven", UNPROVEN_HEADERS, "identity_unverified"],
  ] as const)("G2 (neg-%s): identity refusal is byte-identical for existing and missing jobs", async (_name, headers, kind) => {
    const { jobId } = await paidScope(fixture);
    const res = await read(jobId, headers);
    const missing = await read(MISSING, headers);
    expect(res.statusCode).toBe(JOB_READ_REFUSAL[kind].status);
    expect(missing.statusCode).toBe(res.statusCode);
    expect(res.json()).toEqual(JOB_READ_REFUSAL[kind].body);
    expect(res.body).toBe(missing.body);
  });

  it.each([200, 401, 403, 404, 503])("H1: Cache-Control is no-store on %i", async (status) => {
    const { jobId } = await paidScope(fixture);
    if (status === 503) failScopesQuery();
    const headers = status === 401 ? {} : status === 403 ? UNPROVEN_HEADERS : status === 404 ? OTHER_HEADERS : ADMIN_HEADERS;
    const res = await read(jobId, headers);
    expect(res.statusCode).toBe(status);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("H2: only jobId and scopes are returned, preserving all eight DTO fields and verification fields", async () => {
    installActivationTerms();
    const { jobId, scopeId } = await paidScope(fixture);
    const record = plantRecord(installTestFundingRecordStore(), scopeId);
    const res = await read(jobId);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(["jobId", "scopes"]);
    expect(res.json().jobId).toBe(jobId);
    expect(res.json().scopes).toHaveLength(1);
    expect(Object.keys(res.json().scopes[0]).sort()).toEqual(["asOf", "binding", "jobId", "schemaId", "scope", "scopeId", "state", "verification"]);
    expect(res.json().scopes[0]).toMatchObject({ schemaId: "pcc.funding-status/v1", asOf: iso(T0), verification: { fundingBlockHash: record.fundingBlockHash } });
    const expected = jobFundingOf(jobId, KERNEL, iso(T0));
    expect(expected.read).toBe("ok");
    if (expected.read !== "ok") throw new Error("fixture funding read failed");
    expect(res.json().scopes).toEqual(expected.scopes);
  });

  it("H3 (neg-scopes-query): a failed read is 503 with no partial scopes", async () => {
    const { jobId } = await paidScope(fixture);
    failScopesQuery();
    const res = await read(jobId, ADMIN_HEADERS);
    expect(jobFundingOf).toHaveBeenCalledWith(jobId, KERNEL, iso(T0));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual(READ_FAILED);
    expect(res.json()).not.toHaveProperty("scopes");
  });

  it("H4: a job without paid scopes returns an empty array", async () => {
    const { jobId } = await paidScope(fixture);
    const emptyId = "job-n268-4-no-scope";
    cloneJob(jobId, emptyId);
    const res = await read(emptyId, ADMIN_HEADERS);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ jobId: emptyId, scopes: [] });
  });

  it.each([
    ["stranger", OTHER_HEADERS, 404],
    ["anonymous", {}, 401],
    ["unproven", UNPROVEN_HEADERS, 403],
  ] as const)("H5 (neg-%s): refusal never calls jobFundingOf", async (_name, headers, status) => {
    const { jobId } = await paidScope(fixture);
    vi.mocked(jobFundingOf).mockClear();
    for (const id of [jobId, MISSING]) {
      const res = await read(id, headers);
      expect(res.statusCode).toBe(status);
      expect(jobFundingOf).not.toHaveBeenCalled();
    }
  });

  it("H6 (neg-foreign-kernel): a different kernel's scope for the same job is excluded", async () => {
    const { jobId, scopeId } = await paidScope(fixture);
    getStore().db.insert(schema.executionScopes).values({ ...scopeRow(scopeId), id: "scope-n268-4-foreign", kernelId: OTHER_KERNEL }).run();
    const res = await read(jobId);
    expect(res.statusCode).toBe(200);
    expect(res.json().scopes.map((s: FundingStatusDTO) => s.scopeId)).toEqual([scopeId]);
  });

  it("O1: OpenAPI exposes the funding operation and all five responses", async () => {
    const docs = Fastify({ logger: false });
    try {
      await docs.register(fastifySwagger, {
        transform: createOperationIdTransform(),
        openapi: { info: { title: "Funding read", version: "1.0.0" } },
      });
      docs.get("/openapi.json", async () => docs.swagger());
      await docs.register(jobFundingRoutes);
      await docs.ready();
      const res = await docs.inject({ method: "GET", url: "/openapi.json" });
      expect(res.statusCode).toBe(200);
      const operation = res.json().paths["/api/jobs/{jobId}/funding"]?.get;
      expect(operation).toBeDefined();
      expect(operation.operationId).toEqual(expect.any(String));
      expect(operation.operationId.length).toBeGreaterThan(0);
      expect(Object.keys(operation.responses).sort()).toEqual(["200", "401", "403", "404", "503"]);
    } finally {
      await docs.close();
    }
  });

/** The route is a pass-through: its scopes are exactly jobFundingOf's at the same clock. */
function expectPassThrough(body: { scopes: unknown }, jobId: string) {
  const expected = jobFundingOf(jobId, KERNEL, iso(T0));
  expect(expected.read).toBe("ok");
  expect(body.scopes).toEqual(expected.read === "ok" ? expected.scopes : null);
}
const setScopeStatus = (scopeId: string, status: string) =>
  getStore().db.update(schema.executionScopes).set({ status }).where(eq(schema.executionScopes.id, scopeId)).run();

it("F4c (neg-live-without-record): a scope live with no record reads unknown, never funded_verified", async () => {
  installActivationTerms();
  const { jobId, scopeId } = await paidScope(fixture);
  setScopeStatus(scopeId, "active");
  const res = await read(jobId);
  expect(res.statusCode).toBe(200);
  expect(res.json().scopes[0]).toMatchObject({ state: "unknown", binding: "no_record", verification: null, scope: { sourceStatus: "active" } });
  expectPassThrough(res.json(), jobId);
});

it("F4d (neg-bound-but-revoked): a revoked scope with a bound record is listed and reads cancelled", async () => {
  installActivationTerms();
  const { jobId, scopeId } = await paidScope(fixture);
  installTestFundingRecordStore().plant(verification(scopeId));
  setScopeStatus(scopeId, "revoked");
  const res = await read(jobId);
  expect(res.statusCode).toBe(200);
  expect(res.json().scopes).toHaveLength(1);
  expect(res.json().scopes[0]).toMatchObject({ state: "cancelled", binding: "bound", scope: { sourceStatus: "revoked" } });
  expect(res.json().scopes[0].verification).not.toBeNull();
  expectPassThrough(res.json(), jobId);
});

it("F4e (neg-no-escrow-row): a record whose job has no escrow row reads escrow_missing, unknown", async () => {
  installActivationTerms();
  const { jobId, scopeId, escrowId } = await paidScope(fixture);
  installTestFundingRecordStore().plant(verification(scopeId));
  getStore().db.update(schema.escrows).set({ cwmId: "cwm-n268-4-elsewhere" }).where(eq(schema.escrows.id, escrowId)).run();
  const res = await read(jobId, ADMIN_HEADERS);
  expect(res.statusCode).toBe(200);
  expect(res.json().scopes[0]).toMatchObject({ state: "unknown", binding: "escrow_missing", verification: null });
  expectPassThrough(res.json(), jobId);
});

it("F4f (neg-testnet-buyer-not-listed): testnet-only terms without the buyer listed read unknown", async () => {
  installActivationTerms({ ...TERMS, testnetOnly: true });
  const { jobId, scopeId } = await paidScope(fixture);
  installTestFundingRecordStore().plant(verification(scopeId));
  const res = await read(jobId);
  expect(res.statusCode).toBe(200);
  expect(res.json().scopes[0]).toMatchObject({ state: "unknown", binding: "testnet_buyer_not_allowed", verification: null });
  expectPassThrough(res.json(), jobId);
});

});
