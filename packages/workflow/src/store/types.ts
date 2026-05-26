/**
 * Store interface contracts — five adapters + a combined Store handle.
 *
 * All store methods are async. The default implementation is synchronous
 * under the hood (better-sqlite3) but the public surface is async so a
 * future Postgres / Drizzle adapter is drop-in.
 *
 * See design §4 for schema and §5.2 for the TS signatures.
 */

import type {
  CanonicalInput,
  DataLocation,
  DataScheme,
  DataType,
  TokenTag,
} from '../shared/types.js';
import type { Result } from '../shared/types.js';

// ── Idempotency ────────────────────────────────────────────────────────────

/**
 * Outcome of a {@link IdempotencyStore.claim} call.
 *
 *   fresh       — no prior row; caller may proceed.
 *   cached      — prior row completed; caller should return the cached result.
 *   in_flight   — prior row is still processing within the stuck window; caller
 *                 should either wait or return 409 to the upstream HTTP client.
 *   reclaimed   — prior row was stuck past the window; we incremented attempt
 *                 and the caller may re-run (fencing-token semantics).
 *   mismatch    — a row with the same key exists but requestHash differs —
 *                 callers should return 422 (scout-delta §9.2).
 */
export interface IdempotencyClaim {
  outcome: 'fresh' | 'cached' | 'in_flight' | 'reclaimed' | 'mismatch';
  row?: IdempotencyRow;
  newAttempt?: number;
}

/** Concrete idempotency record as persisted in SQLite. */
export interface IdempotencyRow {
  key: string;
  scope: string;
  status: 'processing' | 'completed' | 'failed';
  attempt: number;
  createdAt: string;
  processingStartedAt: string;
  completedAt: string | null;
  expiresAt: string;
  responseCode: number | null;
  responseBody: string | null;
  responseHeaders: Record<string, string> | null;
  requestMethod: string | null;
  requestPath: string | null;
  requestHash: string;
  actorId: string;
  correlationId: string | null;
  causationId: string | null;
  eventId: string | null;
  onchainTxHash: string | null;
  onchainStatus: 'pending' | 'confirmed' | 'reverted' | 'reorged' | null;
  onchainTxBlock: number | null;
}

export interface IdempotencyClaimArgs {
  key: string;
  scope: string;
  requestHash: string;
  actorId: string;
  correlationId?: string;
  causationId?: string;
  requestMethod?: string;
  requestPath?: string;
  eventId?: string;
  /** Override expires_at; otherwise derived from scope prefix (see design §4.1). */
  expiresAtOverride?: string;
}

export interface IdempotencyCompleteArgs {
  responseCode?: number;
  responseBody: string;
  responseHeaders?: Record<string, string>;
  onchainTxHash?: string;
  onchainTxBlock?: number;
}

export interface IdempotencyFailArgs {
  code?: number;
  body: string;
}

/** Claim-once, cache-forever contract (design §4.1). */
export interface IdempotencyStore {
  claim(args: IdempotencyClaimArgs): Promise<IdempotencyClaim>;
  complete(key: string, scope: string, result: IdempotencyCompleteArgs): Promise<void>;
  fail(key: string, scope: string, error: IdempotencyFailArgs): Promise<void>;
  recordTx(key: string, scope: string, txHash: string): Promise<void>;
  reclaim(key: string, scope: string): Promise<IdempotencyRow>;
  lookup(key: string, scope: string): Promise<IdempotencyRow | null>;
  prune(): Promise<number>;
}

// ── Event Store ────────────────────────────────────────────────────────────

export interface EventAppend {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  actorType: string;
  actorId: string;
  occurredAt?: string;
  monotonicTick?: number;
  payload: CanonicalInput;
  correlationId?: string;
  causationId?: string;
  idempotencyKey?: string;
  kernelSignature?: string;
}

export interface EventRecord {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  sequence: number;
  eventOrder: number;
  actorType: string;
  actorId: string;
  occurredAt: string;
  recordedAt: string;
  monotonicTick: number;
  payload: CanonicalInput;
  payloadHash: string;
  prevHash: string;
  eventHash: string;
  kernelSignature: string | null;
  gatewaySignature: string | null;
  correlationId: string | null;
  causationId: string | null;
  idempotencyKey: string | null;
  onchainTxHash: string | null;
  onchainBlockNumber: number | null;
  storageCid: string | null;
}

export interface EventStore {
  /** Append an event; assigns sequence + hashes atomically. */
  append(event: EventAppend): Promise<EventRecord>;

  /** Read all events in an aggregate stream, ordered by sequence. */
  readStream(aggregateType: string, aggregateId: string): Promise<EventRecord[]>;

  /** Read events by type within an optional time window. */
  readByType(eventType: string, sinceIso?: string, untilIso?: string): Promise<EventRecord[]>;

  /** Walk causation links backward from a given event. */
  readCausationChain(eventId: string): Promise<EventRecord[]>;

  /** Verify the per-aggregate hash chain. Returns ok or the first broken sequence. */
  verifyChain(
    aggregateType: string,
    aggregateId: string,
  ): Promise<Result<true, { brokenAt: number; reason: string }>>;
}

// ── Step Results ───────────────────────────────────────────────────────────

export interface StepResultRecord {
  status: 'completed' | 'failed';
  result?: string;
  error?: string;
}

export interface StepResultPutArgs {
  status: 'completed' | 'failed';
  result?: string;
  error?: string;
  sequence: number;
  durationMs: number;
  attempt: number;
}

export interface StepResultStore {
  get(runId: string, stepId: string): Promise<StepResultRecord | null>;
  put(runId: string, stepId: string, args: StepResultPutArgs): Promise<void>;
  listIds(runId: string): Promise<string[]>;
}

// ── Workflow Runs ──────────────────────────────────────────────────────────

export interface WorkflowRunRow {
  runId: string;
  workflowName: string;
  workflowVersion: number;
  runArgsHash: string;
  runArgs: CanonicalInput;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  currentStepIndex: number;
  lastEventSequence: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  result: string | null;
  error: string | null;
  correlationId: string | null;
  parentRunId: string | null;
}

export interface WorkflowRunCreateArgs {
  runId: string;
  workflowName: string;
  workflowVersion: number;
  runArgsHash: string;
  runArgs: CanonicalInput;
  correlationId?: string;
  parentRunId?: string;
}

export interface WorkflowRunUpdateExtra {
  currentStepIndex?: number;
  result?: string;
  error?: string;
  lastEventSequence?: number;
}

export interface WorkflowRunStore {
  create(args: WorkflowRunCreateArgs): Promise<void>;
  get(runId: string): Promise<WorkflowRunRow | null>;
  updateStatus(
    runId: string,
    status: WorkflowRunRow['status'],
    extra?: WorkflowRunUpdateExtra,
  ): Promise<void>;
  findByArgs(workflowName: string, runArgsHash: string): Promise<WorkflowRunRow | null>;
  listIncomplete(): Promise<WorkflowRunRow[]>;
}

// ── Data Locations ─────────────────────────────────────────────────────────

export interface DataLocationRegisterArgs {
  portId: string;
  kernelId: string;
  scheme: DataScheme;
  path: string;
  dataType: DataType;
  sizeBytes?: number;
  checksum?: string;
  runId?: string;
  sourceLocationId?: string;
  tokenTag?: TokenTag;
  service?: string;
  /** Initial availability (default false — caller toggles via markAvailable). */
  available?: boolean;
}

export interface DataLocationStore {
  register(args: DataLocationRegisterArgs): Promise<DataLocation>;
  getByPort(portId: string): Promise<DataLocation[]>;
  markAvailable(locationId: string): Promise<void>;
  invalidate(locationId: string): Promise<void>;
  addLineage(sourceLocationId: string, derivedLocationId: string): Promise<void>;
  get(locationId: string): Promise<DataLocation | null>;
}

// ── Combined Store ─────────────────────────────────────────────────────────

export interface Store {
  readonly idempotency: IdempotencyStore;
  readonly events: EventStore;
  readonly steps: StepResultStore;
  readonly runs: WorkflowRunStore;
  readonly dataLocations: DataLocationStore;
  close(): Promise<void>;
}
