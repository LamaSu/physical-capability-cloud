/**
 * SEAM-2 — device-signed (#236) evidence → settlement wiring. READY BUT GATED.
 *
 * The operator node already produces real Ed25519-signed evidence bundles
 * (packages/kernel-sdk/src/job-handler.ts finalises + signs the bundleHash with
 * a device key). Two gateway paths currently discard that signature and anchor
 * settlement on a fabricated gateway placeholder instead:
 *   - operator-relay `POST /api/operator/evidence` stored the bundle with
 *     `kernelSignature.value:"operator-relay-auto"` (real Ed25519 sig dropped);
 *   - paid-job-flow `/complete` rebuilt the bundle and signed it with the ZERO
 *     address / `"gateway-auto-sign"`.
 *
 * This module builds the path by which a captured device bundle is verified
 * against the device's REGISTERED signer (#47 ident.registered_key, via
 * `normalizeRegisteredSigner`) and, ONLY when the gate is open, anchors
 * settlement on the DEVICE's own bundleHash + signature.
 *
 * THE GATE IS CLOSED BY CONSTRUCTION (money path — fails closed):
 *   1. `machine.execution_log` (#52) ships `verifierStatus:"stub"` and its
 *      oracle verifier fails closed (spec §8, verifiers/oracle-binding.ts). This
 *      module reads that live vocabulary status — it does NOT flip it. #233 stays
 *      stubbed until a real device clears #52 on deployed infra.
 *   2. An explicit opt-in flag (`SEAM2_DEVICE_EVIDENCE_SETTLEMENT`) defaults off.
 * Both must be true to route device evidence into settlement, so today the
 * mechanism is INERT: `resolveSettlementEvidence` always returns the gateway
 * fallback and `/complete` behaves exactly as before. The verify+route code
 * exists and is unit-tested so that when a real device clears #52 on deployed
 * infra, opening the gate (NOT done here) turns it on with no new code. The
 * post-deploy live proof is the harness rehearse-loop.mjs A6 rehearsal.
 *
 * SDK bundles use a per-job session key. This verifier authenticates the
 * principal-signed delegation, enforces expiry/action/job scope, and only then
 * verifies the bundle signature with the delegated session public key.
 */

import nacl from "tweetnacl";
import {
  normalizeRegisteredSigner,
  getPrimitive,
  type RegisteredSigner,
  type SessionKeyAuthorization,
  type SessionKey,
  type SessionSignedEvent,
} from "@pcc/spec";
import { SessionKeyService } from "@pcc/verifier";

// ── The signature shape stored on / carried by an evidence bundle ────────────

/** The `kernelSignature` shape (matches the DB `evidence_bundles` JSON column
 *  and the spec `Signature` type). */
export interface StoredSignature {
  signer: string;
  algorithm: string;
  value: string;
}

/** The zero address the gateway used as a placeholder signer. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Signature `value`s the gateway writes when it has NO real device signature.
 *  A bundle carrying one of these is a gateway placeholder, never device-signed
 *  and never eligible to anchor settlement. */
export const PLACEHOLDER_SIGNATURE_VALUES: ReadonlySet<string> = new Set([
  "operator-relay-auto", // legacy path-1 placeholder
  "gateway-auto-sign", // legacy path-2 placeholder
]);

/**
 * True iff `sig` is a REAL device (#236) Ed25519 signature, not a gateway/test
 * placeholder: ed25519 algorithm, a non-zero signer, and a `value` that is
 * neither a known gateway placeholder nor the emitter's `test_sig_` marker.
 * Fails closed on anything missing.
 */
export function isDeviceSignedSignature(sig: StoredSignature | null | undefined): boolean {
  if (!sig || typeof sig !== "object") return false;
  if (sig.algorithm !== "ed25519") return false;
  if (typeof sig.value !== "string" || sig.value.length === 0) return false;
  if (PLACEHOLDER_SIGNATURE_VALUES.has(sig.value)) return false;
  if (sig.value.startsWith("test_sig_")) return false;
  if (typeof sig.signer !== "string" || sig.signer.length === 0) return false;
  if (sig.signer.toLowerCase() === ZERO_ADDRESS) return false;
  return true;
}

// ── Path-1 parser: the node's signed bundle out of the relay body ────────────

/** The subset of a captured device bundle the settlement seam needs. */
export interface CapturedDeviceBundle {
  bundleHash: string;
  kernelSignature: StoredSignature;
  /** The node's DECLARED assurance tier (unverified at capture; the oracle #52
   *  verifier — gated — is what actually gates settlement on it). */
  assuranceTier: number;
  /** Full signer public key when the envelope carries it (the truncated
   *  `kernelSignature.signer` is not enough to verify an Ed25519 sig). Provenance
   *  only; verification uses the REGISTERED key, not this. */
  signerPublicKey?: string;
  /** Principal-authorised session key carried by SDK evidence bundles. */
  sessionKeyAuthorization?: SessionKeyAuthorization;
  /** Job/contract scope the delegation must match. */
  contractId?: string;
}

/** Coerce an unknown into a `StoredSignature` or null (fail closed). */
function asStoredSignature(input: unknown): StoredSignature | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (
    typeof o.signer === "string" &&
    typeof o.algorithm === "string" &&
    typeof o.value === "string"
  ) {
    return { signer: o.signer, algorithm: o.algorithm, value: o.value };
  }
  return null;
}

/**
 * Extract a real device-signed bundle from an operator-relay evidence body, or
 * null when none is present (old nodes / non-bundle evidence → caller keeps the
 * placeholder). Accepts the canonical EvidenceBundle shape (`kernelSignature` +
 * `bundleHash`), and tolerates a `bundle` wrapper and a `signature` alias. Only
 * returns non-null when the signature is a genuine device Ed25519 signature.
 */
export function extractNodeSignedBundle(evidence: unknown): CapturedDeviceBundle | null {
  if (!evidence || typeof evidence !== "object") return null;
  // Unwrap a `{ bundle: {...} }` envelope if present.
  const root = evidence as Record<string, unknown>;
  const b = (root.bundle && typeof root.bundle === "object" ? root.bundle : root) as Record<
    string,
    unknown
  >;

  const sig = asStoredSignature(b.kernelSignature) ?? asStoredSignature(b.signature);
  if (!sig || !isDeviceSignedSignature(sig)) return null;

  const bundleHash = typeof b.bundleHash === "string" ? b.bundleHash : undefined;
  if (!bundleHash) return null;

  const tierRaw = b.assuranceTier;
  const assuranceTier = typeof tierRaw === "number" && Number.isInteger(tierRaw) ? tierRaw : 0;

  const signerPublicKey =
    typeof b.kernelSessionPublicKey === "string"
      ? b.kernelSessionPublicKey
      : typeof b.signerPublicKey === "string"
        ? b.signerPublicKey
        : undefined;

  const sessionKeyAuthorization = asSessionKeyAuthorization(b.sessionKeyAuthorization);
  const contractId = typeof b.jobId === "string" ? b.jobId : undefined;

  return {
    bundleHash,
    kernelSignature: sig,
    assuranceTier,
    ...(signerPublicKey ? { signerPublicKey } : {}),
    ...(sessionKeyAuthorization ? { sessionKeyAuthorization } : {}),
    ...(contractId ? { contractId } : {}),
  };
}

function asSessionKeyAuthorization(input: unknown): SessionKeyAuthorization | undefined {
  if (!input || typeof input !== "object") return undefined;
  const a = input as Record<string, unknown>;
  const scope = a.scope as Record<string, unknown> | undefined;
  if (
    typeof a.sessionId !== "string" ||
    typeof a.parentAgentId !== "string" ||
    typeof a.publicKey !== "string" ||
    !/^(?:0x)?[0-9a-fA-F]{64}$/.test(a.publicKey) ||
    typeof a.issuedAt !== "number" ||
    typeof a.expiresAt !== "number" ||
    !scope ||
    !Array.isArray(scope.allowedActions) ||
    !scope.allowedActions.every((v) => typeof v === "string") ||
    !Array.isArray(scope.contractIds) ||
    !scope.contractIds.every((v) => typeof v === "string") ||
    typeof scope.maxSignatures !== "number" ||
    typeof a.parentSignature !== "string" ||
    !/^(?:0x)?[0-9a-fA-F]{128}$/.test(a.parentSignature)
  ) return undefined;
  return {
    sessionId: a.sessionId,
    parentAgentId: a.parentAgentId,
    publicKey: a.publicKey,
    issuedAt: a.issuedAt,
    expiresAt: a.expiresAt,
    scope: {
      allowedActions: scope.allowedActions as string[],
      contractIds: scope.contractIds as string[],
      maxSignatures: scope.maxSignatures,
    },
    parentSignature: a.parentSignature,
    ...(typeof a.derivationPath === "string" ? { derivationPath: a.derivationPath } : {}),
  };
}

/** The signer-identity columns persisted on a kernel row (see db schema
 *  `kernels.ts`): the proven registered signer, tagged by algorithm. */
export interface KernelSignerColumns {
  signingKeyAlgorithm?: string | null;
  signingKeyPublicKey?: string | null;
  signingAddress?: string | null;
}

/**
 * Build a `normalizeRegisteredSigner`-acceptable tagged input from a kernel's
 * persisted signer columns, or null when the kernel has no proven signer
 * (fail closed). ed25519 → the raw pubkey; secp256k1 → the EVM address.
 */
export function registeredSignerInputFromColumns(
  cols: KernelSignerColumns | null | undefined,
): { algorithm: "ed25519"; publicKey: string } | { algorithm: "secp256k1"; address: string } | null {
  if (!cols) return null;
  if (cols.signingKeyAlgorithm === "ed25519" && typeof cols.signingKeyPublicKey === "string") {
    return { algorithm: "ed25519", publicKey: cols.signingKeyPublicKey };
  }
  if (cols.signingKeyAlgorithm === "secp256k1" && typeof cols.signingAddress === "string") {
    return { algorithm: "secp256k1", address: cols.signingAddress };
  }
  return null;
}

// ── The verifier: registered-signer → (Ed25519 verify) ───────────────────────

/**
 * An injected Ed25519 verify: `(message, signatureHex, publicKeyHex) => bool`.
 * Injected (not hard-imported) so the mechanism is a pure function and the exact
 * crypto is swappable at the seam. `naclEd25519Verify` is the reference impl.
 */
export type VerifyEd25519 = (
  message: string,
  signatureValue: string,
  publicKeyHex: string,
) => boolean | Promise<boolean>;

function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/**
 * Reference Ed25519 verify using tweetnacl (the same primitive the node signs
 * with — kernel-sdk `verifyBundleSignature`). Message is UTF-8 bytes of the
 * bundleHash string; signature + public key are hex (optional 0x). Returns false
 * on any malformed input — never throws.
 */
export function naclEd25519Verify(
  message: string,
  signatureValue: string,
  publicKeyHex: string,
): boolean {
  try {
    const msg = new TextEncoder().encode(message);
    const sig = Buffer.from(stripHexPrefix(signatureValue), "hex");
    const pk = Buffer.from(stripHexPrefix(publicKeyHex), "hex");
    if (sig.length !== 64 || pk.length !== 32) return false;
    return nacl.sign.detached.verify(msg, sig, pk);
  } catch {
    return false;
  }
}

export interface DeviceEvidenceVerifyInput {
  /** The captured device bundle's signature. */
  signature: StoredSignature;
  /** The bundleHash the device signed over (the verify message). */
  bundleHash: string;
  /** The device's REGISTERED signer, as served on `KernelDTO.signingKey` (any
   *  `normalizeRegisteredSigner`-acceptable input). Verification is against THIS,
   *  not the self-declared `signature.signer`. */
  registeredSigner: unknown;
  /** Delegation required when the bundle was signed by an ephemeral session key. */
  sessionKeyAuthorization?: SessionKeyAuthorization;
  /** Job/contract id the session scope must explicitly contain. */
  contractId?: string;
  /** Injected Ed25519 verify (default `naclEd25519Verify`). */
  verifyEd25519?: VerifyEd25519;
}

export interface DeviceEvidenceVerifyResult {
  ok: boolean;
  reason?: string;
  /** The normalized registered signer the sig was checked against, on success. */
  signer?: RegisteredSigner;
}

/**
 * Verify a device-signed bundle against its REGISTERED Ed25519 signer (#47).
 * Fails CLOSED: any missing/malformed input, an unregistered or non-ed25519
 * signer, or an invalid signature → `ok:false`. This is the registered-signer →
 * verify leg that gates whether device evidence may anchor settlement.
 */
export async function verifyDeviceSignedEvidence(
  input: DeviceEvidenceVerifyInput,
): Promise<DeviceEvidenceVerifyResult> {
  const verifyEd25519 = input.verifyEd25519 ?? naclEd25519Verify;

  if (!isDeviceSignedSignature(input.signature)) {
    return { ok: false, reason: "not-device-signed" };
  }
  if (typeof input.bundleHash !== "string" || input.bundleHash.length === 0) {
    return { ok: false, reason: "missing-bundle-hash" };
  }
  const signer = normalizeRegisteredSigner(input.registeredSigner);
  if (!signer) return { ok: false, reason: "unregistered-signer" };
  if (signer.algorithm !== "ed25519") return { ok: false, reason: "signer-not-ed25519" };

  if (input.sessionKeyAuthorization) {
    if (!input.contractId) return { ok: false, reason: "missing-contract-id" };
    const auth = input.sessionKeyAuthorization;
    try {
      const sessionKey: SessionKey = {
        sessionId: auth.sessionId,
        parentAgentId: auth.parentAgentId as SessionKey["parentAgentId"],
        publicKey: Uint8Array.from(Buffer.from(stripHexPrefix(auth.publicKey), "hex")),
        issuedAt: auth.issuedAt,
        expiresAt: auth.expiresAt,
        scope: {
          allowedActions: auth.scope.allowedActions as SessionKey["scope"]["allowedActions"],
          contractIds: auth.scope.contractIds,
          maxSignatures: auth.scope.maxSignatures,
        },
        parentSignature: Uint8Array.from(Buffer.from(stripHexPrefix(auth.parentSignature), "hex")),
        ...(auth.derivationPath ? { derivationPath: auth.derivationPath } : {}),
      };
      if (sessionKey.publicKey.length !== 32 || sessionKey.parentSignature.length !== 64) {
        return { ok: false, reason: "malformed-session-authorization" };
      }
      if (!sessionKey.scope.contractIds.includes(input.contractId)) {
        return { ok: false, reason: "contract_not_allowed" };
      }
      const event: SessionSignedEvent = {
        eventData: new TextEncoder().encode(input.bundleHash),
        sessionSignature: Uint8Array.from(Buffer.from(stripHexPrefix(input.signature.value), "hex")),
        proof: {
          sessionKey,
          parentPublicKey: Uint8Array.from(Buffer.from(stripHexPrefix(signer.publicKey), "hex")),
          ...(auth.derivationPath ? { derivationPath: auth.derivationPath } : {}),
        },
      };
      const result = new SessionKeyService().verifySessionSignedEvent({
        event,
        action: "evidence_submit",
      });
      if (!result.valid) return { ok: false, reason: result.failures[0] ?? "delegation-invalid" };
      return { ok: true, signer };
    } catch {
      return { ok: false, reason: "malformed-session-authorization" };
    }
  }

  let valid: boolean;
  try {
    valid = await verifyEd25519(input.bundleHash, input.signature.value, signer.publicKey);
  } catch {
    return { ok: false, reason: "verify-threw" };
  }
  if (!valid) return { ok: false, reason: "signature-invalid" };
  return { ok: true, signer };
}

// ── The gate — CLOSED by construction ────────────────────────────────────────

/**
 * The #52 `machine.execution_log` verifier is the settlement gate (#233). It
 * ships `verifierStatus:"stub"` and fails closed (spec §8). This reads the REAL
 * vocabulary status; flipping #52 to `"live"` (NOT done here) is what would open
 * this leg of the gate.
 */
export function machineLogVerifierLive(): boolean {
  return getPrimitive("machine.execution_log")?.verifierStatus === "live";
}

/**
 * Explicit opt-in flag, defaulted OFF. Belt-and-suspenders on top of the stubbed
 * verifier: even once #52 goes live, settlement-on-device-evidence needs this
 * deliberate flag set to `"1"`.
 */
export function deviceEvidenceSettlementFlagEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.SEAM2_DEVICE_EVIDENCE_SETTLEMENT === "1";
}

/**
 * Composite gate: device evidence anchors settlement ONLY when BOTH the #52
 * verifier is live AND the explicit flag is set. Both default false, so this is
 * CLOSED today — the wiring is ready but inert (SEAM-2 ready-but-gated).
 */
export function deviceEvidenceSettlementEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return machineLogVerifierLive() && deviceEvidenceSettlementFlagEnabled(env);
}

// ── The settlement-evidence decision (what /complete calls) ───────────────────

export interface SettlementEvidenceSlot {
  bundleHash: string;
  kernelSignature: StoredSignature;
  assuranceTier: number;
  sessionKeyAuthorization?: SessionKeyAuthorization;
  contractId?: string;
}

export interface SettlementEvidenceInput {
  /** A device-signed bundle already captured for this job (path 1), if any. */
  deviceBundle: SettlementEvidenceSlot | null;
  /** The device's registered signer (from the kernel registry). */
  registeredSigner: unknown;
  /** The gateway's own rebuilt anchor (today's behavior). */
  fallback: SettlementEvidenceSlot;
  /** Injected Ed25519 verify (default `naclEd25519Verify`). */
  verifyEd25519?: VerifyEd25519;
  /** Gate override (default `deviceEvidenceSettlementEnabled(env)`). */
  gateOpen?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface SettlementEvidenceDecision extends SettlementEvidenceSlot {
  source: "device" | "gateway-fallback";
  reason?: string;
}

/**
 * Decide which evidence anchors settlement. When the gate is CLOSED (default)
 * this ALWAYS returns the gateway fallback — identical to today's behavior, so
 * the money path is unchanged. When the gate is OPEN and a device bundle verifies
 * against its registered signer, it anchors on the DEVICE's real hash +
 * signature. Fails closed to the fallback on any verify failure.
 */
export async function resolveSettlementEvidence(
  input: SettlementEvidenceInput,
): Promise<SettlementEvidenceDecision> {
  const gateOpen = input.gateOpen ?? deviceEvidenceSettlementEnabled(input.env);
  if (!gateOpen) {
    return { ...input.fallback, source: "gateway-fallback", reason: "gate-closed" };
  }
  if (!input.deviceBundle) {
    return { ...input.fallback, source: "gateway-fallback", reason: "no-device-bundle" };
  }
  const verified = await verifyDeviceSignedEvidence({
    signature: input.deviceBundle.kernelSignature,
    bundleHash: input.deviceBundle.bundleHash,
    registeredSigner: input.registeredSigner,
    ...(input.deviceBundle.sessionKeyAuthorization
      ? { sessionKeyAuthorization: input.deviceBundle.sessionKeyAuthorization }
      : {}),
    ...(input.deviceBundle.contractId ? { contractId: input.deviceBundle.contractId } : {}),
    ...(input.verifyEd25519 ? { verifyEd25519: input.verifyEd25519 } : {}),
  });
  if (!verified.ok) {
    return { ...input.fallback, source: "gateway-fallback", reason: verified.reason ?? "verify-failed" };
  }
  return {
    source: "device",
    bundleHash: input.deviceBundle.bundleHash,
    kernelSignature: input.deviceBundle.kernelSignature,
    assuranceTier: input.deviceBundle.assuranceTier,
  };
}
