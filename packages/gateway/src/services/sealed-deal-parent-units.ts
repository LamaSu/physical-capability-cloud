/**
 * MC 9's parent-unit terms, derived by the SERVER from the sealed deal the R13 store keeps (amendment
 * #3231, steward conditions #3235). The store holds the accepted deal's canonical preimage: the bytes
 * whose sha256 is `consumed_deal_digest`. The terms of one unit, `${jobId}#${milestoneIndex}`, are:
 *   - operator: the job's signing operator;
 *   - netBaseUnits: the unit's net n (what its children may share);
 *   - reclaimAt: the unit's reclaim time (no child may outlive it).
 *
 * Nothing here comes from the caller. The reservation id and unit reference are lookup keys; the terms
 * are read from bytes that hash to the digest the payer's reservation sealed. A malformed stored deal
 * is null (fail closed), never an exception.
 */
import type { BudgetReservationStore, ParentUnitTerms } from "@pcc/store";

const BASE_UNITS = /^(0|[1-9][0-9]{0,77})$/;

export function sealedDealParentUnits(store: BudgetReservationStore): (parentReservationId: string, unit: string) => ParentUnitTerms | null {
  return (parentReservationId, unit) => {
    const bytes = store.sealedDealPreimage(parentReservationId);
    if (bytes === null) return null;
    try {
      const deal = JSON.parse(bytes) as {
        jobs?: Array<{ jobId?: unknown; operator?: unknown; units?: Array<{ milestoneIndex?: unknown; n?: unknown; reclaimAt?: unknown }> }>;
      };
      const hash = unit.lastIndexOf("#");
      if (hash <= 0 || !Array.isArray(deal.jobs)) return null;
      const jobId = unit.slice(0, hash);
      const milestone = unit.slice(hash + 1);
      const job = deal.jobs.find((j) => j?.jobId === jobId);
      const u = Array.isArray(job?.units) ? job!.units!.find((x) => x?.milestoneIndex === milestone) : undefined;
      if (!job || !u || typeof job.operator !== "string") return null;
      if (typeof u.n !== "string" || !BASE_UNITS.test(u.n) || typeof u.reclaimAt !== "string" || !BASE_UNITS.test(u.reclaimAt)) return null;
      const reclaimAt = Number(u.reclaimAt);
      if (!Number.isSafeInteger(reclaimAt)) return null;
      return { reservationId: parentReservationId, unit, operator: job.operator, netBaseUnits: BigInt(u.n), reclaimAt };
    } catch {
      return null;
    }
  };
}
