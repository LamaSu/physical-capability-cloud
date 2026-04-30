import { eq } from "drizzle-orm";
import { orchestratorSessions } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type {
  IOrchestratorSessionRepository,
  SessionInsert,
  SessionRow,
} from "../interfaces/IOrchestratorSessionRepository.js";

/**
 * Wave 4.3 — Drizzle-backed orchestrator session store.
 *
 * One row per onboarding session. Used by the gateway's
 * `OrchestratorSessionStore` adapter (see
 * packages/gateway/src/services/orchestrator-session-store.ts) to back the
 * orchestrator-sdk's pluggable `SessionStore` interface.
 */
export class OrchestratorSessionRepository implements IOrchestratorSessionRepository {
  constructor(private db: StoreDB) {}

  upsert(row: SessionInsert): SessionRow | undefined {
    return this.db
      .insert(orchestratorSessions)
      .values(row)
      .onConflictDoUpdate({
        target: orchestratorSessions.id,
        set: {
          name: row.name,
          url: row.url ?? null,
          contactEmail: row.contactEmail ?? null,
          state: row.state,
          capabilities: row.capabilities ?? null,
          dataSources: row.dataSources ?? null,
          backend: row.backend ?? null,
          agent: row.agent ?? null,
          extras: row.extras ?? null,
          tenantId: row.tenantId ?? null,
          updatedAt: row.updatedAt,
        },
      })
      .returning()
      .get();
  }

  findById(id: string): SessionRow | undefined {
    return this.db
      .select()
      .from(orchestratorSessions)
      .where(eq(orchestratorSessions.id, id))
      .get();
  }

  delete(id: string): void {
    this.db.delete(orchestratorSessions).where(eq(orchestratorSessions.id, id)).run();
  }

  findAll(): SessionRow[] {
    // TODO(wave-4.1): scope by tenant when RLS lands.
    return this.db.select().from(orchestratorSessions).all();
  }
}
