/**
 * Buyer funding, Stage 2 (readmodels; the plan's S2.1 and S2.2, research/buyer-funding-plan-20261008.md):
 * the port through which a buyer's VERIFIED funding of a paid job's escrow is recorded and read.
 *
 * What a record is. A FundingVerificationRecord says: at block `blockNumber` (hash `blockHash`) of
 * chain `chainId`, a FINALIZED block, the verifier `verifierVersion` found `escrowAddress` funded
 * from `buyer`'s own wallet for the paid job whose write scope is `scopeId` (the plan's section 3
 * step 6). It is the only thing that makes a real escrow the buyer's own funding (N133 rule 3).
 * A tx hash, a DB flag or a balance never is.
 *
 * Who writes one. reconcilePaidScope inserts it through `insert`, inside the SQLite transaction that
 * activates the scope, so the record and the activation commit together or not at all. (The Stage-1
 * verifier may store one first; reconcilePaidScope then inserts nothing and only activates.)
 *
 * Production wiring: NONE. The table these records belong in (the parked escrow_funding DDL) is the
 * operator's decision (Q9), so no store exists outside a test process: fundingRecordStore() answers
 * null there, and every reader fails closed. buyerFundingVerdict refuses every real escrow
 * (escrow_not_buyer_funded, exactly as before), and reconcilePaidScope refuses with
 * funding_record_store_unavailable. A test process may install a store; one installed is never
 * consulted outside a test process.
 */
import type { StoreDB } from "@pcc/store";
import { isTestProcess } from "./settlement-mode.js";

/** The caller's open transaction (the callback argument of StoreDB.transaction). */
export type FundingTx = Parameters<Parameters<StoreDB["transaction"]>[0]>[0];
/** A transaction, or the database itself for a read outside one. Both run on the one connection. */
export type FundingDbHandle = StoreDB | FundingTx;

/** A record is written only at a finalized block. Any other value is refused where a record is read. */
export const FUNDING_FINALITY = "finalized" as const;

/** One finalized verification of a buyer's own funding of the escrow that pays for one scope. */
export interface FundingVerificationRecord {
  /** The paid write scope the funding is for (execution_scopes.id). */
  scopeId: string;
  /** The escrow contract, a 0x address. Addresses compare without letter case. */
  escrowAddress: string;
  /** The escrow's verified on-chain payer: the buyer's own wallet, a 0x address. */
  buyer: string;
  /** The chain the verifier read (EIP-155 id). */
  chainId: number;
  /** The finalized block the verifier read, as a decimal string (lossless for a uint64). */
  blockNumber: string;
  /** That block's hash, 0x and 64 hex digits: the read is pinned by hash, not by number. */
  blockHash: string;
  /** The verifier build that made the checks. */
  verifierVersion: string;
  /** When the verifier verified, ISO-8601 UTC as Date#toISOString writes it. */
  verifiedAt: string;
  /** Always "finalized": a record is never written for an unfinalized block. */
  finality: typeof FUNDING_FINALITY;
}

/**
 * Where FundingVerificationRecords are kept. Every method takes the caller's handle, so a read inside
 * the activation's transaction sees that transaction, and `insert` takes part in it: a rollback
 * undoes the insert.
 *
 * Contract: at most one record per scope and at most one per escrow address (one funding activates
 * one scope). An insert that would make a second for either throws, and the caller's transaction
 * then rolls back. Escrow addresses compare without letter case.
 */
export interface FundingRecordStore {
  insert(tx: FundingTx, record: FundingVerificationRecord): void;
  findByEscrow(handle: FundingDbHandle, escrowAddress: string): FundingVerificationRecord | null;
  findByScope(handle: FundingDbHandle, scopeId: string): FundingVerificationRecord | null;
}

let testStore: FundingRecordStore | null = null;

/**
 * The store records are read from and written to, or null when there is none. Outside a test
 * process there is none (no table until Q9), whatever was installed.
 */
export function fundingRecordStore(): FundingRecordStore | null {
  return isTestProcess() ? testStore : null;
}

/**
 * Installs (or, with null, removes) the store a TEST process reads and writes. Throws in any other
 * process, so production keeps no store.
 */
export function __setFundingRecordStoreForTest(store: FundingRecordStore | null): void {
  if (!isTestProcess()) throw new Error("funding record store: test processes only");
  testStore = store;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BLOCK_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
/** A canonical decimal of at most 20 digits; with UINT64_MAX below, a uint64 (a chain's block number). */
const BLOCK_NUMBER_RE = /^(0|[1-9][0-9]{0,19})$/;
/** 2^64 - 1: 20-digit decimals above it pass BLOCK_NUMBER_RE and are refused by this bound. */
const UINT64_MAX = 18446744073709551615n;

/** The same 0x address, in any letter case. Anything that is not a 0x address never matches. */
export function sameAddress(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && ADDRESS_RE.test(a) && ADDRESS_RE.test(b)
    && a.toLowerCase() === b.toLowerCase();
}

function nonEmpty(v: unknown, max: number): boolean {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

/**
 * Whether `record` is a well-formed, finalized verification record, checked field by field at run
 * time (a caller may not be typed). A record that is not is never treated as funding.
 */
export function isWellFormedFundingRecord(record: unknown): record is FundingVerificationRecord {
  if (typeof record !== "object" || record === null) return false;
  const r = record as Record<string, unknown>;
  return nonEmpty(r.scopeId, 200)
    && typeof r.escrowAddress === "string" && ADDRESS_RE.test(r.escrowAddress)
    && typeof r.buyer === "string" && ADDRESS_RE.test(r.buyer)
    && typeof r.chainId === "number" && Number.isSafeInteger(r.chainId) && r.chainId > 0
    && typeof r.blockNumber === "string" && BLOCK_NUMBER_RE.test(r.blockNumber) && BigInt(r.blockNumber) <= UINT64_MAX
    && typeof r.blockHash === "string" && BLOCK_HASH_RE.test(r.blockHash)
    && nonEmpty(r.verifierVersion, 100)
    && typeof r.verifiedAt === "string" && !Number.isNaN(Date.parse(r.verifiedAt))
    && new Date(r.verifiedAt).toISOString() === r.verifiedAt
    && r.finality === FUNDING_FINALITY;
}
