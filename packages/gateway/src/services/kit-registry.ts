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
 * table or an in-memory cache. Every file is created EXCLUSIVELY (written to a
 * unique temp file, then hard-linked to its final name; EEXIST means another
 * writer got there first) and is never overwritten:
 *   - `<root>/manifests/<shard>/<hex>.json`: the manifest bytes. A second
 *     writer of the same digest must carry identical bytes.
 *   - `<root>/publications/<shard>/<hex>.json`: one publication record per
 *     digest, so the first publisher of a digest wins, across processes too.
 *   - `<root>/quota/<sha256(publisher)>/<n>.json`: the publisher's n-th claim.
 *     Claim n needs claim n - dailyLimit to be at least 24 hours old, so the
 *     rolling quota is exact across processes without a lock (astra k1-511).
 * Before its first write, a registry probes that the volume supports hard
 * links, and refuses to publish (503) if it does not, so a failed link never
 * leaves an orphan manifest (astra k1-511).
 *
 * The kit index is deliberately NOT a capability_template_store row: on master
 * any key can rewrite any template row through the generic template routes
 * (kits D5), and a kit row there would also surface in their list, fork and
 * rate routes.
 *
 * Integrity: every read (get, list, the existence check and the quota count)
 * reads the files afresh; nothing is cached, so another process's publish is
 * seen and a file that stops verifying stops being listed (astra k1-511). A
 * read requires that the bytes hash to their digest, that they are exactly the
 * canonical form of a valid manifest, and that a well-formed publication record
 * names the same digest; anything else is a KitIntegrityError, and a listing
 * skips it. Files are opened with O_NOFOLLOW and every registry directory is
 * checked with lstat, so a symlink planted under the root is refused, never
 * followed (astra k1-511). The configured root itself may be a symlink (a
 * volume mount): it is resolved once.
 *
 * Privacy: the publisher (an email or a wallet) stays in the server-side
 * record; no kit route returns it. The audit log records it as `actor` for
 * authorized audit queries.
 */

import { constants as fsConstants, promises as fs } from "node:fs";
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
import { isValidRegistryDigest } from "./registry-snapshot-store.js";

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
  /** The open flag that refuses a symlink; default fs.constants.O_NOFOLLOW. 0 or absent means the runtime has none (tests). */
  noFollowFlag?: number;
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

const CLAIM_NAME = /^(0|[1-9][0-9]{0,15})\.json$/;
const ClaimSchema = z
  .object({ claimedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s))), kitDigest: z.string().refine(isValidRegistryDigest) })
  .strict();

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

export class KitRegistry {
  private readonly rootDir: string;
  private readonly now: () => Date;
  private readonly dailyLimit: number;
  private readonly audit: (entry: AuditEntry) => void;
  private readonly durable: () => boolean;
  /** O_NOFOLLOW, or 0 when this runtime has none: then the registry refuses to read or publish (astra k1b). */
  private readonly noFollow: number;
  private realRoot: Promise<string> | null = null;
  private linksChecked = false;
  private queue: Promise<unknown> = Promise.resolve();
  private lastSkipped: string[] = [];

  constructor(options: KitRegistryOptions = {}) {
    this.rootDir = options.rootDir ?? resolveKitRegistryRoot();
    this.now = options.now ?? (() => new Date());
    this.dailyLimit = options.dailyLimit ?? configuredDailyLimit();
    this.audit = options.audit ?? ((entry) => auditService.log(entry));
    this.durable = options.durable ?? isDurableKitRoot;
    this.noFollow = options.noFollowFlag ?? fsConstants.O_NOFOLLOW ?? 0;
  }

  /** Digests the latest listing skipped because they failed verification. */
  get skipped(): readonly string[] {
    return this.lastSkipped;
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

  /** Published kits matching every given filter, newest first (then by digest), read from the files now. */
  async list(filter: KitListFilter = {}): Promise<{ kits: KitSummary[]; total: number }> {
    const entries = await this.scan();
    const q = filter.q?.toLowerCase();
    const matching = [...entries.entries()]
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
   * existing publication (created: false), never re-stamps it, and costs no
   * quota.
   */
  publish(input: unknown, publisher: string, options: { forkOf?: string } = {}): Promise<PublishResult> {
    const run = this.queue.then(() => this.publishNow(input, publisher, options));
    // Serialize this process's publishes; a failed one doesn't block the next.
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

    // Read from the files, not a cache: another process may have published it.
    const existing = await this.readVerified(kitDigest);
    if (existing) return { kitDigest, created: false, publishedAt: existing.record.publishedAt };

    await this.ensureLinksSupported();
    const now = this.now();
    await this.claimQuota(publisher, kitDigest, now);
    await this.writeManifestOnce(kitDigest, bytes);
    const { record, created } = await this.writePublicationOnce({
      schema: PUBLICATION_SCHEMA,
      kitDigest,
      publisher,
      publishedAt: now.toISOString(),
    });
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

  // ── Storage: exclusive creates, no symlinks ───────────────────────

  /** The configured root, created if absent and resolved once (the root itself may be a mount symlink). */
  private root(): Promise<string> {
    if (!this.realRoot) {
      this.realRoot = (async () => {
        await fs.mkdir(this.rootDir, { recursive: true });
        return fs.realpath(this.rootDir);
      })();
    }
    return this.realRoot;
  }

  /** `<root>/<area>/<shard>`; every component below the root must be a real directory, never a symlink. */
  private async dirFor(area: string, shard: string, create: boolean): Promise<string | null> {
    const root = await this.root();
    let dir = root;
    for (const part of [area, shard]) {
      dir = path.join(dir, part);
      if (create) await fs.mkdir(dir, { recursive: true }).catch((err) => (errnoOf(err) === "EEXIST" ? undefined : Promise.reject(err)));
      let st;
      try {
        st = await fs.lstat(dir);
      } catch (err) {
        if (errnoOf(err) === "ENOENT" && !create) return null;
        throw err;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) throw new KitIntegrityError(`(${area}/${shard})`, "a registry directory is a symlink or not a directory");
    }
    return dir;
  }

  /** A file's bytes, opened without following a symlink; null when absent. Fails closed on a runtime without O_NOFOLLOW. */
  private async readNoFollow(dir: string, name: string, kitDigest: string): Promise<Uint8Array | null> {
    if (!this.noFollow) throw new KitIntegrityError(kitDigest, "this runtime cannot open a file without following a symlink");
    let handle;
    try {
      handle = await fs.open(path.join(dir, name), fsConstants.O_RDONLY | this.noFollow);
    } catch (err) {
      const code = errnoOf(err);
      if (code === "ENOENT") return null;
      if (code === "ELOOP" || code === "EMLINK") throw new KitIntegrityError(kitDigest, "a registry file is a symlink");
      throw err;
    }
    try {
      if (!(await handle.stat()).isFile()) throw new KitIntegrityError(kitDigest, "a registry file is not a regular file");
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  }

  /** Create `<dir>/<name>` exclusively with `bytes`; false when it already exists. Never overwrites. */
  private async createOnce(dir: string, name: string, bytes: Uint8Array | string): Promise<boolean> {
    const tmp = path.join(dir, `.${name}.tmp-${randomUUID()}`);
    await fs.writeFile(tmp, bytes, { flag: "wx" });
    try {
      await fs.link(tmp, path.join(dir, name));
      return true;
    } catch (err) {
      if (errnoOf(err) === "EEXIST") return false;
      throw err;
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
  }

  /**
   * Probe once, before anything is written, that this runtime and volume can keep the registry
   * write-once and symlink-free: O_NOFOLLOW exists and hard links work. 503 if not (astra k1-511, k1b).
   */
  private async ensureLinksSupported(): Promise<void> {
    if (this.linksChecked) return;
    if (!this.noFollow) {
      throw new KitRegistryError("registry_unsupported_fs", 503, "this runtime has no O_NOFOLLOW, so the registry cannot refuse symlinks");
    }
    const root = await this.root();
    const probe = path.join(root, `.link-probe-${randomUUID()}`);
    try {
      await fs.writeFile(probe, "", { flag: "wx" });
      await fs.link(probe, `${probe}.link`);
    } catch (err) {
      throw new KitRegistryError("registry_unsupported_fs", 503, `the registry's volume cannot create hard links (${errnoOf(err) ?? "error"}), so it cannot publish write-once`);
    } finally {
      await fs.unlink(probe).catch(() => undefined);
      await fs.unlink(`${probe}.link`).catch(() => undefined);
    }
    this.linksChecked = true;
  }

  private static nameOf(kitDigest: string): { shard: string; name: string } {
    const hex = kitDigest.slice("sha256:".length);
    return { shard: hex.slice(0, 2), name: `${hex}.json` };
  }

  /** Store the manifest bytes once; an existing file for the digest must hold exactly these bytes. */
  private async writeManifestOnce(kitDigest: string, bytes: Uint8Array): Promise<void> {
    const { shard, name } = KitRegistry.nameOf(kitDigest);
    const dir = (await this.dirFor("manifests", shard, true))!;
    if (await this.createOnce(dir, name, bytes)) return;
    const stored = await this.readNoFollow(dir, name, kitDigest);
    if (!stored || stored.length !== bytes.length || stored.some((b, i) => b !== bytes[i])) {
      throw new KitIntegrityError(kitDigest, "different bytes are already stored under this digest");
    }
  }

  /** The first record for a digest wins; a later one never overwrites it. */
  private async writePublicationOnce(record: KitPublicationRecord): Promise<{ record: KitPublicationRecord; created: boolean }> {
    const { shard, name } = KitRegistry.nameOf(record.kitDigest);
    const dir = (await this.dirFor("publications", shard, true))!;
    const created = await this.createOnce(dir, name, canonicalize(record));
    const winner = await this.readPublication(record.kitDigest);
    if (!winner) throw new KitIntegrityError(record.kitDigest, "the publication record vanished after it was written");
    return { record: winner, created };
  }

  /**
   * Claim the publisher's next quota slot, exactly across processes: claim n
   * (an exclusive create) needs claim n - dailyLimit to be at least 24 hours
   * old. A claim is spent even if the publish then fails (conservative).
   */
  private async claimQuota(publisher: string, kitDigest: string, now: Date): Promise<void> {
    const owner = createHash("sha256").update(publisher, "utf8").digest("hex");
    const root = await this.root();
    const quotaDir = path.join(root, "quota");
    await fs.mkdir(quotaDir, { recursive: true });
    const dir = (await this.dirFor("quota", owner, true))!;
    const refused = () => new KitRegistryError("publish_quota", 429, `at most ${this.dailyLimit} new kits per publisher per 24 hours`);
    for (let attempt = 0; attempt < 16; attempt++) {
      let next = 0;
      for (const entry of await fs.readdir(dir)) {
        const m = CLAIM_NAME.exec(entry);
        if (m) next = Math.max(next, Number(m[1]) + 1);
      }
      const back = next - this.dailyLimit;
      if (back >= 0) {
        const old = await this.readNoFollow(dir, `${back}.json`, kitDigest);
        let claimedAt = Number.POSITIVE_INFINITY;
        try {
          if (old) claimedAt = Date.parse(ClaimSchema.parse(JSON.parse(strictUtf8.decode(old))).claimedAt);
        } catch {
          // a malformed claim counts as recent: fail closed
        }
        if (!(claimedAt <= now.getTime() - DAY_MS)) throw refused();
      }
      if (await this.createOnce(dir, `${next}.json`, canonicalize({ claimedAt: now.toISOString(), kitDigest }))) return;
      // Another process took claim `next`; look again.
    }
    throw new KitRegistryError("publish_busy", 503, "too many concurrent publishes for this publisher; retry");
  }

  /** The publication record, or null when absent. Throws KitIntegrityError on a malformed record or a symlink. */
  private async readPublication(kitDigest: string): Promise<KitPublicationRecord | null> {
    const { shard, name } = KitRegistry.nameOf(kitDigest);
    const dir = await this.dirFor("publications", shard, false);
    if (!dir) return null;
    const raw = await this.readNoFollow(dir, name, kitDigest);
    if (!raw) return null;
    let text: string;
    let parsed: z.infer<typeof PublicationRecordSchema>;
    try {
      text = strictUtf8.decode(raw);
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
    const { shard, name } = KitRegistry.nameOf(kitDigest);
    const dir = await this.dirFor("manifests", shard, false);
    const bytes = dir ? await this.readNoFollow(dir, name, kitDigest) : null;
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
    // With the hash check above, this also proves computeKitDigest(manifest) === kitDigest.
    if (canonicalize(manifest) !== text) throw new KitIntegrityError(kitDigest, "the stored bytes are not the canonical manifest");
    return { record, manifest };
  }

  /** Every published kit that verifies, read from the files now; failures are skipped and remembered. */
  private async scan(): Promise<Map<string, IndexEntry>> {
    const entries = new Map<string, IndexEntry>();
    const skipped: string[] = [];
    const root = await this.root();
    const area = path.join(root, "publications");
    // The area itself must be a real directory before it is listed: a symlink here is refused, never read (astra k1b).
    let st;
    try {
      st = await fs.lstat(area);
    } catch (err) {
      if (errnoOf(err) === "ENOENT") {
        this.lastSkipped = skipped;
        return entries;
      }
      throw err;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new KitIntegrityError("(publications)", "a registry directory is a symlink or not a directory");
    const shards = await fs.readdir(area);
    for (const shard of shards.sort()) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue;
      let names: string[];
      try {
        const dir = await this.dirFor("publications", shard, false);
        names = dir ? (await fs.readdir(dir)).sort() : [];
      } catch {
        skipped.push(`(publications/${shard})`);
        continue;
      }
      for (const name of names) {
        const match = /^([0-9a-f]{64})\.json$/.exec(name);
        if (!match || !match[1]!.startsWith(shard)) continue;
        const kitDigest = `sha256:${match[1]}`;
        try {
          const entry = await this.readVerified(kitDigest);
          if (entry) entries.set(kitDigest, entry);
        } catch {
          skipped.push(kitDigest);
        }
      }
    }
    this.lastSkipped = skipped;
    return entries;
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
