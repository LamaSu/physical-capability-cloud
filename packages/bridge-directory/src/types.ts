/**
 * Bridge directory types — Phase 1 (JSON) and Phase 2 (on-chain) share this
 * shape. Schema rationale in:
 *   ai/research/bridge-directory-schema-2026-05-26.md
 *
 * On-chain Solidity struct will mirror these field names; enum encodings
 * documented in `status` and `trustTier` below.
 */

/** Lifecycle state for a bridge entry. Once a namespace exists, it never
 * disappears — status can transition to "deprecated" or "removed" but the
 * namespace is permanent (replay-attack analog from ethereum-lists/chains).
 *
 * On-chain encoding: `uint8 status` where
 *   0 = experimental, 1 = active, 2 = deprecated, 3 = removed
 */
export type BridgeStatus =
  | "experimental"
  | "active"
  | "deprecated"
  | "removed";

/** Trust tier of the bridge maintainer / code.
 *
 * On-chain encoding: `uint8 trustTier` where
 *   0 = community, 1 = verified, 2 = audited
 * Numeric encoding in the TS type (0|1|2|3) lets us use it directly as a
 * compact value in JSON or as the on-chain integer when migrating. The
 * spec's JSON Schema accepts only string enums; the JSON file uses strings,
 * but consumer code that needs the integer can derive it via the
 * conversion helpers below.
 */
export type BridgeTrustTier = number; // 0..3

/** Map of EVM chainId -> deployed BackendAuthorRegistry address.
 * Sparse — only present chains pay storage. */
export type RegistryMap = Record<number, `0x${string}`>;

/** Self-declared SLA hint. Off-chain only enforces by social pressure;
 * on-chain version reserves space for future challenge / slashing hooks. */
export interface BridgeSLA {
  /** Target uptime percentage, 0-100. */
  uptime?: number;
  /** p50 response time in milliseconds. */
  responseMs?: number;
  /** Contact channel (URL / email). */
  contact?: string;
}

export interface BridgeEntry {
  // ===== Required =====

  /** Unique key, lowercase alphanum + hyphen, max 31 chars (fits bytes32). */
  namespace: string;

  /** Human-readable display name. */
  name: string;

  /** Canonical GitHub / git URL for source-of-truth code. */
  repoUrl: string;

  /** On-chain auth address for updating this entry (Phase 2). EOA or multisig. */
  maintainerAddress: `0x${string}`;

  /** npm package name OR pypi name for the runtime adapter. */
  adapterPackage: string;

  /** Per-bridge semver. */
  version: string;

  /** Lifecycle state. */
  status: BridgeStatus;

  // ===== Optional (well-known) =====

  /** 0-3 trust tier, PCC-signaled. See BridgeTrustTier docstring. */
  trustTier?: BridgeTrustTier;

  /** Multi-chain registries map (chainId -> address). */
  registries?: RegistryMap;

  /** Pointer to capability schema (IPFS CID, https URL). */
  configSchemaURI?: string;

  /** Self-declared SLA hint. */
  sla?: BridgeSLA;

  /** Human-readable ENS name for the maintainer (cosmetic; auth is by address). */
  maintainerENS?: string;

  /** Capability types this bridge serves. */
  capabilityTypes?: string[];

  /** One-line summary. */
  description?: string;

  /** Free-form escape hatch. Reverse-DNS keyed:
   *   "com.lamasu.firmwareMinVersion": "5.2.1"
   *   "org.pcc.protocolVersion": "v2"
   *
   * Borrowed from Uniswap token-list extensions field.
   */
  extensions?: Record<string, unknown>;
}

export interface BridgeDirectoryVersion {
  /** Bumps on REMOVED / NAMESPACE RENAMED (breaking for consumers). */
  major: number;
  /** Bumps on ADDED bridge (non-breaking). */
  minor: number;
  /** Bumps on metadata-only change to an existing bridge. */
  patch: number;
}

export interface BridgeDirectory {
  /** Display name of this directory snapshot. */
  name: string;
  /** ISO 8601 snapshot generation time. */
  timestamp: string;
  /** Semver of the document. See BridgeDirectoryVersion docstring. */
  version: BridgeDirectoryVersion;
  /** Entries. */
  bridges: BridgeEntry[];
}

export type SourceMode = "json" | "onchain" | "auto";

export interface GetDirectoryOptions {
  /** Default: "json". */
  source?: SourceMode;
  /** Default: "https://capability.network/bridges.json". */
  jsonUrl?: string;
  /** Default: 8453 (Base mainnet). Only used in onchain/auto mode. */
  chainId?: number;
  /** On-chain BridgeDirectory contract address. Required for onchain/auto. */
  directoryAddress?: `0x${string}`;
  /** Inject a custom fetch (testing). */
  fetchImpl?: typeof fetch;
}

// ---- Status / TrustTier integer encodings (for Phase 2 migration) ----

export const STATUS_TO_UINT: Record<BridgeStatus, number> = {
  experimental: 0,
  active: 1,
  deprecated: 2,
  removed: 3,
};

export const UINT_TO_STATUS: Record<number, BridgeStatus> = {
  0: "experimental",
  1: "active",
  2: "deprecated",
  3: "removed",
};

export const DEFAULT_JSON_URL =
  "https://capability.network/bridges.json";
export const DEFAULT_CHAIN_ID = 8453; // Base mainnet
