/**
 * getVersion() — marker-based versioning for long-running workflows.
 *
 * See design §10 for the full rollout pattern and semantics.
 *
 * Algorithm (design §10.1):
 *   1. Read the workflow's event stream; look for a VersionMarker with the key.
 *   2. If present → return the recorded value (ignore currentValue).
 *   3. If absent → distinguish replay vs fresh:
 *        a. Replay (step_results non-empty AND currentStepIndex > 0 AND status=running)
 *           → return defaultValue, do NOT emit a marker (historic run predates
 *             this decision point).
 *        b. Fresh (no prior step results OR currentStepIndex === 0)
 *           → emit a VersionMarker event with currentValue, return currentValue.
 *
 * Why the replay/fresh distinction matters: a workflow v1 run that crashed
 * mid-flight and is being recovered on a v2 deploy must NOT flip branches
 * just because the deploy added `ctx.getVersion('key', 0, 1)`. The defaultValue
 * is the "what the old code assumed" value.
 */

import type { CanonicalInput } from '../shared/types.js';
import type { Store } from '../store/types.js';

export interface GetVersionArgs {
  store: Store;
  runId: string;
  key: string;
  defaultValue: number;
  currentValue: number;
  correlationId?: string;
}

export async function getVersion(args: GetVersionArgs): Promise<number> {
  const events = await args.store.events.readStream('Workflow', args.runId);
  const existing = events.find(
    (e) =>
      e.eventType === 'VersionMarker' &&
      isObject(e.payload) &&
      (e.payload as { key?: unknown }).key === args.key,
  );
  if (existing && isObject(existing.payload)) {
    const value = (existing.payload as { value?: unknown }).value;
    if (typeof value === 'number') return value;
  }

  const run = await args.store.runs.get(args.runId);
  if (!run) {
    // Unknown run — safest fallback is currentValue so fresh logic kicks in
    return args.currentValue;
  }

  const memoizedSteps = await args.store.steps.listIds(args.runId);
  const isReplay =
    run.status === 'running' && run.currentStepIndex > 0 && memoizedSteps.length > 0;

  if (isReplay) {
    return args.defaultValue;
  }

  const payload: CanonicalInput = { key: args.key, value: args.currentValue };
  await args.store.events.append({
    eventType: 'VersionMarker',
    aggregateType: 'Workflow',
    aggregateId: args.runId,
    actorType: 'workflow',
    actorId: args.runId,
    payload,
    ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
  });
  return args.currentValue;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
