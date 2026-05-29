/**
 * Automata TEE-wrap (DCC5 S2) tests.
 *
 * Uses createMockBoundlessClient for the prover network and exercises:
 *   - submit returns job id
 *   - poll progresses pending → proving → complete
 *   - buildTeeWrapMetadata composes a valid ZkProofMetadata
 *   - failure paths propagate cleanly
 *
 * Integration with the upgrade-worker happens in dcc5-upgrade-worker.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  submitTeeWrapJob,
  pollTeeWrapJob,
  buildTeeWrapMetadata,
  createMockBoundlessClient,
} from "../automata-tee-wrap.js";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return typeof btoa === "function"
    ? btoa(bin)
    : Buffer.from(bin, "binary").toString("base64");
}

const FAKE_QUOTE_B64 = bytesToBase64(new Uint8Array(700).fill(0x11));

describe("submitTeeWrapJob", () => {
  it("submits and returns a job id", async () => {
    const client = createMockBoundlessClient();
    const { jobId, pollUrl } = await submitTeeWrapJob(FAKE_QUOTE_B64, {
      client,
      zkSystem: "sp1",
    });
    expect(jobId).toMatch(/^mock-job-/);
    expect(pollUrl).toMatch(/^mock:\/\/boundless/);
  });

  it("propagates client failures", async () => {
    const client = createMockBoundlessClient({ failOnSubmit: true });
    await expect(
      submitTeeWrapJob(FAKE_QUOTE_B64, { client, zkSystem: "sp1" }),
    ).rejects.toThrow(/mock boundless submit failure/);
  });
});

describe("pollTeeWrapJob", () => {
  it("returns proving immediately, complete after delay", async () => {
    const client = createMockBoundlessClient({ proveDelayMs: 60 });
    const { jobId } = await client.submitTeeWrapJob(new Uint8Array(100), {
      zkSystem: "sp1",
    });
    const early = await pollTeeWrapJob(jobId, { client });
    expect(early.status).toBe("proving");

    await new Promise((r) => setTimeout(r, 100));
    const late = await pollTeeWrapJob(jobId, { client });
    expect(late.status).toBe("complete");
    expect(late.proofBytesBase64).toBeDefined();
    expect(late.imageId).toBeDefined();
    expect(late.publicInputsHash).toMatch(/^sha256:/);
  });

  it("returns failed when client says so", async () => {
    const client = createMockBoundlessClient({ failOnPoll: true });
    const { jobId } = await client.submitTeeWrapJob(new Uint8Array(100), {
      zkSystem: "sp1",
    });
    const res = await pollTeeWrapJob(jobId, { client });
    expect(res.status).toBe("failed");
    expect(res.reason).toMatch(/mock boundless poll failure/);
  });

  it("returns failed for unknown job ids", async () => {
    const client = createMockBoundlessClient();
    const res = await pollTeeWrapJob("nonexistent-job", { client });
    expect(res.status).toBe("failed");
    expect(res.reason).toMatch(/unknown job id/);
  });
});

describe("buildTeeWrapMetadata", () => {
  it("composes ZkProofMetadata from a completed job", async () => {
    const client = createMockBoundlessClient({ proveDelayMs: 10 });
    const { jobId } = await client.submitTeeWrapJob(new Uint8Array(100), {
      zkSystem: "sp1",
    });
    await new Promise((r) => setTimeout(r, 50));
    const result = await pollTeeWrapJob(jobId, { client });
    expect(result.status).toBe("complete");

    const meta = buildTeeWrapMetadata(result, {
      automataImageId: "image-abc",
      verificationKeyHash: "vk-sha256:def",
      onchainVerifier: { chainId: 84532, address: "0x" + "1".repeat(40) },
      zkSystem: "sp1",
    });
    expect(meta.zkSystem).toBe("sp1");
    expect(meta.statement).toBe("tee-wrap");
    expect(meta.programCid).toBe("image-abc");
    expect(meta.verificationKeyHash).toBe("vk-sha256:def");
    expect(meta.onchainVerifier?.chainId).toBe(84532);
    expect(meta.provingSeconds).toBeGreaterThan(0);
    expect(meta.provingCostUsdc).toBe("0.05");
  });

  it("throws when job is not complete", () => {
    expect(() =>
      buildTeeWrapMetadata(
        { jobId: "j", status: "proving" },
        {
          automataImageId: "i",
          verificationKeyHash: "vk",
          zkSystem: "sp1",
        },
      ),
    ).toThrow(/not complete/);
  });
});
