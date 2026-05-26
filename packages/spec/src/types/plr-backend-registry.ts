/**
 * PLRBackendRegistry — off-chain types for the on-chain PyLabRobot backend
 * authorship registry (PLRBackendRegistry.sol on Base mainnet).
 *
 * Owner doc: `ai/scoping/plr-backend-author-economics-2026-05-25.md`
 * Validated answers: `ai/scoping/plr-answers-validation-2026-05-25.md`
 *
 * Three shapes live here:
 *
 *   1. `BackendRecord`           — exact on-chain BackendRecord struct as
 *                                  returned by getRecord(). Pure data; the
 *                                  CLI / aggregator reads this from RPC.
 *   2. `BackendManifest`         — the signed off-chain JSON authors publish
 *                                  to IPFS describing their backend. The
 *                                  on-chain entry pins its CID.
 *   3. `SignedBackendManifest`   — the same payload + EIP-712 signature.
 *
 * Hashing / signing rules:
 *
 *   - The manifest is canonicalized via @pcc/spec util/canonical (sorted
 *     keys, no whitespace) BEFORE signing or hashing. EIP-712 typed-data
 *     domain is `{name:"PCC-PLRBackendRegistry", version:"1", chainId,
 *     verifyingContract}`; the typed-data struct mirrors `BackendManifest`
 *     one-to-one minus the signature itself.
 *   - The IPFS CID stored on-chain (`manifestCid` field as bytes32) is the
 *     CIDv1 raw multihash of the canonical signed payload. Authors compute
 *     this via {manifestCid}; actual IPFS pinning is the caller's
 *     responsibility (see PLR_BACKEND_AUTHORS.md).
 *
 * Forward compatibility:
 *
 *   The on-chain `delegatedAgentId` is currently `bytes32` storing an
 *   address cast (per validated answer Q3: Phase 1 holds a wallet address;
 *   Phase 2 swaps to ERC-8004 tokenId without schema change). The TS shape
 *   below uses a discriminated union so callers don't accidentally cast.
 */

import { z } from "zod";

// ── On-chain record shape (matches BackendRecord struct in Solidity) ────

/**
 * One-to-one mirror of `PLRBackendRegistry.BackendRecord` returned by
 * `getRecord()`. All fields are read directly from the chain; never
 * computed off-chain.
 *
 * @property modulePath              UTF-8 PLR module path, e.g.
 *                                   "pylabrobot.liquid_handling.backends.hamilton.STAR".
 *                                   Reconstructed from the `BackendRegistered`
 *                                   event because the contract only stores
 *                                   keccak256(modulePath) for gas reasons.
 * @property modulePathKey           keccak256(bytes(modulePath)). The primary
 *                                   key in `records` and `claimed` mappings.
 * @property scheduleHash            sha256 of the off-chain RateSchedule
 *                                   canonical JSON. Validated against
 *                                   RateScheduleRegistry at register-time.
 * @property delegatedAgentId        bytes32 of either:
 *                                     - address cast (Phase 1 default), OR
 *                                     - ERC-8004 tokenId (Phase 2; same field).
 *                                   `0x00…00` = no delegated agent (toggle
 *                                    callable only by the ContributorNFT owner).
 * @property manifestCid             bytes32 of the IPFS CIDv1 raw multihash
 *                                   of the canonical signed manifest. The
 *                                   author may rotate this with
 *                                   `setManifestCid()` without changing rate.
 * @property contributorTokenId      ContributorNFT tokenId minted with
 *                                   role=BACKEND_AUTHOR; the registry queries
 *                                   `ContributorNFT.ownerOf(tokenId)` for the
 *                                   authoritative author address.
 * @property registeredAt            block.timestamp at registration, seconds.
 * @property lastEnabledChange       block.timestamp of most recent
 *                                   `setEnabled()` call, seconds.
 * @property enabled                 True iff `assertEnabled()` succeeds.
 *                                   In-flight escrow continues even when
 *                                   false; only NEW assertions are blocked.
 */
export const BackendRecordSchema = z.object({
  modulePath: z
    .string()
    .regex(/^pylabrobot\.[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/),
  modulePathKey: z.string().regex(/^0x[a-f0-9]{64}$/i),
  scheduleHash: z.string().regex(/^0x[a-f0-9]{64}$/i),
  delegatedAgentId: z.string().regex(/^0x[a-f0-9]{64}$/i),
  manifestCid: z.string().regex(/^0x[a-f0-9]{64}$/i),
  contributorTokenId: z.string().regex(/^[0-9]+$/),
  registeredAt: z.number().int().min(0),
  lastEnabledChange: z.number().int().min(0),
  enabled: z.boolean(),
});
export type BackendRecord = z.infer<typeof BackendRecordSchema>;

// ── Off-chain manifest shape (signed JSON pinned to IPFS) ───────────────

/**
 * One author entry in a BackendManifest. Supports co-author splits via
 * the `groupBps` weight (sum across authors must equal 10_000).
 */
export const BackendManifestAuthorSchema = z.object({
  /** EVM address that receives payouts for this author's share. */
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  /** Display name (optional). */
  name: z.string().optional(),
  /**
   * GitHub handle / ENS name / other social handle for transparency.
   * Informational only; not verified on-chain.
   */
  handle: z.string().optional(),
  /**
   * Basis points (0..10000) of the backend-author payout this address
   * receives. Sum across all `authors[].groupBps` must equal 10000.
   */
  groupBps: z.number().int().min(0).max(10000),
  /** Role within the co-author group. Display-only. */
  role: z
    .enum(["maintainer", "co-author", "occasional-contributor"])
    .optional(),
});
export type BackendManifestAuthor = z.infer<
  typeof BackendManifestAuthorSchema
>;

/**
 * The signed off-chain manifest. Pinned to IPFS; the registry stores only
 * its CID (as bytes32).
 *
 * Default rate preset per validated answer Q1: 10 bps flat-for-life
 * (REVIEW_AT 2026-11-25, six-month review trigger).
 */
export const BackendManifestSchema = z.object({
  /** Always 1 in Phase 1. Bump for schema-breaking changes. */
  schemaVersion: z.literal(1),

  /**
   * Fully-qualified PLR Python module path. Must start with `pylabrobot.`
   * and resolve to a `Backend` subclass in the PLR repo.
   */
  plrModulePath: z
    .string()
    .regex(/^pylabrobot\.[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/),

  /** Semver-range string covering supported PLR releases (e.g. ">=0.2.0 <0.3.0"). */
  plrVersionRange: z.string().min(1),

  /** Python class name (case-sensitive). */
  className: z.string().min(1),

  /**
   * Authors. One entry for single-author backends; up to 8 for co-author
   * splits. `sum(authors[].groupBps) === 10000` is enforced by validation
   * helpers.
   */
  authors: z.array(BackendManifestAuthorSchema).min(1).max(8),

  /**
   * sha256 of the canonical-JSON RateSchedule the author published to
   * RateScheduleRegistry. Must be 0x-prefixed lower-case hex.
   */
  rateScheduleHash: z.string().regex(/^0x[a-f0-9]{64}$/i),

  /**
   * Optional delegated agent identity. Phase 1: hex of an EVM address
   * left-padded to 32 bytes. Phase 2 (Q3 2026): hex of an ERC-8004
   * tokenId (same field; same length).
   */
  delegatedAgentId: z.string().regex(/^0x[a-f0-9]{64}$/i).optional(),

  /** PLR license — MIT for the entire pylabrobot tree as of writing. */
  license: z.literal("MIT"),

  /** Free-form notes (PR links, prior art, migration hints). */
  notes: z.string().max(2000).optional(),

  /** ISO 8601 timestamp when authors[0] signed the manifest. */
  issuedAt: z.string(),
});
export type BackendManifest = z.infer<typeof BackendManifestSchema>;

/**
 * BackendManifest plus the EIP-712 signature by `authors[0].address`.
 *
 * @property manifest The canonical-JSON payload (sorted keys, no whitespace).
 * @property signature  Hex-encoded EIP-712 signature recoverable to
 *                      manifest.authors[0].address.
 * @property signerAddress  The address recovered from `signature`. Helper
 *                          callers may pre-compute this; verifiers MUST
 *                          re-recover and compare against
 *                          manifest.authors[0].address.
 */
export const SignedBackendManifestSchema = z.object({
  manifest: BackendManifestSchema,
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
  signerAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
});
export type SignedBackendManifest = z.infer<
  typeof SignedBackendManifestSchema
>;

// ── EIP-712 domain + types ──────────────────────────────────────────────

/**
 * EIP-712 domain separator inputs. `chainId` and `verifyingContract` are
 * filled in by signBackendManifest from the caller's RegistryConfig.
 */
export interface BackendManifestEip712Domain {
  name: "PCC-PLRBackendRegistry";
  version: "1";
  chainId: number;
  verifyingContract: `0x${string}`;
}

/**
 * EIP-712 typed-data struct mirroring `BackendManifest`. Used directly by
 * viem's `signTypedData` / `recoverTypedDataAddress`. Arrays + optional
 * fields require flattening to a wire-stable shape; the helpers in
 * `util/plr-backend-manifest` produce this representation.
 */
export const BACKEND_MANIFEST_EIP712_TYPES = {
  Author: [
    { name: "address", type: "address" },
    { name: "groupBps", type: "uint16" },
    { name: "name", type: "string" },
    { name: "handle", type: "string" },
    { name: "role", type: "string" },
  ],
  BackendManifest: [
    { name: "schemaVersion", type: "uint8" },
    { name: "plrModulePath", type: "string" },
    { name: "plrVersionRange", type: "string" },
    { name: "className", type: "string" },
    { name: "authors", type: "Author[]" },
    { name: "rateScheduleHash", type: "bytes32" },
    { name: "delegatedAgentId", type: "bytes32" },
    { name: "license", type: "string" },
    { name: "notes", type: "string" },
    { name: "issuedAt", type: "string" },
  ],
} as const;

// ── Errors ──────────────────────────────────────────────────────────────

/**
 * Thrown by the aggregator when `PLRBackendRegistry.assertEnabled()` would
 * revert (the backend's `enabled` flag is false). The aggregator converts
 * this to a 503 backend_disabled error toward the gateway client.
 *
 * Intentionally a plain class (not a Zod-validated shape) — it's an
 * exception used in control flow.
 */
export class BackendDisabledError extends Error {
  readonly modulePath: string;
  readonly lastEnabledChange?: number;
  readonly author?: string;
  readonly manifestCid?: string;

  constructor(opts: {
    modulePath: string;
    lastEnabledChange?: number;
    author?: string;
    manifestCid?: string;
  }) {
    super(
      `PLR backend ${opts.modulePath} is disabled by its author` +
        (opts.author ? ` (${opts.author})` : ""),
    );
    this.name = "BackendDisabledError";
    this.modulePath = opts.modulePath;
    this.lastEnabledChange = opts.lastEnabledChange;
    this.author = opts.author;
    this.manifestCid = opts.manifestCid;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Compute the deterministic `ipId` for a PLR backend per validated answer
 * Q10. Uses abi.encodePacked-equivalent encoding so the off-chain bytes32
 * matches what the on-chain `keccak256(abi.encodePacked(...))` produces.
 *
 * @param modulePath    Fully-qualified PLR module path.
 * @param majorVersion  Semver major (e.g. 0 for pylabrobot 0.x).
 * @returns             0x-prefixed bytes32 of keccak256("pylabrobot:" + path + ":" + major).
 *
 * NOTE: We don't import keccak_256 here to avoid a circular module load on
 * cold start; computation lives in `util/plr-backend-manifest.ts`. This
 * type-level helper exists for documentation only.
 */
export const PLR_BACKEND_IP_ID_PREFIX = "pylabrobot:" as const;

/**
 * Default rate-schedule preset for PLR backend authors per validated
 * answer Q1: 10 bps flat-for-life.
 *
 * REVIEW_AT 2026-11-25 — tag for the 6-month review trigger. If
 * registration adoption is <10 authors at that point, raise the default;
 * if >50, leave as-is. Documented in `docs/PLR_BACKEND_AUTHORS.md`.
 */
export const PLR_DEFAULT_RATE_BPS = 10;
