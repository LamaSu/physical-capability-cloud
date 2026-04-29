import { createDatabase, type StoreDB } from "./connection.js";
import { migrateDatabase } from "./migrate.js";
import { buildRepositories, type Repositories } from "./repositories/index.js";
import { seedAll } from "./seed/index.js";
import * as schema from "./schema/index.js";
import type { IRepositories } from "./interfaces/index.js";

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
  /** Drizzle ORM database instance — internal use only (migration scripts, seeding) */
  db: StoreDB;
  /**
   * Pre-built repository instances for each domain.
   * Typed as IRepositories so callers depend on the interface contract,
   * not the concrete Drizzle/SQLite implementation.
   */
  repos: IRepositories;
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
export { eq, and, or, sql, count, desc, asc } from "drizzle-orm";
// Repository interfaces — the public contract for the data access layer
export type { IRepositories } from "./interfaces/index.js";
export type {
  IJobRepository,
  IKernelRepository,
  ICapabilityRepository,
  IEvidenceBundleRepository,
  IEscrowRepository,
  IProtocolTemplateRepository,
  IProtocolRunRepository,
  IAutomationStatusRepository,
  IOrchestratorRepository,
  ILogisticsRepository,
  ISessionRepository,
  IEncryptionRepository,
  ISensorRepository,
  IBatchRepository,
  IStoryRepository,
  ISWFRepository,
  IApiKeyRepository,
  IAuditLogRepository,
  IRegistrationRepository,
  IA2AMessageRepository,
  IContributorRepository,
  ContributorProfileRecord,
  RateScheduleRecord,
  TrainingManifestRecord,
  CompositionManifestRecord,
  CaptureVerdictRow,
} from "./interfaces/index.js";

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
  A2AMessageRepository,
  ContributorRepository,
} from "./repositories/index.js";
export type { A2AMessageRow, A2AMessageInsert, A2AConversationRow } from "./repositories/a2a-messages.js";
