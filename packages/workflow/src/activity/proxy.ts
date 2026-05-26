/**
 * proxyActivities() — typed proxy for invoking activities from inside a workflow.
 *
 * See design §5.5 and §8 for the worked example.
 *
 * The proxy is a type-only convenience. Each method on the returned object
 * calls `.invoke()` on the corresponding ActivityDefinition with a derived
 * workflowRunId + activityId. The user-facing arguments feel like a normal
 * function call; behind the scenes the activity passes through the idempotency
 * + retry pipeline.
 *
 * This module does NOT manage the workflow context — engine.ts does. The proxy
 * returned here is bound to a specific workflow run at construction time via
 * `createActivityProxy()`.
 */

import type { Result } from '../shared/types.js';
import { ActivityFailedError } from '../shared/types.js';
import type { ActivityDefinition } from './define.js';

/**
 * Proxy type map — for each activity definition, return a callable that
 * unwraps Result into its value and throws ActivityFailedError on failure.
 */
export type ActivityProxy<
  TActivities extends Record<string, ActivityDefinition<readonly unknown[], unknown>>,
> = {
  [K in keyof TActivities]: TActivities[K] extends ActivityDefinition<infer A, infer R>
    ? (...args: A) => Promise<R>
    : never;
};

export interface CreateActivityProxyOptions {
  workflowRunId: string;
  actorId: string;
  /** Monotonically-increasing activity counter for stable IDs (engine-managed). */
  nextActivityId: () => string;
  correlationId?: string;
}

/**
 * Build a proxy bound to a particular workflow run. Used internally by the
 * engine; external callers should use the standalone `proxyActivities` sugar.
 */
export function createActivityProxy<
  T extends Record<string, ActivityDefinition<readonly unknown[], unknown>>,
>(activities: T, opts: CreateActivityProxyOptions): ActivityProxy<T> {
  const proxyTarget: Record<string, (...args: readonly unknown[]) => Promise<unknown>> = {};

  for (const [name, def] of Object.entries(activities)) {
    proxyTarget[name] = async (...args: readonly unknown[]): Promise<unknown> => {
      const result = (await def.invoke({
        workflowRunId: opts.workflowRunId,
        activityId: opts.nextActivityId(),
        input: args as readonly unknown[] & never,
        actorId: opts.actorId,
        ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
      })) as Result<unknown, Error>;

      if (!result.ok) {
        throw new ActivityFailedError(def.name, def.retryPolicy.maximumAttempts || 1, result.error);
      }
      return result.value;
    };
  }

  return proxyTarget as unknown as ActivityProxy<T>;
}

/**
 * Public sugar: `proxyActivities<T>(activities)` returns a type-only proxy that
 * the engine rewires inside each workflow run via createActivityProxy().
 *
 * At runtime outside a workflow, this throws — because activities invoked
 * without a run context cannot be properly memoized.
 */
export function proxyActivities<
  T extends Record<string, ActivityDefinition<readonly unknown[], unknown>>,
>(_activities: T): ActivityProxy<T> {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      return () =>
        Promise.reject(
          new Error(
            `proxyActivities: activity '${prop}' invoked outside a workflow run. ` +
              `Use WorkflowContext.activity() inside run() or invoke the ActivityDefinition.invoke() directly.`,
          ),
        );
    },
  };
  return new Proxy({} as Record<string, unknown>, handler) as unknown as ActivityProxy<T>;
}
