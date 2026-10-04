/**
 * pcc_get_evidence: which gateway route answers which question (bus #3341).
 *
 * `GET /api/evidence/:param` is the by-JOB route: a job id, or a bundle's
 * sha256 hash for the oracle's canonical envelope. The tool used to send a
 * bundle id there, so every lookup of a real bundle answered 404. A bundle by
 * id is `GET /api/compliance/evidence/:bundleId`.
 *
 * Pure, so the tests can pin the mapping without booting the MCP server.
 */

export const GET_EVIDENCE_DESCRIPTION =
  "Get evidence by bundle or by job. With bundleId: one bundle's summary " +
  "(id, jobId, stepId, assuranceTier, eventCount, bundleHash, createdAt, verified, storageCid). " +
  "With jobId: every bundle recorded for that job, each with its events. " +
  "Pass exactly one of them. It returns what the gateway stored; it does not fetch IPFS content or run a verification.";

export interface GetEvidenceInput {
  bundleId?: string;
  jobId?: string;
}

/** The gateway path for one lookup, or an error message when the input is ambiguous or empty. */
export function evidencePath(input: GetEvidenceInput): { path: string } | { error: string } {
  const bundleId = input.bundleId?.trim();
  const jobId = input.jobId?.trim();
  if (bundleId && jobId) return { error: "Pass bundleId or jobId, not both." };
  if (bundleId) return { path: `/api/compliance/evidence/${encodeURIComponent(bundleId)}` };
  if (jobId) return { path: `/api/evidence/${encodeURIComponent(jobId)}` };
  return { error: "Pass bundleId (one bundle) or jobId (every bundle of a job)." };
}
