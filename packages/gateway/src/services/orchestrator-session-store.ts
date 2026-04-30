import type { SessionStore, OnboardSession, OnboardState } from "@pcc/orchestrator-sdk";
import type {
  IOrchestratorSessionRepository,
  OrchestratorSessionRow,
  OrchestratorSessionInsert,
} from "@pcc/store";

/**
 * Wave 4.3 — gateway-side SessionStore adapter.
 *
 * Implements the orchestrator-sdk's SessionStore interface against the
 * SQLite-backed `OrchestratorSessionRepository`. The gateway calls
 * `setSessionStore(new OrchestratorSessionStore(repos.orchestratorSessions))`
 * exactly once at startup; thereafter every onboarder write/read flows
 * through SQLite, surviving process restarts.
 *
 * Field-shape translation:
 *   SDK (snake_case)            <->  Row (camelCase)
 *   contact_email                    contactEmail
 *   data_sources                     dataSources
 *   updated_at                       updatedAt
 *   capabilities/backend/agent/extras round-trip as JSON via drizzle's
 *   { mode: "json" } column type.
 */
export class OrchestratorSessionStore implements SessionStore {
  constructor(private repo: IOrchestratorSessionRepository) {}

  get(id: string): OnboardSession | undefined {
    const row = this.repo.findById(id);
    return row ? rowToSession(row) : undefined;
  }

  set(id: string, session: OnboardSession): void {
    // Defensive: ensure the row's id matches the requested key. The SDK
    // is the source of truth — Map.set takes (id, session) and overwrites
    // session.id implicitly, so we mirror that.
    const insert = sessionToRow({ ...session, id });
    this.repo.upsert(insert);
  }

  delete(id: string): void {
    this.repo.delete(id);
  }

  list(): OnboardSession[] {
    return this.repo.findAll().map(rowToSession);
  }
}

/** Convert a DB row to the SDK's OnboardSession shape. */
function rowToSession(row: OrchestratorSessionRow): OnboardSession {
  const session: OnboardSession = {
    id: row.id,
    name: row.name,
    state: row.state as OnboardState,
    updated_at: row.updatedAt,
  };
  if (row.url !== null && row.url !== undefined) session.url = row.url;
  if (row.contactEmail !== null && row.contactEmail !== undefined) {
    session.contact_email = row.contactEmail;
  }
  if (row.capabilities !== null && row.capabilities !== undefined) {
    session.capabilities = row.capabilities;
  }
  if (row.dataSources !== null && row.dataSources !== undefined) {
    session.data_sources = row.dataSources;
  }
  if (row.backend !== null && row.backend !== undefined) {
    session.backend = row.backend;
  }
  if (row.agent !== null && row.agent !== undefined) {
    session.agent = row.agent;
  }
  if (row.extras !== null && row.extras !== undefined) {
    session.extras = row.extras;
  }
  return session;
}

/** Convert an OnboardSession into a row insert payload. */
function sessionToRow(session: OnboardSession): OrchestratorSessionInsert {
  return {
    id: session.id,
    name: session.name,
    url: session.url ?? null,
    contactEmail: session.contact_email ?? null,
    state: session.state,
    capabilities: session.capabilities ?? null,
    dataSources: session.data_sources ?? null,
    backend: session.backend ?? null,
    agent: session.agent ?? null,
    extras: session.extras ?? null,
    tenantId: null, // TODO(wave-4.1): populate from tenant context
    updatedAt: session.updated_at,
  };
}
