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
import {
  computeLogEntryHash,
  getPrimitive,
  hashBundle,
  hashEvent,
  sessionKeyDelegationPreimage,
  signingPreimage,
  type EvidenceEvent,
  type EvidenceSubject,
  type SessionKeyAuthorization,
} from "@pcc/spec";
import { createKernelHandler } from "@pcc/kernel-sdk";
import {
  isDeviceSignedSignature,
  extractNodeSignedBundle,
  verifyDeviceSignedEvidence,
  naclEd25519Verify,
  resolveSettlementEvidence,
  verifyPinnedSettlementEvidence,
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

const SUBJECT_JOB = "job-seam2-subject";
const SUBJECT_KERNEL = "kernel-seam2-subject";

/** A device bundle as a node relays it (LO-EV-9 shape): events that commit the
 *  job and the kernel in their hashed content, the bundleHash over them, and
 *  the signing key's signature over signingPreimage(bundleHash). `slot()`
 *  presents it to settlement for a subject, by default its own. */
async function boundDeviceEvidence(
  opts: { jobId?: string; kernelId?: string; keyPair?: nacl.SignKeyPair } = {},
) {
  const jobId = opts.jobId ?? SUBJECT_JOB;
  const kernelId = opts.kernelId ?? SUBJECT_KERNEL;
  const keyPair = opts.keyPair ?? nacl.sign.keyPair();
  const source = { deviceId: `${kernelId}-printer`, deviceType: "controller" as const, kernelId };
  const raw: Array<Omit<EvidenceEvent, "id" | "hash">> = [
    {
      type: "execution_started",
      timestamp: "2026-09-24T10:00:00.000Z",
      source,
      payload: { jobId, kernelId },
    },
    {
      type: "execution_completed",
      timestamp: "2026-09-24T10:00:05.000Z",
      source,
      payload: { jobId, kernelId, outputHash: `sha256:${"5e".repeat(32)}` },
    },
  ];
  const events: EvidenceEvent[] = await Promise.all(
    raw.map(async (e, i) => ({ ...e, id: `ev-${i}`, hash: await hashEvent(e) })),
  );
  const bundleHash = await hashBundle(events);
  const signature: StoredSignature = {
    signer: `0x${toHex(keyPair.publicKey).slice(0, 40)}`,
    algorithm: "ed25519",
    value: toHex(nacl.sign.detached(signingPreimage(bundleHash), keyPair.secretKey)),
  };
  const publicKeyHex = `0x${toHex(keyPair.publicKey)}`;
  const slot = (subject: EvidenceSubject = { jobId, kernelId }): SettlementEvidenceSlot => ({
    bundleHash,
    kernelSignature: signature,
    assuranceTier: 0,
    events,
    subject,
  });
  return { jobId, kernelId, events, bundleHash, signature, publicKeyHex, keyPair, slot };
}

const ed25519Signer = (publicKey: Uint8Array) => ({
  algorithm: "ed25519",
  publicKey: `0x${toHex(publicKey)}`,
});

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
    const dev = await boundDeviceEvidence();
    const decision = await resolveSettlementEvidence({
      deviceBundle: dev.slot(),
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
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
    const dev = await boundDeviceEvidence();
    const decision = await resolveSettlementEvidence({
      deviceBundle: dev.slot(),
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
      fallback: GATEWAY_FALLBACK,
      // default verifier = naclEd25519Verify (real crypto)
      gateOpen: true,
    });
    expect(decision.source).toBe("device");
    expect(decision.bundleHash).toBe(dev.bundleHash);
  });

  it("gate open but verify FAILS (wrong key) → falls back to gateway anchor (fails closed)", async () => {
    const dev = await boundDeviceEvidence();
    const other = nacl.sign.keyPair();
    const decision = await resolveSettlementEvidence({
      deviceBundle: dev.slot(),
      registeredSigner: { algorithm: "ed25519", publicKey: `0x${toHex(other.publicKey)}` },
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
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(decision.source).toBe("gateway-fallback");
    expect(decision.reason).toBe("no-device-bundle");
  });
});

// ── LO-EV-1 signing byte contract at the real consumer ───────────────────────

describe("verifyDeviceSignedEvidence — LO-EV-1 signing preimage (negative controls)", () => {
  it("rejects a registration-challenge signature replayed as a bundle signature", async () => {
    const dev = realDeviceEvidence();
    const challenge = "pcc-kernel-signing-key:kernel-replay";
    const challengeSig = toHex(nacl.sign.detached(new TextEncoder().encode(challenge), dev.keyPair.secretKey));
    // The bare verify accepts it — the signature is genuine over those bytes —
    // so the digest guard is what stops the cross-protocol replay.
    expect(naclEd25519Verify(challenge, challengeSig, dev.publicKeyHex)).toBe(true);
    const res = await verifyDeviceSignedEvidence({
      signature: { ...dev.signature, value: challengeSig },
      bundleHash: challenge,
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
    });
    expect(res).toMatchObject({ ok: false, reason: "malformed-bundle-hash" });
  });

  it("rejects a signature over the 32 raw digest bytes", async () => {
    const dev = realDeviceEvidence();
    const raw32 = Uint8Array.from(Buffer.from(BUNDLE_HASH.slice("sha256:".length), "hex"));
    const raw32Sig = toHex(nacl.sign.detached(raw32, dev.keyPair.secretKey));
    const res = await verifyDeviceSignedEvidence({
      signature: { ...dev.signature, value: raw32Sig },
      bundleHash: BUNDLE_HASH,
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
    });
    expect(res).toMatchObject({ ok: false, reason: "signature-invalid" });
  });

  it("rejects non-canonical digest forms even when the signature covers that exact string", async () => {
    const hex = BUNDLE_HASH.slice("sha256:".length);
    for (const form of [`0x${hex}`, hex, `sha256:${hex.toUpperCase()}`, `${BUNDLE_HASH}\n`]) {
      const dev = realDeviceEvidence(form);
      const res = await verifyDeviceSignedEvidence({
        signature: dev.signature,
        bundleHash: form,
        registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
      });
      expect(res, form).toMatchObject({ ok: false, reason: "malformed-bundle-hash" });
    }
  });

  it("still accepts the canonical tagged digest (positive control)", async () => {
    const dev = realDeviceEvidence();
    const res = await verifyDeviceSignedEvidence({
      signature: dev.signature,
      bundleHash: dev.bundleHash,
      registeredSigner: { algorithm: "ed25519", publicKey: dev.publicKeyHex },
    });
    expect(res).toMatchObject({ ok: true });
  });
});

// ── LO-EV-9 evidence subject binding at the settlement seam ──────────────────
//
// Each negative first shows that the signature leg ALONE accepts the replayed
// evidence (it is a genuine signature by the right key), then that settlement
// refuses it because the signed digest does not open to events committing this
// job on this job's kernel.

describe("LO-EV-9 — settlement binds device evidence to the accepted job and kernel", () => {
  it("evidence from job A cannot satisfy job B (same node, genuine signature)", async () => {
    const a = await boundDeviceEvidence({ jobId: "job-a" });
    const signer = ed25519Signer(a.keyPair.publicKey);
    expect(
      await verifyDeviceSignedEvidence({
        signature: a.signature,
        bundleHash: a.bundleHash,
        registeredSigner: signer,
      }),
    ).toMatchObject({ ok: true });

    const replayed = await resolveSettlementEvidence({
      deviceBundle: a.slot({ jobId: "job-b", kernelId: a.kernelId }),
      registeredSigner: signer,
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(replayed).toMatchObject({
      source: "gateway-fallback",
      reason: "job-mismatch",
      bundleHash: GATEWAY_FALLBACK.bundleHash,
    });

    const own = await resolveSettlementEvidence({
      deviceBundle: a.slot(),
      registeredSigner: signer,
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(own).toMatchObject({ source: "device", bundleHash: a.bundleHash });
  });

  it("the anchor carries the binding's canonical snapshots, never the caller's objects", async () => {
    const a = await boundDeviceEvidence({ jobId: "job-a" });
    const slot = a.slot();
    const live = slot.events![0] as Record<string, unknown>;
    const decision = await resolveSettlementEvidence({
      deviceBundle: slot,
      registeredSigner: ed25519Signer(a.keyPair.publicKey),
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(decision.source).toBe("device");
    const anchored = decision.events as Record<string, unknown>[];
    expect(anchored).toEqual(JSON.parse(JSON.stringify(slot.events)));
    expect(anchored[0]).not.toBe(live);
    // A later change to the caller's copy cannot reach what was verified.
    (live.payload as Record<string, unknown>).tampered = true;
    expect(anchored[0]!.payload).not.toHaveProperty("tampered");
  });

  it("evidence for node A cannot be substituted for node B", async () => {
    const nodeA = nacl.sign.keyPair();
    const nodeB = nacl.sign.keyPair();
    const fromA = await boundDeviceEvidence({ jobId: "job-shared", kernelId: "kernel-a", keyPair: nodeA });

    // The job was accepted by kernel-b, so kernel-b's registered key is the signer.
    const substituted = await resolveSettlementEvidence({
      deviceBundle: fromA.slot({ jobId: "job-shared", kernelId: "kernel-b" }),
      registeredSigner: ed25519Signer(nodeB.publicKey),
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(substituted).toMatchObject({ source: "gateway-fallback", reason: "kernel-mismatch" });

    // Node A cannot get round that by signing events that claim to be kernel-b:
    // they bind, but the signature is checked against kernel-b's registered key.
    const claimsB = await boundDeviceEvidence({ jobId: "job-shared", kernelId: "kernel-b", keyPair: nodeA });
    const forged = await resolveSettlementEvidence({
      deviceBundle: claimsB.slot(),
      registeredSigner: ed25519Signer(nodeB.publicKey),
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(forged).toMatchObject({ source: "gateway-fallback", reason: "signature-invalid" });
  });

  it("relabelling the stored events cannot move a bundle to another job", async () => {
    const a = await boundDeviceEvidence({ jobId: "job-a" });
    const relabelled = a.events.map((e) => ({ ...e, payload: { ...e.payload, jobId: "job-b" } }));
    const decision = await resolveSettlementEvidence({
      deviceBundle: {
        ...a.slot({ jobId: "job-b", kernelId: a.kernelId }),
        events: relabelled,
      },
      registeredSigner: ed25519Signer(a.keyPair.publicKey),
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(decision).toMatchObject({ source: "gateway-fallback", reason: "event-hash-mismatch" });
  });

  it("a log-chain entry signature cannot anchor settlement", async () => {
    const node = nacl.sign.keyPair();
    const signer = ed25519Signer(node.publicKey);
    const entryHash = await computeLogEntryHash(
      "print started",
      "octoprint",
      "2026-09-24T10:00:01.000Z",
    );
    const signature: StoredSignature = {
      signer: `0x${toHex(node.publicKey).slice(0, 40)}`,
      algorithm: "ed25519",
      value: toHex(nacl.sign.detached(signingPreimage(entryHash), node.secretKey)),
    };
    // A genuine signature by the registered key over a tagged digest, so the
    // signature leg alone cannot tell it from a bundle signature.
    expect(
      await verifyDeviceSignedEvidence({ signature, bundleHash: entryHash, registeredSigner: signer }),
    ).toMatchObject({ ok: true });

    const decision = await resolveSettlementEvidence({
      deviceBundle: {
        bundleHash: entryHash,
        kernelSignature: signature,
        assuranceTier: 0,
        events: [],
        subject: { jobId: SUBJECT_JOB, kernelId: SUBJECT_KERNEL },
      },
      registeredSigner: signer,
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(decision).toMatchObject({ source: "gateway-fallback", reason: "missing-events" });
  });

  it("a delegation scoped to several jobs does not let job A's bundle settle job B", async () => {
    const principal = nacl.sign.keyPair();
    const session = nacl.sign.keyPair();
    const now = Math.floor(Date.now() / 1000);
    const body = {
      sessionId: "session-multi-contract",
      parentAgentId: "eip155:1:0x0000000000000000000000000000000000000001",
      publicKey: session.publicKey,
      issuedAt: now,
      expiresAt: now + 300,
      scope: {
        allowedActions: ["evidence_submit"],
        contractIds: ["job-a", "job-b"],
        maxSignatures: 10,
      },
    };
    const auth: SessionKeyAuthorization = {
      ...body,
      publicKey: toHex(session.publicKey),
      parentSignature: toHex(
        nacl.sign.detached(sessionKeyDelegationPreimage(body), principal.secretKey),
      ),
    };
    const a = await boundDeviceEvidence({ jobId: "job-a", keyPair: session });
    const signer = ed25519Signer(principal.publicKey);

    // job-b is inside the delegation's scope, so the signature leg accepts it.
    expect(
      await verifyDeviceSignedEvidence({
        signature: a.signature,
        bundleHash: a.bundleHash,
        registeredSigner: signer,
        sessionKeyAuthorization: auth,
        contractId: "job-b",
      }),
    ).toMatchObject({ ok: true });

    const replayed = await resolveSettlementEvidence({
      deviceBundle: {
        ...a.slot({ jobId: "job-b", kernelId: a.kernelId }),
        sessionKeyAuthorization: auth,
      },
      registeredSigner: signer,
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(replayed).toMatchObject({ source: "gateway-fallback", reason: "job-mismatch" });

    const own = await resolveSettlementEvidence({
      deviceBundle: { ...a.slot(), sessionKeyAuthorization: auth },
      registeredSigner: signer,
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(own).toMatchObject({ source: "device", bundleHash: a.bundleHash });
  });

  it("a real kernel-sdk bundle opens to its own events and anchors; for another job it does not", async () => {
    const principal = nacl.sign.keyPair();
    const kernelId = "kernel-sdk-subject";
    const jobId = "job-sdk-subject";
    const handler = createKernelHandler({
      manifest: {
        manifestVersion: "1.0.0",
        kernelId,
        name: "Subject Kernel",
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
    // What the relay stores and /complete reads back: JSON, not live objects.
    const storedEvents = JSON.parse(JSON.stringify(evidenceBundle.events)) as unknown[];
    const slot = (subject: EvidenceSubject): SettlementEvidenceSlot => ({
      bundleHash: evidenceBundle.bundleHash,
      kernelSignature: evidenceBundle.kernelSignature,
      assuranceTier: 0,
      sessionKeyAuthorization: evidenceBundle.sessionKeyAuthorization,
      events: storedEvents,
      subject,
    });
    const signer = ed25519Signer(principal.publicKey);

    const own = await resolveSettlementEvidence({
      deviceBundle: slot({ jobId, kernelId }),
      registeredSigner: signer,
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(own).toMatchObject({ source: "device", bundleHash: evidenceBundle.bundleHash });

    const other = await resolveSettlementEvidence({
      deviceBundle: slot({ jobId: "job-sdk-other", kernelId }),
      registeredSigner: signer,
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(other).toMatchObject({ source: "gateway-fallback", reason: "job-mismatch" });
  });

  it("a device slot with no subject, no events, or a contract id that disagrees never anchors", async () => {
    const a = await boundDeviceEvidence();
    const signer = ed25519Signer(a.keyPair.publicKey);
    const cases: Array<[SettlementEvidenceSlot, string]> = [
      [{ ...a.slot(), subject: undefined }, "missing-subject"],
      [{ ...a.slot(), events: undefined }, "missing-events"],
      [{ ...a.slot(), contractId: "job-elsewhere" }, "contract-subject-mismatch"],
    ];
    for (const [deviceBundle, reason] of cases) {
      const decision = await resolveSettlementEvidence({
        deviceBundle,
        registeredSigner: signer,
        fallback: GATEWAY_FALLBACK,
        gateOpen: true,
      });
      expect(decision, reason).toMatchObject({ source: "gateway-fallback", reason });
    }
  });

  it("a replayed row stored first cannot hide the genuine bundle", async () => {
    const node = nacl.sign.keyPair();
    const signer = ed25519Signer(node.publicKey);
    const fromA = await boundDeviceEvidence({ jobId: "job-a", keyPair: node });
    const forB = await boundDeviceEvidence({ jobId: "job-b", keyPair: node });

    const decision = await resolveSettlementEvidence({
      deviceBundles: [fromA.slot({ jobId: "job-b", kernelId: fromA.kernelId }), forB.slot()],
      registeredSigner: signer,
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(decision).toMatchObject({ source: "device", bundleHash: forB.bundleHash });

    const allBad = await resolveSettlementEvidence({
      deviceBundles: [
        fromA.slot({ jobId: "job-b", kernelId: fromA.kernelId }),
        { ...forB.slot(), subject: undefined },
      ],
      registeredSigner: signer,
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(allBad).toMatchObject({ source: "gateway-fallback", reason: "job-mismatch" });

    const none = await resolveSettlementEvidence({
      deviceBundles: [],
      registeredSigner: signer,
      fallback: GATEWAY_FALLBACK,
      gateOpen: true,
    });
    expect(none).toMatchObject({ source: "gateway-fallback", reason: "no-device-bundle" });
  });
});

// ── Strict transport decoding + conditional-field preservation (R20 review) ──
//
// Pre-existing gaps the LO-EV-1 review found in this module: Buffer.from(hex)
// silently truncated malformed signature and key suffixes, and derivationPath was
// kept only when truthy. Defined fields are now reproduced as signed, and an empty
// path is refused by the contract (R20 round 2), so neither change widens.

describe("device evidence — strict transport decoding (no truncation)", () => {
  it("a signature or key with a trailing nibble or junk is rejected, not truncated", () => {
    const dev = realDeviceEvidence();
    const sig = dev.signature.value;
    // What the old decoder did: the odd nibble / junk was dropped silently.
    expect(Buffer.from(sig + "0", "hex").length).toBe(64);
    expect(Buffer.from(sig + "zz", "hex").length).toBe(64);
    for (const bad of [sig + "0", sig + "zz", sig.slice(0, -1)]) {
      expect(naclEd25519Verify(dev.bundleHash, bad, dev.publicKeyHex), bad.length.toString()).toBe(false);
    }
    expect(naclEd25519Verify(dev.bundleHash, sig, dev.publicKeyHex + "0")).toBe(false);
    // The exact-length forms the gateway always accepted still verify.
    expect(naclEd25519Verify(dev.bundleHash, sig, dev.publicKeyHex)).toBe(true);
    expect(naclEd25519Verify(dev.bundleHash, `0x${sig.toUpperCase()}`, dev.publicKeyHex.toUpperCase().replace("0X", "0x"))).toBe(true);
  });
});

describe("device evidence — derivationPath absent, empty and non-empty, against the old gateway (R20 round 2)", () => {
  // The pre-LO-EV-1 gateway rebuilt the delegation keeping derivationPath only when
  // truthy, so a principal who signed an explicitly empty path never verified there.
  // The contract now refuses an empty path before any signature check: a labelled
  // tightening, so nothing the old gateway rejected is accepted now.
  const principal = nacl.sign.keyPair();
  const session = nacl.sign.keyPair();
  const now = Math.floor(Date.now() / 1000);
  const base = {
    sessionId: "session-path",
    parentAgentId: "eip155:1:0x0000000000000000000000000000000000000001",
    issuedAt: now,
    expiresAt: now + 300,
    scope: { allowedActions: ["evidence_submit"], contractIds: ["job-path"], maxSignatures: 10 },
  };
  // What a principal signs: the contract's key order, the path kept whenever defined
  // (the incumbent producer rule), built by hand so an empty path can be signed at all.
  const signedBytes = (path: string | undefined) =>
    new TextEncoder().encode(
      JSON.stringify({
        sessionId: base.sessionId,
        parentAgentId: base.parentAgentId,
        publicKey: toHex(session.publicKey),
        issuedAt: base.issuedAt,
        expiresAt: base.expiresAt,
        scope: base.scope,
        ...(path !== undefined ? { derivationPath: path } : {}),
      }),
    );
  const parentSignature = (path: string | undefined) => nacl.sign.detached(signedBytes(path), principal.secretKey);
  /** The old gateway: the same bytes, except the path was dropped when falsy. */
  const oldGatewayVerifies = (path: string | undefined) =>
    nacl.sign.detached.verify(signedBytes(path ? path : undefined), parentSignature(path), principal.publicKey);
  const newGateway = (path: string | undefined) => {
    const bundleHash = `sha256:${"cd".repeat(32)}`;
    return verifyDeviceSignedEvidence({
      signature: {
        signer: `0x${toHex(session.publicKey).slice(0, 40)}`,
        algorithm: "ed25519",
        value: toHex(nacl.sign.detached(signingPreimage(bundleHash), session.secretKey)),
      } as StoredSignature,
      bundleHash,
      registeredSigner: { algorithm: "ed25519", publicKey: `0x${toHex(principal.publicKey)}` },
      sessionKeyAuthorization: {
        ...base,
        publicKey: toHex(session.publicKey),
        parentSignature: toHex(parentSignature(path)),
        ...(path !== undefined ? { derivationPath: path } : {}),
      } as SessionKeyAuthorization,
      contractId: "job-path",
    });
  };

  it("absent: accepted before and after", async () => {
    expect(oldGatewayVerifies(undefined)).toBe(true);
    expect(await newGateway(undefined)).toMatchObject({ ok: true });
  });

  it("non-empty: accepted before and after", async () => {
    expect(oldGatewayVerifies("m/44'/0'/0'")).toBe(true);
    expect(await newGateway("m/44'/0'/0'")).toMatchObject({ ok: true });
  });

  it("empty: rejected before (bytes differed) and refused now before any signature check", async () => {
    expect(oldGatewayVerifies("")).toBe(false);
    expect(await newGateway("")).toEqual({ ok: false, reason: "session_key_malformed" });
  });
});

// ── LO-EV-9 review R1: re-verifying the pinned settlement anchor on recovery ──

import { buildCanonicalEvidenceEnvelope } from "../services/evidence-envelope.js";
import { createHash } from "node:crypto";

describe("verifyPinnedSettlementEvidence — what recovery may settle on", () => {
  async function deviceRow(jobId = SUBJECT_JOB, kernelId = SUBJECT_KERNEL) {
    const dev = await boundDeviceEvidence({ jobId, kernelId });
    const row = {
      id: "ev-relayed-1",
      jobId,
      stepId: "operator-relay",
      kernelId,
      assuranceTier: 0,
      createdAt: "2026-09-24T12:00:00.000Z",
      bundleHash: dev.bundleHash,
      kernelSignature: dev.signature,
    };
    return { dev, row, signer: ed25519Signer(dev.keyPair.publicKey) };
  }

  function gatewayRow(events: Array<Record<string, unknown>> = []) {
    const meta = {
      id: "bundle-gw-1",
      jobId: SUBJECT_JOB,
      stepId: "step-1",
      kernelId: SUBJECT_KERNEL,
      assuranceTier: 0,
      createdAt: "2026-09-24T12:00:00.000Z",
      kernelSignature: { signer: ZERO_ADDRESS, algorithm: "ed25519", value: "gateway-auto-sign" },
    };
    const bundleHash = `sha256:${createHash("sha256").update(buildCanonicalEvidenceEnvelope(meta, events as never)).digest("hex")}`;
    return { ...meta, bundleHash };
  }

  it("a device anchor that still binds and verifies may be settled", async () => {
    const { dev, row, signer } = await deviceRow();
    expect(
      await verifyPinnedSettlementEvidence({
        jobId: SUBJECT_JOB,
        kernelId: SUBJECT_KERNEL,
        row,
        events: dev.events,
        registeredSigner: signer,
      }),
    ).toEqual({ ok: true });
  });

  it("a device anchor whose stored events were altered may not", async () => {
    const { dev, row, signer } = await deviceRow();
    const altered = dev.events.map((e, i) => (i === 0 ? { ...e, payload: { ...e.payload, extra: 1 } } : e));
    expect(
      await verifyPinnedSettlementEvidence({
        jobId: SUBJECT_JOB,
        kernelId: SUBJECT_KERNEL,
        row,
        events: altered,
        registeredSigner: signer,
      }),
    ).toEqual({ ok: false, reason: "event-hash-mismatch" });
  });

  it("a device anchor is re-checked against the kernel's registered key", async () => {
    const { dev, row } = await deviceRow();
    expect(
      await verifyPinnedSettlementEvidence({
        jobId: SUBJECT_JOB,
        kernelId: SUBJECT_KERNEL,
        row,
        events: dev.events,
        registeredSigner: ed25519Signer(nacl.sign.keyPair().publicKey),
      }),
    ).toEqual({ ok: false, reason: "signature-invalid" });
  });

  it("a row for another job or another kernel may not be settled for this one", async () => {
    const { dev, row, signer } = await deviceRow();
    const base = { events: dev.events, registeredSigner: signer };
    expect(
      await verifyPinnedSettlementEvidence({ ...base, jobId: "job-other", kernelId: SUBJECT_KERNEL, row }),
    ).toEqual({ ok: false, reason: "pinned-evidence-job-mismatch" });
    expect(
      await verifyPinnedSettlementEvidence({ ...base, jobId: SUBJECT_JOB, kernelId: "kernel-other", row }),
    ).toEqual({ ok: false, reason: "pinned-evidence-kernel-mismatch" });
  });

  it("a gateway anchor must recompute from its stored envelope", async () => {
    const events = [
      { id: "e1", type: "execution_completed", timestamp: "t", source: { deviceId: "gateway", deviceType: "controller", kernelId: SUBJECT_KERNEL }, payload: { toolCallCount: 1 }, hash: "sha256:" + "0".repeat(64) },
    ];
    const row = gatewayRow(events);
    const base = { jobId: SUBJECT_JOB, kernelId: SUBJECT_KERNEL, registeredSigner: null };
    expect(await verifyPinnedSettlementEvidence({ ...base, row, events })).toEqual({ ok: true });
    const altered = [{ ...events[0]!, payload: { toolCallCount: 2 } }];
    expect(await verifyPinnedSettlementEvidence({ ...base, row, events: altered })).toEqual({
      ok: false,
      reason: "pinned-evidence-hash-mismatch",
    });
    expect(await verifyPinnedSettlementEvidence({ ...base, row: { ...row, bundleHash: "sha256:trapped" }, events })).toEqual({
      ok: false,
      reason: "pinned-evidence-hash-mismatch",
    });
  });

  it("no pinned row, no settlement", async () => {
    expect(
      await verifyPinnedSettlementEvidence({
        jobId: SUBJECT_JOB,
        kernelId: SUBJECT_KERNEL,
        row: undefined,
        events: [],
        registeredSigner: null,
      }),
    ).toEqual({ ok: false, reason: "no-pinned-evidence" });
  });
});
