/**
 * Stage 4 — submit job to PCC + fund escrow.
 *
 * Talks to the PCC gateway via an injected PccClient (the real implementation
 * uses fetch against https://capability.network, but tests pass a mock).
 *
 * Order of operations:
 *   1. POST /api/jobs/submit with the MADSci workflow embedded as params.
 *   2. POST /api/escrow/fund against the returned escrow id.
 *   3. Return the escrow id + PCC job id.
 *
 * Settlement (release/dispute) is left to the gateway's evidence
 * verification — PCC releases automatically when the kernel posts
 * evidence that meets the tier's ALCOA+ checks.
 */

import { madsciWorkflowToPccJob } from "@pcc/adapter-madsci";
import type { MadsciWorkflow } from "@pcc/adapter-madsci";
import type { SimAttestation } from "@pcc/kernel-omniverse-sim";
import type { PccClient } from "./types.js";

export interface PccStageOptions {
  pcc: PccClient;
  workflow: MadsciWorkflow;
  attestation: SimAttestation;
  kernelId: string;
  capabilityId: string;
  assuranceTier?: 0 | 1 | 2 | 3;
  /** USDC amount to fund the escrow, as a string per PCC convention. */
  fundAmountUSDC: string;
}

export interface PccStageResult {
  pccJobId: string;
  escrowId: string;
  escrowAddress?: string;
}

export async function submitAndFund(
  opts: PccStageOptions,
): Promise<PccStageResult> {
  const jobBody = madsciWorkflowToPccJob(opts.workflow, {
    kernelId: opts.kernelId,
    capabilityId: opts.capabilityId,
    assuranceTier: opts.assuranceTier ?? 1,
  });
  // Carry the attestation hash + signature alongside the workflow so the
  // executing kernel can demand it as a pre-condition.
  const augmented = {
    ...jobBody,
    params: {
      ...jobBody.params,
      simAttestation: {
        workflowHash: opts.attestation.workflowHash,
        signature: opts.attestation.signature,
        signerPublicKey: opts.attestation.signerPublicKey,
        timestamp: opts.attestation.timestamp,
        verdict: opts.attestation.result.verdict,
      },
    },
  };

  const submitResp = await opts.pcc.submitJob(augmented);

  // If submitJob already returns an escrow id, use it; otherwise fund a
  // fresh one against the new job.
  let escrowId = submitResp.escrowId;
  let escrowAddress: string | undefined;
  if (!escrowId) {
    const fundResp = await opts.pcc.fundEscrow({
      jobId: submitResp.jobId,
      amount: opts.fundAmountUSDC,
      currency: "USDC",
    });
    escrowId = fundResp.escrowId;
    escrowAddress = fundResp.address;
  } else {
    const fundResp = await opts.pcc.fundEscrow({
      escrowId,
      amount: opts.fundAmountUSDC,
      currency: "USDC",
    });
    escrowAddress = fundResp.address;
  }

  return { pccJobId: submitResp.jobId, escrowId: escrowId!, escrowAddress };
}
