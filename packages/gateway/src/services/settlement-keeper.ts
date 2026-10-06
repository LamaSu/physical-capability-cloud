/**
 * Settlement keeper — the permissionless background crank that closes the
 * currently un-owned challenge-window release (Settlement pivot, Step 2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * MilestoneEscrowV2.release() is PERMISSIONLESS and gated only on
 * `block.timestamp >= challengeWindowEnd`. In the happy path /complete (or a
 * later resume-settlement) calls it once the window closes. But if the completing
 * agent goes away between attestation and window-close — a crash, a shut-down
 * pipeline, an agent that never polls again — the milestone sits Attested past
 * its window with the money escrowed and NOBODY calling release. Those funds are
 * trapped: everything needed to release is on-chain, but no owner triggers it.
 *
 * The keeper owns that release. It periodically finds Attested-past-window
 * milestones and drives them through the EXISTING settlement crank
 * (`driveSettlement`, Step 1) — it does NOT reimplement the on-chain logic. The
 * crank already: (a) maps the contract's dedup reverts to already-done so
 * re-driving never double-releases, and (b) upholds the F1/F2/F3 invariant —
 * `settled=true` ONLY from a landed release receipt or a read-confirmed Released,
 * never from a status-agnostic revert. So the keeper can trust the crank's
 * verdict and simply route candidates to it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE KEEPER IS — AND IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * The keeper is STRICTLY a release-leg closer. It hands the crank NO evidence
 * hash and NO EAS UID, and passes `skipFund: true`, so it can only ever advance a
 * milestone that is already Attested → Released. Milestones below Attested
 * (Unfunded/Funded/Locked/Evidenced) are NOT the keeper's job — funding pulls the
 * payer's USDC and evidence/attestation come from the oracle pipeline
 * (/complete). The keeper leaves those untouched.
 *
 * Terminal-other states (Disputed / Refunded / Slashed) are SURFACED, never
 * treated as a release: a milestone whose money is frozen or refunded must not be
 * reported settled. The crank enforces this too (a dispute landing between the
 * keeper's pre-read and the drive is caught by the crank's confirming read), so
 * terminal_other is defended at both layers.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCOPE (Step 2) — decisions flagged for the operator
 * ─────────────────────────────────────────────────────────────────────────────
 *  - V2 ONLY. `driveSettlement` reads/writes through the V2 ABI; V3 escrows settle
 *    through the oracle-attested Mode-B path (submitEvidenceV3 → … → releaseV3),
 *    which has no crank yet. The keeper skips `version === "v3"` rows (counted, not
 *    driven). A V3 keeper is a separate follow-up.
 *  - DB reconciliation is CONSERVATIVE. The keeper's primary job is the on-chain
 *    release (the money move). It reconciles ONLY the escrow row (and its milestone
 *    rows), and ONLY to "completed"/"released", and ONLY when every on-chain
 *    milestone is Released — a monotonic, chain-confirmed transition. It does NOT
 *    touch the jobs table; job status reconciliation stays with the existing
 *    /complete + resume-settlement paths and the future Step-3 event-sourced
 *    projection (which owns the read model).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OWNERSHIP (N79 round 3, astra F1; round 4, R4-M1)
 * ─────────────────────────────────────────────────────────────────────────────
 * A release is a money move, and a job's failure can give the same escrow back
 * (N79). So the keeper OWNS an escrow while it drives it: right before the escrow's
 * FIRST awaited call of any kind — the authoritative chain read itself, not only the
 * drive that follows it (N79 round 4, R4-M1: the read used to run unowned, so a
 * refund could land while it was in flight and see no lease, even when that read was
 * about to return a milestone already settled on-chain) — it takes the settlement
 * lease (`beginSettlement`, leaseOnly: its DB row can lag the chain, so a row that is
 * neither funded nor completing still takes the lease). It holds the lease across
 * that escrow's read, its remaining milestones, and
 * then either records the completion under it or hands the escrow back. A refund
 * attempted meanwhile is skipped as settlement_in_progress; an escrow another
 * operation holds is skipped here (`skippedBusy`), and one given back or completed
 * is skipped (`skippedTerminal`). A milestone the chain shows Released (a drive that
 * settled, or one already Released at the pre-read) has its own row marked
 * `released` at once, so a partly paid escrow's rows tell the truth even when the
 * escrow is handed back, and a later refund stops at milestone_past_funding. The
 * sweep takes `repos` by injection, but the ownership module works on the gateway's
 * global store; production passes getRepos(), so they are the same store.
 */

import type { Address, Hex } from "viem";
import type { IRepositories } from "@pcc/store";
import { ESCROW_REFUND_STATUS } from "@pcc/spec";
import {
  getEscrowStateV2,
  isWriteEnabled,
  MilestoneStatusV2,
  milestoneStatusV2Name,
  type OnChainMilestoneV2,
} from "../contracts/escrow-client.js";
import { driveSettlement, type DriveOutcome } from "./settlement-crank.js";
import {
  beginSettlement,
  checkChainMapping,
  endSettlement,
  recordChainSettlement,
  releaseEscrowFromSettlement,
  type SettlementClaim,
} from "./escrow-refund.js";

// ── Interval bounds (mirror kernel-ttl-sweeper's guard band) ────────────────
const KEEPER_INTERVAL_LOWER_BOUND_SEC = 60; // 1 min — guard against thrash
const KEEPER_INTERVAL_UPPER_BOUND_SEC = 3600; // 1 h — guard against staleness
const KEEPER_INTERVAL_DEFAULT_SEC = 300; // 5 min — challenge windows are ≥1h, so this is plenty responsive

/**
 * Escrow DB statuses that are unambiguously done-forever — nothing left to
 * release. Every OTHER status is a candidate: the on-chain read is authoritative,
 * and the crank safely no-ops any non-releasable milestone, so we prefer to check
 * a few extra escrows (a cheap read) over skipping a possibly-trapped one because
 * its DB status lags the chain. This is the money-liveness-over-read-cost call.
 */
// N79: "refund_pending" too. A chain escrow whose job failed or was cancelled has its refund decided; releasing it
// would pay out an escrow the platform has already given back.
const TERMINAL_ESCROW_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  ESCROW_REFUND_STATUS.DONE,
  ESCROW_REFUND_STATUS.PENDING,
]);

export interface KeeperLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/** Per-milestone disposition within one sweep (audit trail + test assertions). */
export interface KeeperMilestoneResult {
  escrowId: string;
  escrowAddress: string;
  /** -1 (R4-M1) when ownership was decided for the whole escrow, before any chain read — no milestone exists yet. */
  milestoneIdx: number;
  /** on-chain status name the keeper acted on (pre-drive read), or "unread" (R4-M1) when ownership was decided
   *  before the read ever ran. */
  statusBefore: ReturnType<typeof milestoneStatusV2Name> | "unread";
  /**
   * - `released`        — the crank released it (settled=true, chain-confirmed).
   * - `pending_window`  — Attested but the challenge window has not closed yet.
   * - `terminal_other`  — Disputed / Refunded / Slashed; surfaced, NOT released.
   * - `not_ready`       — below Attested (fund/evidence/attest owed elsewhere).
   * - `already_released`— already Released on the pre-read (no work).
   * - `awaiting`        — handed to the crank but it deferred (chain clock behind).
   * - `blocked`         — the crank could not advance (wrong signer / timeout / revert).
   * - `busy`            — another operation holds the escrow's settlement lease; the escrow is skipped this pass.
   */
  disposition:
    | "released"
    | "pending_window"
    | "terminal_other"
    | "not_ready"
    | "already_released"
    | "awaiting"
    | "blocked"
    | "busy";
  /** the crank's raw outcome, when the milestone was handed to it. */
  driveOutcome?: DriveOutcome;
  reason?: string;
}

export interface KeeperSweepResult {
  scannedEscrows: number;
  /** escrows skipped because version !== "v2" (V3 has no crank). */
  skippedV3: number;
  /** escrows skipped because their DB status is terminal (completed/refunded), or turned so once the sweep reached them. */
  skippedTerminal: number;
  /** escrows skipped because another operation (/complete, a release, a resume) holds their settlement lease. */
  skippedBusy: number;
  /** escrows whose on-chain read threw (soft-failed; sweep continued). */
  readErrors: number;
  released: number;
  terminalOther: number;
  blocked: number;
  /** escrows reconciled to DB status "completed" (all milestones Released). */
  reconciledCompleted: number;
  /** N79 round 6 (H2-B / addendum 1 P4): escrows whose chain/local mapping drifted (cardinality or identity) on
   *  this pass's authoritative read, BEFORE any drive — quarantined in `completing`, never driven, never
   *  reconciled, never handed back. Logged as `[escrow] settlement_mapping_mismatch`. */
  mappingMismatch: number;
  /** true when the sweep did no work because writes are disabled (no signer). */
  writeDisabled: boolean;
  milestones: KeeperMilestoneResult[];
}

export interface KeeperSweepOptions {
  logger?: KeeperLogger;
  /**
   * Unix seconds used as "now" for the challenge-window gate. Defaults to
   * wall-clock. The contract's `block.timestamp >= challengeWindowEnd` is the real
   * gate; an optimistic wall-clock that runs slightly ahead only risks a release
   * attempt the contract reverts ("Challenge window open") which the crank maps to
   * awaiting — always safe. Injectable so a deterministic (e.g. fork) test can pin it.
   */
  nowSeconds?: number;
}

function isTerminalOtherStatus(status: number): boolean {
  return (
    status === MilestoneStatusV2.Disputed ||
    status === MilestoneStatusV2.Refunded ||
    status === MilestoneStatusV2.Slashed
  );
}

/**
 * Run ONE keeper pass. Pure function of (repos, options) so tests exercise it
 * without a timer. Enumerates candidate escrows, hands every Attested-past-window
 * milestone to the settlement crank, surfaces terminal-other, and reconciles a
 * fully-released escrow's DB row to "completed".
 *
 * Never throws for a single bad escrow — one unreadable escrow (bad address, RPC
 * blip) is logged and skipped so it can't wedge the whole sweep. The crank owns
 * every money-safety decision; the keeper only decides WHICH milestones to route.
 */
export async function runKeeperSweep(
  repos: IRepositories,
  options: KeeperSweepOptions = {},
): Promise<KeeperSweepResult> {
  const logger = options.logger;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  const result: KeeperSweepResult = {
    scannedEscrows: 0,
    skippedV3: 0,
    skippedTerminal: 0,
    skippedBusy: 0,
    readErrors: 0,
    released: 0,
    terminalOther: 0,
    blocked: 0,
    reconciledCompleted: 0,
    mappingMismatch: 0,
    writeDisabled: false,
    milestones: [],
  };

  // Without a signer the keeper cannot call release — do no reads, report cleanly.
  if (!isWriteEnabled()) {
    result.writeDisabled = true;
    return result;
  }

  const escrows = repos.escrows.findAll();

  for (const escrow of escrows) {
    // V2-only: the crank reads/writes through the V2 ABI. Default (null) is v2.
    if ((escrow.version ?? "v2") !== "v2") {
      result.skippedV3 += 1;
      continue;
    }
    if (TERMINAL_ESCROW_STATUSES.has(escrow.status)) {
      result.skippedTerminal += 1;
      continue;
    }

    const address = escrow.contractAddress as Address;
    // Guard: a mock / non-hex address is not a live escrow — skip (never a release target).
    if (!address || !address.startsWith("0x") || address.length !== 42) {
      continue;
    }

    result.scannedEscrows += 1;

    // N79 round 4 (R4-M1, astra 126b Q2 MEDIUM): own the escrow BEFORE the first awaited chain read, not only before
    // the first drive. Taking the claim lazily (inside the milestone loop, after the read) left the read itself
    // unprotected: a refund could land while the read was in flight and see no lease at all, even when that read
    // was about to return a milestone already settled on-chain. The claim is taken HERE — synchronously, with no
    // await between the scan above and this call — and is held through the read, every drive, and the reconcile in
    // the `finally` below, exactly as it was held from the first drive onward before.
    /**
     * Take ownership of this escrow. Returns the claim, or undefined after counting (and recording) why this
     * escrow is skipped: another operation holds it (`skippedBusy`), it was given back or completed since the
     * sweep began (`skippedTerminal`), or the claim itself failed (`blocked`, logged).
     */
    const takeOwnership = (record?: (over: Partial<KeeperMilestoneResult>) => void): SettlementClaim | undefined => {
      try {
        const begun = beginSettlement({ escrowId: escrow.id }, { leaseOnly: true });
        if ("claim" in begun) return begun.claim;
        if (begun.disposition === "busy") {
          result.skippedBusy += 1;
          record?.({ disposition: "busy", reason: "another operation holds the escrow's settlement lease" });
        } else {
          result.skippedTerminal += 1;
          record?.({
            disposition: "terminal_other",
            reason: `escrow ${"escrowStatus" in begun ? begun.escrowStatus : "missing"} since the sweep began`,
          });
        }
      } catch (err) {
        // Like any other single-escrow failure: logged and counted, never fatal to the sweep.
        const reason = err instanceof Error ? err.message : String(err);
        result.blocked += 1;
        record?.({ disposition: "blocked", reason });
        logger?.warn?.(`[settlement-keeper] could not take ownership of ${escrow.id}: ${reason}`);
      }
      return undefined;
    };

    // Before any milestone is known (no chain read has happened yet), a skip is reported at the ESCROW level:
    // there is no milestone index or pre-drive status to attach it to.
    const recordEscrowLevelSkip = (over: Partial<KeeperMilestoneResult>): void => {
      result.milestones.push({
        escrowId: escrow.id,
        escrowAddress: address,
        milestoneIdx: -1,
        statusBefore: "unread",
        disposition: "not_ready",
        ...over,
      });
    };

    const claim = takeOwnership(recordEscrowLevelSkip);
    if (!claim) continue; // busy, given-back-or-completed, or claim construction failed — already counted above

    // N79 round 6 (H2-B / addendum 1 P4): set when this pass's authoritative chain read disagrees with the local
    // rows in cardinality or identity — independent of status, so a drift where every milestone is still below
    // Released (invisible before this round: nothing used to check until a row was about to be WRITTEN) is
    // caught too. Quarantines the escrow in `completing`: no drive, no record, no hand-back.
    let mappingDrifted = false;
    // Whether this pass's chain READ itself succeeded. A read failure is the pre-existing, unrelated case (one
    // unreadable escrow must not abort the sweep): the escrow is handed back exactly as before, since this pass
    // learned nothing about it.
    let readSucceeded = false;
    // N79 round 4 (R4-H3, astra 126c HIGH), generalized: set when `recordChainSettlement` reports a row-write
    // failure. Money that already moved on-chain must never be reopened to a refund because its bookkeeping
    // lagged — the `finally` below leaves the escrow durably as the claim found it (still `completing`).
    let recordFailed = false;

    try {
      // ── One authoritative on-chain read: the escrow's full milestone set. Protected by the claim taken above: a
      // refund attempted while this read is in flight sees the escrow already `completing`/leased and is skipped
      // (`settlement_in_progress`), not landed, instead of racing it. A read that throws is soft-failed (one
      // unreadable escrow must not abort the sweep) — handled in the `finally` below exactly as before. ──
      let onChain: Awaited<ReturnType<typeof getEscrowStateV2>> | undefined;
      try {
        onChain = await getEscrowStateV2(address);
      } catch (err) {
        result.readErrors += 1;
        logger?.warn?.(
          `[settlement-keeper] read failed for ${escrow.id} (${address}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      if (onChain) {
        readSucceeded = true;

        // P4: the full ordered identity + cardinality compare runs IMMEDIATELY after the read, BEFORE any drive
        // and BEFORE any write — not only when a row is about to be marked released (round 5's rule; H2-B's
        // finding is that it leaves a below-Released drift invisible, since nothing below Released ever reaches
        // a record call at all).
        // `checkChainMapping` reads the local rows itself (the GLOBAL store, like every write path in
        // escrow-refund.ts) — NOT the `repos` parameter this sweep is injected with (that parameter is used
        // only for the top-level `findAll()` enumeration above; see the module header on why the two are the
        // same store in production). A test that fakes the whole ownership module (settlement-keeper.test.ts)
        // fakes this ONE function too, so it never needs real repos access either.
        const mapping = checkChainMapping(escrow.id, {
          stepIds: onChain.milestones.map((cm) => cm.stepId as Hex), // OnChainMilestone types stepId as a plain string; at runtime it is always 0x-hex.
          statuses: onChain.milestones.map((cm) => cm.status),
        });
        if (!mapping.ok) {
          mappingDrifted = true;
          result.mappingMismatch += 1;
          console.error("[escrow] settlement_mapping_mismatch", {
            escrowId: escrow.id,
            chainCount: mapping.chainCount,
            localCount: mapping.localCount,
            firstMismatch: mapping.firstMismatch,
          });
          result.milestones.push({
            escrowId: escrow.id,
            escrowAddress: address,
            milestoneIdx: -1,
            statusBefore: "unread",
            disposition: "blocked",
            reason: "settlement_mapping_mismatch",
          });
        } else {
          // This pass's post-drive status per index — Released where a drive below settles it or the pre-read
          // already showed it, unchanged otherwise — so the single end-of-pass `recordChainSettlement` call
          // sees this pass's TRUE result, not the stale pre-read snapshot.
          const postPassStatuses: number[] = onChain.milestones.map((cm) => cm.status);

          for (let idx = 0; idx < onChain.milestones.length; idx++) {
            const m: OnChainMilestoneV2 = onChain.milestones[idx];
            const statusBefore = milestoneStatusV2Name(m.status);
            const record = (over: Partial<KeeperMilestoneResult>): void => {
              result.milestones.push({
                escrowId: escrow.id,
                escrowAddress: address,
                milestoneIdx: idx,
                statusBefore,
                disposition: "not_ready",
                ...over,
              });
            };

            if (m.status === MilestoneStatusV2.Released) {
              record({ disposition: "already_released" });
              continue;
            }
            if (isTerminalOtherStatus(m.status)) {
              // Money frozen/refunded — surface, never drive toward release.
              result.terminalOther += 1;
              record({ disposition: "terminal_other", reason: statusBefore.toLowerCase() });
              continue;
            }
            if (m.status !== MilestoneStatusV2.Attested) {
              // Below Attested — fund/evidence/attest are owed to /complete, not the keeper.
              record({ disposition: "not_ready" });
              continue;
            }
            // Attested. Pre-check the window from the read we already hold, so we don't
            // spend a crank call on a milestone whose window is plainly still open. The
            // crank re-checks against the chain and is the authority for the rest.
            if (nowSeconds < m.challengeWindowEnd) {
              record({ disposition: "pending_window" });
              continue;
            }

            // ── Hand the release to the crank. The claim taken above (R4-M1) already covers this await — no new
            //    ownership step needed here. skipFund + no evidence/uid keeps the keeper a pure release-leg closer;
            //    the crank owns every safety check. ──
            try {
              const drive = await driveSettlement(address, idx, { skipFund: true, nowSeconds });
              if (drive.settled) {
                result.released += 1;
                postPassStatuses[idx] = MilestoneStatusV2.Released;
                record({ disposition: "released", driveOutcome: drive.outcome });
              } else if (drive.outcome === "terminal_other") {
                // A dispute/slash landed between our read and the drive — the crank's
                // confirming read caught it. Surface, do not count as released.
                result.terminalOther += 1;
                record({ disposition: "terminal_other", driveOutcome: drive.outcome, reason: drive.reason });
              } else if (drive.outcome === "awaiting_challenge_window") {
                // Chain clock is behind our off-chain gate; heals on a later sweep.
                record({ disposition: "awaiting", driveOutcome: drive.outcome });
              } else {
                // blocked / advanced / needs_input — not settled this pass.
                result.blocked += 1;
                record({ disposition: "blocked", driveOutcome: drive.outcome, reason: drive.reason });
              }
            } catch (err) {
              // An UNEXPECTED crank error (RPC down, unmapped revert). The crank does not
              // swallow real errors; the keeper does not either — but one milestone's
              // failure must not abort the sweep. Log, mark blocked, move on. The next
              // sweep re-reads fresh state and retries.
              result.blocked += 1;
              record({
                disposition: "blocked",
                reason: err instanceof Error ? err.message : String(err),
              });
              logger?.warn?.(
                `[settlement-keeper] drive failed for ${escrow.id}#${idx}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }

          // P1: the ONE guarded writer, chain-required. `postPassStatuses` already carries this pass's TRUE
          // result; identity + cardinality were already confirmed above.
          // N79 round 8 (P4, astra 126i MEDIUM-2): abiVersion "v2" -- `onChain` above is getEscrowStateV2.
          const outcome = recordChainSettlement(claim, {
            stepIds: onChain.milestones.map((cm) => cm.stepId as Hex),
            statuses: postPassStatuses,
            abiVersion: "v2",
          });
          if (!outcome.ok) {
            recordFailed = true;
          } else if (outcome.completed) {
            result.reconciledCompleted += 1;
          }
        }
      }
    } finally {
      if (!readSucceeded) {
        // The read itself failed (or the escrow was skipped before one ran) — this pass learned nothing. Hand
        // the escrow back exactly as before (the safe default for "nothing to do this pass").
        try {
          releaseEscrowFromSettlement(claim, claim.jobId);
        } catch (err) {
          // Reconciliation is best-effort — logged, not fatal.
          logger?.warn?.(
            `[settlement-keeper] DB reconcile failed for ${escrow.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        } finally {
          endSettlement(claim);
        }
      } else if (mappingDrifted || recordFailed) {
        // Quarantine (P4 / R4-H3 generalized): never hand back, never reconcile — `checkChainMapping` or
        // `recordChainSettlement` already logged why. Only the lease ends, so the next claim adopts the
        // still-`completing` row and recounts from chain truth.
        endSettlement(claim);
      } else {
        // `recordChainSettlement` already completed the escrow, or handed it back (with its own refund check),
        // inside its own transaction. Only the lease ends here.
        endSettlement(claim);
      }
    }
  }

  return result;
}

export function resolveKeeperIntervalSec(): number {
  const raw = process.env.SETTLEMENT_KEEPER_INTERVAL_SEC;
  if (!raw) return KEEPER_INTERVAL_DEFAULT_SEC;
  const parsed = parseInt(raw, 10);
  if (
    !Number.isFinite(parsed) ||
    parsed < KEEPER_INTERVAL_LOWER_BOUND_SEC ||
    parsed > KEEPER_INTERVAL_UPPER_BOUND_SEC
  ) {
    console.warn(
      `[settlement-keeper] SETTLEMENT_KEEPER_INTERVAL_SEC="${raw}" out of band ` +
        `[${KEEPER_INTERVAL_LOWER_BOUND_SEC},${KEEPER_INTERVAL_UPPER_BOUND_SEC}]; using ${KEEPER_INTERVAL_DEFAULT_SEC}`,
    );
    return KEEPER_INTERVAL_DEFAULT_SEC;
  }
  return parsed;
}

let _timer: NodeJS.Timeout | undefined;

export interface KeeperHandle {
  stop(): void;
  intervalSec: number;
}

/**
 * Start the settlement keeper interval. OPT-IN and idempotent.
 *
 * No-op unless ALL of:
 *   - SETTLEMENT_KEEPER_ENABLED === "true"  (opt-in — off by default), AND
 *   - NODE_ENV !== "test"                    (tests drive runKeeperSweep directly), AND
 *   - isWriteEnabled()                       (a signer is configured — else it can't release).
 *
 * The timer is unref'd so it never keeps the process alive on its own. Returns a
 * handle even when disabled (stop() is then a no-op) so callers have a uniform shape.
 */
export function startSettlementKeeper(reposProvider: () => IRepositories, logger?: KeeperLogger): KeeperHandle {
  const intervalSec = resolveKeeperIntervalSec();
  const noop: KeeperHandle = { stop: () => {}, intervalSec };

  if (_timer) {
    const existing = _timer;
    return {
      stop: () => {
        clearInterval(existing);
        if (_timer === existing) _timer = undefined;
      },
      intervalSec,
    };
  }
  if (process.env.SETTLEMENT_KEEPER_ENABLED !== "true") return noop;
  if (process.env.NODE_ENV === "test") return noop;
  if (!isWriteEnabled()) {
    logger?.warn?.("[settlement-keeper] not started — write disabled (no signer configured)");
    return noop;
  }

  const log = logger ?? {
    info: (m: string) => console.log(`[settlement-keeper] ${m}`),
    warn: (m: string) => console.warn(`[settlement-keeper] ${m}`),
  };

  const timer = setInterval(() => {
    void runKeeperSweep(reposProvider(), { logger: log }).then(
      (r) => {
        if (r.released > 0 || r.terminalOther > 0 || r.blocked > 0 || r.reconciledCompleted > 0) {
          log.info(
            `swept ${r.scannedEscrows} escrows: released=${r.released} terminalOther=${r.terminalOther} ` +
              `blocked=${r.blocked} reconciled=${r.reconciledCompleted} (skipV3=${r.skippedV3} readErr=${r.readErrors} busy=${r.skippedBusy})`,
          );
        }
      },
      (err) => {
        log.warn(`sweep error: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
  }, intervalSec * 1000);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  _timer = timer;
  log.info(`started (every ${intervalSec}s)`);

  return {
    stop: () => {
      clearInterval(timer);
      if (_timer === timer) _timer = undefined;
    },
    intervalSec,
  };
}

/** Stop the keeper interval. Idempotent. */
export function stopSettlementKeeper(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = undefined;
  }
}
