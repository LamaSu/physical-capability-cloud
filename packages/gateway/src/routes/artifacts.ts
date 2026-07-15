/**
 * UI Artifact registry — gateway routes (On-Ramp Wave 1).
 *
 * Makes dashboards a first-class, durable, shareable network entity. A person's
 * LLM emits a `DashboardManifest`, saves it here, and hands the person a live
 * URL (`/a/:slug`) that the shipped `pcc-ui` kit renders. Endpoints (§5.3):
 *
 *   POST   /api/artifacts             — save/publish (Bearer; validates manifest
 *                                        + key-refusal; mints slug; owner=caller)
 *   GET    /api/artifacts/:idOrSlug   — recall (public if public/unlisted,
 *                                        owner-only if private; loadCount++)
 *   GET    /api/artifacts?...         — discover (public listing; filter by
 *                                        capabilityType, FTS-lite q, sort)
 *   PUT    /api/artifacts/:id         — modify (owner; version++)
 *   POST   /api/artifacts/:id/fork    — fork (Bearer; forkOf lineage)
 *   DELETE /api/artifacts/:id         — soft-retire (owner; status flip)
 *   GET    /a/:slug                   — the render shell (CSP-compliant HTML)
 *
 * Storage: SQLite via @pcc/store (ui_artifacts) — following the skills.ts /
 * compose.ts marketplace persistence pattern, so artifacts survive gateway
 * redeploys (the CSD-registry gap, G5). The full UiArtifact lives in a JSON
 * column alongside the scalar columns the discovery filters use.
 *
 * Pattern fidelity: Zod `safeParse` guards every body/query, error responses
 * use the `{ error, message, details? }` shape, ids are minted with
 * `randomUUID()`, and store access uses the lazy-init helper from compose.ts.
 *
 * Security invariants (§12): the manifest schema forbids API-key substrings
 * anywhere (acceptance #2); the `/a/:slug` shell is textContent / JSON-inlined
 * only — no innerHTML, no raw HTML from the manifest; private visibility is
 * owner-gated. Dashboards are NOT `capabilities` rows; artifacts are NOT stored
 * as runtime CSDs.
 */

import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CreateUiArtifactSchema,
  UpdateUiArtifactSchema,
  ForkUiArtifactSchema,
  DASHBOARD_CSD_URL,
  containsApiKey,
  type UiArtifact,
} from "@pcc/spec";
import { schema, eq } from "@pcc/store";
import { getStore, initStore } from "../db.js";
import { resolveApiKey } from "../auth/api-key-auth.js";

// ---------------------------------------------------------------------------
// Legacy share-slug rotation + expiring aliases (R4 PR4 / D13)
//
// Weak (~24-bit) legacy slugs are rotated to ≥96-bit ones (see uniqueSlug), and
// an EXPIRING HASHED alias is written so the OLD link keeps resolving for a
// bounded window. The alias key is sha256(old-slug) — the old slug itself is
// never stored — and it never widens visibility (the resolver re-applies the
// active + public|unlisted gate after dereferencing an alias).
// ---------------------------------------------------------------------------

/** ~30 days — the bounded window a rotated legacy link keeps resolving. */
const LEGACY_ALIAS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** sha256(old-slug) hex — the alias primary key (no plaintext slug is stored). */
function legacyAliasHash(slug: string): string {
  return createHash("sha256").update(slug).digest("hex");
}

/** Write a one-time expiring alias old-slug → artifactId. Idempotent: an existing
 * alias for the same hash is kept (a slug is rotated at most once). */
function writeLegacyAlias(oldSlug: string, artifactId: string, now: Date, ttlMs: number): void {
  db()
    .insert(schema.legacySlugAliases)
    .values({
      slugHash: legacyAliasHash(oldSlug),
      artifactId,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      createdAt: now.toISOString(),
    })
    .onConflictDoNothing()
    .run();
}

/** Resolve a slug through a LIVE (unexpired) legacy alias to its artifact id, or
 * undefined when there is no alias or it has lapsed. An expired alias resolves to
 * nothing — the old link is gone, indistinguishable from a never-seen slug. */
function resolveLiveAliasArtifactId(slug: string): string | undefined {
  const row = db()
    .select()
    .from(schema.legacySlugAliases)
    .where(eq(schema.legacySlugAliases.slugHash, legacyAliasHash(slug)))
    .get();
  if (!row) return undefined;
  if (new Date(row.expiresAt).getTime() <= Date.now()) return undefined;
  return row.artifactId;
}

/**
 * A slug minted by the OLD scheme: human prefix + "-" + exactly 6 hex chars
 * (~24 bits). Strong slugs carry a 24- or 32-hex suffix, so they never match;
 * a slug with no hex suffix (never minted this way) never matches either. Only
 * the final hyphen-delimited segment is inspected, so a hex-looking base word is
 * irrelevant. This is the idempotency discriminator for the rotation below.
 */
export function isWeakLegacySlug(slug: string): boolean {
  const m = /-([0-9a-f]+)$/.exec(slug);
  return m !== null && m[1].length === 6;
}

export interface LegacySlugRotationSummary {
  scanned: number;
  rotated: number;
  aliasesWritten: number;
  /** Already-strong active public|unlisted slugs left untouched (idempotency). */
  skippedStrong: number;
  /** {id, newSlug} per rotated artifact. The OLD slug is deliberately NOT logged
   * in plaintext — only its sha256 lives in the alias table. */
  rotated_ids: Array<{ id: string; newSlug: string }>;
}

/**
 * ONE-TIME, IDEMPOTENT migration: rotate every ACTIVE public|unlisted artifact
 * whose slug is a weak (~24-bit) legacy slug to a fresh ≥96-bit slug, writing an
 * expiring hashed alias so the old link keeps resolving for `ttlMs` (~30d).
 *
 * Idempotent by construction: a rotated artifact then carries a STRONG slug, so a
 * re-run skips it (isWeakLegacySlug → false); the alias insert is conflict-safe.
 * Private/retired artifacts are never enumerable share targets, so they are left
 * as-is. Operates on the same store the routes use (call initStore() first).
 *
 * Each artifact's slug rotation + alias insert run in ONE DB transaction, so a
 * failure between them can never strand a rotated slug without its alias
 * (re-audit #2). A mid-run failure leaves already-processed artifacts fully
 * rotated and the failing one fully rolled back; a re-run then completes the rest.
 */
export function rotateLegacyShareSlugs(
  opts: {
    ttlMs?: number;
    now?: Date;
    /** Alias-write sink, injectable for tests / alternate sinks. Defaults to the
     *  built-in expiring-hashed-alias writer. Runs INSIDE the per-artifact
     *  transaction, so if it throws the slug rotation rolls back (atomicity). */
    aliasWriter?: (oldSlug: string, artifactId: string, now: Date, ttlMs: number) => void;
  } = {},
): LegacySlugRotationSummary {
  const ttlMs = opts.ttlMs ?? LEGACY_ALIAS_TTL_MS;
  const now = opts.now ?? new Date();
  const aliasWriter = opts.aliasWriter ?? writeLegacyAlias;
  const summary: LegacySlugRotationSummary = {
    scanned: 0,
    rotated: 0,
    aliasesWritten: 0,
    skippedStrong: 0,
    rotated_ids: [],
  };
  for (const a of listArtifacts()) {
    summary.scanned++;
    if (a.status !== "active") continue;
    if (a.visibility !== "public" && a.visibility !== "unlisted") continue;
    if (!isWeakLegacySlug(a.slug)) {
      summary.skippedStrong++;
      continue;
    }
    const oldSlug = a.slug;
    const newSlug = uniqueSlug(a.name); // fresh ≥96-bit slug, human prefix kept
    a.slug = newSlug;
    a.updatedAt = now.toISOString();
    // Atomic per-artifact (re-audit #2): the slug rotation + the alias insert commit
    // together or not at all. A crash/throw BETWEEN them would otherwise strand a
    // rotated slug with NO alias — the old share link would 404 with no recovery.
    // One DB transaction guarantees an artifact is never left half-rotated.
    db().transaction(() => {
      saveArtifact(a); // updates both the slug column and data.slug
      aliasWriter(oldSlug, a.id, now, ttlMs);
    });
    summary.rotated++;
    summary.aliasesWritten++;
    summary.rotated_ids.push({ id: a.id, newSlug });
  }
  return summary;
}

/**
 * Opaque per-caller key for the failed-lookup limiter: a truncated SHA-256 of the
 * raw caller identity (IP or MCP session id, namespaced by `kind`). Hashing keeps
 * plaintext IPs out of the in-memory map and gives each MCP session its OWN bucket
 * — there is no shared global bucket that one caller's misses could use to gate
 * another caller (R4 PR4 / D13).
 */
export function hashLookupKey(kind: string, raw: string): string {
  return createHash("sha256").update(`${kind}|${raw}`).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Store access — see compose.ts / skills.ts for the lazy-init rationale.
// ---------------------------------------------------------------------------

function db() {
  try {
    return getStore().db;
  } catch {
    if (
      (process.env.VITEST || process.env.NODE_ENV === "test") &&
      !process.env.PCC_DB_PATH &&
      !process.env.DATABASE_URL
    ) {
      process.env.PCC_DB_PATH = ":memory:";
    }
    return initStore({ seed: false }).db;
  }
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// ---------------------------------------------------------------------------
// Caller identity
// ---------------------------------------------------------------------------

/**
 * Resolve the caller's owner id, consistently across gated mutations and the
 * ungated `/a/:slug` render route:
 *   1. req.operatorId — set by apiGate on gated /api/* mutations (production).
 *   2. resolveApiKey(req) — the real operator, resolved here so ungated routes
 *      (/a/:slug) still identify a key holder. Wrapped: getRepos() throws
 *      before the store is initialised.
 *   3. Fallback — a stable id derived from the Bearer token itself, for the
 *      bare-Fastify test harness (no apiGate, empty api_keys table) and any
 *      path where (1)+(2) yield nothing. Same token gives the same id.
 * Returns null when no Bearer credential is present.
 */
function resolveCaller(req: FastifyRequest): string | null {
  const opId = (req as unknown as { operatorId?: string | null }).operatorId;
  if (opId) return String(opId);

  try {
    const key = resolveApiKey(req);
    if (key) return String(key.operatorId);
  } catch {
    // Store not initialised yet — fall through to the token-derived id.
  }

  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return "anon_" + createHash("sha256").update(token).digest("hex").slice(0, 24);
  }
  return null;
}

/** Whether `caller` may read `a` given its visibility. */
function canRead(a: UiArtifact, caller: string | null): boolean {
  if (a.visibility === "public" || a.visibility === "unlisted") return true;
  return caller !== null && a.owner === caller;
}

// ---------------------------------------------------------------------------
// Slug minting
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "dashboard";
}

/**
 * A crypto-random hex suffix so unlisted/public slugs are NOT enumerable
 * (directive 13). `randomBytes` is a CSPRNG; `bytes` bytes → `bytes*8` bits of
 * entropy → `bytes*2` hex chars.
 *
 * NEW links use SLUG_SUFFIX_BYTES = 12 → 96 random bits (the audit floor),
 * replacing the old 6-hex-char / 24-bit suffix. EXISTING slugs are NOT rewritten
 * — they are looked up by exact string, so short legacy slugs keep resolving;
 * only newly-minted links get the wider suffix. No redirect/migration is needed
 * (nothing changes the stored slug of an existing artifact).
 */
const SLUG_SUFFIX_BYTES = 12; // 96 bits
const SLUG_SUFFIX_BYTES_FALLBACK = 16; // 128 bits, used only on the rare clash

function randomSuffix(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** Mint a slug not already taken (96-bit random suffix; widened on the rare clash). */
function uniqueSlug(name: string): string {
  const base = slugify(name);
  for (let i = 0; i < 5; i++) {
    const candidate = `${base}-${randomSuffix(SLUG_SUFFIX_BYTES)}`;
    if (!getBySlug(candidate)) return candidate;
  }
  return `${base}-${randomSuffix(SLUG_SUFFIX_BYTES_FALLBACK)}`;
}

// ---------------------------------------------------------------------------
// Failed-lookup rate limiting (anti-enumeration, directive 13)
//
// A sliding-window counter of FAILED public lookups per caller key. The limit is
// checked ONLY on the MISS path, AFTER the store lookup has run: a resolvable,
// readable artifact is served BEFORE the limiter is ever consulted, so a
// KNOWN-VALID link can never be suppressed by accumulated misses (this caller's
// or, crucially, another caller's). Only a burst of MISSES (the enumeration
// signature) trips the limit. This is defense-in-depth — the primary
// anti-enumeration guarantee is the ≥96-bit slug entropy above.
//
// Keying (R4 PR4 / D13): every key is an OPAQUE hash (hashLookupKey) of the raw
// caller identity — the HTTP routes hash `req.ip`, the MCP `resources/read` share
// path hashes the host session id. There is NO shared global bucket: the previous
// `mcp:anon` bucket was removed because it let one anonymous session's misses gate
// another's. An MCP read with no session identity is simply not throttled — safe,
// because the lookup still runs (valid links are always served) and every miss
// returns the identical not-found (no existence oracle regardless).
// ---------------------------------------------------------------------------

const FAILED_LOOKUP_WINDOW_MS = 60_000;
const FAILED_LOOKUP_MAX = 30; // failed public lookups per key per window
const FAILED_LOOKUP_MAX_KEYS = 10_000; // memory bound on the tracking map
const failedLookups = new Map<string, number[]>();

function freshFailures(key: string, now: number): number[] {
  const arr = failedLookups.get(key);
  if (!arr) return [];
  return arr.filter((t) => now - t < FAILED_LOOKUP_WINDOW_MS);
}

/** True when `key` has exceeded the failed-lookup budget in the current window
 * (read-only; does not record). Callers should short-circuit to a generic
 * response — never one that reveals whether a given artifact exists. */
export function publicLookupThrottled(key: string): boolean {
  return freshFailures(key, Date.now()).length >= FAILED_LOOKUP_MAX;
}

/** Record one FAILED (miss/forbidden) public lookup for `key`. */
export function notePublicLookupFailure(key: string): void {
  const now = Date.now();
  const arr = freshFailures(key, now);
  arr.push(now);
  failedLookups.set(key, arr);
  if (failedLookups.size > FAILED_LOOKUP_MAX_KEYS) {
    for (const [k, v] of failedLookups) {
      const fresh = v.filter((t) => now - t < FAILED_LOOKUP_WINDOW_MS);
      if (fresh.length === 0) failedLookups.delete(k);
      else failedLookups.set(k, fresh);
    }
  }
}

/** Test reset hook for the failed-lookup limiter. */
export function _resetPublicLookupLimiterForTests(): void {
  failedLookups.clear();
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function listArtifacts(): UiArtifact[] {
  return db().select().from(schema.uiArtifacts).all().map((r) => r.data as UiArtifact);
}

function getById(id: string): UiArtifact | undefined {
  const row = db().select().from(schema.uiArtifacts).where(eq(schema.uiArtifacts.id, id)).get();
  return row ? (row.data as UiArtifact) : undefined;
}

function getBySlug(slug: string): UiArtifact | undefined {
  const row = db().select().from(schema.uiArtifacts).where(eq(schema.uiArtifacts.slug, slug)).get();
  return row ? (row.data as UiArtifact) : undefined;
}

function getByIdOrSlug(idOrSlug: string): UiArtifact | undefined {
  return getById(idOrSlug) ?? getBySlug(idOrSlug);
}

/** Valid slug format — lowercase alnum with internal hyphens (exactly what
 * slugify() mints). Rejects an id (`ua_…`, underscores), uppercase, spaces, or
 * junk, so the public share surface accepts only a well-formed slug. Length cap
 * accommodates the 96-bit suffix (base ≤40 + "-" + 24 hex = 65; 128-bit clash
 * fallback = 73) with headroom, while still bounding the input. */
function isValidSlugFormat(slug: string): boolean {
  return slug.length <= 80 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug);
}

/**
 * Resolve a well-formed slug to its artifact via an exact LIVE slug OR a LIVE
 * (unexpired) legacy alias (sha256(old-slug) → id, R4 PR4 / D13), applying NO
 * visibility/status gate — the caller applies its own. Format-validates first
 * (SLUG ONLY, never an id), so malformed input, unknown slugs, and lapsed
 * aliases all return undefined identically. A rotated weak legacy link keeps
 * resolving through its alias until the alias expires.
 */
function resolveBySlugOrLiveAlias(slug: string): UiArtifact | undefined {
  if (typeof slug !== "string" || !isValidSlugFormat(slug)) return undefined;
  const direct = getBySlug(slug);
  if (direct) return direct;
  const id = resolveLiveAliasArtifactId(slug);
  return id ? getById(id) : undefined;
}

/**
 * Look up an artifact for the no-auth PUBLIC SHARE surface (the MCP-Apps
 * `ui://pcc/dashboard/<slug>` resource read — see mcp/mcp-app-view.ts). Accepts
 * a well-formed SLUG ONLY (never an id — a resource read must not double as an
 * id oracle), resolving an exact live slug OR a live legacy alias, and returns
 * the artifact ONLY if it exists, is active, and is publicly readable
 * (public|unlisted) via `canRead(a, null)`. An alias NEVER widens visibility:
 * the active + public|unlisted gate is re-applied after dereferencing. This is a
 * PASSIVE read: it does NOT mutate loadCount/updatedAt (unlike GET
 * /api/artifacts/:id, which is an explicit recall). Private artifacts are never
 * exposed here; a host embeds the returned view with no PCC credential. Same
 * process, same store as POST /api/artifacts, so a saved dashboard is the exact
 * one rendered.
 */
export function getPublicArtifactForRender(slug: string): UiArtifact | undefined {
  const a = resolveBySlugOrLiveAlias(slug);
  if (!a || a.status === "retired") return undefined;
  return canRead(a, null) ? a : undefined;
}

function saveArtifact(a: UiArtifact): void {
  const cols = {
    slug: a.slug,
    owner: a.owner,
    visibility: a.visibility,
    status: a.status,
    capabilityTypes: a.capabilityTypes,
    useCount: a.useCount,
    loadCount: a.loadCount,
    forkCount: a.forkCount,
    forkOf: a.forkOf ?? null,
    version: a.version,
    updatedAt: a.updatedAt,
    data: a,
  };
  db()
    .insert(schema.uiArtifacts)
    .values({ id: a.id, createdAt: a.createdAt, ...cols })
    .onConflictDoUpdate({ target: schema.uiArtifacts.id, set: cols })
    .run();
}

// ---------------------------------------------------------------------------
// HTML render shell (`/a/:slug`) — CSP-compliant, textContent/JSON-inlined only
// ---------------------------------------------------------------------------

/** HTML-escape a string for safe interpolation into element text/attributes. */
function escapeHtml(s: string): string {
  return s
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split('"').join("&quot;")
    .split("'").join("&#39;");
}

/**
 * Serialize the manifest for a `<script type="application/json">` data block.
 * `<script>` is a raw-text element — only `</script` (and `<!--`) can end it —
 * so escaping `<` and `>` to their JSON `\u00XX` forms fully prevents a
 * breakout. The result is valid JSON that `JSON.parse` accepts. (U+2028/U+2029
 * are harmless in a non-executable data block, so need no special handling.)
 */
function inlineManifestJson(manifest: unknown): string {
  return JSON.stringify(manifest)
    .split("<").join("\\u003c")
    .split(">").join("\\u003e");
}

/**
 * The render shell (§5.3). Loads the same-origin kit and inlines the manifest.
 * Degrades gracefully pre-Wave-2: if `/ui-kit/v1/pcc-ui.js` 404s, the plain
 * "Loading the PCC dashboard kit" placeholder simply remains — not an error.
 * No inline executable script is needed, and no manifest content is ever placed
 * in the DOM as HTML.
 */
function renderShell(a: UiArtifact): string {
  const title = escapeHtml(a.manifest.title || a.name);
  const desc = a.manifest.description ? `<p>${escapeHtml(a.manifest.description)}</p>` : "";
  const theme = escapeHtml(a.manifest.theme ?? "auto");
  const slug = escapeHtml(a.slug);
  const manifestJson = inlineManifestJson(a.manifest);
  return `<!doctype html>
<html lang="en" data-pcc-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - PCC</title>
</head>
<body>
<main id="pcc-root" data-slug="${slug}">
  <header>
    <h1>${title}</h1>
    ${desc}
  </header>
  <p id="pcc-kit-status">Loading the PCC dashboard kit&hellip;</p>
</main>
<script type="application/json" id="pcc-manifest">${manifestJson}</script>
<script src="/ui-kit/v1/pcc-ui.js" defer></script>
</body>
</html>`;
}

function htmlMessage(heading: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)} - PCC</title></head>
<body><main id="pcc-root"><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
}

// ---------------------------------------------------------------------------
// Query schema (GET /api/artifacts)
// ---------------------------------------------------------------------------

const ListArtifactsQuerySchema = z.object({
  capabilityType: z.string().min(1).optional(),
  q: z.string().min(1).optional(),
  sort: z.enum(["popular", "recent"]).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
});

function popularityScore(a: UiArtifact): number {
  return a.useCount + a.loadCount + a.forkCount;
}

// ---------------------------------------------------------------------------
// Small reply helpers (mirror skills.ts error shape)
// ---------------------------------------------------------------------------

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({
    error: "unauthorized",
    message: "This endpoint requires an Authorization: Bearer <key> header.",
  });
}

function notFound(reply: FastifyReply, idOrSlug: string): FastifyReply {
  return reply.status(404).send({
    error: "not_found",
    message: `No artifact with id/slug=${idOrSlug}`,
  });
}

function forbidden(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(403).send({ error: "forbidden", message });
}

/**
 * §2(a) key-refusal, extended beyond the manifest. The manifest's own no-key
 * `.refine` runs inside safeParse; this covers the top-level create/update
 * fields (name / description / capabilityTypes / composeRefs / renderedCid)
 * that are ALSO stored and publicly returned — `name` even renders into the
 * `/a/:slug` HTML — so a key baked into any of them would travel with a shared
 * artifact. Scans the whole validated body; returns a 400 reply when a key is
 * present, else null.
 */
function rejectIfBodyHasKey(reply: FastifyReply, body: unknown): FastifyReply | null {
  if (!containsApiKey(body)) return null;
  return reply.status(400).send({
    error: "invalid_body",
    message:
      "Invalid artifact body — no field may contain an API key (pcc_live_/pcc_test_ substring); a shared artifact travels with its contents.",
  });
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function artifactsRoutes(app: FastifyInstance): Promise<void> {
  // ═════════════════════════════════════════════════════════════════
  // POST /api/artifacts — save / publish
  // ═════════════════════════════════════════════════════════════════

  app.post("/api/artifacts", async (req, reply) => {
    const caller = resolveCaller(req);
    if (!caller) return unauthorized(reply);

    const parsed = CreateUiArtifactSchema.safeParse(req.body);
    if (!parsed.success) {
      // A key baked into the manifest fails the schema's no-key refine here.
      return reply.status(400).send({
        error: "invalid_body",
        message:
          "Invalid artifact body — the manifest must conform to the dashboard schema and must not contain an API key.",
        details: parsed.error.flatten(),
      });
    }
    const keyReject = rejectIfBodyHasKey(reply, parsed.data);
    if (keyReject) return keyReject;

    const now = new Date().toISOString();
    const artifact: UiArtifact = {
      id: `ua_${randomUUID()}`,
      slug: uniqueSlug(parsed.data.name),
      csd: DASHBOARD_CSD_URL,
      name: parsed.data.name,
      description: parsed.data.description,
      manifest: parsed.data.manifest,
      capabilityTypes: parsed.data.capabilityTypes ?? [],
      composeRefs: parsed.data.composeRefs,
      visibility: parsed.data.visibility ?? "unlisted", // §5.4 default
      owner: caller,
      useCount: 0,
      loadCount: 0,
      forkCount: 0,
      renderedCid: parsed.data.renderedCid,
      status: "active",
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    saveArtifact(artifact);
    return reply.status(201).send(artifact);
  });

  // ═════════════════════════════════════════════════════════════════
  // GET /api/artifacts — public discovery (filter + sort + paginate)
  // ═════════════════════════════════════════════════════════════════

  app.get("/api/artifacts", async (req, reply) => {
    const parsed = ListArtifactsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_query",
        message: "Invalid query params",
        details: parsed.error.flatten(),
      });
    }
    const q = parsed.data;

    // Only PUBLIC + active artifacts are listed. Unlisted load by slug but are
    // absent from listings; private are never listed (acceptance #8).
    let list = listArtifacts().filter((a) => a.status === "active" && a.visibility === "public");

    if (q.capabilityType !== undefined) {
      const t = q.capabilityType;
      list = list.filter((a) => a.capabilityTypes.includes(t));
    }
    if (q.q !== undefined) {
      const needle = q.q.toLowerCase();
      list = list.filter((a) =>
        `${a.name} ${a.description ?? ""} ${a.capabilityTypes.join(" ")}`
          .toLowerCase()
          .includes(needle),
      );
    }

    if (q.sort === "popular") {
      list.sort((a, b) => popularityScore(b) - popularityScore(a));
    } else {
      // recent (default)
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    const offset = q.offset ?? 0;
    const limit = q.limit ?? DEFAULT_LIMIT;
    const total = list.length;
    const entries = list.slice(offset, offset + limit);
    return { entries, total, offset, limit };
  });

  // ═════════════════════════════════════════════════════════════════
  // GET /api/artifacts/:idOrSlug — recall (loadCount++)
  // ═════════════════════════════════════════════════════════════════

  app.get<{ Params: { idOrSlug: string } }>(
    "/api/artifacts/:idOrSlug",
    async (req, reply) => {
      // Recall API — keeps id-or-slug lookup (owners recall by id) and its
      // owner-gated 403/404 contract. The limiter is consulted AFTER the lookup:
      // a readable artifact is served regardless of throttle state, so a valid
      // recall is never suppressed by accumulated misses (R4 PR4 / D13).
      const rateKey = hashLookupKey("ip", req.ip || "unknown");
      const a = getByIdOrSlug(req.params.idOrSlug);
      const caller = resolveCaller(req);

      if (a && a.status !== "retired" && canRead(a, caller)) {
        a.loadCount += 1;
        a.updatedAt = new Date().toISOString();
        saveArtifact(a);
        return a;
      }

      // Miss (missing / retired / private-to-non-owner) — now subject to the
      // per-caller (hashed-IP) limiter.
      notePublicLookupFailure(rateKey);
      if (publicLookupThrottled(rateKey)) {
        return reply.status(429).send({
          error: "rate_limited",
          message: "Too many lookups. Please slow down and try again shortly.",
        });
      }
      if (!a || a.status === "retired") return notFound(reply, req.params.idOrSlug);
      return forbidden(reply, "This artifact is private.");
    },
  );

  // ═════════════════════════════════════════════════════════════════
  // PUT /api/artifacts/:id — owner modify (version++)
  // ═════════════════════════════════════════════════════════════════

  app.put<{ Params: { id: string } }>("/api/artifacts/:id", async (req, reply) => {
    const caller = resolveCaller(req);
    if (!caller) return unauthorized(reply);

    const a = getById(req.params.id);
    if (!a || a.status === "retired") return notFound(reply, req.params.id);
    if (a.owner !== caller) return forbidden(reply, "Only the owner may modify this artifact.");

    const parsed = UpdateUiArtifactSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_body",
        message:
          "Invalid update body — the manifest must conform to the dashboard schema and must not contain an API key.",
        details: parsed.error.flatten(),
      });
    }
    const keyReject = rejectIfBodyHasKey(reply, parsed.data);
    if (keyReject) return keyReject;

    const u = parsed.data;
    if (u.name !== undefined) a.name = u.name;
    if (u.description !== undefined) a.description = u.description;
    if (u.manifest !== undefined) a.manifest = u.manifest;
    if (u.capabilityTypes !== undefined) a.capabilityTypes = u.capabilityTypes;
    if (u.composeRefs !== undefined) a.composeRefs = u.composeRefs;
    if (u.visibility !== undefined) a.visibility = u.visibility;
    if (u.renderedCid !== undefined) a.renderedCid = u.renderedCid;
    a.version += 1;
    a.updatedAt = new Date().toISOString();
    saveArtifact(a);
    return a;
  });

  // ═════════════════════════════════════════════════════════════════
  // POST /api/artifacts/:id/fork — fork (forkOf lineage, source forkCount++)
  // ═════════════════════════════════════════════════════════════════

  app.post<{ Params: { id: string } }>(
    "/api/artifacts/:id/fork",
    async (req, reply) => {
      const caller = resolveCaller(req);
      if (!caller) return unauthorized(reply);

      const src = getById(req.params.id);
      if (!src || src.status === "retired") return notFound(reply, req.params.id);
      if (!canRead(src, caller)) return forbidden(reply, "Cannot fork a private artifact you do not own.");

      const parsed = ForkUiArtifactSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_body",
          message: "Invalid fork body",
          details: parsed.error.flatten(),
        });
      }

      const now = new Date().toISOString();
      const name = parsed.data.name ?? `${src.name} (fork)`;
      const fork: UiArtifact = {
        ...src,
        id: `ua_${randomUUID()}`,
        slug: uniqueSlug(name),
        name,
        owner: caller,
        forkOf: src.id,
        visibility: parsed.data.visibility ?? "unlisted",
        useCount: 0,
        loadCount: 0,
        forkCount: 0,
        renderedCid: undefined,
        storyIpId: undefined,
        status: "active",
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      saveArtifact(fork);

      // Record the remix on the source.
      src.forkCount += 1;
      src.updatedAt = now;
      saveArtifact(src);

      return reply.status(201).send(fork);
    },
  );

  // ═════════════════════════════════════════════════════════════════
  // DELETE /api/artifacts/:id — owner soft-retire (never hard-delete; §5.3)
  // ═════════════════════════════════════════════════════════════════

  app.delete<{ Params: { id: string } }>("/api/artifacts/:id", async (req, reply) => {
    const caller = resolveCaller(req);
    if (!caller) return unauthorized(reply);

    const a = getById(req.params.id);
    if (!a || a.status === "retired") return notFound(reply, req.params.id);
    if (a.owner !== caller) return forbidden(reply, "Only the owner may retire this artifact.");

    a.status = "retired";
    a.updatedAt = new Date().toISOString();
    saveArtifact(a);
    return { retired: true, id: a.id };
  });

  // ═════════════════════════════════════════════════════════════════
  // GET /a/:slug — the render shell (public per visibility; non-/api → ungated)
  // ═════════════════════════════════════════════════════════════════

  app.get<{ Params: { slug: string } }>("/a/:slug", async (req, reply) => {
    // Public SHARE surface (R4 PR4 / D13): SLUG-ONLY (no id fallback — a share
    // link is not an id oracle), resolving an exact slug OR a live legacy alias.
    const rateKey = hashLookupKey("ip", req.ip || "unknown");
    const a = resolveBySlugOrLiveAlias(req.params.slug);
    const caller = resolveCaller(req);

    if (a && a.status !== "retired" && canRead(a, caller)) {
      // Known-valid + readable → serve BEFORE the limiter is consulted, so a valid
      // link is never suppressed by accumulated misses (this caller's or another's).
      a.loadCount += 1;
      a.updatedAt = new Date().toISOString();
      saveArtifact(a);
      return reply.type("text/html; charset=utf-8").send(renderShell(a));
    }

    // Every non-serve reason — private (to a non-owner), retired, missing,
    // malformed, or an expired alias — collapses to ONE generic not-found: no
    // existence oracle, no 403-vs-404 leak. Only now is the per-caller limiter
    // consulted; a throttled caller gets a generic 429 (returned identically for
    // ALL miss reasons, so it never distinguishes a private slug from a missing
    // one — throttling reveals no private existence).
    notePublicLookupFailure(rateKey);
    if (publicLookupThrottled(rateKey)) {
      return reply
        .status(429)
        .type("text/html; charset=utf-8")
        .send(htmlMessage("Too many requests", "Please slow down and try again shortly."));
    }
    return reply
      .status(404)
      .type("text/html; charset=utf-8")
      .send(htmlMessage("Dashboard not found", "No dashboard exists at this link, or it is no longer available."));
  });
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

/** Clear the artifact store. Test reset hook. */
export function _clearArtifactsForTests(): void {
  db().delete(schema.uiArtifacts).run();
  db().delete(schema.legacySlugAliases).run();
}

/** Preload a fully-formed artifact into the store. Test helper. */
export function _seedArtifactForTests(a: UiArtifact): void {
  saveArtifact(a);
}

/** Seed a legacy alias old-slug → artifactId with an explicit expiry. Test helper
 * for the expiry path (a past `expiresAt` must resolve to nothing). */
export function _seedLegacyAliasForTests(oldSlug: string, artifactId: string, expiresAt: string): void {
  db()
    .insert(schema.legacySlugAliases)
    .values({ slugHash: legacyAliasHash(oldSlug), artifactId, expiresAt, createdAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: schema.legacySlugAliases.slugHash,
      set: { artifactId, expiresAt },
    })
    .run();
}

/** Count stored legacy aliases. Test helper. */
export function _countLegacyAliasesForTests(): number {
  return db().select().from(schema.legacySlugAliases).all().length;
}
