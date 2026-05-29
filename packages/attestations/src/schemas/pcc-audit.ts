/**
 * PCC Audit schema — an external auditor attests a score (0..100) for
 * a PCC bridge namespace, with an audit report CID and organization name.
 *
 * Use cases:
 *  - Third-party security audits ("audited by Trail of Bits, score 92")
 *  - Compliance audits ("FDA 21 CFR Part 11 audit by HCL Tech, score 87")
 *  - Operational audits ("SOC 2 Type II audit by Deloitte")
 *
 * Schema fields:
 *   - auditedBridgeNamespace: bytes32 (keccak256(bridge-namespace-string))
 *   - auditReportCID: bytes32 (IPFS CID hash of the audit report)
 *   - score: uint8 (0..100)
 *   - auditorOrg: string (human-readable auditor name)
 */

import { computeSchemaUID } from "../schema-registry.js";
import { ZERO_ADDRESS } from "../constants.js";

export const PCC_AUDIT_SCHEMA =
  "bytes32 auditedBridgeNamespace,bytes32 auditReportCID,uint8 score,string auditorOrg";

export const PCC_AUDIT_SCHEMA_UID = computeSchemaUID(
  PCC_AUDIT_SCHEMA,
  ZERO_ADDRESS,
  true,
);

export interface PCCAuditData {
  /** keccak256 of the bridge namespace string */
  auditedBridgeNamespace: `0x${string}`;
  /** IPFS CID hash (or content-addressed reference) for the audit report */
  auditReportCID: `0x${string}`;
  /** Numeric audit score 0..100 */
  score: number;
  /** Auditor organization name (e.g. "Trail of Bits") */
  auditorOrg: string;
}

export function toPCCAuditFields(data: PCCAuditData): Record<string, unknown> {
  if (data.score < 0 || data.score > 100) {
    throw new Error(`Audit score must be 0..100, got ${data.score}`);
  }
  if (!data.auditorOrg || data.auditorOrg.length === 0) {
    throw new Error("auditorOrg must be a non-empty string");
  }
  return {
    auditedBridgeNamespace: data.auditedBridgeNamespace,
    auditReportCID: data.auditReportCID,
    score: data.score,
    auditorOrg: data.auditorOrg,
  };
}
