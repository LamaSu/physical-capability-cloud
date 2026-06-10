/**
 * @pcc/kernel-omniverse-sim — digital-twin pre-flight attestation kernel.
 *
 * Wraps PRISM-style Stage-2 simulation as a PCC capability. The runner
 * shells out to a Python helper (Omniverse Kit headless) which replays
 * the MADSci workflow against a USD scene and returns a verdict. The
 * verdict is signed (Ed25519) into a SimAttestation and returned to the
 * PCC gateway as evidence.
 *
 * Public surface:
 *   detectCapabilities()             — runtime probe (RTX? Kit version?)
 *   runSim(workflow, opts)           — execute sim, return verdict
 *   signAttestation({result, ...})   — wrap verdict in signed envelope
 *   verifyAttestation(att)           — verify signature
 *   buildSimKernelManifest(opts)     — DigitalKernelManifest for PCC
 *   attestWorkflow(req)              — sim + sign in one call
 */

export { detectCapabilities, runSim } from "./runner.js";
export type { RunnerOptions } from "./runner.js";

export {
  signAttestation,
  verifyAttestation,
  hashWorkflow,
} from "./attestation.js";
export type { SignAttestationOptions } from "./attestation.js";

export { buildSimKernelManifest, attestWorkflow } from "./kernel.js";
export type { SimKernelOptions, SimAttestRequest } from "./kernel.js";

export type {
  SimVerdict,
  SimRunResult,
  SimError,
  SimStepTrace,
  SimAttestation,
  SimRunnerCapabilities,
} from "./types.js";

export const OMNIVERSE_COUPLING_STATUS = {
  runner: "stub-mode (deterministic) + real-mode (env: OMNIVERSE_AVAILABLE=1)",
  realModeNeeds: ["RTX GPU", "NVIDIA Omniverse Kit license", "USD lab scene"],
  contact: "developer-relations@nvidia.com (Isaac Sim for Healthcare track)",
} as const;
