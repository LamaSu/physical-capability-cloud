/**
 * Registry-snapshot content-addressed store.
 *
 * Durable, WRITE-ONCE, collision-verified persistence for the D2 registry
 * snapshot artifact — the compiler ABI served by
 * `GET /api/compose/registry-snapshot`.
 *
 * Keyed by the inc-1 `registryDigest` (`sha256:<hex>` =
 * `sha256(canonicalize(snapshot))`). The stored value is the EXACT canonical
 * bytes (the digest preimage), so an already-funded job's exact artifact is
 * always recoverable by digest via `GET /api/compose/registry-snapshot/:registryDigest`.
 *
 * Invariants:
 *   - WRITE-ONCE: a digest's bytes are written exactly once. A re-store of the
 *     SAME digest with BYTE-IDENTICAL content is a verified no-op
 *     (`created: false`). A re-store with DIFFERENT bytes under the same digest
 *     is a hard error ({@link RegistrySnapshotCollisionError}) — the store
 *     NEVER overwrites existing bytes.
 *   - CONTENT-ADDRESSED: the caller supplies a consistent `(digest, canonical
 *     bytes)` pair produced by the inc-1 API (`computeRegistrySnapshotDigest` +
 *     `canonicalize`). The store treats the digest as an opaque key and enforces
 *     write-once by byte-identity; it does not itself re-derive the hash (that
 *     correspondence is the route's contract).
 *
 * This is a CONTENT COMMITMENT (integrity + retrievability), NOT an on-chain
 * settlement proof: persisting a snapshot asserts nothing about escrow funding
 * or chain state.
 *
 * Durability: FS-backed, following the gateway's existing content-addressed
 * persistence pattern (LocalBlobBackend in cid-blob-storage.ts — sharded dirs).
 * The storage root resolves Railway-volume-first (the same durability priority
 * as db.ts), so snapshots survive redeploys on Railway.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** A registryDigest is exactly `sha256:` + 64 lowercase hex chars. */
const REGISTRY_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * True when `s` is a syntactically well-formed registryDigest
 * (`sha256:<64 lowercase hex>`). Used to validate the untrusted `:registryDigest`
 * path param before it is turned into a filesystem path (traversal-safe: the hex
 * body has no `/`, `.`, or other path metacharacters).
 */
export function isValidRegistryDigest(s: string): boolean {
  return REGISTRY_DIGEST_RE.test(s);
}

/** Thrown when a WRITE-ONCE digest is re-stored with non-identical bytes. */
export class RegistrySnapshotCollisionError extends Error {
  readonly code = "REGISTRY_SNAPSHOT_DIGEST_COLLISION" as const;
  readonly registryDigest: string;
  constructor(registryDigest: string) {
    super(
      `registry snapshot collision: digest "${registryDigest}" is already stored with ` +
        `different bytes — refusing to overwrite a write-once content-addressed artifact`,
    );
    this.name = "RegistrySnapshotCollisionError";
    this.registryDigest = registryDigest;
  }
}

/** Result of a {@link RegistrySnapshotStore.put}. */
export interface PutRegistrySnapshotResult {
  registryDigest: string;
  /** true = bytes newly written; false = identical bytes already present (verified no-op). */
  created: boolean;
  sizeBytes: number;
  /** Observational only — filesystem write time; never part of the hashed artifact. */
  storedAt: string;
}

export interface IRegistrySnapshotStore {
  /**
   * WRITE-ONCE put. Stores `bytes` under `registryDigest`.
   *   - digest absent → write, `created: true`.
   *   - digest present + byte-identical → verified no-op, `created: false`.
   *   - digest present + different bytes → throw {@link RegistrySnapshotCollisionError}.
   * Throws on a malformed digest.
   */
  put(registryDigest: string, bytes: Uint8Array): Promise<PutRegistrySnapshotResult>;
  /** Fetch the canonical snapshot bytes for a digest, or `null` if absent. */
  get(registryDigest: string): Promise<Uint8Array | null>;
  /** Whether a digest is present in the store. */
  exists(registryDigest: string): Promise<boolean>;
}

/**
 * Resolve the storage root, Railway-volume-first (mirrors db.ts durability
 * priority):
 *   1. PCC_REGISTRY_SNAPSHOT_DIR   — explicit override (tests point this at a temp dir)
 *   2. RAILWAY_VOLUME_MOUNT_PATH/registry-snapshots — durable Railway volume
 *   3. ./data/registry-snapshots   — local-dev default
 */
function resolveRoot(): string {
  if (process.env.PCC_REGISTRY_SNAPSHOT_DIR) {
    return process.env.PCC_REGISTRY_SNAPSHOT_DIR;
  }
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "registry-snapshots");
  }
  return path.join("./data", "registry-snapshots");
}

/**
 * Filesystem-backed registry-snapshot store. One file per digest, sharded by the
 * first two hex chars to avoid flat mega-directories. The file content is exactly
 * the canonical snapshot bytes (the digest preimage) — no wrapping, so the stored
 * artifact is byte-identical to what was hashed.
 */
export class FsRegistrySnapshotStore implements IRegistrySnapshotStore {
  private readonly rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir = rootDir ?? resolveRoot();
  }

  /** `<root>/<hex[0:2]>/<hex>.json` where hex is the digest minus the `sha256:` prefix. */
  private digestPath(registryDigest: string): string {
    const hex = registryDigest.slice("sha256:".length);
    return path.join(this.rootDir, hex.slice(0, 2), `${hex}.json`);
  }

  private assertValidDigest(registryDigest: string): void {
    if (!isValidRegistryDigest(registryDigest)) {
      throw new Error(
        `invalid registryDigest "${registryDigest}" — expected sha256:<64 lowercase hex>`,
      );
    }
  }

  async put(registryDigest: string, bytes: Uint8Array): Promise<PutRegistrySnapshotResult> {
    this.assertValidDigest(registryDigest);
    const filePath = this.digestPath(registryDigest);

    // WRITE-ONCE + collision verification: if the digest is already stored,
    // the incoming bytes MUST be byte-identical, else it is a hard error and we
    // never overwrite.
    if (existsSync(filePath)) {
      const stored = new Uint8Array(await fs.readFile(filePath));
      if (!bytesEqual(stored, bytes)) {
        throw new RegistrySnapshotCollisionError(registryDigest);
      }
      return {
        registryDigest,
        created: false,
        sizeBytes: stored.length,
        storedAt: (await fs.stat(filePath)).ctime.toISOString(),
      };
    }

    // Atomic create: write to a unique temp file then rename onto the final
    // path (same-dir rename is atomic). A concurrent writer of the SAME digest
    // carries identical bytes (content-addressed), so an overwriting rename is
    // harmless.
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${crypto.randomUUID()}`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, filePath);

    return {
      registryDigest,
      created: true,
      sizeBytes: bytes.length,
      storedAt: new Date().toISOString(),
    };
  }

  async get(registryDigest: string): Promise<Uint8Array | null> {
    if (!isValidRegistryDigest(registryDigest)) return null;
    const filePath = this.digestPath(registryDigest);
    if (!existsSync(filePath)) return null;
    return new Uint8Array(await fs.readFile(filePath));
  }

  async exists(registryDigest: string): Promise<boolean> {
    if (!isValidRegistryDigest(registryDigest)) return false;
    return existsSync(this.digestPath(registryDigest));
  }
}

/** Constant-length-independent byte equality (short-circuits on length). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _store: IRegistrySnapshotStore | null = null;

/** Process-wide singleton store (root resolved from env on first use). */
export function getRegistrySnapshotStore(): IRegistrySnapshotStore {
  if (!_store) _store = new FsRegistrySnapshotStore();
  return _store;
}

/**
 * Test helper — reset the singleton, optionally injecting a replacement (e.g. an
 * FsRegistrySnapshotStore pointed at an OS temp dir) so tests never touch a real
 * data directory.
 */
export function _resetRegistrySnapshotStoreForTests(replacement?: IRegistrySnapshotStore): void {
  _store = replacement ?? null;
}
