import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openSqliteStore } from "@pcc/workflow";

import { Brain } from "../brain/supervisor.js";
import { WorkflowDispatcher } from "../dispatch/workflow-dispatch.js";
import type { OrgFacadeSource, KernelSummary, CapabilitySummary, JobSummary } from "../snapshot/facade-snapshot.js";

/**
 * ACCEPTANCE TEST — the spec's definition of "done" for this package:
 * start Brain -> drive one cycle to a pending queue item + a dispatched-but-
 * incomplete workflow -> kill the process mid-cycle -> restart -> assert it
 * resumes from durable state (item + workflow persist; no double-dispatch).
 *
 * "Kill mid-cycle" is simulated the same way @pcc/workflow's own test suite
 * simulates a crash (see packages/workflow/__tests__/workflow/*.test.ts):
 * drop every in-memory reference WITHOUT calling close() on anything, then
 * construct entirely new objects pointed at the SAME SQLite file. WAL mode
 * supports multiple connections (even sequential ones from one process) to
 * one file, so "session B"'s fresh connections see exactly what "session A"
 * committed — no different, durability-wise, from a real process restart.
 */

class OneStaleKernelSource implements OrgFacadeSource {
  async listKernels(): Promise<KernelSummary[]> {
    return [{ id: "kernel-1", name: "Test Kernel", status: "online", capabilityCount: 1, isStale: true }];
  }
  async listCapabilities(): Promise<CapabilitySummary[]> {
    return [];
  }
  async listJobs(): Promise<JobSummary[]> {
    return [];
  }
}

function freshDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pcc-coordination-"));
  return path.join(dir, "brain.sqlite");
}

describe("kill-resume acceptance test", () => {
  it("resumes from durable state after a mid-cycle kill, with no double-dispatch", async () => {
    const dbPath = freshDbPath();

    // ── Session A (pre-kill) ────────────────────────────────────────────
    const brainA = new Brain({ dbPath, facadeSource: new OneStaleKernelSource() });

    const tickResult = await brainA.tick();
    expect(tickResult.halted).toBe(false);
    // staleKernelRule (the one rule this slice ships) fires on the one
    // stale kernel above and proposes an observe-only escalation — this is
    // the "pending queue item" half of the acceptance criterion, produced
    // by driving the REAL reaction pipeline, not a stub.
    expect(tickResult.enqueued).toHaveLength(1);
    expect(tickResult.enqueued[0]?.status).toBe("pending");

    // staleKernelRule is observe-only by design (a stale heartbeat needs a
    // human to check connectivity, not an automated fix — see
    // reactions/rule-engine.ts). To exercise the dispatch-durability half of
    // the acceptance test, enqueue a second item that DOES carry a
    // dispatchable action — proving the general queue -> approve -> dispatch
    // pipeline, independent of which particular rule produced the item.
    const dispatchableItem = brainA.queue.enqueue({
      severity: "high",
      category: "adapter_failure",
      title: "Adapter retry needed",
      details: "Simulated dispatchable escalation for the kill-resume test.",
      action: { workflowName: "retry-adapter", args: { attempt: 1 } },
    });

    // Human approval (contract (a) resolve semantics).
    brainA.queue.approve(dispatchableItem.id);

    const dispatcherA = new WorkflowDispatcher({ dbPath, bus: brainA.bus });
    await dispatcherA.recover(); // no-op on a fresh file; mirrors real boot order
    const dispatchResultA = await dispatcherA.dispatchApproved();
    expect(dispatchResultA).toHaveLength(1);
    const runIdA = dispatchResultA[0]?.runId;
    expect(runIdA).toBeTruthy();

    // Confirm the workflow is genuinely dispatched-but-incomplete: it
    // durably blocks on ACTION_COMPLETION_SIGNAL, which nothing has sent.
    const peekStoreA = openSqliteStore({ path: dbPath });
    const runRowBeforeKill = await peekStoreA.runs.get(runIdA as string);
    expect(runRowBeforeKill?.status).toBe("running");

    // ── Simulate an ungraceful crash ────────────────────────────────────
    // Deliberately no .close() calls here — an ungraceful kill would not
    // flush/close cleanly either. Every "session A" object is simply never
    // touched again; "session B" below opens brand-new connections.

    // ── Session B (restart) ─────────────────────────────────────────────
    const brainB = new Brain({ dbPath, facadeSource: new OneStaleKernelSource() });

    const itemAfterRestart = brainB.queue.get(dispatchableItem.id);
    expect(itemAfterRestart?.status).toBe("approved");
    expect(itemAfterRestart?.dispatchRunId).toBe(runIdA);

    const dispatcherB = new WorkflowDispatcher({ dbPath, bus: brainB.bus });
    const recovered = await dispatcherB.recover();
    expect(recovered.failed).toBe(0);
    expect(recovered.resumed).toBeGreaterThanOrEqual(1);

    const peekStoreB = openSqliteStore({ path: dbPath });
    const runRowAfterRecover = await peekStoreB.runs.get(runIdA as string);
    // Same run persisted (not lost, not replaced by a new one) and still
    // incomplete — the completion signal was never delivered.
    expect(runRowAfterRecover?.runId).toBe(runIdA);
    expect(runRowAfterRecover?.status).toBe("running");

    // No double-dispatch: the item already carries a dispatchRunId, so a
    // second dispatchApproved() pass must find nothing new to dispatch.
    const dispatchResultB = await dispatcherB.dispatchApproved();
    expect(dispatchResultB).toHaveLength(0);

    brainB.close();
    dispatcherB.close();
    await peekStoreB.close();
  });
});
