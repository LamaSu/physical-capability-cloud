/**
 * Workflow abstract base class.
 *
 * See design §5.5.
 *
 * Users extend this class and implement `run(ctx, args)`. The engine
 * constructs a WorkflowContext and invokes run(); the user's code calls
 * `ctx.step()`, `ctx.activity()`, `ctx.signal()`, `ctx.getVersion()` to
 * compose a durable pipeline.
 */

import type { WorkflowContext } from '../shared/types.js';

export abstract class Workflow<Args = unknown, R = unknown> {
  /** Globally-unique workflow name — used as the registration key. */
  abstract readonly name: string;
  /** Bump when making breaking changes to run() logic. */
  abstract readonly version: number;
  /**
   * The workflow body. Must be deterministic modulo ctx.step() / ctx.activity()
   * invocations — non-memoized code (loops, conditionals, variable
   * assignments) re-runs on every resume.
   */
  abstract run(ctx: WorkflowContext, args: Args): Promise<R>;
}
