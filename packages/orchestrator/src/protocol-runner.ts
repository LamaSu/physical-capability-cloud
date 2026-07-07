/**
 * ProtocolRunner — executes a bound ProtocolRun by coordinating with
 * the IntraKernelOrchestrator.
 *
 * Converts ProtocolRunSteps into InstrumentSteps, builds an InstrumentWorkflow,
 * delegates execution, tracks run status, and emits ProtocolEvents.
 */

import type {
  ProtocolRun,
  ProtocolRunStatus,
  ProtocolEvent,
  ProtocolEventType,
  InstrumentStep,
  InstrumentWorkflow,
} from "@pcc/spec";
import { ids } from "@pcc/spec";

import { IntraKernelOrchestrator } from "./intra-kernel-orchestrator.js";
import { AutomationTracker } from "./automation-tracker.js";
import { SampleTracker } from "./sample-tracker.js";

/** Options controlling terminal-run retention (R1 unbounded-growth fix). */
export interface ProtocolRunnerOptions {
  /**
   * How long a terminal (completed/failed/cancelled) run stays queryable via
   * getRun() after finishing. Default: 15 minutes.
   */
  terminalRunTtlMs?: number;
  /**
   * Hard cap on retained terminal runs regardless of TTL — oldest terminal
   * runs are evicted first once exceeded. Default: 1000.
   */
  maxTerminalRuns?: number;
}

const TERMINAL_STATUSES: ReadonlySet<ProtocolRunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);
const DEFAULT_TERMINAL_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_TERMINAL_RUNS = 1000;

export class ProtocolRunner {
  private runs = new Map<string, ProtocolRun>();
  private eventListeners = new Set<(event: ProtocolEvent) => void>();
  /** When each run reached a terminal status (ms epoch) — eviction bookkeeping. */
  private terminalAt = new Map<string, number>();
  private readonly terminalRunTtlMs: number;
  private readonly maxTerminalRuns: number;

  constructor(
    private orchestrator: IntraKernelOrchestrator,
    private automationTracker: AutomationTracker,
    private tracker: SampleTracker,
    options: ProtocolRunnerOptions = {},
  ) {
    this.terminalRunTtlMs = options.terminalRunTtlMs ?? DEFAULT_TERMINAL_TTL_MS;
    this.maxTerminalRuns = options.maxTerminalRuns ?? DEFAULT_MAX_TERMINAL_RUNS;
  }

  // ── Execution ────────────────────────────────────────────────────

  /** Execute a bound protocol run */
  async executeRun(run: ProtocolRun): Promise<void> {
    // R1 — sweep expired terminal runs before adding a new one, so the map
    // cannot grow without bound in a long-lived process.
    this.evictTerminalRuns();

    // Store a mutable copy
    const mutableRun: ProtocolRun = { ...run, status: "running", startedAt: new Date().toISOString() };
    this.runs.set(mutableRun.id, mutableRun);
    // Re-execution under the same id makes the run live again
    this.terminalAt.delete(mutableRun.id);

    this.emitEvent(mutableRun.id, "protocol_run_started", {});

    try {
      // Convert ProtocolRunSteps to InstrumentSteps
      const instrumentSteps: InstrumentStep[] = mutableRun.steps.map((runStep, index) => {
        // Build dependsOn from the step ordering — each step depends on the previous
        const dependsOn: string[] = index > 0 ? [mutableRun.steps[index - 1].id] : [];

        return {
          id: runStep.id,
          nodeId: runStep.nodeId,
          action: runStep.action,
          params: runStep.resolvedParams,
          estimatedDurationMs: 1000, // Default; could be provided on the run step
          producesEvidence: false,
          dependsOn,
        };
      });

      // Build the InstrumentWorkflow
      const workflow: InstrumentWorkflow = {
        id: ids.instrumentWorkflow(),
        kernelId: mutableRun.kernelId,
        jobId: mutableRun.jobId ?? mutableRun.id,
        steps: instrumentSteps,
        status: "pending",
      };

      // Create a sample if none exists, or use the first sample ID
      let sampleId: string;
      if (mutableRun.sampleIds.length > 0) {
        sampleId = mutableRun.sampleIds[0];
      } else {
        // Create a sample at the first step's node
        const firstNodeId = mutableRun.steps[0]?.nodeId ?? "unknown";
        const sample = this.tracker.createSample(
          mutableRun.id,
          `Protocol ${mutableRun.templateId} sample`,
          "plate",
          firstNodeId,
        );
        sampleId = sample.id;
        mutableRun.sampleIds = [sampleId];
      }

      // Listen for orchestrator events to translate them to protocol events
      const unsub = this.orchestrator.onEvent((orchEvent) => {
        if (orchEvent.workflowId !== workflow.id) return;

        if (orchEvent.type === "step_started" && orchEvent.stepId) {
          const runStep = mutableRun.steps.find((s) => s.id === orchEvent.stepId);
          if (runStep) {
            runStep.status = "running";
            runStep.startedAt = new Date().toISOString();
            mutableRun.currentStepIndex = mutableRun.steps.indexOf(runStep);
          }
          this.emitEvent(mutableRun.id, "protocol_step_started", {
            stepId: orchEvent.stepId,
          });
        }

        if (orchEvent.type === "step_completed" && orchEvent.stepId) {
          const runStep = mutableRun.steps.find((s) => s.id === orchEvent.stepId);
          if (runStep) {
            runStep.status = "completed";
            runStep.completedAt = new Date().toISOString();
          }
          this.emitEvent(mutableRun.id, "protocol_step_completed", {
            stepId: orchEvent.stepId,
          });
        }

        if (orchEvent.type === "step_failed" && orchEvent.stepId) {
          const runStep = mutableRun.steps.find((s) => s.id === orchEvent.stepId);
          if (runStep) {
            runStep.status = "failed";
            runStep.error = String(orchEvent.payload.error ?? "Unknown error");
          }
          this.emitEvent(mutableRun.id, "protocol_step_failed", {
            stepId: orchEvent.stepId,
            error: orchEvent.payload.error,
          });
        }
      });

      try {
        await this.orchestrator.executeWorkflow(workflow, sampleId);
      } finally {
        unsub();
      }

      // Check final workflow status
      const finalWorkflow = this.orchestrator.getWorkflow(workflow.id);
      if (finalWorkflow?.status === "failed") {
        mutableRun.status = "failed";
        mutableRun.error = finalWorkflow.error;
        mutableRun.completedAt = new Date().toISOString();
        this.markTerminal(mutableRun.id);
        this.emitEvent(mutableRun.id, "protocol_run_failed", {
          error: mutableRun.error,
        });
        return;
      }

      if (finalWorkflow?.status === "cancelled") {
        mutableRun.status = "cancelled";
        mutableRun.completedAt = new Date().toISOString();
        this.markTerminal(mutableRun.id);
        this.emitEvent(mutableRun.id, "protocol_run_cancelled", {});
        return;
      }

      // Process transfers — record episodes if applicable
      for (const transfer of mutableRun.transfers) {
        transfer.status = "completed";
        transfer.completedAt = new Date().toISOString();

        if (transfer.episodeRecorded) {
          try {
            this.automationTracker.recordEpisode(
              transfer.fromNodeId,
              transfer.toNodeId,
              transfer.episodeId,
            );
            this.emitEvent(mutableRun.id, "protocol_episode_recorded", {
              transferId: transfer.id,
              fromNodeId: transfer.fromNodeId,
              toNodeId: transfer.toNodeId,
            });
          } catch {
            // Automation status may not be registered — that's okay
          }
        }
      }

      mutableRun.status = "completed";
      mutableRun.completedAt = new Date().toISOString();
      this.markTerminal(mutableRun.id);
      this.emitEvent(mutableRun.id, "protocol_run_completed", {});
    } catch (err) {
      mutableRun.status = "failed";
      mutableRun.error = err instanceof Error ? err.message : String(err);
      mutableRun.completedAt = new Date().toISOString();
      this.markTerminal(mutableRun.id);
      this.emitEvent(mutableRun.id, "protocol_run_failed", {
        error: mutableRun.error,
      });
    }
  }

  // ── Control ──────────────────────────────────────────────────────

  /** Pause a running protocol */
  async pauseRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Protocol run ${runId} not found`);
    if (run.status !== "running") return;

    run.status = "paused";
    this.emitEvent(runId, "protocol_run_paused", {});
  }

  /** Resume a paused protocol */
  async resumeRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Protocol run ${runId} not found`);
    if (run.status !== "paused") return;

    run.status = "running";
    // In a full implementation, this would re-trigger execution from the current step
  }

  /** Cancel a running protocol */
  async cancelRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Protocol run ${runId} not found`);
    if (run.status !== "running" && run.status !== "paused") return;

    run.status = "cancelled";
    run.completedAt = new Date().toISOString();
    this.markTerminal(runId);
    this.emitEvent(runId, "protocol_run_cancelled", {});
  }

  // ── Queries ──────────────────────────────────────────────────────

  /** Get a run by ID */
  getRun(runId: string): ProtocolRun | undefined {
    return this.runs.get(runId);
  }

  /** Get all active runs */
  getActiveRuns(): ProtocolRun[] {
    return [...this.runs.values()].filter(
      (r) => r.status === "running" || r.status === "paused" || r.status === "ready",
    );
  }

  // ── Retention (R1) ───────────────────────────────────────────────

  /**
   * Evict terminal (completed/failed/cancelled) runs.
   *
   * Terminal runs are kept for a grace window (terminalRunTtlMs) so callers
   * can still read the final status, then dropped. A hard cap
   * (maxTerminalRuns) bounds memory within the window — oldest terminal runs
   * are dropped first. Non-terminal runs are never evicted.
   *
   * Called opportunistically at the start of every executeRun(); safe to
   * call at any time.
   */
  evictTerminalRuns(now: number = Date.now()): void {
    // TTL pass
    for (const [id, at] of this.terminalAt) {
      const run = this.runs.get(id);
      if (!run) {
        this.terminalAt.delete(id);
        continue;
      }
      if (!TERMINAL_STATUSES.has(run.status)) continue; // live again — keep
      if (now - at >= this.terminalRunTtlMs) {
        this.runs.delete(id);
        this.terminalAt.delete(id);
      }
    }

    // Cap pass — oldest terminal runs first
    if (this.terminalAt.size > this.maxTerminalRuns) {
      const terminal = [...this.terminalAt.entries()]
        .filter(([id]) => {
          const run = this.runs.get(id);
          return run ? TERMINAL_STATUSES.has(run.status) : false;
        })
        .sort((a, b) => a[1] - b[1]);
      const excess = terminal.length - this.maxTerminalRuns;
      for (let i = 0; i < excess; i++) {
        this.runs.delete(terminal[i][0]);
        this.terminalAt.delete(terminal[i][0]);
      }
    }
  }

  /** Record that a run reached a terminal status (starts its retention TTL). */
  private markTerminal(runId: string): void {
    this.terminalAt.set(runId, Date.now());
  }

  // ── Events ───────────────────────────────────────────────────────

  /** Subscribe to protocol events */
  onEvent(cb: (event: ProtocolEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  // ── Internals ────────────────────────────────────────────────────

  private emitEvent(
    runId: string,
    type: ProtocolEventType,
    payload: Record<string, unknown>,
  ): void {
    const event: ProtocolEvent = {
      id: ids.protocolEvent(),
      runId,
      timestamp: new Date().toISOString(),
      type,
      stepId: typeof payload.stepId === "string" ? payload.stepId : undefined,
      transferId: typeof payload.transferId === "string" ? payload.transferId : undefined,
      payload,
    };

    for (const cb of this.eventListeners) {
      cb(event);
    }
  }
}
