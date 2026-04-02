/**
 * Storacha (w3up) Evidence Storage Service — content-addresses evidence bundles
 * on IPFS via Storacha / web3.storage infrastructure.
 *
 * Two operating modes:
 *   - mock (default): in-memory Map, generates deterministic CIDs using
 *     multiformats sha2-256 + raw codec. No network I/O, safe for tests.
 *   - real: delegates to @storacha/client, uploading blobs to Storacha.
 *     Requires STORACHA_PROOF env var (base64-encoded UCAN delegation).
 *
 * The public interface mirrors EvidenceStorageService so the two are
 * interchangeable via createEvidenceStorage().
 */

import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import type { EvidenceBundle, EncryptedEvidenceBundle } from "@pcc/spec";
import type { ArchiveResult } from "./evidence-storage.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface StorachaStorageOptions {
  /**
   * When true (default) the service runs entirely in memory.
   * Set to false to use the real @storacha/client.
   */
  mock?: boolean;
  /** DID of the Storacha space (real mode only). */
  spaceDid?: string;
  /**
   * Base64-encoded UCAN delegation proof granting upload capability.
   * Falls back to the STORACHA_PROOF env var when omitted.
   */
  proof?: string;
}

// ---------------------------------------------------------------------------
// Helpers — deterministic CID from bytes (mock mode)
// ---------------------------------------------------------------------------

/**
 * Compute a CIDv1 for arbitrary bytes using sha2-256 + raw codec.
 * This produces the same string as Helia/UnixFS would for small blobs
 * (single-block files use the raw codec, sha2-256 hash).
 */
async function cidFromBytes(bytes: Uint8Array): Promise<CID> {
  const hash = await sha256.digest(bytes);
  return CID.createV1(raw.code, hash);
}

// ---------------------------------------------------------------------------
// StorachaStorageService
// ---------------------------------------------------------------------------

export class StorachaStorageService {
  private readonly options: Required<Pick<StorachaStorageOptions, "mock">> &
    StorachaStorageOptions;

  /** In-memory store: CID string → raw bytes (mock mode only) */
  private store = new Map<string, Uint8Array>();

  /** Whether init() has completed successfully */
  private ready = false;

  /** Real-mode client — typed as unknown to keep @storacha/client optional at build time */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;

  constructor(options: StorachaStorageOptions = {}) {
    this.options = { mock: true, ...options };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    if (this.options.mock) {
      // Nothing to start; the in-memory store is always available.
      this.ready = true;
      return;
    }

    // Real mode: initialise @storacha/client
    const proofBase64 =
      this.options.proof ?? process.env["STORACHA_PROOF"] ?? "";
    if (!proofBase64) {
      throw new Error(
        "Storacha real mode requires a delegation proof. " +
          "Set STORACHA_PROOF env var or pass proof in options."
      );
    }

    const spaceDid =
      this.options.spaceDid ?? process.env["STORACHA_SPACE_DID"] ?? "";

    try {
      const { create } = await import("@storacha/client");
      const { parse: parseProof } = await import("@storacha/client/proof");
      const { StoreMemory } = await import("@storacha/client/stores/memory");

      this.client = await create({ store: new StoreMemory() });

      // Parse the delegation proof from base64
      const proof = await parseProof(proofBase64);

      // Try addSpace first — works when the delegation's capabilities[0].with
      // is a did:key: (the space DID).  Newer Storacha CLI versions may issue
      // proofs where capabilities[0].with is did:web:up.storacha.network,
      // which older @storacha/access versions reject.  In that case, fall back
      // to manual registration.
      try {
        const space = await this.client.addSpace(proof);
        await this.client.setCurrentSpace(space.did());
      } catch (addSpaceErr) {
        const msg = (addSpaceErr as Error).message ?? "";
        if (!msg.includes("did:key") && !msg.includes("did:web")) {
          // Not the known DID-method mismatch — re-throw
          throw addSpaceErr;
        }

        // Fallback: manually register the space and add the proof.
        // This requires a known space DID (from STORACHA_SPACE_DID env or options).
        if (!spaceDid) {
          throw new Error(
            "Storacha delegation uses a non did:key: resource (likely did:web). " +
              "Set STORACHA_SPACE_DID to the did:key: of your space so the " +
              "client can register the space manually."
          );
        }

        // Register the space in the agent's spaces Map.  The Agent class
        // exposes `get spaces()` which returns the same Map reference held by
        // the underlying AgentData.  setCurrentSpace checks this map, so we
        // must populate it before calling setCurrentSpace.
        const agent = this.client.agent;
        agent.spaces.set(spaceDid, { name: "storacha-space" });

        // Add the delegation as a proof so capability invocations carry it
        await this.client.addProof(proof);

        // Set the space as current
        await this.client.setCurrentSpace(spaceDid);
      }

      this.ready = true;
    } catch (err) {
      throw new Error(
        `Failed to initialise Storacha client: ${(err as Error).message}`
      );
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  async stop(): Promise<void> {
    this.store.clear();
    this.ready = false;
    this.client = null;
  }

  // -------------------------------------------------------------------------
  // Archive — plain evidence bundle
  // -------------------------------------------------------------------------

  async archiveBundle(bundle: EvidenceBundle): Promise<ArchiveResult> {
    this.assertReady();

    const encoder = new TextEncoder();
    const bundleBytes = encoder.encode(JSON.stringify(bundle));

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

    if (this.options.mock) {
      return this.mockStore(bundleBytes, metaBytes);
    }

    return this.realUpload(bundleBytes, metaBytes);
  }

  // -------------------------------------------------------------------------
  // Archive — encrypted evidence bundle
  // -------------------------------------------------------------------------

  async archiveEncryptedBundle(
    bundle: EncryptedEvidenceBundle
  ): Promise<ArchiveResult> {
    this.assertReady();

    const encoder = new TextEncoder();
    const bundleBytes = encoder.encode(JSON.stringify(bundle));

    const metadata = {
      bundleId: bundle.bundleId,
      bundleHash: bundle.bundleHash,
      encryptedAt: bundle.encryptedAt,
      recipientCount: bundle.capsules.length,
    };
    const metaBytes = encoder.encode(JSON.stringify(metadata));

    if (this.options.mock) {
      return this.mockStore(bundleBytes, metaBytes);
    }

    return this.realUpload(bundleBytes, metaBytes);
  }

  // -------------------------------------------------------------------------
  // Retrieve
  // -------------------------------------------------------------------------

  async retrieveBundle(cidString: string): Promise<unknown> {
    this.assertReady();

    if (this.options.mock) {
      const bytes = this.store.get(cidString);
      if (!bytes) {
        throw new Error(`Storacha mock: CID not found — ${cidString}`);
      }
      return JSON.parse(new TextDecoder().decode(bytes));
    }

    // Real mode: fetch from Storacha / IPFS gateway
    const cid = CID.parse(cidString);
    const res = await fetch(`https://w3s.link/ipfs/${cid.toString()}`);
    if (!res.ok) {
      throw new Error(
        `Storacha retrieve failed for ${cidString}: HTTP ${res.status}`
      );
    }
    return res.json();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private assertReady(): void {
    if (!this.ready) {
      throw new Error("Storacha not initialized — call init() first");
    }
  }

  /** Mock-mode: compute CIDs locally and store bytes in the in-memory map. */
  private async mockStore(
    bundleBytes: Uint8Array,
    metaBytes: Uint8Array
  ): Promise<ArchiveResult> {
    const bundleCid = await cidFromBytes(bundleBytes);
    const metaCid = await cidFromBytes(metaBytes);

    const cid = bundleCid.toString();
    const metadataCid = metaCid.toString();

    // Idempotent: same content → same CID → same slot
    this.store.set(cid, bundleBytes);
    this.store.set(metadataCid, metaBytes);

    return { cid, metadataCid };
  }

  /** Real-mode: upload blobs to Storacha via @storacha/client. */
  private async realUpload(
    bundleBytes: Uint8Array,
    metaBytes: Uint8Array
  ): Promise<ArchiveResult> {
    // Upload as raw blobs
    const bundleBlob = new Blob([bundleBytes as BlobPart], {
      type: "application/octet-stream",
    });
    const metaBlob = new Blob([metaBytes as BlobPart], {
      type: "application/octet-stream",
    });

    const bundleCid = await this.client.uploadFile(bundleBlob);
    const metaCid = await this.client.uploadFile(metaBlob);

    return {
      cid: bundleCid.toString(),
      metadataCid: metaCid.toString(),
    };
  }
}
