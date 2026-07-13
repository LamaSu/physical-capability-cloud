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
import type { SessionRevocationRecord } from "./session-revocation-store.js";

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

/**
 * Default permitted skew (SECONDS) between the device's ADVISORY `createdAt` and
 * the authoritative `effectiveEvidenceTime` (§8.4-A: `|deviceCreatedAt −
 * effectiveEvidenceTime| ≤ permittedSkew` as a flag/policy input; §8.6 suggests a
 * 5-minute default). This is an OWNER-POLICY value, tunable per
 * `assurancePolicyVersion` — callers may override via `permittedSkewSeconds`. It
 * is a NAMED default here, never a bare literal. In this cut the skew check is a
 * FLAG ONLY (surfaced for policy on the verify result); hard-reject-on-skew is an
 * owner policy toggle that is DEFAULT OFF and not wired here.
 */
export const DEFAULT_PERMITTED_SKEW_SECONDS = 300;

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
  /**
   * Session-key revocations (Unix SECONDS), from the shared revocation store
   * (§8.5-2). Consulted ONLY on the session-key branch. A revocation disqualifies
   * the signing session iff it took effect BEFORE `effectiveEvidenceTime` (strict
   * `<`, §7.3-4). Absent/empty → no revocation disqualifies (unchanged behavior).
   */
  revocations?: SessionRevocationRecord[];
  /**
   * The AUTHORITATIVE evidence-time (Unix SECONDS) that validity is judged at
   * (§7.3-4 / §8.4-A / §8.5-4). This is the ONE value used for BOTH the session-key
   * EXPIRY check (`notBefore(issuedAt) ≤ effectiveEvidenceTime ≤ expiresAt`, via
   * `verifySessionSignedEvent.currentTimestamp`) AND the step-2 revocation filter
   * (`revokedAt < effectiveEvidenceTime`) — never settlement wall-clock-now, never
   * the device's raw `createdAt` (§3.1 CVE-2024-55655 fix: check the timestamp
   * against cert validity using the LOG's/gateway's time, not the signer's claim).
   * Sourced from the gateway `receivedAt` (§7.1). REQUIRED on the delegated
   * (session-key) path — omitting it there returns `missing-effective-evidence-time`
   * rather than fabricating one from settlement wall-clock. On the non-delegated
   * direct-Ed25519 path (nothing time-judged) it defaults to now when omitted, which
   * keeps legacy direct callers/tests unchanged.
   */
  effectiveEvidenceTime?: number;
  /**
   * The device's ADVISORY `createdAt` (Unix SECONDS), when available. Used ONLY to
   * compute the skew flag `|deviceCreatedAt − effectiveEvidenceTime| ≤ permittedSkew`
   * (§8.4-A). It is ADVISORY — never the validity time itself, never trusted for
   * expiry/revocation. Omitted → no skew flag is computed.
   */
  deviceCreatedAt?: number;
  /**
   * Owner-policy override (Unix SECONDS) for the permitted device-clock skew;
   * defaults to `DEFAULT_PERMITTED_SKEW_SECONDS`. Tunable per `assurancePolicyVersion`.
   */
  permittedSkewSeconds?: number;
}

export interface DeviceEvidenceVerifyResult {
  ok: boolean;
  reason?: string;
  /** The normalized registered signer the sig was checked against, on success. */
  signer?: RegisteredSigner;
  /**
   * The absolute skew (SECONDS) between the ADVISORY device `createdAt` and the
   * authoritative `effectiveEvidenceTime` (§8.4-A). Present only when a device
   * `createdAt` was supplied. A standing anomaly signal, independent of `ok`.
   */
  skewSeconds?: number;
  /**
   * Whether `skewSeconds ≤ permittedSkew` (§8.6 owner policy, default
   * `DEFAULT_PERMITTED_SKEW_SECONDS`). Present only when a device `createdAt` was
   * supplied. FLAG ONLY — this does NOT gate `ok` in this cut (hard-reject-on-skew
   * is an owner toggle, default off).
   */
  skewWithinPolicy?: boolean;
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

  // §8.5-4 — resolve the ONE authoritative evidence time (Unix SECONDS) up front.
  // It is used for BOTH the session-key EXPIRY check (passed as currentTimestamp to
  // verifySessionSignedEvent below) AND the step-2 revocation filter — unified, so
  // the two can never diverge.
  //
  // The DELEGATED (session-key) live path REQUIRES an explicit trusted evidence time
  // (the gateway receipt time, §7.1 receivedAt). Fabricating one from settlement
  // wall-clock (Date.now() at settlement) is a fail-open: a since-expired or
  // since-revoked delegation would then verify as if it were still fresh. So on the
  // session-key branch a missing effectiveEvidenceTime is a caller error, returned
  // CLOSED. The `?? now` fallback is retained ONLY for the non-delegated direct-Ed25519
  // path, where nothing is time-judged (no expiry, no revocation) and legacy direct
  // callers/tests legitimately omit it.
  if (input.sessionKeyAuthorization && input.effectiveEvidenceTime === undefined) {
    return { ok: false, reason: "missing-effective-evidence-time" };
  }
  const evidenceTime = input.effectiveEvidenceTime ?? Math.floor(Date.now() / 1000);

  // §8.4-A skew FLAG (advisory): |deviceCreatedAt − effectiveEvidenceTime| ≤ permittedSkew.
  // deviceCreatedAt stays ADVISORY — never the validity time, never trusted for expiry.
  // FLAG ONLY: it never gates `ok` in this cut (hard-reject-on-skew is an owner toggle,
  // default off — §8.6). Computed only when a device createdAt was supplied, then spread
  // onto every subsequent return so callers always see the standing anomaly signal.
  const permittedSkew = input.permittedSkewSeconds ?? DEFAULT_PERMITTED_SKEW_SECONDS;
  const skewFields: Pick<DeviceEvidenceVerifyResult, "skewSeconds" | "skewWithinPolicy"> =
    typeof input.deviceCreatedAt === "number"
      ? {
          skewSeconds: Math.abs(input.deviceCreatedAt - evidenceTime),
          skewWithinPolicy: Math.abs(input.deviceCreatedAt - evidenceTime) <= permittedSkew,
        }
      : {};

  if (input.sessionKeyAuthorization) {
    if (!input.contractId) return { ok: false, reason: "missing-contract-id", ...skewFields };
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
        return { ok: false, reason: "malformed-session-authorization", ...skewFields };
      }
      if (!sessionKey.scope.contractIds.includes(input.contractId)) {
        return { ok: false, reason: "contract_not_allowed", ...skewFields };
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
      // §8.5-4 — BOTH the EXPIRY check and the revocation filter are now keyed to the
      // single authoritative `evidenceTime` (hoisted above). This is the CVE-2024-55655
      // fix (§3.1): validity is `notBefore(issuedAt) ≤ effectiveEvidenceTime ≤ expiresAt`,
      // judged at EVIDENCE time using the gateway's clock (§7.1 receivedAt), never at
      // settlement wall-clock-now, never on the signer's raw `createdAt` claim.
      // Revocation (§7.3-4 / §8.4-A step 6): a session-key revocation disqualifies iff the
      // key was revoked BEFORE the effective evidence time (strict `<`): "revokedAt <
      // effectiveEvidenceTime → invalid; else prior evidence stands". Pre-filtering the
      // revocation set here (rather than relying on the verifier's own clock) is what makes
      // check-5 time-aware; passing currentTimestamp makes check-3 (expiry) time-aware.
      const revokedSessionIds =
        input.revocations && input.revocations.length > 0
          ? new Set(
              input.revocations
                .filter((r) => r.revokedAt < evidenceTime)
                .map((r) => r.sessionId),
            )
          : undefined;
      const result = new SessionKeyService().verifySessionSignedEvent({
        event,
        action: "evidence_submit",
        currentTimestamp: evidenceTime,
        ...(revokedSessionIds ? { revokedSessionIds } : {}),
      });
      if (!result.valid)
        return { ok: false, reason: result.failures[0] ?? "delegation-invalid", ...skewFields };
      return { ok: true, signer, ...skewFields };
    } catch {
      return { ok: false, reason: "malformed-session-authorization", ...skewFields };
    }
  }

  let valid: boolean;
  try {
    valid = await verifyEd25519(input.bundleHash, input.signature.value, signer.publicKey);
  } catch {
    return { ok: false, reason: "verify-threw", ...skewFields };
  }
  if (!valid) return { ok: false, reason: "signature-invalid", ...skewFields };
  return { ok: true, signer, ...skewFields };
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
  /**
   * The device's ADVISORY `createdAt` (Unix SECONDS), when the captured bundle
   * carries one. Passed through to the skew flag (§8.4-A) — ADVISORY only, never
   * the validity time. Distinct from the gateway `effectiveEvidenceTime`.
   */
  deviceCreatedAt?: number;
}

export interface SettlementEvidenceInput {
  /** A device-signed bundle already captured for this job (path 1), if any. */
  deviceBundle: SettlementEvidenceSlot | null;
  /** The device's registered signer (from the kernel registry). */
  registeredSigner: unknown;
  /** The gateway's own rebuilt anchor (today's behavior). */
  fallback: SettlementEvidenceSlot;
  /** The purchased/contracted assurance tier for this job. Tier >= 1 REQUIRES real
   *  device evidence: with the gate open, a missing bundle or a verify failure at
   *  tier >= 1 HOLDS settlement (§8.5-1 / §7.3-3) rather than silently downgrading
   *  onto the gateway placeholder. Tier 0 (self-attested) keeps the buyer-approved
   *  gateway fallback, exactly as before. */
  requestedTier: number;
  /** Injected Ed25519 verify (default `naclEd25519Verify`). */
  verifyEd25519?: VerifyEd25519;
  /**
   * Session-key revocations (Unix SECONDS) from the shared store (§8.5-2), passed
   * through to `verifyDeviceSignedEvidence`. Only affects the session-key branch.
   */
  revocations?: SessionRevocationRecord[];
  /**
   * The AUTHORITATIVE evidence-time (Unix SECONDS) validity is judged at — used for
   * BOTH expiry and revocation (§7.3-4 / §8.4-A / §8.5-4). Sourced from the gateway
   * `receivedAt` (§7.1). Passed through to verifyDeviceSignedEvidence.
   */
  effectiveEvidenceTime?: number;
  /** Owner-policy override (Unix SECONDS) for the skew flag; defaults to
   *  `DEFAULT_PERMITTED_SKEW_SECONDS`. Passed through to verifyDeviceSignedEvidence. */
  permittedSkewSeconds?: number;
  /** Gate override (default `deviceEvidenceSettlementEnabled(env)`). */
  gateOpen?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface SettlementEvidenceDecision extends SettlementEvidenceSlot {
  /** `"device"` = anchored on the device's own verified hash + signature.
   *  `"gateway-fallback"` = anchored on the gateway placeholder (gate closed, or a
   *  tier-0 buyer-approved fallback). `"hold"` = the purchased tier (>= 1) required
   *  device evidence that did not verify; settlement HOLDS and does NOT anchor. */
  source: "device" | "gateway-fallback" | "hold";
  reason?: string;
  /** Skew flag (§8.4-A), surfaced from the device verify when a device `createdAt`
   *  was available. Advisory/policy signal only — never gates settlement here. */
  skewSeconds?: number;
  skewWithinPolicy?: boolean;
}

/**
 * Decide which evidence anchors settlement.
 *
 * When the gate is CLOSED (the default in every current env) this ALWAYS returns
 * the gateway fallback — identical to today's behavior, so the live money path is
 * byte-identical and tier-agnostic.
 *
 * When the gate is OPEN (SEAM-2 live):
 *   - a device bundle that verifies against its registered signer anchors on the
 *     DEVICE's real hash + signature (`source:"device"`);
 *   - if the purchased tier is >= 1 and the required device evidence is MISSING or
 *     FAILS to verify, settlement HOLDS (`source:"hold"`) — it is NOT silently
 *     downgraded onto the gateway placeholder (§8.5-1, §7.3-3, §8.4-C). HOLD means
 *     "do not anchor settlement on the gateway placeholder when the purchased tier
 *     (>= 1) required real device evidence that did not verify": the money holds in
 *     escrow — it does not move and it does not auto-refund. The caller surfaces the
 *     hold; supplement / buyer-accept / Mode-C-D dispute are later, owner-gated steps;
 *   - at tier 0 (self-attested) a missing/failed device bundle keeps the
 *     buyer-approved gateway fallback (`source:"gateway-fallback"`), exactly as before.
 */
export async function resolveSettlementEvidence(
  input: SettlementEvidenceInput,
): Promise<SettlementEvidenceDecision> {
  const gateOpen = input.gateOpen ?? deviceEvidenceSettlementEnabled(input.env);
  if (!gateOpen) {
    // Gate CLOSED — the inert default. Unchanged, tier-agnostic: the live money
    // path stays byte-identical to today regardless of the purchased tier.
    return { ...input.fallback, source: "gateway-fallback", reason: "gate-closed" };
  }
  // Gate OPEN. Tier >= 1 required real device evidence, so a missing bundle or a
  // verify failure HOLDS (never a silent downgrade). Tier 0 keeps the fallback.
  const holdWhenEvidenceInsufficient = input.requestedTier >= 1;
  if (!input.deviceBundle) {
    return holdWhenEvidenceInsufficient
      ? { ...input.fallback, source: "hold", reason: "no-device-bundle" }
      : { ...input.fallback, source: "gateway-fallback", reason: "no-device-bundle" };
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
    // §8.5-2: revocation state + §8.5-4: authoritative evidence-time (both consulted on
    // the session-key branch: revocation filter + expiry check share the one value).
    ...(input.revocations ? { revocations: input.revocations } : {}),
    ...(input.effectiveEvidenceTime !== undefined
      ? { effectiveEvidenceTime: input.effectiveEvidenceTime }
      : {}),
    // §8.4-A skew flag inputs (advisory device createdAt + owner-policy skew bound).
    ...(input.deviceBundle.deviceCreatedAt !== undefined
      ? { deviceCreatedAt: input.deviceBundle.deviceCreatedAt }
      : {}),
    ...(input.permittedSkewSeconds !== undefined
      ? { permittedSkewSeconds: input.permittedSkewSeconds }
      : {}),
  });
  // Skew flag is a standing signal independent of the verify verdict — surface it on
  // every post-verify decision (device / hold / fallback-on-failure).
  const skewOut: Pick<SettlementEvidenceDecision, "skewSeconds" | "skewWithinPolicy"> = {
    ...(verified.skewSeconds !== undefined ? { skewSeconds: verified.skewSeconds } : {}),
    ...(verified.skewWithinPolicy !== undefined
      ? { skewWithinPolicy: verified.skewWithinPolicy }
      : {}),
  };
  if (!verified.ok) {
    return holdWhenEvidenceInsufficient
      ? { ...input.fallback, source: "hold", reason: verified.reason ?? "verify-failed", ...skewOut }
      : {
          ...input.fallback,
          source: "gateway-fallback",
          reason: verified.reason ?? "verify-failed",
          ...skewOut,
        };
  }
  return {
    source: "device",
    bundleHash: input.deviceBundle.bundleHash,
    kernelSignature: input.deviceBundle.kernelSignature,
    assuranceTier: input.deviceBundle.assuranceTier,
    ...skewOut,
  };
}
