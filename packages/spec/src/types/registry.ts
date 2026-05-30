/**
 * Registry — Primitive 3 of RFC-001-work-primitives.
 *
 * Generalized content-addressed reference data the VerificationProgram can
 * read at attestation time. Replaces the ad-hoc per-domain pattern (rate
 * schedules, contributor NFTs, canonical-id library) with a single primitive
 * that hosts many registries by id.
 *
 * Two shapes:
 *   set — membership only (e.g., approved-lots, certified-inspectors)
 *   map — key → value (e.g., permit-db: address → permitNumber)
 *
 * Each Registry has many Snapshots over time, each pinned by snapshotHash.
 * Predicates pin a specific snapshotHash so verification is reproducible —
 * the verifier can re-evaluate two years later and get the same answer.
 *
 * Hash discipline:
 *   For shape=set:
 *     snapshotHash = sha256(canonical_json({ entries: lex-sorted }))
 *   For shape=map:
 *     snapshotHash = sha256(canonical_json({ entries: sorted-by-key }))
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "../util/canonical.js";

const HEX_HASH = /^0x[a-f0-9]{64}$/i;
const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SIGNATURE = /^0x[a-fA-F0-9]+$/;

// ---------------------------------------------------------------------------
// Shape & descriptor
// ---------------------------------------------------------------------------

export const RegistryShapeSchema = z.enum(["set", "map"]);
export type RegistryShape = z.infer<typeof RegistryShapeSchema>;

export const RegistryDescriptorSchema = z.object({
  /**
   * Unique identifier. Convention: dot-segmented, ending in a version,
   * e.g. "permit-db.us.california.contra-costa.v1",
   * "fda.approved-lots.acn-grade.v3", "pcc-driver-licenses.us.v2".
   */
  registryId: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9.\-]*$/, "lowercase, dot/dash-segmented"),
  /** Set membership or key-value map. */
  shape: RegistryShapeSchema,
  /** Authority that may publish snapshots — wallet or multisig. */
  publisher: z.string().regex(ETH_ADDRESS),
  /** Schema for entries when shape=map. Optional for shape=set. */
  valueSchema: z.record(z.unknown()).optional(),
  /** Description for humans + agent surfaces. */
  description: z.string().max(500),
});
export type RegistryDescriptor = z.infer<typeof RegistryDescriptorSchema>;

// ---------------------------------------------------------------------------
// Entry shapes
// ---------------------------------------------------------------------------

/** A `set` entry is an opaque string. Convention: lower-cased canonical form. */
export const SetEntrySchema = z.string().min(1);

/** A `map` entry is a (key, value) where value is JSON. */
export const MapEntrySchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
});
export type MapEntry = z.infer<typeof MapEntrySchema>;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export const RegistrySnapshotSchema = z.object({
  registryId: z.string().min(1),
  /** Monotonically increasing version. */
  version: z.number().int().min(1),
  /** Self-reference: sha256(canonical_json(entries-in-canonical-order)). */
  snapshotHash: z.string().regex(HEX_HASH),
  /**
   * Where the entries live. Inline for small registries; IPFS for large.
   * Either way, the bytes hash to `snapshotHash`.
   */
  entriesLocator: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("inline"),
      entries: z.array(z.unknown()),
    }),
    z.object({
      kind: z.literal("ipfs"),
      cid: z.string().min(1),
      /** How many entries are in the snapshot — for sanity-check on retrieval. */
      entryCount: z.number().int().min(0),
    }),
  ]),
  /** Publisher's signature over `snapshotHash`. */
  publisherSignature: z.string().regex(SIGNATURE),
  /** Unix seconds. */
  publishedAt: z.number().int().min(0),
});
export type RegistrySnapshot = z.infer<typeof RegistrySnapshotSchema>;

// ---------------------------------------------------------------------------
// Canonical hashing
// ---------------------------------------------------------------------------

/**
 * Compute the snapshotHash for a set-shaped registry. Entries are
 * lower-cased and lex-sorted before hashing so that the same set always
 * produces the same hash regardless of insertion order or case.
 */
export function computeSetSnapshotHash(entries: string[]): `0x${string}` {
  const normalized = [...new Set(entries.map((e) => e.toLowerCase()))].sort();
  const canonical = canonicalize({ entries: normalized });
  const hex = createHash("sha256").update(canonical).digest("hex");
  return `0x${hex}` as `0x${string}`;
}

/**
 * Compute the snapshotHash for a map-shaped registry. Entries are sorted
 * by key (lower-cased) before hashing so the same key→value mapping always
 * produces the same hash regardless of insertion order. Duplicate keys
 * throw — the publisher must dedupe upstream.
 */
export function computeMapSnapshotHash(entries: MapEntry[]): `0x${string}` {
  const seen = new Set<string>();
  const normalized = entries.map((e) => {
    const key = e.key.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Map registry has duplicate key: ${e.key}`);
    }
    seen.add(key);
    return { key, value: e.value };
  });
  normalized.sort((a, b) => a.key.localeCompare(b.key));
  const canonical = canonicalize({ entries: normalized });
  const hex = createHash("sha256").update(canonical).digest("hex");
  return `0x${hex}` as `0x${string}`;
}

/**
 * Lookup helpers — used by the VerificationProgram evaluator at predicate
 * eval time. Both verify the snapshot's hash against the pinned hash before
 * answering, so a tampered snapshot fails closed.
 */
export function verifySnapshotHash(
  snapshot: RegistrySnapshot,
  shape: RegistryShape,
  inlineEntries?: unknown[],
): void {
  const entries =
    snapshot.entriesLocator.kind === "inline"
      ? snapshot.entriesLocator.entries
      : (inlineEntries ?? null);
  if (entries === null) {
    throw new Error(
      `Cannot verify snapshot hash for IPFS-backed registry without resolved entries`,
    );
  }
  const recomputed =
    shape === "set"
      ? computeSetSnapshotHash(entries as string[])
      : computeMapSnapshotHash(entries as MapEntry[]);
  if (recomputed.toLowerCase() !== snapshot.snapshotHash.toLowerCase()) {
    throw new Error(
      `Registry snapshot hash mismatch: claimed ${snapshot.snapshotHash}, recomputed ${recomputed}`,
    );
  }
}

/**
 * Membership check for a set-shaped registry.
 * Snapshot MUST be pre-verified (callers should `verifySnapshotHash` first).
 */
export function setContains(
  snapshot: RegistrySnapshot,
  candidate: string,
  inlineEntries?: string[],
): boolean {
  const entries =
    snapshot.entriesLocator.kind === "inline"
      ? (snapshot.entriesLocator.entries as string[])
      : (inlineEntries ?? null);
  if (entries === null) {
    throw new Error(`Cannot query IPFS-backed registry without resolved entries`);
  }
  const target = candidate.toLowerCase();
  return entries.some((e) => e.toLowerCase() === target);
}

/**
 * Lookup for a map-shaped registry. Returns undefined if the key is absent.
 */
export function mapGet(
  snapshot: RegistrySnapshot,
  key: string,
  inlineEntries?: MapEntry[],
): unknown | undefined {
  const entries =
    snapshot.entriesLocator.kind === "inline"
      ? (snapshot.entriesLocator.entries as MapEntry[])
      : (inlineEntries ?? null);
  if (entries === null) {
    throw new Error(`Cannot query IPFS-backed registry without resolved entries`);
  }
  const target = key.toLowerCase();
  const hit = entries.find((e) => e.key.toLowerCase() === target);
  return hit?.value;
}
