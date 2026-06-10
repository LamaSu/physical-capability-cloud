/**
 * Stage 3 — sim-attest the workflow.
 *
 * Delegates to @pcc/kernel-omniverse-sim. If the attestation comes back
 * verdict=fail, the orchestrator short-circuits before any escrow is
 * funded — this is the whole point of the pre-flight gate.
 */

import { attestWorkflow, verifyAttestation } from "@pcc/kernel-omniverse-sim";
import type { MadsciWorkflow } from "@pcc/adapter-madsci";
import type { SimAttestation } from "@pcc/kernel-omniverse-sim";

export interface AttestOptions {
  workflow: MadsciWorkflow;
  /** Hex-encoded Ed25519 secret key for the sim kernel. */
  secretKeyHex: string;
  runnerVersion?: string;
}

export class AttestationError extends Error {
  constructor(message: string, public readonly attestation?: SimAttestation) {
    super(message);
    this.name = "AttestationError";
  }
}

export async function attestStage(
  opts: AttestOptions,
): Promise<SimAttestation> {
  const att = await attestWorkflow({
    workflow: opts.workflow,
    secretKeyHex: opts.secretKeyHex,
    runnerVersion: opts.runnerVersion,
  });
  if (!verifyAttestation(att)) {
    throw new AttestationError(
      "self-verification failed — signing key/envelope mismatch",
      att,
    );
  }
  if (att.result.verdict !== "pass") {
    throw new AttestationError(
      `sim verdict=${att.result.verdict}: ${att.result.errors
        .map((e) => `${e.kind}@${e.step}: ${e.message}`)
        .join("; ")}`,
      att,
    );
  }
  return att;
}
