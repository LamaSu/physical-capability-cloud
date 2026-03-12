/**
 * Evidence Storage Service — content-addresses evidence bundles on IPFS via Helia.
 *
 * Runs an in-process Helia node (no external IPFS daemon needed).
 * Bundles are stored as JSON bytes under UnixFS, producing a CID.
 * A separate metadata CID is generated for public indexing (no secrets).
 */

import { createHelia } from "helia";
import { unixfs } from "@helia/unixfs";
import { CID } from "multiformats/cid";
import type { EvidenceBundle, EncryptedEvidenceBundle } from "@pcc/spec";

/** Result of archiving a bundle to IPFS */
export interface ArchiveResult {
  /** IPFS content identifier for the full bundle */
  cid: string;
  /** IPFS CID for public metadata (no secrets) */
  metadataCid: string;
}

export class EvidenceStorageService {
  private helia: Awaited<ReturnType<typeof createHelia>> | null = null;
  private fs: ReturnType<typeof unixfs> | null = null;

  /** Start the in-process Helia node */
  async init(): Promise<void> {
    this.helia = await createHelia();
    this.fs = unixfs(this.helia);
  }

  /** Check whether the IPFS node is running */
  isReady(): boolean {
    return this.fs !== null;
  }

  /**
   * Archive a plain evidence bundle to IPFS.
   * Returns CIDs for the full bundle and its public metadata.
   */
  async archiveBundle(bundle: EvidenceBundle): Promise<ArchiveResult> {
    if (!this.fs) throw new Error("IPFS not initialized — call init() first");

    const encoder = new TextEncoder();

    // Store full bundle
    const bundleBytes = encoder.encode(JSON.stringify(bundle));
    const bundleCid = await this.fs.addBytes(bundleBytes);

    // Store public metadata (no secrets, suitable for indexing)
    const metadata = {
      bundleId: bundle.id,
      jobId: bundle.jobId,
      stepId: bundle.stepId,
      kernelId: bundle.kernelId,
      tier: bundle.assuranceTier,
      bundleHash: bundle.bundleHash,
      eventCount: bundle.events.length,
      createdAt: bundle.createdAt,
    };
    const metaBytes = encoder.encode(JSON.stringify(metadata));
    const metaCid = await this.fs.addBytes(metaBytes);

    return {
      cid: bundleCid.toString(),
      metadataCid: metaCid.toString(),
    };
  }

  /**
   * Archive an encrypted evidence bundle to IPFS.
   * Returns CIDs for the encrypted bundle and its public metadata.
   */
  async archiveEncryptedBundle(bundle: EncryptedEvidenceBundle): Promise<ArchiveResult> {
    if (!this.fs) throw new Error("IPFS not initialized — call init() first");

    const encoder = new TextEncoder();

    // Store full encrypted bundle
    const bundleBytes = encoder.encode(JSON.stringify(bundle));
    const bundleCid = await this.fs.addBytes(bundleBytes);

    // Store public metadata (no ciphertext, no keys)
    const metadata = {
      bundleId: bundle.bundleId,
      bundleHash: bundle.bundleHash,
      encryptedAt: bundle.encryptedAt,
      recipientCount: bundle.capsules.length,
    };
    const metaBytes = encoder.encode(JSON.stringify(metadata));
    const metaCid = await this.fs.addBytes(metaBytes);

    return {
      cid: bundleCid.toString(),
      metadataCid: metaCid.toString(),
    };
  }

  /**
   * Retrieve a bundle (or any JSON object) from IPFS by its CID string.
   */
  async retrieveBundle(cidString: string): Promise<unknown> {
    if (!this.fs) throw new Error("IPFS not initialized — call init() first");

    const cid = CID.parse(cidString);

    const chunks: Uint8Array[] = [];
    for await (const chunk of this.fs.cat(cid)) {
      chunks.push(chunk);
    }

    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    return JSON.parse(new TextDecoder().decode(combined));
  }

  /** Stop the Helia node and release resources */
  async stop(): Promise<void> {
    if (this.helia) {
      await this.helia.stop();
      this.helia = null;
      this.fs = null;
    }
  }
}
