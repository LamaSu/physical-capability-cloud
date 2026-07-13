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

import { randomUUID, createHash } from "node:crypto";
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

/** Short, unguessable-enough suffix so unlisted slugs aren't enumerable. */
function shortId(len: number): string {
  return randomUUID().replace(/-/g, "").slice(0, len);
}

/** Mint a slug not already taken (random suffix; retried on the rare clash). */
function uniqueSlug(name: string): string {
  const base = slugify(name);
  for (let i = 0; i < 5; i++) {
    const candidate = `${base}-${shortId(6)}`;
    if (!getBySlug(candidate)) return candidate;
  }
  return `${base}-${shortId(12)}`;
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

/**
 * Look up an artifact for a no-auth render surface (the MCP-Apps `ui://` resource
 * read — see mcp/mcp-app-view.ts). Returns the artifact ONLY if it exists, is
 * active, and is publicly readable (public|unlisted) — the same gate `/a/:slug`
 * applies for an anonymous caller (`canRead(a, null)`). Private artifacts are
 * never exposed here; a host embeds the returned view with no PCC credential.
 * Reuses the store helpers above so a dashboard saved via POST /api/artifacts is
 * the exact one the MCP resource renders (same process, same store).
 */
export function getPublicArtifactForRender(idOrSlug: string): UiArtifact | undefined {
  const a = getByIdOrSlug(idOrSlug);
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
      const a = getByIdOrSlug(req.params.idOrSlug);
      if (!a || a.status === "retired") return notFound(reply, req.params.idOrSlug);

      const caller = resolveCaller(req);
      if (!canRead(a, caller)) return forbidden(reply, "This artifact is private.");

      a.loadCount += 1;
      a.updatedAt = new Date().toISOString();
      saveArtifact(a);
      return a;
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
    const a = getBySlug(req.params.slug) ?? getById(req.params.slug);
    if (!a || a.status === "retired") {
      return reply
        .status(404)
        .type("text/html; charset=utf-8")
        .send(htmlMessage("Dashboard not found", "No dashboard exists at this link, or it has been retired."));
    }

    const caller = resolveCaller(req);
    if (!canRead(a, caller)) {
      return reply
        .status(403)
        .type("text/html; charset=utf-8")
        .send(htmlMessage("Private dashboard", "This dashboard is private. Ask its owner for access."));
    }

    a.loadCount += 1;
    a.updatedAt = new Date().toISOString();
    saveArtifact(a);

    return reply.type("text/html; charset=utf-8").send(renderShell(a));
  });
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

/** Clear the artifact store. Test reset hook. */
export function _clearArtifactsForTests(): void {
  db().delete(schema.uiArtifacts).run();
}

/** Preload a fully-formed artifact into the store. Test helper. */
export function _seedArtifactForTests(a: UiArtifact): void {
  saveArtifact(a);
}
