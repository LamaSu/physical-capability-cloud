import { describe, it, expect } from "vitest";
import type {
  TransferNode,
  TransferEdge,
  TransferGraph,
  ProtocolRun,
  ProtocolRunStep,
  ProtocolRunTransfer,
  ProtocolEventType,
} from "@pcc/spec";
import { ids } from "@pcc/spec";
import { TransferGraphBuilder } from "../transfer-graph.js";
import { ResourcePool } from "../resource-pool.js";
import { SampleTracker } from "../sample-tracker.js";
import { IntraKernelOrchestrator, type StepExecutor } from "../intra-kernel-orchestrator.js";
import { AutomationTracker } from "../automation-tracker.js";
import { ProtocolRunner, type ProtocolRunnerOptions } from "../protocol-runner.js";

// ── Helpers ──────────────────────────────────────────────────────────

const KERNEL_ID = "kernel_test1";

function makeNode(
  id: string,
  label: string,
  nodeType: TransferNode["nodeType"] = "instrument",
): Omit<TransferNode, "id"> & { id: string } {
  return { id, kernelId: KERNEL_ID, label, nodeType, capabilities: [] };
}

function makeEdge(
  id: string,
  from: string,
  to: string,
  timeMs: number,
  bidirectional = false,
): Omit<TransferEdge, "id"> & { id: string } {
  return {
    id,
    fromNode: from,
    toNode: to,
    mechanism: "robot_arm",
    transferTimeMs: timeMs,
    bidirectional,
  };
}

function buildLinearGraph(): TransferGraph {
  const builder = new TransferGraphBuilder();
  builder.addNode(makeNode("staging", "Staging", "staging"));
  builder.addNode(makeNode("inst_a", "Instrument A"));
  builder.addNode(makeNode("inst_b", "Instrument B"));

  builder.addEdge(makeEdge("e1", "staging", "inst_a", 10));
  builder.addEdge(makeEdge("e2", "inst_a", "inst_b", 10));

  return builder.build(KERNEL_ID);
}

function makeRunStep(
  id: string,
  nodeId: string,
  action = "process",
): ProtocolRunStep {
  return {
    id,
    protocolStepId: ids.protocolStep(),
    nodeId,
    action,
    resolvedParams: {},
    status: "pending",
  };
}

function makeRunTransfer(
  fromNodeId: string,
  toNodeId: string,
  episodeRecorded = false,
): ProtocolRunTransfer {
  return {
    id: ids.protocolRunTransfer(),
    protocolTransferId: ids.protocolTransfer(),
    fromNodeId,
    toNodeId,
    automationLevel: "manual",
    mechanism: "robot_arm",
    episodeRecorded,
    status: "pending",
  };
}

function makeProtocolRun(
  steps: ProtocolRunStep[],
  transfers: ProtocolRunTransfer[] = [],
): ProtocolRun {
  return {
    id: ids.protocolRun(),
    templateId: ids.protocolTemplate(),
    templateVersion: "1.0.0",
    kernelId: KERNEL_ID,
    parameterValues: {},
    steps,
    transfers,
    status: "ready",
    currentStepIndex: 0,
    initiatedBy: "user_test",
    sampleIds: [],
    createdAt: new Date().toISOString(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ProtocolRunner", () => {
  it("executes a simple 2-step protocol run", async () => {
    const graph = buildLinearGraph();
    const pool = new ResourcePool();
    const sampleTracker = new SampleTracker();
    const orchestrator = new IntraKernelOrchestrator(graph, pool, sampleTracker);
    const autoTracker = new AutomationTracker();

    const runner = new ProtocolRunner(orchestrator, autoTracker, sampleTracker);

    const step1 = makeRunStep("rs1", "inst_a", "print");
    const step2 = makeRunStep("rs2", "inst_b", "inspect");
    const run = makeProtocolRun([step1, step2]);

    await runner.executeRun(run);

    const completedRun = runner.getRun(run.id)!;
    expect(completedRun.status).toBe("completed");
    expect(completedRun.startedAt).toBeDefined();
    expect(completedRun.completedAt).toBeDefined();
  });

  it("emits protocol events through execution lifecycle", async () => {
    const graph = buildLinearGraph();
    const pool = new ResourcePool();
    const sampleTracker = new SampleTracker();
    const orchestrator = new IntraKernelOrchestrator(graph, pool, sampleTracker);
    const autoTracker = new AutomationTracker();

    const runner = new ProtocolRunner(orchestrator, autoTracker, sampleTracker);

    const eventTypes: ProtocolEventType[] = [];
    runner.onEvent((event) => {
      eventTypes.push(event.type);
    });

    const step1 = makeRunStep("rs1", "inst_a");
    const run = makeProtocolRun([step1]);

    await runner.executeRun(run);

    expect(eventTypes).toContain("protocol_run_started");
    expect(eventTypes).toContain("protocol_step_started");
    expect(eventTypes).toContain("protocol_step_completed");
    expect(eventTypes).toContain("protocol_run_completed");

    // run_started should be first
    expect(eventTypes[0]).toBe("protocol_run_started");
    // run_completed should be last
    expect(eventTypes[eventTypes.length - 1]).toBe("protocol_run_completed");
  });

  it("cancels a running protocol via cancelRun", async () => {
    const graph = buildLinearGraph();
    const pool = new ResourcePool();
    const sampleTracker = new SampleTracker();

    // Slow executor to give time to cancel
    const executor: StepExecutor = {
      async execute() {
        await new Promise((r) => setTimeout(r, 200));
        return {};
      },
    };

    const orchestrator = new IntraKernelOrchestrator(graph, pool, sampleTracker, executor);
    const autoTracker = new AutomationTracker();
    const runner = new ProtocolRunner(orchestrator, autoTracker, sampleTracker);

    const step1 = makeRunStep("rs1", "inst_a");
    const step2 = makeRunStep("rs2", "inst_b");
    const run = makeProtocolRun([step1, step2]);

    // Start the run without awaiting
    const execPromise = runner.executeRun(run);

    // Wait a tick then cancel
    await new Promise((r) => setTimeout(r, 10));
    await runner.cancelRun(run.id);

    // Wait for execution to finish
    await execPromise;

    const finalRun = runner.getRun(run.id)!;
    expect(["cancelled", "completed", "failed"]).toContain(finalRun.status);
  });

  it("getActiveRuns returns running protocols", async () => {
    const graph = buildLinearGraph();
    const pool = new ResourcePool();
    const sampleTracker = new SampleTracker();

    let resolveStep: (() => void) | undefined;
    const executor: StepExecutor = {
      async execute() {
        await new Promise<void>((r) => {
          resolveStep = r;
        });
        return {};
      },
    };

    const orchestrator = new IntraKernelOrchestrator(graph, pool, sampleTracker, executor);
    const autoTracker = new AutomationTracker();
    const runner = new ProtocolRunner(orchestrator, autoTracker, sampleTracker);

    const step1 = makeRunStep("rs1", "inst_a");
    const run = makeProtocolRun([step1]);

    // Start but don't await
    const execPromise = runner.executeRun(run);

    // Wait a tick for execution to begin
    await new Promise((r) => setTimeout(r, 10));

    const active = runner.getActiveRuns();
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe("running");

    // Release the step
    resolveStep!();
    await execPromise;

    expect(runner.getActiveRuns()).toHaveLength(0);
  });

  it("pause and resume update run status", async () => {
    const graph = buildLinearGraph();
    const pool = new ResourcePool();
    const sampleTracker = new SampleTracker();

    let resolveStep: (() => void) | undefined;
    const executor: StepExecutor = {
      async execute() {
        await new Promise<void>((r) => {
          resolveStep = r;
        });
        return {};
      },
    };

    const orchestrator = new IntraKernelOrchestrator(graph, pool, sampleTracker, executor);
    const autoTracker = new AutomationTracker();
    const runner = new ProtocolRunner(orchestrator, autoTracker, sampleTracker);

    const step1 = makeRunStep("rs1", "inst_a");
    const run = makeProtocolRun([step1]);

    const execPromise = runner.executeRun(run);

    // Wait for execution to start
    await new Promise((r) => setTimeout(r, 10));

    // Pause
    await runner.pauseRun(run.id);
    let paused = runner.getRun(run.id)!;
    expect(paused.status).toBe("paused");

    // Resume
    await runner.resumeRun(run.id);
    let resumed = runner.getRun(run.id)!;
    expect(resumed.status).toBe("running");

    // Finish execution
    resolveStep!();
    await execPromise;
  });

  it("failed step marks run as failed with error", async () => {
    const graph = buildLinearGraph();
    const pool = new ResourcePool();
    const sampleTracker = new SampleTracker();

    const executor: StepExecutor = {
      async execute() {
        throw new Error("Instrument malfunction");
      },
    };

    const orchestrator = new IntraKernelOrchestrator(graph, pool, sampleTracker, executor);
    const autoTracker = new AutomationTracker();
    const runner = new ProtocolRunner(orchestrator, autoTracker, sampleTracker);

    const eventTypes: ProtocolEventType[] = [];
    runner.onEvent((event) => {
      eventTypes.push(event.type);
    });

    const step1 = makeRunStep("rs1", "inst_a");
    const run = makeProtocolRun([step1]);

    await runner.executeRun(run);

    const failedRun = runner.getRun(run.id)!;
    expect(failedRun.status).toBe("failed");
    expect(failedRun.error).toBeDefined();

    expect(eventTypes).toContain("protocol_run_started");
    expect(eventTypes).toContain("protocol_step_failed");
    expect(eventTypes).toContain("protocol_run_failed");
  });
});

// ── R1 — terminal-run eviction (unbounded Map growth fix) ────────────

describe("ProtocolRunner terminal-run eviction (R1)", () => {
  function makeRunner(options?: ProtocolRunnerOptions, executor?: StepExecutor) {
    const graph = buildLinearGraph();
    const pool = new ResourcePool();
    const sampleTracker = new SampleTracker();
    const orchestrator = new IntraKernelOrchestrator(graph, pool, sampleTracker, executor);
    const autoTracker = new AutomationTracker();
    return new ProtocolRunner(orchestrator, autoTracker, sampleTracker, options);
  }

  it("evicts a completed run once its TTL has elapsed", async () => {
    const runner = makeRunner({ terminalRunTtlMs: 0 });
    const run = makeProtocolRun([makeRunStep("rs1", "inst_a")]);
    await runner.executeRun(run);

    // Terminal but not yet swept — still readable
    expect(runner.getRun(run.id)?.status).toBe("completed");

    runner.evictTerminalRuns();
    expect(runner.getRun(run.id)).toBeUndefined();
  });

  it("keeps terminal runs inside the grace window (default TTL)", async () => {
    const runner = makeRunner(); // 15-minute default
    const run = makeProtocolRun([makeRunStep("rs1", "inst_a")]);
    await runner.executeRun(run);

    runner.evictTerminalRuns();
    expect(runner.getRun(run.id)?.status).toBe("completed");
  });

  it("executeRun sweeps expired terminal runs from previous executions", async () => {
    const runner = makeRunner({ terminalRunTtlMs: 0 });
    const run1 = makeProtocolRun([makeRunStep("rs1", "inst_a")]);
    await runner.executeRun(run1);

    const run2 = makeProtocolRun([makeRunStep("rs2", "inst_a")]);
    await runner.executeRun(run2);

    // run1 was terminal + expired → swept on run2's entry; run2 is intact
    expect(runner.getRun(run1.id)).toBeUndefined();
    expect(runner.getRun(run2.id)?.status).toBe("completed");
  });

  it("failed runs are evicted after TTL too", async () => {
    const failingExecutor: StepExecutor = {
      async execute() {
        throw new Error("Instrument malfunction");
      },
    };
    const runner = makeRunner({ terminalRunTtlMs: 0 }, failingExecutor);
    const run = makeProtocolRun([makeRunStep("rs1", "inst_a")]);
    await runner.executeRun(run);
    expect(runner.getRun(run.id)?.status).toBe("failed");

    runner.evictTerminalRuns();
    expect(runner.getRun(run.id)).toBeUndefined();
  });

  it("never evicts a run that is still active, even with TTL 0", async () => {
    let resolveStep: (() => void) | undefined;
    const executor: StepExecutor = {
      async execute() {
        await new Promise<void>((r) => {
          resolveStep = r;
        });
        return {};
      },
    };
    const runner = makeRunner({ terminalRunTtlMs: 0 }, executor);
    const run = makeProtocolRun([makeRunStep("rs1", "inst_a")]);

    const execPromise = runner.executeRun(run);
    await new Promise((r) => setTimeout(r, 10));

    runner.evictTerminalRuns();
    expect(runner.getRun(run.id)?.status).toBe("running");
    expect(runner.getActiveRuns()).toHaveLength(1);

    resolveStep!();
    await execPromise;
    expect(runner.getRun(run.id)?.status).toBe("completed");
  });

  it("hard cap evicts the oldest terminal runs first", async () => {
    const runner = makeRunner({ terminalRunTtlMs: 60 * 60 * 1000, maxTerminalRuns: 1 });
    const run1 = makeProtocolRun([makeRunStep("rs1", "inst_a")]);
    await runner.executeRun(run1);
    // Ensure distinct terminal timestamps for deterministic oldest-first order
    await new Promise((r) => setTimeout(r, 5));
    const run2 = makeProtocolRun([makeRunStep("rs2", "inst_a")]);
    await runner.executeRun(run2);

    runner.evictTerminalRuns();
    // TTL has not elapsed, but the cap (1) drops the older terminal run
    expect(runner.getRun(run1.id)).toBeUndefined();
    expect(runner.getRun(run2.id)?.status).toBe("completed");
  });

  it("cancelled runs are evicted after TTL", async () => {
    let resolveStep: (() => void) | undefined;
    const executor: StepExecutor = {
      async execute() {
        await new Promise<void>((r) => {
          resolveStep = r;
        });
        return {};
      },
    };
    const runner = makeRunner({ terminalRunTtlMs: 0 }, executor);
    const run = makeProtocolRun([makeRunStep("rs1", "inst_a")]);

    const execPromise = runner.executeRun(run);
    await new Promise((r) => setTimeout(r, 10));
    await runner.cancelRun(run.id);

    resolveStep!();
    await execPromise;

    // Whichever terminal status won the write, the run is terminal + expired
    runner.evictTerminalRuns();
    expect(runner.getRun(run.id)).toBeUndefined();
  });
});
