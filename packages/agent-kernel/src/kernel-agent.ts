/**
 * Kernel Agent — represents a physical shop on the A2A network.
 *
 * This agent:
 *   1. Advertises its capabilities to the broker
 *   2. Accepts job assignments
 *   3. Runs jobs on the physical kernel (mock devices in v1)
 *   4. Emits evidence bundles
 *   5. Reports completion back to the broker
 *   6. Handles courier handoff
 *
 * Each KernelAgent wraps one Shop Kernel instance (one physical site).
 */

import { BaseAgent } from "@pcc/agent-runtime";
import type { MessageBus, A2AMessage, Intent, RequestQuoteIntent, JobCompletedIntent } from "@pcc/a2a";
import type { Capability, AssuranceTier, EvidenceBundle } from "@pcc/spec";
import { ids } from "@pcc/spec";
import { EvidenceEmitter } from "@pcc/kernel";
import { JobRunner } from "@pcc/kernel";
import { MockFDMAdapter } from "@pcc/kernel";
import { MockPowerMonitorAdapter } from "@pcc/kernel";
import { MockCameraAdapter } from "@pcc/kernel";

import type { MachineProfile } from "@pcc/spec";

export interface KernelAgentConfig {
  kernelId: string;
  name: string;
  location: { lat: number; lng: number };
  capabilities: Capability[];
  /** Print duration in ms for mock adapter */
  mockPrintDuration?: number;
  /** Machine profiles for the contract builder */
  machineProfiles?: MachineProfile[];
}

interface ActiveJob {
  jobId: string;
  stepId: string;
  requesterId: string;
  conversationId: string;
  status: "queued" | "executing" | "completed" | "failed";
  evidenceBundle?: EvidenceBundle;
  startedAt?: string;
  completedAt?: string;
}

export class KernelAgent extends BaseAgent {
  readonly kernelId: string;
  readonly capabilities: Capability[];
  readonly location: { lat: number; lng: number };
  readonly machineProfiles: MachineProfile[];

  private activeJobs: Map<string, ActiveJob> = new Map();
  private evidenceEmitter: EvidenceEmitter;
  private fdm: MockFDMAdapter;
  private powerMonitor: MockPowerMonitorAdapter;
  private camera: MockCameraAdapter;
  private jobQueue: string[] = [];
  private isProcessing = false;

  constructor(bus: MessageBus, config: KernelAgentConfig) {
    super({
      name: config.name,
      role: "kernel",
      description: `Shop kernel at ${config.name} with ${config.capabilities.map((c) => c.type).join(", ")} capabilities`,
      bus,
    });

    this.kernelId = config.kernelId;
    this.capabilities = config.capabilities;
    this.location = config.location;
    this.machineProfiles = config.machineProfiles ?? [];

    // Initialize mock devices
    this.fdm = new MockFDMAdapter(`dev_fdm_${config.kernelId}`, config.kernelId, config.mockPrintDuration ?? 3000);
    this.powerMonitor = new MockPowerMonitorAdapter(`dev_power_${config.kernelId}`, config.kernelId);
    this.camera = new MockCameraAdapter(`dev_cam_${config.kernelId}`, config.kernelId);
    this.evidenceEmitter = new EvidenceEmitter(config.kernelId);

    // Listen for completed evidence bundles
    this.evidenceEmitter.onBundle((bundle) => {
      this.handleBundleComplete(bundle);
    });

    this.setupIntentHandlers();
    this.setupTools();
  }

  /** Get advertised capabilities (for broker registration) */
  getCapabilities(): Capability[] {
    return [...this.capabilities];
  }

  /** Get machine profiles for the contract builder */
  getMachineProfiles(): MachineProfile[] {
    return [...this.machineProfiles];
  }

  /** Get active jobs */
  getActiveJobs(): ActiveJob[] {
    return [...this.activeJobs.values()];
  }

  // ── Intent Handlers ────────────────────────────────────────────

  private setupIntentHandlers(): void {
    // Quote request — can this kernel do this job and at what price?
    this.onIntent("request_quote", async (msg) => {
      const intent = msg.intent as RequestQuoteIntent;
      return this.handleQuoteRequest(intent);
    });

    // Execute job — broker has assigned this job to this kernel
    this.onIntent("execute_job", async (msg) => {
      const intent = msg.intent as any;
      return this.handleExecuteJob(msg, intent);
    });

    // Cancel job
    this.onIntent("cancel_job", async (msg) => {
      const intent = msg.intent as any;
      return this.handleCancelJob(intent);
    });

    // Courier handoff request
    this.onIntent("request_handoff", async (msg) => {
      const intent = msg.intent as any;
      return this.handleHandoff(msg, intent);
    });

    // Status query
    this.onIntent("job_status_query", async (msg) => {
      const intent = msg.intent as any;
      return this.handleStatusQuery(intent);
    });

    // Text message — only respond to user/broker first-contact, not reply chains
    this.onIntent("text_message", async (msg) => {
      // Don't reply to text_messages that are replies (prevents infinite loop)
      if (msg.inReplyTo) return null;
      return {
        type: "text_message" as const,
        text: `This is ${this.name} (kernel ${this.kernelId}). ` +
          `I have ${this.capabilities.length} capabilities: ${this.capabilities.map((c) => `${c.type} (${c.materials.join(", ")})`).join("; ")}. ` +
          `Currently ${this.activeJobs.size} active jobs.`,
      };
    });
  }

  private async handleQuoteRequest(intent: RequestQuoteIntent): Promise<Intent> {
    // Find matching capability
    const cap = this.capabilities.find((c) => {
      if (c.type !== intent.capabilityType) return false;
      const material = intent.params.material as string | undefined;
      if (material && !c.materials.includes(material)) return false;
      if (!c.assuranceTiers.includes(intent.assuranceTier as AssuranceTier)) return false;
      return true;
    });

    if (!cap) {
      return {
        type: "error",
        code: "no_capability",
        message: `Kernel ${this.kernelId} does not support ${intent.capabilityType} with requested parameters`,
        retryable: false,
      };
    }

    // Calculate price
    const estimatedMinutes = 60; // default
    const baseCost = parseFloat(cap.pricing.baseCost);
    const perMin = parseFloat(cap.pricing.perMinute ?? "0");
    const price = Math.max(parseFloat(cap.pricing.minimum), baseCost + perMin * estimatedMinutes);

    const quoteId = ids.job();
    const quantity = intent.quantity ?? 1;
    const totalPrice = (price * quantity).toFixed(2);
    const bondPercent = [0, 5, 15, 25][intent.assuranceTier] ?? 0;
    const bond = ((price * bondPercent) / 100).toFixed(2);

    return {
      type: "quote_response",
      quoteId,
      pricePerUnit: price.toFixed(2),
      totalPrice,
      currency: cap.pricing.currency,
      estimatedStart: new Date(Date.now() + 5 * 60_000).toISOString(),
      estimatedCompletion: new Date(Date.now() + (5 + estimatedMinutes) * 60_000).toISOString(),
      assuranceTier: intent.assuranceTier,
      operatorBond: bond,
      validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
      kernelId: this.kernelId,
      kernelName: this.name,
    };
  }

  private async handleExecuteJob(msg: A2AMessage, intent: any): Promise<Intent> {
    const jobId = intent.jobId ?? ids.job();
    const stepId = intent.stepId ?? ids.job();

    const activeJob: ActiveJob = {
      jobId,
      stepId,
      requesterId: msg.from,
      conversationId: msg.conversationId,
      status: "queued",
    };
    this.activeJobs.set(jobId, activeJob);
    this.jobQueue.push(jobId);

    // Start processing if not already
    if (!this.isProcessing) {
      this.processQueue().catch(console.error);
    }

    return {
      type: "text_message",
      text: `Job ${jobId} accepted and queued (position ${this.jobQueue.length}). Will begin shortly.`,
    };
  }

  private async handleCancelJob(intent: any): Promise<Intent> {
    const job = this.activeJobs.get(intent.jobId);
    if (!job) {
      return { type: "error", code: "job_not_found", message: "Job not found", retryable: false };
    }
    if (job.status === "executing") {
      return { type: "error", code: "cannot_cancel", message: "Job is already executing", retryable: false };
    }
    job.status = "failed";
    this.jobQueue = this.jobQueue.filter((id) => id !== intent.jobId);
    return { type: "text_message", text: `Job ${intent.jobId} cancelled.` };
  }

  private async handleHandoff(msg: A2AMessage, intent: any): Promise<Intent> {
    const job = this.activeJobs.get(intent.jobId);
    if (!job || job.status !== "completed") {
      return { type: "error", code: "not_ready", message: "Job not ready for handoff", retryable: true };
    }

    return {
      type: "text_message",
      text: `Job ${intent.jobId} ready for courier pickup at ${this.name}. ` +
        `Location: ${this.location.lat}, ${this.location.lng}`,
    };
  }

  private async handleStatusQuery(intent: any): Promise<Intent> {
    const jobId = intent.jobId;
    if (jobId) {
      const job = this.activeJobs.get(jobId);
      if (!job) {
        return { type: "error", code: "job_not_found", message: "Job not found", retryable: false };
      }
      return {
        type: "job_status_response",
        planId: "",
        overallStatus: job.status,
        steps: [{
          stepId: job.stepId,
          status: job.status,
          progress: job.status === "completed" ? 100 : job.status === "executing" ? 50 : 0,
          kernelName: this.name,
          evidenceBundleId: job.evidenceBundle?.id,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
        }],
      };
    }

    // Return all active jobs
    return {
      type: "job_status_response",
      planId: "",
      overallStatus: this.activeJobs.size > 0 ? "active" : "idle",
      steps: [...this.activeJobs.values()].map((j) => ({
        stepId: j.stepId,
        status: j.status,
        progress: j.status === "completed" ? 100 : j.status === "executing" ? 50 : 0,
        kernelName: this.name,
        startedAt: j.startedAt,
        completedAt: j.completedAt,
      })),
    };
  }

  // ── Job Processing ──────────────────────────────────────────────

  private async processQueue(): Promise<void> {
    this.isProcessing = true;

    while (this.jobQueue.length > 0) {
      const jobId = this.jobQueue.shift()!;
      const job = this.activeJobs.get(jobId);
      if (!job || job.status !== "queued") continue;

      job.status = "executing";
      job.startedAt = new Date().toISOString();

      try {
        const runner = new JobRunner(this.fdm, [this.powerMonitor], this.camera, this.evidenceEmitter);
        const result = await runner.run({
          jobId: job.jobId,
          stepId: job.stepId,
          gcodeHash: `sha256_mock_${job.jobId.slice(0, 8)}` as any,
          assuranceTier: 1 as AssuranceTier,
        });

        if (result.success) {
          job.status = "completed";
          job.completedAt = new Date().toISOString();

          // Notify requester (broker) that job is complete
          await this.send(job.requesterId, {
            type: "job_completed",
            jobId: job.jobId,
            stepId: job.stepId,
            evidenceBundleHash: result.bundleHash ?? "",
            summary: `Job completed successfully on ${this.name}. Duration: ${result.durationMs}ms.`,
          }, job.conversationId);
        } else {
          job.status = "failed";
          await this.send(job.requesterId, {
            type: "error",
            code: "job_failed",
            message: `Job ${job.jobId} failed: ${result.error}`,
            retryable: true,
          }, job.conversationId);
        }
      } catch (err) {
        job.status = "failed";
        const message = err instanceof Error ? err.message : String(err);
        await this.send(job.requesterId, {
          type: "error",
          code: "job_error",
          message: `Job ${job.jobId} error: ${message}`,
          retryable: true,
        }, job.conversationId);
      }
    }

    this.isProcessing = false;
  }

  private handleBundleComplete(bundle: EvidenceBundle): void {
    // Find the job this bundle belongs to and attach it
    for (const job of this.activeJobs.values()) {
      if (job.jobId === bundle.jobId) {
        job.evidenceBundle = bundle;
        break;
      }
    }
  }

  // ── Tools ──────────────────────────────────────────────────────

  private setupTools(): void {
    this.registerTool({
      name: "list_capabilities",
      description: "List this kernel's manufacturing capabilities",
      parameters: {},
      execute: async () => this.capabilities.map((c) => ({
        id: c.id,
        type: c.type,
        name: c.name,
        materials: c.materials,
        assuranceTiers: c.assuranceTiers,
        pricing: c.pricing,
      })),
    });

    this.registerTool({
      name: "list_active_jobs",
      description: "List all active jobs on this kernel",
      parameters: {},
      execute: async () => [...this.activeJobs.values()].map((j) => ({
        jobId: j.jobId,
        status: j.status,
        startedAt: j.startedAt,
        completedAt: j.completedAt,
      })),
    });

    this.registerTool({
      name: "get_build_options",
      description: "Get available machine profiles and build options for this kernel",
      parameters: {},
      execute: async () => ({
        kernelId: this.kernelId,
        name: this.name,
        profiles: this.machineProfiles.map((p) => ({
          id: p.id,
          machineName: p.machineName,
          capabilityType: p.capabilityType,
          overrideCount: p.paramOverrides.length,
        })),
      }),
    });

    this.registerTool({
      name: "get_queue_depth",
      description: "Get current queue depth",
      parameters: {},
      execute: async () => ({
        queueDepth: this.jobQueue.length,
        activeJobs: [...this.activeJobs.values()].filter((j) => j.status === "executing").length,
        completedJobs: [...this.activeJobs.values()].filter((j) => j.status === "completed").length,
      }),
    });
  }
}
