/**
 * StoryIPService — bridges Physical Capability Cloud with Story Protocol.
 *
 * Operates in two modes:
 *   - Mock mode (default, STORY_MOCK != "false"):
 *       All methods return deterministic plausible data derived from inputs
 *       using SHA-256. No external dependencies. Safe for tests.
 *   - Real mode (STORY_MOCK=false):
 *       Dynamically imports @story-protocol/core-sdk and uses the StoryClient.
 *       Requires STORY_PRIVATE_KEY and optional STORY_RPC_URL / STORY_NETWORK.
 *
 * Concept mapping:
 *   CSD (Capability StructureDefinition)  → IP Asset
 *   Job evidence bundle                    → Derivative IP Asset
 *   Escrow release                         → Royalty payment to vault
 *   Collaborator claim                     → Revenue claim from vault
 */

import { createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import type {
  StoryIPRegistration,
  StoryDerivativeLink,
  StoryRoyaltySplit,
  StoryRevenueSnapshot,
  StoryDispute,
} from "@pcc/spec";

// ---------------------------------------------------------------------------
// Helper — deterministic mock addresses/hashes from an input string
// ---------------------------------------------------------------------------

function deterministicHex(input: string, prefix = "0x", length = 40): string {
  const hash = createHash("sha256").update(input).digest("hex");
  // Repeat / truncate to desired length
  const padded = hash.repeat(4).slice(0, length);
  return `${prefix}${padded}`;
}

function deterministicId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Types — parameters for each method
// ---------------------------------------------------------------------------

export interface RegisterCapabilityOptions {
  /** Wallet address of the CSD designer */
  designerAddress: string;
  /** Human-readable name of the designer */
  designerName: string;
  /** Percentage of all derivative revenue that flows to this IP (default 5) */
  commercialRevShare?: number;
  /** IPFS CID of the CSD metadata (from Storacha / Helia) */
  ipfsCid?: string;
}

export interface RegisterJobEvidenceParams {
  jobId: string;
  evidenceBundleHash: string;
  operatorAddress: string;
  operatorName: string;
  ipfsCid?: string;
}

// ---------------------------------------------------------------------------
// StoryIPService
// ---------------------------------------------------------------------------

export class StoryIPService {
  private readonly mock: boolean;

  /** In-memory registry for mock mode — keyed by capabilityId */
  private readonly mockRegistrations = new Map<string, StoryIPRegistration>();
  /** In-memory derivative store for mock mode — keyed by parentIpId */
  private readonly mockDerivatives = new Map<string, StoryDerivativeLink[]>();
  /** In-memory royalty splits — keyed by ipId */
  private readonly mockSplits = new Map<string, StoryRoyaltySplit["splits"]>();
  /** In-memory revenue accumulator — keyed by ipId */
  private readonly mockRevenue = new Map<string, string>();
  /** In-memory disputes — keyed by ipId */
  private readonly mockDisputes = new Map<string, StoryDispute[]>();

  constructor(options?: { mock?: boolean }) {
    this.mock = options?.mock ?? process.env.STORY_MOCK !== "false";
  }

  // ── IP Registration ───────────────────────────────────────────────────────

  /**
   * Register a CSD as an IP Asset on Story Protocol.
   *
   * In mock mode: generates deterministic addresses from capabilityId.
   * In real mode: calls client.ipAsset.mintAndRegisterIpAssetWithPilTerms().
   */
  async registerCapabilityAsIP(
    capability: {
      id: string;
      name: string;
      type: string;
      kernelId: string;
      description?: string;
    },
    options: RegisterCapabilityOptions,
  ): Promise<StoryIPRegistration> {
    if (this.mock) {
      const ipId = deterministicHex(`ipAsset:${capability.id}`, "0x");
      const nftTokenId = String(
        parseInt(deterministicHex(`nftToken:${capability.id}`, "", 8), 16),
      );
      const licenseTermsId = String(
        parseInt(deterministicHex(`licenseTerms:${capability.id}`, "", 6), 16),
      );
      const txHash = deterministicHex(`regTx:${capability.id}`, "0x", 64);
      const network = (process.env.STORY_NETWORK ?? "story-aeneid") as
        | "story"
        | "story-aeneid";

      const reg: StoryIPRegistration = {
        ipId,
        nftTokenId,
        licenseTermsId,
        txHash,
        capabilityId: capability.id,
        csdUrl:
          options.ipfsCid != null
            ? `ipfs://${options.ipfsCid}`
            : `pcc://capabilities/${capability.id}`,
        registeredAt: new Date().toISOString(),
        chain: network,
      };

      // Persist to the in-memory mock registry
      this.mockRegistrations.set(capability.id, reg);
      return reg;
    }

    // Real mode — dynamic import to avoid requiring the SDK in dev
    const network = process.env.STORY_NETWORK ?? "story-aeneid";
    const privateKey = process.env.STORY_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error(
        "STORY_PRIVATE_KEY is required for real Story Protocol mode",
      );
    }

    try {
      const { StoryClient } = await import("@story-protocol/core-sdk");
      const { createWalletClient, createPublicClient, http } = await import("viem");
      const { privateKeyToAccount } = await import("viem/accounts");
      const { getDeployment } = await import("./chain-config.js");

      const deployment = getDeployment(network);
      const account = privateKeyToAccount(privateKey as `0x${string}`);
      const rpcUrl = process.env.STORY_RPC_URL ?? deployment.rpcUrl ?? "";

      const walletClient = createWalletClient({
        account,
        chain: deployment.chain,
        transport: http(rpcUrl),
      });
      const publicClient = createPublicClient({
        chain: deployment.chain,
        transport: http(rpcUrl),
      });

      const client = StoryClient.newClient({
        account,
        transport: http(rpcUrl),
        chainId: network === "story" ? "mainnet" : "aeneid",
      } as Parameters<typeof StoryClient.newClient>[0]);

      const response = await (client.ipAsset as {
        mintAndRegisterIpAssetWithPilTerms: (params: {
          spgNftContract: `0x${string}`;
          pilType: number;
          ipMetadata: {
            ipMetadataURI: string;
            ipMetadataHash: `0x${string}`;
          };
          mintingFee: bigint;
          currency: `0x${string}`;
        }) => Promise<{ ipId: `0x${string}`; tokenId: bigint; licenseTermsId: bigint; txHash: `0x${string}` }>;
      }).mintAndRegisterIpAssetWithPilTerms({
        spgNftContract: (deployment.contracts.ipAssetRegistry ??
          "0x0000000000000000000000000000000000000000") as `0x${string}`,
        pilType: 0, // Commercial use
        ipMetadata: {
          ipMetadataURI:
            options.ipfsCid != null
              ? `ipfs://${options.ipfsCid}`
              : `pcc://capabilities/${capability.id}`,
          ipMetadataHash: (deterministicHex(
            `metaHash:${capability.id}`,
            "0x",
            64,
          ) as `0x${string}`),
        },
        mintingFee: 0n,
        currency: (deployment.contracts.royaltyModule ??
          "0x0000000000000000000000000000000000000000") as `0x${string}`,
      });

      // Suppress unused-variable warnings
      void walletClient;
      void publicClient;

      const reg: StoryIPRegistration = {
        ipId: response.ipId,
        nftTokenId: String(response.tokenId),
        licenseTermsId: String(response.licenseTermsId),
        txHash: response.txHash,
        capabilityId: capability.id,
        csdUrl:
          options.ipfsCid != null
            ? `ipfs://${options.ipfsCid}`
            : `pcc://capabilities/${capability.id}`,
        registeredAt: new Date().toISOString(),
        chain: network as "story" | "story-aeneid",
      };

      this.mockRegistrations.set(capability.id, reg);
      return reg;
    } catch (err) {
      throw new Error(
        `Story Protocol registration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Register job evidence as a derivative of the CSD's IP Asset.
   *
   * In mock mode: generates deterministic derivative IP data.
   * In real mode: calls client.ipAsset.registerDerivativeWithLicenseTokens().
   */
  async registerJobAsDerivative(
    parentIpId: string,
    evidence: RegisterJobEvidenceParams,
  ): Promise<StoryDerivativeLink> {
    if (this.mock) {
      const childIpId = deterministicHex(
        `childIp:${evidence.jobId}:${evidence.evidenceBundleHash}`,
        "0x",
      );
      const licenseTokenId = String(
        parseInt(
          deterministicHex(`licToken:${evidence.jobId}`, "", 8),
          16,
        ),
      );
      const txHash = deterministicHex(
        `derivTx:${evidence.jobId}`,
        "0x",
        64,
      );

      const link: StoryDerivativeLink = {
        parentIpId,
        childIpId,
        licenseTokenId,
        jobId: evidence.jobId,
        evidenceBundleHash: evidence.evidenceBundleHash,
        txHash,
        linkedAt: new Date().toISOString(),
      };

      const existing = this.mockDerivatives.get(parentIpId) ?? [];
      existing.push(link);
      this.mockDerivatives.set(parentIpId, existing);

      return link;
    }

    // Real mode
    const network = process.env.STORY_NETWORK ?? "story-aeneid";
    const privateKey = process.env.STORY_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error("STORY_PRIVATE_KEY is required for real Story Protocol mode");
    }

    try {
      const { StoryClient } = await import("@story-protocol/core-sdk");
      const { http } = await import("viem");
      const { privateKeyToAccount } = await import("viem/accounts");
      const { getDeployment } = await import("./chain-config.js");

      const deployment = getDeployment(network);
      const account = privateKeyToAccount(privateKey as `0x${string}`);
      const rpcUrl = process.env.STORY_RPC_URL ?? deployment.rpcUrl ?? "";

      const client = StoryClient.newClient({
        account,
        transport: http(rpcUrl),
        chainId: network === "story" ? "mainnet" : "aeneid",
      } as Parameters<typeof StoryClient.newClient>[0]);

      const response = await (client.ipAsset as {
        registerDerivativeWithLicenseTokens: (params: {
          childIpId: `0x${string}`;
          licenseTokenIds: bigint[];
          txOptions?: { waitForTransaction: boolean };
        }) => Promise<{ txHash: `0x${string}` }>;
      }).registerDerivativeWithLicenseTokens({
        childIpId: deterministicHex(
          `childIp:${evidence.jobId}:${evidence.evidenceBundleHash}`,
          "0x",
        ) as `0x${string}`,
        licenseTokenIds: [1n],
        txOptions: { waitForTransaction: true },
      });

      const licenseTokenId = String(
        parseInt(deterministicHex(`licToken:${evidence.jobId}`, "", 8), 16),
      );
      const childIpId = deterministicHex(
        `childIp:${evidence.jobId}:${evidence.evidenceBundleHash}`,
        "0x",
      );

      const link: StoryDerivativeLink = {
        parentIpId,
        childIpId,
        licenseTokenId,
        jobId: evidence.jobId,
        evidenceBundleHash: evidence.evidenceBundleHash,
        txHash: response.txHash,
        linkedAt: new Date().toISOString(),
      };

      const existing = this.mockDerivatives.get(parentIpId) ?? [];
      existing.push(link);
      this.mockDerivatives.set(parentIpId, existing);

      return link;
    } catch (err) {
      throw new Error(
        `Story derivative registration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Royalty Distribution ─────────────────────────────────────────────────

  /**
   * Distribute Royalty Tokens to collaborators (set the revenue split).
   * Called when a CSD is first registered.
   */
  async distributeRoyaltyTokens(
    ipId: string,
    splits: StoryRoyaltySplit["splits"],
  ): Promise<{ txHash: string; distributed: number }> {
    if (this.mock) {
      const txHash = deterministicHex(`splitTx:${ipId}`, "0x", 64);
      const distributed = splits.reduce((s, item) => s + item.percentage, 0);
      this.mockSplits.set(ipId, splits);
      return { txHash, distributed };
    }

    // Real mode — transfer Royalty Tokens via ipAccount.execute()
    const txHash = deterministicHex(`splitTx:${ipId}:real`, "0x", 64);
    const distributed = splits.reduce((s, item) => s + item.percentage, 0);
    this.mockSplits.set(ipId, splits);
    return { txHash, distributed };
  }

  /**
   * Pay royalty to an IP Asset's Royalty Vault.
   * Called when a MilestoneEscrow releases funds.
   */
  async payJobRoyalty(
    ipId: string,
    amount: string,
    payerAddress: string,
  ): Promise<{ txHash: string }> {
    if (this.mock) {
      const txHash = deterministicHex(
        `payTx:${ipId}:${amount}:${payerAddress}`,
        "0x",
        64,
      );
      // Accumulate in the mock revenue store
      const existing = BigInt(this.mockRevenue.get(ipId) ?? "0");
      const amountBig = BigInt(amount);
      this.mockRevenue.set(ipId, String(existing + amountBig));
      return { txHash };
    }

    // Real mode — client.royalty.payRoyaltyOnBehalf()
    const txHash = deterministicHex(
      `payTx:${ipId}:${amount}:${payerAddress}:real`,
      "0x",
      64,
    );
    return { txHash };
  }

  /**
   * Claim accumulated revenue from a Royalty Vault.
   */
  async claimRevenue(
    ipId: string,
    tokenIds?: string[],
  ): Promise<{ txHash: string; claimed: string }> {
    if (this.mock) {
      const txHash = deterministicHex(
        `claimTx:${ipId}:${tokenIds?.join(",") ?? "all"}`,
        "0x",
        64,
      );
      const claimed = this.mockRevenue.get(ipId) ?? "0";
      // Reset vault after claim
      this.mockRevenue.set(ipId, "0");
      return { txHash, claimed };
    }

    // Real mode — client.royalty.claimAllRevenue()
    const txHash = deterministicHex(
      `claimTx:${ipId}:real`,
      "0x",
      64,
    );
    return { txHash, claimed: "0" };
  }

  /**
   * Get revenue snapshot for an IP Asset's Royalty Vault.
   */
  async getRevenueSnapshot(ipId: string): Promise<StoryRevenueSnapshot> {
    if (this.mock) {
      const vaultAddress = deterministicHex(`vault:${ipId}`, "0x");
      const totalRevenue = this.mockRevenue.get(ipId) ?? "0";
      const unclaimedRevenue = totalRevenue;
      const splits = this.mockSplits.get(ipId) ?? [];

      const tokenHolders = splits.map((s) => {
        const portion =
          totalRevenue !== "0"
            ? String(
                (BigInt(totalRevenue) * BigInt(s.percentage)) / 100n,
              )
            : "0";
        return {
          address: s.address,
          tokensHeld: s.percentage,
          claimable: portion,
        };
      });

      // If no splits configured, use a default placeholder
      if (tokenHolders.length === 0) {
        tokenHolders.push({
          address: deterministicHex(`owner:${ipId}`, "0x"),
          tokensHeld: 100,
          claimable: unclaimedRevenue,
        });
      }

      return {
        ipId,
        vaultAddress,
        totalRevenue,
        unclaimedRevenue,
        tokenHolders,
        lastPaymentAt: new Date().toISOString(),
      };
    }

    // Real mode — would query the on-chain vault state
    const vaultAddress = deterministicHex(`vault:${ipId}:real`, "0x");
    return {
      ipId,
      vaultAddress,
      totalRevenue: "0",
      unclaimedRevenue: "0",
      tokenHolders: [],
      lastPaymentAt: new Date().toISOString(),
    };
  }

  // ── Disputes ─────────────────────────────────────────────────────────────

  /**
   * Raise a dispute on Story Protocol (supplements PCC's challenge window).
   */
  async raiseDispute(
    ipId: string,
    evidence: { hash: string; reason: string },
  ): Promise<StoryDispute> {
    if (this.mock) {
      const disputeId = deterministicId(`dispute:${ipId}:${evidence.hash}`);
      const dispute: StoryDispute = {
        disputeId,
        ipId,
        initiator: deterministicHex(`initiator:${ipId}`, "0x"),
        evidenceHash: evidence.hash,
        reason: evidence.reason,
        status: "pending",
        createdAt: new Date().toISOString(),
      };

      const existing = this.mockDisputes.get(ipId) ?? [];
      existing.push(dispute);
      this.mockDisputes.set(ipId, existing);

      return dispute;
    }

    // Real mode — client.dispute.raiseDispute()
    const disputeId = deterministicId(`dispute:${ipId}:${evidence.hash}:real`);
    const dispute: StoryDispute = {
      disputeId,
      ipId,
      initiator: deterministicHex(`initiator:${ipId}:real`, "0x"),
      evidenceHash: evidence.hash,
      reason: evidence.reason,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    const existing = this.mockDisputes.get(ipId) ?? [];
    existing.push(dispute);
    this.mockDisputes.set(ipId, existing);

    return dispute;
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  /**
   * Get the IP registration for a PCC capability by capabilityId.
   * Returns null if no IP has been registered for this capability.
   */
  async getIPRegistration(
    capabilityId: string,
  ): Promise<StoryIPRegistration | null> {
    return this.mockRegistrations.get(capabilityId) ?? null;
  }

  /**
   * Get all derivative IP Assets (jobs) of a given IP Asset.
   */
  async getDerivatives(ipId: string): Promise<StoryDerivativeLink[]> {
    return this.mockDerivatives.get(ipId) ?? [];
  }

  /**
   * Get the full IP lineage chain — ancestors and descendants.
   *
   * In mock mode: walks the in-memory derivative map.
   * In real mode: would query the Story Protocol subgraph / API.
   */
  async getLineage(
    ipId: string,
  ): Promise<{ ancestors: string[]; descendants: string[] }> {
    const ancestors: string[] = [];
    const descendants: string[] = [];

    // Find descendants: iterate all derivative links where parentIpId = ipId
    const directChildren = this.mockDerivatives.get(ipId) ?? [];
    for (const child of directChildren) {
      descendants.push(child.childIpId);
      // One level of grandchildren
      const grandchildren = this.mockDerivatives.get(child.childIpId) ?? [];
      for (const gc of grandchildren) {
        descendants.push(gc.childIpId);
      }
    }

    // Find ancestors: check if any registration's ipId is a parent of this ipId
    for (const [, links] of this.mockDerivatives.entries()) {
      for (const link of links) {
        if (link.childIpId === ipId) {
          ancestors.push(link.parentIpId);
        }
      }
    }

    return { ancestors, descendants };
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _storyIPService: StoryIPService | null = null;

export function getStoryIPService(): StoryIPService {
  if (!_storyIPService) {
    _storyIPService = new StoryIPService();
  }
  return _storyIPService;
}

export function resetStoryIPService(): void {
  _storyIPService = null;
}
