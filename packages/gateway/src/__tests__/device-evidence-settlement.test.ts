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

import { describe, it, expect, vi } from "vitest";
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
  DEFAULT_PERMITTED_SKEW_SECONDS,
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
// bundle does NOT anchor settlement. Fix #1 (audit round-2): a PURCHASED tier >= 1
// job HOLDS under the closed gate rather than silently downgrading onto the gateway
// placeholder; tier 0 keeps the buyer-approved fallback.
describe("SEAM-2 gate holds — settlement does NOT auto-anchor device evidence", () => {
  it("HOLDS a tier >= 1 job under the real (stubbed) gate — no auto-anchor, no placeholder downgrade", async () => {
    // Rewritten (fix #1): with the real gate closed (#52 stubbed) a purchased tier-2 job
    // neither auto-anchors device evidence NOR silently downgrades onto the gateway
    // placeholder — it HOLDS (the required verifier is unavailable). Was: gateway-fallback.
    const dev = realDeviceEvidence();
    const decision = await resolveSettlementEvidence({
      deviceBundle: { bundleHash: dev.bundleHash, kernelSignature: dev.signature, assuranceTier: 2 },
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
      requestedTier: 2, // purchased tier-2 → HOLD while the verifier is unavailable
      fallback: GATEWAY_FALLBACK,
      // No gateOpen override → uses deviceEvidenceSettlementEnabled() (env below): closed.
      env: { SEAM2_DEVICE_EVIDENCE_SETTLEMENT: "1" } as unknown as NodeJS.ProcessEnv,
    });
    expect(decision.source).toBe("hold");
    expect(decision.reason).toBe("required-verifier-unavailable");
    // A hold is NOT a gateway anchor — the money must not settle on the placeholder.
    expect(decision.source).not.toBe("gateway-fallback");
  });

  it("keeps the gateway fallback for a tier 0 job under the real (stubbed) gate", async () => {
    // Tier 0 (self-attested) is the buyer-approved fallback path — unchanged by fix #1.
    const dev = realDeviceEvidence();
    const decision = await resolveSettlementEvidence({
      deviceBundle: { bundleHash: dev.bundleHash, kernelSignature: dev.signature, assuranceTier: 0 },
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
      requestedTier: 0,
      fallback: GATEWAY_FALLBACK,
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
      // §8.5-4 (fix #3): the delegated path now REQUIRES an explicit trusted evidence
      // time. The session was just issued, so now is inside its [issuedAt, expiresAt].
      effectiveEvidenceTime: Math.floor(Date.now() / 1000),
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
// SCOPE — CRYPTO-ROUTING, NOT SETTLEMENT POLICY. These tests assert only that a
// signature which VERIFIES against the registered signer routes settlement to the
// DEVICE anchor (source:"device") instead of the gateway placeholder. They do NOT
// assert that the achieved assurance tier satisfies the requestedTier: "signature
// valid ≠ requested assurance satisfied". Deriving the ACHIEVED tier from verified
// claims and gating settlement on achievedTier >= requestedTier is a later step
// (§8.5-10, a future gate-opening blocker), NOT asserted here. Where requestedTier is
// 2 below it is only to show the crypto routing is tier-agnostic, never a claim that
// tier 2 was met.

describe("SEAM-2 wiring (crypto-routing) — a verified device signature routes to the device anchor when the gate is OPEN", () => {
  it("gate open + valid device bundle (mocked passing verifier) → anchors on DEVICE hash+sig", async () => {
    const dev = realDeviceEvidence();
    const decision = await resolveSettlementEvidence({
      deviceBundle: { bundleHash: dev.bundleHash, kernelSignature: dev.signature, assuranceTier: 0 },
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
      requestedTier: 2, // crypto-routing is tier-agnostic: verify OK → source "device" (NOT a claim tier-2 was achieved — see §8.5-10 scope note above)
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
      requestedTier: 2, // crypto-routing is tier-agnostic: verify OK → source "device" (NOT a claim tier-2 was achieved — see §8.5-10 scope note above)
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
// The core of step 1: a purchased tier >= 1 whose required device evidence is
// missing or fails to verify HOLDS settlement (§7.3-3, §8.4-C) — it is NOT anchored
// on the gateway placeholder. This holds whether the gate is OPEN (missing/failed
// device evidence, cases a/c/e) or CLOSED (required verifier unavailable, case d, fix
// #1). Tier 0 always keeps the buyer-approved fallback (cases b, f).
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

  it("(d) gate CLOSED + tier >= 1 → source 'hold' reason 'required-verifier-unavailable' (fix #1: no silent placeholder downgrade)", async () => {
    // Rewritten (audit round-2 fix #1). This previously asserted gate-closed + tier-2 →
    // gateway-fallback/gate-closed, which LOCKED IN the fail-open: a PURCHASED tier-2 job
    // settling on the zero-address gateway placeholder while the required verifier is
    // unavailable. Correct: tier >= 1 HOLDS when the gate is closed (fails closed). The
    // still-permitted tier-0 fallback moved to case (f).
    const dev = realDeviceEvidence();
    const decision = await resolveSettlementEvidence({
      deviceBundle: { bundleHash: dev.bundleHash, kernelSignature: dev.signature, assuranceTier: 2 },
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
      requestedTier: 2,
      fallback: GATEWAY_FALLBACK,
      gateOpen: false, // the closed default
    });
    expect(decision.source).toBe("hold");
    expect(decision.reason).toBe("required-verifier-unavailable");
    expect(decision.source).not.toBe("gateway-fallback");
  });

  it("(f) gate CLOSED + tier 0 → 'gateway-fallback'/'gate-closed' (tier-0 fallback UNCHANGED)", async () => {
    // The still-permitted closed-gate path: tier 0 (self-attested) keeps the buyer-approved
    // gateway placeholder, byte-identical to before fix #1. (This is the tier-0 half of what
    // the old tier-agnostic case (d) used to cover.)
    const dev = realDeviceEvidence();
    const decision = await resolveSettlementEvidence({
      deviceBundle: { bundleHash: dev.bundleHash, kernelSignature: dev.signature, assuranceTier: 0 },
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
      requestedTier: 0,
      fallback: GATEWAY_FALLBACK,
      gateOpen: false,
    });
    expect(decision.source).toBe("gateway-fallback");
    expect(decision.reason).toBe("gate-closed");
    expect(decision.bundleHash).toBe(GATEWAY_FALLBACK.bundleHash);
    expect(decision.kernelSignature.value).toBe("gateway-auto-sign");
  });

  it("(e) gate open + verify OK → source 'device' (crypto-routing to the device anchor; achieved-tier vs requested is §8.5-10, not asserted)", async () => {
    // Crypto-routing, not settlement policy: a verified signature routes to the device
    // anchor. requestedTier:2 here only proves the routing fires at tier >= 1 — it is NOT
    // an assertion that achievedTier >= 2 ("signature valid ≠ requested assurance
    // satisfied"; achieved-tier derivation is §8.5-10, a later step).
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
// so a revocation AT the exact evidence time → prior evidence STANDS (valid).
// UPDATED for §8.5-4: expiry is now ALSO judged at effectiveEvidenceTime (one unified
// value). So these fixtures key effectiveEvidenceTime/revokedAt off the session's real
// `issuedAt` — placing effectiveEvidenceTime INSIDE [issuedAt, expiresAt] — which keeps
// the session VALID at that time and isolates the revocation semantics under test.

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
    // The session's real validity window (Unix seconds). Fixtures key evidence/revocation
    // times off issuedAt so the session is VALID at the chosen effectiveEvidenceTime — now
    // that §8.5-4 judges expiry AT effectiveEvidenceTime, isolating the revocation semantics.
    issuedAt: auth.issuedAt,
    expiresAt: auth.expiresAt,
  };
}

describe("verifyDeviceSignedEvidence — session-key revocation keyed to effectiveEvidenceTime (§8.5-2)", () => {
  it("revoked BEFORE effectiveEvidenceTime → invalid (session_revoked)", async () => {
    const { evidenceBundle, registeredSigner, sessionId, jobId, issuedAt } = await realSessionSignedBundle();
    const res = await verifyDeviceSignedEvidence({
      signature: evidenceBundle.kernelSignature,
      bundleHash: evidenceBundle.bundleHash,
      registeredSigner,
      sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization!,
      contractId: jobId,
      // effectiveEvidenceTime INSIDE the window (session valid there); revokedAt < it → revoked before evidence.
      revocations: [{ sessionId, revokedAt: issuedAt + 50 }],
      effectiveEvidenceTime: issuedAt + 100,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("session_revoked");
  });

  it("revoked AFTER effectiveEvidenceTime → prior evidence stands (valid)", async () => {
    const { evidenceBundle, registeredSigner, sessionId, jobId, issuedAt } = await realSessionSignedBundle();
    const res = await verifyDeviceSignedEvidence({
      signature: evidenceBundle.kernelSignature,
      bundleHash: evidenceBundle.bundleHash,
      registeredSigner,
      sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization!,
      contractId: jobId,
      // revokedAt (issuedAt+200) < effectiveEvidenceTime (issuedAt+100) is false → not disqualified → valid.
      revocations: [{ sessionId, revokedAt: issuedAt + 200 }],
      effectiveEvidenceTime: issuedAt + 100,
    });
    expect(res.ok).toBe(true);
  });

  it("revoked AT effectiveEvidenceTime (boundary) → prior evidence stands (strict `<`, §7.3-4)", async () => {
    const { evidenceBundle, registeredSigner, sessionId, jobId, issuedAt } = await realSessionSignedBundle();
    const res = await verifyDeviceSignedEvidence({
      signature: evidenceBundle.kernelSignature,
      bundleHash: evidenceBundle.bundleHash,
      registeredSigner,
      sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization!,
      contractId: jobId,
      // revokedAt == effectiveEvidenceTime → strict `<` is false → valid ("prior evidence stands").
      revocations: [{ sessionId, revokedAt: issuedAt + 100 }],
      effectiveEvidenceTime: issuedAt + 100,
    });
    expect(res.ok).toBe(true);
  });

  it("a DIFFERENT session's revocation does not disqualify", async () => {
    const { evidenceBundle, registeredSigner, jobId, issuedAt } = await realSessionSignedBundle();
    const res = await verifyDeviceSignedEvidence({
      signature: evidenceBundle.kernelSignature,
      bundleHash: evidenceBundle.bundleHash,
      registeredSigner,
      sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization!,
      contractId: jobId,
      revocations: [{ sessionId: "some-other-session", revokedAt: issuedAt + 1 }],
      effectiveEvidenceTime: issuedAt + 100,
    });
    expect(res.ok).toBe(true);
  });

  it("no revocations supplied → unchanged (valid)", async () => {
    const { evidenceBundle, registeredSigner, jobId, issuedAt } = await realSessionSignedBundle();
    const res = await verifyDeviceSignedEvidence({
      signature: evidenceBundle.kernelSignature,
      bundleHash: evidenceBundle.bundleHash,
      registeredSigner,
      sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization!,
      contractId: jobId,
      // §8.5-4 (fix #3): delegated path requires an explicit trusted evidence time (inside window).
      effectiveEvidenceTime: issuedAt + 100,
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
    const { evidenceBundle, registeredSigner, sessionId, jobId, issuedAt } = await realSessionSignedBundle();
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
      revocations: [{ sessionId, revokedAt: issuedAt + 50 }],
      effectiveEvidenceTime: issuedAt + 100,
      gateOpen: true,
    });
    expect(decision.source).toBe("hold"); // tier >= 1 → HOLD, never silent downgrade
    expect(decision.reason).toBe("session_revoked");
  });

  it("gate open + revoked AFTER evidence time → source 'device' (prior evidence stands)", async () => {
    const { evidenceBundle, registeredSigner, sessionId, jobId, issuedAt } = await realSessionSignedBundle();
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
      revocations: [{ sessionId, revokedAt: issuedAt + 200 }],
      effectiveEvidenceTime: issuedAt + 100,
      gateOpen: true,
    });
    expect(decision.source).toBe("device");
    expect(decision.bundleHash).toBe(evidenceBundle.bundleHash);
  });

  it("gate open + tier 0 + revoked BEFORE evidence time → 'gateway-fallback' (T0 keeps buyer-approved fallback)", async () => {
    const { evidenceBundle, registeredSigner, sessionId, jobId, issuedAt } = await realSessionSignedBundle();
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
      revocations: [{ sessionId, revokedAt: issuedAt + 50 }],
      effectiveEvidenceTime: issuedAt + 100,
      gateOpen: true,
    });
    expect(decision.source).toBe("gateway-fallback");
    expect(decision.reason).toBe("session_revoked");
    expect(decision.bundleHash).toBe(GATEWAY_FALLBACK.bundleHash);
  });

  it("gate CLOSED + revoked + tier >= 1 → source 'hold'/'required-verifier-unavailable' (revocation inert on the default path)", async () => {
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
    // Updated for fix #1: closed-gate tier >= 1 now HOLDS (was gateway-fallback). The
    // point of THIS test survives and is in fact sharper — the hold reason is the
    // closed-gate stance 'required-verifier-unavailable', NOT 'session_revoked', proving
    // revocation state was never consulted on the closed path (it short-circuits first).
    expect(decision.source).toBe("hold");
    expect(decision.reason).toBe("required-verifier-unavailable");
    expect(decision.reason).not.toBe("session_revoked");
  });
});

// ── §8.5-4. effectiveEvidenceTime — validity judged at EVIDENCE time (CVE-2024-55655) ──
// §3.1/§7.1/§8.4-A: expiry (`notBefore(issuedAt) ≤ effectiveEvidenceTime ≤ expiresAt`) is
// judged at the gateway's authoritative evidence time — NEVER at settlement wall-clock-now,
// NEVER on the device's raw `createdAt`. Step 4 only PASSES verifySessionSignedEvent a
// currentTimestamp; it does not change that verifier. Plus the §8.4-A skew FLAG.

/** A genuine session-signed bundle whose validity window is entirely in the PAST
 *  (issuedAt..expiresAt < real now). Built by running the real SDK signing path under a
 *  Date-only fake clock so the stamped issuedAt/expiresAt are in the past — no manual
 *  canonical-bytes reconstruction, no timer/promise faking (only Date is mocked). */
async function pastDatedSessionBundle(issuedAtSec: number, jobId = "job-cve-247") {
  const principal = nacl.sign.keyPair();
  const handler = createKernelHandler({
    manifest: {
      manifestVersion: "1.0.0",
      kernelId: "kernel-cve-247",
      name: "CVE Kernel",
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
      agentId: "eip155:1:0x0000000000000000000000000000000000000009",
      walletAddress: "0x0000000000000000000000000000000000000009",
      publicKey: principal.publicKey,
    },
    principalPrivateKey: principal.secretKey,
    execute: async () => ({ ok: true }),
  });
  // Fake ONLY Date so issueSessionKey's `Math.floor(Date.now()/1000)` stamps a past
  // issuedAt; timers/microtasks are untouched so `await handler(...)` still resolves.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(issuedAtSec * 1000);
  const result = await handler({ jobId, input: { value: 1 } });
  vi.useRealTimers();
  const evidenceBundle = result.evidenceBundle;
  const auth = evidenceBundle.sessionKeyAuthorization;
  if (!auth) throw new Error("expected sessionKeyAuthorization on the SDK bundle");
  return {
    evidenceBundle,
    registeredSigner: { algorithm: "ed25519", publicKey: `0x${toHex(principal.publicKey)}` },
    sessionId: auth.sessionId,
    jobId,
    issuedAt: auth.issuedAt,
    expiresAt: auth.expiresAt,
  };
}

describe("verifyDeviceSignedEvidence — validity at effectiveEvidenceTime (§8.5-4 / CVE-2024-55655 fix)", () => {
  it("session EXPIRED by settlement-now but VALID at effectiveEvidenceTime → verify OK (the whole point)", async () => {
    const b = await pastDatedSessionBundle(1_600_000_000); // window [t, t+300], far before real now
    // Precondition: the session really is expired at the real clock now.
    expect(b.expiresAt).toBeLessThan(Math.floor(Date.now() / 1000));
    const res = await verifyDeviceSignedEvidence({
      signature: b.evidenceBundle.kernelSignature,
      bundleHash: b.evidenceBundle.bundleHash,
      registeredSigner: b.registeredSigner,
      sessionKeyAuthorization: b.evidenceBundle.sessionKeyAuthorization!,
      contractId: b.jobId,
      // WITHIN [issuedAt, expiresAt] → valid AT evidence time even though expired at now.
      effectiveEvidenceTime: b.issuedAt + 100,
    });
    expect(res.ok).toBe(true); // long/late-but-legit evidence is judged at EVIDENCE time
  });

  it("session EXPIRED at effectiveEvidenceTime → invalid (session_expired → tier>=1 HOLD)", async () => {
    const { evidenceBundle, registeredSigner, jobId, expiresAt } = await realSessionSignedBundle("job-exp-247");
    const res = await verifyDeviceSignedEvidence({
      signature: evidenceBundle.kernelSignature,
      bundleHash: evidenceBundle.bundleHash,
      registeredSigner,
      sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization!,
      contractId: jobId,
      effectiveEvidenceTime: expiresAt + 100, // past the session's expiry
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("session_expired");
  });

  it("effectiveEvidenceTime < issuedAt → session_not_yet_valid", async () => {
    const { evidenceBundle, registeredSigner, jobId, issuedAt } = await realSessionSignedBundle("job-nyv-247");
    const res = await verifyDeviceSignedEvidence({
      signature: evidenceBundle.kernelSignature,
      bundleHash: evidenceBundle.bundleHash,
      registeredSigner,
      sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization!,
      contractId: jobId,
      effectiveEvidenceTime: issuedAt - 100, // before the session was issued
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("session_not_yet_valid");
  });

  it("sourcing: the expiry verdict tracks effectiveEvidenceTime, NOT Date.now() and NOT the device createdAt", async () => {
    const { evidenceBundle, registeredSigner, jobId, issuedAt, expiresAt } = await realSessionSignedBundle("job-src-247");
    const realNow = Math.floor(Date.now() / 1000);
    // The session IS valid at the real clock now (so a Date.now()-keyed check would PASS)...
    expect(realNow).toBeGreaterThanOrEqual(issuedAt);
    expect(realNow).toBeLessThanOrEqual(expiresAt);
    const res = await verifyDeviceSignedEvidence({
      signature: evidenceBundle.kernelSignature,
      bundleHash: evidenceBundle.bundleHash,
      registeredSigner,
      sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization!,
      contractId: jobId,
      effectiveEvidenceTime: expiresAt + 5000, // expired ONLY at this evidence time
      deviceCreatedAt: issuedAt, // a valid-looking time; must NOT be used for validity
    });
    // ...yet the verdict is session_expired → it tracked effectiveEvidenceTime, not now, not createdAt.
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("session_expired");
  });

  it("delegated (session-key) path REQUIRES effectiveEvidenceTime → missing-effective-evidence-time (fix #3)", async () => {
    // Fix #3: the live delegated path must supply the gateway receipt time. Omitting it
    // is a caller error returned CLOSED — NOT silently defaulted to settlement wall-clock
    // (Date.now() at settlement), which would let a since-expired/revoked delegation verify
    // as if it were still fresh.
    const { evidenceBundle, registeredSigner, jobId } = await realSessionSignedBundle("job-missing-evt-247");
    const res = await verifyDeviceSignedEvidence({
      signature: evidenceBundle.kernelSignature,
      bundleHash: evidenceBundle.bundleHash,
      registeredSigner,
      sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization!,
      contractId: jobId,
      // effectiveEvidenceTime deliberately omitted.
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("missing-effective-evidence-time");
  });

  it("non-delegated direct-Ed25519 path keeps the now() default when time is omitted (fallback retained, fix #3)", async () => {
    // The `?? now` fallback is retained ONLY here: no session key → nothing is time-judged
    // (no expiry, no revocation), so a legacy direct caller may omit the time.
    const dev = realDeviceEvidence();
    const res = await verifyDeviceSignedEvidence({
      signature: dev.signature,
      bundleHash: dev.bundleHash,
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
      // no sessionKeyAuthorization + no effectiveEvidenceTime → direct path, defaults to now.
    });
    expect(res.ok).toBe(true);
  });
});

describe("verifyDeviceSignedEvidence — §8.4-A skew FLAG (advisory createdAt vs effectiveEvidenceTime)", () => {
  const EV = 1_700_000_000;

  it("skew within DEFAULT_PERMITTED_SKEW → skewWithinPolicy true (boundary ==) and verify passes", async () => {
    const dev = realDeviceEvidence();
    const res = await verifyDeviceSignedEvidence({
      signature: dev.signature,
      bundleHash: dev.bundleHash,
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
      effectiveEvidenceTime: EV,
      deviceCreatedAt: EV + DEFAULT_PERMITTED_SKEW_SECONDS, // exactly the bound → within (≤)
    });
    expect(res.ok).toBe(true);
    expect(res.skewSeconds).toBe(DEFAULT_PERMITTED_SKEW_SECONDS);
    expect(res.skewWithinPolicy).toBe(true);
  });

  it("skew beyond DEFAULT_PERMITTED_SKEW → skewWithinPolicy false, but verify STILL passes (flag only)", async () => {
    const dev = realDeviceEvidence();
    const res = await verifyDeviceSignedEvidence({
      signature: dev.signature,
      bundleHash: dev.bundleHash,
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
      effectiveEvidenceTime: EV,
      deviceCreatedAt: EV - (DEFAULT_PERMITTED_SKEW_SECONDS + 1), // 301s early → beyond (abs value)
    });
    expect(res.ok).toBe(true); // FLAG only — skew never gates ok in this cut
    expect(res.skewSeconds).toBe(DEFAULT_PERMITTED_SKEW_SECONDS + 1);
    expect(res.skewWithinPolicy).toBe(false);
  });

  it("no device createdAt → no skew flag computed (fields absent)", async () => {
    const dev = realDeviceEvidence();
    const res = await verifyDeviceSignedEvidence({
      signature: dev.signature,
      bundleHash: dev.bundleHash,
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
      effectiveEvidenceTime: EV,
    });
    expect(res.ok).toBe(true);
    expect(res.skewSeconds).toBeUndefined();
    expect(res.skewWithinPolicy).toBeUndefined();
  });

  it("owner-policy permittedSkewSeconds override tightens the flag", async () => {
    const dev = realDeviceEvidence();
    const res = await verifyDeviceSignedEvidence({
      signature: dev.signature,
      bundleHash: dev.bundleHash,
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
      effectiveEvidenceTime: EV,
      deviceCreatedAt: EV + 100, // within the 300 default...
      permittedSkewSeconds: 60, // ...but beyond a tightened 60s owner policy
    });
    expect(res.ok).toBe(true);
    expect(res.skewSeconds).toBe(100);
    expect(res.skewWithinPolicy).toBe(false);
  });
});

describe("verifyDeviceSignedEvidence — revocation + expiry share ONE effectiveEvidenceTime (§8.5-4)", () => {
  it("valid at evidence time (expiry PASSES) but revoked BEFORE it → session_revoked (not session_expired)", async () => {
    const b = await pastDatedSessionBundle(1_600_000_500, "job-combined-247");
    const evTime = b.issuedAt + 120; // inside [issuedAt, expiresAt] → expiry PASSES at evTime
    const res = await verifyDeviceSignedEvidence({
      signature: b.evidenceBundle.kernelSignature,
      bundleHash: b.evidenceBundle.bundleHash,
      registeredSigner: b.registeredSigner,
      sessionKeyAuthorization: b.evidenceBundle.sessionKeyAuthorization!,
      contractId: b.jobId,
      effectiveEvidenceTime: evTime,
      revocations: [{ sessionId: b.sessionId, revokedAt: evTime - 10 }], // revoked before the SAME evTime
    });
    expect(res.ok).toBe(false);
    // Proves both share evTime: expiry passed AT evTime, revocation failed AT evTime.
    expect(res.reason).toBe("session_revoked");
  });

  it("same evidence time, revoked AFTER it → valid (expiry passes AND not-yet-revoked, one value)", async () => {
    const b = await pastDatedSessionBundle(1_600_001_000, "job-combined-ok-247");
    const evTime = b.issuedAt + 120;
    const res = await verifyDeviceSignedEvidence({
      signature: b.evidenceBundle.kernelSignature,
      bundleHash: b.evidenceBundle.bundleHash,
      registeredSigner: b.registeredSigner,
      sessionKeyAuthorization: b.evidenceBundle.sessionKeyAuthorization!,
      contractId: b.jobId,
      effectiveEvidenceTime: evTime,
      revocations: [{ sessionId: b.sessionId, revokedAt: evTime + 10 }], // revoked after evTime
    });
    expect(res.ok).toBe(true);
  });
});
