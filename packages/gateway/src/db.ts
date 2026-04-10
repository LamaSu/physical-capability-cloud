/**
 * Gateway database singleton.
 *
 * Initializes a SQLite-backed store from @pcc/store and exposes
 * repository instances for all route handlers. The DB file path
 * comes from the PCC_DB_PATH environment variable (defaults to
 * ./data/pcc.sqlite). Set PCC_DB_PATH=":memory:" for ephemeral use.
 *
 * DB path priority:
 *   1. DATABASE_URL env var (explicit override)
 *   2. RAILWAY_VOLUME_MOUNT_PATH + "/pcc.db" (persistent Railway volume)
 *   3. PCC_DB_PATH env var (legacy, default "./data/pcc.sqlite")
 *
 * Call `initStore()` once at startup; after that every route can
 * import `getRepos()` / `getStore()` synchronously.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createStore, type Store, type IRepositories } from "@pcc/store";

let _store: Store | undefined;

/**
 * Initializes the database, runs migrations, and optionally seeds.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function initStore(options?: { seed?: boolean }): Store {
  if (_store) return _store;

  // Prefer explicit DATABASE_URL, then Railway volume mount, then local path
  const dbPath = process.env.DATABASE_URL
    ?? (process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/pcc.db`
      : (process.env.PCC_DB_PATH ?? "./data/pcc.sqlite"));

  // Ensure the parent directory exists when using a file path (not :memory:)
  if (dbPath !== ":memory:") {
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch {
      // directory may already exist
    }
  }

  _store = createStore({
    dbPath,
    seed: options?.seed ?? true,
  });

  console.log(`[db] Store initialised (${dbPath === ":memory:" ? "in-memory" : dbPath})`);
  return _store;
}

/**
 * Returns the repository collection. Throws if initStore() hasn't been called.
 */
export function getRepos(): IRepositories {
  if (!_store) throw new Error("[db] Store not initialised — call initStore() first");
  return _store.repos as unknown as Repositories;
}

/**
 * Returns the full Store (db + repos + close). Throws if not initialised.
 */
export function getStore(): Store {
  if (!_store) throw new Error("[db] Store not initialised — call initStore() first");
  return _store;
}

/**
 * Closes the underlying SQLite connection. Used in graceful shutdown.
 */
export function closeStore(): void {
  if (_store) {
    _store.close();
    _store = undefined;
    console.log("[db] Store closed");
  }
}
