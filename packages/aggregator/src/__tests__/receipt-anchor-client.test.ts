import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { InvocationReceipt } from "@pcc/spec";
import { DigitalCaptureClass } from "@pcc/spec";
import { signReceipt } from "../receipt-signer.js";
import {
  ReceiptAnchorClient,
  createReceiptAnchorClient,
  buildAnchorRequest,
  type AnchorRequest,
  type BatchManifest,
  type BatchManifestStorage,
  type ChainBackend,
} from "../receipt-anchor-client.js";
import type { Bytes32Hex } from "../merkle.js";
import { verifyMerkleProof } from "../merkle.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const SHA = "sha256:" + "a".repeat(64);

function makeReceipt(opts: { dcc: DigitalCaptureClass; agent?: string; tool?: string; cid?: string }): InvocationReceipt {
  const body = {
    receiptId: `r-${Math.random().toString(36).slice(2)}`,
    schemaVersion: "1.0" as const,
    indexedToolId: opts.tool ?? "tool-x",
    toolCID: SHA,
    toolSchemaHashAtCall: SHA,
    requestProjection: {
      method: "POST",
      url: "https://example.com",
      headersHash: SHA,
      bodyHash: SHA,
      middlewareRedactions: [],
      timestamp: "2026-05-23T00:00:00.000Z",
    },
    responseProjection: {
      status: 200,
      headersHash: SHA,
      bodyHash: SHA,
      middlewareRedactions: [],
      timestamp: "2026-05-23T00:00:01.000Z",
    },
    requestedDccClass: opts.dcc,
    effectiveDccClass: opts.dcc,
    callerAgentId: opts.agent ?? "agent-a",
    callerSessionId: "session-1",
    pccFeeBps: 100,
  };
  const signed = signReceipt(body, { keyId: "k1", secretHex: "ab".repeat(32) });
  if (opts.cid) {
    return { ...signed, receiptCID: opts.cid as InvocationReceipt["receiptCID"] };
  }
  return signed;
}

// ── Mocks ────────────────────────────────────────────────────────────────

function makeMockChain(): ChainBackend & {
  singleCalls: AnchorRequest[];
  batchCalls: Array<{
    merkleRoot: Bytes32Hex;
    count: number;
    minDccClass: number;
    maxDccClass: number;
    batchMetadataCID: Bytes32Hex;
  }>;
  singleShouldThrow: { value: boolean };
  batchShouldThrow: { value: boolean };
} {
  const single: AnchorRequest[] = [];
  const batches: Array<{
    merkleRoot: Bytes32Hex;
    count: number;
    minDccClass: number;
    maxDccClass: number;
    batchMetadataCID: Bytes32Hex;
  }> = [];
  const singleShouldThrow = { value: false };
  const batchShouldThrow = { value: false };
  return {
    singleCalls: single,
    batchCalls: batches,
    singleShouldThrow,
    batchShouldThrow,
    anchorOne: async (req) => {
      if (singleShouldThrow.value) throw new Error("anchorOne mock failure");
      single.push(req);
      return `0xsingle${single.length}`;
    },
    anchorBatch: async (args) => {
      if (batchShouldThrow.value) throw new Error("anchorBatch mock failure");
      batches.push(args);
      return `0xbatch${batches.length}`;
    },
  };
}

function makeMockStorage(): BatchManifestStorage & { manifests: BatchManifest[] } {
  const manifests: BatchManifest[] = [];
  return {
    manifests,
    publishManifest: async (m) => {
      manifests.push(m);
      // Fake CID for testing.
      return ("0x" + "cd".repeat(32)) as Bytes32Hex;
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("ReceiptAnchorClient — enabled flag", () => {
  it("anchorReceipt is no-op when disabled", () => {
    const chain = makeMockChain();
    const storage = makeMockStorage();
    const c = createReceiptAnchorClient({ enabled: false, chainBackend: chain, manifestStorage: storage });
    const r = makeReceipt({ dcc: DigitalCaptureClass.DCC3 });
    expect(c.anchorReceipt(r)).toEqual({ mode: "disabled" });
    expect(chain.singleCalls).toHaveLength(0);
    expect(chain.batchCalls).toHaveLength(0);
  });

  it("flushBatch returns null when disabled", async () => {
    const chain = makeMockChain();
    const storage = makeMockStorage();
    const c = createReceiptAnchorClient({ enabled: false, chainBackend: chain, manifestStorage: storage });
    await expect(c.flushBatch()).resolves.toBeNull();
  });
});

describe("ReceiptAnchorClient — single anchor path (DCC3+)", () => {
  it("DCC3 receipt routes to anchorOne", async () => {
    const chain = makeMockChain();
    const storage = makeMockStorage();
    const c = createReceiptAnchorClient({ enabled: true, chainBackend: chain, manifestStorage: storage });
    const receipt = makeReceipt({ dcc: DigitalCaptureClass.DCC3 });
    const outcome = c.anchorReceipt(receipt);
    expect(outcome.mode).toBe("single");
    if (outcome.mode !== "single") throw new Error("type narrowing");
    await expect(outcome.txHashPromise).resolves.toBe("0xsingle1");
    expect(chain.singleCalls).toHaveLength(1);
    expect(chain.batchCalls).toHaveLength(0);
  });

  it("DCC5 receipt also routes to anchorOne", async () => {
    const chain = makeMockChain();
    const c = createReceiptAnchorClient({ enabled: true, chainBackend: chain, manifestStorage: makeMockStorage() });
    const r = makeReceipt({ dcc: DigitalCaptureClass.DCC5 });
    const o = c.anchorReceipt(r);
    if (o.mode !== "single") throw new Error("expected single");
    await o.txHashPromise;
    expect(chain.singleCalls).toHaveLength(1);
    expect(chain.singleCalls[0].dccClass).toBe(5);
  });

  it("configurable singleAnchorMinDcc=0 forces all to single", async () => {
    const chain = makeMockChain();
    const c = createReceiptAnchorClient({
      enabled: true,
      singleAnchorMinDcc: 0,
      chainBackend: chain,
      manifestStorage: makeMockStorage(),
    });
    const r = makeReceipt({ dcc: DigitalCaptureClass.DCC0 });
    const o = c.anchorReceipt(r);
    if (o.mode !== "single") throw new Error("expected single");
    await o.txHashPromise;
    expect(chain.singleCalls).toHaveLength(1);
  });
});

describe("ReceiptAnchorClient — batch path (DCC0..DCC2)", () => {
  it("DCC1 receipts buffer until flush", async () => {
    const chain = makeMockChain();
    const c = createReceiptAnchorClient({ enabled: true, chainBackend: chain, manifestStorage: makeMockStorage() });
    const r1 = makeReceipt({ dcc: DigitalCaptureClass.DCC1, agent: "a", tool: "t" });
    const r2 = makeReceipt({ dcc: DigitalCaptureClass.DCC1, agent: "a", tool: "t2" });
    const o1 = c.anchorReceipt(r1);
    const o2 = c.anchorReceipt(r2);
    expect(o1).toEqual({ mode: "batched", cidHash: expect.any(String), bufferSize: 1 });
    expect(o2).toEqual({ mode: "batched", cidHash: expect.any(String), bufferSize: 2 });
    expect(c.bufferSize()).toBe(2);
    expect(chain.batchCalls).toHaveLength(0); // not flushed yet

    const result = await c.flushBatch();
    expect(result).not.toBeNull();
    expect(result!.count).toBe(2);
    expect(result!.minDccClass).toBe(1);
    expect(result!.maxDccClass).toBe(1);
    expect(chain.batchCalls).toHaveLength(1);
    expect(c.bufferSize()).toBe(0);
  });

  it("flushBatch returns null on empty buffer", async () => {
    const c = createReceiptAnchorClient({ enabled: true, chainBackend: makeMockChain(), manifestStorage: makeMockStorage() });
    await expect(c.flushBatch()).resolves.toBeNull();
  });

  it("batch min/max DCC reflect tightest/loosest leaves", async () => {
    const chain = makeMockChain();
    const c = createReceiptAnchorClient({ enabled: true, chainBackend: chain, manifestStorage: makeMockStorage() });
    c.anchorReceipt(makeReceipt({ dcc: DigitalCaptureClass.DCC0 }));
    c.anchorReceipt(makeReceipt({ dcc: DigitalCaptureClass.DCC2, agent: "b" }));
    c.anchorReceipt(makeReceipt({ dcc: DigitalCaptureClass.DCC1, agent: "c" }));
    const result = await c.flushBatch();
    expect(result!.minDccClass).toBe(0);
    expect(result!.maxDccClass).toBe(2);
  });

  it("each batch leaf has a verifiable Merkle proof", async () => {
    const chain = makeMockChain();
    const c = createReceiptAnchorClient({ enabled: true, chainBackend: chain, manifestStorage: makeMockStorage() });
    const receipts = [
      makeReceipt({ dcc: DigitalCaptureClass.DCC1, agent: "a" }),
      makeReceipt({ dcc: DigitalCaptureClass.DCC1, agent: "b" }),
      makeReceipt({ dcc: DigitalCaptureClass.DCC1, agent: "c" }),
      makeReceipt({ dcc: DigitalCaptureClass.DCC1, agent: "d" }),
    ];
    for (const r of receipts) c.anchorReceipt(r);
    const result = await c.flushBatch();
    expect(result).not.toBeNull();
    for (const [cidHash, { proof }] of result!.proofs) {
      expect(verifyMerkleProof(cidHash, result!.merkleRoot, proof)).toBe(true);
    }
  });

  it("batch reaching batchMaxLeaves auto-flushes", async () => {
    const chain = makeMockChain();
    const c = createReceiptAnchorClient({
      enabled: true,
      batchMaxLeaves: 3,
      chainBackend: chain,
      manifestStorage: makeMockStorage(),
    });
    c.anchorReceipt(makeReceipt({ dcc: DigitalCaptureClass.DCC1, agent: "a" }));
    c.anchorReceipt(makeReceipt({ dcc: DigitalCaptureClass.DCC1, agent: "b" }));
    const oFinal = c.anchorReceipt(makeReceipt({ dcc: DigitalCaptureClass.DCC1, agent: "c" }));
    // Third receipt should trigger overflow flush.
    expect(oFinal).toMatchObject({ mode: "batched" });
    // Wait for the fire-and-forget flush to complete.
    await new Promise((r) => setTimeout(r, 10));
    expect(chain.batchCalls).toHaveLength(1);
    expect(chain.batchCalls[0].count).toBe(3);
  });

  it("batch tx failure re-enqueues leaves at front", async () => {
    const chain = makeMockChain();
    chain.batchShouldThrow.value = true;
    const c = createReceiptAnchorClient({
      enabled: true,
      chainBackend: chain,
      manifestStorage: makeMockStorage(),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
    c.anchorReceipt(makeReceipt({ dcc: DigitalCaptureClass.DCC1, agent: "a" }));
    c.anchorReceipt(makeReceipt({ dcc: DigitalCaptureClass.DCC1, agent: "b" }));
    expect(c.bufferSize()).toBe(2);
    await expect(c.flushBatch()).rejects.toThrow(/anchorBatch mock failure/);
    expect(c.bufferSize()).toBe(2); // restored
    expect(chain.batchCalls).toHaveLength(0); // none accepted

    // Recover on next flush.
    chain.batchShouldThrow.value = false;
    const result = await c.flushBatch();
    expect(result!.count).toBe(2);
  });

  it("concurrent flushes coalesce to a single tx", async () => {
    const chain = makeMockChain();
    const c = createReceiptAnchorClient({ enabled: true, chainBackend: chain, manifestStorage: makeMockStorage() });
    c.anchorReceipt(makeReceipt({ dcc: DigitalCaptureClass.DCC1, agent: "a" }));
    c.anchorReceipt(makeReceipt({ dcc: DigitalCaptureClass.DCC1, agent: "b" }));
    const [r1, r2] = await Promise.all([c.flushBatch(), c.flushBatch()]);
    expect(r1).toBe(r2); // coalesced — same promise resolves both
    expect(chain.batchCalls).toHaveLength(1);
  });
});

describe("ReceiptAnchorClient — start/stop timer", () => {
  it("start + stop are idempotent", () => {
    vi.useFakeTimers();
    const c = createReceiptAnchorClient({
      enabled: true,
      chainBackend: makeMockChain(),
      manifestStorage: makeMockStorage(),
      batchFlushIntervalMs: 1000,
    });
    c.start();
    c.start(); // idempotent
    c.stop();
    c.stop(); // idempotent
    vi.useRealTimers();
  });
});

describe("buildAnchorRequest — receipt → on-chain projection", () => {
  it("produces deterministic hashes for the same receipt", () => {
    const r = makeReceipt({ dcc: DigitalCaptureClass.DCC3 });
    const a = buildAnchorRequest(r);
    const b = buildAnchorRequest(r);
    expect(a).toEqual(b);
  });

  it("cidHash matches sha256 of receiptCID (post sha256: strip)", () => {
    const r = makeReceipt({ dcc: DigitalCaptureClass.DCC3 });
    const req = buildAnchorRequest(r);
    expect(req.cidHash).toBe(`0x${r.receiptCID.replace("sha256:", "")}`);
  });

  it("upstreamKeyHash is bytes32(0) when no upstream key", () => {
    const r = makeReceipt({ dcc: DigitalCaptureClass.DCC1 });
    const req = buildAnchorRequest(r);
    expect(req.upstreamKeyHash).toBe("0x" + "00".repeat(32));
  });

  it("receiptTimestamp is seconds, not ms", () => {
    const r = makeReceipt({ dcc: DigitalCaptureClass.DCC1 });
    const req = buildAnchorRequest(r);
    // 2026-05-23T00:00:00.000Z = 1779840000 seconds
    expect(req.receiptTimestamp).toBe(1779840000n);
  });
});

describe("ReceiptAnchorClient — env-flag default", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.PCC_RECEIPT_ANCHOR_ENABLED;
  });
  afterEach(() => {
    if (original == null) delete process.env.PCC_RECEIPT_ANCHOR_ENABLED;
    else process.env.PCC_RECEIPT_ANCHOR_ENABLED = original;
  });

  it("defaults to disabled when env not set", () => {
    delete process.env.PCC_RECEIPT_ANCHOR_ENABLED;
    const c = new ReceiptAnchorClient({ chainBackend: makeMockChain(), manifestStorage: makeMockStorage() });
    expect(c.isEnabled()).toBe(false);
  });

  it("enabled when env=true", () => {
    process.env.PCC_RECEIPT_ANCHOR_ENABLED = "true";
    const c = new ReceiptAnchorClient({ chainBackend: makeMockChain(), manifestStorage: makeMockStorage() });
    expect(c.isEnabled()).toBe(true);
  });

  it("enabled when env=1", () => {
    process.env.PCC_RECEIPT_ANCHOR_ENABLED = "1";
    const c = new ReceiptAnchorClient({ chainBackend: makeMockChain(), manifestStorage: makeMockStorage() });
    expect(c.isEnabled()).toBe(true);
  });

  it("explicit constructor flag overrides env", () => {
    process.env.PCC_RECEIPT_ANCHOR_ENABLED = "true";
    const c = new ReceiptAnchorClient({ enabled: false, chainBackend: makeMockChain(), manifestStorage: makeMockStorage() });
    expect(c.isEnabled()).toBe(false);
  });
});
