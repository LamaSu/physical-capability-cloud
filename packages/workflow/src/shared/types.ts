/**
 * Shared types for @pcc/workflow.
 *
 * Exports:
 *   - Result<T, E>              — ok/error discriminated union (matches design §5.1)
 *   - CanonicalInput            — JSON-serializable input type
 *   - RetryPolicy / Required    — exponential-backoff retry policy (design §7)
 *   - ActivityContext           — runtime context injected into activity handlers
 *   - WorkflowContext           — context passed to Workflow.run() handlers
 *   - Token / TokenTag          — data-port token primitives
 *   - DataScheme / DataType     — data-port enums
 *   - DataLocation              — physical data location record
 */

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/** Helper constructors for Result. */
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E = Error>(error: E): Result<never, E> => ({ ok: false, error });

/**
 * JSON-serializable input — no undefined, no functions, no classes.
 * Used anywhere a value participates in content-addressable hashing
 * or cross-boundary serialization.
 */
export type CanonicalInput =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<CanonicalInput>
  | { readonly [k: string]: CanonicalInput };

/**
 * Retry policy for activities. Mirrors Temporal's RetryPolicy shape
 * with TS-idiomatic names. Defaults applied via {@link DEFAULT_RETRY_POLICY}.
 *
 * See design §7 for the canonical defaults and the backoff algorithm.
 */
export interface RetryPolicy {
  /** Wait before first retry. Default 1000 ms. */
  initialIntervalMs?: number;
  /** Multiplier applied per retry. Default 2.0. */
  backoffCoefficient?: number;
  /** Upper bound on retry interval in ms. Default 100 × initialIntervalMs. */
  maxIntervalMs?: number;
  /** Total attempts including first. 0 = infinite; 1 = no retries. Default 5. */
  maximumAttempts?: number;
  /** Error name/message regex patterns that skip retry. Default []. */
  nonRetryableErrorPatterns?: readonly string[];
  /** Jitter factor 0..1. Default 0.2 (±20%). */
  jitterFactor?: number;
}

/** Canonical defaults — applied by {@link applyRetryPolicyDefaults}. */
export const DEFAULT_RETRY_POLICY: Required<RetryPolicy> = Object.freeze({
  initialIntervalMs: 1_000,
  backoffCoefficient: 2.0,
  maxIntervalMs: 100_000,
  maximumAttempts: 5,
  nonRetryableErrorPatterns: Object.freeze([]) as readonly string[],
  jitterFactor: 0.2,
});

/**
 * Apply defaults to a partial RetryPolicy.
 *
 * CAUTION: the "100 × initialIntervalMs" maxIntervalMs rule described in the design
 * is only applied when the user supplies a custom initialIntervalMs but no explicit
 * maxIntervalMs. When both are defaults we use DEFAULT_RETRY_POLICY.maxIntervalMs
 * directly (100_000).
 */
export function applyRetryPolicyDefaults(p: RetryPolicy | undefined): Required<RetryPolicy> {
  const partial: RetryPolicy = p ?? {};
  const initialIntervalMs = partial.initialIntervalMs ?? DEFAULT_RETRY_POLICY.initialIntervalMs;
  const maxIntervalMs =
    partial.maxIntervalMs ??
    (partial.initialIntervalMs !== undefined
      ? partial.initialIntervalMs * 100
      : DEFAULT_RETRY_POLICY.maxIntervalMs);
  return {
    initialIntervalMs,
    backoffCoefficient: partial.backoffCoefficient ?? DEFAULT_RETRY_POLICY.backoffCoefficient,
    maxIntervalMs,
    maximumAttempts: partial.maximumAttempts ?? DEFAULT_RETRY_POLICY.maximumAttempts,
    nonRetryableErrorPatterns:
      partial.nonRetryableErrorPatterns ?? DEFAULT_RETRY_POLICY.nonRetryableErrorPatterns,
    jitterFactor: partial.jitterFactor ?? DEFAULT_RETRY_POLICY.jitterFactor,
  };
}

/**
 * Context injected into an activity handler when it is invoked.
 *
 * IMPORTANT (design §8.2 + §12 risk #2): `attempt` is the local retry counter
 * and MUST NOT be mixed into semantic on-chain idempotency keys. Use the
 * dedicated {@link deriveOnchainOpKey} helper (activity/idempotency-key.ts)
 * which hardcodes attempt=1. The `attempt` field here is intentionally
 * exposed so handlers can branch on "am I a retry?" logic.
 */
export interface ActivityContext {
  readonly workflowRunId: string;
  readonly activityId: string;
  readonly activityName: string;
  readonly attempt: number;
  /** The idempotency key the engine claimed for this attempt. */
  readonly idempotencyKey: string;
  readonly actorId: string;
}

/**
 * Context passed to Workflow.run(). Provides the four core primitives
 * needed to author durable workflows.
 */
export interface WorkflowContext {
  readonly runId: string;
  readonly name: string;
  readonly version: number;

  /** Memoized step — lambda runs exactly once per run across crashes. */
  step<T>(id: string, fn: () => Promise<T>): Promise<T>;

  /** Invoke a registered activity with typed arguments. */
  activity<A extends readonly unknown[], R>(name: string, ...args: A): Promise<R>;

  /**
   * Durable sleep. v0.1 throws NotImplementedError — see design §12.6.
   * A scheduled_at poller is planned for v0.2.
   */
  sleep(id: string, ms: number): Promise<void>;

  /**
   * Marker-based versioning (Temporal pattern). Emits a VersionMarker event
   * on first call and returns `currentValue`; replays of a run started before
   * the marker existed receive `defaultValue`. See design §10.
   */
  getVersion(key: string, defaultValue: number, currentValue: number): Promise<number>;

  /**
   * Block until an external signal is delivered by name.
   * Signal delivery is currently single-process (design §12.1).
   */
  signal<T>(name: string): Promise<T>;
}

/** Provenance tag attached to a data-port token (StreamFlow lineage). */
export type TokenTag = string;

/** Typed token produced/consumed via a DataPort. */
export interface Token<T = unknown> {
  readonly value: T;
  readonly tag: TokenTag;
  readonly recoverable: boolean;
  readonly locations: readonly DataLocation[];
}

/** URI scheme for a DataLocation. */
export type DataScheme = 'fs' | 'ipfs' | 'storacha' | 'onchain' | 'p2p' | 'http';

/** Classification of a DataLocation entry. */
export type DataType = 'primary' | 'symbolic_link' | 'invalid';

/** Physical/logical location where port data lives. */
export interface DataLocation {
  readonly locationId: string;
  readonly kernelId: string;
  readonly service?: string;
  readonly scheme: DataScheme;
  readonly path: string;
  readonly dataType: DataType;
  readonly available: boolean;
  readonly sizeBytes?: number;
  readonly checksum?: string;
  readonly tokenTag?: TokenTag;
  readonly sourceLocationId?: string;
  readonly portId?: string;
  readonly runId?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

/** Error thrown when a feature is declared in the API but not shipped in v0.1. */
export class NotImplementedError extends Error {
  constructor(feature: string, rationale?: string) {
    super(
      rationale
        ? `${feature} is not implemented in @pcc/workflow v0.1: ${rationale}`
        : `${feature} is not implemented in @pcc/workflow v0.1.`,
    );
    this.name = 'NotImplementedError';
  }
}

/** Thrown when an activity exhausts its retry budget. */
export class ActivityFailedError extends Error {
  constructor(
    public readonly activityName: string,
    public readonly attempts: number,
    public readonly cause: Error,
  ) {
    super(
      `Activity '${activityName}' failed after ${attempts} attempt(s): ${cause.message}`,
    );
    this.name = 'ActivityFailedError';
  }
}

/** Thrown when a DataPort.get() is awaited on a port that was closed. */
export class PortClosedError extends Error {
  constructor(portName: string) {
    super(`DataPort '${portName}' was closed before a token was available.`);
    this.name = 'PortClosedError';
  }
}

/** Thrown when a DataManager transfer fails (network, checksum, etc.). */
export class TransferFailedError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'TransferFailedError';
  }
}

/** Thrown when cwlExport input fails zod validation. */
export class CwlExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CwlExportError';
  }
}

/** Thrown when a workflow is started with a runId that already exists at a different args hash. */
export class DuplicateRunIdError extends Error {
  constructor(runId: string) {
    super(`Workflow runId '${runId}' already exists with different args.`);
    this.name = 'DuplicateRunIdError';
  }
}
