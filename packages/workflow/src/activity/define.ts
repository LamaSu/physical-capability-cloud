/**
 * Activity.define() — the main registration + invocation primitive.
 *
 * See design §5.4 for signatures and §7 for retry policy semantics.
 *
 * Wraps a user handler with:
 *   - idempotency claim / complete / fail / reclaim via IdempotencyStore
 *   - retry loop with exponential backoff (from retry.ts)
 *   - at-least-once semantics — the Result<R> surface lets callers distinguish
 *     exhausted-retries from programmer errors.
 */

import type {
  ActivityContext,
  CanonicalInput,
  Result,
  RetryPolicy,
} from '../shared/types.js';
import { applyRetryPolicyDefaults, ok, err } from '../shared/types.js';
import type { Store } from '../store/types.js';
import { deriveActivityKey } from './idempotency-key.js';
import { computeBackoffMs, isNonRetryable, shouldRetry } from './retry.js';

/** The concrete handle returned from Activity.define(). */
export interface ActivityDefinition<Args extends readonly unknown[], R> {
  readonly name: string;
  readonly retryPolicy: Required<RetryPolicy>;

  /**
   * Invoke the activity with full idempotency + retry semantics.
   * Returns Result<R> — NEVER throws for retry-worthy errors.
   */
  invoke(args: {
    workflowRunId: string;
    activityId: string;
    input: Args;
    actorId: string;
    /** Optional Stripe-style client Idempotency-Key. */
    clientKey?: string;
    /** Optional HTTP route metadata (informs scope on clientKey path). */
    httpMethod?: string;
    httpPath?: string;
    correlationId?: string;
  }): Promise<Result<R, Error>>;
}

export interface DefineActivityOptions<Args extends readonly unknown[], R> {
  name: string;
  store: Store;
  retryPolicy?: RetryPolicy;
  handler: (input: Args, ctx: ActivityContext) => Promise<R>;
  /**
   * Optional custom key derivation. Default: deriveActivityKey().
   * Supplied functions are called once per invocation (not per retry).
   */
  deriveKey?: (ctx: {
    activityName: string;
    workflowRunId: string;
    args: Args;
    attemptNumber: number;
    clientProvidedKey?: string;
    actorId?: string;
    httpMethod?: string;
    httpPath?: string;
  }) => { key: string; scope: string };
  /** Sleep override — injectable for tests to skip real backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Random source for jitter; injectable. */
  rand?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export function defineActivity<Args extends readonly unknown[], R>(
  opts: DefineActivityOptions<Args, R>,
): ActivityDefinition<Args, R> {
  if (!opts.name) throw new Error('defineActivity: name is required');
  if (!opts.store) throw new Error('defineActivity: store is required');
  if (typeof opts.handler !== 'function') {
    throw new Error('defineActivity: handler must be a function');
  }
  const retryPolicy = applyRetryPolicyDefaults(opts.retryPolicy);
  const sleep = opts.sleep ?? defaultSleep;
  const rand = opts.rand ?? Math.random;

  return {
    name: opts.name,
    retryPolicy,
    async invoke(a): Promise<Result<R, Error>> {
      const derived = opts.deriveKey
        ? opts.deriveKey({
            activityName: opts.name,
            workflowRunId: a.workflowRunId,
            args: a.input,
            attemptNumber: 1,
            ...(a.clientKey !== undefined ? { clientProvidedKey: a.clientKey } : {}),
            ...(a.actorId !== undefined ? { actorId: a.actorId } : {}),
            ...(a.httpMethod !== undefined ? { httpMethod: a.httpMethod } : {}),
            ...(a.httpPath !== undefined ? { httpPath: a.httpPath } : {}),
          })
        : deriveActivityKey({
            activityName: opts.name,
            workflowRunId: a.workflowRunId,
            args: a.input as unknown as CanonicalInput,
            attemptNumber: 1,
            ...(a.clientKey !== undefined ? { clientProvidedKey: a.clientKey } : {}),
            ...(a.actorId !== undefined ? { actorId: a.actorId } : {}),
            ...(a.httpMethod !== undefined ? { httpMethod: a.httpMethod } : {}),
            ...(a.httpPath !== undefined ? { httpPath: a.httpPath } : {}),
          });

      // requestHash covers the canonicalized args for mismatch detection
      const requestHash = hashArgs(a.input);

      // Claim — dedup across restarts
      const claim = await opts.store.idempotency.claim({
        key: derived.key,
        scope: derived.scope,
        requestHash,
        actorId: a.actorId,
        ...(a.correlationId !== undefined ? { correlationId: a.correlationId } : {}),
        ...(a.httpMethod !== undefined ? { requestMethod: a.httpMethod } : {}),
        ...(a.httpPath !== undefined ? { requestPath: a.httpPath } : {}),
      });

      if (claim.outcome === 'cached' && claim.row) {
        const row = claim.row;
        if (row.status === 'completed' && row.responseBody !== null) {
          try {
            return ok(JSON.parse(row.responseBody) as R);
          } catch {
            return ok(row.responseBody as unknown as R);
          }
        }
        if (row.status === 'failed') {
          const errBody =
            row.responseBody !== null ? row.responseBody : 'activity previously failed';
          return err(new Error(`ActivityCachedFailure: ${errBody}`));
        }
      }
      if (claim.outcome === 'mismatch') {
        return err(
          new Error(
            `IdempotencyMismatchError: key ${derived.key} exists with different request hash`,
          ),
        );
      }
      if (claim.outcome === 'in_flight') {
        return err(
          new Error(
            `ActivityInFlightError: another attempt is currently processing key ${derived.key}`,
          ),
        );
      }

      // Fresh or reclaimed — proceed with the retry loop.
      const startingAttempt = claim.outcome === 'reclaimed' ? claim.newAttempt ?? 2 : 1;
      let lastError: Error = new Error('ActivityNotAttempted');

      for (let attempt = startingAttempt; ; attempt++) {
        if (attempt > startingAttempt) {
          const waitMs = computeBackoffMs(retryPolicy, attempt, rand);
          if (waitMs > 0) await sleep(waitMs);
        }

        const actCtx: ActivityContext = {
          workflowRunId: a.workflowRunId,
          activityId: a.activityId,
          activityName: opts.name,
          attempt,
          idempotencyKey: derived.key,
          actorId: a.actorId,
        };

        try {
          const result = await opts.handler(a.input, actCtx);
          const body = safeStringify(result);
          await opts.store.idempotency.complete(derived.key, derived.scope, {
            responseBody: body,
          });
          return ok(result);
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          if (isNonRetryable(retryPolicy, lastError)) {
            await opts.store.idempotency.fail(derived.key, derived.scope, {
              body: lastError.message,
            });
            return err(lastError);
          }
          if (!shouldRetry(retryPolicy, attempt, lastError)) {
            await opts.store.idempotency.fail(derived.key, derived.scope, {
              body: lastError.message,
            });
            return err(lastError);
          }
          // otherwise loop
        }
      }
    },
  };
}

/** Convenience namespace matching the design's `Activity.define` sugar. */
export const Activity = {
  define: defineActivity,
} as const;

// ── Internal helpers ──────────────────────────────────────────────────────

function safeStringify(value: unknown): string {
  if (value === undefined) return 'null';
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

function hashArgs(args: readonly unknown[]): string {
  // Not content-addressable — just stable enough for mismatch detection.
  try {
    return JSON.stringify(args);
  } catch {
    return JSON.stringify(args.map((a) => String(a)));
  }
}
