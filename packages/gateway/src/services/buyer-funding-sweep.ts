/** Retry committed activations, then verify eligible prepares. Inert without deployment opt-ins. */
import { schema, eq, asc } from "@pcc/store";
import { getStore } from "../db.js";
import { fundingRecordStore } from "./funding-record-port.js";
import { configuredVNextDeploymentRecord, paidScopeActivationTerms } from "./paid-scope-activation-terms.js";
import { reconcilePaidScope } from "./reconcile-paid-scope.js";
import { scopeExpiryMs } from "./scope-expiry.js";
import { verifyBuyerFunding, type BuyerFundingVerifierDeps } from "./buyer-funding-verifier.js";
import { createVNextChainReads, vnextRpcUrl } from "./vnext-rpc-client.js";

export const BUYER_FUNDING_SWEEP_INTERVAL_SEC = Object.freeze({ min: 60, max: 180, default: 60 });
export interface BuyerFundingSweepLogger { info(message: string): void; warn(message: string): void }
export interface BuyerFundingSweepDeps extends BuyerFundingVerifierDeps { cap?: number; logger?: BuyerFundingSweepLogger }
export type BuyerFundingSweepResult = { skipped: "deployment_record_unavailable" } | { passA: Record<string, number>; passB: Record<string, number> };

export async function runBuyerFundingSweepOnce(deps: BuyerFundingSweepDeps = {}): Promise<BuyerFundingSweepResult> {
  const record = deps.record === undefined ? configuredVNextDeploymentRecord() : deps.record;
  if (!record) return { skipped: "deployment_record_unavailable" };
  const now = deps.now ?? (() => new Date());
  const at = now().getTime();
  const cap = deps.cap === undefined ? 25 : Math.max(0, Math.floor(deps.cap));
  const { db } = getStore();
  const store = fundingRecordStore();
  const passA: Record<string, number> = {}, passB: Record<string, number> = {};
  const count = (pass: "A" | "B", kind: string, scopeId: string, activated = false) => {
    const counts = pass === "A" ? passA : passB;
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (!activated) deps.logger?.info(`buyer_funding_sweep ${pass} ${kind} ${scopeId}`);
  };
  const open = (scope: typeof schema.executionScopes.$inferSelect | undefined) =>
    !!scope && scope.status === "awaiting_funding" && scopeExpiryMs(scope.expiresAt) > at;
  const scopeFor = (scopeId: string) => db.select().from(schema.executionScopes).where(eq(schema.executionScopes.id, scopeId)).get();
  const retryRows = db.select().from(schema.escrowFunding).where(eq(schema.escrowFunding.finality, "finalized"))
    .all().filter(row => open(scopeFor(row.scopeId))).slice(0, cap);
  for (const row of retryRows) {
    try {
      const scope = scopeFor(row.scopeId)!;
      const kept = store?.findByScope(db, row.scopeId);
      if (!kept) { count("A", "refused", row.scopeId); continue; }
      const activation = (deps.reconcile ?? reconcilePaidScope)(scope.id, kept, paidScopeActivationTerms(scope));
      count("A", activation.kind, scope.id, activation.kind === "activated");
    } catch { count("A", "row_failed", row.scopeId); }
  }
  const prepares = db.select().from(schema.fundingPrepares).orderBy(asc(schema.fundingPrepares.createdAt), asc(schema.fundingPrepares.id)).all()
    .filter(row => (row.state === "served" || row.state === "expired") && row.chainId === record.chainId
      && !store?.findByEscrow(db, row.chainId, row.escrow) && open(scopeFor(row.scopeId))).slice(0, cap);
  let reads = deps.reads;
  if (prepares.length && !reads) {
    const url = vnextRpcUrl();
    if (url) reads = createVNextChainReads(url);
  }
  for (const row of prepares) {
    try {
      const outcome = await verifyBuyerFunding({ chainId: row.chainId, escrow: row.escrow }, { ...deps, record, reads });
      const kind = outcome.kind === "refused" ? outcome.code : outcome.kind;
      count("B", kind, row.scopeId, outcome.kind === "recorded" && outcome.activation.kind === "activated");
    } catch { count("B", "row_failed", row.scopeId); }
  }
  return { passA, passB };
}

export function buyerFundingSweepStartRefusal(env: NodeJS.ProcessEnv = process.env): "test_process" | "deployment_record_unavailable" | "rpc_url_invalid" | null {
  const nodeEnv = env === process.env ? process.env.NODE_ENV : env.NODE_ENV;
  if (nodeEnv === "test") return "test_process";
  if (!configuredVNextDeploymentRecord()) return "deployment_record_unavailable";
  if (!vnextRpcUrl(env)) return "rpc_url_invalid";
  return null;
}

export function resolveBuyerFundingSweepIntervalSec(): number {
  const raw = process.env.PCC_VNEXT_FUNDING_SWEEP_INTERVAL_SEC;
  if (raw === undefined) return BUYER_FUNDING_SWEEP_INTERVAL_SEC.default;
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < BUYER_FUNDING_SWEEP_INTERVAL_SEC.min || Number(raw) > BUYER_FUNDING_SWEEP_INTERVAL_SEC.max) {
    console.warn("[buyer-funding-sweep] PCC_VNEXT_FUNDING_SWEEP_INTERVAL_SEC outside [60,180]; using 60");
    return BUYER_FUNDING_SWEEP_INTERVAL_SEC.default;
  }
  return Number(raw);
}

/** One ticker retains its lock until the run settles, including after a rejected run. */
export function makeBuyerFundingSweepTicker(run: () => Promise<unknown>, logger?: BuyerFundingSweepLogger): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try { await run(); }
    catch { logger?.warn("buyer_funding_sweep run_failed"); }
    finally { running = false; }
  };
}
let timer: NodeJS.Timeout | undefined;
let activeIntervalSec: number = BUYER_FUNDING_SWEEP_INTERVAL_SEC.default;
export function startBuyerFundingSweep(logger?: BuyerFundingSweepLogger): { stop(): void; intervalSec: number; started: boolean } {
  const intervalSec = resolveBuyerFundingSweepIntervalSec();
  if (timer) return { stop: stopBuyerFundingSweep, intervalSec: activeIntervalSec, started: false };
  if (buyerFundingSweepStartRefusal()) return { stop: () => {}, intervalSec, started: false };
  const tick = makeBuyerFundingSweepTicker(() => runBuyerFundingSweepOnce({ logger }), logger);
  timer = setInterval(() => { void tick(); }, intervalSec * 1000);
  timer.unref();
  activeIntervalSec = intervalSec;
  return { stop: stopBuyerFundingSweep, intervalSec, started: true };
}
export function stopBuyerFundingSweep(): void {
  if (timer) { clearInterval(timer); timer = undefined; }
}
