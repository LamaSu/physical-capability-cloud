/**
 * DCC5 upgrade-worker integration tests.
 *
 * End-to-end: enqueue → runOnce drains Boundless → ReceiptStore receives
 * upgrade → queue marked complete.
 */

import { describe, it, expect } from "vitest";
import {
  createInMemoryUpgradeQueue,
  runOnce,
  createUpgradeJob,
  type ReceiptStore,
  type AutomataConfig,
} from "../dcc5-upgrade-worker.js";
import { createMockBoundlessClient } from "../zk/automata-tee-wrap.js";
import type { InvocationReceipt } from "@pcc/spec";
import { DigitalCaptureClass } from "@pcc/spec";

const SHA = "sha256:" + "a".repeat(64);

function makeDcc4Receipt(): InvocationReceipt {
  return {
    receiptId: "rcpt-1",
    receiptCID: SHA,
    schemaVersion: "1.0",
    indexedToolId: "tool-1",
    toolCID: SHA,
    toolSchemaHashAtCall: SHA,
    requestProjection: {
      method: "POST",
      url: "https://example.com",
      headersHash: SHA,
      bodyHash: SHA,
      middlewareRedactions: [],
      timestamp: "2026-05-25T00:00:00.000Z",
    },
    responseProjection: {
      status: 200,
      headersHash: SHA,
      bodyHash: SHA,
      middlewareRedactions: [],
      timestamp: "2026-05-25T00:00:01.000Z",
    },
    requestedDccClass: DigitalCaptureClass.DCC5,
    effectiveDccClass: DigitalCaptureClass.DCC4,
    downgradeReason: "DCC5 proof pending — currently at DCC4",
    pccSignature: "sig-pcc",
    pccKeyId: "pcc-key-1",
    teeQuote: "b".repeat(900), // base64 stub
    teeMeasurements: {
      vendor: "intel-tdx",
      observedMeasurement: "a".repeat(96),
      quoteFormat: "tdx-v4",
      reportData: "f".repeat(128),
      expectedReportData: "f".repeat(128),
      measurementMatch: true,
      certChainValid: true,
    },
    callerAgentId: "agent-1",
    callerSessionId: "sess-1",
    pccFeeBps: 100,
  };
}

function makeInMemoryStore(
  initial: InvocationReceipt,
): { store: ReceiptStore; persisted: InvocationReceipt[]; baseCid: string } {
  const baseCid = initial.receiptCID;
  const upgradedList: InvocationReceipt[] = [];
  const store: ReceiptStore = {
    async findByCid(cid) {
      if (cid === baseCid) return initial;
      return upgradedList.find((u) => u.receiptCID === cid) ?? null;
    },
    async persistUpgrade(upgraded) {
      const newCid = "sha256:" + "b".repeat(64);
      const persisted = { ...upgraded, receiptCID: newCid };
      upgradedList.push(persisted);
      return { newCid };
    },
  };
  return { store, persisted: upgradedList, baseCid };
}

function makeAutomataConfig(): AutomataConfig {
  return {
    resolveForTool: () => ({
      automataImageId: "automata-image-v1",
      verificationKeyHash: "vk-sha256:" + "c".repeat(64),
      onchainVerifier: { chainId: 84532, address: "0x" + "1".repeat(40) },
    }),
  };
}

describe("dcc5-upgrade-worker", () => {
  it("processes a completed Boundless job and persists upgraded receipt", async () => {
    const receipt = makeDcc4Receipt();
    const { store, persisted, baseCid } = makeInMemoryStore(receipt);
    const queue = createInMemoryUpgradeQueue();
    const client = createMockBoundlessClient({ proveDelayMs: 10 });
    const { jobId } = await client.submitTeeWrapJob(new Uint8Array(100), {
      zkSystem: "sp1",
    });

    await queue.enqueue(
      createUpgradeJob({
        baseReceiptCid: baseCid,
        boundlessJobId: jobId,
        toolId: "tool-1",
        zkSystem: "sp1",
      }),
    );

    // First runOnce: still proving (proveDelayMs=10ms but we polled immediately)
    const first = await runOnce({
      client,
      queue,
      store,
      automata: makeAutomataConfig(),
    });
    expect(first?.status).toBe("pending");

    // Wait for mock to "complete"
    await new Promise((r) => setTimeout(r, 50));
    const second = await runOnce({
      client,
      queue,
      store,
      automata: makeAutomataConfig(),
    });
    expect(second?.status).toBe("complete");
    expect(second?.upgradedReceiptCid).toMatch(/^sha256:/);

    // Verify upgrade contents
    expect(persisted).toHaveLength(1);
    const upgraded = persisted[0]!;
    expect(upgraded.effectiveDccClass).toBe(DigitalCaptureClass.DCC5);
    expect(upgraded.zkProof).toBeDefined();
    expect(upgraded.zkProofMetadata?.zkSystem).toBe("sp1");
    expect(upgraded.zkProofMetadata?.statement).toBe("tee-wrap");
    expect(upgraded.zkSystem).toBe("sp1");
    expect(upgraded.zkProofVerifierAddress?.chainId).toBe(84532);
  });

  it("fails when toolId has no Automata config", async () => {
    const receipt = makeDcc4Receipt();
    const { store, baseCid } = makeInMemoryStore(receipt);
    const queue = createInMemoryUpgradeQueue();
    const client = createMockBoundlessClient({ proveDelayMs: 10 });
    const { jobId } = await client.submitTeeWrapJob(new Uint8Array(100), {
      zkSystem: "sp1",
    });

    await queue.enqueue(
      createUpgradeJob({
        baseReceiptCid: baseCid,
        boundlessJobId: jobId,
        toolId: "tool-without-dcc5",
        zkSystem: "sp1",
      }),
    );

    await new Promise((r) => setTimeout(r, 50));
    const result = await runOnce({
      client,
      queue,
      store,
      automata: { resolveForTool: () => null }, // simulate no opt-in
    });
    expect(result?.status).toBe("failed");
    expect(result?.reason).toMatch(/no DCC5 opt-in/);
  });

  it("fails when base receipt is missing", async () => {
    const receipt = makeDcc4Receipt();
    const store: ReceiptStore = {
      async findByCid() {
        return null;
      },
      async persistUpgrade(u) {
        return { newCid: u.receiptCID };
      },
    };
    const queue = createInMemoryUpgradeQueue();
    const client = createMockBoundlessClient({ proveDelayMs: 10 });
    const { jobId } = await client.submitTeeWrapJob(new Uint8Array(100), {
      zkSystem: "sp1",
    });

    await queue.enqueue(
      createUpgradeJob({
        baseReceiptCid: receipt.receiptCID,
        boundlessJobId: jobId,
        toolId: "tool-1",
        zkSystem: "sp1",
      }),
    );

    await new Promise((r) => setTimeout(r, 50));
    const result = await runOnce({
      client,
      queue,
      store,
      automata: makeAutomataConfig(),
    });
    expect(result?.status).toBe("failed");
    expect(result?.reason).toMatch(/base receipt CID not found/);
  });

  it("fails when boundless reports failure", async () => {
    const receipt = makeDcc4Receipt();
    const { store, baseCid } = makeInMemoryStore(receipt);
    const queue = createInMemoryUpgradeQueue();
    const client = createMockBoundlessClient({ failOnPoll: true });
    const { jobId } = await client.submitTeeWrapJob(new Uint8Array(100), {
      zkSystem: "sp1",
    });

    await queue.enqueue(
      createUpgradeJob({
        baseReceiptCid: baseCid,
        boundlessJobId: jobId,
        toolId: "tool-1",
        zkSystem: "sp1",
      }),
    );

    const result = await runOnce({
      client,
      queue,
      store,
      automata: makeAutomataConfig(),
    });
    expect(result?.status).toBe("failed");
    expect(result?.reason).toMatch(/mock boundless poll failure/);
  });

  it("returns null when queue is empty", async () => {
    const queue = createInMemoryUpgradeQueue();
    const result = await runOnce({
      client: createMockBoundlessClient(),
      queue,
      store: makeInMemoryStore(makeDcc4Receipt()).store,
      automata: makeAutomataConfig(),
    });
    expect(result).toBeNull();
  });

  it("respects maxJobLifetimeMs", async () => {
    const receipt = makeDcc4Receipt();
    const { store, baseCid } = makeInMemoryStore(receipt);
    const queue = createInMemoryUpgradeQueue();
    const client = createMockBoundlessClient({ proveDelayMs: 999999 });
    const { jobId } = await client.submitTeeWrapJob(new Uint8Array(100), {
      zkSystem: "sp1",
    });

    const job = createUpgradeJob({
      baseReceiptCid: baseCid,
      boundlessJobId: jobId,
      toolId: "tool-1",
      zkSystem: "sp1",
    });
    job.enqueuedAt = Date.now() - 700_000; // pretend it's 700 s old
    await queue.enqueue(job);

    const result = await runOnce({
      client,
      queue,
      store,
      automata: makeAutomataConfig(),
      maxJobLifetimeMs: 600_000,
    });
    expect(result?.status).toBe("failed");
    expect(result?.reason).toMatch(/lifetime exceeded/);
  });
});
