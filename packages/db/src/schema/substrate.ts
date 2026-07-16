/**
 * Substrate persistence — Drizzle tables backing the five "agentic substrate"
 * gateway routes that shipped as in-memory scaffolds:
 *
 *   compose.ts        → compositions, composition_candidates, composition_executions
 *   reputation.ts     → agent_reputations, reputation_deltas,
 *                       composition_step_outcomes, composition_step_disputes
 *   asset-outbound.ts → asset_budgets, outbound_demands
 *   skills.ts         → skill_capabilities, skill_jobs
 *   graph-search.ts   → graph_search_nodes, graph_search_edges, graph_search_proposals
 *
 * Each row keeps the exact domain object in a `data` JSON column for lossless
 * round-trips, alongside the scalar columns the routes filter / sort / dedup on.
 * Flat objects (asset_budgets, agent_reputations) are stored column-only and
 * reconstructed field-by-field — they mutate in place, so a single source of
 * truth avoids JSON/column drift.
 *
 * Mirrors the marketplace / requests persistence pattern. Indexes live in the
 * runtime migration (packages/db/src/migrate.ts) — the gateway's migration is a
 * single better-sqlite3 exec(), not drizzle-kit — and in the matching
 * migrations/0003_substrate_persistence.sql for the drizzle-kit path.
 */

import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import type {
  ComposeResponse,
  CompositionCandidate,
  ExecuteCompositionResponse,
  CompositionStepOutcome,
  CompositionStepDispute,
  OutboundDemandResponse,
  SkillCapability,
  SkillJob,
  ReputationDelta,
  CapabilityGraphNode,
  CapabilityGraphEdge,
  GraphSearchRequest,
  GraphPathOption,
  UiArtifact,
} from "@pcc/spec";

// ── compose.ts ───────────────────────────────────────────────────────────

/** One proposed composition (ComposeResponse), retrievable by id until TTL. */
export const compositions = sqliteTable("compositions", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  totalPriceUsd: real("total_price_usd").notNull().default(0),
  stepCount: integer("step_count").notNull().default(0),
  requesterAgentId: text("requester_agent_id"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  data: text("data", { mode: "json" }).notNull().$type<ComposeResponse>(),
});

/** Scaffold candidate pool the in-memory provider plans against. */
export const compositionCandidates = sqliteTable("composition_candidates", {
  capabilityId: text("capability_id").primaryKey(),
  kernelId: text("kernel_id").notNull(),
  operatorAddress: text("operator_address").notNull(),
  capabilityType: text("capability_type").notNull(),
  estimatedPriceUsd: real("estimated_price_usd").notNull(),
  estimatedDurationMs: integer("estimated_duration_ms").notNull(),
  assuranceTier: integer("assurance_tier").notNull(),
  reputation: integer("reputation"),
  available: integer("available", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  data: text("data", { mode: "json" }).notNull().$type<CompositionCandidate>(),
});

/** Execute results keyed by compositionId — replayed for idempotent re-execute. */
export const compositionExecutions = sqliteTable("composition_executions", {
  compositionId: text("composition_id").primaryKey(),
  workflowId: text("workflow_id").notNull(),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull(),
  createdAt: text("created_at").notNull(),
  data: text("data", { mode: "json" }).notNull().$type<ExecuteCompositionResponse>(),
});

// ── reputation.ts ────────────────────────────────────────────────────────

/** Running reputation state per agent (flat object, column-stored). */
export const agentReputations = sqliteTable("agent_reputations", {
  agentId: text("agent_id").primaryKey(),
  kind: text("kind").notNull(),
  score: integer("score").notNull(),
  positiveContributions: integer("positive_contributions").notNull().default(0),
  negativeContributions: integer("negative_contributions").notNull().default(0),
  disputesUpheld: integer("disputes_upheld").notNull().default(0),
  disputesRejected: integer("disputes_rejected").notNull().default(0),
  lastUpdatedAt: text("last_updated_at").notNull(),
  createdAt: text("created_at").notNull(),
});

/**
 * Append-only reputation delta log. `seq` (autoincrement rowid) preserves
 * insertion order so deltas can be returned newest-first via ORDER BY seq DESC,
 * matching the in-memory Map's reverse-insertion behaviour.
 */
export const reputationDeltas = sqliteTable("reputation_deltas", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  deltaId: text("delta_id").notNull(),
  agentId: text("agent_id").notNull(),
  delta: real("delta").notNull(),
  reason: text("reason").notNull(),
  compositionId: text("composition_id"),
  stepIndex: integer("step_index"),
  appliedAt: text("applied_at").notNull(),
  createdAt: text("created_at").notNull(),
  data: text("data", { mode: "json" }).notNull().$type<ReputationDelta>(),
});

/** Per-step execution outcome; unique on (composition_id, step_index). */
export const compositionStepOutcomes = sqliteTable("composition_step_outcomes", {
  outcomeId: text("outcome_id").primaryKey(),
  compositionId: text("composition_id").notNull(),
  stepIndex: integer("step_index").notNull(),
  agentId: text("agent_id").notNull(),
  capabilityId: text("capability_id").notNull(),
  status: text("status").notNull(),
  finalReputationApplied: integer("final_reputation_applied", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: text("created_at").notNull(),
  data: text("data", { mode: "json" }).notNull().$type<CompositionStepOutcome>(),
});

/** Per-step dispute records. */
export const compositionStepDisputes = sqliteTable("composition_step_disputes", {
  disputeId: text("dispute_id").primaryKey(),
  compositionId: text("composition_id").notNull(),
  stepIndex: integer("step_index").notNull(),
  disputerDid: text("disputer_did").notNull(),
  status: text("status").notNull(),
  resolution: text("resolution"),
  resolvedAt: text("resolved_at"),
  createdAt: text("created_at").notNull(),
  data: text("data", { mode: "json" }).notNull().$type<CompositionStepDispute>(),
});

// ── asset-outbound.ts ────────────────────────────────────────────────────

/** Per-asset spend envelope (flat object, column-stored, mutated in place). */
export const assetBudgets = sqliteTable("asset_budgets", {
  assetId: text("asset_id").primaryKey(),
  ownerDid: text("owner_did").notNull(),
  budgetCapUsd: real("budget_cap_usd").notNull(),
  dailyCapUsd: real("daily_cap_usd").notNull(),
  spentTodayUsd: real("spent_today_usd").notNull().default(0),
  spentLifetimeUsd: real("spent_lifetime_usd").notNull().default(0),
  allowedCapabilityTypes: text("allowed_capability_types", { mode: "json" }).$type<string[]>(),
  requiresOwnerApproval: integer("requires_owner_approval", { mode: "boolean" }),
  lastResetAt: text("last_reset_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Posted outbound demands (OutboundDemandResponse). */
export const outboundDemands = sqliteTable("outbound_demands", {
  demandId: text("demand_id").primaryKey(),
  assetId: text("asset_id").notNull(),
  status: text("status").notNull(),
  rejectionReason: text("rejection_reason"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  data: text("data", { mode: "json" }).notNull().$type<OutboundDemandResponse>(),
});

// ── skills.ts ────────────────────────────────────────────────────────────

/** Human-node skill capabilities (SkillCapability). */
export const skillCapabilities = sqliteTable("skill_capabilities", {
  id: text("id").primaryKey(),
  humanDid: text("human_did").notNull(),
  skillType: text("skill_type").notNull(),
  hourlyRateUsd: real("hourly_rate_usd").notNull(),
  reputation: integer("reputation").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  data: text("data", { mode: "json" }).notNull().$type<SkillCapability>(),
});

/** Skill jobs (SkillJob) — hire → accept → start → complete lifecycle. */
export const skillJobs = sqliteTable("skill_jobs", {
  jobId: text("job_id").primaryKey(),
  skillId: text("skill_id").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  data: text("data", { mode: "json" }).notNull().$type<SkillJob>(),
});

// ── graph-search.ts ──────────────────────────────────────────────────────

/** Capability graph nodes (CapabilityGraphNode), keyed by capabilityId. */
export const graphSearchNodes = sqliteTable("graph_search_nodes", {
  capabilityId: text("capability_id").primaryKey(),
  capabilityType: text("capability_type").notNull(),
  kernelId: text("kernel_id").notNull(),
  estimatedPriceUsd: real("estimated_price_usd").notNull(),
  estimatedDurationMs: integer("estimated_duration_ms").notNull(),
  assuranceTier: integer("assurance_tier").notNull(),
  reputation: integer("reputation").notNull().default(0),
  available: integer("available", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  data: text("data", { mode: "json" }).notNull().$type<CapabilityGraphNode>(),
});

/** Capability graph edges, keyed by `${fromCapabilityId}->${toCapabilityId}`. */
export const graphSearchEdges = sqliteTable("graph_search_edges", {
  id: text("id").primaryKey(),
  fromCapabilityId: text("from_capability_id").notNull(),
  toCapabilityId: text("to_capability_id").notNull(),
  capabilityTypeFlow: text("capability_type_flow").notNull(),
  createdAt: text("created_at").notNull(),
  data: text("data", { mode: "json" }).notNull().$type<CapabilityGraphEdge>(),
});

/**
 * Search proposals (30-min TTL). `search_stats_json` carries the response meta
 * ({ searchStats, outcomeType, optimizedFor, proposedAt }) so the full
 * GraphSearchResponse can be reconstructed on read.
 */
export const graphSearchProposals = sqliteTable("graph_search_proposals", {
  id: text("id").primaryKey(),
  requestJson: text("request_json", { mode: "json" }).notNull().$type<GraphSearchRequest>(),
  optionsJson: text("options_json", { mode: "json" }).notNull().$type<GraphPathOption[]>(),
  searchStatsJson: text("search_stats_json", { mode: "json" })
    .notNull()
    .$type<Record<string, unknown>>(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

// ── artifacts.ts (On-Ramp UI artifacts) ───────────────────────────────────

/**
 * UI dashboard artifacts (UiArtifact) — saved/shared/forkable dashboards.
 * The full record lives in the `data` JSON column for lossless round-trips;
 * scalar columns back the discovery filters (visibility, capability_types,
 * popularity counts) and the slug/owner lookups. Durable SQLite persistence is
 * the whole point (survives redeploy — the CSD-registry gap, G5).
 */
export const uiArtifacts = sqliteTable("ui_artifacts", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  owner: text("owner").notNull(),
  visibility: text("visibility").notNull().default("unlisted"),
  status: text("status").notNull().default("active"),
  capabilityTypes: text("capability_types", { mode: "json" }).$type<string[]>(),
  useCount: integer("use_count").notNull().default(0),
  loadCount: integer("load_count").notNull().default(0),
  forkCount: integer("fork_count").notNull().default(0),
  forkOf: text("fork_of"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  data: text("data", { mode: "json" }).notNull().$type<UiArtifact>(),
});

/**
 * Expiring HASHED aliases from a ROTATED legacy share slug to its artifact
 * (R4 PR4 / D13). When a weak (~24-bit) unlisted/public slug is rotated to a
 * ≥96-bit one, an entry is written here so the OLD link keeps resolving for a
 * bounded window (~30d) before it lapses. The old slug is NOT stored in
 * plaintext — `slug_hash` is sha256(old-slug), so this table is not an
 * enumerable list of retired slugs, and lookup is O(1) by primary key. The
 * public resolver honours an alias ONLY while `now < expires_at` AND the target
 * artifact is still active + public|unlisted (the alias never widens visibility).
 */
export const legacySlugAliases = sqliteTable("legacy_slug_aliases", {
  slugHash: text("slug_hash").primaryKey(), // sha256(old-slug) hex — no plaintext slug stored
  artifactId: text("artifact_id").notNull(),
  expiresAt: text("expires_at").notNull(), // ISO-8601; alias resolves only while now < expires_at
  createdAt: text("created_at").notNull(),
});
