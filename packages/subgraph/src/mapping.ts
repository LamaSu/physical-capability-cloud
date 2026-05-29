/**
 * ReceiptAnchorRegistry subgraph mapping handlers.
 *
 * AssemblyScript (WASM compile target). Runs under graph-node.
 *
 * Source: ai/scoping/onchain-receipt-anchoring-2026-05-23.md §5.3
 *
 * Three handlers:
 *   - handleAnchorEmitted    -> upsert ReceiptAnchor, Tool, Caller
 *   - handleBatchAnchorEmitted -> insert BatchAnchor
 *   - handleDisputeRaised    -> insert Dispute (linked to ReceiptAnchor if known)
 */

import { Bytes, BigInt, Address } from "@graphprotocol/graph-ts";
import {
  AnchorEmitted as AnchorEmittedEvent,
  BatchAnchorEmitted as BatchAnchorEmittedEvent,
  DisputeRaised as DisputeRaisedEvent,
} from "../generated/ReceiptAnchorRegistry/ReceiptAnchorRegistry";
import {
  ReceiptAnchor,
  BatchAnchor,
  Tool,
  Caller,
  Dispute,
} from "../generated/schema";

const ZERO = BigInt.fromI32(0);
const ONE = BigInt.fromI32(1);

// ── Handlers ───────────────────────────────────────────────────────────────

export function handleAnchorEmitted(event: AnchorEmittedEvent): void {
  let cidHashHex = event.params.cidHash.toHexString();
  let toolIdHashHex = event.params.toolIdHash.toHexString();
  let callerHashHex = event.params.callerHash.toHexString();

  // ── Tool aggregate ──
  let tool = Tool.load(toolIdHashHex);
  if (tool == null) {
    tool = new Tool(toolIdHashHex);
    tool.totalReceipts = ZERO;
    tool.firstSeenBlock = event.block.number;
    tool.lastSeenBlock = event.block.number;
    tool.dcc0Count = ZERO;
    tool.dcc1Count = ZERO;
    tool.dcc2Count = ZERO;
    tool.dcc3Count = ZERO;
    tool.dcc4Count = ZERO;
    tool.dcc5Count = ZERO;
  }
  tool.totalReceipts = tool.totalReceipts.plus(ONE);
  tool.lastSeenBlock = event.block.number;
  let dcc = event.params.dccClass;
  if (dcc == 0) tool.dcc0Count = tool.dcc0Count.plus(ONE);
  else if (dcc == 1) tool.dcc1Count = tool.dcc1Count.plus(ONE);
  else if (dcc == 2) tool.dcc2Count = tool.dcc2Count.plus(ONE);
  else if (dcc == 3) tool.dcc3Count = tool.dcc3Count.plus(ONE);
  else if (dcc == 4) tool.dcc4Count = tool.dcc4Count.plus(ONE);
  else if (dcc == 5) tool.dcc5Count = tool.dcc5Count.plus(ONE);
  tool.save();

  // ── Caller aggregate ──
  let caller = Caller.load(callerHashHex);
  if (caller == null) {
    caller = new Caller(callerHashHex);
    caller.totalReceipts = ZERO;
    caller.firstSeenBlock = event.block.number;
    caller.lastSeenBlock = event.block.number;
  }
  caller.totalReceipts = caller.totalReceipts.plus(ONE);
  caller.lastSeenBlock = event.block.number;
  caller.save();

  // ── Receipt anchor (immutable) ──
  let anchor = new ReceiptAnchor(cidHashHex);
  anchor.cidHash = event.params.cidHash;
  anchor.toolIdHash = event.params.toolIdHash;
  anchor.callerHash = event.params.callerHash;
  anchor.toolCID = event.params.toolCID;
  // Sentinel: bytes32(0) means no upstream key, so we leave the optional field null.
  let upstream = event.params.upstreamKeyHash;
  if (!isZeroBytes32(upstream)) {
    anchor.upstreamKeyHash = upstream;
  }
  anchor.dccClass = dcc;
  anchor.receiptTimestamp = BigInt.fromU64(event.params.receiptTimestamp);
  anchor.anchoredAtBlock = event.block.number;
  anchor.anchoredAtTimestamp = event.block.timestamp;
  anchor.txHash = event.transaction.hash;
  anchor.anchorMode = "SINGLE";
  anchor.tool = toolIdHashHex;
  anchor.caller = callerHashHex;
  anchor.save();
}

export function handleBatchAnchorEmitted(event: BatchAnchorEmittedEvent): void {
  let merkleRootHex = event.params.merkleRoot.toHexString();

  let batch = new BatchAnchor(merkleRootHex);
  batch.merkleRoot = event.params.merkleRoot;
  batch.count = event.params.count;
  batch.minDccClass = event.params.minDccClass;
  batch.maxDccClass = event.params.maxDccClass;
  batch.batchMetadataCID = event.params.batchMetadataCID;
  batch.anchoredAtBlock = event.block.number;
  batch.anchoredAtTimestamp = event.block.timestamp;
  batch.txHash = event.transaction.hash;
  batch.save();
}

export function handleDisputeRaised(event: DisputeRaisedEvent): void {
  // id = txHash + logIndex for uniqueness across multiple disputes in one tx
  let id = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();

  let dispute = new Dispute(id);
  dispute.cidHash = event.params.cidHash;
  dispute.disputer = event.params.disputer;
  dispute.reason = event.params.reason;
  dispute.raisedAtBlock = event.block.number;
  dispute.raisedAtTimestamp = event.block.timestamp;
  dispute.txHash = event.transaction.hash;

  // Link to single-anchored ReceiptAnchor if it exists. Batch-anchored disputes
  // leave receipt == null until the off-chain Merkle proof resolves the leaf.
  let cidHashHex = event.params.cidHash.toHexString();
  let target = ReceiptAnchor.load(cidHashHex);
  if (target != null) {
    dispute.receipt = cidHashHex;
  }
  dispute.save();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isZeroBytes32(value: Bytes): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value[i] != 0) return false;
  }
  return true;
}
