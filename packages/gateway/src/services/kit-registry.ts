/**
 * Capability Kit registry (kits K1 slice 1; ledger R5/R6, row 6: "no
 * in-memory-only production catalog").
 *
 * A kit version is the EXACT canonical bytes of its normalized manifest
 * (@pcc/spec capability-kit.ts), keyed by kitDigest = sha256 of those bytes.
 * Who published it and when is registry metadata, stamped by the server and
 * never part of the hashed bytes.
 *
 * Authority lives in write-once files on the durable volume, never in a mutable
 * table:
 *   - `<root>/manifests/`: the manifest bytes, through FsRegistrySnapshotStore
 *     (write-once, collision-verified; concurrent writers of one digest carry
 *     identical bytes).
 *   - `<root>/publications/`: one publication record per digest, written with
 *     an EXCLUSIVE create (link from a temp file), so the first publisher of a
 *     digest wins even under concurrent publishes, and a record is never
 *     overwritten. FsRegistrySnapshotStore's check-then-rename is safe only for
 *     identical bytes; two first publishers write different records.
 * The kit index is deliberately NOT a capability_template_store row: on master
 * any key can rewrite any template row through the generic template routes
 * (kits D5), and a kit row there would also surface in their list, fork and
 * rate routes.
 *
 * Integrity: every `get` re-reads the stored bytes and requires that they hash
 * to their digest, that they are exactly the canonical form of a valid
 * manifest, and that a well-formed publication record names the same digest.
 * Anything else throws KitIntegrityError: the registry never serves unverified
 * bytes. The in-memory index is a cache rebuilt from the files at first use;
 * an entry that fails verification is skipped (and counted), never listed.
 *
 * Privacy: the publisher (an email or a wallet) stays in the server-side
 * record. Nothing this module returns to a route carries it.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  canonicalize,
  computeKitDigest,
  normalizeKitManifest,
  validateKitCompleteness,
  type CapabilityKitManifestV1,
} from "@pcc/spec";
import { auditService, type AuditEntry } from "./audit-service.js";
import { FsRegistrySnapshotStore, isValidRegistryDigest, type IRegistrySnapshotStore } from "./registry-snapshot-store.js";

/** Largest canonical manifest the registry stores. */
export const MAX_KIT_MANIFEST_BYTES = 256 * 1024;
/** Default number of NEW kits one publisher may create in a rolling 24 hours. */
export const DEFAULT_KIT_PUBLISH_DAILY_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLICATION_SCHEMA = "pcc.kit-publication.v1" as const;

/** The server-side publication record. Never returned by a route. */
export interface KitPublicationRecord {
  schema: typeof PUBLICATION_SCHEMA;
  kitDigest: string;
  publisher: string;
  publishedAt: string;
}

const PublicationRecordSchema = z
  .object({
    schema: z.literal(PUBLICATION_SCHEMA),
    kitDigest: z.string().refine(isValidRegistryDigest),
    publisher: z.string().min(1).max(512),
    publishedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s),
  })
  .strict();

/** A verified kit as the routes return it: content and publication time, no publisher. */
export interface KitView {
  kitDigest: string;
  manifest: CapabilityKitManifestV1;
  publishedAt: string;
}

/** One row of the listing. */
export interface KitSummary {
  kitDigest: string;
  name: string;
  version: string;
  parentKitDigest: string | null;
  csdUrls: string[];
  compatibility?: CapabilityKitManifestV1["compatibility"];
  declaredAssuranceTiers?: number[];
  publishedAt: string;
}

export interface KitListFilter {
  csdUrl?: string;
  deviceFamily?: string;
  interface?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface PublishResult {
  kitDigest: string;
  /** True when this call created the publication; false when the digest was already published. */
  created: boolean;
  publishedAt: string;
}

/** A request the registry refuses, with the HTTP status a route should answer. */
export class KitRegistryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "KitRegistryError";
  }
}

/** Stored bytes or records that fail verification. The registry fails closed on these. */
export class KitIntegrityError extends Error {
  readonly code = "kit_integrity_failure" as const;
  constructor(
    readonly kitDigest: string,
    reason: string,
  ) {
    super(`kit ${kitDigest}: ${reason}`);
    this.name = "KitIntegrityError";
  }
}

export interface KitRegistryOptions {
  /** Root directory; default resolveKitRegistryRoot(). */
  rootDir?: string;
  /** Clock; default the system clock. */
  now?: () => Date;
  /** New kits per publisher per rolling 24 h; default PCC_KIT_PUBLISH_DAILY_LIMIT or 20. */
  dailyLimit?: number;
  /** Audit sink; default auditService.log. */
  audit?: (entry: AuditEntry) => void;
  /** Whether the root is durable enough to publish to; default isDurableKitRoot(). */
  durable?: () => boolean;
}

/**
 * The registry root, durable-volume first:
 *   1. PCC_KIT_REGISTRY_DIR (explicit; tests point it at a temp dir)
 *   2. $RAILWAY_VOLUME_MOUNT_PATH/kit-registry (the durable Railway volume)
 *   3. ./data/kit-registry (local development)
 */
export function resolveKitRegistryRoot(): string {
  if (process.env.PCC_KIT_REGISTRY_DIR) return process.env.PCC_KIT_REGISTRY_DIR;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "kit-registry");
  return path.join("./data", "kit-registry");
}

/** In production, publishing needs a durable root: the Railway volume or an explicit directory. */
export function isDurableKitRoot(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.PCC_KIT_REGISTRY_DIR);
}

function configuredDailyLimit(): number {
  const raw = process.env.PCC_KIT_PUBLISH_DAILY_LIMIT;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_KIT_PUBLISH_DAILY_LIMIT;
}

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

interface IndexEntry {
  record: KitPublicationRecord;
  manifest: CapabilityKitManifestV1;
}

export class KitRegistry {
  private readonly manifests: IRegistrySnapshotStore;
  private readonly publicationsDir: string;
  private readonly now: () => Date;
  private readonly dailyLimit: number;
  private readonly audit: (entry: AuditEntry) => void;
  private readonly durable: () => boolean;
  private readonly index = new Map<string, IndexEntry>();
  private loading: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Digests skipped at load because they failed verification. */
  readonly skipped: string[] = [];

  constructor(options: KitRegistryOptions = {}) {
    const root = options.rootDir ?? resolveKitRegistryRoot();
    this.manifests = new FsRegistrySnapshotStore(path.join(root, "manifests"));
    this.publicationsDir = path.join(root, "publications");
    this.now = options.now ?? (() => new Date());
    this.dailyLimit = options.dailyLimit ?? configuredDailyLimit();
    this.audit = options.audit ?? ((entry) => auditService.log(entry));
    this.durable = options.durable ?? isDurableKitRoot;
  }

  // ── Reads ──────────────────────────────────────────────────────────

  /** The verified kit, or null when the digest is not published. Throws KitIntegrityError on bad bytes. */
  async get(kitDigest: string): Promise<KitView | null> {
    if (!isValidRegistryDigest(kitDigest)) {
      throw new KitRegistryError("invalid_digest", 400, "a kit digest is sha256: followed by 64 lowercase hex digits");
    }
    const entry = await this.readVerified(kitDigest);
    return entry ? { kitDigest, manifest: entry.manifest, publishedAt: entry.record.publishedAt } : null;
  }

  /** Published kits matching every given filter, newest first (then by digest). */
  async list(filter: KitListFilter = {}): Promise<{ kits: KitSummary[]; total: number }> {
    await this.ensureLoaded();
    const q = filter.q?.toLowerCase();
    const matching = [...this.index.entries()]
      .filter(([, { manifest: m }]) => {
        if (filter.csdUrl !== undefined && !m.capabilities.some((c) => c.csdUrl === filter.csdUrl)) return false;
        if (filter.deviceFamily !== undefined && !(m.compatibility?.deviceFamilies ?? []).includes(filter.deviceFamily)) return false;
        if (filter.interface !== undefined && !(m.compatibility?.interfaces ?? []).includes(filter.interface)) return false;
        if (q !== undefined && !m.name.toLowerCase().includes(q) && !(m.description ?? "").toLowerCase().includes(q)) return false;
        return true;
      })
      .sort(([da, a], [db, b]) => {
        const byTime = Date.parse(b.record.publishedAt) - Date.parse(a.record.publishedAt);
        return byTime !== 0 ? byTime : da < db ? -1 : da > db ? 1 : 0;
      });
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    return { kits: matching.slice(offset, offset + limit).map(([d, e]) => summarize(d, e)), total: matching.length };
  }

  /** The recorded publisher of a published digest. Server-side only (ownership checks, audits). */
  async publisherOf(kitDigest: string): Promise<string | null> {
    if (!isValidRegistryDigest(kitDigest)) return null;
    return (await this.readVerified(kitDigest))?.record.publisher ?? null;
  }

  // ── Publish ────────────────────────────────────────────────────────

  /**
   * Publish a complete kit for `publisher` (the authenticated principal). With
   * `forkOf`, the manifest's parentKitDigest must equal it and that kit must
   * exist. Re-publishing an existing digest is not an error: it returns the
   * existing publication (created: false) and never re-stamps it.
   */
  publish(input: unknown, publisher: string, options: { forkOf?: string } = {}): Promise<PublishResult> {
    const run = this.queue.then(() => this.publishNow(input, publisher, options));
    // Serialize publishes in this process (quota and index stay exact); a failed one doesn't block the next.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async publishNow(input: unknown, publisher: string, options: { forkOf?: string }): Promise<PublishResult> {
    if (typeof publisher !== "string" || publisher.trim() === "") {
      throw new KitRegistryError("missing_identity", 401, "publishing a kit needs an authenticated principal");
    }
    if (!this.durable()) {
      throw new KitRegistryError("registry_not_durable", 503, "the kit registry has no durable storage in this environment");
    }
    let manifest: CapabilityKitManifestV1;
    try {
      manifest = normalizeKitManifest(input);
    } catch (err) {
      const issues =
        err instanceof z.ZodError ? err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) : [{ path: "", message: "not a manifest" }];
      throw new KitRegistryError("invalid_manifest", 400, "the manifest is not a valid pcc.capability-kit/v1", { issues });
    }
    const completeness = validateKitCompleteness(manifest);
    if (!completeness.complete) {
      throw new KitRegistryError("incomplete_kit", 422, "only a complete, reusable kit can be published", { missing: completeness.missing });
    }
    const text = canonicalize(manifest);
    const bytes = utf8.encode(text);
    if (bytes.length > MAX_KIT_MANIFEST_BYTES) {
      throw new KitRegistryError("manifest_too_large", 413, `a kit manifest may be at most ${MAX_KIT_MANIFEST_BYTES} bytes`);
    }
    const kitDigest = await computeKitDigest(manifest);
    if (kitDigest !== sha256Digest(bytes)) throw new KitIntegrityError(kitDigest, "the digest does not cover the stored bytes");

    if (options.forkOf !== undefined) {
      if (!isValidRegistryDigest(options.forkOf)) {
        throw new KitRegistryError("invalid_digest", 400, "a kit digest is sha256: followed by 64 lowercase hex digits");
      }
      if (!(await this.readVerified(options.forkOf))) throw new KitRegistryError("not_found", 404, "no published kit has that digest");
      if (manifest.parentKitDigest !== options.forkOf) {
        throw new KitRegistryError("parent_mismatch", 400, "a fork's parentKitDigest must name the kit it forks");
      }
    }
    if (manifest.parentKitDigest !== null && !(await this.readVerified(manifest.parentKitDigest))) {
      throw new KitRegistryError("unknown_parent", 422, "parentKitDigest names no published kit");
    }

    await this.ensureLoaded();
    const existing = this.index.get(kitDigest);
    if (existing) return { kitDigest, created: false, publishedAt: existing.record.publishedAt };

    const now = this.now();
    const since = now.getTime() - DAY_MS;
    let recent = 0;
    for (const { record } of this.index.values()) {
      if (record.publisher === publisher && Date.parse(record.publishedAt) > since) recent++;
    }
    if (recent >= this.dailyLimit) {
      throw new KitRegistryError("publish_quota", 429, `at most ${this.dailyLimit} new kits per publisher per 24 hours`);
    }

    await this.manifests.put(kitDigest, bytes);
    const { record, created } = await this.writePublicationOnce({
      schema: PUBLICATION_SCHEMA,
      kitDigest,
      publisher,
      publishedAt: now.toISOString(),
    });
    this.index.set(kitDigest, { record, manifest });
    if (created) {
      this.audit({
        eventType: options.forkOf !== undefined ? "kit.forked" : "kit.published",
        actor: publisher,
        resourceType: "capability-kit",
        resourceId: kitDigest,
        action: options.forkOf !== undefined ? "fork" : "publish",
        metadata: { parentKitDigest: manifest.parentKitDigest },
      });
    }
    return { kitDigest, created, publishedAt: record.publishedAt };
  }

  // ── Storage ────────────────────────────────────────────────────────

  private publicationPath(kitDigest: string): string {
    const hex = kitDigest.slice("sha256:".length);
    return path.join(this.publicationsDir, hex.slice(0, 2), `${hex}.json`);
  }

  /** Exclusive create: the first record for a digest wins; a later one never overwrites it. */
  private async writePublicationOnce(record: KitPublicationRecord): Promise<{ record: KitPublicationRecord; created: boolean }> {
    const file = this.publicationPath(record.kitDigest);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${randomUUID()}`;
    await fs.writeFile(tmp, canonicalize(record), { flag: "wx" });
    let created = true;
    try {
      await fs.link(tmp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      created = false;
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
    const winner = await this.readPublication(record.kitDigest);
    if (!winner) throw new KitIntegrityError(record.kitDigest, "the publication record vanished after it was written");
    return { record: winner, created };
  }

  /** The publication record, or null when absent. Throws KitIntegrityError on a malformed record. */
  private async readPublication(kitDigest: string): Promise<KitPublicationRecord | null> {
    let text: string;
    try {
      text = strictUtf8.decode(await fs.readFile(this.publicationPath(kitDigest)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new KitIntegrityError(kitDigest, "the publication record is unreadable");
    }
    let parsed: z.infer<typeof PublicationRecordSchema>;
    try {
      parsed = PublicationRecordSchema.parse(JSON.parse(text));
    } catch {
      throw new KitIntegrityError(kitDigest, "the publication record is malformed");
    }
    if (parsed.kitDigest !== kitDigest || canonicalize(parsed) !== text) {
      throw new KitIntegrityError(kitDigest, "the publication record does not match its digest");
    }
    return parsed;
  }

  /** Read and verify one published kit; null when it is not published. */
  private async readVerified(kitDigest: string): Promise<IndexEntry | null> {
    const record = await this.readPublication(kitDigest);
    if (!record) return null;
    const bytes = await this.manifests.get(kitDigest);
    if (!bytes) throw new KitIntegrityError(kitDigest, "the manifest bytes are missing");
    if (sha256Digest(bytes) !== kitDigest) throw new KitIntegrityError(kitDigest, "the manifest bytes do not hash to their digest");
    let manifest: CapabilityKitManifestV1;
    let text: string;
    try {
      text = strictUtf8.decode(bytes);
      manifest = normalizeKitManifest(JSON.parse(text));
    } catch {
      throw new KitIntegrityError(kitDigest, "the stored manifest is not a valid kit");
    }
    if (canonicalize(manifest) !== text) throw new KitIntegrityError(kitDigest, "the stored bytes are not the canonical manifest");
    if ((await computeKitDigest(manifest)) !== kitDigest) throw new KitIntegrityError(kitDigest, "the manifest's digest differs");
    return { record, manifest };
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loading) this.loading = this.loadIndex();
    return this.loading;
  }

  /** Rebuild the index from the publication records; an entry that fails verification is skipped. */
  private async loadIndex(): Promise<void> {
    let shards: string[];
    try {
      shards = await fs.readdir(this.publicationsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const shard of shards.sort()) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue;
      for (const name of (await fs.readdir(path.join(this.publicationsDir, shard))).sort()) {
        const match = /^([0-9a-f]{64})\.json$/.exec(name);
        if (!match || !match[1]!.startsWith(shard)) continue;
        const kitDigest = `sha256:${match[1]}`;
        try {
          const entry = await this.readVerified(kitDigest);
          if (entry) this.index.set(kitDigest, entry);
        } catch {
          this.skipped.push(kitDigest);
        }
      }
    }
  }
}

function summarize(kitDigest: string, { record, manifest: m }: IndexEntry): KitSummary {
  return {
    kitDigest,
    name: m.name,
    version: m.version,
    parentKitDigest: m.parentKitDigest,
    csdUrls: m.capabilities.map((c) => c.csdUrl),
    ...(m.compatibility !== undefined ? { compatibility: m.compatibility } : {}),
    ...(m.declaredAssuranceTiers !== undefined ? { declaredAssuranceTiers: m.declaredAssuranceTiers } : {}),
    publishedAt: record.publishedAt,
  };
}

// ── Process singleton ──────────────────────────────────────────────

let registry: KitRegistry | null = null;

/** The process-wide registry (root resolved from the environment on first use). */
export function getKitRegistry(): KitRegistry {
  if (!registry) registry = new KitRegistry();
  return registry;
}

/** Test helper: reset the singleton, optionally to a replacement rooted in a temp dir. */
export function _resetKitRegistryForTests(replacement?: KitRegistry): void {
  registry = replacement ?? null;
}
