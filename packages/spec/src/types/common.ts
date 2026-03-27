/**
 * Common types used across the Physical Capability Cloud.
 */

/** SHA-256 hex-encoded hash */
export type SHA256 = `sha256:${string}`;

/** Pedersen hash (BN254 field element, Barretenberg-compatible) */
export type PedersenHash = `pedersen:${string}`;

/** Any hash digest used in tree-internal operations */
export type HashDigest = SHA256 | PedersenHash;

/** Ethereum address */
export type Address = `0x${string}`;

/** ISO 8601 timestamp */
export type Timestamp = string;

/** Unique identifier */
export type Id = string;

/** Currency amount as string (to avoid floating point) */
export type Amount = string;

/** Supported currencies for settlement */
export type Currency = "USDC" | "ETH" | "DAI" | "SOL";

/** Supported settlement chains */
export type Chain = "base-sepolia" | "base" | "solana-devnet" | "solana";

/** Assurance tiers — the SLA levels of the physical cloud */
export type AssuranceTier = 0 | 1 | 2 | 3;

/** Geographic coordinates */
export interface GeoLocation {
  lat: number;
  lng: number;
}

/** A time window for scheduling */
export interface TimeWindow {
  start: Timestamp;
  end: Timestamp;
}

/** Cryptographic signature from a kernel or verifier */
export interface Signature {
  signer: Address;
  algorithm: "secp256k1" | "ed25519";
  value: string;
}

/** Status of a job step */
export type StepStatus =
  | "pending"
  | "scheduled"
  | "in_progress"
  | "awaiting_verification"
  | "verified"
  | "disputed"
  | "completed"
  | "failed"
  | "cancelled";

/** Status of an escrow */
export type EscrowStatus =
  | "unfunded"
  | "funded"
  | "locked"       // step in progress
  | "releasing"    // challenge window open
  | "released"     // payment sent to operator
  | "disputed"     // under arbitration
  | "refunded"     // returned to user
  | "slashed";     // bond slashed
