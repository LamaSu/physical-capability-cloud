/**
 * Sim-attestation as a PCC kernel — one capability ("sim-attest/v1") that
 * accepts a MADSci workflow and returns a signed SimAttestation.
 *
 * Use this kernel as a milestone gate ahead of any execution kernel:
 * fund-escrow → sim-attest → (if pass) → release-funds-to-exec → execute.
 */

import { buildManifest, type ManifestBuilderInput } from "@pcc/kernel-sdk";
import type { DigitalKernelManifest } from "@pcc/spec";
import { runSim } from "./runner.js";
import { signAttestation } from "./attestation.js";
import type { MadsciWorkflow } from "@pcc/adapter-madsci";
import type { SimAttestation } from "./types.js";

export interface SimKernelOptions {
  kernelId: string;
  name: string;
  builder: ManifestBuilderInput["builder"];
  endpointURL: string;
  touchstoneLibraryId: string;
  /** Tier this kernel can offer (typically 1 — verified via signed attestation). */
  maxAssuranceTier?: 0 | 1 | 2 | 3;
}

export function buildSimKernelManifest(
  opts: SimKernelOptions,
): DigitalKernelManifest {
  return buildManifest({
    kernelId: opts.kernelId,
    name: opts.name,
    description:
      "Digital-twin pre-flight attestation via NVIDIA Omniverse Kit. Returns a signed SimAttestation over a MADSci workflow.",
    builder: opts.builder,
    capabilityType: "sim-attest/v1",
    workflowSteps: [
      {
        stepId: "sim-attest",
        stepType: "validate",
        description:
          "Simulate workflow — replay MADSci workflow against a USD scene in headless Omniverse Kit",
        dependsOn: [],
      },
    ],
    maxAssuranceTier: opts.maxAssuranceTier ?? 1,
    touchstoneLibraryId: opts.touchstoneLibraryId,
    endpointURL: opts.endpointURL,
  });
}

export interface SimAttestRequest {
  workflow: MadsciWorkflow;
  /** Hex-encoded Ed25519 secret key. Pulled from kernel session-key store. */
  secretKeyHex: string;
  /** Runner version string for the envelope. */
  runnerVersion?: string;
}

/**
 * Run sim + sign. The PCC-side job handler for this kernel calls this
 * function and returns the SimAttestation as the job's evidence payload.
 */
export async function attestWorkflow(
  req: SimAttestRequest,
): Promise<SimAttestation> {
  const result = await runSim(req.workflow);
  return signAttestation({
    result,
    workflow: req.workflow,
    runnerVersion: req.runnerVersion ?? "omniverse-kit/stub-0.1",
    secretKeyHex: req.secretKeyHex,
  });
}
