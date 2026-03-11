import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";

export type StoreDB = BetterSQLite3Database<typeof schema>;

export function createDatabase(dbPath?: string): { db: StoreDB; sqlite: BetterSqlite3.Database } {
  const sqlite = new Database(dbPath ?? ":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
