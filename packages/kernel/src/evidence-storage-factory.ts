/**
 * Evidence Storage Factory
 *
 * Selects an evidence storage backend based on the EVIDENCE_STORAGE env var:
 *   - "storacha"  → StorachaStorageService (w3up / Storacha network)
 *   - "helia"     → EvidenceStorageService (in-process Helia node) [default]
 *
 * Usage:
 *   const storage = createEvidenceStorage();
 *   await storage.init();
 *   const { cid } = await storage.archiveBundle(bundle);
 */

import type { ArchiveResult } from "./evidence-storage.js";
import type { EvidenceBundle, EncryptedEvidenceBundle } from "@pcc/spec";

/**
 * Minimal shared interface for all evidence storage backends.
 * Implemented by both EvidenceStorageService (Helia) and StorachaStorageService.
 */
export interface IEvidenceStorageService {
  init(): Promise<void>;
  isReady(): boolean;
  archiveBundle(bundle: EvidenceBundle): Promise<ArchiveResult>;
  archiveEncryptedBundle(bundle: EncryptedEvidenceBundle): Promise<ArchiveResult>;
  retrieveBundle(cid: string): Promise<unknown>;
  stop(): Promise<void>;
}

/**
 * Factory that returns the correct storage backend instance.
 *
 * @param type Override the backend selection; falls back to EVIDENCE_STORAGE
 *             env var, then defaults to "helia".
 */
export async function createEvidenceStorage(
  type?: string
): Promise<IEvidenceStorageService> {
  const backend = type ?? process.env["EVIDENCE_STORAGE"] ?? "helia";

  if (backend === "storacha") {
    const { StorachaStorageService } = await import("./storacha-storage.js");
    return new StorachaStorageService({ mock: true });
  }

  // Default: Helia in-process node
  const { EvidenceStorageService } = await import("./evidence-storage.js");
  return new EvidenceStorageService();
}
