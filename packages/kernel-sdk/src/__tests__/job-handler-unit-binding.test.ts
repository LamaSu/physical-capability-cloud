/**
 * The kernel commits the settlement unit and its challenge nonce in the events
 * it signs, so evidence for one milestone cannot settle another milestone of
 * the same job (LO-EV-9 unit binding; the oracle's milestone-replay finding).
 */
import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { verifyEvidenceSubjectBinding } from "@pcc/spec";
import { createKernelHandler, KernelAuthError } from "../job-handler.js";

const U3 = "0x" + "03".repeat(32);
const U4 = "0x" + "04".repeat(32);
const NONCE = "0x" + "a3".repeat(32);
const KERNEL = "kernel-unit-binding";

function handler() {
  const principal = nacl.sign.keyPair();
  return createKernelHandler({
    manifest: {
      manifestVersion: "1.0.0",
      kernelId: KERNEL,
      name: "Unit Kernel",
      description: "test",
      builder: { agentId: "agent:test" },
      capabilityType: "test.transform",
      workflowSteps: [],
      pricing: { currency: "USDC", baseUSD: 0 },
      maxAssuranceTier: 0,
      endpointURL: "https://example.test/run",
      sessionKeyPolicy: { maxTTLSeconds: 300, allowedActions: ["evidence_submit"] },
      status: "pending",
    } as never,
    principalKey: {
      agentId: "eip155:1:0x0000000000000000000000000000000000000001",
      walletAddress: "0x0000000000000000000000000000000000000001",
      publicKey: principal.publicKey,
    } as never,
    principalPrivateKey: principal.secretKey,
    execute: async () => ({ ok: true }),
  });
}

describe("kernel-sdk commits the settlement unit and challenge nonce it was given", () => {
  it("started and completed carry both, and the bundle binds that unit only", async () => {
    const { evidenceBundle } = await handler()({ jobId: "job-u", input: { v: 1 }, settlementUnitId: U3, challengeNonce: NONCE });
    for (const type of ["execution_started", "execution_completed"]) {
      const e = evidenceBundle.events.find((x) => x.type === type)!;
      expect(e.payload).toMatchObject({ settlementUnitId: U3, challengeNonce: NONCE });
    }
    const subject = { jobId: "job-u", kernelId: KERNEL };
    const bind = (extra: Record<string, string>) =>
      verifyEvidenceSubjectBinding({ bundleHash: evidenceBundle.bundleHash, events: evidenceBundle.events, subject: { ...subject, ...extra } });
    expect(await bind({ settlementUnitId: U3, challengeNonce: NONCE })).toMatchObject({ ok: true });
    expect(await bind({ settlementUnitId: U4 })).toMatchObject({ ok: false, reason: "unit-mismatch" });
  });

  it("a job without a unit keeps its payloads unchanged", async () => {
    const { evidenceBundle } = await handler()({ jobId: "job-plain", input: { v: 1 } });
    for (const e of evidenceBundle.events) {
      expect(e.payload).not.toHaveProperty("settlementUnitId");
      expect(e.payload).not.toHaveProperty("challengeNonce");
    }
  });

  it("a malformed unit or nonce is refused before anything executes", async () => {
    for (const bad of [{ settlementUnitId: U3.toUpperCase().replace("0X", "0x") + "0" }, { challengeNonce: "nonce-3" }, { settlementUnitId: "0x" + "AB".repeat(32) }]) {
      await expect(handler()({ jobId: "job-bad", input: { v: 1 }, ...bad })).rejects.toBeInstanceOf(KernelAuthError);
    }
  });
});
