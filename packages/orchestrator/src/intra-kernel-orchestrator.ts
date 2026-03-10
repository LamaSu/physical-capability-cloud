/**
 * IntraKernelOrchestrator — executes multi-instrument workflows within a
 * single shop kernel by topo-sorting steps, moving samples along the
 * transfer graph, claiming/releasing instruments, and emitting events.
 */

import type {
  TransferGraph,
  TransferEdge,
  InstrumentStep,
  InstrumentWorkflow,
  OrchestratorEvent,
  OrchestratorEventType,
} from "@pcc/spec";
import { ids } from "@pcc/spec";

import { TransferGraphBuilder } from "./transfer-graph.js";
import { ResourcePool } from "./resource-pool.js";
import { SampleTracker } from "./sample-tracker.js";

// ── StepExecutor interface ────────────────────────────────────────

export interface StepExecutor {
  execute(
    step: InstrumentStep,
    sampleId: string,
  ): Promise<{ evidenceHash?: string }>;
}

/** Default executor that just waits estimatedDurationMs. */
class MockStepExecutor implements StepExecutor {
  async execute(step: InstrumentStep): Promise<{ evidenceHash?: string }> {
    await new Promise((resolve) => setTimeout(resolve, step.estimatedDurationMs));
    return {};
  }
}

// ── Orchestrator ──────────────────────────────────────────────────

export class IntraKernelOrchestrator {
  private graphBuilder: TransferGraphBuilder;
  private pool: ResourcePool;
  private tracker: SampleTracker;
  private executor: StepExecutor;

  private activeWorkflows = new Map<string, InstrumentWorkflow>();
  /** workflowId → Set of claim IDs currently held */
  private heldClaims = new Map<string, Set<string>>();
  private eventListeners = new Set<(event: OrchestratorEvent) => void>();

  constructor(
    graph: TransferGraph,
    pool: ResourcePool,
    tracker: SampleTracker,
    executor?: StepExecutor,
  ) {
    this.pool = pool;
    this.tracker = tracker;
    this.executor = executor ?? new MockStepExecutor();

    // Rebuild a TransferGraphBuilder from the immutable graph for pathfinding
    this.graphBuilder = new TransferGraphBuilder();
    for (const node of graph.nodes) {
      this.graphBuilder.addNode(node);
    }
    for (const edge of graph.edges) {
      this.graphBuilder.addEdge(edge);
    }
  }

  // ── Workflow execution ──────────────────────────────────────────

  async executeWorkflow(
    workflow: InstrumentWorkflow,
    sampleId: string,
  ): Promise<void> {
    // Store a mutable copy so we can update status
    const wf: InstrumentWorkflow = { ...workflow, status: "running", startedAt: new Date().toISOString() };
    this.activeWorkflows.set(wf.id, wf);
    this.heldClaims.set(wf.id, new Set());

    this.emit(wf.id, "workflow_started", { sampleId });

    try {
      const sorted = this.topoSort(wf.steps);

      for (const step of sorted) {
        // Check for cancellation
        if (wf.status === "cancelled") return;

        const sample = this.tracker.getSample(sampleId);
        if (!sample) throw new Error(`Sample ${sampleId} not found`);

        // 1. Move sample to the step's node if not already there
        if (sample.currentNodeId !== step.nodeId) {
          await this.moveSampleTo(wf.id, sampleId, sample.currentNodeId, step.nodeId);
        }

        // 2. Claim the instrument
        this.emit(wf.id, "resource_queued", { sampleId, stepId: step.id, nodeId: step.nodeId });
        const claim = await this.pool.waitForAvailability(step.nodeId, wf.id);
        this.heldClaims.get(wf.id)!.add(claim.id);
        this.emit(wf.id, "resource_claimed", {
          sampleId,
          stepId: step.id,
          nodeId: step.nodeId,
          claimId: claim.id,
        });

        // 3. Process
        this.tracker.startProcessing(sampleId);
        this.emit(wf.id, "step_started", { sampleId, stepId: step.id, nodeId: step.nodeId });

        try {
          const result = await this.executor.execute(step, sampleId);
          this.tracker.completeProcessing(sampleId);
          this.emit(wf.id, "step_completed", {
            sampleId,
            stepId: step.id,
            nodeId: step.nodeId,
            evidenceHash: result.evidenceHash,
          });
        } catch (stepErr) {
          this.tracker.completeProcessing(sampleId);
          this.emit(wf.id, "step_failed", {
            sampleId,
            stepId: step.id,
            nodeId: step.nodeId,
            error: stepErr instanceof Error ? stepErr.message : String(stepErr),
          });
          throw stepErr;
        } finally {
          // 4. Release claim
          this.pool.release(claim.id);
          this.heldClaims.get(wf.id)!.delete(claim.id);
          this.emit(wf.id, "resource_released", {
            sampleId,
            stepId: step.id,
            nodeId: step.nodeId,
            claimId: claim.id,
          });
        }
      }

      // All steps completed
      wf.status = "completed";
      wf.completedAt = new Date().toISOString();
      this.tracker.completeSample(sampleId);
      this.emit(wf.id, "workflow_completed", { sampleId });
    } catch (err) {
      wf.status = "failed";
      wf.completedAt = new Date().toISOString();
      wf.error = err instanceof Error ? err.message : String(err);

      // Release any held claims
      this.releaseAllClaims(wf.id);

      this.tracker.failSample(sampleId, wf.error);
      this.emit(wf.id, "workflow_failed", {
        sampleId,
        error: wf.error,
      });
    } finally {
      // Cleanup held-claims tracking (may already be empty)
      this.heldClaims.delete(wf.id);
    }
  }

  // ── Queries ─────────────────────────────────────────────────────

  getActiveWorkflows(): InstrumentWorkflow[] {
    return [...this.activeWorkflows.values()].filter(
      (w) => w.status === "running" || w.status === "pending",
    );
  }

  getWorkflow(id: string): InstrumentWorkflow | undefined {
    return this.activeWorkflows.get(id);
  }

  // ── Cancellation ────────────────────────────────────────────────

  async cancelWorkflow(id: string): Promise<void> {
    const wf = this.activeWorkflows.get(id);
    if (!wf) throw new Error(`Workflow ${id} not found`);
    if (wf.status !== "running" && wf.status !== "pending") return;

    wf.status = "cancelled";
    wf.completedAt = new Date().toISOString();
    this.releaseAllClaims(id);
    this.emit(id, "workflow_cancelled", {});
  }

  // ── Events ──────────────────────────────────────────────────────

  onEvent(cb: (event: OrchestratorEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  // ── Internals ───────────────────────────────────────────────────

  /**
   * Kahn's algorithm: topological sort using in-degree counting.
   */
  private topoSort(steps: InstrumentStep[]): InstrumentStep[] {
    const stepMap = new Map(steps.map((s) => [s.id, s]));
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const step of steps) {
      inDegree.set(step.id, step.dependsOn.length);
      for (const dep of step.dependsOn) {
        let list = dependents.get(dep);
        if (!list) {
          list = [];
          dependents.set(dep, list);
        }
        list.push(step.id);
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const sorted: InstrumentStep[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      sorted.push(stepMap.get(id)!);
      for (const depId of dependents.get(id) ?? []) {
        const newDeg = (inDegree.get(depId) ?? 1) - 1;
        inDegree.set(depId, newDeg);
        if (newDeg === 0) queue.push(depId);
      }
    }

    if (sorted.length !== steps.length) {
      throw new Error("Circular dependency detected in instrument workflow steps");
    }

    return sorted;
  }

  /**
   * Move a sample along the shortest path through the transfer graph.
   */
  private async moveSampleTo(
    workflowId: string,
    sampleId: string,
    fromNodeId: string,
    toNodeId: string,
  ): Promise<void> {
    const pathResult = this.graphBuilder.findPath(fromNodeId, toNodeId);
    if (!pathResult) {
      throw new Error(`No transfer path from ${fromNodeId} to ${toNodeId}`);
    }

    for (const edge of pathResult.edges) {
      const sample = this.tracker.getSample(sampleId)!;
      const nextNode = edge.fromNode === sample.currentNodeId
        ? edge.toNode
        : edge.fromNode;

      this.tracker.moveSample(sampleId, nextNode, edge.mechanism);
      this.emit(workflowId, "sample_moved", {
        sampleId,
        fromNodeId: sample.currentNodeId === nextNode
          ? (edge.fromNode === nextNode ? edge.toNode : edge.fromNode)
          : sample.currentNodeId,
        toNodeId: nextNode,
        mechanism: edge.mechanism,
      });
    }
  }

  private releaseAllClaims(workflowId: string): void {
    const claimIds = this.heldClaims.get(workflowId);
    if (!claimIds) return;
    for (const claimId of claimIds) {
      this.pool.release(claimId);
    }
    claimIds.clear();
  }

  private emit(
    workflowId: string,
    type: OrchestratorEventType,
    payload: Record<string, unknown>,
  ): void {
    const event: OrchestratorEvent = {
      id: ids.orchestratorEvent(),
      workflowId,
      timestamp: new Date().toISOString(),
      type,
      sampleId: typeof payload.sampleId === "string" ? payload.sampleId : undefined,
      stepId: typeof payload.stepId === "string" ? payload.stepId : undefined,
      nodeId: typeof payload.nodeId === "string" ? payload.nodeId : undefined,
      payload,
    };

    for (const cb of this.eventListeners) {
      cb(event);
    }
  }
}
