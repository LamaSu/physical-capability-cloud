/**
 * Settlement Populator — transforms raw Escrow models into EscrowSummaryDTOs.
 *
 * Handles enrichment: milestoneCount, releasedCount, disputedCount, challengeWindowEnd.
 */

import type { EscrowSummaryDTO, PopulationContext } from "../types.js";

/** Raw escrow shape from the DB (typed loosely since store schema may vary) */
export interface RawEscrow {
  id: string;
  jobId?: string;
  status: string;
  totalAmount?: string | number;
  currency?: string;
  challengeWindowEnd?: string | null;
  [key: string]: unknown;
}

/** Raw milestone shape from the DB */
export interface RawMilestone {
  id?: string;
  escrowId: string;
  status?: string;
  [key: string]: unknown;
}

/**
 * Populate a single raw escrow + milestones into an EscrowSummaryDTO.
 */
export function populateEscrowDTO(
  escrow: RawEscrow,
  milestones: RawMilestone[],
  ctx: PopulationContext,
): EscrowSummaryDTO {
  const releasedCount = milestones.filter(
    (m) => m.status === "released" || m.status === "completed",
  ).length;

  const disputedCount = milestones.filter(
    (m) => m.status === "disputed",
  ).length;

  return {
    id: escrow.id,
    jobId: escrow.jobId ?? "",
    status: escrow.status as EscrowSummaryDTO["status"],
    totalAmount: String(escrow.totalAmount ?? "0"),
    currency: (escrow.currency ?? ctx.currency ?? "USDC") as EscrowSummaryDTO["currency"],
    milestoneCount: milestones.length,
    releasedCount,
    disputedCount,
    challengeWindowEnd: escrow.challengeWindowEnd ?? undefined,
  };
}

/**
 * Batch-populate a list of escrows with their milestones.
 * Accepts milestoneMap: (escrowId → RawMilestone[]) to avoid N+1.
 */
export function populateEscrowList(
  escrows: RawEscrow[],
  milestoneMap: Map<string, RawMilestone[]>,
  ctx: PopulationContext,
): EscrowSummaryDTO[] {
  return escrows.map((escrow) =>
    populateEscrowDTO(escrow, milestoneMap.get(escrow.id) ?? [], ctx),
  );
}
