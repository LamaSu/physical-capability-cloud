/**
 * R4 PR4 / D13 — share hardening: legacy-slug rotation + expiring aliases, a
 * slug-only alias-aware public resolver with indistinguishable not-found, and a
 * failed-lookup limiter that is checked AFTER the lookup (so a known-valid link
 * is never suppressed by accumulated misses) with per-caller hashed keys (no
 * shared bucket). Complements mcp-apps-hardening.test.ts (which covers the
 * ≥96-bit entropy on NEW saves + the base rate-limiter unit).
 */

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DASHBOARD_CSD_URL, type UiArtifact } from "@pcc/spec";
import {
  artifactsRoutes,
  getPublicArtifactForRender,
  rotateLegacyShareSlugs,
  isWeakLegacySlug,
  _clearArtifactsForTests,
  _seedArtifactForTests,
  _seedLegacyAliasForTests,
  _countLegacyAliasesForTests,
  _resetPublicLookupLimiterForTests,
} from "../routes/artifacts.js";
import { resolvePublicShareSlug } from "../mcp/mcp-app-view.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(artifactsRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  _clearArtifactsForTests();
  _resetPublicLookupLimiterForTests();
});

// ───────────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────────

function manifestFor(title: string) {
  return {
    csd: DASHBOARD_CSD_URL,
    title,
    sections: [{ windows: [{ kind: "note", text: "hi" }] }],
  };
}

/** Seed a fully-formed artifact with an explicit slug/visibility/status. */
function seed(
  slug: string,
  name: string,
  visibility: UiArtifact["visibility"] = "public",
  status: UiArtifact["status"] = "active",
): void {
  const now = new Date().toISOString();
  _seedArtifactForTests({
    id: `ua_${slug}`,
    slug,
    csd: DASHBOARD_CSD_URL,
    name,
    manifest: manifestFor(name),
    capabilityTypes: [],
    visibility,
    owner: "op_test",
    useCount: 0,
    loadCount: 0,
    forkCount: 0,
    status,
    createdAt: now,
    updatedAt: now,
    version: 1,
  } as UiArtifact);
}

const HOUR = 3_600_000;

// ═══════════════════════════════════════════════════════════════════════════
// Scope 1 — NEW unlisted artifacts get ≥96-bit slugs.
// ═══════════════════════════════════════════════════════════════════════════

describe("D13 · new slug entropy", () => {
  it("mints a ≥96-bit (24-hex) suffix and keeps the human prefix, and it is NOT weak", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/artifacts",
      headers: { authorization: "Bearer tok-entropy", "content-type": "application/json" },
      payload: { name: "Budget Report", manifest: manifestFor("Budget Report"), visibility: "unlisted" },
    });
    expect(res.statusCode).toBe(201);
    const slug = res.json().slug as string;
    expect(slug).toMatch(/^budget-report-[0-9a-f]{24}$/);
    expect(isWeakLegacySlug(slug)).toBe(false);
  });

  it("isWeakLegacySlug flags only a 6-hex (24-bit) suffix", () => {
    expect(isWeakLegacySlug("watch-my-pizza-1a2b3c")).toBe(true); // legacy 6-hex
    expect(isWeakLegacySlug("watch-my-pizza-1a2b3c4d5e6f7a8b9c0d1e2f")).toBe(false); // 24-hex
    expect(isWeakLegacySlug("watch-my-pizza")).toBe(false); // no hex suffix
    expect(isWeakLegacySlug("report-hello1")).toBe(false); // 6 chars but not all hex
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scope 2 — rotation + expiring hashed aliases.
// ═══════════════════════════════════════════════════════════════════════════

describe("D13 · rotate legacy weak slugs + expiring aliases", () => {
  it("rotates a weak slug to ≥96 bits and the OLD link resolves through the alias (within TTL)", () => {
    const oldSlug = "watch-my-pizza-1a2b3c"; // ~24-bit
    seed(oldSlug, "Watch my pizza", "public");
    expect(isWeakLegacySlug(oldSlug)).toBe(true);

    const summary = rotateLegacyShareSlugs();
    expect(summary.rotated).toBe(1);
    expect(summary.aliasesWritten).toBe(1);
    expect(_countLegacyAliasesForTests()).toBe(1);

    const newSlug = summary.rotated_ids[0].newSlug;
    expect(newSlug).toMatch(/^watch-my-pizza-[0-9a-f]{24}$/);
    expect(isWeakLegacySlug(newSlug)).toBe(false);

    // The artifact now lives at the strong slug — the old one is gone as a direct slug…
    expect(getPublicArtifactForRender(newSlug)?.id).toBe(`ua_${oldSlug}`);
    // …but the OLD share link still resolves, via the live alias.
    expect(getPublicArtifactForRender(oldSlug)?.id).toBe(`ua_${oldSlug}`);
  });

  it("an EXPIRED alias no longer resolves the old link (indistinguishable from missing)", () => {
    const oldSlug = "budget-report-abcdef";
    seed(oldSlug, "Budget report", "public");
    const summary = rotateLegacyShareSlugs();
    const newSlug = summary.rotated_ids[0].newSlug;

    // Force the alias to have already lapsed.
    _seedLegacyAliasForTests(oldSlug, `ua_${oldSlug}`, new Date(Date.now() - 1000).toISOString());

    expect(getPublicArtifactForRender(oldSlug)).toBeUndefined(); // expired → gone
    expect(getPublicArtifactForRender(newSlug)?.id).toBe(`ua_${oldSlug}`); // new slug still works
  });

  it("is idempotent — a second run rotates nothing", () => {
    seed("pizza-live-1a2b3c", "Pizza", "public");
    const first = rotateLegacyShareSlugs();
    expect(first.rotated).toBe(1);

    const second = rotateLegacyShareSlugs();
    expect(second.rotated).toBe(0);
    expect(second.skippedStrong).toBeGreaterThanOrEqual(1);
    expect(_countLegacyAliasesForTests()).toBe(1); // no duplicate alias
  });

  it("is ATOMIC per artifact: a failing alias insert rolls back the slug rotation", () => {
    const oldSlug = "atomic-check-1a2b3c";
    seed(oldSlug, "Atomic", "public");
    expect(isWeakLegacySlug(oldSlug)).toBe(true);

    // Inject an alias sink that throws AFTER the slug update runs inside the txn.
    expect(() =>
      rotateLegacyShareSlugs({
        aliasWriter: () => {
          throw new Error("alias sink down");
        },
      }),
    ).toThrow("alias sink down");

    // Rollback: the artifact still lives at its OLD slug (never half-rotated) and
    // NO alias was written — the old share link is intact, not stranded.
    expect(getPublicArtifactForRender(oldSlug)?.slug).toBe(oldSlug);
    expect(isWeakLegacySlug(getPublicArtifactForRender(oldSlug)!.slug)).toBe(true);
    expect(_countLegacyAliasesForTests()).toBe(0);
  });

  it("rotates ONLY active public|unlisted weak slugs — leaves private / retired / strong", () => {
    seed("pub-weak-1a2b3c", "Pub", "public", "active");
    seed("unl-weak-2b3c4d", "Unl", "unlisted", "active");
    seed("priv-weak-3c4d5e", "Priv", "private", "active"); // private → skip
    seed("ret-weak-4d5e6f", "Ret", "public", "retired"); // retired → skip
    seed("strong-pub-0011223344556677889900aa", "Strong", "public", "active"); // already strong → skip

    const summary = rotateLegacyShareSlugs();
    expect(summary.rotated).toBe(2); // pub + unlisted only
    expect(getPublicArtifactForRender("priv-weak-3c4d5e")).toBeUndefined(); // still private
    // The private/retired/strong slugs are untouched (private/retired stay unresolvable publicly).
    expect(getPublicArtifactForRender("strong-pub-0011223344556677889900aa")?.slug).toBe(
      "strong-pub-0011223344556677889900aa",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scope 3 — public-share resolver: slug-only, alias-aware, indistinguishable,
// passive; an alias never widens visibility.
// ═══════════════════════════════════════════════════════════════════════════

describe("D13 · public resolver — indistinguishable + no visibility widening", () => {
  it("private / retired / missing / malformed / expired-alias all resolve to undefined; a live public one resolves", () => {
    seed("live-public-7777", "Live", "public", "active");
    seed("priv-9999", "Priv", "private", "active");
    seed("ret-8888", "Ret", "public", "retired");
    // A live alias whose target is present + public is the positive control below;
    // here seed an already-expired alias to the live artifact.
    _seedLegacyAliasForTests("expired-old-link", "ua_live-public-7777", new Date(Date.now() - 1000).toISOString());

    expect(getPublicArtifactForRender("priv-9999")).toBeUndefined();
    expect(getPublicArtifactForRender("ret-8888")).toBeUndefined();
    expect(getPublicArtifactForRender("never-existed-0000")).toBeUndefined();
    expect(getPublicArtifactForRender("Bad Slug!")).toBeUndefined(); // malformed
    expect(getPublicArtifactForRender("ua_live-public-7777")).toBeUndefined(); // an id is never accepted
    expect(getPublicArtifactForRender("expired-old-link")).toBeUndefined(); // expired alias
    expect(getPublicArtifactForRender("live-public-7777")?.slug).toBe("live-public-7777"); // control
  });

  it("an alias NEVER widens visibility — a live alias pointing at a PRIVATE artifact resolves to nothing", () => {
    seed("secret-strong-0011223344556677889900aa", "Secret", "private", "active");
    _seedLegacyAliasForTests(
      "old-public-name-1234",
      "ua_secret-strong-0011223344556677889900aa",
      new Date(Date.now() + HOUR).toISOString(), // unexpired
    );
    // Alias resolves the id, but the resolver re-applies the public|unlisted gate.
    expect(getPublicArtifactForRender("old-public-name-1234")).toBeUndefined();
  });

  it("resolving via an alias is a PASSIVE read — no loadCount bump", () => {
    const oldSlug = "counter-check-1a2b3c";
    seed(oldSlug, "Counter", "public");
    rotateLegacyShareSlugs();
    getPublicArtifactForRender(oldSlug); // via alias
    getPublicArtifactForRender(oldSlug);
    expect(getPublicArtifactForRender(oldSlug)?.loadCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scope 3 (route) — /a/:slug is slug-only, alias-aware, and returns ONE generic
// not-found for every miss reason.
// ═══════════════════════════════════════════════════════════════════════════

describe("D13 · /a/:slug render shell", () => {
  it("serves a rotated old link via its alias, and the NEW slug — but NEVER the artifact id (slug-only)", async () => {
    const oldSlug = "pizza-live-1a2b3c";
    seed(oldSlug, "Pizza", "public");
    const summary = rotateLegacyShareSlugs();
    const newSlug = summary.rotated_ids[0].newSlug;
    const id = summary.rotated_ids[0].id; // ua_pizza-live-1a2b3c

    expect((await app.inject({ method: "GET", url: `/a/${newSlug}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/a/${oldSlug}` })).statusCode).toBe(200); // alias
    // The id fallback is gone: an id is not a valid slug and is never resolved.
    expect((await app.inject({ method: "GET", url: `/a/${id}` })).statusCode).toBe(404);
  });

  it("private / retired / missing / malformed all return the SAME generic not-found (byte-identical, no oracle)", async () => {
    seed("priv-strong-0011223344556677889900aa", "Priv", "private", "active");
    seed("ret-strong-0011223344556677889900bb", "Ret", "public", "retired");

    const priv = await app.inject({ method: "GET", url: "/a/priv-strong-0011223344556677889900aa" });
    const ret = await app.inject({ method: "GET", url: "/a/ret-strong-0011223344556677889900bb" });
    const missing = await app.inject({ method: "GET", url: "/a/never-existed-000000000000000000000000" });
    const malformed = await app.inject({ method: "GET", url: "/a/Bad_Slug" });

    for (const r of [priv, ret, missing, malformed]) {
      expect(r.statusCode).toBe(404);
      expect(r.headers["content-type"]).toContain("text/html");
    }
    // The slug is not echoed in the body → the four documents are byte-identical.
    expect(priv.body).toBe(missing.body);
    expect(ret.body).toBe(missing.body);
    expect(malformed.body).toBe(missing.body);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scope 4 — limiter checked AFTER the lookup; per-caller hashed keys.
// ═══════════════════════════════════════════════════════════════════════════

describe("D13 · rate limiter (lookup-before-throttle, per-caller)", () => {
  it("a KNOWN-VALID link is still served from an IP that is ALREADY throttled", async () => {
    seed("valid-pub-0011223344556677889900aa", "Valid", "public");
    const ip = "198.51.100.123";

    // Drive this IP over the failed-lookup budget with a burst of misses.
    let last = await app.inject({ method: "GET", url: "/a/miss-init", remoteAddress: ip });
    for (let i = 0; i < 40 && last.statusCode !== 429; i++) {
      last = await app.inject({ method: "GET", url: `/a/miss-${i}`, remoteAddress: ip });
    }
    expect(last.statusCode).toBe(429); // confirmed throttled

    // The SAME throttled IP asks for a VALID slug → served (lookup runs first).
    const valid = await app.inject({
      method: "GET",
      url: "/a/valid-pub-0011223344556677889900aa",
      remoteAddress: ip,
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.body).toContain("pcc-manifest");
  });

  it("one caller's misses NEVER suppress another caller's valid link (per-caller keys)", async () => {
    seed("shared-pub-0011223344556677889900cc", "Shared", "public");
    const attacker = "203.0.113.50";

    let last = await app.inject({ method: "GET", url: "/a/x-init", remoteAddress: attacker });
    for (let i = 0; i < 40 && last.statusCode !== 429; i++) {
      last = await app.inject({ method: "GET", url: `/a/x-${i}`, remoteAddress: attacker });
    }
    expect(last.statusCode).toBe(429); // the attacker is throttled

    // A DIFFERENT caller's valid request is unaffected.
    const other = await app.inject({
      method: "GET",
      url: "/a/shared-pub-0011223344556677889900cc",
      remoteAddress: "203.0.113.99",
    });
    expect(other.statusCode).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scope 4 (MCP resource resolver) — the public-share `resources/read` resolver
// now actually CONSULTS the limiter (re-audit #2: it used to record a miss but
// never throttle). Lookup-before-throttle; per-caller keys.
// ═══════════════════════════════════════════════════════════════════════════

describe("D13 · MCP share resolver consults the failed-lookup limiter", () => {
  const VALID = "valid-share-0011223344556677889900aa";

  it("repeated MISSES from one session key get throttled after the budget", () => {
    seed(VALID, "Valid", "public");
    let last = resolvePublicShareSlug("miss-a-000000000000000000000000", "sessKeyA");
    expect(last.found).toBe(false);
    expect(last.throttled).toBe(false);
    // Drive the same key over the failed-lookup budget.
    for (let i = 0; i < 40 && !last.throttled; i++) {
      last = resolvePublicShareSlug(`miss-a-${i}`, "sessKeyA");
    }
    expect(last.found).toBe(false);
    expect(last.throttled).toBe(true);
    // The throttled response differs from the plain not-found body (limiter acts).
    expect(last.html).toContain("Too many lookups");
  });

  it("a VALID link is served (lookup-first) even for a session key that is already throttled", () => {
    seed(VALID, "Valid", "public");
    // Throttle keyA on misses…
    let last = resolvePublicShareSlug("x-000000000000000000000000", "sessKeyA");
    for (let i = 0; i < 40 && !last.throttled; i++) last = resolvePublicShareSlug(`x-${i}`, "sessKeyA");
    expect(last.throttled).toBe(true);
    // …yet the SAME throttled key still gets its valid link (never suppressed).
    const valid = resolvePublicShareSlug(VALID, "sessKeyA");
    expect(valid.found).toBe(true);
    expect(valid.throttled).toBe(false);
    expect(valid.html).toContain("pcc-manifest");
  });

  it("one caller's misses NEVER suppress another caller's valid link (per-key)", () => {
    seed(VALID, "Valid", "public");
    let last = resolvePublicShareSlug("y-000000000000000000000000", "attackerKey");
    for (let i = 0; i < 40 && !last.throttled; i++) last = resolvePublicShareSlug(`y-${i}`, "attackerKey");
    expect(last.throttled).toBe(true);
    // A different caller's valid request is unaffected.
    const other = resolvePublicShareSlug(VALID, "innocentKey");
    expect(other.found).toBe(true);
    expect(other.throttled).toBe(false);
  });

  it("a read with NO session identity is never throttled (no shared bucket to abuse)", () => {
    let res = resolvePublicShareSlug("z-000000000000000000000000", null);
    for (let i = 0; i < 40; i++) res = resolvePublicShareSlug(`z-${i}`, null);
    expect(res.found).toBe(false);
    expect(res.throttled).toBe(false);
  });
});
