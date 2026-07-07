/**
 * Settlement crank — the re-drivable, idempotent driver for a single milestone's
 * on-chain lifecycle (Settlement pivot, Step 1).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * MilestoneEscrowV2 is a strict per-milestone linear state machine. Every
 * post-creation money move is deduped BY THE CONTRACT, by revert (proven on a
 * Base-Sepolia fork, 9/9 — ai/research/settlement-pivot-roadmap.md, "Step 0
 * RESULT"). So the settle spine does not need a second, off-chain "exactly-once"
 * layer; it needs a function that reads the chain, does the next step, and treats
 * the contract's "you already did that" reverts as SUCCESS. That is this file.
 *
 * `driveSettlement(escrow, idx)` is safe to call any number of times, from any
 * caller (/complete, resume-settlement, a future keeper), after a crash at any
 * point. It cannot double-fund, double-submit, double-attest, or double-release,
 * because the contract reverts the duplicate and we map that revert to
 * ALREADY-DONE. Correctness under RPC replica lag, concurrent cranks, and
 * mid-sequence crashes comes from ONE property: every call re-reads the
 * receipt-confirmed on-chain state first, so a stale/false step from a previous
 * call is healed by the next call's fresh read. Re-driving converges to Released.
 *
 * The EXACT revert strings below are read verbatim from
 * packages/contracts/src/MilestoneEscrowV2.sol (fund :750, submitEvidence :817,
 * submitAttestation :862/:864, release :942/:943) — not inferred.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STATE MACHINE (per milestone)
 * ─────────────────────────────────────────────────────────────────────────────
 *   Unfunded(0) --fund()------------------> Funded(1)      (escrow-wide)
 *   Funded(1)   --depositBond()-----------> Locked(2)      (only when bond > 0)
 *   Locked(2) | (Funded & bond==0)
 *               --submitEvidence(hash)----> Evidenced(3)
 *   Evidenced(3)--submitAttestation(uid)--> Attested(4)    (opens challenge window)
 *   Attested(4) --release() [past window]-> Released(5)    (permissionless)
 *   {Disputed, Refunded, Slashed}          terminal (not driven here)
 *
 * The crank is PURE on-chain: it reads/writes the escrow and returns a structured
 * result. It never touches the DB — callers translate the outcome into their own
 * status rows. Evidence-hash and EAS-UID inputs are produced off-chain (evidence
 * bundle + oracle mint) and handed in; when a step needs an input the caller did
 * not supply, the crank stops with outcome `needs_input` rather than failing.
 */

import type { Address, Hex } from "viem";
import {
  getMilestoneV2,
  fundEscrowV2,
  depositBondV2,
  submitEvidenceV2,
  submitAttestationV2,
  releaseMilestoneV2,
  waitForReceipt,
  isWriteEnabled,
  MilestoneStatusV2,
  milestoneStatusV2Name,
} from "../contracts/escrow-client.js";
import { withSignerLock } from "../contracts/signer-lock.js";

// ── Revert strings (verbatim from MilestoneEscrowV2.sol) ────────────────────
// Each set is the revert(s) that, GIVEN we only attempt the step from its correct
// precondition (we read fresh state first), can ONLY mean "the milestone already
// advanced past this step" — i.e. ALREADY-DONE, not an error. They fire during
// viem's pre-broadcast gas estimation, so the write call throws before any tx.
const REVERT = {
  /** fund() when the escrow is already funded (:750). */
  fundAlready: ["Already funded"],
  /** depositBond() when status != Funded — i.e. already Locked+ (:791). */
  bondAlready: ["Not funded"],
  /** submitEvidence() when status != Locked/Funded — i.e. already Evidenced+ (:817). */
  evidenceAlready: ["Invalid status"],
  /** submitAttestation() when status != Evidenced (already Attested+, :862) OR the
   *  UID already released a milestone (:864) — both mean the attestation is in. */
  attestAlready: ["Evidence not submitted", "Attestation already used"],
  /** release() when status != Attested — i.e. already Released+ (:942). */
  releaseAlready: ["Not attested"],
  /** release() before the challenge window closes (:943) — NOT done, come back. */
  releaseWindowOpen: ["Challenge window open"],
  /** Steps that require a specific signer we may not be (operator/payer). Not an
   *  error and not done — the crank is blocked pending the right signer. */
  wrongSigner: ["Only operator", "Only payer"],
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DriveAction = "fund" | "depositBond" | "submitEvidence" | "submitAttestation" | "release";

/** One step the crank attempted (or short-circuited) during a drive. */
export interface DriveStep {
  action: DriveAction;
  /**
   * - `landed`       — the write was broadcast AND its receipt mined `success`.
   * - `already_done` — the contract reverted with an expected "already applied"
   *                    string; the step's effect is already on-chain (idempotent).
   * - `blocked`      — a wrong-signer revert, or a mined-but-reverted tx; the crank
   *                    cannot advance this step itself this call.
   */
  result: "landed" | "already_done" | "blocked";
  txHash?: string;
  /** The mapped revert string, when result is already_done/blocked. */
  revert?: string;
}

export type DriveOutcome =
  | "released" //                milestone is Released — fully settled on-chain
  | "awaiting_challenge_window" // Attested; release blocked until the window closes
  | "needs_input" //             a step needs an evidence hash / EAS UID we lack
  | "blocked" //                 write disabled, wrong signer, or a mined revert
  | "terminal_other" //          Disputed / Refunded / Slashed — not driven here
  | "advanced"; //               did work but ended in an intermediate state

export interface DriveSettlementResult {
  escrowAddress: string;
  milestoneIdx: number;
  /** On-chain status name AFTER the drive (best knowledge from reads + receipts). */
  finalStatus: ReturnType<typeof milestoneStatusV2Name>;
  outcome: DriveOutcome;
  /** True iff finalStatus === "Released". */
  settled: boolean;
  /** The steps this call attempted, in order (audit trail). */
  steps: DriveStep[];
  /** The milestone's on-chain stepId (read at the start; callers bind the oracle mint to it). */
  stepId?: string;
  /** When outcome === awaiting_challenge_window: unix-seconds the window closes. */
  challengeWindowEnd?: number;
  /** When outcome === needs_input: which input the next step requires. */
  needs?: "evidence_hash" | "eas_uid";
  /** When outcome === blocked / terminal_other: a short machine-readable reason. */
  reason?: string;
}

export interface DriveSettlementOptions {
  /** bytes32 evidence bundle hash — required to submit evidence on-chain. */
  evidenceBundleHash?: Hex;
  /** EAS attestation UID — required to bind the attestation on-chain. */
  easUid?: Hex;
  /**
   * Unix seconds used for the OFF-CHAIN challenge-window gate (default now). The
   * contract is the real gate (`block.timestamp >= challengeWindowEnd`); this only
   * avoids broadcasting a release we know will revert. A skew that lets a release
   * through is caught by the on-chain "Challenge window open" revert-map, so it is
   * always safe — this just saves gas.
   */
  nowSeconds?: number;
  /**
   * Skip the fund() step even when the milestone reads Unfunded. Funding pulls the
   * payer's USDC (a money move distinct from settlement); a caller that wants a
   * settlement-only drive can opt out. Default false (fund is part of the drive,
   * per the roadmap — and is a no-op once funded via the "Already funded" map).
   */
  skipFund?: boolean;
}

// ---------------------------------------------------------------------------
// Revert extraction / matching
// ---------------------------------------------------------------------------

/** Flatten a thrown error (viem or plain) to one lowercase string for matching. */
function flattenError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < 8) {
    if (typeof cur === "string") {
      parts.push(cur);
      break;
    }
    const e = cur as Record<string, unknown>;
    for (const k of ["shortMessage", "message", "details", "reason", "metaMessages"]) {
      const v = e[k];
      if (typeof v === "string") parts.push(v);
      else if (Array.isArray(v)) parts.push(v.filter((x) => typeof x === "string").join(" "));
    }
    cur = e.cause;
    depth++;
  }
  return parts.join(" | ").toLowerCase();
}

/** True if the error text contains any of the given revert needles (case-insensitive). */
function matchesRevert(err: unknown, needles: readonly string[]): string | undefined {
  const text = flattenError(err);
  for (const n of needles) {
    if (text.includes(n.toLowerCase())) return n;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Step executor
// ---------------------------------------------------------------------------

interface ExecResult {
  step: DriveStep;
  /** True if the milestone is now at/past this step's target status (advance local state). */
  advanced: boolean;
}

/**
 * Execute one on-chain write, wait for its receipt, and classify the outcome.
 * Expected "already applied" reverts map to already_done (advance); wrong-signer
 * reverts map to blocked (do NOT advance); anything else propagates (RPC down, an
 * EAS provenance failure, an unexpected contract error) — the crank must not
 * swallow a real error as success.
 */
async function execWrite(
  action: DriveAction,
  write: () => Promise<{ transactionHash: string }>,
  alreadyDoneReverts: readonly string[],
): Promise<ExecResult> {
  try {
    const { transactionHash } = await write();
    const receipt = await waitForReceipt(transactionHash as Hex);
    if (receipt.status !== "success") {
      // Broadcast passed estimation but the tx reverted on-chain (state moved
      // between estimation and mining). The next drive's fresh read is ground
      // truth; surface as blocked this call rather than assume success.
      return { step: { action, result: "blocked", txHash: transactionHash, revert: "tx_reverted" }, advanced: false };
    }
    return { step: { action, result: "landed", txHash: transactionHash }, advanced: true };
  } catch (err) {
    const already = matchesRevert(err, alreadyDoneReverts);
    if (already) return { step: { action, result: "already_done", revert: already }, advanced: true };
    const wrongSigner = matchesRevert(err, REVERT.wrongSigner);
    if (wrongSigner) return { step: { action, result: "blocked", revert: wrongSigner }, advanced: false };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The crank
// ---------------------------------------------------------------------------

/**
 * Drive a milestone forward as far as it can go RIGHT NOW, idempotently.
 *
 * Reads the milestone's receipt-confirmed on-chain state once, then runs the
 * ordered sequence fund → (bond) → evidence → attest → release from wherever it
 * is, treating expected reverts as already-done and stopping cleanly when it needs
 * an input it wasn't given or when the challenge window is still open. Returns a
 * structured result describing where the milestone ended up and what it did.
 *
 * Re-callable at any time: a second call is a no-op once Released, and resumes
 * from the true on-chain state after any crash.
 */
export async function driveSettlement(
  escrowAddress: Address,
  milestoneIdx: number,
  options: DriveSettlementOptions = {},
): Promise<DriveSettlementResult> {
  const { evidenceBundleHash, easUid, skipFund = false } = options;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const steps: DriveStep[] = [];

  // Defensive: without a signer the crank cannot write. Degrade gracefully (the
  // caller keeps its recoverable state) rather than throwing deep in a sequence.
  if (!isWriteEnabled()) {
    return {
      escrowAddress,
      milestoneIdx,
      finalStatus: "Unfunded",
      outcome: "blocked",
      settled: false,
      steps,
      reason: "write_disabled",
    };
  }

  // ── ONE fresh, receipt-confirmed read — the ground truth for this call ──
  const m = await getMilestoneV2(milestoneIdx, escrowAddress);
  let statusNum = m.status;
  const stepId = m.stepId;
  const hasBond = Number(m.operatorBond) > 0;
  // The challenge window closes at this unix-second. For a milestone read as
  // already-Attested this is the real on-chain value. When we attest DURING this
  // call the on-chain end isn't in our pre-attestation read, so we recompute it as
  // now + challengeWindowSeconds below — conservative (never releases early: a
  // zero-second window releases immediately; any positive window defers, and a
  // stale over-estimate at worst waits one extra drive).
  let windowEnd = m.challengeWindowEnd;

  // Result builder — reads the (locally-advanced) statusNum at call time, so the
  // reported finalStatus always reflects the furthest point the drive reached.
  const base = (extra: Partial<DriveSettlementResult> & { outcome: DriveOutcome }): DriveSettlementResult => ({
    escrowAddress,
    milestoneIdx,
    finalStatus: milestoneStatusV2Name(statusNum),
    settled: statusNum === MilestoneStatusV2.Released,
    steps,
    stepId,
    ...extra,
  });

  // Terminal states need no lock and no writes.
  if (
    statusNum === MilestoneStatusV2.Released
  ) {
    return base({ outcome: "released" });
  }
  if (
    statusNum === MilestoneStatusV2.Disputed ||
    statusNum === MilestoneStatusV2.Refunded ||
    statusNum === MilestoneStatusV2.Slashed
  ) {
    return base({ outcome: "terminal_other", reason: milestoneStatusV2Name(statusNum).toLowerCase() });
  }

  // The write sequence runs under the single-signer lock so this milestone's txs
  // stay contiguous vs. other jobs sharing the hot key (signer-lock.ts).
  return withSignerLock(async (): Promise<DriveSettlementResult> => {
    // 1. FUND (escrow-wide) — only from Unfunded.
    if (statusNum === MilestoneStatusV2.Unfunded) {
      if (skipFund) {
        return base({ outcome: "needs_input", needs: "evidence_hash", reason: "unfunded_fund_skipped" });
      }
      const r = await execWrite("fund", () => fundEscrowV2(escrowAddress), REVERT.fundAlready);
      steps.push(r.step);
      if (r.step.result === "blocked") return base({ outcome: "blocked", reason: r.step.revert ?? "fund_blocked" });
      if (r.advanced) statusNum = MilestoneStatusV2.Funded;
    }

    // 2. DEPOSIT BOND — only from Funded AND when a bond is required.
    if (statusNum === MilestoneStatusV2.Funded && hasBond) {
      const r = await execWrite("depositBond", () => depositBondV2(milestoneIdx, escrowAddress), REVERT.bondAlready);
      steps.push(r.step);
      if (r.step.result === "blocked") {
        // Bond is the operator's stake; a wrong-signer block here means the operator
        // must deposit it. Surface, don't crash.
        return base({ outcome: "blocked", reason: r.step.revert ?? "bond_blocked" });
      }
      if (r.advanced) statusNum = MilestoneStatusV2.Locked;
    }

    // 3. SUBMIT EVIDENCE — from Locked, or Funded when no bond is required.
    if (statusNum === MilestoneStatusV2.Locked || (statusNum === MilestoneStatusV2.Funded && !hasBond)) {
      if (!evidenceBundleHash) return base({ outcome: "needs_input", needs: "evidence_hash" });
      const r = await execWrite(
        "submitEvidence",
        () => submitEvidenceV2(milestoneIdx, evidenceBundleHash, escrowAddress),
        REVERT.evidenceAlready,
      );
      steps.push(r.step);
      if (r.step.result === "blocked") return base({ outcome: "blocked", reason: r.step.revert ?? "evidence_blocked" });
      if (r.advanced) statusNum = MilestoneStatusV2.Evidenced;
    }

    // 4. SUBMIT ATTESTATION — from Evidenced. Needs the oracle-minted EAS UID.
    if (statusNum === MilestoneStatusV2.Evidenced) {
      if (!easUid) return base({ outcome: "needs_input", needs: "eas_uid" });
      const r = await execWrite(
        "submitAttestation",
        () => submitAttestationV2(milestoneIdx, easUid, escrowAddress),
        REVERT.attestAlready,
      );
      steps.push(r.step);
      if (r.step.result === "blocked") return base({ outcome: "blocked", reason: r.step.revert ?? "attest_blocked" });
      if (r.advanced) {
        statusNum = MilestoneStatusV2.Attested;
        // The window just opened (or was reopened by a concurrent attest we mapped
        // to already_done). Recompute its end from the milestone's window length.
        windowEnd = nowSeconds + m.challengeWindowSeconds;
      }
    }

    // 5. RELEASE — from Attested, only once the challenge window has closed.
    if (statusNum === MilestoneStatusV2.Attested) {
      if (nowSeconds < windowEnd) {
        return base({ outcome: "awaiting_challenge_window", challengeWindowEnd: windowEnd });
      }
      try {
        const r = await execWrite("release", () => releaseMilestoneV2(milestoneIdx, escrowAddress), REVERT.releaseAlready);
        steps.push(r.step);
        if (r.step.result === "blocked") return base({ outcome: "blocked", reason: r.step.revert ?? "release_blocked" });
        if (r.advanced) statusNum = MilestoneStatusV2.Released;
      } catch (err) {
        // Off-chain gate passed but the chain's block.timestamp is still behind
        // challengeWindowEnd (clock skew). The window is genuinely open on-chain —
        // not an error, just "come back later" (Step 2's keeper will own this).
        if (matchesRevert(err, REVERT.releaseWindowOpen)) {
          steps.push({ action: "release", result: "blocked", revert: "Challenge window open" });
          return base({ outcome: "awaiting_challenge_window", challengeWindowEnd: windowEnd });
        }
        throw err;
      }
    }

    // ── Final classification from the (locally-advanced) status ──
    if (statusNum === MilestoneStatusV2.Released) return base({ outcome: "released" });
    if (statusNum === MilestoneStatusV2.Attested) {
      return base({ outcome: "awaiting_challenge_window", challengeWindowEnd: windowEnd });
    }
    return base({ outcome: "advanced" });
  });
}
