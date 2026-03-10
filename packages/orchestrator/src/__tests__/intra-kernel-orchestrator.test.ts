import { describe, it, expect, vi } from "vitest";
import type {
  TransferGraph,
  TransferNode,
  TransferEdge,
  InstrumentStep,
  InstrumentWorkflow,
  OrchestratorEvent,
  OrchestratorEventType,
} from "@pcc/spec";
import { ids } from "@pcc/spec";
import { TransferGraphBuilder } from "../transfer-graph.js";
import { ResourcePool } from "../resource-pool.js";
import { SampleTracker } from "../sample-tracker.js";
import { IntraKernelOrchestrator, type StepExecutor } from "../intra-kernel-orchestrator.js";

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

/** Build a 3-node linear graph: staging -> instrument_a -> instrument_b */
function buildLinearGraph(): TransferGraph {
  const builder = new TransferGraphBuilder();
  builder.addNode(makeNode("staging", "Staging", "staging"));
  builder.addNode(makeNode("inst_a", "Instrument A"));
  builder.addNode(makeNode("inst_b", "Instrument B"));

  builder.addEdge(makeEdge("e1", "staging", "inst_a", 10));
  builder.addEdge(makeEdge("e2", "inst_a", "inst_b", 10));

  return builder.build(KERNEL_ID);
}

function makeStep(
  id: string,
  nodeId: string,
  dependsOn: string[] = [],
  durationMs = 5,
): InstrumentStep {
  return {
    id,
    nodeId,
    action: "process",
    params: {},
    estimatedDurationMs: durationMs,
    producesEvidence: false,
    dependsOn,
  };
}

function makeWorkflow(
  steps: InstrumentStep[],
  jobId = "job_test1",
): InstrumentWorkflow {
  return {
    id: ids.instrumentWorkflow(),
    kernelId: KERNEL_ID,
    jobId,
    steps,
    status: "pending",
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("IntraKernelOrchestrator", () => {
  it("executes a simple 2-step linear workflow", async () => {
    const graph = buildLinearGraph();
    const pool = new ResourcePool();
    const tracker = new SampleTracker();
    const orchestrator = new IntraKernelOrchestrator(graph, pool, tracker);

    const sample = tracker.createSample("job_test1", "S1", "plate", "staging");
    const workflow = makeWorkflow([
      makeStep("s1", "inst_a"),
      makeStep("s2", "inst_b", ["s1"]),
    ]);

    await orchestrator.executeWorkflow(workflow, sample.id);

    const updatedSample = tracker.getSample(sample.id)!;
    expect(updatedSample.currentNodeId).toBe("inst_b");
    expect(updatedSample.status).toBe("completed");

    const wf = orchestrator.getWorkflow(workflow.id)!;
    expect(wf.status).toBe("completed");
    expect(wf.completedAt).toBeDefined();
  });

  it("executes a workflow with step dependencies (fan-in)", async () => {
    // Graph: staging -> A, A -> B, staging -> B (need edge so A and B both reachable from staging)
    // But since topo-sort runs steps sequentially, we just need A reachable from staging
    // and B reachable from A (or staging).
    // Use linear graph: staging -> inst_a -> inst_b
    // Steps: s1 at inst_a (no deps), s2 at inst_a (no deps), s3 at inst_b (depends on s1, s2)
    const graph = buildLinearGraph();
    const pool = new ResourcePool();
    const tracker = new SampleTracker();

    const stepLog: string[] = [];
    const executor: StepExecutor = {
      async execute(step) {
        stepLog.push(step.id);
        await new Promise((r) => setTimeout(r, 5));
        return {};
      },
    };

    const orchestrator = new IntraKernelOrchestrator(graph, pool, tracker, executor);
    const sample = tracker.createSample("job_test1", "S1", "plate", "staging");

    const workflow = makeWorkflow([
      makeStep("s1", "inst_a"),
      makeStep("s2", "inst_a", ["s1"]),
      makeStep("s3", "inst_b", ["s1", "s2"]),
    ]);

    await orchestrator.executeWorkflow(workflow, sample.id);

    // Topo sort ensures s1 before s2, and both before s3
    expect(stepLog.indexOf("s1")).toBeLessThan(stepLog.indexOf("s2"));
    expect(stepLog.indexOf("s2")).toBeLessThan(stepLog.indexOf("s3"));
    expect(orchestrator.getWorkflow(workflow.id)!.status).toBe("completed");
  });

  it("emits events throughout workflow execution", async () => {
    const graph = buildLinearGraph();
    const pool = new ResourcePool();
    const tracker = new SampleTracker();
    const orchestrator = new IntraKernelOrchestrator(graph, pool, tracker);

    const events: OrchestratorEventType[] = [];
    orchestrator.onEvent((event) => {
      events.push(event.type);
    });

    const sample = tracker.createSample("job_test1", "S1", "plate", "staging");
    const workflow = makeWorkflow([makeStep("s1", "inst_a")]);

    await orchestrator.executeWorkflow(workflow, sample.id);

    expect(events).toContain("workflow_started");
    expect(events).toContain("step_started");
    expect(events).toContain("step_completed");
    expect(events).toContain("workflow_completed");

    // workflow_started should be first
    expect(events[0]).toBe("workflow_started");
    // workflow_completed should be last
    expect(events[events.length - 1]).toBe("workflow_completed");
  });

  it("handles resource contention between two workflows", async () => {
    const graph = buildLinearGraph();
    const pool = new ResourcePool();
    const tracker = new SampleTracker();

    const completionOrder: string[] = [];
    const executor: StepExecutor = {
      async execute(step, sampleId) {
        await new Promise((r) => setTimeout(r, 10));
        completionOrder.push(sampleId);
        return {};
      },
    };

    const orchestrator = new IntraKernelOrchestrator(graph, pool, tracker, executor);

    const sample1 = tracker.createSample("job_1", "S1", "plate", "staging");
    const sample2 = tracker.createSample("job_2", "S2", "plate", "staging");

    const wf1 = makeWorkflow([makeStep("s1", "inst_a", [], 10)], "job_1");
    const wf2 = makeWorkflow([makeStep("s2", "inst_a", [], 10)], "job_2");

    // Both target the same instrument — second must wait for the first
    const p1 = orchestrator.executeWorkflow(wf1, sample1.id);
    const p2 = orchestrator.executeWorkflow(wf2, sample2.id);

    await Promise.all([p1, p2]);

    // Both should complete, first workflow's sample finishes at inst_a before the second's
    expect(completionOrder[0]).toBe(sample1.id);
    expect(completionOrder[1]).toBe(sample2.id);
  });

  it("cancels a running workflow", async () => {
    const graph = buildLinearGraph();
    const pool = new ResourcePool();
    const tracker = new SampleTracker();

    const executor: StepExecutor = {
      async execute(step) {
        // Long step — gives us time to cancel
        await new Promise((r) => setTimeout(r, 200));
        return {};
      },
    };

    const orchestrator = new IntraKernelOrchestrator(graph, pool, tracker, executor);
    const sample = tracker.createSample("job_test1", "S1", "plate", "staging");

    const workflow = makeWorkflow([
      makeStep("s1", "inst_a", [], 200),
      makeStep("s2", "inst_b", ["s1"], 200),
    ]);

    // Start the workflow without awaiting it
    const execPromise = orchestrator.executeWorkflow(workflow, sample.id);

    // Wait a tick then cancel
    await new Promise((r) => setTimeout(r, 10));
    await orchestrator.cancelWorkflow(workflow.id);

    // Wait for the workflow to finish processing the cancellation
    await execPromise;

    const wf = orchestrator.getWorkflow(workflow.id)!;
    expect(wf.status).toBe("cancelled");
  });

  it("fails on unreachable node", async () => {
    // Build a disconnected graph: staging -> inst_a, but inst_c is isolated
    const builder = new TransferGraphBuilder();
    builder.addNode(makeNode("staging", "Staging", "staging"));
    builder.addNode(makeNode("inst_a", "Instrument A"));
    builder.addNode(makeNode("inst_c", "Isolated Instrument"));

    builder.addEdge(makeEdge("e1", "staging", "inst_a", 10));
    // No edge to inst_c

    const graph = builder.build(KERNEL_ID);
    const pool = new ResourcePool();
    const tracker = new SampleTracker();
    const orchestrator = new IntraKernelOrchestrator(graph, pool, tracker);

    const sample = tracker.createSample("job_test1", "S1", "plate", "staging");
    const workflow = makeWorkflow([
      makeStep("s1", "inst_a"),
      makeStep("s2", "inst_c", ["s1"]), // inst_c is unreachable from inst_a
    ]);

    await orchestrator.executeWorkflow(workflow, sample.id);

    const wf = orchestrator.getWorkflow(workflow.id)!;
    expect(wf.status).toBe("failed");
    expect(wf.error).toMatch(/No transfer path/);
  });

  it("getActiveWorkflows shows running workflows", async () => {
    const graph = buildLinearGraph();
    const pool = new ResourcePool();
    const tracker = new SampleTracker();

    let resolveStep: (() => void) | undefined;
    const executor: StepExecutor = {
      async execute() {
        await new Promise<void>((r) => {
          resolveStep = r;
        });
        return {};
      },
    };

    const orchestrator = new IntraKernelOrchestrator(graph, pool, tracker, executor);
    const sample = tracker.createSample("job_test1", "S1", "plate", "staging");
    const workflow = makeWorkflow([makeStep("s1", "inst_a")]);

    // Start but don't await
    const execPromise = orchestrator.executeWorkflow(workflow, sample.id);

    // Wait a tick for the workflow to start
    await new Promise((r) => setTimeout(r, 5));

    const active = orchestrator.getActiveWorkflows();
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe("running");

    // Release the step so workflow completes
    resolveStep!();
    await execPromise;

    expect(orchestrator.getActiveWorkflows()).toHaveLength(0);
  });

  it("calls custom StepExecutor with correct arguments", async () => {
    const graph = buildLinearGraph();
    const pool = new ResourcePool();
    const tracker = new SampleTracker();

    const calls: Array<{ stepId: string; sampleId: string; action: string }> = [];
    const executor: StepExecutor = {
      async execute(step, sampleId) {
        calls.push({ stepId: step.id, sampleId, action: step.action });
        return { evidenceHash: "sha256:abc123" };
      },
    };

    const orchestrator = new IntraKernelOrchestrator(graph, pool, tracker, executor);
    const sample = tracker.createSample("job_test1", "S1", "plate", "staging");

    const step = makeStep("s1", "inst_a");
    step.action = "fdm_print";
    const workflow = makeWorkflow([step]);

    await orchestrator.executeWorkflow(workflow, sample.id);

    expect(calls).toHaveLength(1);
    expect(calls[0].stepId).toBe("s1");
    expect(calls[0].sampleId).toBe(sample.id);
    expect(calls[0].action).toBe("fdm_print");
  });
});
