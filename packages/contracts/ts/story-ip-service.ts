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
// Fail-closed real mode
// ---------------------------------------------------------------------------

/**
 * Thrown in real mode (STORY_MOCK=false) for every Story operation PCC does not actually perform
 * against the chain. Nothing was sent and no transaction exists.
 *
 * These branches used to return a made-up `deterministicHex(...)` transaction hash, a zero-revenue
 * "vault", or a dispute that was never raised. To a caller they read as a royalty paid, revenue
 * claimed, tokens distributed or a derivative registered, although nothing moved. A missing
 * implementation must look missing (pcc-economics, board row N10b). Routes should answer 501
 * `not_executed` for this error, never success and never a swallowed row.
 */
export class StoryNotExecutedError extends Error {
  readonly code = "STORY_NOT_EXECUTED" as const;
  constructor(
    readonly operation: string,
    reason: string,
  ) {
    super(
      `Story Protocol ${operation} was NOT executed in real mode: ${reason}. No transaction was sent and no transaction hash exists.`,
    );
    this.name = "StoryNotExecutedError";
  }
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
        simulated: true,
      };

      // Persist to the in-memory mock registry
      this.mockRegistrations.set(capability.id, reg);
      return reg;
    }

    // Real mode. The registration below would commit an `ipMetadataHash` made up from the capability
    // id (no metadata document exists to hash) against a hard-coded contract choice, so the on-chain
    // record would bind nothing real. Refuse until the metadata document is produced and hashed.
    // The SDK wiring this replaced is in git history (master ac86a404) for the real implementation.
    throw new StoryNotExecutedError(
      "registerCapabilityAsIP",
      "the IP metadata hash it would commit is fabricated (PCC produces no metadata document to hash yet)",
    );
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
        simulated: true,
      };

      const existing = this.mockDerivatives.get(parentIpId) ?? [];
      existing.push(link);
      this.mockDerivatives.set(parentIpId, existing);

      return link;
    }

    // Real mode. The call below registers a child IP id derived from a hash of the job id (never
    // registered as an IP) with a hard-coded license token id 1, and returns a made-up licenseTokenId.
    throw new StoryNotExecutedError(
      "registerJobAsDerivative",
      "the child IP id and license token it would use are fabricated, not registered",
    );
  }

  // ── Royalty Distribution ─────────────────────────────────────────────────

  /**
   * Distribute Royalty Tokens to collaborators (set the revenue split).
   * Called when a CSD is first registered.
   */
  async distributeRoyaltyTokens(
    ipId: string,
    splits: StoryRoyaltySplit["splits"],
  ): Promise<{ txHash: string; distributed: number; simulated: boolean }> {
    if (this.mock) {
      const txHash = deterministicHex(`splitTx:${ipId}`, "0x", 64);
      const distributed = splits.reduce((s, item) => s + item.percentage, 0);
      this.mockSplits.set(ipId, splits);
      return { txHash, distributed, simulated: true };
    }

    // Real mode: transferring Royalty Tokens (ipAccount.execute) is not implemented.
    throw new StoryNotExecutedError("distributeRoyaltyTokens", "Royalty Token transfer is not implemented");
  }

  /**
   * Pay royalty to an IP Asset's Royalty Vault.
   * Called when a MilestoneEscrow releases funds.
   */
  async payJobRoyalty(
    ipId: string,
    amount: string,
    payerAddress: string,
  ): Promise<{ txHash: string; simulated: boolean }> {
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
      return { txHash, simulated: true };
    }

    // Real mode: client.royalty.payRoyaltyOnBehalf() is not implemented.
    throw new StoryNotExecutedError("payJobRoyalty", "paying a royalty on behalf of a job is not implemented");
  }

  /**
   * Claim accumulated revenue from a Royalty Vault.
   */
  async claimRevenue(
    ipId: string,
    tokenIds?: string[],
  ): Promise<{ txHash: string; claimed: string; simulated: boolean }> {
    if (this.mock) {
      const txHash = deterministicHex(
        `claimTx:${ipId}:${tokenIds?.join(",") ?? "all"}`,
        "0x",
        64,
      );
      const claimed = this.mockRevenue.get(ipId) ?? "0";
      // Reset vault after claim
      this.mockRevenue.set(ipId, "0");
      return { txHash, claimed, simulated: true };
    }

    // Real mode: client.royalty.claimAllRevenue() is not implemented.
    throw new StoryNotExecutedError("claimRevenue", "claiming vault revenue is not implemented");
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
        simulated: true,
      };
    }

    // Real mode: the on-chain vault is not read. Returning zeros from a made-up vault address would
    // state "no revenue" as a fact.
    throw new StoryNotExecutedError("getRevenueSnapshot", "reading the Royalty Vault is not implemented");
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
        simulated: true,
      };

      const existing = this.mockDisputes.get(ipId) ?? [];
      existing.push(dispute);
      this.mockDisputes.set(ipId, existing);

      return dispute;
    }

    // Real mode: client.dispute.raiseDispute() is not implemented.
    throw new StoryNotExecutedError("raiseDispute", "raising a Story dispute is not implemented");
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  /**
   * Get the IP registration for a PCC capability by capabilityId.
   * Returns null if no IP has been registered for this capability.
   */
  async getIPRegistration(
    capabilityId: string,
  ): Promise<StoryIPRegistration | null> {
    // Real mode: this in-process map is not chain state, so "null" would falsely mean "not registered".
    if (!this.mock) throw new StoryNotExecutedError("getIPRegistration", "reading Story IP registrations is not implemented");
    return this.mockRegistrations.get(capabilityId) ?? null;
  }

  /**
   * Get all derivative IP Assets (jobs) of a given IP Asset.
   */
  async getDerivatives(ipId: string): Promise<StoryDerivativeLink[]> {
    if (!this.mock) throw new StoryNotExecutedError("getDerivatives", "reading Story derivative links is not implemented");
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
    if (!this.mock) throw new StoryNotExecutedError("getLineage", "reading the Story IP graph is not implemented");
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
