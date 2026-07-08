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
 *    release (the money move). It reconciles ONLY the escrow row, and ONLY to
 *    "completed", and ONLY when every on-chain milestone is Released — a monotonic,
 *    chain-confirmed transition. It does NOT touch the jobs table; job status
 *    reconciliation stays with the existing /complete + resume-settlement paths and
 *    the future Step-3 event-sourced projection (which owns the read model).
 */

import type { Address } from "viem";
import type { IRepositories } from "@pcc/store";
import {
  getEscrowStateV2,
  isWriteEnabled,
  MilestoneStatusV2,
  milestoneStatusV2Name,
  type OnChainMilestoneV2,
} from "../contracts/escrow-client.js";
import { driveSettlement, type DriveOutcome } from "./settlement-crank.js";

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
const TERMINAL_ESCROW_STATUSES = new Set(["completed", "refunded"]);

export interface KeeperLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/** Per-milestone disposition within one sweep (audit trail + test assertions). */
export interface KeeperMilestoneResult {
  escrowId: string;
  escrowAddress: string;
  milestoneIdx: number;
  /** on-chain status name the keeper acted on (pre-drive read). */
  statusBefore: ReturnType<typeof milestoneStatusV2Name>;
  /**
   * - `released`        — the crank released it (settled=true, chain-confirmed).
   * - `pending_window`  — Attested but the challenge window has not closed yet.
   * - `terminal_other`  — Disputed / Refunded / Slashed; surfaced, NOT released.
   * - `not_ready`       — below Attested (fund/evidence/attest owed elsewhere).
   * - `already_released`— already Released on the pre-read (no work).
   * - `awaiting`        — handed to the crank but it deferred (chain clock behind).
   * - `blocked`         — the crank could not advance (wrong signer / timeout / revert).
   */
  disposition:
    | "released"
    | "pending_window"
    | "terminal_other"
    | "not_ready"
    | "already_released"
    | "awaiting"
    | "blocked";
  /** the crank's raw outcome, when the milestone was handed to it. */
  driveOutcome?: DriveOutcome;
  reason?: string;
}

export interface KeeperSweepResult {
  scannedEscrows: number;
  /** escrows skipped because version !== "v2" (V3 has no crank). */
  skippedV3: number;
  /** escrows skipped because their DB status is terminal (completed/refunded). */
  skippedTerminal: number;
  /** escrows whose on-chain read threw (soft-failed; sweep continued). */
  readErrors: number;
  released: number;
  terminalOther: number;
  blocked: number;
  /** escrows reconciled to DB status "completed" (all milestones Released). */
  reconciledCompleted: number;
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
    readErrors: 0,
    released: 0,
    terminalOther: 0,
    blocked: 0,
    reconciledCompleted: 0,
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

    // ── One authoritative on-chain read: the escrow's full milestone set ──
    let onChain: Awaited<ReturnType<typeof getEscrowStateV2>>;
    try {
      onChain = await getEscrowStateV2(address);
    } catch (err) {
      // Soft-fail: one unreadable escrow must not abort the sweep.
      result.readErrors += 1;
      logger?.warn?.(
        `[settlement-keeper] read failed for ${escrow.id} (${address}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    // Track whether EVERY milestone ends this pass Released (gates DB reconcile).
    let allReleased = onChain.milestones.length > 0;

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
        allReleased = false;
        result.terminalOther += 1;
        record({ disposition: "terminal_other", reason: statusBefore.toLowerCase() });
        continue;
      }
      if (m.status !== MilestoneStatusV2.Attested) {
        // Below Attested — fund/evidence/attest are owed to /complete, not the keeper.
        allReleased = false;
        record({ disposition: "not_ready" });
        continue;
      }
      // Attested. Pre-check the window from the read we already hold, so we don't
      // spend a crank call on a milestone whose window is plainly still open. The
      // crank re-checks against the chain and is the authority for the rest.
      if (nowSeconds < m.challengeWindowEnd) {
        allReleased = false;
        record({ disposition: "pending_window" });
        continue;
      }

      // ── Hand the release to the crank. skipFund + no evidence/uid keeps the
      //    keeper a pure release-leg closer; the crank owns every safety check. ──
      try {
        const drive = await driveSettlement(address, idx, { skipFund: true, nowSeconds });
        if (drive.settled) {
          result.released += 1;
          record({ disposition: "released", driveOutcome: drive.outcome });
        } else if (drive.outcome === "terminal_other") {
          // A dispute/slash landed between our read and the drive — the crank's
          // confirming read caught it. Surface, do not count as released.
          allReleased = false;
          result.terminalOther += 1;
          record({ disposition: "terminal_other", driveOutcome: drive.outcome, reason: drive.reason });
        } else if (drive.outcome === "awaiting_challenge_window") {
          // Chain clock is behind our off-chain gate; heals on a later sweep.
          allReleased = false;
          record({ disposition: "awaiting", driveOutcome: drive.outcome });
        } else {
          // blocked / advanced / needs_input — not settled this pass.
          allReleased = false;
          result.blocked += 1;
          record({ disposition: "blocked", driveOutcome: drive.outcome, reason: drive.reason });
        }
      } catch (err) {
        // An UNEXPECTED crank error (RPC down, unmapped revert). The crank does not
        // swallow real errors; the keeper does not either — but one milestone's
        // failure must not abort the sweep. Log, mark blocked, move on. The next
        // sweep re-reads fresh state and retries.
        allReleased = false;
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

    // ── Reconcile the escrow row ONLY when every milestone is Released ──
    // Monotonic + chain-confirmed (settled=true is F1-guaranteed real). Jobs are
    // left to the existing settle paths + Step-3 projection.
    if (allReleased && escrow.status !== "completed") {
      try {
        repos.escrows.updateStatus(escrow.id, "completed");
        result.reconciledCompleted += 1;
      } catch (err) {
        // Reconciliation is best-effort — the on-chain release already happened,
        // which is the load-bearing outcome. A failed DB write is logged, not fatal.
        logger?.warn?.(
          `[settlement-keeper] DB reconcile failed for ${escrow.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
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
              `blocked=${r.blocked} reconciled=${r.reconciledCompleted} (skipV3=${r.skippedV3} readErr=${r.readErrors})`,
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
