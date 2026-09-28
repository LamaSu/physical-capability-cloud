/**
 * Onboarding readiness, derived from canonical rows (ADK D4(a), PX-10/R40;
 * interface agreed with gateway in bus #2622).
 *
 * GET /api/operators/:slug/status used to call an operator "ready" once a
 * kernel, a capability and a channel existed. Nothing checked that a device
 * could execute or that any run had produced real evidence, so an operator
 * with only a mock device and a self-attested setup test read as ready.
 *
 * These helpers answer two questions from rows the server already holds:
 *
 *   1. Can a registered device execute real work? It must be a machine whose
 *      adapter the kernel can build, and not the simulator or the generic-http
 *      refusal.
 *   2. Has a real run happened? A completed job on one of the operator's
 *      kernels must carry evidence whose device signature verifies against
 *      that kernel's REGISTERED signer (#47), checked with the SEAM-2 verifier
 *      in device-evidence-settlement.ts. That proves the node's pipeline and
 *      key, not the hardware: hardware assurance stays with the evidence tiers
 *      and the oracle, and nothing here touches the settlement gate.
 *
 * The setup test job (POST /api/setup/test-job) cannot satisfy (2) today: a
 * kernel with no registered device gets a self-attested bundle, and a kernel
 * with devices runs on the gateway's in-process KernelService, whose emitter
 * signs with the zero-address test key.
 *
 * Only classes, flags and counts leave this module; keys, signatures and job
 * ids never do.
 */

import type { SessionKeyAuthorization } from "@pcc/spec";
import {
  isDeviceSignedSignature,
  PLACEHOLDER_SIGNATURE_VALUES,
  registeredSignerInputFromColumns,
  verifyDeviceSignedEvidence,
  ZERO_ADDRESS,
  type KernelSignerColumns,
  type VerifyEd25519,
} from "./device-evidence-settlement.js";

// ── Devices ──────────────────────────────────────────────────────────────────

/** Machine adapters that never execute real work: the simulator and the refusal. */
export const NON_EXECUTING_ADAPTERS: ReadonlySet<string> = new Set(["mock", "generic-http"]);

export type DeviceReadiness =
  | { executable: true }
  | {
      executable: false;
      reason: "not_a_machine" | "no_adapter" | "non_executing_adapter" | "unknown_adapter";
    };

/**
 * Whether a registered device can execute real work. Only machines execute
 * jobs; sensors and cameras observe. `buildableMachineAdapters` is the
 * kernel's machine-adapter registry (listRegisteredMachineAdapters()).
 */
export function deviceReadiness(
  device: { type: string | null | undefined; adapterType: string | null | undefined },
  buildableMachineAdapters: readonly string[],
): DeviceReadiness {
  if (device.type !== "machine") return { executable: false, reason: "not_a_machine" };
  const adapter = device.adapterType;
  if (!adapter) return { executable: false, reason: "no_adapter" };
  if (NON_EXECUTING_ADAPTERS.has(adapter)) return { executable: false, reason: "non_executing_adapter" };
  if (!buildableMachineAdapters.includes(adapter)) return { executable: false, reason: "unknown_adapter" };
  return { executable: true };
}

// ── Evidence ─────────────────────────────────────────────────────────────────

/** What a stored signature is, before any verification. */
export type StoredSignatureClass =
  | "device-signed" // a real-looking device Ed25519 signature (isDeviceSignedSignature)
  | "unverifiable" // some other signature this route cannot check (e.g. secp256k1)
  | "test-key" // the emitter's test-only key: zero-address signer or a test_sig_ value
  | "gateway-placeholder" // written by the gateway when no device signature arrived
  | "self-attest" // the setup route's self-attested bundle (algorithm "none")
  | "none";

/** What a run's evidence proves, after verification. */
export type EvidenceClass =
  | "verified" // a device signature that verifies against the kernel's registered signer
  | "invalid" // a device signature that does NOT verify against the registered signer
  | "unregistered-signer" // a device signature, but the kernel has no proven signing key
  | Exclude<StoredSignatureClass, "device-signed">;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Classify a stored `kernelSignature` without verifying it. Never throws. */
export function classifyStoredSignature(signature: unknown): StoredSignatureClass {
  if (!signature || typeof signature !== "object") return "none";
  const raw = signature as Record<string, unknown>;
  const sig = { signer: str(raw.signer), algorithm: str(raw.algorithm), value: str(raw.value) };
  if (!sig.signer && !sig.algorithm && !sig.value) return "none";
  if (sig.algorithm === "none" || sig.signer === "self-attest") return "self-attest";
  if (PLACEHOLDER_SIGNATURE_VALUES.has(sig.value) || sig.algorithm === "sha256") return "gateway-placeholder";
  if (sig.signer.toLowerCase() === ZERO_ADDRESS || sig.value.startsWith("test_sig_")) return "test-key";
  if (isDeviceSignedSignature(sig)) return "device-signed";
  return "unverifiable";
}

export interface StoredBundle {
  bundleHash: string;
  kernelSignature: unknown;
  sessionKeyAuthorization?: unknown;
}

/**
 * What one evidence bundle proves about a run on `kernelSigner`'s kernel.
 * Verification is against the kernel's REGISTERED signer, never the signer the
 * bundle names; a session-key bundle must be scoped to `jobId`.
 */
export async function assessBundle(
  bundle: StoredBundle,
  jobId: string,
  kernelSigner: KernelSignerColumns | null | undefined,
  verifyEd25519?: VerifyEd25519,
): Promise<EvidenceClass> {
  const stored = classifyStoredSignature(bundle.kernelSignature);
  if (stored !== "device-signed") return stored;
  const registeredSigner = registeredSignerInputFromColumns(kernelSigner);
  if (!registeredSigner) return "unregistered-signer";
  if (registeredSigner.algorithm !== "ed25519") return "unverifiable";
  const result = await verifyDeviceSignedEvidence({
    signature: bundle.kernelSignature as { signer: string; algorithm: string; value: string },
    bundleHash: bundle.bundleHash,
    registeredSigner,
    ...(bundle.sessionKeyAuthorization
      ? { sessionKeyAuthorization: bundle.sessionKeyAuthorization as SessionKeyAuthorization }
      : {}),
    contractId: jobId,
    ...(verifyEd25519 ? { verifyEd25519 } : {}),
  });
  if (result.ok) return "verified";
  return result.reason === "unregistered-signer" ? "unregistered-signer" : "invalid";
}

/** Most informative first: a verified run, then problems worth fixing, then weaker evidence. */
const EVIDENCE_RANK: Record<EvidenceClass, number> = {
  verified: 7,
  invalid: 6,
  "unregistered-signer": 5,
  unverifiable: 4,
  "test-key": 3,
  "gateway-placeholder": 2,
  "self-attest": 1,
  none: 0,
};

export function strongestEvidence(classes: readonly EvidenceClass[]): EvidenceClass {
  let best: EvidenceClass = "none";
  for (const c of classes) if (EVIDENCE_RANK[c] > EVIDENCE_RANK[best]) best = c;
  return best;
}

// ── Readiness ────────────────────────────────────────────────────────────────

export interface RunObservation {
  status: string;
  /** The strongest class among the run's evidence bundles. */
  evidence: EvidenceClass;
}

export interface OnboardingReadiness {
  /** Registered devices on the operator's kernels, and how many can execute real work. */
  devices: { registered: number; executable: number };
  /** At least one registered machine has an adapter the kernel can build that is not the simulator or the refusal. */
  adapterReady: boolean;
  /** A completed job on one of the operator's kernels has evidence that verifies against the kernel's registered signer. */
  verifiedRun: boolean;
  /** The strongest evidence among the completed runs examined ("none" when there are none). */
  runEvidence: EvidenceClass;
  /** The evidence of the most recent setup test job ("none" when there is none). */
  setupTestEvidence: EvidenceClass;
  /** Payout destinations are not supported until R41; this never reports ready. */
  payout: "not_supported";
  /** Open job offers for the operator's capability types; null when the offer store is unavailable. */
  openOffers: number | null;
}

export function computeOnboardingReadiness(input: {
  devices: ReadonlyArray<{ type: string | null | undefined; adapterType: string | null | undefined }>;
  buildableMachineAdapters: readonly string[];
  /** Completed runs examined, any order. */
  runs: readonly RunObservation[];
  latestSetupTest: RunObservation | null;
  openOffers: number | null;
}): OnboardingReadiness {
  const executable = input.devices.filter(
    (d) => deviceReadiness(d, input.buildableMachineAdapters).executable,
  ).length;
  const completed = input.runs.filter((r) => r.status === "completed");
  const offers = input.openOffers;
  return {
    devices: { registered: input.devices.length, executable },
    adapterReady: executable > 0,
    verifiedRun: completed.some((r) => r.evidence === "verified"),
    runEvidence: strongestEvidence(completed.map((r) => r.evidence)),
    setupTestEvidence: input.latestSetupTest?.evidence ?? "none",
    payout: "not_supported",
    openOffers: offers === null || !Number.isFinite(offers) ? null : Math.max(0, Math.floor(offers)),
  };
}

const RUN_EVIDENCE_HINT: Record<EvidenceClass, string> = {
  verified: "",
  invalid: "device-signed evidence was found, but its signature does not verify against the kernel's registered key",
  "unregistered-signer": "device-signed evidence was found, but no signing key is registered for the kernel (pcc-node registers one at start)",
  unverifiable: "the evidence found is signed with a key this check cannot verify",
  "test-key": "the evidence found is signed with a test key",
  "gateway-placeholder": "the evidence found carries a gateway placeholder, not a device signature",
  "self-attest": "the evidence found is self-attested",
  none: "no completed job has evidence yet",
};

/** Human-readable gaps, in the same voice as the route's existing `missing` list. */
export function readinessGaps(readiness: OnboardingReadiness): string[] {
  const gaps: string[] = [];
  if (readiness.devices.registered > 0 && readiness.devices.executable === 0) {
    gaps.push(
      `device adapter — none of the ${readiness.devices.registered} registered devices can execute real work (mock, generic-http, sensors, cameras and adapters the kernel cannot build do not count); register the machine with its real adapter`,
    );
  }
  if (!readiness.verifiedRun) {
    const setupNote =
      readiness.setupTestEvidence === "none"
        ? ""
        : "; a setup test job does not count, because it self-attests or runs on the gateway with a test key";
    gaps.push(
      `verified run — no completed job on this operator's kernels has evidence that verifies against the kernel's registered signing key: ${RUN_EVIDENCE_HINT[readiness.runEvidence]}${setupNote}`,
    );
  }
  return gaps;
}
