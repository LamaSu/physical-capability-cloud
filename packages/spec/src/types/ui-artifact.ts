/**
 * UI Artifact — the PCC On-Ramp's first-class network entity.
 *
 * A `UiArtifact` is a saved/shared/forkable DASHBOARD: a small declarative
 * `DashboardManifest` (windows + data bindings + actions) that the person's own
 * LLM emits when a task needs a surface, and the shipped `pcc-ui` kit renders
 * identically everywhere. Saving the manifest to the network turns it into a
 * durable artifact with a live URL (`/a/:slug`).
 *
 * This file is the ONE schema mechanism (§5.1 of the On-Ramp spec):
 *   - `DashboardManifestSchema` — the manifest the LLM emits, incl. the no-key
 *     `.refine` (a saved/shared manifest must never carry an API key, §3/§5.2).
 *   - `UiArtifactSchema` — the record the network stores (§5.2).
 *   - Create / Update / Fork input schemas for the gateway routes (§5.3).
 *
 * Design invariants (why, not just what):
 *   - Windows are a closed discriminated union — shared artifacts are untrusted
 *     content, so the kit can render them `textContent`-only. No raw HTML/JS.
 *   - `Action.confirm` is `"inline" | "approval"` with NO `"none"` — a human
 *     gesture is the confirmation step; nothing auto-fires (§4.2).
 *   - `composeRefs` pins re-plannable `ComposeRequest`s, never compositionIds
 *     (30-min TTL, G7).
 *   - `capabilityTypes[]` is the discovery join to the capability catalog (G9 —
 *     a dashboard is NOT a `capabilities` row).
 */

import { z } from "zod";
import { ComposeRequestSchema } from "./composition.js";

// ---------------------------------------------------------------------------
// Canonical CSD URI for the dashboard manifest type.
// MUST match the `url` of the builtin CSD in ../csd/builtins/dashboard-v1.ts.
// ---------------------------------------------------------------------------

export const DASHBOARD_CSD_URL = "pcc://artifacts/dashboard/v1" as const;

// ---------------------------------------------------------------------------
// Manifest resource caps. A shared/popular dashboard is untrusted content that
// many viewers render, so it must not be able to DoS the gateway or a browser
// (fast-polling many authenticated bindings, or a pathologically large tree).
// A real dashboard is 2–6KB; these bounds are generous (sol security pass #7).
// ---------------------------------------------------------------------------

export const MIN_POLL_MS = 2000;
export const MAX_SECTIONS = 24;
export const MAX_WINDOWS_PER_SECTION = 24;
export const MAX_ACTIONS_PER_WINDOW = 24;
export const MAX_LIST_LIMIT = 200;
export const MAX_MANIFEST_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Manifest building blocks
// ---------------------------------------------------------------------------

/** A live-data binding: which route a window reads, how often, what to pluck. */
export const BindingSchema = z.object({
  /** "/api/…" route the window reads. */
  path: z.string().min(1),
  /** Optional query params merged onto the request. */
  query: z.record(z.unknown()).optional(),
  /** Poll cadence in ms (falls back to the system_prompt's ~30s default).
   *  Floored at MIN_POLL_MS so a shared dashboard can't fast-poll authenticated
   *  endpoints (sol security pass #7). */
  pollMs: z.number().int().min(MIN_POLL_MS).optional(),
  /** Optional SSE stream "/sse/stream/…" (fetch-SSE with Bearer, G4). */
  sse: z.string().min(1).optional(),
  /** Dot-path into the response (e.g. "data.jobs.0.status"). NOT JSONPath. */
  select: z.string().optional(),
});
export type Binding = z.infer<typeof BindingSchema>;

/**
 * A write the surface can perform. Fires ONLY on a human click; nothing on load.
 * `confirm` has NO "none" — the click IS the confirm step (§4.2). Money-moving
 * verbs use `confirm:"approval"` (the kit's Approval window).
 */
export const ActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["post", "patch"]),
  path: z.string().min(1),
  /** Form id whose collected values become the request body. */
  bodyFrom: z.string().optional(),
  /** Static body merged into the request. */
  body: z.record(z.unknown()).optional(),
  /** "inline" = button confirm; "approval" = the kit's Approval window. NO "none". */
  confirm: z.enum(["inline", "approval"]),
  /** Field id supplying an idempotencyKey (required on offer-posting actions). */
  idempotencyFrom: z.string().optional(),
  /** Snapshot-mode chip text handed back to the LLM (e.g. "pcc: approve offer …"). */
  intentText: z.string().min(1),
  /**
   * R4 PR2 — typed host-mediated operation id. When present, a hosted (MCP-App)
   * view routes the click to the registered `pcc.op.<operationId>` tool via the
   * host's `tools/call` instead of the raw HTTP `kind`/`path` (which is inert in
   * host mode). The SERVER registry (packages/gateway/src/mcp/operation-policy.ts)
   * is the allowlist: an unregistered id stays inert. Standalone/non-host
   * rendering ignores this and uses `kind`/`path` unchanged. Must be an explicit
   * optional field so it survives schema parsing (z.object strips unknown keys).
   */
  operation_id: z.string().min(1).optional(),
  /** Bounded arguments for the typed operation (host mode only). The manifest
   *  supplies ONLY these; the server strips any actor/tenant/operator id and
   *  fixes server-owned fields (e.g. job status). Guarded by the no-key refine. */
  arguments: z.record(z.unknown()).optional(),
});
export type Action = z.infer<typeof ActionSchema>;

/** ActionRef — a window's referenced action (form submit, approve/deny, chain execute). */
export const ActionRefSchema = ActionSchema;
export type ActionRef = Action;

const MetricFormat = z.enum(["usd", "int", "pct", "ts"]);

/** One row descriptor for a `list` window. */
export const ListItemSchema = z.object({
  title: z.string().min(1),
  // capped — meta selectors are looped per rendered row; unbounded = render DoS (sol re-review #7)
  meta: z.array(z.string()).max(12).default([]),
  statusFrom: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Window discriminated union (§6.1). Closed set — the kit renders each kind
// textContent-only. Extending the vocabulary = a new kit version, never
// per-artifact code.
// ---------------------------------------------------------------------------

export const WindowSchema = z.discriminatedUnion("kind", [
  // prose; textContent only
  z.object({ kind: z.literal("note"), text: z.string() }),
  // single scalar with formatting
  z.object({
    kind: z.literal("metric"),
    label: z.string().min(1),
    binding: BindingSchema,
    select: z.string().optional(),
    format: MetricFormat.optional(),
  }),
  // one catalog row (price + trust + assurance)
  z.object({ kind: z.literal("capability"), binding: BindingSchema }),
  // a collection
  z.object({
    kind: z.literal("list"),
    binding: BindingSchema,
    item: ListItemSchema,
    limit: z.number().int().positive().max(MAX_LIST_LIMIT).optional(),
  }),
  // a form; submit is an ActionRef
  z.object({
    kind: z.literal("form"),
    schema: z.record(z.unknown()),
    submit: ActionRefSchema,
  }),
  // live status + collapsed event feed (fetch-SSE or poll)
  z.object({
    kind: z.literal("run"),
    binding: BindingSchema,
    statusFrom: z.string(),
    latestFrom: z.string(),
  }),
  // what/who/cost block; only Approve fires the POST
  z.object({
    kind: z.literal("approval"),
    binding: BindingSchema,
    approve: ActionRefSchema,
    deny: ActionRefSchema.optional(),
  }),
  // amount, payer→payee, rail, event timeline, tx ids
  z.object({ kind: z.literal("receipt"), binding: BindingSchema }),
  // value-chain plan/step view; pins a re-plannable ComposeRequest (G7)
  z.object({
    kind: z.literal("chain"),
    composeRef: ComposeRequestSchema,
    execute: ActionRefSchema.optional(),
  }),
  // a bare action bar
  z.object({
    kind: z.literal("actions"),
    actions: z.array(ActionSchema).min(1).max(MAX_ACTIONS_PER_WINDOW),
  }),
]);
export type Window = z.infer<typeof WindowSchema>;

/** One ordered section of the dashboard. */
export const SectionSchema = z.object({
  heading: z.string().optional(),
  windows: z.array(WindowSchema).max(MAX_WINDOWS_PER_SECTION),
});
export type Section = z.infer<typeof SectionSchema>;

// ---------------------------------------------------------------------------
// The manifest itself + the no-key refine.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Canonical PCC API-key prefixes — SINGLE SOURCE OF TRUTH, shared with the auth
// layer. `packages/gateway/src/auth/api-key-auth.ts` derives its live prefix
// from PCC_API_KEY_LIVE_PREFIX; `sse-auth.ts` rejects the whole set in query
// strings; `containsApiKey` (below) uses the set to guard the SHARE boundary.
// A raw PCC key is `<prefix><hex secret>`. One definition, no drift.
// ---------------------------------------------------------------------------

export const PCC_API_KEY_LIVE_PREFIX = "pcc_live_" as const;
export const PCC_API_KEY_TEST_PREFIX = "pcc_test_" as const;
export const PCC_API_KEY_PREFIXES = [
  PCC_API_KEY_LIVE_PREFIX,
  PCC_API_KEY_TEST_PREFIX,
] as const;

/**
 * Object-key names that must never carry a baked credential VALUE inside a
 * shared manifest/body (confused-deputy / credential-transport guard). Compared
 * after normalization (lowercased, `_`/`-` stripped), so api_key / apiKey /
 * API-KEY / apikey all collapse to a single entry.
 */
const SENSITIVE_FIELD_NAMES: ReadonlySet<string> = new Set([
  "token",
  "apikey",
  "authorization",
  "bearer",
  "secret",
  "password",
  "privatekey",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "sessiontoken",
]);

function normalizeFieldName(k: string): string {
  return k.toLowerCase().replace(/[_-]/g, "");
}

/**
 * Percent-decode up to a few passes so an ENCODED prefix can't slip past
 * (`pcc%5Flive%5F…`, `%70%63%63_live_…`, double-encoded). Fails open: a fully
 * malformed sequence falls back to a lenient per-token decode, never throws.
 */
function decodePercentDeep(s: string): string {
  let cur = s;
  for (let i = 0; i < 3; i++) {
    if (cur.indexOf("%") === -1) break;
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      next = cur.replace(/%[0-9a-fA-F]{2}/g, (m) => {
        try {
          return decodeURIComponent(m);
        } catch {
          return m;
        }
      });
    }
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/**
 * True if a single string carries a PCC key prefix, tolerant of CASE and
 * PERCENT-ENCODING — so `PCC_LIVE_…`, `pcc%5Flive%5F…`, `%70%63%63_live_…` all
 * match, not just the exact lowercase literal.
 */
// A `Bearer <token>` header value, or a JWT (three base64url segments starting
// `eyJ`), baked into a shared manifest is a credential leak regardless of the
// PCC prefix (sol security pass, finding #10).
// Require the token after "Bearer" to have CREDENTIAL shape (≥20 chars AND at
// least one digit or dot) — real bearer tokens/JWTs have those; ordinary prose
// like "Bearer authentication" does not, so it is not a false positive (sol
// re-review #10). A JWT after Bearer is also caught by JWT_RE below.
const BEARER_RE = /\bbearer\s+(?=[A-Za-z0-9._~+/\-]{20,})[A-Za-z0-9._~+/\-]*[\d.][A-Za-z0-9._~+/\-]*/i;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/;

/** Bounded base64/base64url decode; returns "" on anything that isn't clean
 *  base64 of a plausible length (so an encoded PCC prefix can't slip past). */
function tryBase64Decode(raw: string): string {
  if (raw.length < 12 || raw.length > 8192) return "";
  const s = raw.trim();
  if (!/^[A-Za-z0-9+/_=-]+$/.test(s)) return "";
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    // atob is universal (browser + Node ≥16 global); fall back to Buffer.
    const dec =
      typeof atob === "function"
        ? atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="))
        : Buffer.from(b64, "base64").toString("latin1");
    return dec;
  } catch {
    return "";
  }
}

function stringHasKeyPrefix(raw: string): boolean {
  const forms = new Set<string>([raw, raw.toLowerCase()]);
  const decoded = decodePercentDeep(raw);
  if (decoded !== raw) {
    forms.add(decoded);
    forms.add(decoded.toLowerCase());
  }
  // Bounded base64 decode — a PCC key stuffed inside a base64 blob still leaks.
  const b64 = tryBase64Decode(raw);
  if (b64) {
    forms.add(b64);
    forms.add(b64.toLowerCase());
  }
  for (const form of forms) {
    for (const prefix of PCC_API_KEY_PREFIXES) {
      if (form.indexOf(prefix) !== -1) return true;
    }
  }
  // Vendor-agnostic authorization credentials (Bearer / JWT) in any string.
  if (BEARER_RE.test(raw) || JWT_RE.test(raw)) return true;
  return false;
}

/**
 * True if `value` IS, or contains anywhere, a PCC API key — the defense-in-depth
 * guard for the SHARE boundary (a saved/shared manifest travels with its
 * contents, so a baked key would leak; §3, §5.2, acceptance #2).
 *
 * Exported so the gateway applies the SAME predicate to the whole create/update
 * body (name/description/capabilityTypes/composeRefs), not just the manifest the
 * `.refine` below guards. Recursively walks EVERY nested string — URLs, query
 * values, action paths, form defaults, labels, descriptions, snapshots,
 * composeRefs — and rejects on either:
 *   1. a string carrying a `pcc_live_`/`pcc_test_` prefix, tolerant of case and
 *      percent-encoding (so an encoded/upper-cased prefix can't slip past); or
 *   2. an object KEY named like a credential (token/apiKey/api_key/authorization/
 *      bearer/secret/password/privateKey/…) that holds a concrete scalar VALUE —
 *      a baked credential. A credential-shaped NAME is ALLOWED when its value is
 *      an object/array (a nested schema/definition — e.g. a form field named
 *      `password` in a JSON-Schema `properties` block is a field DEFINITION, not
 *      a baked secret), so benign form schemas are not false-positives.
 *
 * The primary guarantee stays architectural (a manifest is not a credential
 * transport — Round 1); this is cheap, conservative defense-in-depth. Robust
 * against cycles / pathological depth (visited set + node budget); an
 * oversized/degenerate input fails CLOSED (budget exhaustion returns true =
 * treat as key-bearing and reject, sol pass #5), never hangs.
 */
export function containsApiKey(value: unknown): boolean {
  const seen = new WeakSet<object>();
  // Node budget. A manifest large enough to exhaust this is pathological — the
  // route also enforces MAX_MANIFEST_BYTES below, so a legitimate dashboard
  // never approaches it. FAIL CLOSED on exhaustion (return true = "treat as
  // key-bearing", reject) so a caller cannot pad an object with ~budget filler
  // nodes to push a trailing key past the scan (sol security pass, finding #5).
  let budget = 20000;

  function walk(v: unknown): boolean {
    if (budget-- <= 0) return true;
    if (typeof v === "string") return stringHasKeyPrefix(v);
    if (typeof v !== "object" || v === null) return false;
    if (seen.has(v)) return false;
    seen.add(v);

    if (Array.isArray(v)) {
      for (const item of v) if (walk(item)) return true;
      return false;
    }

    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      // (2) credential-named field holding a concrete scalar = baked secret.
      // An object/array value under the same name is a definition — recurse,
      // don't auto-flag.
      if (SENSITIVE_FIELD_NAMES.has(normalizeFieldName(k))) {
        if (typeof val === "string" && val.trim().length > 0) return true;
        if (typeof val === "number" && Number.isFinite(val)) return true;
      }
      if (walk(val)) return true;
    }
    return false;
  }

  return walk(value);
}

const DashboardManifestBase = z.object({
  csd: z.literal(DASHBOARD_CSD_URL),
  title: z.string().min(1),
  description: z.string().optional(),
  // ADVISORY ONLY — retained because host-mode consumers (mcp-app-view) still
  // read it. Live transport is HARD-BOUND to the render origin by the kit and
  // this is IGNORED for fetches: a manifest that could name its own fetch host
  // would let a shared dashboard redirect the viewer's Bearer key to an attacker
  // origin (sol security pass #1). The ENFORCING fix is the kit-side origin
  // hard-bind (staged); this field must NEVER be used as a transport destination.
  api_base: z.string().optional(),
  theme: z.enum(["auto", "dark", "light"]).optional(),
  sections: z.array(SectionSchema).max(MAX_SECTIONS),
});

/**
 * The dashboard manifest. The `.refine` rejects any `pcc_live_`/`pcc_test_`
 * substring ANYWHERE in the manifest — SHARE means the artifact travels, so a
 * baked key would travel with it. Cheap; catches the dumb mistake (§3, §5.2,
 * acceptance #2).
 *
 * Source model, NOT a wire format (audit directive 18). `DashboardManifest` is
 * PCC's SOURCE model for a dashboard. Consumers ADAPT it: the MCP Apps bridge
 * (packages/gateway/src/mcp/mcp-app-view.ts) delivers it as MCP Apps
 * `structuredContent` for a fixed predeclared HTML view. It is NOT itself an A2UI
 * (a2ui.org) wire format, and PCC intentionally ships NO A2UI transport and NO
 * in-repo Atelier producer — those adapters are deferred until there is a
 * concrete non-MCP consumer that needs declarative, streamed, native UI. Until
 * then MCP Apps is the ONE UI transport (F11/directive 18); do not claim this
 * manifest is A2UI, and add an A2UI/Atelier adapter only against a real consumer.
 */
export const DashboardManifestSchema = DashboardManifestBase
  // Size guard FIRST — a real dashboard is 2–6KB. Rejecting oversized manifests
  // up front bounds the node walk below (so it never hits its fail-closed
  // budget on legitimate input) and blocks resource exhaustion (sol #5/#7).
  // Measure UTF-8 BYTES (TextEncoder is universal in browser + Node) — .length
  // counts UTF-16 code units, so non-ASCII could be ~3x larger than it appears
  // and slip past a code-unit check (sol re-review #7).
  .refine((m) => new TextEncoder().encode(JSON.stringify(m)).length <= MAX_MANIFEST_BYTES, {
    message: `manifest exceeds ${MAX_MANIFEST_BYTES} bytes (a dashboard is 2–6KB)`,
    path: ["_size"],
  })
  .refine((m) => !containsApiKey(m), {
    message:
      "manifest must not contain a credential (pcc_live_/pcc_test_ key, Bearer token, or JWT — raw, encoded, or base64) — a shared artifact travels with its contents",
    path: ["_security"],
  });
export type DashboardManifest = z.infer<typeof DashboardManifestSchema>;

// ---------------------------------------------------------------------------
// The stored record (§5.2)
// ---------------------------------------------------------------------------

export const ArtifactVisibilitySchema = z.enum(["private", "unlisted", "public"]);
export type ArtifactVisibility = z.infer<typeof ArtifactVisibilitySchema>;

export const UiArtifactSchema = z.object({
  /** "ua_<uuid>" */
  id: z.string().min(1),
  /** short, unguessable-enough for unlisted, e.g. "watch-pizza-8k3f" */
  slug: z.string().min(1),
  csd: z.literal(DASHBOARD_CSD_URL),
  name: z.string().min(1),
  description: z.string().optional(),
  /** THE artifact — the 2–6KB manifest (§6). */
  manifest: DashboardManifestSchema,
  /** Discovery join to the capability catalog, e.g. ["pizza.order"]. */
  capabilityTypes: z.array(z.string()).default([]),
  /** Pinned re-plannable value-chain requests (G7). */
  composeRefs: z.array(ComposeRequestSchema).optional(),
  visibility: ArtifactVisibilitySchema,
  /** operatorId (or key-derived id) of the caller who saved it. */
  owner: z.string().min(1),
  /** Lineage: the artifact this was forked from. */
  forkOf: z.string().optional(),
  useCount: z.number().int().nonnegative().default(0),
  loadCount: z.number().int().nonnegative().default(0),
  forkCount: z.number().int().nonnegative().default(0),
  /** Optional rendered-HTML export CID via existing /api/storage (G11). */
  renderedCid: z.string().optional(),
  /** Optional Story-IP id (owner-gated, ships dark). */
  storyIpId: z.string().optional(),
  /** Soft-retire flag — DELETE flips this; ids/slugs are never reused (§5.3). */
  status: z.enum(["active", "retired"]).default("active"),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int().positive().default(1),
});
export type UiArtifact = z.infer<typeof UiArtifactSchema>;

// ---------------------------------------------------------------------------
// Route input schemas (§5.3)
// ---------------------------------------------------------------------------

/** POST /api/artifacts — save/publish. owner + slug + id are minted server-side. */
export const CreateUiArtifactSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  manifest: DashboardManifestSchema,
  capabilityTypes: z.array(z.string()).optional(),
  composeRefs: z.array(ComposeRequestSchema).optional(),
  /** default "unlisted" on publish (§5.4); applied in the route. */
  visibility: ArtifactVisibilitySchema.optional(),
  renderedCid: z.string().optional(),
});
export type CreateUiArtifactInput = z.infer<typeof CreateUiArtifactSchema>;

/** PUT /api/artifacts/:id — owner modify; version++. */
export const UpdateUiArtifactSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  manifest: DashboardManifestSchema.optional(),
  capabilityTypes: z.array(z.string()).optional(),
  composeRefs: z.array(ComposeRequestSchema).optional(),
  visibility: ArtifactVisibilitySchema.optional(),
  renderedCid: z.string().optional(),
});
export type UpdateUiArtifactInput = z.infer<typeof UpdateUiArtifactSchema>;

/** POST /api/artifacts/:id/fork — optional new name/visibility. */
export const ForkUiArtifactSchema = z.object({
  name: z.string().min(1).optional(),
  visibility: ArtifactVisibilitySchema.optional(),
});
export type ForkUiArtifactInput = z.infer<typeof ForkUiArtifactSchema>;
