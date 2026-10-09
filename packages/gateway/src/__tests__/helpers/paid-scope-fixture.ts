/**
 * Fixture for the buyer-funding Stage 2 tests (n133-reconcile-paid-scope.test.ts and
 * n133-funding-record-gate.test.ts): the paid-job, relay and operator routes over an in-memory
 * store, built as the N133 suites build them, a fake clock, a buyer's paid scope on a REAL escrow
 * (a 0x contract address), and finalized verification records.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { vi } from "vitest";
import { schema, eq, sql } from "@pcc/store";
import { paidJobFlowRoutes } from "../../routes/paid-job-flow.js";
import { deviceRelayRoutes } from "../../routes/device-relay.js";
import { operatorRoutes } from "../../routes/operator.js";
import { initStore, closeStore, getStore, getRepos } from "../../db.js";
import { actAsJobParty } from "./job-read-party.js";
import { __setFundingRecordStoreForTest, type FundingVerificationRecord } from "../../services/funding-record-port.js";
import { PAID_SCOPE_TTL_MS } from "../../services/scope-acceptance.js";
import {
  __setPaidScopeActivationTermsForTest,
  type PaidScopeActivationTerms,
} from "../../services/paid-scope-activation-terms.js";

export const KERNEL = "kernel-nyc"; // operator 0x1111…, default (manual) policy
export const BUYER = "0x5555555555555555555555555555555555555555";
export const OTHER = "0x6666666666666666666666666666666666666666";
export const ESCROW_A = "0x" + "a1".repeat(20);
export const ESCROW_B = "0x" + "b2".repeat(20);
/** The mint's window: a scope not live yet may be accepted and funded until mint + this (1 h, #591). */
export const TTL = PAID_SCOPE_TTL_MS;
export const MIN = 60_000;
/** The chain the tests' records are verified on (Base Sepolia), and the post-activation TTL they pass. */
export const CHAIN_ID = 84532;
export const ACTIVATION_TTL = 6 * 60 * MIN;
/** reconcilePaidScope's required inputs (rulings 4 and 5), as the tests give them explicitly. */
export const TERMS: PaidScopeActivationTerms = { expectedChainId: CHAIN_ID, postActivationTtlMs: ACTIVATION_TTL };
/** Installs the accept route's source of the expected chain and TTL (none by default: both null). */
export const installActivationTerms = (terms: PaidScopeActivationTerms = TERMS) =>
  __setPaidScopeActivationTermsForTest(() => terms);
/** The fake clock's start: every scope in these tests is minted at T0. */
export const T0 = Date.parse("2026-10-08T12:00:00.000Z");
export const iso = (ms: number) => new Date(ms).toISOString();

const ENV = ["MOCK_SETTLEMENT", "PCC_GATEWAY_PRIVATE_KEY", "PCC_A2A_AUTH_DISABLED", "PCC_DB_PATH", "PCC_ADMIN_KEY", "NODE_ENV"] as const;
export const ADMIN = "fund-s2-admin";

export interface Fixture {
  app: FastifyInstance;
}

/** N98: each kernel submitted to carries one USDC-priced liquid-handler capability. */
function ensurePricedLiquidHandler(kernelId: string): void {
  const capabilities = getRepos().capabilities;
  if (capabilities.findByKernel(kernelId).some((c: { type: string }) => c.type === "liquid-handler")) return;
  capabilities.insert({
    id: `cap-liquid-handler-${kernelId}`,
    kernelId,
    type: "liquid-handler",
    name: "liquid-handler test capability",
    description: "test",
    materials: [],
    tolerances: {},
    envelope: { x: 1, y: 1, z: 1, unit: "mm" as const },
    assuranceTiers: [0, 1, 2, 3],
    pricing: { currency: "USDC", baseCost: "10.00", minimum: "0.01" } as never,
    availability: {},
    location: { lat: 40.7, lng: -74 },
  } as never);
}

const saved: Record<string, string | undefined> = {};

/**
 * beforeEach: a fresh store and app, mock settlement on (the escrow is then made real per test), the
 * clock at T0. The store is in memory unless `dbPath` names a database file.
 */
export async function setUpFixture(opts: { dbPath?: string } = {}): Promise<Fixture> {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.MOCK_SETTLEMENT = "true";
  delete process.env.PCC_GATEWAY_PRIVATE_KEY;
  delete process.env.PCC_A2A_AUTH_DISABLED;
  process.env.PCC_ADMIN_KEY = ADMIN;
  process.env.PCC_DB_PATH = opts.dbPath ?? ":memory:";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  initStore({ seed: true });
  ensurePricedLiquidHandler(KERNEL);

  const app = Fastify({ logger: false });
  app.decorateRequest("operatorId", null);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.addHook("onRequest", async (req) => {
    const key = req.headers["x-test-key"];
    if (typeof key === "string") {
      (req as unknown as { operatorId: string }).operatorId = key;
      (req as unknown as { userId: string }).userId = key;
    }
  });
  // A request with no x-test-key reads as kernel-nyc's operator, proven.
  actAsJobParty(app);
  await app.register(paidJobFlowRoutes);
  await app.register(deviceRelayRoutes);
  await app.register(operatorRoutes);
  await app.ready();
  return { app };
}

/** afterEach. */
export async function tearDownFixture(f: Fixture): Promise<void> {
  await f.app.close();
  // Before NODE_ENV is restored: the setters refuse outside a test process.
  process.env.NODE_ENV = "test";
  __setFundingRecordStoreForTest(null);
  __setPaidScopeActivationTermsForTest(null);
  closeStore();
  vi.useRealTimers();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

export const db = () => getStore().db;
export const scopeRow = (id: string) =>
  db().select().from(schema.executionScopes).where(eq(schema.executionScopes.id, id)).get()!;
export const asKey = (id: string) => ({ "x-test-key": id });

export function setPolicy(kernelId: string, policy: unknown): void {
  db().run(sql`INSERT OR REPLACE INTO operator_policies (kernel_id, policy, updated_at, updated_by)
    VALUES (${kernelId}, ${JSON.stringify(policy)}, ${new Date().toISOString()}, ${"test"})`);
}
/** A copy of the kernel's seeded policy. */
export const basePolicy = (kernelId = KERNEL): Record<string, unknown> =>
  structuredClone(
    (db().select().from(schema.operatorPolicies).where(eq(schema.operatorPolicies.kernelId, kernelId)).get()?.policy ??
      {}) as Record<string, unknown>,
  );

export function setEscrow(escrowId: string, over: Partial<{ payer: string; status: string; contractAddress: string }>): void {
  db().update(schema.escrows).set(over).where(eq(schema.escrows.id, escrowId)).run();
}

export const submit = (f: Fixture, buyer = BUYER) =>
  f.app.inject({
    method: "POST",
    url: "/api/jobs/submit-from-discovery",
    headers: asKey(buyer),
    payload: { kernelId: KERNEL, capabilityType: "liquid-handler", userAgentId: buyer },
  });
/** The kernel operator's decision (no x-test-key reads as kernel-nyc's operator). */
export const acceptScope = (f: Fixture, scopeId: string) =>
  f.app.inject({ method: "POST", url: `/api/operator/scopes/${scopeId}/accept` });
export const revokeScope = (f: Fixture, scopeId: string) =>
  f.app.inject({ method: "POST", url: `/api/relay/${KERNEL}/scope/${scopeId}/revoke` });
/** A write tool call under the scope, as the buyer. */
export const writeAs = (f: Fixture, scopeId: string, buyer = BUYER) =>
  f.app.inject({
    method: "POST",
    url: `/api/relay/${KERNEL}/tool-call`,
    headers: asKey(buyer),
    payload: { scopeId, toolName: "ot2_run_protocol", args: { protocol: "x" } },
  });

/**
 * A buyer's paid job on kernel-nyc (manual policy): its escrow row made a real, funded escrow at
 * `real` (or left the test's mock escrow with real: null), then accepted by the kernel's operator
 * unless accept is false.
 */
export async function paidScope(
  f: Fixture,
  opts: { real?: string | null; accept?: boolean; buyer?: string } = {},
): Promise<{ scopeId: string; jobId: string; escrowId: string }> {
  const real = opts.real === undefined ? ESCROW_A : opts.real;
  const res = await submit(f, opts.buyer ?? BUYER);
  if (res.statusCode !== 201) throw new Error(`submit answered ${res.statusCode}`);
  const { scopeId, jobId, escrowId } = res.json() as { scopeId: string; jobId: string; escrowId: string };
  if (real !== null) setEscrow(escrowId, { contractAddress: real, status: "funded" });
  if (opts.accept !== false) {
    const accepted = await acceptScope(f, scopeId);
    if (accepted.statusCode !== 200) throw new Error(`accept answered ${accepted.statusCode}`);
  }
  return { scopeId, jobId, escrowId };
}

/** The verifier's finalized record of BUYER's funding of ESCROW_A for `scopeId`, at the clock's now. */
export function verification(scopeId: string, over: Partial<FundingVerificationRecord> = {}): FundingVerificationRecord {
  return {
    scopeId,
    escrowAddress: ESCROW_A,
    buyer: BUYER,
    chainId: 84532,
    blockNumber: "31337000",
    blockHash: "0x" + "c3".repeat(32),
    verifierVersion: "verifier-test/1",
    verifiedAt: new Date().toISOString(),
    finality: "finalized",
    ...over,
  };
}
