/**
 * Tests for createKernelHandler's optional preflight() seam — the R3
 * resource-tracker gate on the third-party kernel-builder SDK path.
 *
 * Acceptance (ROBOTICS-BUILD-SPEC.md §R3): an under-resourced job is
 * refused at preflight() before escrow/execute(); a sufficient job
 * passes; tests green.
 *
 * The seam sits AFTER inbound auth verification and BEFORE the session
 * key is minted / execute() is invoked — see job-handler.ts.
 */

import { describe, it, expect, vi } from "vitest";
import nacl from "tweetnacl";
import type { PrincipalKey } from "@pcc/spec";
import { createKernelHandler, KernelAuthError, KernelPreflightError, type PreflightCheckResult } from "../job-handler.js";
import { buildManifest } from "../manifest-builder.js";

function makeManifest() {
  return buildManifest({
    kernelId: "kernel-preflight-test",
    name: "Preflight Test Kernel",
    builder: { agentId: "eip155:8453:0x1111111111111111111111111111111111111111" },
    capabilityType: "test-capability",
    workflowSteps: [{ stepId: "step-1", stepType: "transform", description: "test step", dependsOn: [] }],
    maxAssuranceTier: 0,
    endpointURL: "https://example.test/run",
  });
}

function makePrincipal(): { principalKey: PrincipalKey; principalPrivateKey: Uint8Array } {
  const kp = nacl.sign.keyPair();
  const principalKey: PrincipalKey = {
    agentId: "eip155:8453:0x1111111111111111111111111111111111111111",
    walletAddress: "0x1111111111111111111111111111111111111111",
    publicKey: kp.publicKey,
  };
  return { principalKey, principalPrivateKey: kp.secretKey };
}

describe("createKernelHandler — preflight() seam", () => {
  it("refuses an under-resourced job BEFORE minting a session key or calling execute()", async () => {
    const { principalKey, principalPrivateKey } = makePrincipal();
    const execute = vi.fn().mockResolvedValue({ result: "should never run" });
    const preflight = vi.fn().mockResolvedValue({
      ok: false,
      reason: "insufficient_resource",
      details: { resource: "filamentGrams", requested: 200, available: 50 },
    } satisfies PreflightCheckResult);

    const handler = createKernelHandler({
      manifest: makeManifest(),
      principalKey,
      principalPrivateKey,
      execute,
      preflight,
    });

    await expect(handler({ jobId: "job-under", input: { filamentGrams: 200 } })).rejects.toThrow(
      KernelPreflightError,
    );

    expect(preflight).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledWith({ filamentGrams: 200 });
    // The whole point of the seam: execute() must never be reached.
    expect(execute).not.toHaveBeenCalled();
  });

  it("carries the typed refusal reason/details on the thrown error", async () => {
    const { principalKey, principalPrivateKey } = makePrincipal();
    const preflight = vi.fn().mockResolvedValue({
      ok: false,
      reason: "insufficient_resource",
      details: { resource: "filamentGrams", requested: 200, available: 50 },
    } satisfies PreflightCheckResult);

    const handler = createKernelHandler({
      manifest: makeManifest(),
      principalKey,
      principalPrivateKey,
      execute: vi.fn(),
      preflight,
    });

    try {
      await handler({ jobId: "job-under", input: {} });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelPreflightError);
      const e = err as KernelPreflightError;
      expect(e.reason).toBe("insufficient_resource");
      expect(e.details).toMatchObject({ resource: "filamentGrams" });
    }
  });

  it("passes a sufficient job through to execute() and returns a normal response", async () => {
    const { principalKey, principalPrivateKey } = makePrincipal();
    const execute = vi.fn().mockResolvedValue({ printed: true });
    const preflight = vi.fn().mockResolvedValue({ ok: true } satisfies PreflightCheckResult);

    const handler = createKernelHandler({
      manifest: makeManifest(),
      principalKey,
      principalPrivateKey,
      execute,
      preflight,
    });

    const response = await handler({ jobId: "job-ok", input: { filamentGrams: 50 } });

    expect(preflight).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(response.output).toEqual({ printed: true });
    expect(response.evidenceBundle).toBeDefined();
    expect(response.kernelSessionPublicKey).toBeTruthy();
  });

  it("kernels with no preflight option behave exactly as before (backward compatible)", async () => {
    const { principalKey, principalPrivateKey } = makePrincipal();
    const execute = vi.fn().mockResolvedValue({ ok: true });

    const handler = createKernelHandler({
      manifest: makeManifest(),
      principalKey,
      principalPrivateKey,
      execute,
      // no preflight option supplied
    });

    const response = await handler({ jobId: "job-no-preflight", input: {} });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(response.output).toEqual({ ok: true });
  });

  it("preflight runs AFTER auth verification — a bad session signature refuses on auth, never reaching preflight", async () => {
    const { principalKey, principalPrivateKey } = makePrincipal();
    const preflight = vi.fn().mockResolvedValue({ ok: true } satisfies PreflightCheckResult);
    const handler = createKernelHandler({
      manifest: makeManifest(),
      principalKey,
      principalPrivateKey,
      execute: vi.fn(),
      preflight,
    });

    const fakeKeypair = nacl.sign.keyPair();
    await expect(
      handler({
        jobId: "job-bad-auth",
        input: {},
        auth: {
          eventData: Buffer.from("some-data").toString("hex"),
          sessionSignature: Buffer.from(new Uint8Array(64)).toString("hex"), // all-zero, invalid
          sessionPublicKey: Buffer.from(fakeKeypair.publicKey).toString("hex"),
          action: "evidence_submit",
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    ).rejects.toThrow(KernelAuthError);

    expect(preflight).not.toHaveBeenCalled();
  });
});
