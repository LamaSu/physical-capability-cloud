/**
 * Compliance Populator — transforms raw EvidenceBundle DB rows into EvidenceSummaryDTOs.
 *
 * Kept intentionally thin: enrichment beyond what the raw bundle provides
 * (ALCOA+ checks, tier compliance, drift detection) is the responsibility
 * of ComplianceFacade, not this populator.
 */

import type { EvidenceSummaryDTO } from "../types.js";
import type { AssuranceTier } from "@pcc/spec";

/** Raw bundle row returned by EvidenceBundleRepository */
export interface RawEvidenceBundle {
  id: string;
  jobId: string;
  stepId: string;
  kernelId?: string;
  assuranceTier?: number;
  bundleHash?: string;
  createdAt?: string;
  kernelSignature?: {
    signer: string;
    algorithm: string;
    value: string;
  };
  /** Optional enrichment — not on the raw DB row */
  verified?: boolean;
  /** Optional IPFS CID — not on the raw DB row, added by encrypted evidence layer */
  storageCid?: string;
  /** Serialized events — may be present if pre-loaded */
  events?: unknown[];
  [key: string]: unknown;
}

/**
 * Populate a single raw evidence bundle into an EvidenceSummaryDTO.
 */
export function populateEvidenceSummaryDTO(bundle: RawEvidenceBundle): EvidenceSummaryDTO {
  return {
    id: bundle.id,
    jobId: bundle.jobId,
    stepId: bundle.stepId,
    assuranceTier: (bundle.assuranceTier ?? 0) as AssuranceTier,
    eventCount: Array.isArray(bundle.events) ? bundle.events.length : 0,
    bundleHash: bundle.bundleHash ?? "",
    createdAt: bundle.createdAt ?? new Date().toISOString(),
    verified: bundle.verified ?? false,
    storageCid: bundle.storageCid ?? undefined,
  };
}

/**
 * Batch-populate a list of raw evidence bundles.
 * Returns them sorted by createdAt descending (most recent first).
 */
export function populateEvidenceList(bundles: RawEvidenceBundle[]): EvidenceSummaryDTO[] {
  return bundles
    .map(populateEvidenceSummaryDTO)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
