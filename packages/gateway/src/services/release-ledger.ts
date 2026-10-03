/**
 * Public demand release ledger (kits K4a; PX-13: "release each period exactly
 * once"). painpoints' buildPublicRelease (#365, @pcc/spec kit-demand.ts) builds
 * one PublicOpportunityRelease per closed calendar month. A record's digest
 * proves it is unmodified since it was built, but not who built it or that its
 * period was released only once. That is the weakest link astra named on #397
 * (112e), and #397's demandAggregatesFromRelease says the caller must take the
 * record from this ledger.
 *
 * One write-once file per period, on the Kit registry's durable volume (K1),
 * with no table and no cache:
 *   - `<root>/releases/<YYYY-MM>.json`: the canonical JSON of a ledger entry
 *     {schema, period, publishedAt, publisher, approvedSet, release}.
 *   - It is created EXCLUSIVELY, as K1 creates its files: a unique temp file is
 *     hard-linked to the final name, and EEXIST means another writer got there
 *     first. It is never overwritten. The same record again is answered
 *     `created: false`; a DIFFERENT record for a released period is refused
 *     (409 release_period_taken), so a period is released exactly once, across
 *     processes too.
 *   - `approvedSet` is the approved-set snapshot the record was built with: the
 *     public capability urls, deduplicated and sorted by code unit, exactly
 *     what #397's approvedSetDigest commits to. A consumer can therefore verify
 *     the record against the set approved at release time.
 *
 * Verification is #397's own: before writing, and again on every read, the
 * record must pass demandAggregatesFromRelease(release, approvedSet, ...).
 * That checks the strict record schema and #365's single policy, a closed
 * period, the digest over the other fields, the approved-set digest,
 * membership, canonical order, and every aggregate as a valid demand_aggregate.
 * A read also requires strict UTF-8, the exact canonical bytes, and the
 * period in the file name, the entry and the record to agree. Anything else is
 * a ReleaseIntegrityError: a read refuses it and a listing skips it.
 *
 * Files are opened with O_NOFOLLOW and the `releases` directory is checked with
 * lstat, so a symlink planted under the root is refused, never followed. Before
 * its first write, a ledger probes that the runtime has O_NOFOLLOW and the
 * volume supports hard links, and otherwise refuses to publish (503), as K1
 * does (astra k1-511, k1b).
 *
 * Publishing is a server-side call, never a route: the producer that builds a
 * release calls `publish`. The publisher is kept in the entry and in the audit
 * log; no read returns it.
 */

import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  canonicalize,
  compareCodeUnits,
  demandAggregatesFromRelease,
  isPublicCapabilityUrl,
  type PublicOpportunityRelease,
} from "@pcc/spec";
import { auditService, type AuditEntry } from "./audit-service.js";
import { isDurableKitRoot, resolveKitRegistryRoot } from "./kit-registry.js";

export const RELEASE_LEDGER_ENTRY_SCHEMA = "pcc.release-ledger-entry.v1" as const;

/** Largest canonical ledger entry the ledger stores or reads. */
export const MAX_RELEASE_ENTRY_BYTES = 1024 * 1024;

const AREA = "releases";
const PERIOD = /^[0-9]{4}-(?:0[1-9]|1[0-2])$/;
const ENTRY_NAME = /^([0-9]{4}-(?:0[1-9]|1[0-2]))\.json$/;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** A request the ledger refuses, with the HTTP status a caller should answer. */
export class ReleaseLedgerError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ReleaseLedgerError";
  }
}

/** A stored entry that fails verification. It is never served. */
export class ReleaseIntegrityError extends Error {
  readonly code = "release_integrity_failure";
  constructor(
    readonly period: string,
    reason: string,
  ) {
    super(`release ledger entry ${period}: ${reason}`);
    this.name = "ReleaseIntegrityError";
  }
}

/** One verified release, as every read returns it. The publisher is never included. */
export interface ReleaseView {
  period: string;
  release: PublicOpportunityRelease;
  /** The approved-set snapshot the release was built with. */
  approvedSet: string[];
  publishedAt: string;
}

/** One row of the listing. */
export interface ReleaseSummary {
  period: string;
  digest: string;
  aggregateCount: number;
  publishedAt: string;
}

export interface ReleasePublishResult {
  period: string;
  digest: string;
  /** True when this call wrote the period's entry; false when that same record was already released. */
  created: boolean;
  publishedAt: string;
}

export interface ReleaseLedgerOptions {
  /** Root directory; default resolveKitRegistryRoot(), the Kit registry's durable root. */
  rootDir?: string;
  /** Clock for publishedAt; default the system clock. */
  now?: () => Date;
  /** Whether the root is durable enough to publish to; default isDurableKitRoot(). */
  durable?: () => boolean;
  /** Audit sink; default auditService.log. */
  audit?: (entry: AuditEntry) => void;
  /** The open flag that refuses a symlink; default fs.constants.O_NOFOLLOW. 0 means the runtime has none (tests). */
  noFollowFlag?: number;
}

/**
 * The approved set exactly as #397's approvedSetDigest commits to it: the entries that are public capability urls,
 * deduplicated and sorted by code unit. Iterates `urls` once.
 */
export function approvedSetSnapshot(urls: Iterable<unknown>): string[] {
  const kept = Array.from(urls).filter((u): u is string => typeof u === "string" && isPublicCapabilityUrl(u));
  return [...new Set(kept)].sort(compareCodeUnits);
}

const EntrySchema = z
  .object({
    schema: z.literal(RELEASE_LEDGER_ENTRY_SCHEMA),
    period: z.string().regex(PERIOD),
    publishedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)) && new Date(Date.parse(s)).toISOString() === s),
    publisher: z.string().min(1),
    approvedSet: z.array(z.string()),
    release: z.unknown(),
  })
  .strict();

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ReleaseLedger {
  private readonly rootDir: string;
  private readonly now: () => Date;
  private readonly durable: () => boolean;
  private readonly audit: (entry: AuditEntry) => void;
  /** O_NOFOLLOW, or 0 when this runtime has none: then the ledger refuses to read or publish. */
  private readonly noFollow: number;
  private realRoot: Promise<string> | null = null;
  private linksChecked = false;
  private lastSkipped: string[] = [];

  constructor(options: ReleaseLedgerOptions = {}) {
    this.rootDir = options.rootDir ?? resolveKitRegistryRoot();
    this.now = options.now ?? (() => new Date());
    this.durable = options.durable ?? isDurableKitRoot;
    this.audit = options.audit ?? ((entry) => auditService.log(entry));
    this.noFollow = options.noFollowFlag ?? fsConstants.O_NOFOLLOW ?? 0;
  }

  /** Periods the latest listing skipped because their entries failed verification. */
  get skipped(): readonly string[] {
    return this.lastSkipped;
  }

  // ── Reads ──────────────────────────────────────────────────────────

  /** The verified release for `period`, or null when that period has not been released. */
  async get(period: string): Promise<ReleaseView | null> {
    if (typeof period !== "string" || !PERIOD.test(period)) {
      throw new ReleaseLedgerError("invalid_period", 400, "a release period is YYYY-MM");
    }
    const dir = await this.area(false);
    if (!dir) return null;
    const bytes = await this.readNoFollow(dir, `${period}.json`, period);
    return bytes === null ? null : this.verify(bytes, period);
  }

  /** Every released period whose entry verifies, newest first; a failing entry is skipped and remembered. */
  async list(): Promise<{ releases: ReleaseSummary[] }> {
    const dir = await this.area(false);
    if (!dir) {
      this.lastSkipped = [];
      return { releases: [] };
    }
    const skipped: string[] = [];
    const releases: ReleaseSummary[] = [];
    for (const name of (await fs.readdir(dir)).sort(compareCodeUnits)) {
      const m = ENTRY_NAME.exec(name);
      if (!m) continue;
      const period = m[1]!;
      try {
        const view = await this.get(period);
        if (!view) continue;
        releases.push({
          period,
          digest: view.release.digest,
          aggregateCount: view.release.aggregates.length,
          publishedAt: view.publishedAt,
        });
      } catch (err) {
        if (!(err instanceof ReleaseIntegrityError)) throw err;
        skipped.push(period);
      }
    }
    this.lastSkipped = skipped;
    releases.sort((a, b) => compareCodeUnits(b.period, a.period));
    return { releases };
  }

  // ── Publish ────────────────────────────────────────────────────────

  /**
   * Record `release` as its period's one release. `approvedUrls` is the approved set the release was built with
   * (the set buildPublicRelease was given); its snapshot must match the record's approvedSetDigest.
   */
  async publish(release: unknown, approvedUrls: Iterable<unknown>, publisher: string): Promise<ReleasePublishResult> {
    if (typeof publisher !== "string" || publisher.trim() === "") {
      throw new ReleaseLedgerError("missing_identity", 401, "publishing a release needs an authenticated publisher");
    }
    if (!this.durable()) {
      throw new ReleaseLedgerError("registry_not_durable", 503, "the release ledger has no durable storage in this environment");
    }
    const approvedSet = approvedSetSnapshot(approvedUrls);
    const publishedAt = this.now().toISOString();
    // Verify and store ONE plain copy, so what is checked is exactly what is written.
    let record: PublicOpportunityRelease;
    try {
      record = JSON.parse(canonicalize(release)) as PublicOpportunityRelease;
      demandAggregatesFromRelease(record, approvedSet, publishedAt);
    } catch (err) {
      throw new ReleaseLedgerError("invalid_release", 422, messageOf(err));
    }
    const period = record.period;
    const text = canonicalize({
      schema: RELEASE_LEDGER_ENTRY_SCHEMA,
      period,
      publishedAt,
      publisher,
      approvedSet,
      release: record,
    });
    if (Buffer.byteLength(text, "utf8") > MAX_RELEASE_ENTRY_BYTES) {
      throw new ReleaseLedgerError("release_too_large", 413, `a ledger entry may be at most ${MAX_RELEASE_ENTRY_BYTES} bytes`);
    }
    await this.ensureLinksSupported();
    const dir = (await this.area(true))!;
    if (await this.createOnce(dir, `${period}.json`, text)) {
      this.audit({
        eventType: "demand.release.published",
        actor: publisher,
        resourceType: "public-opportunity-release",
        resourceId: period,
        action: "publish",
        metadata: { digest: record.digest, aggregateCount: record.aggregates.length },
      });
      return { period, digest: record.digest, created: true, publishedAt };
    }
    const existing = await this.get(period);
    if (!existing) throw new ReleaseIntegrityError(period, "the entry vanished after a writer created it");
    if (existing.release.digest !== record.digest) {
      throw new ReleaseLedgerError("release_period_taken", 409, `period ${period} has already been released`, {
        period,
        releasedDigest: existing.release.digest,
      });
    }
    return { period, digest: existing.release.digest, created: false, publishedAt: existing.publishedAt };
  }

  // ── Storage ────────────────────────────────────────────────────────

  private root(): Promise<string> {
    if (!this.realRoot) {
      this.realRoot = (async () => {
        await fs.mkdir(this.rootDir, { recursive: true });
        return fs.realpath(this.rootDir);
      })();
    }
    return this.realRoot;
  }

  /** `<root>/releases`, which must be a real directory, never a symlink; null when absent and not created. */
  private async area(create: boolean): Promise<string | null> {
    const dir = path.join(await this.root(), AREA);
    if (create) await fs.mkdir(dir).catch((err) => (errnoOf(err) === "EEXIST" ? undefined : Promise.reject(err)));
    let st;
    try {
      st = await fs.lstat(dir);
    } catch (err) {
      if (errnoOf(err) === "ENOENT" && !create) return null;
      throw err;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new ReleaseIntegrityError(`(${AREA})`, "the ledger directory is a symlink or not a directory");
    return dir;
  }

  /** A file's bytes, opened without following a symlink; null when absent. Fails closed on a runtime without O_NOFOLLOW. */
  private async readNoFollow(dir: string, name: string, period: string): Promise<Uint8Array | null> {
    if (!this.noFollow) throw new ReleaseIntegrityError(period, "this runtime cannot open a file without following a symlink");
    let handle;
    try {
      handle = await fs.open(path.join(dir, name), fsConstants.O_RDONLY | this.noFollow);
    } catch (err) {
      const code = errnoOf(err);
      if (code === "ENOENT") return null;
      if (code === "ELOOP" || code === "EMLINK") throw new ReleaseIntegrityError(period, "the entry is a symlink");
      throw err;
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) throw new ReleaseIntegrityError(period, "the entry is not a regular file");
      if (st.size > MAX_RELEASE_ENTRY_BYTES) throw new ReleaseIntegrityError(period, "the entry is larger than any entry the ledger writes");
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  }

  /** Create `<dir>/<name>` exclusively with `text`; false when it already exists. Never overwrites. */
  private async createOnce(dir: string, name: string, text: string): Promise<boolean> {
    const tmp = path.join(dir, `.${name}.tmp-${randomUUID()}`);
    await fs.writeFile(tmp, text, { flag: "wx" });
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

  /** Probe once, before anything is written, that the runtime has O_NOFOLLOW and the volume makes hard links. */
  private async ensureLinksSupported(): Promise<void> {
    if (this.linksChecked) return;
    if (!this.noFollow) {
      throw new ReleaseLedgerError("registry_unsupported_fs", 503, "this runtime has no O_NOFOLLOW, so the ledger cannot refuse symlinks");
    }
    const root = await this.root();
    const probe = path.join(root, `.link-probe-${randomUUID()}`);
    try {
      await fs.writeFile(probe, "", { flag: "wx" });
      await fs.link(probe, `${probe}.link`);
    } catch (err) {
      throw new ReleaseLedgerError("registry_unsupported_fs", 503, `the ledger's volume cannot create hard links (${errnoOf(err) ?? "error"}), so it cannot publish write-once`);
    } finally {
      await fs.unlink(probe).catch(() => undefined);
      await fs.unlink(`${probe}.link`).catch(() => undefined);
    }
    this.linksChecked = true;
  }

  /** The verified view of an entry's bytes, or a ReleaseIntegrityError. */
  private verify(bytes: Uint8Array, period: string): ReleaseView {
    let text: string;
    let json: unknown;
    try {
      text = strictUtf8.decode(bytes);
      json = JSON.parse(text);
    } catch {
      throw new ReleaseIntegrityError(period, "the entry is not UTF-8 JSON");
    }
    const parsed = EntrySchema.safeParse(json);
    if (!parsed.success) throw new ReleaseIntegrityError(period, "the entry is malformed");
    if (canonicalize(json) !== text) throw new ReleaseIntegrityError(period, "the entry is not in canonical form");
    const entry = parsed.data;
    const record = entry.release as PublicOpportunityRelease;
    if (entry.period !== period || (record as { period?: unknown } | null)?.period !== period) {
      throw new ReleaseIntegrityError(period, "the entry's period does not match its name");
    }
    if (canonicalize(approvedSetSnapshot(entry.approvedSet)) !== canonicalize(entry.approvedSet)) {
      throw new ReleaseIntegrityError(period, "the approved set is not a canonical snapshot");
    }
    try {
      demandAggregatesFromRelease(record, entry.approvedSet, entry.publishedAt);
    } catch (err) {
      throw new ReleaseIntegrityError(period, `the release does not verify (${messageOf(err)})`);
    }
    return { period, release: record, approvedSet: entry.approvedSet, publishedAt: entry.publishedAt };
  }
}

let ledger: ReleaseLedger | null = null;

/** The process's ledger, on the Kit registry's durable root. */
export function getReleaseLedger(): ReleaseLedger {
  if (!ledger) ledger = new ReleaseLedger();
  return ledger;
}

/** Test helper: reset the singleton, optionally to a replacement rooted in a temp dir. */
export function _resetReleaseLedgerForTests(replacement?: ReleaseLedger): void {
  ledger = replacement ?? null;
}
