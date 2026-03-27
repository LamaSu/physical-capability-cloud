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

import { BaseAgent, SettlementClient, UnbrowseClient } from "@pcc/agent-runtime";
import type { MessageBus, A2AMessage, Intent, RequestQuoteIntent, JobCompletedIntent } from "@pcc/a2a";
import type { Capability, AssuranceTier, EvidenceBundle } from "@pcc/spec";
import { ids } from "@pcc/spec";
import { EvidenceEmitter } from "@pcc/kernel";
import { JobRunner } from "@pcc/kernel";
import { MockFDMAdapter } from "@pcc/kernel";
import { MockPowerMonitorAdapter } from "@pcc/kernel";
import { MockCameraAdapter } from "@pcc/kernel";
import type { MachineAdapter, SensorAdapter, CameraAdapter } from "@pcc/kernel";
import { evaluatePolicy, type PolicyContext } from "@pcc/kernel";

import type { MachineProfile, OperatorPolicy } from "@pcc/spec";
import { DEFAULT_OPERATOR_POLICY } from "@pcc/spec";

export interface KernelAgentConfig {
  kernelId: string;
  name: string;
  location: { lat: number; lng: number };
  capabilities: Capability[];
  /** Print duration in ms for mock adapter */
  mockPrintDuration?: number;
  /** Machine profiles for the contract builder */
  machineProfiles?: MachineProfile[];
  /** Gateway URL for batch settlement (e.g., "http://localhost:3200") */
  gatewayUrl?: string;
  /** Escrow address → milestone index mapping (set externally when jobs are dispatched) */
  escrowMappings?: Map<string, { escrowAddress: `0x${string}`; milestoneIndex: number }>;
  /** Unbrowse server URL for supply chain monitoring */
  unbrowseUrl?: string;
  /** Supplier URLs to monitor for stock/pricing changes */
  supplierUrls?: string[];
  /** Pluggable adapters — override mock defaults for real hardware */
  adapters?: {
    machine?: MachineAdapter;
    sensors?: SensorAdapter[];
    camera?: CameraAdapter;
  };
  /** Network memberships for dual-network operation */
  networks?: string[];
  /** Operator policy for guardrails (default: safe manual-approval policy) */
  operatorPolicy?: OperatorPolicy;
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
  private machine: MachineAdapter;
  private sensors: SensorAdapter[];
  private camera: CameraAdapter;
  private jobQueue: string[] = [];
  private isProcessing = false;
  private settlement?: SettlementClient;
  private escrowMappings: Map<string, { escrowAddress: `0x${string}`; milestoneIndex: number }> = new Map();
  private unbrowse?: UnbrowseClient;
  private supplierUrls: string[];
  /** Networks this kernel participates in */
  readonly networks: string[];
  /** Operator policy for job guardrails */
  private policy: OperatorPolicy;

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
    this.networks = config.networks ?? ["default"];
    this.policy = config.operatorPolicy ?? DEFAULT_OPERATOR_POLICY;

    // Initialize adapters — use pluggable overrides or fall back to mock
    this.machine = config.adapters?.machine ??
      new MockFDMAdapter(`dev_fdm_${config.kernelId}`, config.kernelId, config.mockPrintDuration ?? 3000);
    this.sensors = config.adapters?.sensors ??
      [new MockPowerMonitorAdapter(`dev_power_${config.kernelId}`, config.kernelId)];
    this.camera = config.adapters?.camera ??
      new MockCameraAdapter(`dev_cam_${config.kernelId}`, config.kernelId);
    this.evidenceEmitter = new EvidenceEmitter(config.kernelId, async (data: string) => {
      const sig = await this.wallet.signMessage(data);
      return { signer: this.wallet.address, algorithm: "secp256k1" as const, value: sig };
    });

    // Listen for completed evidence bundles
    this.evidenceEmitter.onBundle((bundle) => {
      this.handleBundleComplete(bundle);
    });

    // Initialize batch settlement client if gateway URL provided
    if (config.gatewayUrl) {
      this.settlement = new SettlementClient({
        gatewayUrl: config.gatewayUrl,
        agentId: this.id,
        wallet: this.wallet,
      });
    }
    if (config.escrowMappings) {
      this.escrowMappings = config.escrowMappings;
    }

    this.supplierUrls = config.supplierUrls ?? [];
    if (config.unbrowseUrl || process.env.UNBROWSE_URL) {
      this.unbrowse = new UnbrowseClient({ serverUrl: config.unbrowseUrl });
    }

    this.setupIntentHandlers();
    this.setupTools();
  }

  /** Get advertised capabilities (for broker registration) */
  getCapabilities(): Capability[] {
    return [...this.capabilities];
  }

  /** Update operator policy at runtime */
  setPolicy(policy: OperatorPolicy): void {
    this.policy = policy;
  }

  /** Get current operator policy */
  getPolicy(): OperatorPolicy {
    return { ...this.policy };
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

    // ── Policy Enforcement ──────────────────────────────────────
    const policyCtx: PolicyContext = {
      agentId: msg.from,
      capabilityType: intent.capabilityType,
      material: intent.params?.material ?? intent.material,
      estimatedDurationMs: intent.estimatedDurationMs,
      estimatedCost: intent.estimatedCost,
      currentTime: new Date(),
      rateCounts: {
        jobsThisHour: [...this.activeJobs.values()].filter(
          (j) => j.startedAt && Date.now() - new Date(j.startedAt).getTime() < 3600_000,
        ).length,
        jobsToday: this.activeJobs.size,
        costToday: 0,
      },
      quantity: intent.quantity,
      escrowFunded: intent.escrowFunded,
    };

    const evaluation = evaluatePolicy(this.policy, policyCtx);

    if (!evaluation.allowed && !evaluation.requiresApproval) {
      return {
        type: "error",
        code: "policy_violation",
        message: `Job rejected by operator policy: ${evaluation.violations.map((v) => v.message).join("; ")}`,
        retryable: false,
      };
    }

    if (evaluation.requiresApproval) {
      return {
        type: "text_message",
        text: `Job ${jobId} requires operator approval. Status: pending_approval. ` +
          `The operator will review your request within ${Math.round(this.policy.approvalTimeoutMs / 60_000)} minutes.`,
      };
    }

    // ── Approved — queue the job ────────────────────────────────
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
        const runner = new JobRunner(this.machine, this.sensors, this.camera, this.evidenceEmitter);
        const result = await runner.run({
          jobId: job.jobId,
          stepId: job.stepId,
          gcodeHash: `sha256_mock_${job.jobId.slice(0, 8)}` as any,
          assuranceTier: 1 as AssuranceTier,
        });

        if (result.success) {
          job.status = "completed";
          job.completedAt = new Date().toISOString();

          // Auto-submit evidence to escrow via batch settlement
          if (result.bundleHash) {
            this.autoSubmitEvidence(job.jobId, result.bundleHash).catch(() => {});
          }

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

  /**
   * Register an escrow mapping so the kernel knows which escrow contract
   * and milestone index to submit evidence to after job completion.
   */
  registerEscrowMapping(jobId: string, escrowAddress: `0x${string}`, milestoneIndex: number): void {
    this.escrowMappings.set(jobId, { escrowAddress, milestoneIndex });
  }

  /** Get the settlement client (if configured) */
  getSettlement(): SettlementClient | undefined {
    return this.settlement;
  }

  /**
   * Auto-submit evidence to the escrow contract after job completion.
   * Routes through batch settlement for throughput.
   */
  private async autoSubmitEvidence(jobId: string, evidenceBundleHash: string): Promise<void> {
    if (!this.settlement) return;

    const mapping = this.escrowMappings.get(jobId);
    if (!mapping) return;

    try {
      await this.settlement.submitEvidence(
        mapping.escrowAddress,
        mapping.milestoneIndex,
        evidenceBundleHash as `0x${string}`,
      );
    } catch (err) {
      console.warn(
        `[kernel-agent] Auto-submit evidence failed for job ${jobId}:`,
        err instanceof Error ? err.message : err,
      );
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

    // Unbrowse: supply chain monitoring tools
    this.registerTool({
      name: "check_supplier",
      description: "Check a supplier website for material stock, pricing, and lead times via Unbrowse",
      parameters: {
        url: { type: "string", description: "Supplier URL (e.g., McMaster-Carr, Xometry)" },
        query: { type: "string", description: "What to check (e.g., 'PLA filament 1.75mm stock and price')" },
      },
      execute: async (params) => {
        if (!this.unbrowse) return { error: "Unbrowse not configured. Set UNBROWSE_URL or pass unbrowseUrl." };
        return this.unbrowse.resolveSupplierQuery(params.url as string, params.query as string);
      },
    });

    this.registerTool({
      name: "monitor_suppliers",
      description: "Check all configured supplier URLs for stock/pricing changes",
      parameters: {
        material: { type: "string", description: "Material to check across all suppliers" },
      },
      execute: async (params) => {
        if (!this.unbrowse) return { error: "Unbrowse not configured" };
        if (this.supplierUrls.length === 0) return { error: "No supplier URLs configured" };

        const results = [];
        for (const url of this.supplierUrls) {
          try {
            const data = await this.unbrowse.resolveSupplierQuery(
              url,
              `${params.material as string} stock price availability`,
            );
            results.push({ url, ...data });
          } catch (err) {
            results.push({ url, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return results;
      },
    });

    this.registerTool({
      name: "search_materials",
      description: "Search Unbrowse marketplace for material suppliers (finds vendors automatically)",
      parameters: {
        query: { type: "string", description: "Material need (e.g., 'aluminum 6061 sheet 1mm', 'PLA filament bulk')" },
      },
      execute: async (params) => {
        if (!this.unbrowse) return { error: "Unbrowse not configured" };
        return this.unbrowse.searchExternalCapabilities(params.query as string);
      },
    });
  }
}
