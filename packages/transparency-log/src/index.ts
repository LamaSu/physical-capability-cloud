/**
 * @pcc/transparency-log — RFC 6962-style append-only Merkle log,
 * Ed25519-signed receipts, and Anchor.sol payload composition.
 *
 * Primary entry points:
 *  - MerkleLog: incremental tree with O(log N) appends and inclusion proofs.
 *  - signReceipt / verifyReceipt: Ed25519 over canonicalized JSON.
 *  - composeAnchor / InMemoryAnchorStore: prepare payloads for Anchor.sol.
 */

export {
  MerkleLog,
  hashLeaf,
  hashInner,
  verifyProof,
  EMPTY_ROOT,
} from "./merkle.js";
export type { MerkleProof, TreeSnapshot } from "./merkle.js";

export {
  ReceiptPayloadSchema,
  SignedReceiptSchema,
  SettlementModeEnum,
  canonicalize,
  payloadDigest,
  signReceipt,
  verifyReceipt,
  generateEd25519Keypair,
} from "./receipt.js";
export type { ReceiptPayload, SignedReceipt, SettlementMode } from "./receipt.js";

export {
  AnchorPayloadSchema,
  AnchorRecordSchema,
  composeAnchor,
  InMemoryAnchorStore,
} from "./anchor.js";
export type { AnchorPayload, AnchorRecord } from "./anchor.js";
