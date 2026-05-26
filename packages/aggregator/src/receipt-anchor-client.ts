/**
 * Receipt anchor client — TS surface for submitting InvocationReceipt
 * anchors to the on-chain ReceiptAnchorRegistry contract.
 *
 * Two modes (selected per-receipt based on dccClass):
 *   - **Single anchor** (anchorOne): DCC3+ receipts go straight to the
 *     contract, ~$0.025/receipt on Base mainnet. Synchronous tx submission.
 *   - **Batch anchor** (anchorBatch): DCC0..DCC2 receipts buffer in memory
 *     and flush every `batchFlushIntervalMs` or when buffer hits
 *     `batchMaxLeaves` (default 4096). Submitted as a single tx anchoring
 *     the Merkle root.
 *
 * The contract is broker-side blockchain-agnostic; this client is the only
 * code that talks to it. Public surface:
 *
 *   - `createReceiptAnchorClient(config)` — factory.
 *   - `client.anchorReceipt(receipt)` — enqueue.
 *   - `client.flushBatch()` — force-flush the buffer.
 *   - `client.start()` / `client.stop()` — control the background timer.
 *
 * The client is designed to be opt-in via the
 * `PCC_RECEIPT_ANCHOR_ENABLED` env flag — when disabled, `anchorReceipt`
 * is a no-op returning `{ mode: "disabled" }`.
 *
 * Design doc: ai/scoping/onchain-receipt-anchoring-2026-05-23.md §3.4 + §9
 */

import type { InvocationReceipt } from "@pcc/spec";
import { DigitalCaptureClass } from "@pcc/spec";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { buildMerkleTree, cidToBytes32, getMerkleProof, type Bytes32Hex } from "./merkle.js";

/**
 * Map the string-enum DigitalCaptureClass to the numeric on-chain encoding
 * the ReceiptAnchorRegistry contract expects (uint8 0..5).
 *
 * The off-chain DCC is "DCC0".."DCC5" (string enum for JSON stability);
 * the on-chain DCC is 0..5 (uint8 for storage efficiency). This is the only
 * place the conversion lives.
 *
 * Throws on unrecognized values — defensive against future enum additions
 * that haven't yet been mapped on-chain.
 */
export function dccClassToNumber(cls: DigitalCaptureClass): number {
  switch (cls) {
    case DigitalCaptureClass.DCC0:
      return 0;
    case DigitalCaptureClass.DCC1:
      return 1;
    case DigitalCaptureClass.DCC2:
      return 2;
    case DigitalCaptureClass.DCC3:
      return 3;
    case DigitalCaptureClass.DCC4:
      return 4;
    case DigitalCaptureClass.DCC5:
      return 5;
    default:
      throw new Error(`dccClassToNumber: unknown class ${cls}`);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The on-chain projection of an InvocationReceipt — the args the contract takes. */
export interface AnchorRequest {
  cidHash: Bytes32Hex;
  toolIdHash: Bytes32Hex;
  callerHash: Bytes32Hex;
  dccClass: number;
  receiptTimestamp: bigint;
  toolCID: Bytes32Hex;
  upstreamKeyHash: Bytes32Hex;
  /** 0 to skip the per-(caller, tool) sequence check; else next expected seq. */
  sequence: bigint;
}

/** Returned synchronously from `anchorReceipt`. */
export type AnchorOutcome =
  | { mode: "disabled" }
  | { mode: "single"; cidHash: Bytes32Hex; txHashPromise: Promise<string> }
  | { mode: "batched"; cidHash: Bytes32Hex; bufferSize: number };

/** Returned from `flushBatch` after a tx is mined. */
export interface BatchFlushResult {
  merkleRoot: Bytes32Hex;
  txHash: string;
  count: number;
  minDccClass: number;
  maxDccClass: number;
  batchMetadataCID: Bytes32Hex;
  /** Per-leaf inclusion proofs, keyed by cidHash, for DB write-back. */
  proofs: Map<Bytes32Hex, { leafIndex: number; proof: Bytes32Hex[] }>;
}

/** Backend abstraction — production uses viem; tests use a mock. */
export interface ChainBackend {
  /** Submit anchorOne, return the tx hash once mined (or accepted in mempool). */
  anchorOne(req: AnchorRequest): Promise<string>;
  /** Submit anchorBatch, return the tx hash. */
  anchorBatch(args: {
    merkleRoot: Bytes32Hex;
    count: number;
    minDccClass: number;
    maxDccClass: number;
    batchMetadataCID: Bytes32Hex;
  }): Promise<string>;
}

/** Persistence abstraction — production uses a real DB / Storacha; tests mock. */
export interface BatchManifestStorage {
  /**
   * Publish the batch manifest (full leaf list + tree metadata) to durable
   * storage (Storacha / IPFS), return its CID as a 0x-prefixed bytes32.
   * The manifest is what `batchMetadataCID` points to on chain.
   */
  publishManifest(manifest: BatchManifest): Promise<Bytes32Hex>;
}

/** What gets serialized + uploaded for each batch. */
export interface BatchManifest {
  schemaVersion: "1.0";
  merkleRoot: Bytes32Hex;
  count: number;
  minDccClass: number;
  maxDccClass: number;
  /** All leaves in insertion order. */
  leaves: Array<{
    cidHash: Bytes32Hex;
    toolIdHash: Bytes32Hex;
    callerHash: Bytes32Hex;
    dccClass: number;
    receiptTimestamp: string; // ISO
    toolCID: Bytes32Hex;
    upstreamKeyHash: Bytes32Hex;
    leafIndex: number;
  }>;
  builtAt: string; // ISO
}

/** Configuration for `createReceiptAnchorClient`. */
export interface ReceiptAnchorClientConfig {
  /** If false, all `anchorReceipt` calls become no-ops. Default reads env var. */
  enabled?: boolean;
  /** Min dccClass routed to single (anchorOne). Default 3. */
  singleAnchorMinDcc?: number;
  /** Max leaves before forced batch flush. Default 4096 (matches contract cap). */
  batchMaxLeaves?: number;
  /** Background batch flush interval, ms. Default 600_000 (10min). */
  batchFlushIntervalMs?: number;
  /** Required: chain backend (anchorOne, anchorBatch). */
  chainBackend: ChainBackend;
  /** Required: persistence for batch manifests. */
  manifestStorage: BatchManifestStorage;
  /** Optional logger; defaults to console with debug-level off. */
  logger?: Pick<Console, "info" | "warn" | "error" | "debug">;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ReceiptAnchorClient {
  private readonly enabled: boolean;
  private readonly singleAnchorMinDcc: number;
  private readonly batchMaxLeaves: number;
  private readonly batchFlushIntervalMs: number;
  private readonly chain: ChainBackend;
  private readonly storage: BatchManifestStorage;
  private readonly log: Pick<Console, "info" | "warn" | "error" | "debug">;

  private buffer: AnchorRequest[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** Flush in-progress promise, so concurrent flush() calls coalesce. */
  private flushInFlight: Promise<BatchFlushResult | null> | null = null;

  constructor(config: ReceiptAnchorClientConfig) {
    this.enabled = config.enabled ?? readEnabledFromEnv();
    this.singleAnchorMinDcc = config.singleAnchorMinDcc ?? 3;
    this.batchMaxLeaves = config.batchMaxLeaves ?? 4096;
    this.batchFlushIntervalMs = config.batchFlushIntervalMs ?? 600_000;
    this.chain = config.chainBackend;
    this.storage = config.manifestStorage;
    this.log = config.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
  }

  /** Whether the client will actually anchor (env or constructor flag). */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Current buffer occupancy. Tests use this to assert batching behavior. */
  bufferSize(): number {
    return this.buffer.length;
  }

  /** Start the background flush timer. Idempotent. */
  start(): void {
    if (!this.enabled || this.flushTimer != null) return;
    this.flushTimer = setInterval(() => {
      void this.flushBatch().catch((err) => this.log.error("[anchor] flush failed", err));
    }, this.batchFlushIntervalMs);
    // Don't keep the process alive solely because of this timer.
    if (typeof (this.flushTimer as { unref?: () => void }).unref === "function") {
      (this.flushTimer as { unref: () => void }).unref();
    }
  }

  /** Stop the background flush timer. Idempotent. */
  stop(): void {
    if (this.flushTimer != null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Anchor a signed receipt. Routes to single or batch mode based on dccClass.
   * For batch mode: appended to in-memory buffer; flushed by timer or when
   * the buffer hits `batchMaxLeaves`.
   *
   * Returns synchronously even for single-mode (the txHash lives behind a
   * promise on the outcome so callers don't pay for the RPC roundtrip on
   * the hot path).
   */
  anchorReceipt(receipt: InvocationReceipt): AnchorOutcome {
    if (!this.enabled) return { mode: "disabled" };

    const req = buildAnchorRequest(receipt);

    if (req.dccClass >= this.singleAnchorMinDcc) {
      const txHashPromise = this.chain.anchorOne(req).then(
        (tx) => {
          this.log.debug("[anchor] single anchored", { cidHash: req.cidHash, tx });
          return tx;
        },
        (err) => {
          this.log.error("[anchor] single failed", { cidHash: req.cidHash, err });
          throw err;
        },
      );
      return { mode: "single", cidHash: req.cidHash, txHashPromise };
    }

    // Batch path: append + maybe trigger immediate flush.
    this.buffer.push(req);
    if (this.buffer.length >= this.batchMaxLeaves) {
      // Fire-and-forget — caller doesn't wait. Manifest write-back from
      // flushBatch resolves separately.
      void this.flushBatch().catch((err) =>
        this.log.error("[anchor] overflow flush failed", err),
      );
    }
    return { mode: "batched", cidHash: req.cidHash, bufferSize: this.buffer.length };
  }

  /**
   * Drain the buffer into a single anchorBatch tx. Concurrent calls
   * coalesce: only one flush runs at a time. Returns null if the buffer
   * was empty.
   */
  async flushBatch(): Promise<BatchFlushResult | null> {
    if (!this.enabled) return null;
    if (this.flushInFlight) return this.flushInFlight;

    this.flushInFlight = this.doFlush()
      .finally(() => {
        this.flushInFlight = null;
      });
    return this.flushInFlight;
  }

  private async doFlush(): Promise<BatchFlushResult | null> {
    if (this.buffer.length === 0) return null;

    // Snapshot + clear buffer atomically (single-thread Node so this is safe).
    const leaves = this.buffer.splice(0, Math.min(this.buffer.length, this.batchMaxLeaves));

    const tree = buildMerkleTree(leaves.map((l) => l.cidHash));
    let minDcc = leaves[0].dccClass;
    let maxDcc = leaves[0].dccClass;
    for (const l of leaves) {
      if (l.dccClass < minDcc) minDcc = l.dccClass;
      if (l.dccClass > maxDcc) maxDcc = l.dccClass;
    }

    const manifest: BatchManifest = {
      schemaVersion: "1.0",
      merkleRoot: tree.root,
      count: leaves.length,
      minDccClass: minDcc,
      maxDccClass: maxDcc,
      leaves: leaves.map((l, i) => ({
        cidHash: l.cidHash,
        toolIdHash: l.toolIdHash,
        callerHash: l.callerHash,
        dccClass: l.dccClass,
        receiptTimestamp: new Date(Number(l.receiptTimestamp) * 1000).toISOString(),
        toolCID: l.toolCID,
        upstreamKeyHash: l.upstreamKeyHash,
        leafIndex: i,
      })),
      builtAt: new Date().toISOString(),
    };

    const batchMetadataCID = await this.storage.publishManifest(manifest);

    let txHash: string;
    try {
      txHash = await this.chain.anchorBatch({
        merkleRoot: tree.root,
        count: leaves.length,
        minDccClass: minDcc,
        maxDccClass: maxDcc,
        batchMetadataCID,
      });
    } catch (err) {
      // Push the leaves back at the FRONT so ordering is preserved and the
      // next flush retries them. The buffer may have grown since the splice
      // — concatenate carefully.
      this.buffer = [...leaves, ...this.buffer];
      this.log.error("[anchor] batch tx failed; re-enqueued", { err, count: leaves.length });
      throw err;
    }

    const proofs = new Map<Bytes32Hex, { leafIndex: number; proof: Bytes32Hex[] }>();
    for (let i = 0; i < leaves.length; i++) {
      proofs.set(leaves[i].cidHash, { leafIndex: i, proof: getMerkleProof(tree, i) });
    }

    this.log.info("[anchor] batch anchored", {
      root: tree.root,
      count: leaves.length,
      minDcc,
      maxDcc,
      tx: txHash,
    });

    return {
      merkleRoot: tree.root,
      txHash,
      count: leaves.length,
      minDccClass: minDcc,
      maxDccClass: maxDcc,
      batchMetadataCID,
      proofs,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReceiptAnchorClient(config: ReceiptAnchorClientConfig): ReceiptAnchorClient {
  return new ReceiptAnchorClient(config);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the on-chain anchor request from an off-chain InvocationReceipt.
 *
 * - cidHash: sha256 of canonical receipt JSON (already in receiptCID).
 * - toolIdHash: sha256(indexedToolId).
 * - callerHash: sha256(callerAgentId).
 * - upstreamKeyHash: sha256(upstreamKeyId) if set, else bytes32(0).
 * - receiptTimestamp: requestProjection.timestamp (ISO) → seconds.
 * - sequence: 0 — anchor client doesn't track sequences (gateway does, if at all).
 */
export function buildAnchorRequest(receipt: InvocationReceipt): AnchorRequest {
  const cidHash = cidToBytes32(receipt.receiptCID);
  const toolIdHash = sha256Bytes32(receipt.indexedToolId);
  const callerHash = sha256Bytes32(receipt.callerAgentId);
  const toolCID = cidToBytes32(receipt.toolCID);
  const upstreamKeyHash = receipt.upstreamKeyId
    ? sha256Bytes32(receipt.upstreamKeyId)
    : ("0x" + "00".repeat(32)) as Bytes32Hex;

  const receiptTimestamp = BigInt(Math.floor(new Date(receipt.requestProjection.timestamp).getTime() / 1000));

  return {
    cidHash,
    toolIdHash,
    callerHash,
    dccClass: dccClassToNumber(receipt.effectiveDccClass),
    receiptTimestamp,
    toolCID,
    upstreamKeyHash,
    sequence: 0n,
  };
}

function sha256Bytes32(input: string): Bytes32Hex {
  return `0x${bytesToHex(sha256(new TextEncoder().encode(input)))}` as Bytes32Hex;
}

function readEnabledFromEnv(): boolean {
  const v = process.env.PCC_RECEIPT_ANCHOR_ENABLED;
  if (v == null) return false;
  return v === "1" || v.toLowerCase() === "true";
}
