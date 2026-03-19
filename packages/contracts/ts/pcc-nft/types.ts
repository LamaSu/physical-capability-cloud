/**
 * PCC Native NFT Program Types
 *
 * Custom Solana program specification for soulbound capability certificates.
 * Replaces Metaplex Core (mpl-core) to eliminate the $0.20/mint protocol fee
 * and give PCC full control over the NFT lifecycle.
 *
 * On-chain program layout (Anchor IDL, not yet implemented in Rust):
 *
 *   Account: PCCAsset (PDA seed: ["pcc_asset", authority, mint_counter])
 *   - discriminator: 8 bytes
 *   - owner:       Pubkey  (32 bytes)
 *   - authority:   Pubkey  (32 bytes)
 *   - name:        String  (4 + len bytes)
 *   - uri:         String  (4 + len bytes)
 *   - frozen:      bool    (1 byte)
 *   - collection:  Option<Pubkey> (1 + 32 bytes)
 *   - attributes:  Vec<(String, String)>
 *   - created_at:  i64 (8 bytes, Unix timestamp)
 *
 *   Account: PCCCollection (PDA seed: ["pcc_collection", authority])
 *   - discriminator: 8 bytes
 *   - authority:   Pubkey  (32 bytes)
 *   - name:        String  (4 + len bytes)
 *   - uri:         String  (4 + len bytes)
 *   - size:        u32     (4 bytes, current count)
 *   - max_size:    Option<u32> (1 + 4 bytes)
 *
 *   Instructions:
 *   - create_collection(name, uri, max_size?)
 *   - mint(name, uri, owner, collection?, attributes?, permanently_frozen?)
 *   - update(asset, new_name?, new_uri?, new_attributes?)
 *   - burn(asset)
 *   - transfer(asset, new_owner) — always fails if frozen
 */

// ── Asset ────────────────────────────────────────────────────────

export interface PCCAsset {
  /** Solana public key (base58) of the asset account */
  address: string;
  /** Current owner public key */
  owner: string;
  /** Update authority — the only key allowed to update/burn */
  authority: string;
  /** Human-readable name */
  name: string;
  /** Off-chain metadata URI (IPFS, Arweave, HTTPS) */
  uri: string;
  /** Whether the asset is permanently frozen (soulbound) */
  frozen: boolean;
  /** Optional collection this asset belongs to */
  collection: string | null;
  /** Key-value attribute pairs stored on-chain */
  attributes: Record<string, string>;
  /** ISO 8601 creation timestamp */
  createdAt: string;
}

// ── Collection ───────────────────────────────────────────────────

export interface PCCCollection {
  /** Solana public key (base58) of the collection account */
  address: string;
  /** Update authority for the collection */
  authority: string;
  /** Human-readable collection name */
  name: string;
  /** Off-chain metadata URI */
  uri: string;
  /** Number of assets currently in this collection */
  size: number;
  /** Maximum number of assets allowed (undefined = unlimited) */
  maxSize: number | undefined;
}

// ── Instruction Params ───────────────────────────────────────────

export interface CreateCollectionParams {
  /** Collection display name */
  name: string;
  /** Metadata URI */
  uri: string;
  /** Maximum collection size (optional — omit for unlimited) */
  maxSize?: number;
}

export interface MintParams {
  /** Asset display name */
  name: string;
  /** Metadata URI */
  uri: string;
  /** Owner public key (base58) */
  owner: string;
  /** Collection address to add this asset to (optional) */
  collection?: string;
  /** On-chain attributes as key-value pairs */
  attributes?: Record<string, string>;
  /**
   * If true, asset is permanently frozen at mint time (soulbound).
   * Default: true — soulbound by default for capability certificates.
   */
  permanentlyFrozen?: boolean;
}

export interface UpdateParams {
  /** Address of the asset to update */
  assetAddress: string;
  /** New name (optional) */
  newName?: string;
  /** New metadata URI (optional) */
  newUri?: string;
  /** New/updated attributes — merged with existing (optional) */
  newAttributes?: Record<string, string>;
}

export interface BurnParams {
  /** Address of the asset to destroy */
  assetAddress: string;
}

// ── Client config ────────────────────────────────────────────────

export interface PCCNFTClientConfig {
  /** Solana RPC URL (default: devnet) */
  rpcUrl?: string;
  /**
   * Use mock mode with in-memory storage (default: true).
   * When false, would call the deployed Anchor program.
   */
  mock?: boolean;
}
