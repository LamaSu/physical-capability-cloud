/**
 * Worked example from design §8 — JobLifecycleWorkflow.
 *
 * This file is NOT compiled into the published package (examples/ is outside
 * tsconfig.include). It is here as a reference for consumers migrating from
 * the existing protocol-runner.ts.
 *
 * Usage (from gateway bootstrap):
 *
 *   import { openSqliteStore, WorkflowEngine } from '@pcc/workflow';
 *   import { makeActivities, JobLifecycleWorkflow } from './workflows/job-lifecycle.js';
 *
 *   const store = openSqliteStore({ path: '/data/workflow.sqlite' });
 *   const activities = makeActivities(store, { escrow, storacha, oracle });
 *   const engine = new WorkflowEngine({ store, activities });
 *   engine.register(JobLifecycleWorkflow);
 *   const recovered = await engine.recover();
 *
 *   // Start a new run
 *   const handle = await engine.start('JobLifecycle', { jobId, milestoneIdx, amount, bundleCid });
 *   const result = await handle.result();
 */

import {
  Activity,
  deriveOnchainOpKey,
  Workflow,
  type WorkflowContext,
  type Store,
  type ActivityDefinition,
} from '../src/index.js';

// --- 1. Stubs for the external clients we depend on ----------------------

interface TxReceipt {
  hash: string;
  blockNumber: number;
}

interface EscrowClient {
  fund(args: {
    jobId: `0x${string}`;
    milestoneIdx: number;
    amountUsdc: bigint;
    opKey: string;
  }): Promise<{ hash: string }>;
  release(args: {
    jobId: `0x${string}`;
    milestoneIdx: number;
    evidenceCid: string;
    opKey: string;
  }): Promise<{ hash: string }>;
  waitForReceipt(hash: string): Promise<TxReceipt>;
}

interface StorachaClient {
  put(bundleCid: string, opts: { idempotencyKey: string }): Promise<string>;
}

interface OracleClient {
  _stub: true;
}

// --- 2. Activities --------------------------------------------------------

export function makeActivities(
  store: Store,
  deps: { escrow: EscrowClient; storacha: StorachaClient; oracle: OracleClient },
) {
  const fundEscrow = Activity.define<
    readonly [`0x${string}`, number, bigint],
    TxReceipt
  >({
    name: 'fund-escrow',
    store,
    retryPolicy: {
      initialIntervalMs: 2_000,
      maximumAttempts: 7,
      nonRetryableErrorPatterns: ['EscrowAlreadyFundedError', 'InsufficientFundsError'],
    },
    handler: async ([jobId, milestoneIdx, amountUsdc], ctx) => {
      // Design §8.2: opKey uses attempt=1 (fencing token), NOT ctx.attempt.
      const { key: opKey, scope } = deriveOnchainOpKey({
        jobId,
        milestoneIdx,
        action: 'fund',
      });

      // If a prior attempt submitted a tx, poll instead of resubmitting.
      const existing = await store.idempotency.lookup(opKey, scope);
      if (existing?.onchainTxHash) {
        return await deps.escrow.waitForReceipt(existing.onchainTxHash);
      }

      const tx = await deps.escrow.fund({ jobId, milestoneIdx, amountUsdc, opKey });
      await store.idempotency.recordTx(opKey, scope, tx.hash);
      void ctx;
      return deps.escrow.waitForReceipt(tx.hash);
    },
  });

  const uploadEvidence = Activity.define<readonly [string], string>({
    name: 'upload-evidence',
    store,
    retryPolicy: {
      initialIntervalMs: 1_000,
      maximumAttempts: 5,
      nonRetryableErrorPatterns: ['InvalidEvidenceFormatError'],
    },
    handler: async ([bundleCid], ctx) => {
      // Storacha is content-addressable → free dedup on retry.
      return deps.storacha.put(bundleCid, { idempotencyKey: ctx.idempotencyKey });
    },
  });

  const releaseMilestone = Activity.define<
    readonly [`0x${string}`, number, string],
    TxReceipt
  >({
    name: 'release-milestone',
    store,
    retryPolicy: {
      initialIntervalMs: 2_000,
      maximumAttempts: 7,
      nonRetryableErrorPatterns: [
        'MilestoneAlreadyReleasedError',
        'InsufficientAttestationsError',
      ],
    },
    handler: async ([jobId, milestoneIdx, evidenceCid]) => {
      const { key: opKey } = deriveOnchainOpKey({ jobId, milestoneIdx, action: 'release' });
      const tx = await deps.escrow.release({ jobId, milestoneIdx, evidenceCid, opKey });
      return deps.escrow.waitForReceipt(tx.hash);
    },
  });

  return { fundEscrow, uploadEvidence, releaseMilestone };
}

// --- 3. Workflow ----------------------------------------------------------

interface JobArgs {
  jobId: `0x${string}`;
  milestoneIdx: number;
  amount: bigint;
  bundleCid: string;
}

interface JobResult {
  txRelease: string;
  evidenceCid: string;
}

export class JobLifecycleWorkflow extends Workflow<JobArgs, JobResult> {
  readonly name = 'JobLifecycle';
  readonly version = 1;

  async run(ctx: WorkflowContext, args: JobArgs): Promise<JobResult> {
    // Step 1 — fund escrow. Retried per policy, deduped by opKey.
    const fundReceipt = await ctx.step('fund-escrow', async () => {
      return ctx.activity<readonly [`0x${string}`, number, bigint], TxReceipt>(
        'fund-escrow',
        args.jobId,
        args.milestoneIdx,
        args.amount,
      );
    });

    // Step 2 — upload evidence. Content-addressable, free dedup on retry.
    const evidenceCid = await ctx.step('upload-evidence', async () => {
      return ctx.activity<readonly [string], string>('upload-evidence', args.bundleCid);
    });

    // Step 3 — wait for external approval signal (async operator sign-off).
    const approval = await ctx.signal<{ approver: string; ok: boolean }>('approved');
    if (!approval.ok) {
      throw new Error(`ApprovalRejectedError: ${approval.approver}`);
    }

    // Step 4 — release milestone. Retried, deduped, chain-safe.
    const releaseReceipt = await ctx.step('release-milestone', async () => {
      return ctx.activity<readonly [`0x${string}`, number, string], TxReceipt>(
        'release-milestone',
        args.jobId,
        args.milestoneIdx,
        evidenceCid,
      );
    });

    void fundReceipt;
    return { txRelease: releaseReceipt.hash, evidenceCid };
  }
}

// Keep the compiler happy — this file is reference-only and may be imported
// by external tooling for doc extraction.
export type { JobArgs, JobResult };
// Re-export activity types so TS resolves the generic bindings cleanly.
export type JobActivities = ReturnType<typeof makeActivities>;
export type AnyActivityDef = ActivityDefinition<readonly unknown[], unknown>;
