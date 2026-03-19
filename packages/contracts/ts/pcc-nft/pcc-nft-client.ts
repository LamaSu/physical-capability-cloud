/**
 * PCC Native NFT Client
 *
 * TypeScript client for the PCC soulbound NFT program.
 * In mock mode (default), all state is held in-memory Maps.
 * In production mode, this would serialize Anchor instructions
 * and submit them to the deployed PCC NFT program on Solana.
 *
 * Key difference from Metaplex Core:
 *   - Zero protocol fees ($0.00 vs $0.20/mint)
 *   - Full PCC authority over freeze/burn/update lifecycle
 *   - Soulbound by default (permanentlyFrozen=true)
 *   - No Metaplex dependency chain (mpl-core, umi, etc.)
 */

import type {
  PCCAsset,
  PCCCollection,
  MintParams,
  UpdateParams,
  BurnParams,
  CreateCollectionParams,
  PCCNFTClientConfig,
} from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────

/** Generate a deterministic-looking fake base58 public key for mock mode. */
function mockPubkey(): string {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let key = "PCC";
  for (let i = 0; i < 41; i++) {
    key += chars[Math.floor(Math.random() * chars.length)];
  }
  return key;
}

/** Generate a fake transaction signature for mock mode. */
function mockSignature(): string {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let sig = "";
  for (let i = 0; i < 88; i++) {
    sig += chars[Math.floor(Math.random() * chars.length)];
  }
  return sig;
}

// ── Client ───────────────────────────────────────────────────────

export class PCCNFTClient {
  private readonly mock: boolean;
  private readonly rpcUrl: string;

  /** Authority pubkey used for mock mode (simulates the program signer) */
  private readonly authorityPubkey: string;

  // ── Mock state ──────────────────────────────────────────────
  private assets = new Map<string, PCCAsset>();
  private collections = new Map<string, PCCCollection>();
  private mintCounter = 0;

  constructor(config: PCCNFTClientConfig = {}) {
    this.mock = config.mock ?? true;
    this.rpcUrl = config.rpcUrl ?? "https://api.devnet.solana.com";
    this.authorityPubkey = mockPubkey();
  }

  // ── Collection ──────────────────────────────────────────────

  /**
   * Create a new NFT collection.
   *
   * On-chain: creates a PCCCollection PDA owned by the caller's authority.
   * Mock: stores in the in-memory collections map.
   */
  async createCollection(
    params: CreateCollectionParams,
  ): Promise<{ address: string }> {
    if (!this.mock) {
      // Production path: build and send Anchor instruction
      // Instruction layout:
      //   discriminator(8) | name(4+len) | uri(4+len) | max_size(1+4?)
      // PDA seeds: ["pcc_collection", authority.key]
      throw new Error(
        "Production mode not yet implemented — deploy the PCC NFT Anchor program first",
      );
    }

    const address = mockPubkey();
    const collection: PCCCollection = {
      address,
      authority: this.authorityPubkey,
      name: params.name,
      uri: params.uri,
      size: 0,
      maxSize: params.maxSize,
    };
    this.collections.set(address, collection);
    return { address };
  }

  // ── Mint ────────────────────────────────────────────────────

  /**
   * Mint a new PCC asset (NFT).
   *
   * By default, assets are permanently frozen (soulbound).
   * There is zero protocol fee — only Solana rent + compute.
   *
   * On-chain instruction layout:
   *   discriminator(8) | name(4+len) | uri(4+len) | owner(32)
   *   | collection(1+32?) | attributes(4+n*(4+len+4+len))
   *   | permanently_frozen(1)
   * PDA seeds: ["pcc_asset", authority.key, mint_counter(u64)]
   */
  async mint(
    params: MintParams,
  ): Promise<{ address: string; signature: string }> {
    if (!this.mock) {
      throw new Error(
        "Production mode not yet implemented — deploy the PCC NFT Anchor program first",
      );
    }

    const frozen = params.permanentlyFrozen ?? true;
    const address = mockPubkey();
    const signature = mockSignature();

    // Validate collection exists if specified
    if (params.collection) {
      const coll = this.collections.get(params.collection);
      if (!coll) {
        throw new Error(`Collection not found: ${params.collection}`);
      }
      // Check max size
      if (coll.maxSize !== undefined && coll.size >= coll.maxSize) {
        throw new Error(
          `Collection ${params.collection} is full (${coll.maxSize}/${coll.maxSize})`,
        );
      }
    }

    const asset: PCCAsset = {
      address,
      owner: params.owner,
      authority: this.authorityPubkey,
      name: params.name,
      uri: params.uri,
      frozen,
      collection: params.collection ?? null,
      attributes: params.attributes ?? {},
      createdAt: new Date().toISOString(),
    };

    this.assets.set(address, asset);
    this.mintCounter++;

    // Increment collection size
    if (params.collection) {
      const coll = this.collections.get(params.collection)!;
      coll.size++;
    }

    return { address, signature };
  }

  // ── Fetch ───────────────────────────────────────────────────

  /**
   * Fetch a single asset by address.
   * Returns null if the asset does not exist or has been burned.
   */
  async fetchAsset(address: string): Promise<PCCAsset | null> {
    if (!this.mock) {
      throw new Error(
        "Production mode not yet implemented — deploy the PCC NFT Anchor program first",
      );
    }

    return this.assets.get(address) ?? null;
  }

  // ── Update ──────────────────────────────────────────────────

  /**
   * Update an asset's metadata. Only the authority can update.
   *
   * On-chain: checks `asset.authority == signer.key`.
   * Mock: checks the stored authority matches.
   */
  async update(
    params: UpdateParams,
  ): Promise<{ signature: string }> {
    if (!this.mock) {
      throw new Error(
        "Production mode not yet implemented — deploy the PCC NFT Anchor program first",
      );
    }

    const asset = this.assets.get(params.assetAddress);
    if (!asset) {
      throw new Error(`Asset not found: ${params.assetAddress}`);
    }

    // Authority check (in mock, the client IS the authority)
    if (asset.authority !== this.authorityPubkey) {
      throw new Error("Unauthorized: only the authority can update this asset");
    }

    if (params.newName !== undefined) {
      asset.name = params.newName;
    }
    if (params.newUri !== undefined) {
      asset.uri = params.newUri;
    }
    if (params.newAttributes !== undefined) {
      asset.attributes = { ...asset.attributes, ...params.newAttributes };
    }

    return { signature: mockSignature() };
  }

  // ── Burn ────────────────────────────────────────────────────

  /**
   * Burn (destroy) an asset. Only the authority can burn.
   *
   * On-chain: closes the PDA and returns rent to authority.
   * Mock: removes from the in-memory map and decrements collection size.
   */
  async burn(params: BurnParams): Promise<{ signature: string }> {
    if (!this.mock) {
      throw new Error(
        "Production mode not yet implemented — deploy the PCC NFT Anchor program first",
      );
    }

    const asset = this.assets.get(params.assetAddress);
    if (!asset) {
      throw new Error(`Asset not found: ${params.assetAddress}`);
    }

    if (asset.authority !== this.authorityPubkey) {
      throw new Error("Unauthorized: only the authority can burn this asset");
    }

    // Decrement collection size
    if (asset.collection) {
      const coll = this.collections.get(asset.collection);
      if (coll) {
        coll.size = Math.max(0, coll.size - 1);
      }
    }

    this.assets.delete(params.assetAddress);
    return { signature: mockSignature() };
  }

  // ── Transfer (always fails for soulbound) ───────────────────

  /**
   * Attempt to transfer an asset. ALWAYS throws for frozen (soulbound) assets.
   *
   * On-chain: the program checks `asset.frozen` and rejects with
   * ProgramError::AccountFrozen. This method mirrors that behavior.
   */
  async transfer(_assetAddress: string, _newOwner: string): Promise<never> {
    throw new Error("Asset is permanently frozen (soulbound)");
  }

  // ── Queries ─────────────────────────────────────────────────

  /**
   * List all assets owned by a given public key.
   *
   * On-chain: uses getProgramAccounts with owner filter.
   * Mock: linear scan of in-memory map.
   */
  async listByOwner(owner: string): Promise<PCCAsset[]> {
    if (!this.mock) {
      throw new Error(
        "Production mode not yet implemented — deploy the PCC NFT Anchor program first",
      );
    }

    return [...this.assets.values()].filter((a) => a.owner === owner);
  }

  /**
   * List all assets in a given collection.
   *
   * On-chain: uses getProgramAccounts with collection filter.
   * Mock: linear scan of in-memory map.
   */
  async listByCollection(collection: string): Promise<PCCAsset[]> {
    if (!this.mock) {
      throw new Error(
        "Production mode not yet implemented — deploy the PCC NFT Anchor program first",
      );
    }

    return [...this.assets.values()].filter(
      (a) => a.collection === collection,
    );
  }

  // ── Fetch collection ────────────────────────────────────────

  /**
   * Fetch a collection by address.
   * Returns null if the collection does not exist.
   */
  async fetchCollection(address: string): Promise<PCCCollection | null> {
    if (!this.mock) {
      throw new Error(
        "Production mode not yet implemented — deploy the PCC NFT Anchor program first",
      );
    }

    return this.collections.get(address) ?? null;
  }

  // ── Introspection ───────────────────────────────────────────

  /** Total number of assets minted (including burned). */
  get totalMinted(): number {
    return this.mintCounter;
  }

  /** Current number of live (non-burned) assets. */
  get liveAssetCount(): number {
    return this.assets.size;
  }
}
