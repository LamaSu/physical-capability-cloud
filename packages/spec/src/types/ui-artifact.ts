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
// Manifest building blocks
// ---------------------------------------------------------------------------

/** A live-data binding: which route a window reads, how often, what to pluck. */
export const BindingSchema = z.object({
  /** "/api/…" route the window reads. */
  path: z.string().min(1),
  /** Optional query params merged onto the request. */
  query: z.record(z.unknown()).optional(),
  /** Poll cadence in ms (falls back to the system_prompt's ~30s default). */
  pollMs: z.number().int().positive().optional(),
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
});
export type Action = z.infer<typeof ActionSchema>;

/** ActionRef — a window's referenced action (form submit, approve/deny, chain execute). */
export const ActionRefSchema = ActionSchema;
export type ActionRef = Action;

const MetricFormat = z.enum(["usd", "int", "pct", "ts"]);

/** One row descriptor for a `list` window. */
export const ListItemSchema = z.object({
  title: z.string().min(1),
  meta: z.array(z.string()).default([]),
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
    limit: z.number().int().positive().optional(),
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
  z.object({ kind: z.literal("actions"), actions: z.array(ActionSchema).min(1) }),
]);
export type Window = z.infer<typeof WindowSchema>;

/** One ordered section of the dashboard. */
export const SectionSchema = z.object({
  heading: z.string().optional(),
  windows: z.array(WindowSchema),
});
export type Section = z.infer<typeof SectionSchema>;

// ---------------------------------------------------------------------------
// The manifest itself + the no-key refine.
// ---------------------------------------------------------------------------

/**
 * True if the JSON value contains a live/test API-key substring ANYWHERE.
 *
 * Exported so the gateway can apply the SAME predicate to the whole
 * create/update body (name/description/capabilityTypes/composeRefs), not just
 * the manifest the `.refine` below guards — those top-level fields are stored
 * AND publicly returned (and `name` renders into the `/a/:slug` HTML), so a
 * baked key would still travel with a shared artifact (§3, §5.2, acceptance #2).
 */
export function containsApiKey(value: unknown): boolean {
  const s = JSON.stringify(value ?? null);
  return s.includes("pcc_live_") || s.includes("pcc_test_");
}

const DashboardManifestBase = z.object({
  csd: z.literal(DASHBOARD_CSD_URL),
  title: z.string().min(1),
  description: z.string().optional(),
  /** default https://capability.network */
  api_base: z.string().optional(),
  theme: z.enum(["auto", "dark", "light"]).optional(),
  sections: z.array(SectionSchema),
});

/**
 * The dashboard manifest. The `.refine` rejects any `pcc_live_`/`pcc_test_`
 * substring ANYWHERE in the manifest — SHARE means the artifact travels, so a
 * baked key would travel with it. Cheap; catches the dumb mistake (§3, §5.2,
 * acceptance #2).
 */
export const DashboardManifestSchema = DashboardManifestBase.refine(
  (m) => !containsApiKey(m),
  {
    message:
      "manifest must not contain an API key (pcc_live_/pcc_test_ substring) — a shared artifact travels with its contents",
    path: ["_security"],
  },
);
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
