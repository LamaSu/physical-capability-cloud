/**
 * Opentrons Operator — the full service layer that makes an Opentrons
 * robot available on the PCC capability network.
 *
 * Wires together:
 * - OpentronsMachineAdapter (hardware communication)
 * - DeviceQueue (mutual exclusion + job scheduling)
 * - ProtocolCompiler (abstract steps → OT Python)
 * - A2A intent handlers (discovery, quoting, execution, status)
 * - Evidence collection (run logs, telemetry, photos)
 *
 * This is the single entry point for "I have an Opentrons, let
 * agents use it through PCC."
 */

import type { Capability, CapabilitySlot } from "@pcc/spec";
import type {
  RequestQuoteIntent,
  QuoteResponseIntent,
  DiscoverCapabilitiesIntent,
  CapabilitiesResponseIntent,
  SubmitWorkflowIntent,
  WorkflowAcceptedIntent,
  JobStatusQueryIntent,
  JobStatusResponseIntent,
} from "@pcc/a2a";
import { OpentronsMachineAdapter } from "./adapter.js";
import { DeviceQueue, type QueuedJob, type QueueEvent, type EnqueueResult } from "./queue.js";
import { ProtocolCompiler, type CompiledProtocol } from "./compiler.js";
import type { OpentronAdapterConfig, DeckLayout, LabwareDef } from "./types.js";
import { ProtocolEstimator, type FullEstimate, type JobHistoryEntry } from "./estimator.js";
import { OperatorHealthTracker, type OperatorInfo, type CompletionRecord } from "./health.js";
import { buildCapabilityCard, type CapabilityCard, type DeckSlotState } from "./capability-card.js";
import { BundleValidator, type ExecutionBundle, type BundleValidationResult } from "./execution-bundle.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { JobRunner } from "../job-runner.js";

// ── Operator Config ───────────────────────────────────────────────

export interface OperatorConfig {
  /** Unique kernel ID for this operator */
  kernelId: string;
  /** Human-readable name */
  name: string;
  /** Operator wallet address (receives payments) */
  operatorAddress: string;
  /** Physical location */
  location: { lat: number; lng: number };
  /** Opentrons adapter config */
  adapter: OpentronAdapterConfig;
  /** Pricing */
  pricing: {
    baseCost: string;
    perMinute: string;
    minimum: string;
    currency: string;
  };
  /** Max queue depth (default 10) */
  maxQueueDepth?: number;
  /** Default assurance tier (default 1) */
  defaultAssuranceTier?: number;
}

// ── Job Record ────────────────────────────────────────────────────

export interface OperatorJob {
  id: string;
  conversationId?: string;
  submittedBy: string;
  protocol?: CompiledProtocol;
  protocolSource?: string;
  queueResult: EnqueueResult;
  status: "queued" | "compiling" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  evidenceBundleId?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

// ── Operator ──────────────────────────────────────────────────────

export class OpentronOperator {
  readonly kernelId: string;
  readonly name: string;

  private adapter: OpentronsMachineAdapter;
  private queue: DeviceQueue;
  private compiler: ProtocolCompiler;
  private estimator: ProtocolEstimator;
  private health: OperatorHealthTracker;
  private evidenceEmitter: EvidenceEmitter;
  private config: OperatorConfig;
  private jobs: Map<string, OperatorJob> = new Map();
  private capability: Capability | null = null;
  private bundleValidator: BundleValidator;
  private lastCard: CapabilityCard | null = null;
  private jobCounter = 0;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: OperatorConfig) {
    this.kernelId = config.kernelId;
    this.name = config.name;
    this.config = config;

    this.adapter = new OpentronsMachineAdapter(
      `${config.kernelId}-ot`,
      config.adapter,
    );

    this.queue = new DeviceQueue(config.maxQueueDepth ?? 10);
    this.compiler = new ProtocolCompiler();
    this.estimator = new ProtocolEstimator();
    this.health = new OperatorHealthTracker();
    this.bundleValidator = new BundleValidator();
    this.evidenceEmitter = new EvidenceEmitter(config.kernelId);

    // Wire queue executor to run jobs on the adapter
    this.queue.setExecutor((job) => this.executeJob(job));

    // Listen for queue events
    this.queue.on("queue_event", (event: QueueEvent) => {
      this.handleQueueEvent(event);
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /** Start the operator — verify connection, build capability */
  async start(): Promise<{ online: boolean; capability: Capability }> {
    const info = await this.adapter.getRobotInfo();
    const caps = await this.adapter.getCapabilities();

    this.capability = {
      id: `cap-${this.kernelId}-liquid-handler`,
      kernelId: this.kernelId,
      type: "liquid-handler",
      name: info ? `${info.model} Liquid Handler` : "Opentrons Liquid Handler",
      description: `Opentrons ${info?.model ?? "robot"} with ${caps.pipettes.length} pipettes, ${caps.modules.length} modules. ` +
        `Supports: ${caps.supportedActions.join(", ")}`,
      materials: ["liquid", "reagent", "buffer", "media", "dna", "rna", "protein"],
      assuranceTiers: [0, 1, 2],
      pricing: {
        currency: this.config.pricing.currency,
        baseCost: this.config.pricing.baseCost,
        perMinute: this.config.pricing.perMinute,
        minimum: this.config.pricing.minimum,
      },
      availability: {
        timezone: "UTC",
        windows: {
          0: [{ start: "2026-01-01T00:00:00Z", end: "2026-01-01T23:59:00Z" }],
          1: [{ start: "2026-01-01T00:00:00Z", end: "2026-01-01T23:59:00Z" }],
          2: [{ start: "2026-01-01T00:00:00Z", end: "2026-01-01T23:59:00Z" }],
          3: [{ start: "2026-01-01T00:00:00Z", end: "2026-01-01T23:59:00Z" }],
          4: [{ start: "2026-01-01T00:00:00Z", end: "2026-01-01T23:59:00Z" }],
          5: [{ start: "2026-01-01T00:00:00Z", end: "2026-01-01T23:59:00Z" }],
          6: [{ start: "2026-01-01T00:00:00Z", end: "2026-01-01T23:59:00Z" }],
        },
      },
      location: this.config.location,
      queueDepth: 0,
    };

    // Start heartbeat tracking (every 60s)
    this.heartbeatInterval = setInterval(async () => {
      const status = await this.adapter.getStatus();
      this.health.recordHeartbeat(status !== "offline" && status !== "error");
    }, 60_000);
    this.health.recordHeartbeat(info !== null);
    this.health.recordCalibration(); // assume calibrated at start

    return { online: info !== null, capability: this.capability };
  }

  /** Shut down the operator */
  async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    await this.adapter.dispose();
  }

  // ── A2A Intent Handlers ───────────────────────────────────────

  /** Handle capability discovery — what can this robot do? */
  handleDiscoverCapabilities(
    _intent: DiscoverCapabilitiesIntent,
  ): CapabilitiesResponseIntent {
    if (!this.capability) {
      return { type: "capabilities_response", matches: [], totalMatches: 0 };
    }

    const queueStatus = this.queue.getStatus();

    return {
      type: "capabilities_response",
      matches: [{
        kernelId: this.kernelId,
        kernelName: this.name,
        capabilityId: this.capability.id,
        capabilityName: this.capability.name,
        type: "liquid-handler",
        materials: this.capability.materials,
        price: this.capability.pricing.minimum,
        currency: this.capability.pricing.currency,
        assuranceTiers: this.capability.assuranceTiers,
        queueDepth: queueStatus.depth,
        estimatedAvailability: new Date(
          Date.now() + queueStatus.estimatedWaitMs,
        ).toISOString(),
        reputation: 100,
        location: this.capability.location,
      }],
      totalMatches: 1,
    };
  }

  /** Handle quote request — how much and how long? */
  handleRequestQuote(intent: RequestQuoteIntent): QuoteResponseIntent {
    const queueStatus = this.queue.getStatus();
    const estimatedMinutes = (intent.params.estimatedMinutes as number) ?? 30;
    const baseCost = parseFloat(this.config.pricing.baseCost);
    const perMin = parseFloat(this.config.pricing.perMinute);
    const total = Math.max(
      parseFloat(this.config.pricing.minimum),
      baseCost + perMin * estimatedMinutes,
    );

    const waitMs = queueStatus.estimatedWaitMs;
    const startTime = new Date(Date.now() + waitMs);
    const endTime = new Date(startTime.getTime() + estimatedMinutes * 60_000);

    return {
      type: "quote_response",
      quoteId: `quote-${this.kernelId}-${Date.now()}`,
      pricePerUnit: perMin.toFixed(2),
      totalPrice: total.toFixed(2),
      currency: this.config.pricing.currency,
      estimatedStart: startTime.toISOString(),
      estimatedCompletion: endTime.toISOString(),
      assuranceTier: intent.assuranceTier,
      operatorBond: "0",
      validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
      kernelId: this.kernelId,
      kernelName: this.name,
      options: queueStatus.depth > 0
        ? [{
            name: "Queue Position",
            description: `Currently ${queueStatus.depth} job(s) ahead. Est. wait: ${Math.round(waitMs / 60_000)}min`,
            additionalCost: "0",
          }]
        : undefined,
    };
  }

  /** Handle workflow submission — enqueue the job */
  handleSubmitWorkflow(intent: SubmitWorkflowIntent): WorkflowAcceptedIntent | { type: "error"; code: string; message: string; retryable: boolean } {
    const jobId = `job-${this.kernelId}-${++this.jobCounter}`;
    const estimatedDurationMs = 30 * 60_000; // default 30min

    const queueResult = this.queue.enqueue({
      id: jobId,
      submittedBy: intent.payerWallet,
      estimatedDurationMs,
      payload: intent.cwm,
    });

    if (!queueResult.accepted) {
      return {
        type: "error",
        code: "QUEUE_FULL",
        message: queueResult.reason ?? "Queue is full",
        retryable: true,
      };
    }

    // Track job
    this.jobs.set(jobId, {
      id: jobId,
      submittedBy: intent.payerWallet,
      queueResult,
      status: "queued",
      progress: 0,
      createdAt: new Date().toISOString(),
    });

    // Update capability queue depth
    if (this.capability) {
      this.capability.queueDepth = this.queue.getStatus().depth;
    }

    return {
      type: "workflow_accepted",
      planId: jobId,
      escrowAddress: "0x0000000000000000000000000000000000000000",
      totalEscrowAmount: "0",
      currency: this.config.pricing.currency,
      milestones: [{
        stepId: "step-0",
        amount: "0",
        kernelId: this.kernelId,
        estimatedStart: new Date(Date.now() + queueResult.estimatedWaitMs).toISOString(),
        estimatedEnd: new Date(Date.now() + queueResult.estimatedWaitMs + estimatedDurationMs).toISOString(),
      }],
    };
  }

  /** Handle job status query */
  handleJobStatusQuery(intent: JobStatusQueryIntent): JobStatusResponseIntent {
    const jobId = intent.jobId ?? intent.planId;
    if (!jobId) {
      return {
        type: "job_status_response",
        planId: "",
        overallStatus: "unknown",
        steps: [],
      };
    }

    const job = this.jobs.get(jobId);
    if (!job) {
      return {
        type: "job_status_response",
        planId: jobId,
        overallStatus: "not_found",
        steps: [],
      };
    }

    const position = this.queue.getPosition(jobId);

    return {
      type: "job_status_response",
      planId: jobId,
      overallStatus: job.status,
      steps: [{
        stepId: "step-0",
        status: job.status,
        progress: job.progress,
        kernelName: this.name,
        evidenceBundleId: job.evidenceBundleId,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
      }],
    };
  }

  // ── Estimation & Info ───────────────────────────────────────────

  /** Get a full estimate for a protocol (time, consumables, cost, queue wait) */
  estimateProtocol(
    template: import("@pcc/spec").ProtocolTemplate,
    params: Record<string, string | number | boolean> = {},
  ): FullEstimate {
    const queueWaitMs = this.queue.getStatus().estimatedWaitMs;
    return this.estimator.estimateFull(template, params, this.config.pricing, queueWaitMs);
  }

  /** Get full operator info — everything an agent needs to evaluate this service */
  async getOperatorInfo(): Promise<OperatorInfo> {
    const info = await this.adapter.getRobotInfo();
    const caps = await this.adapter.getCapabilities();
    const queueStatus = this.queue.getStatus();
    const activeJob = queueStatus.active
      ? this.jobs.get(queueStatus.active.id)
      : null;

    return {
      identity: {
        kernelId: this.kernelId,
        name: this.name,
        operatorAddress: this.config.operatorAddress,
        location: this.config.location,
      },
      hardware: {
        model: info?.model ?? "Unknown",
        serialNumber: info?.serialNumber ?? "Unknown",
        firmwareVersion: info?.firmwareVersion ?? "Unknown",
        apiVersion: info?.apiVersion ?? "Unknown",
        pipettes: caps.pipettes.map((p) => ({
          mount: p.mount,
          name: p.name,
          id: p.pipetteId,
          minVolume: p.minVolume,
          maxVolume: p.maxVolume,
          channels: p.channels,
        })),
        modules: caps.modules.map((m) => ({
          type: m.moduleType,
          serial: m.serial,
          slot: m.slot,
          status: m.status,
        })),
        deckSlots: caps.deckSlots,
      },
      state: {
        online: info !== null,
        status: queueStatus.locked ? "busy" : "idle",
        currentJobId: activeJob?.id ?? null,
        currentJobProgress: activeJob?.progress ?? 0,
        currentJobEstimatedRemainingMs: activeJob && queueStatus.active
          ? Math.max(0, queueStatus.active.estimatedDurationMs - (Date.now() - queueStatus.active.enqueuedAt))
          : 0,
        queueDepth: queueStatus.depth,
        queueEstimatedWaitMs: queueStatus.estimatedWaitMs,
      },
      reliability: this.health.getReliability(),
      consumables: this.health.getConsumables(),
      calibration: this.health.getCalibration(),
      scheduling: this.health.getScheduling(),
      pricing: {
        ...this.config.pricing,
        negotiable: false,
      },
      capabilities: {
        actions: caps.supportedActions,
        labware: caps.supportedLabware,
        materials: this.capability?.materials ?? [],
        assuranceTiers: this.capability?.assuranceTiers ?? [0],
        maxProtocolDurationMs: 4 * 60 * 60_000, // 4 hours max
      },
      cancellationPolicy: {
        cancelWhileQueued: true,
        cancelWhileRunning: false,
        cancellationFeePercent: 0,
        fullRefundWindowMs: 5 * 60_000, // 5 minutes
      },
    };
  }

  // ── Capability Card & Execution Bundle ──────────────────────────

  /** Build a CapabilityCard — the full schema an agent needs to build a bundle */
  async getCapabilityCard(): Promise<CapabilityCard> {
    const pipettes = await this.adapter.getPipettes();
    const modules = await this.adapter.getModules();
    const queueStatus = this.queue.getStatus();

    // Build deck slot states (default: 11 slots, all empty and configurable)
    const deckSlots: DeckSlotState[] = [];
    for (let i = 1; i <= 11; i++) {
      const slot = String(i);
      const mod = modules.find((m) => m.slot === slot);
      deckSlots.push({
        slot,
        currentLabware: null,
        configurable: !mod,
        module: mod ? mod.moduleType : null,
      });
    }
    // Slot 12 is fixed trash
    deckSlots.push({ slot: "12", currentLabware: "opentrons_1_trash_1100ml_fixed", configurable: false, module: null });

    const card = buildCapabilityCard(
      this.kernelId,
      this.name,
      this.config.location,
      pipettes,
      modules,
      deckSlots,
      this.config.pricing,
      queueStatus.depth,
      queueStatus.estimatedWaitMs,
    );

    this.lastCard = card;
    return card;
  }

  /**
   * Submit an ExecutionBundle — validate against hardware, compile, and enqueue.
   *
   * This is the main entry point for the user agent → operator agent → machine flow.
   * Returns validation result. If valid, the job is enqueued and executing.
   */
  async submitBundle(bundle: ExecutionBundle): Promise<BundleValidationResult & { jobId?: string; queuePosition?: number; estimatedWaitMs?: number }> {
    // Get fresh card if we don't have one
    const card = this.lastCard ?? await this.getCapabilityCard();
    const pipettes = await this.adapter.getPipettes();

    // Validate
    const validation = this.bundleValidator.validate(bundle, card, pipettes);

    if (!validation.valid) {
      return validation;
    }

    // Convert bundle steps to ProtocolTemplate steps for the compiler
    const deck: DeckLayout = {
      slots: {},
      modules: [],
    };
    for (const entry of bundle.deck) {
      deck.slots[entry.slot] = {
        loadName: entry.labwareLoadName,
        displayName: entry.labwareDisplayName,
        namespace: "opentrons",
        version: 1,
        slot: entry.slot,
      };
    }

    // Build a ProtocolTemplate from bundle steps
    const templateSteps = bundle.steps.map((s) => ({
      id: s.id,
      capabilityType: "liquid-handler" as const,
      label: s.label ?? s.action,
      action: s.action,
      params: s.params as Record<string, unknown>,
      estimatedDurationMs: 5000,
      producesEvidence: true,
      dependsOn: s.dependsOn,
    }));

    const template = {
      id: `bundle-${bundle.idempotencyKey}`,
      name: bundle.metadata?.name ?? "Execution Bundle",
      description: bundle.metadata?.description ?? "",
      version: "1.0",
      authorId: bundle.submitter.agentId,
      authorName: bundle.submitter.agentId,
      status: "published" as const,
      tags: bundle.metadata?.tags ?? [],
      requiredCapabilities: ["liquid-handler"],
      steps: templateSteps,
      transfers: [],
      parameters: [],
      defaultValues: {},
      estimatedTotalDurationMs: 0,
      forkCount: 0,
      runCount: 0,
      createdAt: new Date().toISOString(),
    };

    // Compile to Opentrons Python
    const compiled = this.compiler.compile(template, {}, deck);

    // Estimate
    const estimate = this.estimator.estimateFull(
      template,
      {},
      this.config.pricing,
      this.queue.getStatus().estimatedWaitMs,
    );

    // Check cost doesn't exceed budget
    if (parseFloat(bundle.maxCost.amount) < estimate.cost.totalCost) {
      return {
        valid: false,
        errors: [{
          location: "constraint",
          code: "COST_EXCEEDS_BUDGET",
          message: `Estimated cost ${estimate.cost.totalCost.toFixed(2)} ${estimate.cost.currency} exceeds budget ${bundle.maxCost.amount} ${bundle.maxCost.currency}`,
          suggestion: `Increase maxCost to at least ${estimate.cost.totalCost.toFixed(2)} or reduce protocol steps`,
        }],
        warnings: validation.warnings,
      };
    }

    // Submit to queue
    const jobId = `job-${this.kernelId}-${++this.jobCounter}`;
    const queueResult = this.queue.enqueue({
      id: jobId,
      submittedBy: bundle.submitter.walletAddress,
      estimatedDurationMs: estimate.time.executionMs,
      payload: { protocolSource: compiled.source, bundle },
    });

    if (!queueResult.accepted) {
      return {
        valid: false,
        errors: [{
          location: "constraint",
          code: "TOO_MANY_STEPS" as any,
          message: queueResult.reason ?? "Queue full",
          suggestion: "Try again later or find another operator",
        }],
        warnings: [],
      };
    }

    // Track job
    this.jobs.set(jobId, {
      id: jobId,
      submittedBy: bundle.submitter.walletAddress,
      protocol: compiled,
      protocolSource: compiled.source,
      queueResult,
      status: "queued",
      progress: 0,
      createdAt: new Date().toISOString(),
    });

    if (this.capability) {
      this.capability.queueDepth = this.queue.getStatus().depth;
    }

    return {
      ...validation,
      compiledProtocolSource: compiled.source,
      estimatedDurationMs: estimate.time.executionMs,
      estimatedCost: {
        amount: estimate.cost.totalCost.toFixed(2),
        currency: estimate.cost.currency,
      },
      jobId,
      queuePosition: queueResult.position,
      estimatedWaitMs: queueResult.estimatedWaitMs,
    };
  }

  /** Get the estimator (for direct use) */
  getEstimator(): ProtocolEstimator {
    return this.estimator;
  }

  /** Get the health tracker (for direct use) */
  getHealthTracker(): OperatorHealthTracker {
    return this.health;
  }

  // ── Direct API ────────────────────────────────────────────────

  /** Submit a protocol directly (not through A2A) */
  submitProtocol(
    protocolSource: string,
    submittedBy: string,
    estimatedDurationMs = 30 * 60_000,
  ): EnqueueResult {
    const jobId = `job-${this.kernelId}-${++this.jobCounter}`;

    const queueResult = this.queue.enqueue({
      id: jobId,
      submittedBy,
      estimatedDurationMs,
      payload: { protocolSource },
    });

    if (queueResult.accepted) {
      this.jobs.set(jobId, {
        id: jobId,
        submittedBy,
        protocolSource,
        queueResult,
        status: "queued",
        progress: 0,
        createdAt: new Date().toISOString(),
      });
    }

    return queueResult;
  }

  /** Get all jobs */
  getJobs(): OperatorJob[] {
    return [...this.jobs.values()];
  }

  /** Get a specific job */
  getJob(jobId: string): OperatorJob | undefined {
    return this.jobs.get(jobId);
  }

  /** Get queue status */
  getQueueStatus() {
    return this.queue.getStatus();
  }

  /** Get the adapter for direct robot queries */
  getAdapter(): OpentronsMachineAdapter {
    return this.adapter;
  }

  /** Cancel a queued job */
  cancelJob(jobId: string): boolean {
    const cancelled = this.queue.cancel(jobId);
    if (cancelled) {
      const job = this.jobs.get(jobId);
      if (job) {
        job.status = "cancelled";
        job.completedAt = new Date().toISOString();
      }
    }
    return cancelled;
  }

  // ── Private: Job Execution ────────────────────────────────────

  /** Called by DeviceQueue when it's this job's turn */
  private async executeJob(queuedJob: QueuedJob): Promise<void> {
    const job = this.jobs.get(queuedJob.id);
    if (!job) return;

    job.status = "running";
    job.startedAt = new Date().toISOString();

    try {
      // Get protocol source from payload
      const protocolSource = job.protocolSource ??
        (queuedJob.payload.protocolSource as string) ??
        null;

      if (protocolSource) {
        // Upload protocol to OT
        const uploadResult = await this.adapter.execute({
          type: "load_gcode",
          payload: { protocolSource, protocolName: `pcc-${queuedJob.id}` },
        });

        if (!uploadResult.success) {
          throw new Error(`Protocol upload failed: ${uploadResult.message}`);
        }
      }

      // Start run
      const startResult = await this.adapter.execute({ type: "start" });
      if (!startResult.success) {
        throw new Error(`Run start failed: ${startResult.message}`);
      }

      // Poll until complete
      const timeout = queuedJob.estimatedDurationMs * 2; // 2x buffer
      const startTime = Date.now();

      while (true) {
        const progress = await this.adapter.getProgress();
        job.progress = progress;

        if (progress >= 100) break;

        const status = await this.adapter.getStatus();
        if (status === "error") throw new Error("Robot reported error");
        if (status === "idle" && progress < 100 && progress > 0) {
          throw new Error("Robot went idle before completion");
        }

        if (Date.now() - startTime > timeout) {
          throw new Error("Job timed out");
        }

        await new Promise((r) => setTimeout(r, this.config.adapter.pollIntervalMs ?? 1000));
      }

      job.status = "completed";
      job.progress = 100;
      job.completedAt = new Date().toISOString();

      // Record completion for health tracking + estimation
      this.health.recordCompletion({
        jobId: job.id,
        templateId: "",
        submittedBy: job.submittedBy,
        enqueuedAt: job.createdAt,
        startedAt: job.startedAt!,
        completedAt: job.completedAt,
        actualDurationMs: Date.now() - new Date(job.startedAt!).getTime(),
        queueWaitMs: new Date(job.startedAt!).getTime() - new Date(job.createdAt).getTime(),
        success: true,
        tipsUsed: 0, // TODO: parse from OT run log
        volumeTransferredUl: 0,
        assuranceTier: this.config.defaultAssuranceTier ?? 1,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      job.status = "failed";
      job.error = error;
      job.completedAt = new Date().toISOString();

      // Record failure
      this.health.recordCompletion({
        jobId: job.id,
        templateId: "",
        submittedBy: job.submittedBy,
        enqueuedAt: job.createdAt,
        startedAt: job.startedAt ?? job.createdAt,
        completedAt: job.completedAt,
        actualDurationMs: Date.now() - new Date(job.startedAt ?? job.createdAt).getTime(),
        queueWaitMs: 0,
        success: false,
        errorMessage: error,
        tipsUsed: 0,
        volumeTransferredUl: 0,
        assuranceTier: this.config.defaultAssuranceTier ?? 1,
      });
      throw err; // Re-throw so DeviceQueue marks it failed too
    } finally {
      // Update capability queue depth
      if (this.capability) {
        this.capability.queueDepth = this.queue.getStatus().depth;
      }
    }
  }

  /** Handle queue lifecycle events */
  private handleQueueEvent(event: QueueEvent): void {
    switch (event.type) {
      case "job_started": {
        const job = this.jobs.get(event.job.id);
        if (job) {
          job.status = "running";
          job.startedAt = new Date().toISOString();
        }
        break;
      }
      case "job_completed": {
        const job = this.jobs.get(event.jobId);
        if (job) {
          job.status = "completed";
          job.progress = 100;
          job.completedAt = new Date().toISOString();
        }
        break;
      }
      case "job_failed": {
        const job = this.jobs.get(event.jobId);
        if (job) {
          job.status = "failed";
          job.error = event.error;
          job.completedAt = new Date().toISOString();
        }
        break;
      }
    }
  }
}
