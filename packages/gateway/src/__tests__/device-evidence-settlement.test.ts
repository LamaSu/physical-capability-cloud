/**
 * SEAM-2 — device-signed (#236) evidence → settlement wiring. READY BUT GATED.
 *
 * These unit tests prove three things the task requires:
 *   1. GATE HOLDS — with the #52 machine.execution_log verifier stubbed/fail-closed
 *      (the real default), settlement does NOT auto-anchor device evidence, even
 *      with the opt-in flag set.
 *   2. WIRING CORRECT — with the gate open (verifier mocked to pass, and again with
 *      REAL tweetnacl Ed25519), a device signature flows registered-signer →
 *      settlement anchor (what /complete feeds to driveSettlement).
 *   3. GATE UNTOUCHED — machine.execution_log (and #53-#55) verifierStatus is still
 *      "stub"; #233 is not flipped.
 * Plus: the path-1 parser, isDeviceSignedSignature, and fail-closed behavior.
 */

import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { getPrimitive } from "@pcc/spec";
import { createKernelHandler } from "@pcc/kernel-sdk";
import {
  isDeviceSignedSignature,
  extractNodeSignedBundle,
  verifyDeviceSignedEvidence,
  naclEd25519Verify,
  resolveSettlementEvidence,
  registeredSignerInputFromColumns,
  machineLogVerifierLive,
  deviceEvidenceSettlementFlagEnabled,
  deviceEvidenceSettlementEnabled,
  ZERO_ADDRESS,
  type StoredSignature,
  type SettlementEvidenceSlot,
} from "../services/device-evidence-settlement.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BUNDLE_HASH = `sha256:${"ab".repeat(32)}`;
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** A real device keypair + a genuine Ed25519 signature over BUNDLE_HASH, in the
 *  exact wire form the node produces (kernel-sdk job-handler): hex sig, "0x"+hex
 *  pubkey, message = UTF-8 bytes of the bundleHash string. */
function realDeviceEvidence(bundleHash = BUNDLE_HASH) {
  const kp = nacl.sign.keyPair();
  const msg = new TextEncoder().encode(bundleHash);
  const sig = nacl.sign.detached(msg, kp.secretKey);
  const publicKeyHex = `0x${toHex(kp.publicKey)}`;
  const signature: StoredSignature = {
    // The node truncates the pubkey to an EVM-looking signer; verification uses
    // the REGISTERED key, not this field.
    signer: `0x${toHex(kp.publicKey).slice(0, 40)}`,
    algorithm: "ed25519",
    value: toHex(sig),
  };
  return { bundleHash, signature, publicKeyHex, keyPair: kp };
}

const GATEWAY_FALLBACK: SettlementEvidenceSlot = {
  bundleHash: `sha256:${"ff".repeat(32)}`,
  kernelSignature: { signer: ZERO_ADDRESS, algorithm: "ed25519", value: "gateway-auto-sign" },
  assuranceTier: 1,
};

// ── 1 & 3. Gate holds / gate untouched (#233) ────────────────────────────────

describe("SEAM-2 gate — stays CLOSED, #233/verifierStatus untouched", () => {
  it("machine.execution_log (#52) verifierStatus is still 'stub' (gate not flipped)", () => {
    expect(getPrimitive("machine.execution_log")?.verifierStatus).toBe("stub");
  });

  it("industrial primitives #52-#55 all remain verifierStatus 'stub'", () => {
    for (const id of [
      "machine.execution_log",
      "telemetry.envelope_conformance",
      "telemetry.coverage_gate",
      "process.batch_record",
    ]) {
      expect(getPrimitive(id)?.verifierStatus, id).toBe("stub");
    }
  });

  it("machineLogVerifierLive() is false while #52 is stubbed", () => {
    expect(machineLogVerifierLive()).toBe(false);
  });

  it("deviceEvidenceSettlementEnabled() is false by default (no flag)", () => {
    expect(deviceEvidenceSettlementEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("STAYS closed even with the opt-in flag set, because #52 is stubbed", () => {
    // The strongest gate-holds check: a deployment that sets the flag but has NOT
    // cleared #52 on real infra still does not anchor device evidence.
    const env = { SEAM2_DEVICE_EVIDENCE_SETTLEMENT: "1" } as unknown as NodeJS.ProcessEnv;
    expect(deviceEvidenceSettlementFlagEnabled(env)).toBe(true); // flag leg on
    expect(machineLogVerifierLive()).toBe(false); // verifier leg holds it closed
    expect(deviceEvidenceSettlementEnabled(env)).toBe(false); // composite still closed
  });

  it("flag defaults OFF", () => {
    expect(deviceEvidenceSettlementFlagEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(deviceEvidenceSettlementFlagEnabled({ SEAM2_DEVICE_EVIDENCE_SETTLEMENT: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});

// GATE HOLDS at the decision layer: with the REAL default gate, a valid device
// bundle does NOT anchor settlement.
describe("SEAM-2 gate holds — settlement does NOT auto-anchor device evidence", () => {
  it("resolveSettlementEvidence returns the gateway fallback under the real (stubbed) gate", async () => {
    const dev = realDeviceEvidence();
    const decision = await resolveSettlementEvidence({
      deviceBundle: { bundleHash: dev.bundleHash, kernelSignature: dev.signature, assuranceTier: 2 },
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
      requestedTier: 2, // tier-2 job; the CLOSED gate is tier-agnostic → still fallback
      fallback: GATEWAY_FALLBACK,
      // No gateOpen override → uses deviceEvidenceSettlementEnabled() (env below).
      env: { SEAM2_DEVICE_EVIDENCE_SETTLEMENT: "1" } as unknown as NodeJS.ProcessEnv,
    });
    expect(decision.source).toBe("gateway-fallback");
    expect(decision.reason).toBe("gate-closed");
    expect(decision.bundleHash).toBe(GATEWAY_FALLBACK.bundleHash);
    expect(decision.kernelSignature.value).toBe("gateway-auto-sign");
  });
});

// ── isDeviceSignedSignature ──────────────────────────────────────────────────

describe("isDeviceSignedSignature", () => {
  it("true for a real device Ed25519 signature", () => {
    const { signature } = realDeviceEvidence();
    expect(isDeviceSignedSignature(signature)).toBe(true);
  });

  it("false for gateway/operator placeholders, zero signer, test sig, sha256, and empties", () => {
    expect(isDeviceSignedSignature({ signer: "kernel-1", algorithm: "sha256", value: "operator-relay-auto" })).toBe(false);
    expect(isDeviceSignedSignature({ signer: ZERO_ADDRESS, algorithm: "ed25519", value: "gateway-auto-sign" })).toBe(false);
    expect(isDeviceSignedSignature({ signer: "0xabc", algorithm: "ed25519", value: "gateway-auto-sign" })).toBe(false);
    expect(isDeviceSignedSignature({ signer: "0xabc", algorithm: "ed25519", value: "test_sig_deadbeef" })).toBe(false);
    expect(isDeviceSignedSignature({ signer: ZERO_ADDRESS, algorithm: "ed25519", value: "aa".repeat(64) })).toBe(false);
    expect(isDeviceSignedSignature({ signer: "0xabc", algorithm: "sha256", value: "aa".repeat(64) })).toBe(false);
    expect(isDeviceSignedSignature(null)).toBe(false);
    expect(isDeviceSignedSignature(undefined)).toBe(false);
    expect(isDeviceSignedSignature({ signer: "", algorithm: "ed25519", value: "aa" })).toBe(false);
  });
});

// ── extractNodeSignedBundle (path 1) ─────────────────────────────────────────

describe("extractNodeSignedBundle (path 1 capture)", () => {
  it("captures a canonical #236 EvidenceBundle's real signature + hash", () => {
    const dev = realDeviceEvidence();
    const captured = extractNodeSignedBundle({
      id: "b1",
      jobId: "j1",
      assuranceTier: 2,
      bundleHash: dev.bundleHash,
      kernelSignature: dev.signature,
      kernelSessionPublicKey: dev.publicKeyHex.slice(2),
      events: [],
    });
    expect(captured).not.toBeNull();
    expect(captured!.bundleHash).toBe(dev.bundleHash);
    expect(captured!.kernelSignature.value).toBe(dev.signature.value);
    expect(captured!.kernelSignature.algorithm).toBe("ed25519");
    expect(captured!.assuranceTier).toBe(2); // declared tier surfaced (not trusted by path-1 storage)
    expect(captured!.signerPublicKey).toBe(dev.publicKeyHex.slice(2));
  });

  it("unwraps a { bundle: {...} } envelope and accepts a `signature` alias", () => {
    const dev = realDeviceEvidence();
    const captured = extractNodeSignedBundle({
      bundle: { bundleHash: dev.bundleHash, signature: dev.signature },
    });
    expect(captured).not.toBeNull();
    expect(captured!.bundleHash).toBe(dev.bundleHash);
  });

  it("returns null for placeholder / non-bundle / missing-hash evidence (old nodes)", () => {
    expect(extractNodeSignedBundle({ printed: true, returncode: 0 })).toBeNull();
    expect(
      extractNodeSignedBundle({
        bundleHash: BUNDLE_HASH,
        kernelSignature: { signer: "k", algorithm: "sha256", value: "operator-relay-auto" },
      }),
    ).toBeNull();
    const dev = realDeviceEvidence();
    // Real signature but no bundleHash → cannot anchor → null.
    expect(extractNodeSignedBundle({ kernelSignature: dev.signature })).toBeNull();
    expect(extractNodeSignedBundle(null)).toBeNull();
    expect(extractNodeSignedBundle("nope")).toBeNull();
  });
});

// ── verifyDeviceSignedEvidence (registered-signer → verify) with REAL crypto ──

describe("verifyDeviceSignedEvidence — registered-signer → Ed25519 verify (real crypto)", () => {
  it("accepts an SDK session-signed bundle through its principal delegation", async () => {
    const principal = nacl.sign.keyPair();
    const jobId = "job-delegated-247";
    const handler = createKernelHandler({
      manifest: {
        manifestVersion: "1.0.0",
        kernelId: "kernel-delegated-247",
        name: "Delegated Kernel",
        description: "test",
        builder: { agentId: "agent:test" },
        capabilityType: "test.transform",
        workflowSteps: [],
        pricing: { currency: "USDC", baseUSD: 0 },
        maxAssuranceTier: 0,
        endpointURL: "https://example.test/run",
        sessionKeyPolicy: { maxTTLSeconds: 300, allowedActions: ["evidence_submit"] },
        status: "pending",
      } as any,
      principalKey: {
        agentId: "eip155:1:0x0000000000000000000000000000000000000001",
        walletAddress: "0x0000000000000000000000000000000000000001",
        publicKey: principal.publicKey,
      },
      principalPrivateKey: principal.secretKey,
      execute: async () => ({ ok: true }),
    });
    const { evidenceBundle } = await handler({ jobId, input: { value: 1 } });
    expect(evidenceBundle.sessionKeyAuthorization).toBeDefined();

    const result = await verifyDeviceSignedEvidence({
      signature: evidenceBundle.kernelSignature,
      bundleHash: evidenceBundle.bundleHash,
      registeredSigner: { algorithm: "ed25519", publicKey: `0x${toHex(principal.publicKey)}` },
      sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization,
      contractId: jobId,
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("naclEd25519Verify round-trips a genuine tweetnacl signature", () => {
    const dev = realDeviceEvidence();
    expect(naclEd25519Verify(dev.bundleHash, dev.signature.value, dev.publicKeyHex)).toBe(true);
  });

  it("ACCEPTS a real device sig against its registered ed25519 signer", async () => {
    const dev = realDeviceEvidence();
    const res = await verifyDeviceSignedEvidence({
      signature: dev.signature,
      bundleHash: dev.bundleHash,
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
    });
    expect(res.ok).toBe(true);
    expect(res.signer?.algorithm).toBe("ed25519");
  });

  it("REJECTS a tampered bundleHash (signature no longer matches)", async () => {
    const dev = realDeviceEvidence();
    const res = await verifyDeviceSignedEvidence({
      signature: dev.signature,
      bundleHash: `sha256:${"cd".repeat(32)}`, // different message
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("signature-invalid");
  });

  it("REJECTS a wrong registered key", async () => {
    const dev = realDeviceEvidence();
    const other = nacl.sign.keyPair();
    const res = await verifyDeviceSignedEvidence({
      signature: dev.signature,
      bundleHash: dev.bundleHash,
      registeredSigner: { algorithm: "ed25519", publicKey: `0x${toHex(other.publicKey)}` },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("signature-invalid");
  });

  it("REJECTS an unregistered signer (null) and a non-ed25519 (secp256k1) signer", async () => {
    const dev = realDeviceEvidence();
    const unreg = await verifyDeviceSignedEvidence({
      signature: dev.signature,
      bundleHash: dev.bundleHash,
      registeredSigner: null,
    });
    expect(unreg.ok).toBe(false);
    expect(unreg.reason).toBe("unregistered-signer");

    const secp = await verifyDeviceSignedEvidence({
      signature: dev.signature,
      bundleHash: dev.bundleHash,
      registeredSigner: { algorithm: "secp256k1", address: `0x${"ab".repeat(20)}` },
    });
    expect(secp.ok).toBe(false);
    expect(secp.reason).toBe("signer-not-ed25519");
  });

  it("REJECTS a placeholder (non-device) signature outright", async () => {
    const res = await verifyDeviceSignedEvidence({
      signature: { signer: ZERO_ADDRESS, algorithm: "ed25519", value: "gateway-auto-sign" },
      bundleHash: BUNDLE_HASH,
      registeredSigner: { algorithm: "ed25519", publicKey: `0x${"cd".repeat(32)}` },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("not-device-signed");
  });
});

// ── registeredSignerInputFromColumns ─────────────────────────────────────────

describe("registeredSignerInputFromColumns", () => {
  it("maps ed25519 / secp256k1 columns, and null when unproven", () => {
    expect(
      registeredSignerInputFromColumns({ signingKeyAlgorithm: "ed25519", signingKeyPublicKey: `0x${"ab".repeat(32)}` }),
    ).toEqual({ algorithm: "ed25519", publicKey: `0x${"ab".repeat(32)}` });
    expect(
      registeredSignerInputFromColumns({ signingKeyAlgorithm: "secp256k1", signingAddress: `0x${"cd".repeat(20)}` }),
    ).toEqual({ algorithm: "secp256k1", address: `0x${"cd".repeat(20)}` });
    expect(registeredSignerInputFromColumns(null)).toBeNull();
    expect(registeredSignerInputFromColumns({ signingKeyAlgorithm: null })).toBeNull();
  });
});

// ── 2. Wiring correct — resolveSettlementEvidence with the gate OPEN ──────────

describe("SEAM-2 wiring — device signature flows to the settlement anchor when the gate is OPEN", () => {
  it("gate open + valid device bundle (mocked passing verifier) → anchors on DEVICE hash+sig", async () => {
    const dev = realDeviceEvidence();
    const decision = await resolveSettlementEvidence({
      deviceBundle: { bundleHash: dev.bundleHash, kernelSignature: dev.signature, assuranceTier: 0 },
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
      requestedTier: 2, // verify OK below → source "device" regardless of tier
      fallback: GATEWAY_FALLBACK,
      verifyEd25519: () => true, // verifier mocked to pass
      gateOpen: true, // simulate #52 live + flag set (NOT changing the real gate)
    });
    expect(decision.source).toBe("device");
    expect(decision.bundleHash).toBe(dev.bundleHash);
    expect(decision.kernelSignature).toEqual(dev.signature);
    expect(decision.kernelSignature.value).not.toBe("gateway-auto-sign");
  });

  it("gate open + REAL Ed25519 device bundle + registered signer → anchors on device (end-to-end mechanism)", async () => {
    const dev = realDeviceEvidence();
    const decision = await resolveSettlementEvidence({
      deviceBundle: { bundleHash: dev.bundleHash, kernelSignature: dev.signature, assuranceTier: 0 },
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
      requestedTier: 2, // verify OK below → source "device" regardless of tier
      fallback: GATEWAY_FALLBACK,
      // default verifier = naclEd25519Verify (real crypto)
      gateOpen: true,
    });
    expect(decision.source).toBe("device");
    expect(decision.bundleHash).toBe(dev.bundleHash);
  });

  it("gate open but verify FAILS (wrong key) → falls back to gateway anchor (fails closed)", async () => {
    const dev = realDeviceEvidence();
    const other = nacl.sign.keyPair();
    const decision = await resolveSettlementEvidence({
      deviceBundle: { bundleHash: dev.bundleHash, kernelSignature: dev.signature, assuranceTier: 0 },
      registeredSigner: { algorithm: "ed25519", publicKey: `0x${toHex(other.publicKey)}` },
      requestedTier: 0, // tier 0 (self-attested) keeps the buyer-approved fallback
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(decision.source).toBe("gateway-fallback");
    expect(decision.reason).toBe("signature-invalid");
    expect(decision.bundleHash).toBe(GATEWAY_FALLBACK.bundleHash);
  });

  it("gate open but NO device bundle → gateway anchor", async () => {
    const decision = await resolveSettlementEvidence({
      deviceBundle: null,
      registeredSigner: null,
      requestedTier: 0, // tier 0 keeps the buyer-approved fallback (no device required)
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(decision.source).toBe("gateway-fallback");
    expect(decision.reason).toBe("no-device-bundle");
  });
});

// ── §8.5-1 hard-gate HOLD: tier >= 1 never silently downgrades ────────────────
// The core of step 1: with the gate OPEN, a purchased tier >= 1 whose required
// device evidence is missing or fails to verify HOLDS settlement (§7.3-3, §8.4-C)
// — it is NOT anchored on the gateway placeholder. Tier 0 keeps the fallback, and
// the CLOSED-gate default path is provably unchanged (case d).
describe("SEAM-2 §8.5-1 hard-gate — tier >= 1 HOLDS instead of silent downgrade", () => {
  it("(a) gate open + verify FAILS + tier >= 1 → source 'hold' (never gateway-fallback)", async () => {
    const dev = realDeviceEvidence();
    const other = nacl.sign.keyPair(); // wrong registered key → verify fails
    const decision = await resolveSettlementEvidence({
      deviceBundle: { bundleHash: dev.bundleHash, kernelSignature: dev.signature, assuranceTier: 2 },
      registeredSigner: { algorithm: "ed25519", publicKey: `0x${toHex(other.publicKey)}` },
      requestedTier: 2,
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(decision.source).toBe("hold");
    expect(decision.reason).toBe("signature-invalid");
    // A hold is NOT a gateway anchor — the caller must not settle on it.
    expect(decision.source).not.toBe("gateway-fallback");
  });

  it("(b) gate open + verify FAILS + tier 0 → 'gateway-fallback' (buyer-approved T0 keeps fallback)", async () => {
    const dev = realDeviceEvidence();
    const other = nacl.sign.keyPair();
    const decision = await resolveSettlementEvidence({
      deviceBundle: { bundleHash: dev.bundleHash, kernelSignature: dev.signature, assuranceTier: 0 },
      registeredSigner: { algorithm: "ed25519", publicKey: `0x${toHex(other.publicKey)}` },
      requestedTier: 0,
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(decision.source).toBe("gateway-fallback");
    expect(decision.reason).toBe("signature-invalid");
    expect(decision.bundleHash).toBe(GATEWAY_FALLBACK.bundleHash);
  });

  it("(c) gate open + NO device bundle + tier >= 1 → source 'hold' reason 'no-device-bundle'", async () => {
    const decision = await resolveSettlementEvidence({
      deviceBundle: null,
      registeredSigner: null,
      requestedTier: 1,
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(decision.source).toBe("hold");
    expect(decision.reason).toBe("no-device-bundle");
  });

  it("(d) gate CLOSED + tier >= 1 → 'gateway-fallback'/'gate-closed' (default money path UNCHANGED)", async () => {
    const dev = realDeviceEvidence();
    const decision = await resolveSettlementEvidence({
      deviceBundle: { bundleHash: dev.bundleHash, kernelSignature: dev.signature, assuranceTier: 2 },
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
      requestedTier: 2,
      fallback: GATEWAY_FALLBACK,
      gateOpen: false, // the inert default — the closed gate is tier-agnostic
    });
    expect(decision.source).toBe("gateway-fallback");
    expect(decision.reason).toBe("gate-closed");
    expect(decision.bundleHash).toBe(GATEWAY_FALLBACK.bundleHash);
    expect(decision.kernelSignature.value).toBe("gateway-auto-sign");
  });

  it("(e) gate open + verify OK + tier >= 1 → source 'device' (anchors on device hash+sig)", async () => {
    const dev = realDeviceEvidence();
    const decision = await resolveSettlementEvidence({
      deviceBundle: { bundleHash: dev.bundleHash, kernelSignature: dev.signature, assuranceTier: 2 },
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
      requestedTier: 2,
      fallback: GATEWAY_FALLBACK,
      gateOpen: true, // default verifier = naclEd25519Verify (real crypto)
    });
    expect(decision.source).toBe("device");
    expect(decision.bundleHash).toBe(dev.bundleHash);
  });
});

// ── §8.5-2. Revocation into settlement, keyed to effectiveEvidenceTime ─────────
// §7.3-4: "revokedAt < effectiveEvidenceTime → invalid; else prior evidence stands"
// (§8.4-A step 6: "not revoked ... BEFORE its effectiveEvidenceTime"). Strict `<`,
// so a revocation AT the exact evidence time → prior evidence STANDS (valid). The
// evidenceTime/revokedAt integers below are only compared for revocation; expiry
// still uses the real clock (currentTimestamp is intentionally not re-keyed here).

/** A real SDK session-signed bundle (principal-delegated session key), plus the
 *  registered signer + the delegated sessionId — the exact shape /complete captures. */
async function realSessionSignedBundle(jobId = "job-revoke-247") {
  const principal = nacl.sign.keyPair();
  const handler = createKernelHandler({
    manifest: {
      manifestVersion: "1.0.0",
      kernelId: "kernel-revoke-247",
      name: "Revoke Kernel",
      description: "test",
      builder: { agentId: "agent:test" },
      capabilityType: "test.transform",
      workflowSteps: [],
      pricing: { currency: "USDC", baseUSD: 0 },
      maxAssuranceTier: 0,
      endpointURL: "https://example.test/run",
      sessionKeyPolicy: { maxTTLSeconds: 300, allowedActions: ["evidence_submit"] },
      status: "pending",
    } as any,
    principalKey: {
      agentId: "eip155:1:0x0000000000000000000000000000000000000002",
      walletAddress: "0x0000000000000000000000000000000000000002",
      publicKey: principal.publicKey,
    },
    principalPrivateKey: principal.secretKey,
    execute: async () => ({ ok: true }),
  });
  const { evidenceBundle } = await handler({ jobId, input: { value: 1 } });
  const auth = evidenceBundle.sessionKeyAuthorization;
  if (!auth) throw new Error("expected sessionKeyAuthorization on the SDK bundle");
  return {
    evidenceBundle,
    registeredSigner: { algorithm: "ed25519", publicKey: `0x${toHex(principal.publicKey)}` },
    sessionId: auth.sessionId,
    jobId,
  };
}

describe("verifyDeviceSignedEvidence — session-key revocation keyed to effectiveEvidenceTime (§8.5-2)", () => {
  it("revoked BEFORE effectiveEvidenceTime → invalid (session_revoked)", async () => {
    const { evidenceBundle, registeredSigner, sessionId, jobId } = await realSessionSignedBundle();
    const res = await verifyDeviceSignedEvidence({
      signature: evidenceBundle.kernelSignature,
      bundleHash: evidenceBundle.bundleHash,
      registeredSigner,
      sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization!,
      contractId: jobId,
      revocations: [{ sessionId, revokedAt: 1000 }],
      effectiveEvidenceTime: 2000, // 1000 < 2000 → revoked before evidence → invalid
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("session_revoked");
  });

  it("revoked AFTER effectiveEvidenceTime → prior evidence stands (valid)", async () => {
    const { evidenceBundle, registeredSigner, sessionId, jobId } = await realSessionSignedBundle();
    const res = await verifyDeviceSignedEvidence({
      signature: evidenceBundle.kernelSignature,
      bundleHash: evidenceBundle.bundleHash,
      registeredSigner,
      sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization!,
      contractId: jobId,
      revocations: [{ sessionId, revokedAt: 3000 }],
      effectiveEvidenceTime: 2000, // 3000 < 2000 is false → not disqualified → valid
    });
    expect(res.ok).toBe(true);
  });

  it("revoked AT effectiveEvidenceTime (boundary) → prior evidence stands (strict `<`, §7.3-4)", async () => {
    const { evidenceBundle, registeredSigner, sessionId, jobId } = await realSessionSignedBundle();
    const res = await verifyDeviceSignedEvidence({
      signature: evidenceBundle.kernelSignature,
      bundleHash: evidenceBundle.bundleHash,
      registeredSigner,
      sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization!,
      contractId: jobId,
      revocations: [{ sessionId, revokedAt: 2000 }],
      effectiveEvidenceTime: 2000, // 2000 < 2000 is false → valid ("prior evidence stands")
    });
    expect(res.ok).toBe(true);
  });

  it("a DIFFERENT session's revocation does not disqualify", async () => {
    const { evidenceBundle, registeredSigner, jobId } = await realSessionSignedBundle();
    const res = await verifyDeviceSignedEvidence({
      signature: evidenceBundle.kernelSignature,
      bundleHash: evidenceBundle.bundleHash,
      registeredSigner,
      sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization!,
      contractId: jobId,
      revocations: [{ sessionId: "some-other-session", revokedAt: 1 }],
      effectiveEvidenceTime: 2000,
    });
    expect(res.ok).toBe(true);
  });

  it("no revocations supplied → unchanged (valid)", async () => {
    const { evidenceBundle, registeredSigner, jobId } = await realSessionSignedBundle();
    const res = await verifyDeviceSignedEvidence({
      signature: evidenceBundle.kernelSignature,
      bundleHash: evidenceBundle.bundleHash,
      registeredSigner,
      sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization!,
      contractId: jobId,
    });
    expect(res.ok).toBe(true);
  });

  it("direct registered-signer path (no session key) is UNAFFECTED by revocation", async () => {
    // No sessionKeyAuthorization → the Ed25519 branch → revocation is never consulted.
    const dev = realDeviceEvidence();
    const res = await verifyDeviceSignedEvidence({
      signature: dev.signature,
      bundleHash: dev.bundleHash,
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
      revocations: [{ sessionId: "anything", revokedAt: 1 }],
      effectiveEvidenceTime: 2, // would disqualify a session key, but there is none
    });
    expect(res.ok).toBe(true);
  });
});

describe("resolveSettlementEvidence — revocation flows into the tier/HOLD decision (§8.5-2)", () => {
  it("gate open + tier >= 1 + revoked BEFORE evidence time → source 'hold' (session_revoked)", async () => {
    const { evidenceBundle, registeredSigner, sessionId, jobId } = await realSessionSignedBundle();
    const decision = await resolveSettlementEvidence({
      deviceBundle: {
        bundleHash: evidenceBundle.bundleHash,
        kernelSignature: evidenceBundle.kernelSignature,
        assuranceTier: 2,
        sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization!,
        contractId: jobId,
      },
      registeredSigner,
      requestedTier: 2,
      fallback: GATEWAY_FALLBACK,
      revocations: [{ sessionId, revokedAt: 1000 }],
      effectiveEvidenceTime: 2000,
      gateOpen: true,
    });
    expect(decision.source).toBe("hold"); // tier >= 1 → HOLD, never silent downgrade
    expect(decision.reason).toBe("session_revoked");
  });

  it("gate open + revoked AFTER evidence time → source 'device' (prior evidence stands)", async () => {
    const { evidenceBundle, registeredSigner, sessionId, jobId } = await realSessionSignedBundle();
    const decision = await resolveSettlementEvidence({
      deviceBundle: {
        bundleHash: evidenceBundle.bundleHash,
        kernelSignature: evidenceBundle.kernelSignature,
        assuranceTier: 2,
        sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization!,
        contractId: jobId,
      },
      registeredSigner,
      requestedTier: 2,
      fallback: GATEWAY_FALLBACK,
      revocations: [{ sessionId, revokedAt: 3000 }],
      effectiveEvidenceTime: 2000,
      gateOpen: true,
    });
    expect(decision.source).toBe("device");
    expect(decision.bundleHash).toBe(evidenceBundle.bundleHash);
  });

  it("gate open + tier 0 + revoked BEFORE evidence time → 'gateway-fallback' (T0 keeps buyer-approved fallback)", async () => {
    const { evidenceBundle, registeredSigner, sessionId, jobId } = await realSessionSignedBundle();
    const decision = await resolveSettlementEvidence({
      deviceBundle: {
        bundleHash: evidenceBundle.bundleHash,
        kernelSignature: evidenceBundle.kernelSignature,
        assuranceTier: 0,
        sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization!,
        contractId: jobId,
      },
      registeredSigner,
      requestedTier: 0,
      fallback: GATEWAY_FALLBACK,
      revocations: [{ sessionId, revokedAt: 1000 }],
      effectiveEvidenceTime: 2000,
      gateOpen: true,
    });
    expect(decision.source).toBe("gateway-fallback");
    expect(decision.reason).toBe("session_revoked");
    expect(decision.bundleHash).toBe(GATEWAY_FALLBACK.bundleHash);
  });

  it("gate CLOSED + revoked → 'gateway-fallback'/'gate-closed' (revocation inert on the default path)", async () => {
    const { evidenceBundle, registeredSigner, sessionId, jobId } = await realSessionSignedBundle();
    const decision = await resolveSettlementEvidence({
      deviceBundle: {
        bundleHash: evidenceBundle.bundleHash,
        kernelSignature: evidenceBundle.kernelSignature,
        assuranceTier: 2,
        sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization!,
        contractId: jobId,
      },
      registeredSigner,
      requestedTier: 2,
      fallback: GATEWAY_FALLBACK,
      revocations: [{ sessionId, revokedAt: 1000 }],
      effectiveEvidenceTime: 2000,
      gateOpen: false, // closed default → revocation never consulted
    });
    expect(decision.source).toBe("gateway-fallback");
    expect(decision.reason).toBe("gate-closed");
  });
});
