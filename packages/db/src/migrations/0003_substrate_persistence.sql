-- 0003_substrate_persistence.sql
--
-- Substrate persistence for the five agentic-substrate gateway routes that
-- shipped as in-memory scaffolds (compose, asset-outbound, skills, reputation,
-- graph-search). Replaces the process-local Maps with durable SQLite tables so
-- state survives gateway redeploys.
--
-- These statements mirror the inline DDL in packages/db/src/migrate.ts (the
-- gateway's runtime migration is a single better-sqlite3 exec(), not
-- drizzle-kit) and the Drizzle table definitions in
-- packages/db/src/schema/substrate.ts. Each row keeps the exact domain object
-- in a `data` JSON column for lossless round-trips; flat objects (asset_budgets,
-- agent_reputations) are column-only.

-- ── compose ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compositions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  total_price_usd REAL NOT NULL DEFAULT 0,
  step_count INTEGER NOT NULL DEFAULT 0,
  requester_agent_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS compositions_status_idx ON compositions(status);
CREATE INDEX IF NOT EXISTS compositions_expires_idx ON compositions(expires_at);

CREATE TABLE IF NOT EXISTS composition_candidates (
  capability_id TEXT PRIMARY KEY,
  kernel_id TEXT NOT NULL,
  operator_address TEXT NOT NULL,
  capability_type TEXT NOT NULL,
  estimated_price_usd REAL NOT NULL,
  estimated_duration_ms INTEGER NOT NULL,
  assurance_tier INTEGER NOT NULL,
  reputation INTEGER,
  available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS composition_candidates_type_idx ON composition_candidates(capability_type);

CREATE TABLE IF NOT EXISTS composition_executions (
  composition_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);

-- ── reputation ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_reputations (
  agent_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  score INTEGER NOT NULL,
  positive_contributions INTEGER NOT NULL DEFAULT 0,
  negative_contributions INTEGER NOT NULL DEFAULT 0,
  disputes_upheld INTEGER NOT NULL DEFAULT 0,
  disputes_rejected INTEGER NOT NULL DEFAULT 0,
  last_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_reputations_kind_idx ON agent_reputations(kind);
CREATE INDEX IF NOT EXISTS agent_reputations_score_idx ON agent_reputations(score);

CREATE TABLE IF NOT EXISTS reputation_deltas (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  delta_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  delta REAL NOT NULL,
  reason TEXT NOT NULL,
  composition_id TEXT,
  step_index INTEGER,
  applied_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reputation_deltas_agent_idx ON reputation_deltas(agent_id);
CREATE INDEX IF NOT EXISTS reputation_deltas_composition_idx ON reputation_deltas(composition_id);
CREATE INDEX IF NOT EXISTS reputation_deltas_reason_idx ON reputation_deltas(reason);

CREATE TABLE IF NOT EXISTS composition_step_outcomes (
  outcome_id TEXT PRIMARY KEY,
  composition_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  status TEXT NOT NULL,
  final_reputation_applied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS composition_step_outcomes_step_uq
  ON composition_step_outcomes(composition_id, step_index);

CREATE TABLE IF NOT EXISTS composition_step_disputes (
  dispute_id TEXT PRIMARY KEY,
  composition_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  disputer_did TEXT NOT NULL,
  status TEXT NOT NULL,
  resolution TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS composition_step_disputes_composition_idx
  ON composition_step_disputes(composition_id);

-- ── asset-outbound ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS asset_budgets (
  asset_id TEXT PRIMARY KEY,
  owner_did TEXT NOT NULL,
  budget_cap_usd REAL NOT NULL,
  daily_cap_usd REAL NOT NULL,
  spent_today_usd REAL NOT NULL DEFAULT 0,
  spent_lifetime_usd REAL NOT NULL DEFAULT 0,
  allowed_capability_types TEXT,
  requires_owner_approval INTEGER,
  last_reset_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_demands (
  demand_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  status TEXT NOT NULL,
  rejection_reason TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS outbound_demands_asset_idx ON outbound_demands(asset_id);
CREATE INDEX IF NOT EXISTS outbound_demands_status_idx ON outbound_demands(status);

-- ── skills ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_capabilities (
  id TEXT PRIMARY KEY,
  human_did TEXT NOT NULL,
  skill_type TEXT NOT NULL,
  hourly_rate_usd REAL NOT NULL,
  reputation INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS skill_capabilities_type_idx ON skill_capabilities(skill_type);

CREATE TABLE IF NOT EXISTS skill_jobs (
  job_id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS skill_jobs_skill_idx ON skill_jobs(skill_id);

-- ── graph-search ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS graph_search_nodes (
  capability_id TEXT PRIMARY KEY,
  capability_type TEXT NOT NULL,
  kernel_id TEXT NOT NULL,
  estimated_price_usd REAL NOT NULL,
  estimated_duration_ms INTEGER NOT NULL,
  assurance_tier INTEGER NOT NULL,
  reputation INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS graph_search_nodes_type_idx ON graph_search_nodes(capability_type);

CREATE TABLE IF NOT EXISTS graph_search_edges (
  id TEXT PRIMARY KEY,
  from_capability_id TEXT NOT NULL,
  to_capability_id TEXT NOT NULL,
  capability_type_flow TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS graph_search_edges_from_idx ON graph_search_edges(from_capability_id);

CREATE TABLE IF NOT EXISTS graph_search_proposals (
  id TEXT PRIMARY KEY,
  request_json TEXT NOT NULL,
  options_json TEXT NOT NULL,
  search_stats_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
