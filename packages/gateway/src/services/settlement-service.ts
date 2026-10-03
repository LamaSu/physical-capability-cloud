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
import { isAddress, getAddress } from "viem";
import type { Address } from "viem";
import type { OracleAttestation } from "@pcc/contracts";
import { getRepos } from "../db.js";
import {
  beginSettlement,
  endSettlement,
  escrowForJob,
  givenBackEscrow,
  recordMilestoneReleased,
  releaseEscrowFromSettlement,
} from "./escrow-refund.js";
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
    const { milestoneIndex = 0, contractAddress, autoRelease = false, attestation } = options;

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

                try {
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
                  bundlePersisted = true;
                } catch (insertErr) {
                  // N79 round 5 (R5-H1, astra 126e Q2 HIGH): the insert can throw because `bundle.id` already
                  // exists — most often an EXACT re-delivery of the same bundle (idempotent: a retried call, a
                  // duplicate network delivery), which must proceed exactly as a fresh insert would. Anything else
                  // under that same id — a different job/step/kernel/tier, or (loudest) a DIFFERENT hash — is a
                  // genuine conflict: this call's evidence was NOT persisted, so it must not be submitted on-chain
                  // or pointed at by the job. A row that cannot even be re-read throws to the outer catch below:
                  // a bare persistence failure, same consequence.
                  const existing = repos.evidence.findById(bundle.id);
                  const exactReDelivery =
                    existing !== undefined &&
                    existing.jobId === bundle.jobId &&
                    existing.stepId === bundle.stepId &&
                    existing.kernelId === bundle.kernelId &&
                    existing.assuranceTier === bundle.assuranceTier &&
                    existing.bundleHash === bundle.bundleHash;
                  if (exactReDelivery) {
                    bundlePersisted = true;
                    console.warn(`[settlement] Evidence bundle ${bundle.id} already persisted identically — idempotent re-delivery, proceeding.`);
                  } else {
                    result.error = existing ? "evidence_bundle_conflict" : "evidence_persistence_failed";
                    console.warn(
                      `[settlement] DB persistence failed for bundle ${bundle.id}: ${
                        existing
                          ? `an existing row under this id does not match this bundle (job/step/kernel/tier/hash) — refusing to settle on it`
                          : insertErr instanceof Error
                            ? insertErr.message
                            : String(insertErr)
                      }`,
                    );
                  }
                }

                if (bundlePersisted && bundle.events.length > 0) {
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

                  const writeResult = await onChainSubmitEvidence(milestoneIndex, bundleHashHex, addr);
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
                  const releaseResult = await this.releaseMilestone(
                    jobId,
                    milestoneIndex,
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
    // escrow's address, else the env default. When the job has its own escrow, the target must name THAT exact
    // row: a caller supplying a different escrow's address (or a stale env default, for a job whose escrow is a
    // per-job V2 clone) is refused here, before the chain and before any lease. Without this, the service could
    // lease the job's own escrow while releasing, and recording the release against, a completely different one.
    //
    // R5-M1: this resolution + mismatch check now runs BEFORE the given-back check below. It used to run after: an
    // UNRELATED refunded env default, or an explicitly-named refunded escrow that was not even the job's own, was
    // checked for "given back" before the job's actual target was ever resolved — wrongly refusing a job A whose
    // OWN escrow was perfectly fine, with the wrong error (`escrow_refunded` instead of `escrow_mismatch`, or
    // instead of no refusal at all).
    const jobRow = escrowForJob(jobId);
    if (!contractAddress) {
      contractAddress = jobRow?.contractAddress ?? process.env.ESCROW_CONTRACT_ADDRESS;
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
        try {
          recordMilestoneReleased(milestoneIndex, claim);
        } catch (recordErr) {
          // The release happened on-chain, so it is not reported as failed, and the claim is NOT handed back (the escrow
          // stays owned: no refund can land on funds that moved). But the caller is told it was not recorded (F5).
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
