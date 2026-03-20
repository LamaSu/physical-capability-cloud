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
import type { Address } from "viem";
import { getRepos } from "../db.js";
import {
  submitEvidence as onChainSubmitEvidence,
  releaseMilestone as onChainReleaseMilestone,
  isWriteEnabled,
} from "../contracts/escrow-client.js";

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
}

export interface ReleaseResult {
  jobId: string;
  txHash: string;
  status: "released" | "failed";
  error?: string;
}

export interface ProcessEvidenceOptions {
  milestoneIndex?: number;
  contractAddress?: string;
  autoRelease?: boolean; // true = immediately release after submitting evidence (tier 0)
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
    const { milestoneIndex = 0, contractAddress, autoRelease = false } = options;

    const result: SettlementResult = {
      jobId,
      evidenceBundleId: bundle.id,
      settled: false,
    };

    // ── Step 1: Store evidence bundle to IPFS/Storacha ──────────────
    try {
      const { createEvidenceStorage } = await import("@pcc/kernel/evidence-storage-factory");
      const storage = await createEvidenceStorage();
      await storage.init();
      const archiveResult = await storage.archiveBundle(bundle);
      result.cid = archiveResult.cid;
    } catch (err) {
      // Storage is best-effort — log but continue
      console.warn("[settlement] Evidence storage failed (best-effort):", err instanceof Error ? err.message : err);
    }

    // ── Step 2: Persist bundle + events to DB ───────────────────────
    try {
      const repos = getRepos();

      repos.evidence.insert({
        id: bundle.id,
        jobId: bundle.jobId,
        stepId: bundle.stepId,
        kernelId: bundle.kernelId,
        assuranceTier: bundle.assuranceTier,
        bundleHash: bundle.bundleHash,
        kernelSignature: bundle.kernelSignature,
        createdAt: bundle.createdAt,
      });

      if (bundle.events.length > 0) {
        repos.evidence.insertEvents(
          bundle.events.map((ev) => ({
            id: ev.id,
            bundleId: bundle.id,
            type: ev.type,
            timestamp: ev.timestamp,
            source: ev.source,
            payload: ev.payload as Record<string, unknown>,
            hash: ev.hash,
          })),
        );
      }

      repos.jobs.updateStatus(jobId, "evidence_stored");
    } catch (err) {
      console.warn("[settlement] DB persistence failed:", err instanceof Error ? err.message : err);
      // Non-fatal — the bundle is still valid
    }

    // ── Step 3: Submit evidence hash on-chain ───────────────────────
    if (isWriteEnabled() && contractAddress) {
      try {
        const addr = contractAddress as Address;
        const bundleHashHex = bundle.bundleHash.startsWith("0x")
          ? (bundle.bundleHash as `0x${string}`)
          : (`0x${bundle.bundleHash}` as `0x${string}`);

        const writeResult = await onChainSubmitEvidence(milestoneIndex, bundleHashHex, addr);
        result.evidenceTxHash = writeResult.transactionHash;

        try {
          const repos = getRepos();
          repos.jobs.updateStatus(jobId, "evidence_submitted");
        } catch {
          // DB update non-fatal
        }
      } catch (err) {
        console.warn("[settlement] On-chain evidence submission failed:", err instanceof Error ? err.message : err);
        result.error = err instanceof Error ? err.message : "on_chain_submission_failed";
      }
    }

    // ── Step 4: Auto-release for tier 0 ─────────────────────────────
    if (autoRelease && isWriteEnabled() && contractAddress) {
      try {
        const releaseResult = await this.releaseMilestone(jobId, milestoneIndex, contractAddress);
        if (releaseResult.status === "released") {
          result.releaseTxHash = releaseResult.txHash;
          result.settled = true;
        }
      } catch (err) {
        console.warn("[settlement] Auto-release failed:", err instanceof Error ? err.message : err);
      }
    }

    return result;
  }

  /**
   * Release a milestone's escrow after the challenge window has closed (or immediately for tier 0).
   */
  async releaseMilestone(
    jobId: string,
    milestoneIndex: number,
    contractAddress?: string,
  ): Promise<ReleaseResult> {
    if (!isWriteEnabled()) {
      return {
        jobId,
        txHash: "",
        status: "failed",
        error: "write_disabled",
      };
    }

    if (!contractAddress) {
      const defaultAddr = process.env.ESCROW_CONTRACT_ADDRESS;
      if (!defaultAddr) {
        return {
          jobId,
          txHash: "",
          status: "failed",
          error: "no_contract_address",
        };
      }
      contractAddress = defaultAddr;
    }

    try {
      const writeResult = await onChainReleaseMilestone(
        milestoneIndex,
        contractAddress as Address,
      );

      try {
        const repos = getRepos();
        repos.jobs.updateStatus(jobId, "settled");
      } catch {
        // DB update non-fatal
      }

      return {
        jobId,
        txHash: writeResult.transactionHash,
        status: "released",
      };
    } catch (err) {
      return {
        jobId,
        txHash: "",
        status: "failed",
        error: err instanceof Error ? err.message : "release_failed",
      };
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
