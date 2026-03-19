/**
 * Capability Certificate Service — Metaplex Core (mpl-core) soulbound NFTs.
 *
 * Uses mpl-core's single-account NFT standard with PermanentFreezeDelegate
 * plugin to create non-transferable capability certificates on Solana.
 *
 * Each certificate proves a machine's manufacturing capability at a specific
 * assurance tier. Soulbound = PermanentFreezeDelegate frozen at mint time.
 *
 * In production: real Solana RPC + funded keypair.
 * In mock mode (default): simulates mpl-core with in-memory state.
 */

import type {
  Umi,
  PublicKey as UmiPublicKey,
  Signer,
  TransactionBuilder,
} from "@metaplex-foundation/umi";
import type {
  CapabilityCertificate,
  CertificateMetadata,
} from "@pcc/spec";
import { PCCNFTClient } from "./pcc-nft/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MintCertificateParams {
  kernelDid: string;
  capabilityType: string;
  assuranceTier: number;
  metadata: CertificateMetadata;
}

export interface MplCoreConfig {
  /** Solana RPC URL (default: devnet) */
  rpcUrl?: string;
  /** Use mock mode — no real Solana calls (default: true) */
  mock?: boolean;
  /** Collection address for PCC certificates (created on first mint if absent) */
  collectionAddress?: string;
  /**
   * NFT engine to use:
   * - "mpl-core": Metaplex Core (legacy, $0.20/mint protocol fee)
   * - "pcc-native": PCC custom program (zero fees, full control)
   *
   * Default: "pcc-native" in mock mode, "mpl-core" in production.
   */
  engine?: "mpl-core" | "pcc-native";
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CapabilityCertificateService {
  private mock: boolean;
  private rpcUrl: string;
  private collectionAddress: string | null;
  private engine: "mpl-core" | "pcc-native";

  /** In-memory store (mock mode) keyed by certificate ID */
  private certificates = new Map<string, CapabilityCertificate>();
  /** Running asset index counter (mock) */
  private nextIndex = 0;

  /** Lazy-initialized Umi instance (production mode, mpl-core engine) */
  private umi: Umi | null = null;

  /** PCC native NFT client (pcc-native engine) */
  private pccClient: PCCNFTClient | null = null;
  /** PCC native collection address (pcc-native engine) */
  private pccCollectionAddress: string | null = null;

  constructor(config: MplCoreConfig = {}) {
    this.mock = config.mock ?? true;
    this.rpcUrl = config.rpcUrl ?? "https://api.devnet.solana.com";
    this.collectionAddress = config.collectionAddress ?? null;
    // Default engine: pcc-native in mock mode, mpl-core in production
    this.engine = config.engine ?? (this.mock ? "pcc-native" : "mpl-core");

    if (this.engine === "pcc-native") {
      this.pccClient = new PCCNFTClient({
        rpcUrl: this.rpcUrl,
        mock: this.mock,
      });
    }
  }

  // ── Umi setup (production only) ──────────────────────────────────

  /**
   * Initialize Umi with mpl-core plugin. Call once before production mints.
   * In mock mode this is a no-op.
   */
  async initUmi(signerKeypair?: Uint8Array): Promise<void> {
    if (this.mock) return;

    // Dynamic imports — mpl-core + umi are ESM
    const { createUmi } = await import("@metaplex-foundation/umi-bundle-defaults");
    const { mplCore } = await import("@metaplex-foundation/mpl-core");
    const { keypairIdentity } = await import("@metaplex-foundation/umi");

    const umi = createUmi(this.rpcUrl).use(mplCore());

    if (signerKeypair) {
      const kp = umi.eddsa.createKeypairFromSecretKey(signerKeypair);
      umi.use(keypairIdentity(kp));
    }

    this.umi = umi;
  }

  // ── Core API ─────────────────────────────────────────────────────

  /**
   * Create the PCC Capability Certificate collection (once per deployment).
   * In production: calls mpl-core createCollection with PermanentFreezeDelegate.
   */
  async createCollection(): Promise<string> {
    // ── PCC-native engine ─────────────────────────────────────
    if (this.engine === "pcc-native" && this.pccClient) {
      const { address } = await this.pccClient.createCollection({
        name: "PCC Capability Certificates",
        uri: "https://pcc.network/metadata/collection.json",
      });
      // Wrap address so it contains "PCCCollection" for backward compat
      const compatAddress = `PCCCollection_${address}`;
      this.pccCollectionAddress = address;
      this.collectionAddress = compatAddress;
      return compatAddress;
    }

    // ── mpl-core engine (legacy) ──────────────────────────────
    if (this.mock) {
      this.collectionAddress = `PCCCollection${Date.now().toString(36)}`;
      return this.collectionAddress;
    }

    if (!this.umi) throw new Error("Call initUmi() first");

    const { createCollection, ruleSet } = await import("@metaplex-foundation/mpl-core");
    const { generateSigner } = await import("@metaplex-foundation/umi");

    const collectionSigner = generateSigner(this.umi);

    await createCollection(this.umi, {
      collection: collectionSigner,
      name: "PCC Capability Certificates",
      uri: "https://pcc.network/metadata/collection.json",
      plugins: [
        {
          type: "PermanentFreezeDelegate",
          frozen: true,
          authority: { type: "UpdateAuthority" },
        },
        {
          type: "Royalties",
          basisPoints: 0,
          creators: [{ address: this.umi.identity.publicKey, percentage: 100 }],
          ruleSet: ruleSet("None"),
        },
      ],
    }).sendAndConfirm(this.umi);

    this.collectionAddress = collectionSigner.publicKey.toString();
    return this.collectionAddress;
  }

  /**
   * Mint a soulbound capability certificate as an mpl-core Asset.
   *
   * The asset is created with PermanentFreezeDelegate(frozen: true),
   * making it non-transferable from the moment it's minted.
   */
  async mintCapabilityCertificate(
    params: MintCertificateParams,
  ): Promise<CapabilityCertificate> {
    const { kernelDid, capabilityType, assuranceTier, metadata } = params;

    if (!kernelDid) throw new Error("kernelDid is required");
    if (!capabilityType) throw new Error("capabilityType is required");
    if (assuranceTier < 0 || assuranceTier > 3) {
      throw new Error("assuranceTier must be 0-3");
    }

    // ── PCC-native engine ────────────────────────────────────────
    if (this.engine === "pcc-native" && this.pccClient) {
      const { address, signature } = await this.pccClient.mint({
        name: `PCC ${capabilityType} T${assuranceTier}`,
        uri: `https://pcc.network/metadata/cert/${Date.now()}.json`,
        owner: kernelDid,
        collection: this.pccCollectionAddress ?? undefined,
        permanentlyFrozen: true,
        attributes: {
          capabilityType,
          assuranceTier: String(assuranceTier),
          kernelDid,
          soulbound: "true",
          ...(metadata.materials ? { materials: metadata.materials.join(",") } : {}),
          ...(metadata.maxBuildVolume ? { maxBuildVolume: metadata.maxBuildVolume } : {}),
          ...(metadata.calibrationDate ? { calibrationDate: metadata.calibrationDate } : {}),
          ...(metadata.calibrationProofCid ? { calibrationProofCid: metadata.calibrationProofCid } : {}),
          ...Object.fromEntries(
            Object.entries(metadata.toleranceSpecs ?? {}).map(([k, v]) => [`tolerance:${k}`, v]),
          ),
        },
      });

      const id = `cnft_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
      const cert: CapabilityCertificate = {
        id,
        kernelDid,
        capabilityType,
        assuranceTier,
        metadata,
        mintedAt: new Date().toISOString(),
        soulbound: true,
        status: "active",
        merkleTree: this.collectionAddress ?? this.pccCollectionAddress ?? "PCCCollection",
        leafIndex: this.nextIndex++,
        assetId: address,
      };

      this.certificates.set(id, cert);
      return cert;
    }

    // ── Mock mode (mpl-core) ─────────────────────────────────────
    if (this.mock) {
      const index = this.nextIndex++;
      const id = `cnft_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
      const assetId = `Asset${id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32)}`;

      const cert: CapabilityCertificate = {
        id,
        kernelDid,
        capabilityType,
        assuranceTier,
        metadata,
        mintedAt: new Date().toISOString(),
        soulbound: true,
        status: "active",
        merkleTree: this.collectionAddress ?? "PCCCollection",
        leafIndex: index,
        assetId,
      };

      this.certificates.set(id, cert);
      return cert;
    }

    // ── Production mode (mpl-core) ───────────────────────────────
    if (!this.umi) throw new Error("Call initUmi() first");

    const { create, fetchCollection } = await import("@metaplex-foundation/mpl-core");
    const { generateSigner } = await import("@metaplex-foundation/umi");

    const assetSigner = generateSigner(this.umi);

    // Build on-chain metadata URI (in production, upload to Arweave/IPFS)
    const onChainMetadata = {
      name: `PCC ${capabilityType} Tier ${assuranceTier}`,
      description: `Capability certificate for ${capabilityType} at assurance tier ${assuranceTier}`,
      image: "https://pcc.network/assets/cert-badge.png",
      attributes: [
        { trait_type: "Capability Type", value: capabilityType },
        { trait_type: "Assurance Tier", value: String(assuranceTier) },
        { trait_type: "Kernel DID", value: kernelDid },
        ...(metadata.materials ?? []).map((m) => ({ trait_type: "Material", value: m })),
        ...(metadata.maxBuildVolume ? [{ trait_type: "Build Volume", value: metadata.maxBuildVolume }] : []),
        ...(metadata.calibrationDate ? [{ trait_type: "Calibration Date", value: metadata.calibrationDate }] : []),
        ...(metadata.calibrationProofCid ? [{ trait_type: "Calibration Proof CID", value: metadata.calibrationProofCid }] : []),
        ...Object.entries(metadata.toleranceSpecs ?? {}).map(([k, v]) => ({ trait_type: `Tolerance: ${k}`, value: v })),
      ],
      properties: {
        category: "capability_certificate",
        soulbound: true,
      },
    };

    // TODO: Upload metadata JSON to Arweave/IPFS and get URI
    const metadataUri = `https://pcc.network/metadata/cert/${assetSigner.publicKey.toString()}.json`;

    // Fetch collection if we have one
    const { publicKey } = await import("@metaplex-foundation/umi");

    let collectionArg: Record<string, unknown> | undefined;
    if (this.collectionAddress) {
      const collection = await fetchCollection(this.umi, publicKey(this.collectionAddress));
      collectionArg = { collection };
    }

    // Mint with PermanentFreezeDelegate → soulbound from creation
    await create(this.umi, {
      asset: assetSigner,
      name: `PCC ${capabilityType} T${assuranceTier}`,
      uri: metadataUri,
      ...collectionArg,
      plugins: [
        {
          type: "PermanentFreezeDelegate",
          frozen: true,
          authority: { type: "UpdateAuthority" },
        },
        {
          type: "Attributes",
          attributeList: [
            { key: "capabilityType", value: capabilityType },
            { key: "assuranceTier", value: String(assuranceTier) },
            { key: "kernelDid", value: kernelDid },
            { key: "soulbound", value: "true" },
          ],
        },
      ],
    }).sendAndConfirm(this.umi);

    const id = `cnft_${assetSigner.publicKey.toString().slice(0, 16)}`;
    const cert: CapabilityCertificate = {
      id,
      kernelDid,
      capabilityType,
      assuranceTier,
      metadata,
      mintedAt: new Date().toISOString(),
      soulbound: true,
      status: "active",
      merkleTree: this.collectionAddress ?? undefined,
      leafIndex: this.nextIndex++,
      assetId: assetSigner.publicKey.toString(),
    };

    this.certificates.set(id, cert);
    return cert;
  }

  /**
   * Verify a certificate exists and is still active.
   */
  verifyCapabilityCertificate(
    certificateId: string,
  ): { valid: boolean; certificate?: CapabilityCertificate; reason?: string } {
    const cert = this.certificates.get(certificateId);
    if (!cert) {
      return { valid: false, reason: "Certificate not found" };
    }
    if (cert.status === "revoked") {
      return { valid: false, certificate: cert, reason: "Certificate has been revoked" };
    }
    if (cert.status === "expired") {
      return { valid: false, certificate: cert, reason: "Certificate has expired" };
    }
    return { valid: true, certificate: cert };
  }

  /**
   * Revoke a certificate. In production: burns the mpl-core asset.
   */
  async revokeCapabilityCertificate(
    certificateId: string,
  ): Promise<{ revoked: boolean; reason?: string }> {
    const cert = this.certificates.get(certificateId);
    if (!cert) {
      return { revoked: false, reason: "Certificate not found" };
    }
    if (cert.status === "revoked") {
      return { revoked: false, reason: "Certificate already revoked" };
    }

    // Production: burn the on-chain asset
    if (!this.mock && this.umi && cert.assetId) {
      const { fetchAsset, burn } = await import("@metaplex-foundation/mpl-core");
      const { publicKey } = await import("@metaplex-foundation/umi");
      const asset = await fetchAsset(this.umi, publicKey(cert.assetId));
      await burn(this.umi, { asset }).sendAndConfirm(this.umi);
    }

    cert.status = "revoked";
    return { revoked: true };
  }

  /**
   * Fetch a certificate from on-chain (production) or memory (mock).
   */
  async fetchOnChainAsset(assetId: string): Promise<Record<string, unknown> | null> {
    if (this.mock) {
      for (const cert of this.certificates.values()) {
        if (cert.assetId === assetId) return cert as unknown as Record<string, unknown>;
      }
      return null;
    }

    if (!this.umi) throw new Error("Call initUmi() first");

    const { fetchAsset } = await import("@metaplex-foundation/mpl-core");
    const { publicKey } = await import("@metaplex-foundation/umi");
    const asset = await fetchAsset(this.umi, publicKey(assetId));
    return asset as unknown as Record<string, unknown>;
  }

  /**
   * Get all certificates for a given kernel DID.
   */
  getCertificatesForKernel(kernelDid: string): CapabilityCertificate[] {
    return [...this.certificates.values()].filter(
      (c) => c.kernelDid === kernelDid,
    );
  }

  /**
   * Get a single certificate by ID.
   */
  getCertificate(certificateId: string): CapabilityCertificate | undefined {
    return this.certificates.get(certificateId);
  }

  /**
   * List all certificates (optionally filtered by status).
   */
  listCertificates(
    filter?: { status?: CapabilityCertificate["status"] },
  ): CapabilityCertificate[] {
    let certs = [...this.certificates.values()];
    if (filter?.status) {
      certs = certs.filter((c) => c.status === filter.status);
    }
    return certs;
  }

  /**
   * Attempting to transfer a soulbound certificate always fails.
   * PermanentFreezeDelegate enforces this on-chain; this method
   * exists to explicitly enforce the invariant in application code.
   */
  transferCertificate(
    _certificateId: string,
    _toKernelDid: string,
  ): { transferred: false; reason: string } {
    return {
      transferred: false,
      reason: "Capability certificates are soulbound (PermanentFreezeDelegate) and non-transferable",
    };
  }
}
