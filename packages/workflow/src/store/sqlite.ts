/**
 * SQLite-backed Store — default adapter for @pcc/workflow.
 *
 * Implements all five store interfaces (Idempotency / Event / Step / Run / DataLocation)
 * over a single better-sqlite3 connection with WAL mode.
 *
 * Usage:
 *   import { openSqliteStore } from '@pcc/workflow/store-sqlite';
 *   const store = openSqliteStore({ path: './pcc-workflow.sqlite' });
 *   // ...
 *   await store.close();
 *
 * Design: see §3 (file layout), §4 (schema), §5.3 (API).
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';

import { canonicalJSON, canonicalJSONStrict } from '../shared/canonical-json.js';
import { sha256Hex, ZERO_HASH } from '../shared/hash.js';
import type { CanonicalInput, DataLocation } from '../shared/types.js';
import type {
  DataLocationRegisterArgs,
  DataLocationStore,
  EventAppend,
  EventRecord,
  EventStore,
  IdempotencyClaim,
  IdempotencyClaimArgs,
  IdempotencyCompleteArgs,
  IdempotencyFailArgs,
  IdempotencyRow,
  IdempotencyStore,
  StepResultPutArgs,
  StepResultRecord,
  StepResultStore,
  Store,
  WorkflowRunCreateArgs,
  WorkflowRunRow,
  WorkflowRunStore,
  WorkflowRunUpdateExtra,
} from './types.js';
import type { Result } from '../shared/types.js';

// ── Constants ──────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

const TTL_HTTP_MS = 24 * 60 * 60 * 1000;              // 24 h
const TTL_ONCHAIN_MS = 30 * 24 * 60 * 60 * 1000;      // 30 d
const TTL_WORKFLOW_MS = 7 * 24 * 60 * 60 * 1000;      // 7 d
const TTL_EVIDENCE_SENTINEL = '9999-12-31T00:00:00.000Z';

// E2: a FAILED row must NOT inherit the scope TTL. The 30-day on-chain TTL is
// correct only for a COMPLETED op — applied to a FAILED one it poisons the
// semantic key for a month after a single transient RPC blip. A failure is
// retryable-until-proven-otherwise, so a failed row gets this SHORT TTL and
// becomes reclaimable within minutes. The client Idempotency-Key escape hatch
// remains the manual override for an immediate retry.
const DEFAULT_TTL_FAILED_MS = 5 * 60 * 1000;          // 5 min

const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;     // 1 h
const DEFAULT_STUCK_HTTP_MS = 60 * 1000;              // 60 s
const DEFAULT_STUCK_ONCHAIN_MS = 10 * 60 * 1000;      // 10 min

// ── Options ────────────────────────────────────────────────────────────────

export interface OpenSqliteStoreOptions {
  path: string;
  wal?: boolean;
  pruneIntervalMs?: number;
  stuckProcessingHttpMs?: number;
  stuckProcessingOnchainMs?: number;
  /** E2: TTL applied to a row when it transitions to 'failed' (default 5 min). */
  failedTtlMs?: number;
}

// ── Bootstrap SQL ──────────────────────────────────────────────────────────

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS schema_version (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS idempotency_keys (
    key                    TEXT NOT NULL,
    scope                  TEXT NOT NULL,
    status                 TEXT NOT NULL CHECK (status IN ('processing','completed','failed')),
    attempt                INTEGER NOT NULL DEFAULT 1,
    created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    processing_started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    completed_at           TEXT,
    expires_at             TEXT NOT NULL,
    response_code          INTEGER,
    response_body          TEXT,
    response_headers       TEXT,
    request_method         TEXT,
    request_path           TEXT,
    request_hash           TEXT NOT NULL,
    actor_id               TEXT NOT NULL,
    correlation_id         TEXT,
    causation_id           TEXT,
    event_id               TEXT,
    onchain_tx_hash        TEXT,
    onchain_tx_block       INTEGER,
    onchain_status         TEXT CHECK (onchain_status IN ('pending','confirmed','reverted','reorged') OR onchain_status IS NULL),
    PRIMARY KEY (key, scope)
  );
  CREATE INDEX IF NOT EXISTS idx_idem_expires ON idempotency_keys(expires_at);
  CREATE INDEX IF NOT EXISTS idx_idem_stuck   ON idempotency_keys(status, processing_started_at) WHERE status = 'processing';
  CREATE INDEX IF NOT EXISTS idx_idem_tx      ON idempotency_keys(onchain_tx_hash) WHERE onchain_tx_hash IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_idem_actor   ON idempotency_keys(actor_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_idem_corr    ON idempotency_keys(correlation_id) WHERE correlation_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS events (
    event_id               TEXT PRIMARY KEY,
    event_type             TEXT NOT NULL,
    aggregate_type         TEXT NOT NULL,
    aggregate_id           TEXT NOT NULL,
    sequence               INTEGER NOT NULL,
    event_order            INTEGER NOT NULL,
    actor_type             TEXT NOT NULL,
    actor_id               TEXT NOT NULL,
    occurred_at            TEXT NOT NULL,
    recorded_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    monotonic_tick         INTEGER NOT NULL,
    payload                TEXT NOT NULL,
    payload_hash           TEXT NOT NULL,
    prev_hash              TEXT NOT NULL,
    event_hash             TEXT NOT NULL,
    kernel_signature       TEXT,
    gateway_signature      TEXT,
    correlation_id         TEXT,
    causation_id           TEXT,
    idempotency_key        TEXT,
    onchain_tx_hash        TEXT,
    onchain_block_number   INTEGER,
    storage_cid            TEXT,
    UNIQUE (aggregate_type, aggregate_id, sequence)
  );
  CREATE INDEX IF NOT EXISTS idx_events_aggregate   ON events(aggregate_type, aggregate_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id) WHERE correlation_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_events_causation   ON events(causation_id) WHERE causation_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_events_type_time   ON events(event_type, recorded_at);
  CREATE INDEX IF NOT EXISTS idx_events_order       ON events(event_order);

  CREATE TABLE IF NOT EXISTS workflow_runs (
    run_id                 TEXT PRIMARY KEY,
    workflow_name          TEXT NOT NULL,
    workflow_version       INTEGER NOT NULL DEFAULT 1,
    run_args_hash          TEXT NOT NULL,
    run_args               TEXT NOT NULL,
    status                 TEXT NOT NULL CHECK (status IN ('pending','running','paused','completed','failed','cancelled')),
    current_step_index     INTEGER NOT NULL DEFAULT 0,
    last_event_sequence    INTEGER NOT NULL DEFAULT 0,
    started_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    completed_at           TEXT,
    result                 TEXT,
    error                  TEXT,
    correlation_id         TEXT,
    parent_run_id          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runs_status       ON workflow_runs(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_runs_name_version ON workflow_runs(workflow_name, workflow_version);
  CREATE INDEX IF NOT EXISTS idx_runs_parent       ON workflow_runs(parent_run_id) WHERE parent_run_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_runs_corr         ON workflow_runs(correlation_id) WHERE correlation_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS step_results (
    run_id                 TEXT NOT NULL,
    step_id                TEXT NOT NULL,
    sequence               INTEGER NOT NULL,
    status                 TEXT NOT NULL CHECK (status IN ('completed','failed')),
    result                 TEXT,
    error                  TEXT,
    duration_ms            INTEGER NOT NULL DEFAULT 0,
    attempt                INTEGER NOT NULL DEFAULT 1,
    completed_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (run_id, step_id),
    FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_step_results_sequence ON step_results(run_id, sequence);

  CREATE TABLE IF NOT EXISTS data_locations (
    location_id            TEXT PRIMARY KEY,
    port_id                TEXT NOT NULL,
    run_id                 TEXT,
    kernel_id              TEXT NOT NULL,
    service                TEXT,
    scheme                 TEXT NOT NULL CHECK (scheme IN ('fs','ipfs','storacha','onchain','p2p','http')),
    path                   TEXT NOT NULL,
    data_type              TEXT NOT NULL CHECK (data_type IN ('primary','symbolic_link','invalid')),
    size_bytes             INTEGER,
    checksum               TEXT,
    available              INTEGER NOT NULL DEFAULT 0 CHECK (available IN (0,1)),
    created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    source_location_id     TEXT,
    token_tag              TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_data_loc_port   ON data_locations(port_id);
  CREATE INDEX IF NOT EXISTS idx_data_loc_run    ON data_locations(run_id) WHERE run_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_data_loc_kernel ON data_locations(kernel_id, available);
  CREATE INDEX IF NOT EXISTS idx_data_loc_source ON data_locations(source_location_id) WHERE source_location_id IS NOT NULL;

  INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, ${SCHEMA_VERSION});
`;

// ── Helpers ────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function addMsIso(baseIso: string, ms: number): string {
  return new Date(Date.parse(baseIso) + ms).toISOString();
}

function deriveExpiresAt(scope: string): string {
  const now = nowIso();
  if (scope.startsWith('http:')) return addMsIso(now, TTL_HTTP_MS);
  if (scope.startsWith('onchain:')) return addMsIso(now, TTL_ONCHAIN_MS);
  if (scope.startsWith('workflow:')) return addMsIso(now, TTL_WORKFLOW_MS);
  if (scope.startsWith('evidence:')) return TTL_EVIDENCE_SENTINEL;
  // Conservative default matches HTTP TTL.
  return addMsIso(now, TTL_HTTP_MS);
}

function stuckWindowFor(
  scope: string,
  http: number,
  onchain: number,
): number {
  if (scope.startsWith('onchain:')) return onchain;
  return http;
}

interface IdempotencyDbRow {
  key: string;
  scope: string;
  status: 'processing' | 'completed' | 'failed';
  attempt: number;
  created_at: string;
  processing_started_at: string;
  completed_at: string | null;
  expires_at: string;
  response_code: number | null;
  response_body: string | null;
  response_headers: string | null;
  request_method: string | null;
  request_path: string | null;
  request_hash: string;
  actor_id: string;
  correlation_id: string | null;
  causation_id: string | null;
  event_id: string | null;
  onchain_tx_hash: string | null;
  onchain_tx_block: number | null;
  onchain_status: 'pending' | 'confirmed' | 'reverted' | 'reorged' | null;
}

function rowToIdempotencyRow(r: IdempotencyDbRow): IdempotencyRow {
  return {
    key: r.key,
    scope: r.scope,
    status: r.status,
    attempt: r.attempt,
    createdAt: r.created_at,
    processingStartedAt: r.processing_started_at,
    completedAt: r.completed_at,
    expiresAt: r.expires_at,
    responseCode: r.response_code,
    responseBody: r.response_body,
    responseHeaders: r.response_headers ? (JSON.parse(r.response_headers) as Record<string, string>) : null,
    requestMethod: r.request_method,
    requestPath: r.request_path,
    requestHash: r.request_hash,
    actorId: r.actor_id,
    correlationId: r.correlation_id,
    causationId: r.causation_id,
    eventId: r.event_id,
    onchainTxHash: r.onchain_tx_hash,
    onchainTxBlock: r.onchain_tx_block,
    onchainStatus: r.onchain_status,
  };
}

interface EventDbRow {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  sequence: number;
  event_order: number;
  actor_type: string;
  actor_id: string;
  occurred_at: string;
  recorded_at: string;
  monotonic_tick: number;
  payload: string;
  payload_hash: string;
  prev_hash: string;
  event_hash: string;
  kernel_signature: string | null;
  gateway_signature: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  idempotency_key: string | null;
  onchain_tx_hash: string | null;
  onchain_block_number: number | null;
  storage_cid: string | null;
}

function rowToEventRecord(r: EventDbRow): EventRecord {
  return {
    eventId: r.event_id,
    eventType: r.event_type,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    sequence: r.sequence,
    eventOrder: r.event_order,
    actorType: r.actor_type,
    actorId: r.actor_id,
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
    monotonicTick: r.monotonic_tick,
    payload: JSON.parse(r.payload) as CanonicalInput,
    payloadHash: r.payload_hash,
    prevHash: r.prev_hash,
    eventHash: r.event_hash,
    kernelSignature: r.kernel_signature,
    gatewaySignature: r.gateway_signature,
    correlationId: r.correlation_id,
    causationId: r.causation_id,
    idempotencyKey: r.idempotency_key,
    onchainTxHash: r.onchain_tx_hash,
    onchainBlockNumber: r.onchain_block_number,
    storageCid: r.storage_cid,
  };
}

interface RunDbRow {
  run_id: string;
  workflow_name: string;
  workflow_version: number;
  run_args_hash: string;
  run_args: string;
  status: WorkflowRunRow['status'];
  current_step_index: number;
  last_event_sequence: number;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  result: string | null;
  error: string | null;
  correlation_id: string | null;
  parent_run_id: string | null;
}

function rowToRun(r: RunDbRow): WorkflowRunRow {
  return {
    runId: r.run_id,
    workflowName: r.workflow_name,
    workflowVersion: r.workflow_version,
    runArgsHash: r.run_args_hash,
    runArgs: JSON.parse(r.run_args) as CanonicalInput,
    status: r.status,
    currentStepIndex: r.current_step_index,
    lastEventSequence: r.last_event_sequence,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    result: r.result,
    error: r.error,
    correlationId: r.correlation_id,
    parentRunId: r.parent_run_id,
  };
}

interface DataLocationDbRow {
  location_id: string;
  port_id: string;
  run_id: string | null;
  kernel_id: string;
  service: string | null;
  scheme: 'fs' | 'ipfs' | 'storacha' | 'onchain' | 'p2p' | 'http';
  path: string;
  data_type: 'primary' | 'symbolic_link' | 'invalid';
  size_bytes: number | null;
  checksum: string | null;
  available: 0 | 1;
  created_at: string;
  updated_at: string;
  source_location_id: string | null;
  token_tag: string | null;
}

function rowToDataLocation(r: DataLocationDbRow): DataLocation {
  const out: DataLocation = {
    locationId: r.location_id,
    portId: r.port_id,
    kernelId: r.kernel_id,
    scheme: r.scheme,
    path: r.path,
    dataType: r.data_type,
    available: r.available === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.service !== null ? { service: r.service } : {}),
    ...(r.size_bytes !== null ? { sizeBytes: r.size_bytes } : {}),
    ...(r.checksum !== null ? { checksum: r.checksum } : {}),
    ...(r.token_tag !== null ? { tokenTag: r.token_tag } : {}),
    ...(r.source_location_id !== null ? { sourceLocationId: r.source_location_id } : {}),
    ...(r.run_id !== null ? { runId: r.run_id } : {}),
  };
  return out;
}

// ── Core store implementation ──────────────────────────────────────────────

class SqliteStore implements Store {
  readonly idempotency: IdempotencyStore;
  readonly events: EventStore;
  readonly steps: StepResultStore;
  readonly runs: WorkflowRunStore;
  readonly dataLocations: DataLocationStore;

  private readonly db: BetterSqliteDatabase;
  private readonly pruneTimer: NodeJS.Timeout | null;

  constructor(opts: OpenSqliteStoreOptions) {
    this.db = new Database(opts.path);
    this.db.pragma('journal_mode = ' + (opts.wal === false ? 'DELETE' : 'WAL'));
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(CREATE_TABLES_SQL);

    const stuckHttp = opts.stuckProcessingHttpMs ?? DEFAULT_STUCK_HTTP_MS;
    const stuckOnchain = opts.stuckProcessingOnchainMs ?? DEFAULT_STUCK_ONCHAIN_MS;
    const failedTtl = opts.failedTtlMs ?? DEFAULT_TTL_FAILED_MS;

    this.idempotency = new SqliteIdempotencyStore(this.db, stuckHttp, stuckOnchain, failedTtl);
    this.events = new SqliteEventStore(this.db);
    this.steps = new SqliteStepResultStore(this.db);
    this.runs = new SqliteWorkflowRunStore(this.db);
    this.dataLocations = new SqliteDataLocationStore(this.db);

    const pruneInterval = opts.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    if (pruneInterval > 0) {
      this.pruneTimer = setInterval(() => {
        try {
          void this.idempotency.prune();
        } catch {
          // Swallow prune errors — telemetry to come in a future PR.
        }
      }, pruneInterval);
      this.pruneTimer.unref?.();
    } else {
      this.pruneTimer = null;
    }
  }

  async close(): Promise<void> {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.db.close();
  }
}

// ── Idempotency store ─────────────────────────────────────────────────────

class SqliteIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly db: BetterSqliteDatabase,
    private readonly stuckHttpMs: number,
    private readonly stuckOnchainMs: number,
    private readonly failedTtlMs: number,
  ) {}

  async claim(args: IdempotencyClaimArgs): Promise<IdempotencyClaim> {
    const expiresAt = args.expiresAtOverride ?? deriveExpiresAt(args.scope);
    const tx = this.db.transaction((a: IdempotencyClaimArgs): IdempotencyClaim => {
      const insertFresh = (): IdempotencyClaim => {
        this.db
          .prepare(
            `INSERT INTO idempotency_keys
               (key, scope, status, attempt, expires_at, request_hash, actor_id,
                correlation_id, causation_id, event_id, request_method, request_path)
             VALUES (?, ?, 'processing', 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            a.key,
            a.scope,
            expiresAt,
            a.requestHash,
            a.actorId,
            a.correlationId ?? null,
            a.causationId ?? null,
            a.eventId ?? null,
            a.requestMethod ?? null,
            a.requestPath ?? null,
          );
        const row = this.db
          .prepare<[string, string]>('SELECT * FROM idempotency_keys WHERE key = ? AND scope = ?')
          .get(a.key, a.scope) as IdempotencyDbRow;
        return { outcome: 'fresh', row: rowToIdempotencyRow(row) };
      };

      const existing = this.db
        .prepare<[string, string]>('SELECT * FROM idempotency_keys WHERE key = ? AND scope = ?')
        .get(a.key, a.scope) as IdempotencyDbRow | undefined;

      if (!existing) {
        return insertFresh();
      }

      // E2: a terminal (completed/failed) row past its expiry is a dead cache
      // entry — the dedup window has elapsed. Recycle the key as a brand-new
      // attempt INLINE (don't wait for the hourly prune) so a failed on-chain op
      // with the short failed-TTL is reclaimable in MINUTES, not up to an hour.
      // Processing rows are left to the stuck-window reclaim logic below.
      if (
        existing.status !== 'processing' &&
        Date.parse(existing.expires_at) < Date.now()
      ) {
        this.db
          .prepare<[string, string]>('DELETE FROM idempotency_keys WHERE key = ? AND scope = ?')
          .run(a.key, a.scope);
        return insertFresh();
      }

      if (existing.request_hash !== a.requestHash) {
        return { outcome: 'mismatch', row: rowToIdempotencyRow(existing) };
      }

      if (existing.status === 'completed' || existing.status === 'failed') {
        return { outcome: 'cached', row: rowToIdempotencyRow(existing) };
      }

      // processing — check stuck window
      const stuckMs = stuckWindowFor(a.scope, this.stuckHttpMs, this.stuckOnchainMs);
      const ageMs = Date.now() - Date.parse(existing.processing_started_at);
      if (ageMs < stuckMs) {
        return { outcome: 'in_flight', row: rowToIdempotencyRow(existing) };
      }

      // Reclaim: bump attempt, reset processing_started_at
      const newAttempt = existing.attempt + 1;
      const now = nowIso();
      this.db
        .prepare(
          `UPDATE idempotency_keys
             SET attempt = ?, processing_started_at = ?
           WHERE key = ? AND scope = ?`,
        )
        .run(newAttempt, now, a.key, a.scope);
      const updated = this.db
        .prepare<[string, string]>('SELECT * FROM idempotency_keys WHERE key = ? AND scope = ?')
        .get(a.key, a.scope) as IdempotencyDbRow;
      return { outcome: 'reclaimed', row: rowToIdempotencyRow(updated), newAttempt };
    });
    return tx(args);
  }

  async complete(key: string, scope: string, r: IdempotencyCompleteArgs): Promise<void> {
    const now = nowIso();
    const info = this.db
      .prepare(
        `UPDATE idempotency_keys
           SET status = 'completed',
               completed_at = ?,
               response_code = ?,
               response_body = ?,
               response_headers = ?,
               onchain_tx_hash = COALESCE(?, onchain_tx_hash),
               onchain_tx_block = COALESCE(?, onchain_tx_block),
               onchain_status = CASE WHEN ? IS NOT NULL THEN 'confirmed' ELSE onchain_status END
         WHERE key = ? AND scope = ? AND status = 'processing'`,
      )
      .run(
        now,
        r.responseCode ?? null,
        r.responseBody,
        r.responseHeaders ? JSON.stringify(r.responseHeaders) : null,
        r.onchainTxHash ?? null,
        r.onchainTxBlock ?? null,
        r.onchainTxHash ?? null,
        key,
        scope,
      );
    if (info.changes === 0) {
      throw new Error(
        `Cannot complete idempotency row (key=${key}, scope=${scope}) — not in 'processing' state`,
      );
    }
  }

  async fail(key: string, scope: string, err: IdempotencyFailArgs): Promise<void> {
    const now = nowIso();
    // E2: override the scope TTL with the SHORT failed-TTL so a failed row
    // (esp. an on-chain op after a transient blip) expires in minutes and the
    // key is reclaimable — not poisoned for the 30-day on-chain window.
    const failedExpiresAt = addMsIso(now, this.failedTtlMs);
    const info = this.db
      .prepare(
        `UPDATE idempotency_keys
           SET status = 'failed',
               completed_at = ?,
               expires_at = ?,
               response_code = ?,
               response_body = ?
         WHERE key = ? AND scope = ? AND status = 'processing'`,
      )
      .run(now, failedExpiresAt, err.code ?? null, err.body, key, scope);
    if (info.changes === 0) {
      throw new Error(
        `Cannot fail idempotency row (key=${key}, scope=${scope}) — not in 'processing' state`,
      );
    }
  }

  async recordTx(key: string, scope: string, txHash: string): Promise<void> {
    const info = this.db
      .prepare(
        `UPDATE idempotency_keys
           SET onchain_tx_hash = ?, onchain_status = 'pending'
         WHERE key = ? AND scope = ?`,
      )
      .run(txHash, key, scope);
    if (info.changes === 0) {
      throw new Error(
        `Cannot record tx on idempotency row (key=${key}, scope=${scope}) — row missing`,
      );
    }
  }

  async reclaim(key: string, scope: string): Promise<IdempotencyRow> {
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare<[string, string]>('SELECT * FROM idempotency_keys WHERE key = ? AND scope = ?')
        .get(key, scope) as IdempotencyDbRow | undefined;
      if (!existing) {
        throw new Error(`reclaim: row not found (key=${key}, scope=${scope})`);
      }
      this.db
        .prepare(
          `UPDATE idempotency_keys
             SET attempt = attempt + 1, processing_started_at = ?
           WHERE key = ? AND scope = ?`,
        )
        .run(nowIso(), key, scope);
      const updated = this.db
        .prepare<[string, string]>('SELECT * FROM idempotency_keys WHERE key = ? AND scope = ?')
        .get(key, scope) as IdempotencyDbRow;
      return rowToIdempotencyRow(updated);
    });
    return tx();
  }

  async lookup(key: string, scope: string): Promise<IdempotencyRow | null> {
    const row = this.db
      .prepare<[string, string]>('SELECT * FROM idempotency_keys WHERE key = ? AND scope = ?')
      .get(key, scope) as IdempotencyDbRow | undefined;
    return row ? rowToIdempotencyRow(row) : null;
  }

  async prune(): Promise<number> {
    const info = this.db
      .prepare<[string]>('DELETE FROM idempotency_keys WHERE expires_at < ?')
      .run(nowIso());
    return info.changes;
  }
}

// ── Event store ───────────────────────────────────────────────────────────

class SqliteEventStore implements EventStore {
  constructor(private readonly db: BetterSqliteDatabase) {}

  async append(event: EventAppend): Promise<EventRecord> {
    const tx = this.db.transaction((e: EventAppend): EventRecord => {
      const lastRow = this.db
        .prepare<[string, string]>(
          `SELECT sequence, event_hash FROM events
           WHERE aggregate_type = ? AND aggregate_id = ?
           ORDER BY sequence DESC LIMIT 1`,
        )
        .get(e.aggregateType, e.aggregateId) as
        | { sequence: number; event_hash: string }
        | undefined;

      const nextSequence = lastRow ? lastRow.sequence + 1 : 1;
      const prevHash = lastRow ? lastRow.event_hash : ZERO_HASH;

      const maxOrderRow = this.db
        .prepare('SELECT COALESCE(MAX(event_order), 0) AS m FROM events')
        .get() as { m: number };
      const eventOrder = maxOrderRow.m + 1;

      const payloadCanonical = canonicalJSONStrict(e.payload);
      const payloadHash = sha256Hex(payloadCanonical);

      // Hash chain input (no timestamps — see design §6.4)
      const hashInput = [
        prevHash,
        payloadHash,
        String(eventOrder),
        e.eventType,
        e.aggregateId,
        String(nextSequence),
      ].join('|');
      const eventHash = sha256Hex(hashInput);

      const eventId = randomUUID();
      const occurredAt = e.occurredAt ?? nowIso();
      const recordedAt = nowIso();
      const monotonicTick = e.monotonicTick ?? 0;

      this.db
        .prepare(
          `INSERT INTO events
             (event_id, event_type, aggregate_type, aggregate_id, sequence, event_order,
              actor_type, actor_id, occurred_at, recorded_at, monotonic_tick,
              payload, payload_hash, prev_hash, event_hash,
              kernel_signature, correlation_id, causation_id, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          e.eventType,
          e.aggregateType,
          e.aggregateId,
          nextSequence,
          eventOrder,
          e.actorType,
          e.actorId,
          occurredAt,
          recordedAt,
          monotonicTick,
          payloadCanonical,
          payloadHash,
          prevHash,
          eventHash,
          e.kernelSignature ?? null,
          e.correlationId ?? null,
          e.causationId ?? null,
          e.idempotencyKey ?? null,
        );

      const inserted = this.db
        .prepare<[string]>('SELECT * FROM events WHERE event_id = ?')
        .get(eventId) as EventDbRow;
      return rowToEventRecord(inserted);
    });
    return tx(event);
  }

  async readStream(aggregateType: string, aggregateId: string): Promise<EventRecord[]> {
    const rows = this.db
      .prepare<[string, string]>(
        `SELECT * FROM events
          WHERE aggregate_type = ? AND aggregate_id = ?
          ORDER BY sequence ASC`,
      )
      .all(aggregateType, aggregateId) as EventDbRow[];
    return rows.map(rowToEventRecord);
  }

  async readByType(eventType: string, sinceIso?: string, untilIso?: string): Promise<EventRecord[]> {
    if (sinceIso && untilIso) {
      const rows = this.db
        .prepare<[string, string, string]>(
          `SELECT * FROM events WHERE event_type = ? AND recorded_at >= ? AND recorded_at <= ?
           ORDER BY recorded_at ASC`,
        )
        .all(eventType, sinceIso, untilIso) as EventDbRow[];
      return rows.map(rowToEventRecord);
    }
    if (sinceIso) {
      const rows = this.db
        .prepare<[string, string]>(
          `SELECT * FROM events WHERE event_type = ? AND recorded_at >= ? ORDER BY recorded_at ASC`,
        )
        .all(eventType, sinceIso) as EventDbRow[];
      return rows.map(rowToEventRecord);
    }
    if (untilIso) {
      const rows = this.db
        .prepare<[string, string]>(
          `SELECT * FROM events WHERE event_type = ? AND recorded_at <= ? ORDER BY recorded_at ASC`,
        )
        .all(eventType, untilIso) as EventDbRow[];
      return rows.map(rowToEventRecord);
    }
    const rows = this.db
      .prepare<[string]>(`SELECT * FROM events WHERE event_type = ? ORDER BY recorded_at ASC`)
      .all(eventType) as EventDbRow[];
    return rows.map(rowToEventRecord);
  }

  async readCausationChain(eventId: string): Promise<EventRecord[]> {
    const chain: EventRecord[] = [];
    let currentId: string | null = eventId;
    const seen = new Set<string>();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const row = this.db
        .prepare<[string]>(`SELECT * FROM events WHERE event_id = ?`)
        .get(currentId) as EventDbRow | undefined;
      if (!row) break;
      const rec = rowToEventRecord(row);
      chain.push(rec);
      currentId = rec.causationId;
    }
    return chain;
  }

  async verifyChain(
    aggregateType: string,
    aggregateId: string,
  ): Promise<Result<true, { brokenAt: number; reason: string }>> {
    const rows = await this.readStream(aggregateType, aggregateId);
    let expectedPrev = ZERO_HASH;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.sequence !== i + 1) {
        return { ok: false, error: { brokenAt: r.sequence, reason: 'sequence_gap' } };
      }
      if (r.prevHash !== expectedPrev) {
        return { ok: false, error: { brokenAt: r.sequence, reason: 'prev_hash_mismatch' } };
      }
      const payloadHash = sha256Hex(canonicalJSONStrict(r.payload));
      if (payloadHash !== r.payloadHash) {
        return { ok: false, error: { brokenAt: r.sequence, reason: 'payload_hash_mismatch' } };
      }
      const hashInput = [
        r.prevHash,
        r.payloadHash,
        String(r.eventOrder),
        r.eventType,
        r.aggregateId,
        String(r.sequence),
      ].join('|');
      const eventHash = sha256Hex(hashInput);
      if (eventHash !== r.eventHash) {
        return { ok: false, error: { brokenAt: r.sequence, reason: 'event_hash_mismatch' } };
      }
      expectedPrev = r.eventHash;
    }
    return { ok: true, value: true };
  }
}

// ── Step-result store ─────────────────────────────────────────────────────

class SqliteStepResultStore implements StepResultStore {
  constructor(private readonly db: BetterSqliteDatabase) {}

  async get(runId: string, stepId: string): Promise<StepResultRecord | null> {
    const row = this.db
      .prepare<[string, string]>(
        `SELECT status, result, error FROM step_results WHERE run_id = ? AND step_id = ?`,
      )
      .get(runId, stepId) as
      | { status: 'completed' | 'failed'; result: string | null; error: string | null }
      | undefined;
    if (!row) return null;
    const out: StepResultRecord = { status: row.status };
    if (row.result !== null) out.result = row.result;
    if (row.error !== null) out.error = row.error;
    return out;
  }

  async put(runId: string, stepId: string, args: StepResultPutArgs): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO step_results (run_id, step_id, sequence, status, result, error, duration_ms, attempt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, step_id) DO NOTHING`,
      )
      .run(
        runId,
        stepId,
        args.sequence,
        args.status,
        args.result ?? null,
        args.error ?? null,
        args.durationMs,
        args.attempt,
      );
  }

  async listIds(runId: string): Promise<string[]> {
    const rows = this.db
      .prepare<[string]>(`SELECT step_id FROM step_results WHERE run_id = ? ORDER BY sequence ASC`)
      .all(runId) as Array<{ step_id: string }>;
    return rows.map((r) => r.step_id);
  }
}

// ── Workflow-run store ────────────────────────────────────────────────────

class SqliteWorkflowRunStore implements WorkflowRunStore {
  constructor(private readonly db: BetterSqliteDatabase) {}

  async create(a: WorkflowRunCreateArgs): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO workflow_runs
           (run_id, workflow_name, workflow_version, run_args_hash, run_args, status,
            current_step_index, last_event_sequence, correlation_id, parent_run_id)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)`,
      )
      .run(
        a.runId,
        a.workflowName,
        a.workflowVersion,
        a.runArgsHash,
        canonicalJSONStrict(a.runArgs),
        a.correlationId ?? null,
        a.parentRunId ?? null,
      );
  }

  async get(runId: string): Promise<WorkflowRunRow | null> {
    const row = this.db
      .prepare<[string]>(`SELECT * FROM workflow_runs WHERE run_id = ?`)
      .get(runId) as RunDbRow | undefined;
    return row ? rowToRun(row) : null;
  }

  async updateStatus(
    runId: string,
    status: WorkflowRunRow['status'],
    extra?: WorkflowRunUpdateExtra,
  ): Promise<void> {
    const now = nowIso();
    const completedAt =
      status === 'completed' || status === 'failed' || status === 'cancelled' ? now : null;
    this.db
      .prepare(
        `UPDATE workflow_runs
           SET status = ?,
               updated_at = ?,
               completed_at = COALESCE(?, completed_at),
               current_step_index = COALESCE(?, current_step_index),
               last_event_sequence = COALESCE(?, last_event_sequence),
               result = COALESCE(?, result),
               error = COALESCE(?, error)
         WHERE run_id = ?`,
      )
      .run(
        status,
        now,
        completedAt,
        extra?.currentStepIndex ?? null,
        extra?.lastEventSequence ?? null,
        extra?.result ?? null,
        extra?.error ?? null,
        runId,
      );
  }

  async findByArgs(workflowName: string, runArgsHash: string): Promise<WorkflowRunRow | null> {
    const row = this.db
      .prepare<[string, string]>(
        `SELECT * FROM workflow_runs WHERE workflow_name = ? AND run_args_hash = ?
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(workflowName, runArgsHash) as RunDbRow | undefined;
    return row ? rowToRun(row) : null;
  }

  async listIncomplete(): Promise<WorkflowRunRow[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_runs WHERE status IN ('pending','running','paused')
         ORDER BY started_at ASC`,
      )
      .all() as RunDbRow[];
    return rows.map(rowToRun);
  }
}

// ── Data-location store ───────────────────────────────────────────────────

class SqliteDataLocationStore implements DataLocationStore {
  constructor(private readonly db: BetterSqliteDatabase) {}

  async register(args: DataLocationRegisterArgs): Promise<DataLocation> {
    const locationId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO data_locations
           (location_id, port_id, run_id, kernel_id, service, scheme, path, data_type,
            size_bytes, checksum, available, source_location_id, token_tag)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        locationId,
        args.portId,
        args.runId ?? null,
        args.kernelId,
        args.service ?? null,
        args.scheme,
        args.path,
        args.dataType,
        args.sizeBytes ?? null,
        args.checksum ?? null,
        args.available ? 1 : 0,
        args.sourceLocationId ?? null,
        args.tokenTag ?? null,
      );
    const row = this.db
      .prepare<[string]>(`SELECT * FROM data_locations WHERE location_id = ?`)
      .get(locationId) as DataLocationDbRow;
    return rowToDataLocation(row);
  }

  async getByPort(portId: string): Promise<DataLocation[]> {
    const rows = this.db
      .prepare<[string]>(`SELECT * FROM data_locations WHERE port_id = ? ORDER BY created_at ASC`)
      .all(portId) as DataLocationDbRow[];
    return rows.map(rowToDataLocation);
  }

  async markAvailable(locationId: string): Promise<void> {
    const info = this.db
      .prepare(
        `UPDATE data_locations SET available = 1, updated_at = ? WHERE location_id = ?`,
      )
      .run(nowIso(), locationId);
    if (info.changes === 0) {
      throw new Error(`markAvailable: location ${locationId} not found`);
    }
  }

  async invalidate(locationId: string): Promise<void> {
    const info = this.db
      .prepare(
        `UPDATE data_locations SET data_type = 'invalid', available = 0, updated_at = ? WHERE location_id = ?`,
      )
      .run(nowIso(), locationId);
    if (info.changes === 0) {
      throw new Error(`invalidate: location ${locationId} not found`);
    }
  }

  async addLineage(sourceLocationId: string, derivedLocationId: string): Promise<void> {
    const info = this.db
      .prepare(
        `UPDATE data_locations SET source_location_id = ?, updated_at = ? WHERE location_id = ?`,
      )
      .run(sourceLocationId, nowIso(), derivedLocationId);
    if (info.changes === 0) {
      throw new Error(`addLineage: location ${derivedLocationId} not found`);
    }
  }

  async get(locationId: string): Promise<DataLocation | null> {
    const row = this.db
      .prepare<[string]>(`SELECT * FROM data_locations WHERE location_id = ?`)
      .get(locationId) as DataLocationDbRow | undefined;
    return row ? rowToDataLocation(row) : null;
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Open (or create) a SQLite-backed Store. Runs CREATE TABLE IF NOT EXISTS
 * on every open and starts a TTL-prune timer (unref'd).
 */
export function openSqliteStore(opts: OpenSqliteStoreOptions): Store {
  return new SqliteStore(opts);
}

// Re-export internal helpers the engine also needs.
export { canonicalJSON };
