import { createDatabase, type StoreDB } from "./connection.js";
import { migrateDatabase } from "./migrate.js";
import { buildRepositories, type Repositories } from "./repositories/index.js";
import { seedAll } from "./seed/index.js";
import * as schema from "./schema/index.js";

export interface StoreOptions {
  /** Path to SQLite file. Defaults to ":memory:" for in-memory database. */
  dbPath?: string;
  /** Whether to seed the database with mock data. Defaults to true. */
  seed?: boolean;
}

/**
 * Creates an in-memory (or file-backed) SQLite store with all tables,
 * repositories, and optionally seeded mock data.
 */
export interface Store {
  /** Drizzle ORM database instance */
  db: StoreDB;
  /** Pre-built repository instances for each domain */
  repos: Repositories;
  /** Close the underlying SQLite connection */
  close: () => void;
}

export function createStore(options: StoreOptions = {}): Store {
  const { db, sqlite } = createDatabase(options.dbPath);

  // Create all tables using raw SQL
  migrateDatabase(sqlite);

  const repos = buildRepositories(db);

  if (options.seed !== false) {
    seedAll(db);
  }

  return {
    db,
    repos,
    close: () => sqlite.close(),
  };
}
export type { StoreDB, Repositories };
export { schema, buildRepositories, createDatabase, migrateDatabase, seedAll };
// Re-export drizzle-orm operators for gateway routes that need direct table queries
export { eq, and, or, sql, count } from "drizzle-orm";

// Re-export repository classes for direct use
export {
  KernelRepository,
  CapabilityRepository,
  JobRepository,
  EvidenceBundleRepository,
  EscrowRepository,
  ProtocolTemplateRepository,
  ProtocolRunRepository,
  AutomationStatusRepository,
  OrchestratorRepository,
  LogisticsRepository,
  SessionRepository,
  EncryptionRepository,
  SensorRepository,
  BatchRepository,
  StoryRepository,
  SWFRepository,
  ApiKeyRepository,
  AuditLogRepository,
} from "./repositories/index.js";
