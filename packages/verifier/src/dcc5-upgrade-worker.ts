/**
 * DCC5 upgrade worker — async queue runner.
 *
 * Per scope §3.9 + §6 question 3: zkSNARK proofs take 30-90 s minimum.
 * The invoke route returns immediately with `effectiveDccClass: "DCC4"`
 * plus a `pendingZkProofUrl`. This worker polls the Boundless market until
 * the S2 proof is ready, then rewrites the InvocationReceipt with the
 * zkProof bytes + metadata and re-signs the new body.
 *
 * Receipt CID stability (scope §6 Q3):
 *   The receipt is signed TWICE — once at DCC4 commit (CID_v1), once at
 *   DCC5 finalization (CID_v2). The CID changes because the receipt body
 *   now includes the zkProof field. The worker writes BOTH receipts to the
 *   repository so historical CID lookups still resolve.
 *
 * Phase 1 ships an in-memory queue + polling loop. Production wires
 * BullMQ / Redis at startup via the `JobQueue` interface.
 *
 * See ai/scoping/dcc4-dcc5-auto-flows-2026-05-23.md §3.2 + §3.9 + §6.
 */

import type {
  InvocationReceipt,
  ZkProofMetadata,
  ZkSystem,
} from "@pcc/spec";
import {
  pollTeeWrapJob,
  buildTeeWrapMetadata,
  type BoundlessClient,
  type BoundlessJobStatus,
} from "./zk/automata-tee-wrap.js";

// ---------------------------------------------------------------------------
// Job state
// ---------------------------------------------------------------------------

export interface UpgradeJob {
  /** Receipt CID at the time DCC4 was committed (CID_v1). */
  baseReceiptCid: string;
  /** Boundless job id from the initial submit. */
  boundlessJobId: string;
  /** Tool id (used to look up Automata vk + on-chain verifier). */
  toolId: string;
  /** Chosen zkSystem (sp1 by default). */
  zkSystem: ZkSystem;
  /** Submission timestamp (epoch ms). */
  enqueuedAt: number;
  /** Current state. */
  status: "pending" | "complete" | "failed";
  /** Failure reason iff status === "failed". */
  reason?: string;
  /** Resulting receipt CID once DCC5 commit finishes (CID_v2). */
  upgradedReceiptCid?: string;
}

export interface UpgradeJobInput {
  baseReceiptCid: string;
  boundlessJobId: string;
  toolId: string;
  zkSystem: ZkSystem;
}

// ---------------------------------------------------------------------------
// Job queue interface
// ---------------------------------------------------------------------------

export interface JobQueue {
  enqueue: (job: UpgradeJob) => Promise<void>;
  /** Pop one ready job (or null if empty). */
  pop: () => Promise<UpgradeJob | null>;
  /** Update job state in place. */
  updateStatus: (
    baseReceiptCid: string,
    patch: Partial<UpgradeJob>,
  ) => Promise<void>;
  /** Look up by base CID — useful for status endpoints. */
  get: (baseReceiptCid: string) => Promise<UpgradeJob | null>;
  /** List for observability. */
  list: () => Promise<UpgradeJob[]>;
}

/**
 * Minimal in-memory job queue. Production wires BullMQ / Redis-backed.
 *
 * Single-process FIFO. Re-enqueues "pending" jobs at pop time so the
 * worker can retry until done.
 */
export function createInMemoryUpgradeQueue(): JobQueue {
  const jobs = new Map<string, UpgradeJob>();
  const order: string[] = [];
  return {
    async enqueue(job) {
      jobs.set(job.baseReceiptCid, job);
      if (!order.includes(job.baseReceiptCid)) order.push(job.baseReceiptCid);
    },
    async pop() {
      while (order.length > 0) {
        const cid = order.shift()!;
        const job = jobs.get(cid);
        if (job && job.status === "pending") return job;
      }
      return null;
    },
    async updateStatus(baseReceiptCid, patch) {
      const job = jobs.get(baseReceiptCid);
      if (!job) return;
      const merged = { ...job, ...patch };
      jobs.set(baseReceiptCid, merged);
      // Re-enqueue if still pending (back-of-line so other jobs aren't starved).
      if (merged.status === "pending" && !order.includes(baseReceiptCid)) {
        order.push(baseReceiptCid);
      }
    },
    async get(baseReceiptCid) {
      return jobs.get(baseReceiptCid) ?? null;
    },
    async list() {
      return Array.from(jobs.values());
    },
  };
}

// ---------------------------------------------------------------------------
// Receipt rewriter (DI surface)
// ---------------------------------------------------------------------------

/**
 * Callback the worker uses to fetch + persist receipts. Caller wires this
 * to the InvocationReceipts repository.
 */
export interface ReceiptStore {
  /** Fetch by receipt CID. */
  findByCid: (cid: string) => Promise<InvocationReceipt | null>;
  /**
   * Persist an upgraded receipt + return its new CID.
   *
   * Implementation re-signs the new body (now with zkProof + zkProofMetadata
   * fields populated) and inserts a new row. The original DCC4 receipt is
   * preserved at its old CID — this is an APPEND not a mutation.
   */
  persistUpgrade: (
    upgraded: InvocationReceipt,
  ) => Promise<{ newCid: string }>;
}

// ---------------------------------------------------------------------------
// Vk + on-chain verifier lookup (operator config)
// ---------------------------------------------------------------------------

export interface AutomataConfig {
  /**
   * Resolve the Automata image id + vk + on-chain verifier for a given tool.
   * Returns null if the tool didn't opt into DCC5.
   */
  resolveForTool: (toolId: string) => {
    automataImageId: string;
    verificationKeyHash: string;
    onchainVerifier?: { chainId: number; address: string };
  } | null;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface RunUpgradeWorkerOptions {
  client: BoundlessClient;
  queue: JobQueue;
  store: ReceiptStore;
  automata: AutomataConfig;
  /** Max ms to wait between poll cycles. Default 1000. */
  pollIntervalMs?: number;
  /**
   * Maximum total time a job is allowed to stay "pending" before being
   * marked failed. Default 600_000 (10 min) per scope §3.9 (typical 30-90s
   * with safety headroom).
   */
  maxJobLifetimeMs?: number;
  /** Optional logger. */
  log?: (event: string, payload: Record<string, unknown>) => void;
}

/**
 * Process one job from the queue. Returns the job's resulting status
 * (or null if no work was available).
 *
 * Caller schedules this in a loop / cron / setInterval. Failures are
 * non-fatal — the worker logs and moves on.
 */
export async function runOnce(
  options: RunUpgradeWorkerOptions,
): Promise<UpgradeJob | null> {
  const job = await options.queue.pop();
  if (!job) return null;

  const lifetime = Date.now() - job.enqueuedAt;
  const maxLife = options.maxJobLifetimeMs ?? 600_000;
  if (lifetime > maxLife) {
    const failed: Partial<UpgradeJob> = {
      status: "failed",
      reason: `job lifetime exceeded ${maxLife}ms (Boundless never completed)`,
    };
    await options.queue.updateStatus(job.baseReceiptCid, failed);
    options.log?.("dcc5_upgrade_lifetime_exceeded", {
      jobId: job.boundlessJobId,
      baseCid: job.baseReceiptCid,
    });
    return { ...job, ...failed } as UpgradeJob;
  }

  let pollResult: BoundlessJobStatus;
  try {
    pollResult = await pollTeeWrapJob(job.boundlessJobId, {
      client: options.client,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    options.log?.("dcc5_upgrade_poll_failed", {
      jobId: job.boundlessJobId,
      err: reason,
    });
    // Keep pending — transient error; re-enqueue for retry next cycle.
    await options.queue.updateStatus(job.baseReceiptCid, { status: "pending" });
    return job;
  }

  if (pollResult.status === "pending" || pollResult.status === "proving") {
    // Still cooking — re-enqueue (pop removed the job from the order list,
    // so explicit re-enqueue is required to revisit it next cycle).
    await options.queue.updateStatus(job.baseReceiptCid, { status: "pending" });
    return job;
  }

  if (pollResult.status === "failed") {
    const failed: Partial<UpgradeJob> = {
      status: "failed",
      reason: pollResult.reason ?? "boundless reported failed",
    };
    await options.queue.updateStatus(job.baseReceiptCid, failed);
    options.log?.("dcc5_upgrade_boundless_failed", {
      jobId: job.boundlessJobId,
      reason: failed.reason,
    });
    return { ...job, ...failed } as UpgradeJob;
  }

  // complete — apply the upgrade.
  const receipt = await options.store.findByCid(job.baseReceiptCid);
  if (!receipt) {
    const failed: Partial<UpgradeJob> = {
      status: "failed",
      reason: `base receipt CID not found: ${job.baseReceiptCid}`,
    };
    await options.queue.updateStatus(job.baseReceiptCid, failed);
    options.log?.("dcc5_upgrade_base_receipt_missing", {
      baseCid: job.baseReceiptCid,
    });
    return { ...job, ...failed } as UpgradeJob;
  }

  const automataCfg = options.automata.resolveForTool(job.toolId);
  if (!automataCfg) {
    const failed: Partial<UpgradeJob> = {
      status: "failed",
      reason: `tool ${job.toolId} has no DCC5 opt-in (Automata config missing)`,
    };
    await options.queue.updateStatus(job.baseReceiptCid, failed);
    return { ...job, ...failed } as UpgradeJob;
  }

  let metadata: ZkProofMetadata;
  try {
    metadata = buildTeeWrapMetadata(pollResult, {
      automataImageId: automataCfg.automataImageId,
      verificationKeyHash: automataCfg.verificationKeyHash,
      onchainVerifier: automataCfg.onchainVerifier,
      zkSystem: job.zkSystem,
    });
  } catch (e) {
    const failed: Partial<UpgradeJob> = {
      status: "failed",
      reason: `buildTeeWrapMetadata failed: ${e instanceof Error ? e.message : String(e)}`,
    };
    await options.queue.updateStatus(job.baseReceiptCid, failed);
    return { ...job, ...failed } as UpgradeJob;
  }

  // Compose upgraded receipt: append zkProof + metadata, advance DCC class.
  const upgraded: InvocationReceipt = {
    ...receipt,
    effectiveDccClass: maxDcc(receipt.effectiveDccClass, "DCC5" as any),
    zkProof: pollResult.proofBytesBase64,
    zkProofMetadata: metadata,
    zkSystem: job.zkSystem,
    zkProofVerifierAddress: metadata.onchainVerifier,
    downgradeReason:
      receipt.effectiveDccClass === receipt.requestedDccClass
        ? receipt.downgradeReason
        : undefined,
  };

  let newCid: string;
  try {
    const persisted = await options.store.persistUpgrade(upgraded);
    newCid = persisted.newCid;
  } catch (e) {
    const failed: Partial<UpgradeJob> = {
      status: "failed",
      reason: `persistUpgrade failed: ${e instanceof Error ? e.message : String(e)}`,
    };
    await options.queue.updateStatus(job.baseReceiptCid, failed);
    return { ...job, ...failed } as UpgradeJob;
  }

  const done: Partial<UpgradeJob> = {
    status: "complete",
    upgradedReceiptCid: newCid,
  };
  await options.queue.updateStatus(job.baseReceiptCid, done);
  options.log?.("dcc5_upgrade_complete", {
    jobId: job.boundlessJobId,
    baseCid: job.baseReceiptCid,
    newCid,
    provingSeconds: pollResult.provingSeconds,
  });
  return { ...job, ...done } as UpgradeJob;
}

/**
 * Run the worker in a setInterval-style loop until the AbortSignal fires.
 * Each tick processes at most one job. Errors are caught and logged.
 */
export async function runLoop(
  options: RunUpgradeWorkerOptions,
  signal?: AbortSignal,
): Promise<void> {
  const interval = options.pollIntervalMs ?? 1000;
  while (!signal?.aborted) {
    try {
      const result = await runOnce(options);
      if (!result) {
        // Empty queue — wait full interval.
        await sleep(interval, signal);
      } else {
        // Job processed; short pause before next.
        await sleep(50, signal);
      }
    } catch (e) {
      options.log?.("dcc5_upgrade_loop_error", {
        err: e instanceof Error ? e.message : String(e),
      });
      await sleep(interval, signal);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** Lift effective DCC class to the higher of (current, target) by numeric tier. */
function maxDcc(current: string, target: string): InvocationReceipt["effectiveDccClass"] {
  const order: Record<string, number> = {
    DCC0: 0,
    DCC1: 1,
    DCC2: 2,
    DCC3: 3,
    DCC4: 4,
    DCC5: 5,
  };
  return (
    (order[target] ?? 0) > (order[current] ?? 0)
      ? (target as InvocationReceipt["effectiveDccClass"])
      : (current as InvocationReceipt["effectiveDccClass"])
  );
}

/**
 * Convenience: create a fresh upgrade-job record.
 */
export function createUpgradeJob(input: UpgradeJobInput): UpgradeJob {
  return {
    ...input,
    enqueuedAt: Date.now(),
    status: "pending",
  };
}
