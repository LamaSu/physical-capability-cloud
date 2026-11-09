/**
 * Copied verbatim from routes/operator-relay.ts fundingForListedJob (N268-4).
 * Until N296 (gateway's fold) lands, any change to either copy changes both in the same PR; F3c in n268-4-job-funding.test.ts pins their exact parity.
 */
import { and, asc, eq, schema } from "@pcc/store";
import { getStore } from "../db.js";
import { projectFundingStatus, type FundingStatusDTO } from "./funding-status.js";
import { fundingRecordStore } from "../services/funding-record-port.js";
import { escrowForJob } from "../services/scope-acceptance.js";
import { paidScopeActivationTerms } from "../services/paid-scope-activation-terms.js";
import { testnetBuyerAllowance, type TestnetBuyerAllowance } from "../services/funding-binding.js";

/** One listed job's buyer funding, to the extent the gateway could read it. */
export type JobFunding =
  | { read: "ok"; scopes: FundingStatusDTO[] }
  | { read: "failed" };

/** Without a verification record there is no reason to read deployment terms or buyer config. */
export const NO_RECORD_ALLOWANCE: TestnetBuyerAllowance = { testnetOnly: true, buyers: undefined };

/** Read only this kernel's scopes for this listed job; a failure does not affect other jobs. */
export function jobFundingOf(jobId: string, kernelId: string, asOf: string): JobFunding {
  try {
    const db = getStore().db;
    // One scoped query per listed job; order ties by id to make the answer deterministic.
    const rows = db.select().from(schema.executionScopes).where(and(
      eq(schema.executionScopes.kernelId, kernelId),
      eq(schema.executionScopes.jobId, jobId),
    )).orderBy(asc(schema.executionScopes.createdAt), asc(schema.executionScopes.id)).all();
    const scopes = rows.map((scope) => {
      const record = fundingRecordStore()?.findByScope(db, scope.id) ?? null;
      if (record === null) {
        // fundingBindingOf checks no_record first. No escrow, deployment, or opt-in read.
        return projectFundingStatus(scope, null, null, null, asOf, NO_RECORD_ALLOWANCE);
      }
      const escrow = escrowForJob(jobId) ?? null;
      const terms = paidScopeActivationTerms({ id: scope.id, jobId: scope.jobId, kernelId: scope.kernelId });
      return projectFundingStatus(
        scope,
        record,
        escrow ? { contractAddress: escrow.contractAddress, payer: escrow.payer, status: escrow.status } : null,
        terms.expectedChainId,
        asOf,
        testnetBuyerAllowance(terms),
      );
    });
    return { read: "ok", scopes };
  } catch {
    // Never report an invented time or state, and never log a job, scope or error value.
    return { read: "failed" };
  }
}
