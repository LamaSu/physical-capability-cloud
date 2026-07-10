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
import type { Address } from "viem";
import type { OracleAttestation } from "@pcc/contracts";
import { getRepos } from "../db.js";
import {
  submitEvidence as onChainSubmitEvidence,
  releaseMilestone as onChainReleaseMilestone,
  isWriteEnabled,
} from "../contracts/escrow-client.js";
import { Sentry } from "../sentry.js";
import { traceCollector, TraceCollector } from "../trace-collector.js";
import { pipelineTelemetry } from "../telemetry.js";
import { auditService } from "./audit-service.js";

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
    const { milestoneIndex = 0, contractAddress, autoRelease = false, attestation } = options;

    const result: SettlementResult = {
      jobId,
      evidenceBundleId: bundle.id,
      settled: false,
    };

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
                traceCollector.endSpan({ traceId: localTraceId, spanId: dbSpanId, status: "ok" });
              } catch (err) {
                console.warn("[settlement] DB persistence failed:", err instanceof Error ? err.message : err);
                traceCollector.endSpan({ traceId: localTraceId, spanId: dbSpanId, status: "error" });
                // Non-fatal — the bundle is still valid
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
              if (isWriteEnabled() && contractAddress && !fabricatedBlocksSettlement) {
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
              if (autoRelease && isWriteEnabled() && contractAddress && attestation && !fabricatedBlocksSettlement) {
                try {
                  const releaseResult = await this.releaseMilestone(
                    jobId,
                    milestoneIndex,
                    attestation,
                    contractAddress,
                  );
                  if (releaseResult.status === "released") {
                    result.releaseTxHash = releaseResult.txHash;
                    result.settled = true;
                    pipelineTelemetry.emit(jobId, "settlement_complete", "completed", {
                      metadata: { released: true, txHash: result.releaseTxHash, contractAddress },
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
        attestation,
        contractAddress as Address,
      );

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
