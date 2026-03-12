/**
 * Capability Certificate Service — mock implementation of Metaplex
 * Bubblegum v2 soulbound compressed NFTs (cNFTs) on Solana.
 *
 * In production this would interact with the Solana Bubblegum program.
 * Here we simulate the full interface with in-memory state so that
 * the rest of the PCC stack (gateway, dashboard, agents) can develop
 * against a realistic API surface.
 */

import type {
  CapabilityCertificate,
  CertificateMetadata,
} from "@pcc/spec";

export interface MintCertificateParams {
  kernelDid: string;
  capabilityType: string;
  assuranceTier: number;
  metadata: CertificateMetadata;
}

export class CapabilityCertificateService {
  /** In-memory store keyed by certificate ID */
  private certificates = new Map<string, CapabilityCertificate>();

  /** Mock Merkle tree address */
  private readonly merkleTree: string;

  /** Running leaf index counter */
  private nextLeafIndex = 0;

  constructor(merkleTree?: string) {
    // Use a deterministic-looking but fake Solana pubkey
    this.merkleTree =
      merkleTree ?? "TreeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  }

  // ── Public API ─────────────────────────────────────────────────

  /**
   * Mint a new soulbound capability certificate.
   * Returns the full certificate object (analogous to the on-chain asset).
   */
  mintCapabilityCertificate(
    params: MintCertificateParams,
  ): CapabilityCertificate {
    const { kernelDid, capabilityType, assuranceTier, metadata } = params;

    if (!kernelDid) throw new Error("kernelDid is required");
    if (!capabilityType) throw new Error("capabilityType is required");
    if (assuranceTier < 0 || assuranceTier > 3) {
      throw new Error("assuranceTier must be 0-3");
    }

    const leafIndex = this.nextLeafIndex++;
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
      merkleTree: this.merkleTree,
      leafIndex,
      assetId,
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
   * Revoke a certificate. In production this would burn/freeze the cNFT.
   */
  revokeCapabilityCertificate(
    certificateId: string,
  ): { revoked: boolean; reason?: string } {
    const cert = this.certificates.get(certificateId);
    if (!cert) {
      return { revoked: false, reason: "Certificate not found" };
    }
    if (cert.status === "revoked") {
      return { revoked: false, reason: "Certificate already revoked" };
    }
    cert.status = "revoked";
    return { revoked: true };
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
   * This method exists to explicitly enforce the soulbound invariant.
   */
  transferCertificate(
    _certificateId: string,
    _toKernelDid: string,
  ): { transferred: false; reason: string } {
    return {
      transferred: false,
      reason: "Capability certificates are soulbound and non-transferable",
    };
  }
}
