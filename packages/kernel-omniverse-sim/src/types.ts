/**
 * Sim-attestation result shape.
 *
 * The attestor wraps the runner's verdict in a signed envelope so the PCC
 * gateway can verify it independently. Signature scheme: Ed25519 over the
 * canonical JSON of `{result, runnerVersion, workflowHash, timestamp}`.
 */

export type SimVerdict = "pass" | "fail" | "infeasible";

export interface SimRunResult {
  verdict: SimVerdict;
  /** Sim wall-clock duration in ms. */
  durationMs: number;
  /** Errors detected during sim (collision, geometry, sequencing). */
  errors: SimError[];
  /** Step-by-step trace, ordered as in the workflow. */
  trace: SimStepTrace[];
  /** Optional summary metrics (volumes dispensed, plates moved, etc). */
  metrics?: Record<string, number>;
}

export interface SimError {
  kind:
    | "collision"
    | "out-of-bounds"
    | "missing-labware"
    | "missing-node"
    | "action-not-supported"
    | "physics-violation"
    | "sequencing"
    | "other";
  step: string;
  message: string;
}

export interface SimStepTrace {
  stepName: string;
  startMs: number;
  endMs: number;
  status: "ok" | "warn" | "fail";
  detail?: string;
}

export interface SimAttestation {
  /** The verdict + trace from the runner. */
  result: SimRunResult;
  /** Runner version (omniverse_kit + sim-driver). */
  runnerVersion: string;
  /** SHA-256 of the canonical MADSci workflow JSON, hex-encoded. */
  workflowHash: string;
  /** ISO-8601 UTC. */
  timestamp: string;
  /** Hex-encoded Ed25519 signature over the canonical envelope. */
  signature: string;
  /** Hex-encoded Ed25519 public key of the signer. */
  signerPublicKey: string;
}

export interface SimRunnerCapabilities {
  /** Reported by the runner — for an operator UI / diagnostics. */
  available: boolean;
  /** Omniverse Kit version if detected. */
  kitVersion?: string;
  /** Has RTX GPU access. */
  gpuRtx: boolean;
  /** Path to the Python interpreter the runner will spawn. */
  pythonPath?: string;
  /** Why we can't run, if available=false. */
  unavailableReason?: string;
}
