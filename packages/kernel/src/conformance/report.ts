import { canonicalize, sha256 } from "@pcc/spec";
import type { ClauseId, ClauseStatus, ConformanceProfileFields } from "./clauses.js";

export interface ConformanceClauseResult {
  id: ClauseId;
  title: string;
  status: ClauseStatus;
  /** Stable contract outcome, without observations such as times or device ids. */
  reason: string;
}
export interface ConformanceReport {
  suite: "pcc.adapter-conformance/v1";
  profile: ConformanceProfileFields;
  clauses: ConformanceClauseResult[];
  digest: Awaited<ReturnType<typeof sha256>>;
}

/** Hash the complete unsigned report using spec's canonical JSON and SHA-256. */
export async function conformanceReport(
  profile: ConformanceProfileFields,
  clauses: ConformanceClauseResult[],
): Promise<ConformanceReport> {
  const body = { suite: "pcc.adapter-conformance/v1" as const, profile, clauses };
  return { ...body, digest: await sha256(canonicalize(body)) };
}
