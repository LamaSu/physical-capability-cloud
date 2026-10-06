/**
 * SettlementService — orchestrates evidence storage, DB persistence, and on-chain settlement.
 *
 * Flow for a completed job:
 *   1. Store evidence bundle (IPFS/Storacha via createEvidenceStorage factory)
 *   2. Persist bundle + events to DB
 *   3. Submit evidence hash on-chain (if escrow contract is configured)
 *   4. For tier-0 jobs (no challenge window), immediately release the milestone
 *
 * All external calls (storage, chain) are best-effort. If they fail the job still
 * completes — errors are captured in the result rather than thrown.
 */

import type { EvidenceBundle } from "@pcc/spec";
import { isFabricated } from "@pcc/spec";
import { isAddress, getAddress, keccak256, toBytes } from "viem";
import type { Address, Hex } from "viem";
import type { OracleAttestation } from "@pcc/contracts";
import { getRepos, getStore } from "../db.js";
import { schema, getTableColumns } from "@pcc/store";
import {
  beginSettlement,
  endSettlement,
  escrowForJob,
  givenBackEscrow,
  recordChainSettlement,
  releaseEscrowFromSettlement,
  resolveRowlessDefaultTarget,
} from "./escrow-refund.js";
import {
  submitEvidence as onChainSubmitEvidence,
  releaseMilestone as onChainReleaseMilestone,
  getEscrowState as getEscrowStateV1,
  getEscrowStateV2,
  isWriteEnabled,
} from "../contracts/escrow-client.js";
import { Sentry } from "../sentry.js";
import { traceCollector, TraceCollector } from "../trace-collector.js";
import { pipelineTelemetry } from "../telemetry.js";
import { auditService } from "./audit-service.js";

/** The authoritative job row shape, as the bind-first block reads it — used to type the hoisted
 *  `authoritativeJob` binding (N79 round 8, P3) so Step 2's header computation can read it too. */
type AuthoritativeJobRow = ReturnType<ReturnType<typeof getRepos>["jobs"]["findById"]>;

// ---------------------------------------------------------------------------
// P3 (N79 round 8, astra 126i HIGH-1): exact re-delivery comparison helpers — GENERIC over every column
// ---------------------------------------------------------------------------

/** Recursively sorts object keys so two values differing only in key order still compare equal when stringified. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) sorted[key] = canonicalize(obj[key]);
    return sorted;
  }
  return value;
}

/** Deep equality by canonical JSON. */
function deepEqualCanonical(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

/**
 * N79 round 8 (P3, astra 126i HIGH-1): canonical deep equality with `null` and `undefined` treated as the SAME
 * value. A stored column reads back as SQLite `NULL` (`null`); a freshly computed column for an omitted
 * optional bundle field is `undefined`. `deepEqualCanonical` alone does not unify them —
 * `JSON.stringify(null) === "null"` (a string) but `JSON.stringify(undefined) === undefined` (the JS value) —
 * so a round-tripped `null` never read as equal to a freshly computed `undefined` before this normalization.
 */
function columnsEqual(a: unknown, b: unknown): boolean {
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  if (na === nb) return true;
  return deepEqualCanonical(na, nb);
}

/** Every column of `schema.evidenceBundles` except `id` (the lookup key, never compared) — enumerated from the
 *  Drizzle table itself via `getTableColumns`, not a hand list (N79 round 8, P3, astra 126i HIGH-1: round 7's
 *  hand-written header comparison omitted `sessionKeyAuthorization` and `tenantId` outright; this enumeration
 *  makes a future column compared automatically). */
const EVIDENCE_BUNDLE_COLUMNS: readonly string[] = Object.keys(getTableColumns(schema.evidenceBundles)).filter(
  (k) => k !== "id",
);

/** Every column of `schema.evidenceEvents` except `id` (the per-event lookup key, never compared). */
const EVIDENCE_EVENT_COLUMNS: readonly string[] = Object.keys(getTableColumns(schema.evidenceEvents)).filter(
  (k) => k !== "id",
);

/**
 * N79 round 8 (P3, astra 126i HIGH-1): the ONE function that computes the
 * header row THIS call writes for `bundle`, from the AUTHORITATIVE job (never the bundle, for the job-bound
 * columns): `jobId`, `stepId`, `kernelId`, `assuranceTier` and `tenantId` come from `job` — the schema comment
 * on `evidenceBundles.tenantId` says it is "backfilled at write time from the buyer/operator on the parent
 * job"; round 7 never wrote it at all. `job` is typed non-undefined
 * — the caller narrows it (never `?.` here) — because this function's whole point is to be THE authoritative
 * source for the job-bound columns; an optional job would silently fall back to trusting the bundle, which is
 * exactly the bug being fixed. `bundleHash`, `kernelSignature`, `sessionKeyAuthorization` and `createdAt` are
 * the bundle's own evidence content — `sessionKeyAuthorization` proves the signing key was authorized by the
 * kernel principal (`packages/spec/src/types/evidence.ts:176`) and the schema persists it
 * (`packages/db/src/schema/evidence.ts:19`), but round 7 never wrote or compared it (astra 126i HIGH-1's
 * reproduction: a re-delivery carrying a DIFFERENT, or no, authorization read as an exact match). Called by
 * both the fresh-insert path and the re-delivery comparison below, so the two can never drift apart.
 *
 * Note (equivalent mutant): after the bind-first check above (`bundle.jobId === jobId`, `bundle.stepId ===
 * job.stepId`, `bundle.kernelId === job.kernelId`, `bundle.assuranceTier === (job.assuranceTier ?? 0)` all
 * hold, or this function is never reached), `job.id`/`job.stepId`/`job.kernelId`/`job.assuranceTier ?? 0` are
 * VALUE-IDENTICAL to `bundle.jobId`/`bundle.stepId`/`bundle.kernelId`/`bundle.assuranceTier`. A mutant that
 * reads those four columns from `bundle` instead of `job` is therefore EQUIVALENT (no test can distinguish the
 * two allocators), not a survivor — `tenantId` has no such bind-first guarantee (never compared there), so it
 * is NOT equivalent: a mutant dropping it still gets caught (see the mutation table).
 */
function computeEvidenceHeaderRow(
  bundle: EvidenceBundle,
  job: NonNullable<AuthoritativeJobRow>,
): typeof schema.evidenceBundles.$inferInsert {
  return {
    id: bundle.id,
    jobId: job.id,
    stepId: job.stepId,
    kernelId: job.kernelId,
    assuranceTier: job.assuranceTier ?? 0,
    tenantId: job.tenantId ?? null,
    bundleHash: bundle.bundleHash,
    kernelSignature: bundle.kernelSignature,
    sessionKeyAuthorization: bundle.sessionKeyAuthorization ?? null,
    createdAt: bundle.createdAt,
  };
}

/** N79 round 8 (P3): the ONE function that computes the event rows THIS call writes for `bundle.events`. Called
 *  by both the fresh-insert path and the re-delivery comparison below. */
function computeEvidenceEventRows(bundle: EvidenceBundle): (typeof schema.evidenceEvents.$inferInsert)[] {
  return bundle.events.map((ev) => ({
    id: ev.id,
    bundleId: bundle.id,
    type: ev.type,
    timestamp: ev.timestamp,
    source: ev.source,
    payload: ev.payload as Record<string, unknown>,
    hash: ev.hash,
  }));
}

/**
 * N79 round 8 (P3, astra 126i HIGH-1 — generalizes round 7's `eventsExactMatch`): whether `incoming` (this
 * call's OWN computed event rows) is a true ONE-TO-ONE match against `existing` (the stored rows) — EVERY
 * column of `getTableColumns(schema.evidenceEvents)` equal via {@link columnsEqual}, keyed by id,
 * order-insensitive (a permuted delivery is still exact). NOT `length + every(...some(...))` (round 6's rule):
 * that passes on a bijection but ALSO on non-bijective coincidences like stored [A,B] / incoming [A,A] — astra
 * 126g H3b's exact reproduction. Duplicate ids WITHIN `incoming` can never be part of a bijection (there is
 * nothing left for a second occurrence of the same id to match that the first one did not already claim), so
 * they are rejected immediately, before any id-keyed map is even built.
 */
function eventsExactMatch(existing: readonly Record<string, unknown>[], incoming: readonly Record<string, unknown>[]): boolean {
  const incomingIds = incoming.map((e) => e.id);
  if (new Set(incomingIds).size !== incomingIds.length) return false;
  if (existing.length !== incoming.length) return false;
  const existingById = new Map(existing.map((e) => [e.id as string, e]));
  if (existingById.size !== existing.length) return false; // defend against a stored set with its own duplicate ids
  for (const ev of incoming) {
    const match = existingById.get(ev.id as string);
    if (!match) return false;
    for (const col of EVIDENCE_EVENT_COLUMNS) {
      if (!columnsEqual(match[col], ev[col])) return false;
    }
  }
  return true;
}

/**
 * N79 round 8 (P3, astra 126i HIGH-1): whether the STORED header row `existing` is an exact re-delivery of
 * `computedHeader` — EVERY column of `getTableColumns(schema.evidenceBundles)` except `id` equal via
 * {@link columnsEqual}. Enumerated from the table itself (not round 7's hand list, which omitted
 * `sessionKeyAuthorization` and the authoritative `tenantId` entirely), so a column added later is compared
 * automatically and this function need not change.
 */
function headerExactMatch(existing: Record<string, unknown>, computedHeader: Record<string, unknown>): boolean {
  return EVIDENCE_BUNDLE_COLUMNS.every((col) => columnsEqual(existing[col], computedHeader[col]));
}

// ---------------------------------------------------------------------------
// P2 (N79 round 8, astra 126i MEDIUM-1): escrow-version resolution + milestone-index derivation helpers
// ---------------------------------------------------------------------------

/**
 * N79 round 8 (P2, astra 126i MEDIUM-1): resolve a JOB-OWNED escrow row's OWN `version` column. The schema's
 * documented default (`packages/db/src/schema/settlement.ts:14-21`) — and the direct chain routes'
 * `resolveEscrowVersion` (`routes/escrow.ts`) — already treat a missing value (`null`/`undefined`, a
 * pre-migration row) as `"v2"`; round 7 instead sent exactly those two values to the V1 reader below (astra
 * 126i MEDIUM-1's reproduction: a null-version V2 row read `evidence_milestone_unbound` for a legitimate
 * producer). `"v3"` resolves to itself. Anything else is UNKNOWN — a value nobody writes today, but the
 * resolver must not silently guess a reader for it. This resolver is for a ROW's version only: the rowless
 * configured default's `"v1"` sentinel ({@link resolveRowlessDefaultTarget}) never flows through it.
 */
type ResolvedRowEscrowVersion = "v2" | "v3" | "unknown";
function resolveEscrowRowVersion(version: string | null | undefined): ResolvedRowEscrowVersion {
  if (version === "v3") return "v3";
  if (version === null || version === undefined || version === "v2") return "v2";
  return "unknown";
}

/**
 * N79 round 8 (P2, astra 126i MEDIUM-1): the verifier's CLOSED input. The CALLER computes ONE of these
 * three — never a raw column value — so the verifier itself can never conflate "this came from the rowless
 * configured default" with "this is what a row's `version` column happens to contain". Passing the raw column
 * through to a verifier that dispatches on the string would send a row that literally holds `"v1"` (a value
 * {@link resolveEscrowRowVersion} maps to UNKNOWN) to `getEscrowStateV1`, exactly like a real rowless target.
 * The selector collapses both callers' own resolution into a type the verifier cannot misread:
 *   - `"rowless-v1"`: ONLY the rowless configured default caller passes this (reachable only when
 *     {@link resolveRowlessDefaultTarget} returned `version: "v1"` — i.e. `ESCROW_CONTRACT_VERSION` is
 *     explicitly `"v1"`).
 *   - `"v2"`: ONLY the job-owned-row caller passes this, and only after {@link resolveEscrowRowVersion} itself
 *     resolved the row's version to `"v2"` — a raw `"v1"`, `"v3"`, or any other string never reaches here.
 *   - `"refuse"`: everything else (a row resolved to `"v3"` or UNKNOWN).
 */
type MilestoneVerificationSelector = "rowless-v1" | "v2" | "refuse";

/**
 * P2 (N79 round 7/8): fresh confirmation, right before a chain WRITE, that the chain milestone at `derivedIndex`
 * still carries the step identity this call derived its target from. Dispatches on the CLOSED `selector` (see
 * {@link MilestoneVerificationSelector}): `"rowless-v1"` → {@link getEscrowStateV1}; `"v2"` → {@link
 * getEscrowStateV2} (lead round-7 addendum: decoding a V2 clone's 12-field milestone struct through the V1
 * ABI's shorter 9-field tuple is a PLAUSIBLE field-order-superset argument, but unproven against a live
 * contract — a wrong decode here would fail closed every V2 job's evidence submit, silently, which is worse
 * than the extra reader); `"refuse"` → no read at all (no existing reader is a confirmed match for v3;
 * guessing for an unresolved value is worse than refusing). A failed read refuses the same way: this never
 * throws, and it adds no chain call on a path that was not already about to make one (callers only reach this
 * once a chain WRITE is already decided).
 */
async function verifyDerivedMilestoneOnChain(
  contractAddress: string,
  derivedIndex: number,
  expectedStepId: string,
  selector: MilestoneVerificationSelector,
): Promise<boolean> {
  if (selector === "refuse") return false;
  try {
    const expectedHash = keccak256(toBytes(expectedStepId)).toLowerCase();
    const chainState =
      selector === "rowless-v1"
        ? await getEscrowStateV1(contractAddress as Address)
        : await getEscrowStateV2(contractAddress as Address);
    const m = chainState.milestones[derivedIndex];
    if (!m) return false;
    return m.stepId.toLowerCase() === expectedHash;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SettlementResult {
  jobId: string;
  evidenceBundleId: string;
  cid?: string;
  evidenceTxHash?: string;
  releaseTxHash?: string;
  settled: boolean;
  error?: string;
  /**
   * N79 round 4 (R4-M3, astra 126b Q5 MEDIUM): set (to `false`), with `reconcile`, only when auto-release's
   * underlying {@link ReleaseResult} came back CONFIRMED on-chain but its bookkeeping failed. `settled` stays
   * chain truth either way; this says the DB still needs reconciling. Absent on a normal settlement.
   */
  recorded?: false;
  reconcile?: "required";
}

export interface ReleaseResult {
  jobId: string;
  txHash: string;
  status: "released" | "failed";
  error?: string;
  /**
   * Set (to `false`) only when the release is CONFIRMED on-chain but recording it in the database failed (N79 round 3,
   * F5). The escrow stays owned (`completing`), `reconcile: "required"` says it needs reconciling, and the failure is
   * logged. Absent on a normal release.
   */
  recorded?: false;
  reconcile?: "required";
}

export interface ProcessEvidenceOptions {
  milestoneIndex?: number;
  contractAddress?: string;
  autoRelease?: boolean; // true = immediately release after submitting evidence (tier 0)
  /**
   * Oracle attestation required for on-chain auto-release. Without it,
   * auto-release is skipped (release still callable manually later once
   * the attestation is available from the oracle client).
   */
  attestation?: OracleAttestation;
}

// ---------------------------------------------------------------------------
// SettlementService
// ---------------------------------------------------------------------------

export class SettlementService {
  /**
   * Process a completed job's evidence bundle:
   *   1. Store to IPFS/Storacha (best-effort)
   *   2. Persist to DB
   *   3. Submit hash on-chain (if write is enabled and escrow is configured)
   *   4. Auto-release if autoRelease=true (tier 0)
   */
  async processEvidence(
    bundle: EvidenceBundle,
    jobId: string,
    options: ProcessEvidenceOptions = {},
  ): Promise<SettlementResult> {
    const { milestoneIndex: suppliedMilestoneIndex, contractAddress, autoRelease = false, attestation } = options;
    // N79 round 7 (P2): the ONE authoritative milestone index, derived below from the job's own step — never
    // taken on the caller's word alone. Starts at the supplied value (or 0) only for paths that derive nothing
    // (no job-owned escrow AND no matched env-default target) — Step 3/4 never fire on those paths anyway (no
    // contractAddress, or writes disabled), so nothing downstream ever acts on an undereived value.
    let derivedMilestoneIndex = suppliedMilestoneIndex ?? 0;
    // The CLOSED selector for the fresh pre-chain-write verification below (`verifyDerivedMilestoneOnChain`) —
    // computed HERE, by this function, never passed a raw column value (N79 round 8, P2; see
    // {@link MilestoneVerificationSelector}'s doc). `undefined` for a path that derives nothing
    // (Step 3/4 never fire on it anyway).
    let derivedMilestoneSelector: MilestoneVerificationSelector | undefined;
    // N79 round 8 (P3): hoisted so Step 2's header computation can read the SAME authoritative job this block
    // already bound to, instead of a second, potentially-stale lookup.
    let authoritativeJob: AuthoritativeJobRow;

    // N79 round 5 (R5-H1, astra 126e Q2 HIGH): true ONLY once this bundle's row is confirmed to hold exactly what
    // this call submits — inserted fresh, or found as an exact re-delivery. Any failure before that (a primary-key
    // collision with a DIFFERENT bundle's content, an insert that fails and cannot even be re-read, a store that
    // will not open) leaves it false. Gates the on-chain submit, the job pointer write and auto-release together:
    // a job must never be pointed at, or settled on, evidence this call did not verifiably persist.
    let bundlePersisted = false;

    const result: SettlementResult = {
      jobId,
      evidenceBundleId: bundle.id,
      settled: false,
    };

    // ── Bind first (N79 round 6, H1-B / addendum 1 P2) ──────────────────────
    // BEFORE Step 1 — before any persistence or chain activity — the bundle's job, step, kernel and tier must
    // all name THIS call's own authoritative job, and a supplied contractAddress must name that job's OWN
    // escrow (when it has one). Without this, a bundle legitimately produced for one job could be persisted
    // under a different job's identity and settled against a completely different escrow (astra 126f H1-B:
    // `processEvidence(bundleForA, jobB, {contractAddress: escrowB})` persisted A's row, submitted to B's
    // escrow, and pointed B at A's evidence). Checked every producer of bundles (kernel-service.ts's two
    // auto-release call sites) already passes the job's own step/kernel/tier and `autoReleaseContractAddress`
    // (the job's own escrow, or the env default when it has none) — neither is loosened or bypassed by this.
    // Lead addendum 2: this lookup (and the escrow-target lookup below it) must never throw OUT of
    // processEvidence — a store that will not open used to propagate as an uncaught exception here, where
    // every caller before this round got a result object back. Touch nothing on failure: no persistence, no
    // chain activity — which the early return already guarantees.
    try {
      authoritativeJob = getRepos().jobs.findById(jobId);
      // A `const` alias, narrowed to non-undefined by the guard below: the OUTER `let authoritativeJob` is
      // hoisted for Step 2 (N79 round 8, P3) to read later, but TypeScript cannot carry a `let`'s narrowing
      // into a closure (e.g. the `.reduce` callback below) — only a `const` keeps it. `job` is that alias for
      // the rest of THIS bind-first block.
      const job = authoritativeJob;
      if (
        !job ||
        bundle.jobId !== jobId ||
        bundle.stepId !== job.stepId ||
        bundle.kernelId !== job.kernelId ||
        bundle.assuranceTier !== (job.assuranceTier ?? 0)
      ) {
        return { ...result, error: "evidence_job_mismatch" };
      }

      // ── The escrow target (N79 round 7/8, P2, astra 126g HIGH / 126i MEDIUM-1) ─
      // Resolve the ONE allowed target BEFORE Step 1: the job's own escrow row's address when a row exists,
      // else the rowless configured default when one is explicitly configured, else none. Round 6 only ran the
      // comparison `if (jobOwnEscrow)` — a job with NO escrow row skipped the comparison entirely, letting ANY
      // supplied contractAddress through (astra 126g H2). Round 7 then read the env address unconditionally,
      // assuming it always answers to V1 (astra 126i MEDIUM-1: production sets it to the V2 factory —
      // docs/V2_DEPLOY.md:183 — so an address alone proves nothing about which ABI is behind it). Round 8:
      // {@link resolveRowlessDefaultTarget} returns a target ONLY when `ESCROW_CONTRACT_VERSION` is explicitly
      // configured — with no configured version, a rowless job has NO chain target, and a supplied
      // contractAddress is still `escrow_mismatch` below.
      const jobOwnEscrow = escrowForJob(jobId);
      const rowlessDefault = resolveRowlessDefaultTarget();
      const allowedTarget = jobOwnEscrow ? jobOwnEscrow.contractAddress : rowlessDefault?.address;
      if (contractAddress) {
        if (!allowedTarget) {
          return { ...result, error: "escrow_mismatch" };
        }
        let targetIsAllowed = false;
        try {
          targetIsAllowed =
            contractAddress === allowedTarget ||
            (isAddress(contractAddress) &&
              isAddress(allowedTarget) &&
              getAddress(contractAddress) === getAddress(allowedTarget));
        } catch {
          targetIsAllowed = false;
        }
        if (!targetIsAllowed) {
          return { ...result, error: "escrow_mismatch" };
        }
      }

      // ── The milestone index (N79 round 7, P2, astra 126g HIGH) ────────────
      // Derive the ONE authoritative index from the job's own step — round 6 passed the caller's milestoneIndex
      // straight through with no check that it identifies THIS job's step at all (astra 126g H1: evidence
      // correctly bound to job A's step, submitted at job B's index on a shared escrow).
      if (jobOwnEscrow) {
        // With a row: the UNIQUE local milestone whose stepId === job.stepId. Pure local read — no chain call,
        // so this runs even when no contractAddress was supplied (Step 3/4 just never act on it then).
        const localRows = getRepos().escrows.findMilestonesByEscrow(jobOwnEscrow.id);
        const localMatches = localRows.reduce<number[]>((acc, row, i) => {
          if (row.stepId === job.stepId) acc.push(i);
          return acc;
        }, []);
        if (localMatches.length !== 1) {
          return { ...result, error: "evidence_milestone_unbound" };
        }
        derivedMilestoneIndex = localMatches[0]!;
        // N79 round 8 (P2): resolved HERE, not passed as the raw column — a row
        // that literally holds "v1" (never written by {@link resolveRowlessDefaultTarget}; a value
        // {@link resolveEscrowRowVersion} maps to UNKNOWN) must refuse, not dispatch through the rowless
        // sentinel.
        derivedMilestoneSelector = resolveEscrowRowVersion(jobOwnEscrow.version) === "v2" ? "v2" : "refuse";
        if (suppliedMilestoneIndex !== undefined && suppliedMilestoneIndex !== derivedMilestoneIndex) {
          return { ...result, error: "evidence_milestone_mismatch" };
        }
      } else if (allowedTarget && contractAddress && isWriteEnabled()) {
        // Without a row (the rowless configured default): the unique ON-CHAIN milestone whose stepId equals
        // keccak256(toBytes(job.stepId)) — derivation itself requires a chain read here, since there is no
        // local row to consult. Skipped when writes are disabled or no target is supplied: Step 3/4 can never
        // make a chain call on that path, and this derivation's own read must not be added where nothing else
        // would ever read or write the chain. `allowedTarget` is truthy here ONLY because `rowlessDefault`
        // resolved above (no job-owned row) — i.e. `ESCROW_CONTRACT_VERSION === "v1"` is already confirmed, so
        // V1 is the unambiguous reader (N79 round 8, P2: NOT "always v1-style" — explicitly configured v1-style).
        try {
          const chainState = await getEscrowStateV1(contractAddress as Address);
          const expectedHash = keccak256(toBytes(job.stepId)).toLowerCase();
          const chainMatches = chainState.milestones.reduce<number[]>((acc, m, i) => {
            if (m.stepId.toLowerCase() === expectedHash) acc.push(i);
            return acc;
          }, []);
          if (chainMatches.length !== 1) {
            return { ...result, error: "evidence_milestone_unbound" };
          }
          derivedMilestoneIndex = chainMatches[0]!;
          derivedMilestoneSelector = "rowless-v1"; // the ONLY caller allowed to pass this selector value.
          if (suppliedMilestoneIndex !== undefined && suppliedMilestoneIndex !== derivedMilestoneIndex) {
            return { ...result, error: "evidence_milestone_mismatch" };
          }
        } catch {
          return { ...result, error: "evidence_milestone_unbound" };
        }
      }
    } catch {
      return { ...result, error: "evidence_job_unverifiable" };
    }

    // ── Fabrication gate (detector side, coord #312/#316) ───────────────────
    // A bundle carrying any mock/simulated event must NOT settle as real. This
    // is the settlement-side twin of the oracle floor: fail CLOSED for paid
    // tiers (>=1). The evidence is still archived + persisted for the record,
    // but on-chain evidence submission AND auto-release are skipped. Tier 0
    // (self-attested dev floor) is unaffected. Additive precondition only — the
    // release mechanism (releaseMilestone) is unchanged.
    const fabricatedBlocksSettlement =
      bundle.events.some(isFabricated) && bundle.assuranceTier >= 1;
    if (fabricatedBlocksSettlement) {
      result.error = "fabricated_evidence";
      console.warn(
        `[settlement] Refusing to settle job ${jobId}: bundle ${bundle.id} contains ` +
          `fabricated (simulated/mock) events at paid tier ${bundle.assuranceTier}. ` +
          `Evidence archived + persisted but NOT settled as real.`,
      );
      auditService.log({
        eventType: "settlement.fabricated_refused",
        resourceType: "job",
        resourceId: jobId,
        action: "refuse_settlement",
        metadata: {
          bundleId: bundle.id,
          assuranceTier: bundle.assuranceTier,
          bundleHash: bundle.bundleHash,
        },
      });
    }

    // ── Local trace (alongside Sentry) ──────────────────────────────────────
    const localTraceId = TraceCollector.newTraceId();
    const localRootSpanId = TraceCollector.newSpanId();
    traceCollector.startSpan({
      traceId: localTraceId,
      spanId: localRootSpanId,
      operation: "settlement.pipeline",
      service: "settlement",
      attributes: {
        "job.id": jobId,
        "bundle.id": bundle.id,
        "bundle.assurance_tier": bundle.assuranceTier,
      },
    });

    // Wrap the entire pipeline in a parent Sentry span for waterfall visibility
    try {
      await Sentry.startSpan(
        {
          name: "settlement.pipeline",
          op: "settlement",
          attributes: {
            "job.id": jobId,
            "bundle.id": bundle.id,
            "bundle.assurance_tier": bundle.assuranceTier,
          },
        },
        async () => {
          // ── Step 1: Store evidence bundle to IPFS/Storacha ──────────────
          const ipfsSpanId = TraceCollector.newSpanId();
          traceCollector.startSpan({
            traceId: localTraceId,
            spanId: ipfsSpanId,
            parentSpanId: localRootSpanId,
            operation: "settlement.ipfs_archive",
            service: "storage",
            attributes: { "bundle.id": bundle.id },
          });
          await Sentry.startSpan(
            { name: "settlement.ipfs_archive", op: "storage", attributes: { "bundle.id": bundle.id } },
            async () => {
              try {
                const { createEvidenceStorage } = await import("@pcc/kernel/evidence-storage-factory");
                const storage = await createEvidenceStorage();
                await storage.init();
                const archiveResult = await storage.archiveBundle(bundle);
                result.cid = archiveResult.cid;
                pipelineTelemetry.emit(jobId, "evidence_archive", "completed", {
                  metadata: { cid: result.cid, bundleId: bundle.id },
                });
                traceCollector.endSpan({ traceId: localTraceId, spanId: ipfsSpanId, status: "ok" });
              } catch (err) {
                // Storage is best-effort — log but continue
                console.warn("[settlement] Evidence storage failed (best-effort):", err instanceof Error ? err.message : err);
                pipelineTelemetry.emit(jobId, "evidence_archive", "failed", {
                  metadata: { error: err instanceof Error ? err.message : String(err) },
                });
                traceCollector.endSpan({ traceId: localTraceId, spanId: ipfsSpanId, status: "error" });
              }
            },
          );

          // ── Step 2: Persist bundle + events to DB ───────────────────────
          const dbSpanId = TraceCollector.newSpanId();
          traceCollector.startSpan({
            traceId: localTraceId,
            spanId: dbSpanId,
            parentSpanId: localRootSpanId,
            operation: "settlement.db_persist",
            service: "db",
            attributes: { "job.id": jobId, "event.count": bundle.events.length },
          });
          await Sentry.startSpan(
            { name: "settlement.db_persist", op: "db", attributes: { "job.id": jobId, "event.count": bundle.events.length } },
            async () => {
              try {
                const repos = getRepos();
                const storeDb = getStore().db;

                // N79 round 8 (P3, astra 126i HIGH-1): ONE computed header row and ONE computed set of event
                // rows for THIS call — from the AUTHORITATIVE job (bind-first already confirmed it names this
                // bundle), never the bundle, for the job-bound columns. The SAME two values feed the fresh
                // insert below AND the re-delivery comparison, so they can never drift apart.
                //
                // Narrowed here, not with `?.`: Step 2 only ever runs when bind-first above already returned
                // early otherwise (there is no path from a falsy `authoritativeJob` to this line), but that
                // invariant does not survive TypeScript's closure analysis for a hoisted `let` — an explicit
                // guard, not a blind `!` assertion, keeps `computeEvidenceHeaderRow`'s `job` parameter honestly
                // non-undefined and leaves a clear error if the invariant is ever actually violated.
                if (!authoritativeJob) {
                  throw new Error("processEvidence: authoritativeJob missing in Step 2 after bind-first succeeded");
                }
                const computedHeader = computeEvidenceHeaderRow(bundle, authoritativeJob);
                const computedEvents = computeEvidenceEventRows(bundle);

                // N79 round 6 (H1-A / addendum 1 P3): the header row and all its events are written in ONE
                // transaction, and `bundlePersisted` is set only once it COMMITS. Before this, the header insert
                // and the events insert were two separate writes: a header that landed followed by an events
                // write that threw left `bundlePersisted` true forever (nothing ever reset it), so the job still
                // settled — on-chain submission and auto-release both included — on evidence this call never
                // actually finished persisting (astra 126f H1-A). Re-delivery now must match the header AND the
                // stored events (EVERY column of each) to count as exact: a header whose events are missing or
                // different (a LEGACY partial row, possibly from before this fix existed) is a conflict, not an
                // idempotent retry — healing it silently here would let a call settle on evidence it did not
                // itself commit. Deliberately NOT wrapped in its own try/catch: any throw (the deliberate
                // re-throws below, or anything unanticipated, e.g. a re-read that itself fails) propagates to
                // the SAME outer catch the original two-write version relied on, so it skips `bundlePersisted =
                // true` AND the unconditional status marker below exactly as before — the outer catch's own
                // fallback (`if (!bundlePersisted && !result.error) ...`) still applies.
                let bundleRejectedAsInvalid = false; // N79 round 7 (P3): set only by the up-front reject below —
                // must NOT count as persisted even though the transaction returns without throwing.
                storeDb.transaction(() => {
                  // N79 round 7 (P3, astra 126g HIGH): a FRESH delivery (no pre-existing row under this id) whose
                  // OWN incoming events carry duplicate ids is malformed input, independent of anything stored —
                  // reject it before any write, with its own error code, rather than let it either collide on the
                  // events table's own id constraint (surfacing as a generic persistence failure) or — worse —
                  // succeed and leave a row this same bijective check would never treat as internally consistent.
                  // Checked via a READ (not the insert's PK collision below), since that collision only tells us
                  // whether `bundle.id` pre-exists, not whether `bundle.events` is internally duplicate-free.
                  const incomingEventIds = bundle.events.map((ev) => ev.id);
                  const hasDuplicateIncomingEventIds = new Set(incomingEventIds).size !== incomingEventIds.length;
                  const preExisting = repos.evidence.findById(bundle.id);
                  if (!preExisting && hasDuplicateIncomingEventIds) {
                    result.error = "evidence_bundle_invalid";
                    bundleRejectedAsInvalid = true;
                    console.warn(
                      `[settlement] Evidence bundle ${bundle.id} is a fresh delivery with duplicate event ids in the same payload — refusing before any write.`,
                    );
                    return; // nothing written; the transaction commits as a no-op (bundlePersisted stays false below).
                  }

                  try {
                    repos.evidence.insert(computedHeader);
                    } catch (insertErr) {
                      // A PRE-EXISTING row under this id (from a prior call, possibly a different bundle
                      // entirely). N79 round 8 (P3, astra 126i HIGH-1): exact ONLY when the STORED header
                      // matches the COMPUTED header on EVERY persisted column — enumerated from
                      // `getTableColumns(schema.evidenceBundles)` itself via {@link headerExactMatch}, not a
                      // hand list (round 7's hand list omitted `sessionKeyAuthorization` and `tenantId`
                      // entirely: a re-delivery differing ONLY in the signing key's delegation, or landing under
                      // a different tenant, used to read as identical) — AND the stored + computed events are a
                      // true one-to-one match via {@link eventsExactMatch} over every event column (round 6's
                      // `length + every(...some(...))` is not a bijection: stored [A,B] wrongly accepted
                      // incoming [A,A], since each incoming A independently matched stored A without the
                      // comparison ever consuming it).
                      const existing = repos.evidence.findById(bundle.id);
                      const existingEvents = existing ? repos.evidence.findEventsByBundle(bundle.id) : [];
                      const exactReDelivery =
                        existing !== undefined &&
                        headerExactMatch(existing, computedHeader) &&
                        eventsExactMatch(existingEvents, computedEvents);
                      if (exactReDelivery) {
                        console.warn(`[settlement] Evidence bundle ${bundle.id} already persisted identically — idempotent re-delivery, proceeding.`);
                        return; // nothing to write; the transaction commits as a no-op.
                      }
                      result.error = existing ? "evidence_bundle_conflict" : "evidence_persistence_failed";
                      console.warn(
                        `[settlement] DB persistence failed for bundle ${bundle.id}: ${
                          existing
                            ? `an existing row under this id does not match this bundle (header column, or its events, differ) — refusing to settle on it`
                            : insertErr instanceof Error
                              ? insertErr.message
                              : String(insertErr)
                        }`,
                      );
                      throw insertErr instanceof Error ? insertErr : new Error(String(insertErr)); // roll back: no header row survives an unverified persistence failure.
                    }

                    // The header was freshly inserted by THIS call. Write its events in the SAME transaction.
                    if (computedEvents.length > 0) {
                      try {
                        repos.evidence.insertEvents(computedEvents);
                      } catch (eventsErr) {
                        // This call's OWN attempt failed partway — not a conflict with anything pre-existing (no
                        // such row was found a moment ago). Roll back the header too: partial persistence must
                        // never settle.
                        result.error = "evidence_persistence_failed";
                        console.warn(
                          `[settlement] DB persistence failed for bundle ${bundle.id}: ${
                            eventsErr instanceof Error ? eventsErr.message : String(eventsErr)
                          }`,
                        );
                        throw eventsErr instanceof Error ? eventsErr : new Error(String(eventsErr));
                      }
                    }
                });
                // Reached only if the transaction committed (returned without throwing) AND this call's own
                // up-front validation did not reject it (N79 round 7, P3's `evidence_bundle_invalid` gate).
                bundlePersisted = !bundleRejectedAsInvalid;

                // This generic step marker is unconditional, as it always was: it commits the job to nothing
                // (unlike Step 3's `evidence_submitted` + `evidenceBundleId`, which IS gated on `bundlePersisted`
                // below). Left exactly as every other caller's status reads it today.
                repos.jobs.updateStatus(jobId, "evidence_stored");
                traceCollector.endSpan({ traceId: localTraceId, spanId: dbSpanId, status: bundlePersisted ? "ok" : "error" });
              } catch (err) {
                console.warn("[settlement] DB persistence failed:", err instanceof Error ? err.message : err);
                traceCollector.endSpan({ traceId: localTraceId, spanId: dbSpanId, status: "error" });
                // Non-fatal for the call, but (R5-H1) a bundle row never confirmed above is unverified evidence:
                // `bundlePersisted` stays false, so it is neither submitted on-chain nor pointed at. A failure
                // AFTER the row was confirmed (its events, the step marker) leaves that row valid, as before.
                if (!bundlePersisted && !result.error) result.error = "evidence_persistence_failed";
              }
            },
          );

          // ── Step 3: Submit evidence hash on-chain ───────────────────────
          const onchainSubmitSpanId = TraceCollector.newSpanId();
          traceCollector.startSpan({
            traceId: localTraceId,
            spanId: onchainSubmitSpanId,
            parentSpanId: localRootSpanId,
            operation: "settlement.onchain_submit",
            service: "blockchain",
            attributes: {
              "job.id": jobId,
              "contract.address": contractAddress ?? "none",
              "write.enabled": isWriteEnabled(),
            },
          });
          await Sentry.startSpan(
            {
              name: "settlement.onchain_submit",
              op: "blockchain",
              attributes: {
                "job.id": jobId,
                "contract.address": contractAddress ?? "none",
                "write.enabled": isWriteEnabled(),
              },
            },
            async () => {
              // N79 round 5 (R5-H1, astra 126e Q2 HIGH): `bundlePersisted` gates this whole step. A bundle this
              // call could not confirm as persisted (a genuine DB failure, or a PK collision with DIFFERENT
              // content under the same id) is never submitted on-chain, and the job is never pointed at it —
              // settling on evidence this call did not actually record would be exactly the hole R4-H2 closed for
              // the latest-row fallback, reopened through a different door.
              if (bundlePersisted && isWriteEnabled() && contractAddress && !fabricatedBlocksSettlement) {
                try {
                  const addr = contractAddress as Address;
                  const bundleHashHex = bundle.bundleHash.startsWith("0x")
                    ? (bundle.bundleHash as `0x${string}`)
                    : (`0x${bundle.bundleHash}` as `0x${string}`);

                  // N79 round 7 (P2): a fresh confirmation, right before THIS submit, that the chain milestone at
                  // the derived index still carries the job's own step identity — defence against drift between
                  // bind-first time and now, and the ONLY check for the env-default (no-row) path's derivation,
                  // whose scan already ran but is re-confirmed here on the same footing as the with-row path.
                  const onChainBindingOk = await verifyDerivedMilestoneOnChain(
                    addr,
                    derivedMilestoneIndex,
                    bundle.stepId,
                    derivedMilestoneSelector ?? "refuse", // never actually undefined here — Step 3 only runs once bind-first set one of the two real selectors; "refuse" is the fail-closed default if that invariant were ever violated.
                  );
                  if (!onChainBindingOk) {
                    result.error = "evidence_milestone_unbound";
                    traceCollector.endSpan({ traceId: localTraceId, spanId: onchainSubmitSpanId, status: "error" });
                    return;
                  }

                  const writeResult = await onChainSubmitEvidence(derivedMilestoneIndex, bundleHashHex, addr);
                  result.evidenceTxHash = writeResult.transactionHash;

                  try {
                    const repos = getRepos();
                    // N79 round 4 (R4-H2, astra 126b Q4 HIGH): record the EXACT bundle this call just submitted, in
                    // the SAME write that marks the job evidence_submitted. Resume requires this id (below) and no
                    // longer falls back to "whatever evidence row is latest" — a relay row appended after this call
                    // must never become the hash a resume settles on.
                    // N79 round 5 (R5-H1): defence in depth — re-verify, right before this write, that the row
                    // under `bundle.id` still holds THIS bundle's hash. `bundlePersisted` already gated getting
                    // here; this re-check is the last line against any theoretical change to that row in between.
                    const storedRow = repos.evidence.findById(bundle.id);
                    if (!storedRow || storedRow.bundleHash !== bundle.bundleHash) {
                      bundlePersisted = false;
                      result.error = "evidence_bundle_conflict";
                      console.error(
                        `[settlement] Refusing to point job ${jobId} at bundle ${bundle.id}: the stored row's hash no longer matches what was just submitted on-chain.`,
                      );
                    } else {
                      repos.jobs.update(jobId, { evidenceBundleId: bundle.id, status: "evidence_submitted" });
                    }
                  } catch {
                    // DB update non-fatal
                  }
                  pipelineTelemetry.emit(jobId, "verification_request", "completed", {
                    metadata: { contractAddress, txHash: result.evidenceTxHash },
                  });
                  traceCollector.endSpan({ traceId: localTraceId, spanId: onchainSubmitSpanId, status: "ok" });
                } catch (err) {
                  console.warn("[settlement] On-chain evidence submission failed:", err instanceof Error ? err.message : err);
                  result.error = err instanceof Error ? err.message : "on_chain_submission_failed";
                  traceCollector.endSpan({ traceId: localTraceId, spanId: onchainSubmitSpanId, status: "error" });
                }
              } else {
                traceCollector.endSpan({ traceId: localTraceId, spanId: onchainSubmitSpanId, status: "ok" });
              }
            },
          );

          // ── Step 3b: Story Protocol — register job as derivative IP ─────
          try {
            const repos = getRepos();
            // Find the capability's Story IP registration via the job's capabilityId
            // The job row contains the capabilityId used for this job
            const job = repos.jobs.findById(jobId);
            pipelineTelemetry.emit(jobId, "settlement_claim", "started", {
              metadata: { capabilityId: job?.capabilityId },
            });
            if (job?.capabilityId) {
              const ipReg = repos.story.findIpByCapabilityId(job.capabilityId);
              if (ipReg) {
                const { getStoryIPService } = await import("@pcc/contracts");
                const storyIPService = getStoryIPService();
                const link = await storyIPService.registerJobAsDerivative(ipReg.ipId, {
                  jobId,
                  evidenceBundleHash: bundle.bundleHash,
                  operatorAddress: "0x0000000000000000000000000000000000000000",
                  operatorName: "operator",
                  ipfsCid: result.cid,
                });
                // Persist derivative link to DB
                try {
                  repos.story.insertDerivativeLink({
                    id: `dl_${jobId}_${Date.now()}`,
                    parentIpId: link.parentIpId,
                    childIpId: link.childIpId,
                    licenseTokenId: link.licenseTokenId,
                    jobId: link.jobId,
                    evidenceBundleHash: link.evidenceBundleHash,
                    txHash: link.txHash,
                    linkedAt: link.linkedAt,
                  });
                } catch (dbErr) {
                  console.warn("[settlement] Story derivative DB persist failed (best-effort):", dbErr instanceof Error ? dbErr.message : dbErr);
                }
                pipelineTelemetry.emit(jobId, "settlement_claim", "completed", {
                  metadata: { derivativeIpId: link.childIpId, parentIpId: link.parentIpId },
                });
                auditService.log({
                  eventType: "settlement.story_registered",
                  resourceType: "job",
                  resourceId: jobId,
                  action: "register_derivative",
                  metadata: { derivativeIpId: link.childIpId, parentIpId: link.parentIpId },
                });
              }
            }
          } catch (storyErr) {
            // Story registration is best-effort — evidence storage succeeds regardless
            console.warn("[settlement] Story derivative registration failed (best-effort):", storyErr instanceof Error ? storyErr.message : storyErr);
            pipelineTelemetry.emit(jobId, "settlement_claim", "failed", {
              metadata: { error: storyErr instanceof Error ? storyErr.message : String(storyErr) },
            });
          }

          // ── Step 4: Auto-release for tier 0 ─────────────────────────────
          const onchainReleaseSpanId = TraceCollector.newSpanId();
          traceCollector.startSpan({
            traceId: localTraceId,
            spanId: onchainReleaseSpanId,
            parentSpanId: localRootSpanId,
            operation: "settlement.onchain_release",
            service: "blockchain",
            attributes: {
              "job.id": jobId,
              "auto_release": autoRelease,
              "contract.address": contractAddress ?? "none",
            },
          });
          await Sentry.startSpan(
            {
              name: "settlement.onchain_release",
              op: "blockchain",
              attributes: {
                "job.id": jobId,
                "auto_release": autoRelease,
                "contract.address": contractAddress ?? "none",
              },
            },
            async () => {
              // N79 round 5 (R5-H1): the same gate as the evidence submit above — auto-release pays out against
              // THIS call's evidence, so it must not fire when that evidence was never confirmed persisted either.
              if (bundlePersisted && autoRelease && isWriteEnabled() && contractAddress && attestation && !fabricatedBlocksSettlement) {
                try {
                  // N79 round 7 (P2): the SAME derived index auto-release acts on, re-confirmed on-chain right
                  // before this call — the brief's "before any auto-release" checkpoint, independent of whether
                  // Step 3 already confirmed it (auto-release can, in principle, run without Step 3 having run
                  // its own submit on this exact call if evidence submission is skipped for some other reason).
                  const onChainBindingOk = await verifyDerivedMilestoneOnChain(
                    contractAddress as Address,
                    derivedMilestoneIndex,
                    bundle.stepId,
                    derivedMilestoneSelector ?? "refuse", // same fail-closed default as Step 3's call above.
                  );
                  if (!onChainBindingOk) {
                    traceCollector.endSpan({ traceId: localTraceId, spanId: onchainReleaseSpanId, status: "error" });
                    return;
                  }

                  const releaseResult = await this.releaseMilestone(
                    jobId,
                    derivedMilestoneIndex,
                    attestation,
                    contractAddress,
                  );
                  if (releaseResult.status === "released") {
                    result.releaseTxHash = releaseResult.txHash;
                    result.settled = true;
                    // N79 round 4 (R4-M3, astra 126b Q5 MEDIUM): a confirmed-on-chain release whose DB bookkeeping
                    // failed (F5) sets `recorded: false` / `reconcile: "required"` on the release result. Auto-release
                    // used to check only `status === "released"` and report an unqualified settled success, hiding
                    // that the escrow still needs reconciling. `settled` stays chain truth either way.
                    if (releaseResult.recorded === false) {
                      result.recorded = false;
                      result.reconcile = releaseResult.reconcile;
                    }
                    pipelineTelemetry.emit(jobId, "settlement_complete", "completed", {
                      metadata: {
                        released: true,
                        txHash: result.releaseTxHash,
                        contractAddress,
                        ...(result.recorded === false ? { recorded: false, reconcile: result.reconcile } : {}),
                      },
                    });
                    auditService.log({
                      eventType: "settlement.completed",
                      resourceType: "job",
                      resourceId: jobId,
                      action: "settle",
                      metadata: {
                        cid: result.cid,
                        bundleHash: bundle.bundleHash,
                        txHash: result.releaseTxHash,
                        contractAddress,
                        autoRelease: true,
                        ...(result.recorded === false ? { recorded: false, reconcile: result.reconcile } : {}),
                      },
                    });
                  }
                  traceCollector.endSpan({ traceId: localTraceId, spanId: onchainReleaseSpanId, status: "ok" });
                } catch (err) {
                  console.warn("[settlement] Auto-release failed:", err instanceof Error ? err.message : err);
                  pipelineTelemetry.emit(jobId, "settlement_complete", "failed", {
                    metadata: { error: err instanceof Error ? err.message : String(err) },
                  });
                  traceCollector.endSpan({ traceId: localTraceId, spanId: onchainReleaseSpanId, status: "error" });
                }
              } else {
                traceCollector.endSpan({ traceId: localTraceId, spanId: onchainReleaseSpanId, status: "ok" });
              }
            },
          );
        },
      );
    } catch {
      // Sentry span failure must never break the settlement pipeline
    }

    // End the local root span
    traceCollector.endSpan({
      traceId: localTraceId,
      spanId: localRootSpanId,
      status: result.error ? "error" : "ok",
    });

    return result;
  }

  /**
   * Release a milestone's escrow after the challenge window has closed (or immediately for tier 0).
   *
   * Requires the oracle-signed Attestation struct that was used in
   * submitAttestation. PCCProtocol.collectFeeWithAttestation re-runs
   * IPCCOracle.verifyAttestation on-chain at settlement time, so a bad
   * attestation fails the release even if the challenge window trivially
   * expires. Caller is responsible for retaining the attestation returned
   * by the oracle client between submitAttestation and releaseMilestone.
   */
  async releaseMilestone(
    jobId: string,
    milestoneIndex: number,
    attestation: OracleAttestation,
    contractAddress?: string,
  ): Promise<ReleaseResult> {
    // write_disabled is checked FIRST, unconditionally — it needs no escrow data, and it is the one error the
    // release activity's retry policy does NOT retry (nonRetryableErrorPatterns). Running any resolution before it
    // risks surfacing a DIFFERENT, retryable error (no_contract_address) for a request that can never succeed
    // regardless of how many times it is retried, and burning the activity's retry budget on it.
    if (!isWriteEnabled()) {
      return {
        jobId,
        txHash: "",
        status: "failed",
        error: "write_disabled",
      };
    }

    // N79 round 4 (R4-H1, astra 126b Q1 HIGH); reordered round 5 (R5-M1, astra 126e Q1 MEDIUM): resolve ONE escrow
    // BEFORE checking anything else about it. The target is the caller's contractAddress, else the JOB's own
    // escrow's address, else the rowless configured default. When the job has its own escrow, the target must
    // name THAT exact row: a caller supplying a different escrow's address (or a stale rowless default, for a
    // job whose escrow is a per-job V2 clone) is refused here, before the chain and before any lease. Without
    // this, the service could lease the job's own escrow while releasing, and recording the release against, a
    // completely different one.
    //
    // R5-M1: this resolution + mismatch check now runs BEFORE the given-back check below. It used to run after: an
    // UNRELATED refunded env default, or an explicitly-named refunded escrow that was not even the job's own, was
    // checked for "given back" before the job's actual target was ever resolved — wrongly refusing a job A whose
    // OWN escrow was perfectly fine, with the wrong error (`escrow_refunded` instead of `escrow_mismatch`, or
    // instead of no refusal at all).
    //
    // N79 round 8 (P2, astra 126i MEDIUM-1): the rowless fallback goes through
    // {@link resolveRowlessDefaultTarget} (the SAME resolver `processEvidence`'s allowed target uses), not a
    // direct `ESCROW_CONTRACT_ADDRESS` read — an address alone does not say which ABI answers at it (production
    // sets it to the V2 factory address, docs/V2_DEPLOY.md:183). Before this round, a rowless job's
    // CALLER-SUPPLIED address was never compared against anything (the `if (!contractAddress)` block only
    // FILLS IN a missing address; it is not a comparison), so an unrelated escrow's address, belonging to a
    // completely different job, went through `givenBackEscrow`/`beginSettlement` below and could lease, and
    // call the chain release against, that escrow. A supplied address for a rowless job must now be the
    // configured rowless default. `rowlessTarget` is resolved once; the fill-in and the comparison read it.
    const jobRow = escrowForJob(jobId);
    const rowlessTarget = jobRow ? undefined : resolveRowlessDefaultTarget();
    if (!contractAddress) {
      contractAddress = jobRow?.contractAddress ?? rowlessTarget?.address;
    }
    if (!contractAddress) {
      return {
        jobId,
        txHash: "",
        status: "failed",
        error: "no_contract_address",
      };
    }
    if (jobRow) {
      let targetIsJobsOwnEscrow = false;
      try {
        targetIsJobsOwnEscrow =
          contractAddress === jobRow.contractAddress ||
          (isAddress(contractAddress) &&
            isAddress(jobRow.contractAddress) &&
            getAddress(contractAddress) === getAddress(jobRow.contractAddress));
      } catch {
        targetIsJobsOwnEscrow = false;
      }
      if (!targetIsJobsOwnEscrow) {
        return { jobId, txHash: "", status: "failed", error: "escrow_mismatch" };
      }
    } else {
      // A rowless job: the ONLY allowed target is the configured rowless default — a SUPPLIED address must
      // equal it (string or checksum equality), before `givenBackEscrow`, `beginSettlement`, or any chain call.
      // No configured default (`rowlessTarget` undefined) plus a supplied address is `escrow_mismatch` too —
      // there is nothing a rowless job's target could legitimately equal. (When no address was supplied and
      // the fallback above filled one in from `rowlessTarget?.address`, this trivially passes: the same value
      // compared to itself.)
      let targetIsRowlessDefault = false;
      try {
        targetIsRowlessDefault =
          !!rowlessTarget &&
          (contractAddress === rowlessTarget.address ||
            (isAddress(contractAddress) &&
              isAddress(rowlessTarget.address) &&
              getAddress(contractAddress) === getAddress(rowlessTarget.address)));
      } catch {
        targetIsRowlessDefault = false;
      }
      if (!targetIsRowlessDefault) {
        return { jobId, txHash: "", status: "failed", error: "escrow_mismatch" };
      }
    }

    // N79 (round 5, R5-M1): never release an escrow the gateway has given back, and never report its job settled.
    // Checked against ONLY the resolved row above — the job's own escrow when it has one (by `jobId`, the same
    // lookup `jobRow` already used), or the address-resolved row when it does not (by `contractAddress`) — never
    // both independently, which is what let an unrelated given-back row (the env default, or an explicitly-named
    // mismatched escrow) wrongly refuse a release of a perfectly fine, already-validated target.
    if (givenBackEscrow(jobRow ? { jobId } : { contractAddress })) {
      return { jobId, txHash: "", status: "failed", error: "escrow_refunded" };
    }

    // N79: this release owns the resolved escrow from here, synchronously after the checks above and before any await (a
    // lease: no refund lands while the chain call is out, and no second settlement acts on the escrow meanwhile; astra
    // rounds 2 and 3). Claimed by ITS OWN id when the job has an escrow — never by address alone, which is what let a
    // release lease one row and act on another — otherwise by the resolved address. An escrow another settlement
    // holds, or one that is not releasable, is refused before the chain is touched.
    const begun = jobRow ? beginSettlement({ escrowId: jobRow.id }) : beginSettlement({ contractAddress });
    if (begun.disposition === "busy") {
      return { jobId, txHash: "", status: "failed", error: "settlement_in_progress" };
    }
    if (begun.disposition === "blocked") {
      return { jobId, txHash: "", status: "failed", error: `escrow_not_releasable:${begun.escrowStatus}` };
    }
    const claim = "claim" in begun ? begun.claim : undefined;
    let released = false;
    let recordFailed = false;

    try {
      const writeResult = await onChainReleaseMilestone(
        milestoneIndex,
        attestation,
        contractAddress as Address,
      );
      released = true;

      if (claim) {
        // N79 round 6 (H2-A(b) / addendum 1 P4): read the chain mapping right after this write, through the
        // SAME ABI that performed the release (V1), and record through recordChainSettlement ONLY — never the
        // old index-only writer, which could complete the escrow from local rows alone with no idea how many
        // milestones the chain actually has (astra 126f: one local row, chain has two — the old writer
        // completed the escrow anyway). A failed read is treated exactly like a failed write: the release
        // already landed on-chain, so it is never reported as failed and the claim is never handed back (no
        // refund can land on funds that moved) — the caller is told it was not recorded (F5).
        try {
          const chainState = await getEscrowStateV1(contractAddress as Address);
          // N79 round 8 (P4, astra 126i MEDIUM-2): abiVersion "v1" -- the reader two lines up is getEscrowStateV1.
          const outcome = recordChainSettlement(claim, {
            stepIds: chainState.milestones.map((m) => m.stepId as Hex),
            statuses: chainState.milestones.map((m) => m.status),
            abiVersion: "v1",
          });
          if (!outcome.ok) {
            recordFailed = true;
            console.error("[escrow] settlement_record_failed", {
              escrowId: claim.escrowId,
              milestoneIndex,
              txHash: writeResult.transactionHash,
              error: outcome.drifted ? "chain_mapping_drift" : "milestone_row_write_failed",
            });
          }
        } catch (recordErr) {
          recordFailed = true;
          console.error("[escrow] settlement_record_failed", {
            escrowId: claim.escrowId,
            milestoneIndex,
            txHash: writeResult.transactionHash,
            error: recordErr instanceof Error ? recordErr.message : String(recordErr),
          });
        }
      }

      try {
        const repos = getRepos();
        repos.jobs.updateStatus(jobId, "settled");
      } catch {
        // DB update non-fatal
      }

      // ── Best-effort: Story Protocol royalty payment ─────────────────
      try {
        const repos = getRepos();
        // Find derivative links for this job to get the IP ID
        const derivLinks = repos.story.findDerivativeLinksByJob(jobId);
        if (derivLinks.length > 0) {
          const childIpId = derivLinks[0].childIpId;
          const royaltyPercent = Number(process.env.STORY_ROYALTY_PERCENT ?? "5");

          // Estimate job value from milestone index (use a placeholder amount for mock)
          // In production this would come from the escrow contract's milestone amount
          const milestoneAmountStr = process.env.STORY_MILESTONE_AMOUNT ?? "1000000"; // 1 USDC in atomic units
          const royaltyAmount = String(
            Math.floor(Number(milestoneAmountStr) * royaltyPercent / 100),
          );

          const { getStoryIPService } = await import("@pcc/contracts");
          const storyIPService = getStoryIPService();
          await storyIPService.payJobRoyalty(childIpId, royaltyAmount, contractAddress as string);
          console.log(`[settlement] Story royalty paid: ipId=${childIpId} amount=${royaltyAmount} (${royaltyPercent}% of milestone)`);
        }
      } catch (storyErr) {
        // Royalty payment is best-effort — escrow release succeeds regardless
        console.warn("[settlement] Story royalty payment failed (best-effort):", storyErr instanceof Error ? storyErr.message : storyErr);
      }

      return {
        jobId,
        txHash: writeResult.transactionHash,
        status: "released",
        ...(recordFailed ? { recorded: false as const, reconcile: "required" as const } : {}),
      };
    } catch (err) {
      return {
        jobId,
        txHash: "",
        status: "failed",
        error: err instanceof Error ? err.message : "release_failed",
      };
    } finally {
      // Nothing was released: hand the escrow back, and give it to the payer if the job ended meanwhile. The lease
      // always ends with the call.
      if (claim && !released) {
        try {
          releaseEscrowFromSettlement(claim, claim.jobId);
        } catch {
          // best-effort
        }
      }
      endSettlement(claim);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _settlementService: SettlementService | null = null;

export function getSettlementService(): SettlementService {
  if (!_settlementService) {
    _settlementService = new SettlementService();
  }
  return _settlementService;
}

export function resetSettlementService(): void {
  _settlementService = null;
}
