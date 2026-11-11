/**
 * The recorded deployment for a funding read (N297): the steward's #12349 (Q1, Q10) and
 * ECONOMICS' #12351 (Q2's c1-c3, Q4). A configured deployment takes precedence at the caller.
 * Every matching prepare row must agree on the frozen identity, and only the deployment record
 * this gateway ships can vouch for it. This module makes no chain call.
 */
import { and, eq, schema, type Store } from "@pcc/store";
import { isWellFormedFundingRecord, type FundingVerificationRecord } from "../services/funding-record-port.js";
import {
  contractsPackageRoot,
  shippedVNextDeploymentRecord,
  vnextNetworkSlug,
  type VNextDeploymentRecord,
  type VNextScheduleId,
} from "../services/paid-scope-activation-terms.js";

export const CHAIN_CLASSES = ["mainnet", "testnet", "local", "unknown"] as const;
export type ChainClass = (typeof CHAIN_CLASSES)[number];

/** ECONOMICS Q4: the chain id alone determines the class. */
export function chainClassOf(chainId: number): ChainClass {
  if (chainId === 8453) return "mainnet";
  if (chainId === 84532) return "testnet";
  if (chainId === 31337) return "local";
  return "unknown";
}

export interface PrepareIdentityRow {
  scopeId: string;
  chainId: number;
  escrow: string;
  state: string;
  s01RecordSha256: string;
  s01ScheduleId: string;
  s01ScheduleTestnetOnly: number;
  factory: string;
  implementation: string;
  usdc: string;
}

export interface RecordedDeployment {
  chainId: number;
  scheduleId: VNextScheduleId;
  scheduleTestnetOnly: boolean;
  recordSha256: string;
}

/** The whole frozen identity must agree, even if the unique escrow index changes in the future. */
export function recordedDeploymentOf(
  record: FundingVerificationRecord,
  rows: readonly PrepareIdentityRow[],
  shipped: VNextDeploymentRecord | null,
): RecordedDeployment | null {
  const first = rows[0];
  if (!first) return null;
  if (!rows.every((row) => row.chainId === record.chainId
    && row.escrow === record.escrowAddress.toLowerCase()
    && row.scopeId === record.scopeId
    && row.chainId === first.chainId
    && row.s01RecordSha256 === first.s01RecordSha256
    && row.s01ScheduleId === first.s01ScheduleId
    && row.s01ScheduleTestnetOnly === first.s01ScheduleTestnetOnly
    && row.factory === first.factory
    && row.implementation === first.implementation
    && row.usdc === first.usdc)) return null;
  if (!rows.some((row) => row.state === "served" || row.state === "expired")) return null;
  if (shipped === null
    || first.chainId !== shipped.chainId
    || first.s01RecordSha256 !== shipped.recordSha256
    || first.s01ScheduleId !== shipped.scheduleId
    || first.s01ScheduleTestnetOnly !== Number(shipped.scheduleTestnetOnly)
    || first.factory !== shipped.factory
    || first.implementation !== shipped.implementation
    || first.usdc !== shipped.usdc) return null;
  return {
    chainId: shipped.chainId,
    scheduleId: shipped.scheduleId,
    scheduleTestnetOnly: shipped.scheduleTestnetOnly,
    recordSha256: shipped.recordSha256,
  };
}

/** One indexed select, then one uncached shipped-record read only when rows exist. DB errors propagate. */
export function recordedDeployment(
  db: Store["db"],
  record: FundingVerificationRecord,
  packageRoot: string | null = contractsPackageRoot(),
): RecordedDeployment | null {
  if (!isWellFormedFundingRecord(record)) return null;
  const p = schema.fundingPrepares;
  const rows = db.select({
    scopeId: p.scopeId,
    chainId: p.chainId,
    escrow: p.escrow,
    state: p.state,
    s01RecordSha256: p.s01RecordSha256,
    s01ScheduleId: p.s01ScheduleId,
    s01ScheduleTestnetOnly: p.s01ScheduleTestnetOnly,
    factory: p.factory,
    implementation: p.implementation,
    usdc: p.usdc,
  }).from(p).where(and(eq(p.chainId, record.chainId), eq(p.escrow, record.escrowAddress.toLowerCase()))).all();
  if (rows.length === 0) return null;
  const shipped = packageRoot === null ? null : shippedVNextDeploymentRecord(packageRoot, vnextNetworkSlug(record.chainId));
  return recordedDeploymentOf(record, rows, shipped);
}
