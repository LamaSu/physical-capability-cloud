/**
 * Public demand release ledger (kits K4a): write-once per period, verified
 * reads, and the read routes. Releases are built the way #365's
 * buildPublicRelease builds one, with both digests computed independently
 * (the fixture of #397's kits-contracts.test.ts).
 */

import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  canonicalize,
  demandAggregatesFromRelease,
  isPublicCapabilityUrl,
  publicCapabilityUrls,
  type PublicOpportunityRelease,
} from "@pcc/spec";
import {
  MAX_RELEASE_ENTRY_BYTES,
  ReleaseIntegrityError,
  ReleaseLedger,
  ReleaseLedgerError,
  approvedSetSnapshot,
} from "../services/release-ledger.js";
import { kitReleaseRoutes } from "../routes/kit-releases.js";
import type { AuditEntry } from "../services/audit-service.js";

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function mkTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "releases-"));
  tempDirs.push(dir);
  return dir;
}

const PUBLISHER = "producer@releases.test";
const NOW = new Date("2026-10-03T12:00:00.000Z");
const liquid = "pcc://capabilities/liquid-handling/v1";
const cnc = "pcc://capabilities/cnc-3axis/v2";
const approved = publicCapabilityUrls([liquid]);
/** The verifier reads the real clock, so "open" and "future" periods are computed from it. */
const THIS_MONTH = new Date().toISOString().slice(0, 7);
const NEXT_YEAR_JANUARY = `${new Date().getUTCFullYear() + 1}-01`;

function digestOf(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

type AggregateRecord = PublicOpportunityRelease["aggregates"][number];

function aggregateRecord(capabilityType: string, period = "2026-08", demandBand: AggregateRecord["demandBand"] = "5-9"): AggregateRecord {
  return { schema: "pcc.public-opportunity-aggregate.v1", capabilityType, demandBand, countedEvidence: "authenticated_order", period } as AggregateRecord;
}

/** A release built the way #365's buildPublicRelease builds one. */
function buildRelease(aggregates: AggregateRecord[], period = "2026-08", approvedUrls: readonly string[] = approved): PublicOpportunityRelease {
  const body = {
    schema: "pcc.public-opportunity-release.v1" as const,
    period,
    policy: { k: 5, evidenceFloor: "authenticated_order" as const },
    approvedSetDigest: digestOf([...new Set(approvedUrls.filter((u) => isPublicCapabilityUrl(u)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))),
    aggregates,
  };
  return { ...body, digest: digestOf(body) } as PublicOpportunityRelease;
}

async function mkLedger(opts: { durable?: boolean; noFollowFlag?: number; rootDir?: string; now?: () => Date } = {}) {
  const rootDir = opts.rootDir ?? (await mkTempRoot());
  const audits: AuditEntry[] = [];
  const ledger = new ReleaseLedger({
    rootDir,
    now: opts.now ?? (() => NOW),
    durable: () => opts.durable ?? true,
    audit: (e) => audits.push(e),
    ...(opts.noFollowFlag !== undefined ? { noFollowFlag: opts.noFollowFlag } : {}),
  });
  return { ledger, rootDir, audits, entryPath: (period: string) => path.join(rootDir, "releases", `${period}.json`) };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("release ledger: one release per period, write-once", () => {
  it("publishes a release once and reads it back verified, with its approved-set snapshot and no publisher", async () => {
    const { ledger, audits } = await mkLedger();
    const release = buildRelease([aggregateRecord(cnc), aggregateRecord(liquid)]);
    const res = await ledger.publish(release, approved, PUBLISHER);
    expect(res).toEqual({ period: "2026-08", digest: release.digest, created: true, publishedAt: NOW.toISOString() });
    const view = await ledger.get("2026-08");
    expect(view).toEqual({ period: "2026-08", release, approvedSet: [...approved], publishedAt: NOW.toISOString() });
    expect(JSON.stringify(view)).not.toContain(PUBLISHER);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ eventType: "demand.release.published", actor: PUBLISHER, resourceId: "2026-08", action: "publish" });
    // A consumer verifies the read view with #397's own function.
    expect(demandAggregatesFromRelease(view!.release, view!.approvedSet, "2026-10-03T12:00:00Z")).toHaveLength(2);
  });

  it("the same record again is created:false with the first publishedAt, and is audited once", async () => {
    const { ledger, audits, rootDir } = await mkLedger();
    const release = buildRelease([aggregateRecord(cnc)]);
    await ledger.publish(release, approved, PUBLISHER);
    const later = new ReleaseLedger({ rootDir, now: () => new Date(NOW.getTime() + 60_000), durable: () => true, audit: (e) => audits.push(e) });
    expect(await later.publish(release, approved, "someone-else@releases.test")).toEqual({
      period: "2026-08",
      digest: release.digest,
      created: false,
      publishedAt: NOW.toISOString(),
    });
    expect(audits).toHaveLength(1);
  });

  it("a DIFFERENT record for a released period is refused (409) and the stored release does not change", async () => {
    const { ledger } = await mkLedger();
    const first = buildRelease([aggregateRecord(cnc)]);
    await ledger.publish(first, approved, PUBLISHER);
    const second = buildRelease([aggregateRecord(cnc, "2026-08", "10-24")]);
    const err = await rejection(ledger.publish(second, approved, PUBLISHER));
    expect(err).toBeInstanceOf(ReleaseLedgerError);
    expect(err).toMatchObject({ code: "release_period_taken", status: 409, details: { period: "2026-08", releasedDigest: first.digest } });
    expect((await ledger.get("2026-08"))!.release).toEqual(first);
  });

  it("two different records racing for one period: exactly one is written, the other gets 409, even across ledger instances", async () => {
    const rootDir = await mkTempRoot();
    const a = new ReleaseLedger({ rootDir, now: () => NOW, durable: () => true, audit: () => undefined });
    const b = new ReleaseLedger({ rootDir, now: () => NOW, durable: () => true, audit: () => undefined });
    const ra = buildRelease([aggregateRecord(cnc)]);
    const rb = buildRelease([aggregateRecord(liquid)]);
    const results = await Promise.allSettled([a.publish(ra, approved, PUBLISHER), b.publish(rb, approved, PUBLISHER)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ code: "release_period_taken" });
    const winner = (ok[0] as PromiseFulfilledResult<{ digest: string }>).value.digest;
    expect((await a.get("2026-08"))!.release.digest).toBe(winner);
  });

  it("the same record racing: one created:true, the rest created:false", async () => {
    const rootDir = await mkTempRoot();
    const release = buildRelease([aggregateRecord(cnc)]);
    const ledgers = Array.from({ length: 5 }, () => new ReleaseLedger({ rootDir, now: () => NOW, durable: () => true, audit: () => undefined }));
    const results = await Promise.all(ledgers.map((l) => l.publish(release, approved, PUBLISHER)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.every((r) => r.digest === release.digest)).toBe(true);
  });

  it("an empty release (no aggregate qualified) is a release too: its period is taken", async () => {
    const { ledger } = await mkLedger();
    const empty = buildRelease([]);
    expect((await ledger.publish(empty, approved, PUBLISHER)).created).toBe(true);
    await expect(ledger.publish(buildRelease([aggregateRecord(cnc)]), approved, PUBLISHER)).rejects.toMatchObject({ code: "release_period_taken" });
  });
});

describe("release ledger: what it refuses to publish (nothing is written)", () => {
  const good = () => buildRelease([aggregateRecord(cnc)]);
  const cases: Array<[label: string, make: () => unknown, urls?: readonly string[]]> = [
    ["a wrong digest", () => ({ ...good(), digest: `sha256:${"0".repeat(64)}` })],
    ["an open period (the current month)", () => buildRelease([aggregateRecord(cnc, THIS_MONTH)], THIS_MONTH)],
    ["a period in the future", () => buildRelease([], NEXT_YEAR_JANUARY)],
    ["an approved set other than the one the record was built with", () => good(), publicCapabilityUrls([])],
    ["an extra key on the record", () => ({ ...good(), note: "x" })],
    ["an extra key on an aggregate", () => buildRelease([{ ...aggregateRecord(cnc), extra: 1 } as unknown as AggregateRecord])],
    ["aggregates out of canonical order", () => buildRelease([aggregateRecord(liquid), aggregateRecord(cnc)])],
    ["an aggregate for another period", () => buildRelease([aggregateRecord(cnc, "2026-07")])],
    ["a policy other than #365's", () => {
      const r = good();
      const body = { ...r, policy: { k: 3, evidenceFloor: "authenticated_order" } } as Record<string, unknown>;
      delete body.digest;
      return { ...body, digest: digestOf(body) };
    }],
    ["an unapproved capability", () => buildRelease([aggregateRecord("pcc://capabilities/not-a-real-thing/v1")])],
    ["not an object", () => "release"],
    ["null", () => null],
  ];
  for (const [label, make, urls] of cases) {
    it(`refuses ${label} (422 invalid_release)`, async () => {
      const { ledger, rootDir } = await mkLedger();
      const err = await rejection(ledger.publish(make(), urls ?? approved, PUBLISHER));
      expect(err, label).toBeInstanceOf(ReleaseLedgerError);
      expect(err, label).toMatchObject({ code: "invalid_release", status: 422 });
      expect(await fs.readdir(rootDir), label).toEqual([]);
    });
  }

  it("refuses a missing publisher (401), a non-durable root (503) and a runtime without O_NOFOLLOW (503), before writing", async () => {
    for (const who of ["", "   "]) {
      const { ledger } = await mkLedger();
      await expect(ledger.publish(buildRelease([]), approved, who)).rejects.toMatchObject({ code: "missing_identity", status: 401 });
    }
    const notDurable = await mkLedger({ durable: false });
    await expect(notDurable.ledger.publish(buildRelease([]), approved, PUBLISHER)).rejects.toMatchObject({ code: "registry_not_durable", status: 503 });
    const noFollow = await mkLedger({ noFollowFlag: 0 });
    await expect(noFollow.ledger.publish(buildRelease([]), approved, PUBLISHER)).rejects.toMatchObject({ code: "registry_unsupported_fs", status: 503 });
    expect(await fs.readdir(noFollow.rootDir)).toEqual([]);
    await expect(noFollow.ledger.get("2026-08")).resolves.toBeNull(); // nothing there to refuse yet
  });

  it("takes ONE plain copy of the input in a single pass and never reads the input again: what is stored is what was verified", async () => {
    const { ledger, entryPath } = await mkLedger();
    const good = buildRelease([aggregateRecord(cnc)]);
    let reads = 0;
    const tricky = { ...good } as Record<string, unknown>;
    // canonicalize reads each property twice in its one pass (its undefined filter, then the value). Any later read,
    // as a ledger that re-read the input after verifying it would make, sees different aggregates.
    Object.defineProperty(tricky, "aggregates", {
      enumerable: true,
      get() {
        reads += 1;
        return reads <= 2 ? good.aggregates : [aggregateRecord(liquid)];
      },
    });
    expect((await ledger.publish(tricky, approved, PUBLISHER)).digest).toBe(good.digest);
    expect(reads).toBeLessThanOrEqual(2);
    const stored = JSON.parse(await fs.readFile(entryPath("2026-08"), "utf8"));
    expect(stored.release).toEqual(good);
    expect((await ledger.get("2026-08"))!.release).toEqual(good);
  });
});

describe("release ledger: verified reads", () => {
  it("an unknown period is null; a malformed one is 400 invalid_period and never touches the filesystem", async () => {
    const { ledger } = await mkLedger();
    expect(await ledger.get("2026-08")).toBeNull();
    for (const bad of ["2026-13", "2026-8", "26-08", "../2026-08", "2026-08.json", "", "2026-00"]) {
      await expect(ledger.get(bad), bad).rejects.toMatchObject({ code: "invalid_period", status: 400 });
    }
  });

  async function published() {
    const ctx = await mkLedger();
    await ctx.ledger.publish(buildRelease([aggregateRecord(cnc)]), approved, PUBLISHER);
    const text = await fs.readFile(ctx.entryPath("2026-08"), "utf8");
    return { ...ctx, text };
  }

  const tampers: Array<[string, (text: string) => string]> = [
    ["a changed demand band", (t) => t.replace('"demandBand":"5-9"', '"demandBand":"10-24"')],
    ["whitespace (not canonical)", (t) => t.replace('{"approvedSet"', '{ "approvedSet"')],
    ["a non-ISO publishedAt", (t) => t.replace(NOW.toISOString(), "2026-10-03 12:00:00")],
    ["a removed approved-set member", (t) => t.replace(`"${liquid}",`, "").replace(`,"${liquid}"`, "")],
    ["a reordered approved set (same members, so the digest alone would still match)", (t) => {
      const m = /"approvedSet":\[([^\]]*)\]/.exec(t)!;
      const members = m[1]!.split(",");
      return t.replace(m[0], `"approvedSet":[${[...members.slice(1), members[0]].join(",")}]`);
    }],
    ["a truncated file", (t) => t.slice(0, t.length - 10)],
    ["invalid UTF-8", () => "replaced by invalid bytes below"],
    ["an empty file", () => ""],
  ];
  for (const [label, tamper] of tampers) {
    it(`a stored entry with ${label} is refused on read and skipped by the listing`, async () => {
      const { ledger, entryPath, text } = await published();
      const changed = tamper(text);
      expect(changed, label).not.toBe(text);
      await fs.writeFile(entryPath("2026-08"), label === "invalid UTF-8" ? Buffer.from([0xc3, 0x28]) : changed);
      await expect(ledger.get("2026-08"), label).rejects.toBeInstanceOf(ReleaseIntegrityError);
      expect((await ledger.list()).releases, label).toEqual([]);
      expect(ledger.skipped, label).toEqual(["2026-08"]);
    });
  }

  it("an entry stored under another period's name is refused", async () => {
    const { ledger, entryPath } = await published();
    await fs.copyFile(entryPath("2026-08"), entryPath("2026-07"));
    await expect(ledger.get("2026-07")).rejects.toBeInstanceOf(ReleaseIntegrityError);
    expect((await ledger.get("2026-08"))!.period).toBe("2026-08");
  });

  it("a symlinked entry or a symlinked releases directory is refused, never followed", async () => {
    const { ledger, rootDir, entryPath } = await published();
    const outside = await mkTempRoot();
    await fs.copyFile(entryPath("2026-08"), path.join(outside, "2026-08.json"));
    await fs.rm(entryPath("2026-08"));
    await fs.symlink(path.join(outside, "2026-08.json"), entryPath("2026-08"));
    await expect(ledger.get("2026-08")).rejects.toBeInstanceOf(ReleaseIntegrityError);

    const other = await mkLedger();
    await fs.symlink(outside, path.join(other.rootDir, "releases"));
    await expect(other.ledger.get("2026-08")).rejects.toBeInstanceOf(ReleaseIntegrityError);
    await expect(other.ledger.list()).rejects.toBeInstanceOf(ReleaseIntegrityError);
    await expect(other.ledger.publish(buildRelease([], "2026-07"), approved, PUBLISHER)).rejects.toBeInstanceOf(ReleaseIntegrityError);
    expect((await fs.readdir(outside)).sort()).toEqual(["2026-08.json"]);
    expect(rootDir).not.toBe(other.rootDir);
  });

  it("a runtime without O_NOFOLLOW refuses to read a stored entry", async () => {
    const { rootDir } = await published();
    const noFollow = new ReleaseLedger({ rootDir, now: () => NOW, durable: () => true, audit: () => undefined, noFollowFlag: 0 });
    await expect(noFollow.get("2026-08")).rejects.toBeInstanceOf(ReleaseIntegrityError);
  });

  it("lists every verified period newest first, with its digest and aggregate count", async () => {
    const { ledger } = await mkLedger();
    const july = buildRelease([aggregateRecord(cnc, "2026-07")], "2026-07");
    const august = buildRelease([aggregateRecord(cnc), aggregateRecord(liquid)]);
    await ledger.publish(july, approved, PUBLISHER);
    await ledger.publish(august, approved, PUBLISHER);
    expect(await ledger.list()).toEqual({
      releases: [
        { period: "2026-08", digest: august.digest, aggregateCount: 2, publishedAt: NOW.toISOString() },
        { period: "2026-07", digest: july.digest, aggregateCount: 1, publishedAt: NOW.toISOString() },
      ],
    });
    expect(ledger.skipped).toEqual([]);
  });

  it("approvedSetSnapshot is #397's construction: public urls only, deduplicated, sorted by code unit", () => {
    expect(approvedSetSnapshot([liquid, cnc, liquid, "not a url", 7, cnc])).toEqual([cnc, liquid].sort((a, b) => (a < b ? -1 : 1)));
    expect(digestOf(approvedSetSnapshot(approved))).toBe(buildRelease([]).approvedSetDigest);
  });

  it("refuses to write an entry larger than MAX_RELEASE_ENTRY_BYTES (413)", async () => {
    const { ledger } = await mkLedger();
    // Letter-only slugs: isPublicCapabilityUrl refuses a slug with four digits in a row.
    const slug = (n: number): string => {
      let out = "";
      for (let i = 0; i < 4; i++, n = Math.floor(n / 26)) out = String.fromCharCode(97 + (n % 26)) + out;
      return out;
    };
    const huge = Array.from({ length: Math.ceil(MAX_RELEASE_ENTRY_BYTES / 30) }, (_, i) => `pcc://capabilities/kit-${slug(i)}/v1`);
    expect(approvedSetSnapshot(huge)).toHaveLength(huge.length);
    const err = await rejection(ledger.publish(buildRelease([], "2026-08", huge), huge, PUBLISHER));
    expect(err).toMatchObject({ code: "release_too_large", status: 413 });
  });
});

describe("release ledger routes", () => {
  async function buildApp(ledger: ReleaseLedger): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(kitReleaseRoutes, { ledger });
    return app;
  }

  it("GET /api/kits/demand/releases lists; GET /api/kits/demand/releases/:period reads one, verified", async () => {
    const { ledger } = await mkLedger();
    const release = buildRelease([aggregateRecord(cnc)]);
    await ledger.publish(release, approved, PUBLISHER);
    const app = await buildApp(ledger);
    try {
      const list = await app.inject({ method: "GET", url: "/api/kits/demand/releases" });
      expect(list.statusCode).toBe(200);
      expect(list.json().releases).toEqual([{ period: "2026-08", digest: release.digest, aggregateCount: 1, publishedAt: NOW.toISOString() }]);
      const one = await app.inject({ method: "GET", url: "/api/kits/demand/releases/2026-08" });
      expect(one.statusCode).toBe(200);
      expect(one.json()).toEqual({ period: "2026-08", release, approvedSet: [...approved], publishedAt: NOW.toISOString() });
      expect(one.body).not.toContain(PUBLISHER);
    } finally {
      await app.close();
    }
  });

  it("404 for an unreleased period, 400 for a malformed one, 500 (nothing served) for an entry that fails verification", async () => {
    const { ledger, entryPath } = await mkLedger();
    await ledger.publish(buildRelease([aggregateRecord(cnc)]), approved, PUBLISHER);
    const app = await buildApp(ledger);
    try {
      expect((await app.inject({ method: "GET", url: "/api/kits/demand/releases/2026-07" })).statusCode).toBe(404);
      const bad = await app.inject({ method: "GET", url: "/api/kits/demand/releases/2026-13" });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe("invalid_period");
      const text = await fs.readFile(entryPath("2026-08"), "utf8");
      await fs.writeFile(entryPath("2026-08"), text.replace('"demandBand":"5-9"', '"demandBand":"10-24"'));
      const broken = await app.inject({ method: "GET", url: "/api/kits/demand/releases/2026-08" });
      expect(broken.statusCode).toBe(500);
      expect(broken.json()).toEqual({ error: "release_integrity_failure", message: "the stored release failed verification and is not served" });
      const list = await app.inject({ method: "GET", url: "/api/kits/demand/releases" });
      expect(list.json().releases).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("a symlinked releases directory answers 500 on the listing", async () => {
    const { ledger, rootDir } = await mkLedger();
    await fs.symlink(await mkTempRoot(), path.join(rootDir, "releases"));
    const app = await buildApp(ledger);
    try {
      const res = await app.inject({ method: "GET", url: "/api/kits/demand/releases" });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe("release_integrity_failure");
    } finally {
      await app.close();
    }
  });
});
