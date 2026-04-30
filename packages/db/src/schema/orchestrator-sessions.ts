import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * Wave 4.3 — Orchestrator session persistence.
 *
 * Backs the @pcc/orchestrator-sdk state-machine session map. The SDK keeps a
 * pluggable SessionStore interface; the gateway wires this drizzle-backed
 * repo as the active store at startup so onboarding sessions survive a
 * process restart.
 *
 * Design notes:
 * - JSON columns (`capabilities`, `data_sources`, `backend`, `agent`,
 *   `extras`) round-trip through JSON.stringify/parse. Drizzle's
 *   `{ mode: "json" }` handles this transparently.
 * - `tenant_id` is nullable for now; Wave 4.1 RLS scoping will populate it.
 *   See // TODO(wave-4.1) markers in the repo.
 * - `updated_at` is a millisecond epoch (matches OnboardSession.updated_at).
 *
 * Mirror DDL lives in packages/db/src/migrate.ts. Drizzle is used for the
 * ORM surface; the runtime migration is the raw SQL exec().
 */

interface OnboardSessionCapability {
  id: string;
  label: string;
  params_schema?: Record<string, unknown>;
  availability?: string;
}

interface OnboardSessionBackend {
  project_url: string;
  anon_key: string;
}

interface OnboardSessionAgent {
  url: string;
  marketplace_url?: string;
}

export const orchestratorSessions = sqliteTable("orchestrator_sessions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url"),
  contactEmail: text("contact_email"),
  state: text("state").notNull(),
  capabilities: text("capabilities", { mode: "json" }).$type<OnboardSessionCapability[]>(),
  dataSources: text("data_sources", { mode: "json" }).$type<unknown[]>(),
  backend: text("backend", { mode: "json" }).$type<OnboardSessionBackend>(),
  agent: text("agent", { mode: "json" }).$type<OnboardSessionAgent>(),
  extras: text("extras", { mode: "json" }).$type<Record<string, unknown>>(),
  tenantId: text("tenant_id"), // populated by future Wave 4.1 tenant scoping; nullable for now
  updatedAt: integer("updated_at").notNull(), // ms epoch
});
