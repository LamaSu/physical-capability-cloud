/**
 * Unit tests for the settlement crank (driveSettlement) — the re-drivable,
 * idempotent milestone driver (settlement pivot Step 1).
 *
 * All pure / mocked: no live chain. The escrow-client network fns are replaced
 * with spies while its REAL status enum + name map are kept (importOriginal), so
 * the crank's status comparisons run against the true Solidity values. Each write
 * spy can `mockResolvedValue` (landed) or `mockRejectedValue(new Error("<revert>"))`
 * to exercise the exact revert-string → ALREADY-DONE mapping the contract enforces.
 *
 * The central guarantees proven here:
 *   • re-driving from any state is a safe no-op (idempotency),
 *   • each contract "already applied" revert advances instead of erroring,
 *   • a mid-settle crash + re-drive completes with NO double on-chain write,
 *   • unexpected errors still propagate (no silent swallow).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../contracts/escrow-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contracts/escrow-client.js")>();
  return {
    ...actual, // keep the REAL MilestoneStatusV2 + milestoneStatusV2Name
    isWriteEnabled: vi.fn().mockReturnValue(true),
    getMilestoneV2: vi.fn(),
    fundEscrowV2: vi.fn(),
    depositBondV2: vi.fn(),
    submitEvidenceV2: vi.fn(),
    submitAttestationV2: vi.fn(),
    releaseMilestoneV2: vi.fn(),
    waitForReceipt: vi.fn(),
  };
});

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
  type OnChainMilestoneV2,
} from "../contracts/escrow-client.js";
import { __resetSignerLockForTests } from "../contracts/signer-lock.js";
import { driveSettlement } from "../services/settlement-crank.js";

const ESCROW = ("0x" + "9a".repeat(20)) as `0x${string}`;
const HASH = ("0x" + "bc".repeat(32)) as `0x${string}`;
const UID = ("0x" + "de".repeat(32)) as `0x${string}`;
const STEP = "0x" + "11".repeat(32);

const NOW = 5_000_000_000;
const PAST = NOW - 1_000; // challenge window already closed
const FUTURE = NOW + 1_000_000; // challenge window still open

const mGet = vi.mocked(getMilestoneV2);
const mFund = vi.mocked(fundEscrowV2);
const mBond = vi.mocked(depositBondV2);
const mEvidence = vi.mocked(submitEvidenceV2);
const mAttest = vi.mocked(submitAttestationV2);
const mRelease = vi.mocked(releaseMilestoneV2);
const mReceipt = vi.mocked(waitForReceipt);
const mWriteEnabled = vi.mocked(isWriteEnabled);

/** Build a minimal on-chain milestone view for a given status. */
function milestone(status: number, over: Partial<OnChainMilestoneV2> = {}): OnChainMilestoneV2 {
  return {
    stepId: STEP,
    operator: ("0x" + "00".repeat(20)) as `0x${string}`,
    amount: "10",
    operatorBond: "0",
    status,
    statusName: "",
    evidenceBundleHash: "0x" + "00".repeat(32),
    verifierAttestationHash: "0x" + "00".repeat(32),
    challengeWindowEnd: PAST,
    challengeWindowSeconds: 0,
    requiredTier: 0,
    jobIdHash: "0x" + "00".repeat(32),
    verifierAttestationUid: "0x" + "00".repeat(32),
    ...over,
  } as OnChainMilestoneV2;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetSignerLockForTests();
  mWriteEnabled.mockReturnValue(true);
  mReceipt.mockResolvedValue({ status: "success", blockNumber: 1 });
  mFund.mockResolvedValue({ transactionHash: "0xfund", status: "submitted" });
  mBond.mockResolvedValue({ transactionHash: "0xbond", status: "submitted" });
  mEvidence.mockResolvedValue({ transactionHash: "0xev", status: "submitted" });
  mAttest.mockResolvedValue({ transactionHash: "0xat", status: "submitted" });
  mRelease.mockResolvedValue({ transactionHash: "0xrel", status: "submitted" });
});

const fullOpts = { evidenceBundleHash: HASH, easUid: UID, nowSeconds: NOW };

describe("driveSettlement — forward drive", () => {
  it("drives Funded (bond 0, window closed) all the way to Released", async () => {
    mGet.mockResolvedValue(milestone(MilestoneStatusV2.Funded, { challengeWindowEnd: PAST }));

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(r.outcome).toBe("released");
    expect(r.settled).toBe(true);
    expect(r.finalStatus).toBe("Released");
    // Funded already → no fund; then evidence → attest → release, each once.
    expect(mFund).not.toHaveBeenCalled();
    expect(mEvidence).toHaveBeenCalledTimes(1);
    expect(mAttest).toHaveBeenCalledTimes(1);
    expect(mRelease).toHaveBeenCalledTimes(1);
    expect(r.steps.map((s) => [s.action, s.result])).toEqual([
      ["submitEvidence", "landed"],
      ["submitAttestation", "landed"],
      ["release", "landed"],
    ]);
  });

  it("funds first when the milestone reads Unfunded", async () => {
    mGet.mockResolvedValue(milestone(MilestoneStatusV2.Unfunded, { challengeWindowEnd: PAST }));

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(mFund).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe("released");
    expect(r.steps[0]).toMatchObject({ action: "fund", result: "landed" });
  });

  it("deposits the operator bond when bond > 0 (Funded → Locked → …)", async () => {
    mGet.mockResolvedValue(milestone(MilestoneStatusV2.Funded, { operatorBond: "5", challengeWindowEnd: PAST }));

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(mBond).toHaveBeenCalledTimes(1);
    expect(mEvidence).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe("released");
  });

  it("stops at awaiting_challenge_window when the window is still open (no release tx)", async () => {
    // Positive window length → a fresh in-call attest sets windowEnd = now + secs.
    mGet.mockResolvedValue(
      milestone(MilestoneStatusV2.Funded, { challengeWindowEnd: FUTURE, challengeWindowSeconds: FUTURE - NOW }),
    );

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(r.outcome).toBe("awaiting_challenge_window");
    expect(r.challengeWindowEnd).toBe(FUTURE); // now + (FUTURE - NOW)
    expect(r.finalStatus).toBe("Attested");
    expect(mEvidence).toHaveBeenCalledTimes(1);
    expect(mAttest).toHaveBeenCalledTimes(1);
    expect(mRelease).not.toHaveBeenCalled(); // off-chain gate prevents the wasted tx
  });

  it("returns the milestone stepId (callers bind the oracle mint to it)", async () => {
    mGet.mockResolvedValue(milestone(MilestoneStatusV2.Funded, { challengeWindowEnd: FUTURE }));
    const r = await driveSettlement(ESCROW, 0, { evidenceBundleHash: HASH, nowSeconds: NOW });
    expect(r.stepId).toBe(STEP);
  });
});

describe("driveSettlement — idempotency / re-drive", () => {
  it("is a pure no-op when already Released (no reads-to-writes, no tx)", async () => {
    mGet.mockResolvedValue(milestone(MilestoneStatusV2.Released));

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(r.outcome).toBe("released");
    expect(r.settled).toBe(true);
    expect(r.steps).toHaveLength(0);
    expect(mFund).not.toHaveBeenCalled();
    expect(mEvidence).not.toHaveBeenCalled();
    expect(mAttest).not.toHaveBeenCalled();
    expect(mRelease).not.toHaveBeenCalled();
  });

  it("releases from Attested past-window with NO evidence/uid inputs", async () => {
    mGet.mockResolvedValue(milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST }));

    const r = await driveSettlement(ESCROW, 0, { nowSeconds: NOW }); // no hash, no uid

    expect(r.outcome).toBe("released");
    expect(mRelease).toHaveBeenCalledTimes(1);
    expect(mEvidence).not.toHaveBeenCalled();
    expect(mAttest).not.toHaveBeenCalled();
  });

  it("re-drives from Evidenced: skips evidence, submits attestation only", async () => {
    mGet.mockResolvedValue(
      milestone(MilestoneStatusV2.Evidenced, { challengeWindowEnd: FUTURE, challengeWindowSeconds: FUTURE - NOW }),
    );

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(mEvidence).not.toHaveBeenCalled();
    expect(mAttest).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe("awaiting_challenge_window");
  });
});

describe("driveSettlement — revert-map (contract dedups → ALREADY-DONE)", () => {
  it('maps fund "Already funded" to already_done and continues', async () => {
    mGet.mockResolvedValue(milestone(MilestoneStatusV2.Unfunded, { challengeWindowEnd: PAST }));
    mFund.mockRejectedValue(new Error("execution reverted: Already funded"));

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(r.steps[0]).toMatchObject({ action: "fund", result: "already_done", revert: "Already funded" });
    expect(r.outcome).toBe("released");
  });

  it('maps submitEvidence "Invalid status" to already_done, confirms Evidenced, continues', async () => {
    // Concurrent evidence: our stale read says Funded; the confirming read after the
    // "Invalid status" revert shows the TRUE state (Evidenced) so the drive continues.
    mGet
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Funded, { challengeWindowEnd: PAST }))
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Evidenced, { challengeWindowEnd: PAST }));
    mEvidence.mockRejectedValue(new Error("The contract function reverted with: Invalid status"));

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(r.steps[0]).toMatchObject({ action: "submitEvidence", result: "already_done" });
    expect(mAttest).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe("released");
  });

  it('maps submitAttestation "Evidence not submitted" to already_done, confirms Attested, releases', async () => {
    mGet
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Evidenced, { challengeWindowEnd: PAST }))
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST }));
    mAttest.mockRejectedValue(new Error("reverted: Evidence not submitted"));

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(r.steps[0]).toMatchObject({ action: "submitAttestation", result: "already_done" });
    expect(mRelease).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe("released");
  });

  it('maps "Attestation already used" to already_done when THIS milestone recorded THIS uid (F2 match)', async () => {
    mGet
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Evidenced, { challengeWindowEnd: PAST }))
      // Confirming read: this milestone IS attested with the SAME uid we tried → genuinely done.
      .mockResolvedValueOnce(
        milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST, verifierAttestationUid: UID }),
      );
    mAttest.mockRejectedValue(new Error("Attestation already used"));

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(r.steps[0]).toMatchObject({ action: "submitAttestation", result: "already_done" });
    expect(mRelease).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe("released");
    expect(r.settled).toBe(true);
  });

  it('maps release "Not attested" to released ONLY via a read-confirmed Released (F1 genuine)', async () => {
    mGet
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST }))
      // Confirming read proves the money actually moved: status is Released on-chain.
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Released, { challengeWindowEnd: PAST }));
    mRelease.mockRejectedValue(new Error("execution reverted: Not attested"));

    const r = await driveSettlement(ESCROW, 0, { nowSeconds: NOW });

    expect(r.steps[0]).toMatchObject({ action: "release", result: "already_done", revert: "Not attested" });
    expect(r.outcome).toBe("released");
    expect(r.settled).toBe(true);
  });

  it('maps release "Challenge window open" (chain clock behind) to awaiting_challenge_window', async () => {
    // Off-chain gate passes (nowSeconds >= end) but the chain reverts window-open.
    mGet.mockResolvedValue(milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST }));
    mRelease.mockRejectedValue(new Error("reverted: Challenge window open"));

    const r = await driveSettlement(ESCROW, 0, { nowSeconds: NOW });

    expect(r.outcome).toBe("awaiting_challenge_window");
    expect(r.settled).toBe(false);
  });

  it("every step already_done (fully redundant re-drive) still reaches Released via confirming reads", async () => {
    // Each ambiguous already-done triggers a confirming read; the chain is progressively
    // further along, ending Released. Fund uses the monotonic "Already funded" map (no read).
    mGet
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Unfunded, { challengeWindowEnd: PAST })) // initial
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Evidenced, { challengeWindowEnd: PAST })) // after evidence already_done
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST })) // after attest already_done
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Released, { challengeWindowEnd: PAST })); // after release already_done
    mFund.mockRejectedValue(new Error("Already funded"));
    mEvidence.mockRejectedValue(new Error("Invalid status"));
    mAttest.mockRejectedValue(new Error("Evidence not submitted"));
    mRelease.mockRejectedValue(new Error("Not attested"));

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(r.outcome).toBe("released");
    expect(r.settled).toBe(true);
    expect(r.steps.every((s) => s.result === "already_done")).toBe(true);
  });
});

describe("driveSettlement — crash + re-drive (no double on-chain write)", () => {
  it("resumes an interrupted settle from true chain state with evidence submitted exactly once", async () => {
    // Call 1: Funded → submitEvidence lands, then submitAttestation throws an
    // UNEXPECTED error (RPC blip) — the crank propagates (does not swallow).
    mGet.mockResolvedValueOnce(milestone(MilestoneStatusV2.Funded, { challengeWindowEnd: PAST }));
    mAttest.mockRejectedValueOnce(new Error("HTTP request failed: 503"));

    await expect(driveSettlement(ESCROW, 0, fullOpts)).rejects.toThrow(/503/);
    expect(mEvidence).toHaveBeenCalledTimes(1); // evidence landed

    // Call 2 (re-drive): the chain now reads Evidenced (evidence persisted). The
    // crank skips evidence entirely and completes attest → release.
    mGet.mockResolvedValueOnce(milestone(MilestoneStatusV2.Evidenced, { challengeWindowEnd: PAST }));
    // mAttest default (resolves) applies now that the once-rejection is consumed.

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(r.outcome).toBe("released");
    // The idempotency-critical assertion: evidence was submitted EXACTLY ONCE
    // across the crash + recovery — no double on-chain write.
    expect(mEvidence).toHaveBeenCalledTimes(1);
    expect(mAttest).toHaveBeenCalledTimes(2); // once threw, once landed
    expect(mRelease).toHaveBeenCalledTimes(1);
  });
});

describe("driveSettlement — needs_input / blocked / terminal", () => {
  it("stops needs_input:evidence_hash when Funded but no evidence hash supplied", async () => {
    mGet.mockResolvedValue(milestone(MilestoneStatusV2.Funded, { challengeWindowEnd: PAST }));

    const r = await driveSettlement(ESCROW, 0, { nowSeconds: NOW }); // no hash

    expect(r.outcome).toBe("needs_input");
    expect(r.needs).toBe("evidence_hash");
    expect(mEvidence).not.toHaveBeenCalled();
  });

  it("stops needs_input:eas_uid when Evidenced but no UID supplied", async () => {
    mGet.mockResolvedValue(milestone(MilestoneStatusV2.Evidenced, { challengeWindowEnd: PAST }));

    const r = await driveSettlement(ESCROW, 0, { evidenceBundleHash: HASH, nowSeconds: NOW });

    expect(r.outcome).toBe("needs_input");
    expect(r.needs).toBe("eas_uid");
    expect(mAttest).not.toHaveBeenCalled();
  });

  it("blocks (no tx, no read) when write is disabled", async () => {
    mWriteEnabled.mockReturnValue(false);

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(r.outcome).toBe("blocked");
    expect(r.reason).toBe("write_disabled");
    expect(mGet).not.toHaveBeenCalled();
  });

  it('blocks on a wrong-signer revert ("Only operator") without erroring', async () => {
    mGet.mockResolvedValue(milestone(MilestoneStatusV2.Funded, { challengeWindowEnd: PAST }));
    mEvidence.mockRejectedValue(new Error("execution reverted: Only operator"));

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(r.outcome).toBe("blocked");
    expect(r.steps[0]).toMatchObject({ action: "submitEvidence", result: "blocked", revert: "Only operator" });
  });

  it("reports terminal_other for a Disputed milestone (not driven here)", async () => {
    mGet.mockResolvedValue(milestone(MilestoneStatusV2.Disputed));

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(r.outcome).toBe("terminal_other");
    expect(mRelease).not.toHaveBeenCalled();
  });

  it("blocks when a write mines but the receipt reverts (status != success)", async () => {
    mGet.mockResolvedValue(milestone(MilestoneStatusV2.Funded, { challengeWindowEnd: PAST }));
    mReceipt.mockResolvedValue({ status: "reverted", blockNumber: 2 });

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(r.outcome).toBe("blocked");
    expect(r.steps[0]).toMatchObject({ action: "submitEvidence", result: "blocked", revert: "tx_reverted" });
    expect(mAttest).not.toHaveBeenCalled();
  });
});

describe("driveSettlement — unexpected errors propagate (no silent swallow)", () => {
  it("re-throws an unmapped write error", async () => {
    mGet.mockResolvedValue(milestone(MilestoneStatusV2.Funded, { challengeWindowEnd: PAST }));
    mEvidence.mockRejectedValue(new Error("insufficient funds for intrinsic transaction cost"));

    await expect(driveSettlement(ESCROW, 0, fullOpts)).rejects.toThrow(/insufficient funds/);
  });

  it("propagates an unmapped EAS provenance revert on attestation", async () => {
    mGet.mockResolvedValue(milestone(MilestoneStatusV2.Evidenced, { challengeWindowEnd: PAST }));
    mAttest.mockRejectedValue(new Error("execution reverted: Wrong attester"));

    await expect(driveSettlement(ESCROW, 0, fullOpts)).rejects.toThrow(/Wrong attester/);
  });
});

describe("driveSettlement — chain-authoritative safety (F1/F2/F3 confirming reads)", () => {
  // THE keeper invariant: settled=true is reported ONLY from a landed release receipt or a
  // read-confirmed Released status — a status-agnostic revert ("Not attested" etc.) never
  // settles a milestone whose money is actually frozen (Disputed) or refunded (Slashed).

  it("F1: a Disputed escrow whose release reverts 'Not attested' is terminal_other, NOT settled", async () => {
    // The exact bug: a dispute lands between our (stale) Attested read and the release write.
    // release() reverts 'Not attested' (fires for ANY status != Attested). The confirming
    // read sees Disputed → terminal_other; the money is frozen, so settled MUST stay false.
    mGet
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST })) // stale read
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Disputed)); // confirming read: money frozen
    mRelease.mockRejectedValue(new Error("execution reverted: Not attested"));

    const r = await driveSettlement(ESCROW, 0, { nowSeconds: NOW });

    expect(r.outcome).toBe("terminal_other");
    expect(r.settled).toBe(false); // ← the invariant closed by F1
    expect(r.finalStatus).toBe("Disputed");
    expect(r.reason).toBe("disputed");
    expect(mGet).toHaveBeenCalledTimes(2); // one confirming read was made
  });

  it("F1: a Slashed escrow whose release reverts 'Not attested' is terminal_other, NOT settled", async () => {
    mGet
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST }))
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Slashed));
    mRelease.mockRejectedValue(new Error("Not attested"));

    const r = await driveSettlement(ESCROW, 0, { nowSeconds: NOW });

    expect(r.outcome).toBe("terminal_other");
    expect(r.settled).toBe(false);
    expect(r.finalStatus).toBe("Slashed");
  });

  it("F1: evidence 'Invalid status' confirming Disputed does NOT waterfall into a release", async () => {
    // The earlier-revert waterfall: a stale Funded read + a Disputed chain. The evidence
    // 'Invalid status' revert must be confirmed (→ terminal_other), never optimistically
    // advanced to Evidenced then attested then released.
    mGet
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Funded, { challengeWindowEnd: PAST })) // stale
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Disputed)); // confirming read
    mEvidence.mockRejectedValue(new Error("Invalid status"));

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(r.outcome).toBe("terminal_other");
    expect(r.settled).toBe(false);
    expect(mAttest).not.toHaveBeenCalled();
    expect(mRelease).not.toHaveBeenCalled();
  });

  it("F1: attestation 'Evidence not submitted' confirming Slashed does NOT waterfall into a release", async () => {
    mGet
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Evidenced, { challengeWindowEnd: PAST })) // stale
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Slashed)); // confirming read
    mAttest.mockRejectedValue(new Error("Evidence not submitted"));

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(r.outcome).toBe("terminal_other");
    expect(r.settled).toBe(false);
    expect(mRelease).not.toHaveBeenCalled();
  });

  it("F1: release 'Not attested' whose confirming read still lags at Attested → awaiting (not settled)", async () => {
    // A stale replica that hasn't caught up: never settle on an unconfirmed release; report
    // awaiting and let the next drive heal once the replica reflects the real state.
    mGet
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST }))
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST }));
    mRelease.mockRejectedValue(new Error("Not attested"));

    const r = await driveSettlement(ESCROW, 0, { nowSeconds: NOW });

    expect(r.outcome).toBe("awaiting_challenge_window");
    expect(r.settled).toBe(false);
  });

  it("F2: 'Attestation already used' by a SIBLING milestone (uid mismatch) is blocked, not advanced", async () => {
    // _attestationUsed is per-UID-per-ESCROW: a sibling milestone consumed the uid, so THIS
    // milestone is still Evidenced. Advancing it toward release would settle unattested work.
    const OTHER_UID = ("0x" + "77".repeat(32)) as `0x${string}`;
    mGet
      .mockResolvedValueOnce(milestone(MilestoneStatusV2.Evidenced, { challengeWindowEnd: PAST }))
      .mockResolvedValueOnce(
        milestone(MilestoneStatusV2.Evidenced, { challengeWindowEnd: PAST, verifierAttestationUid: OTHER_UID }),
      );
    mAttest.mockRejectedValue(new Error("Attestation already used"));

    const r = await driveSettlement(ESCROW, 0, fullOpts);

    expect(r.outcome).toBe("blocked");
    expect(r.reason).toBe("attestation_uid_mismatch");
    expect(r.settled).toBe(false);
    expect(mRelease).not.toHaveBeenCalled();
    expect(r.steps[0]).toMatchObject({ action: "submitAttestation", result: "blocked" });
  });

  it("F3: a receipt-wait timeout classifies the step blocked (never settled)", async () => {
    mGet.mockResolvedValue(milestone(MilestoneStatusV2.Attested, { challengeWindowEnd: PAST }));
    mReceipt.mockResolvedValue({ status: "timeout", blockNumber: 0 });

    const r = await driveSettlement(ESCROW, 0, { nowSeconds: NOW });

    expect(r.outcome).toBe("blocked");
    expect(r.settled).toBe(false);
    expect(r.steps[0]).toMatchObject({ action: "release", result: "blocked", revert: "receipt_timeout" });
  });
});
