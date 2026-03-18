/**
 * SupportAgent — Network-resident bot with complete PCC platform knowledge.
 *
 * Capabilities:
 * - Answers questions about the platform (adapters, capabilities, evidence, settlement)
 * - Runs diagnostics on kernel agents to identify issues
 * - Collects telemetry from all kernels on the network
 * - Escalates critical issues to the operator with full context
 * - Helps troubleshoot onboarding step-by-step
 *
 * Intents handled:
 * - text_message: Free-form questions, routed to knowledge base
 * - job_completed: Telemetry ingestion
 * - error: Error tracking and escalation
 *
 * Custom intents (new):
 * - request_diagnostics: Run full diagnostic on a kernel
 * - report_issue: File a support case
 * - get_telemetry: Get network status snapshot
 */

import type { MessageBus, A2AMessage } from "@pcc/a2a";
import { KnowledgeBase } from "./knowledge-base.js";
import { DiagnosticEngine, type KernelState, type DiagnosticResult } from "./diagnostic-engine.js";
import { TelemetryCollector, type KernelTelemetry, type TelemetrySnapshot } from "./telemetry-collector.js";
import { EscalationManager, type Escalation } from "./escalation-manager.js";

export interface SupportAgentConfig {
  /** Operator agent ID to escalate to (your agent) */
  operatorAgentId: string;
  /** How often to check for timed-out kernels (ms, default 30000) */
  healthCheckIntervalMs?: number;
  /** Auto-escalate on critical issues (default true) */
  autoEscalate?: boolean;
}

export class SupportAgent {
  readonly id: string;
  readonly role = "support" as const;

  private bus: MessageBus;
  private config: SupportAgentConfig;
  private knowledgeBase: KnowledgeBase;
  private diagnosticEngine: DiagnosticEngine;
  private telemetry: TelemetryCollector;
  private escalations: EscalationManager;
  private running = false;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  /** Callback for when the operator should be notified */
  onOperatorAlert?: (message: string, escalation?: Escalation) => void;

  constructor(bus: MessageBus, config: SupportAgentConfig) {
    this.bus = bus;
    this.config = config;
    this.id = `support-agent-${Date.now()}`;
    this.knowledgeBase = new KnowledgeBase();
    this.diagnosticEngine = new DiagnosticEngine();
    this.telemetry = new TelemetryCollector();
    this.escalations = new EscalationManager();
  }

  start(): void {
    this.running = true;

    // Register with bus
    this.bus.register({
      id: this.id,
      name: "PCC Support Agent",
      description: "Network-resident bot with full platform knowledge. Troubleshoots onboarding, adapters, evidence, settlement.",
      role: "support" as any,
      walletAddress: "0x0000000000000000000000000000000000000000",
      capabilities: ["platform-support", "diagnostics", "telemetry", "troubleshooting"],
      endpoint: `agent://${this.id}`,
      supportedIntents: [
        "text_message", "error", "job_completed",
        "request_diagnostics", "report_issue", "get_telemetry",
      ],
      publicKey: "0x00",
    });

    this.bus.subscribe(this.id, (message: A2AMessage) => {
      this.handleMessage(message).catch(err => {
        console.error(`[SUPPORT] Error handling message: ${err}`);
      });
    });

    // Periodic health checks
    const interval = this.config.healthCheckIntervalMs ?? 30_000;
    this.healthTimer = setInterval(() => {
      this.telemetry.checkTimeouts();
      this.checkForEscalations();
    }, interval);

    console.log(`[SUPPORT] Support agent started: ${this.id}`);
    console.log(`  Operator: ${this.config.operatorAgentId}`);
    console.log(`  Knowledge base: ${this.knowledgeBase.getTopics().length} topics`);
  }

  stop(): void {
    this.running = false;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.bus.unregister(this.id);
  }

  // ── Message handling ────────────────────────────────────────────

  private async handleMessage(message: A2AMessage): Promise<void> {
    // Ingest telemetry from all messages
    this.telemetry.processMessage(message);

    switch (message.intent.type) {
      case "text_message":
        await this.handleTextMessage(message);
        break;

      case "error":
        await this.handleError(message);
        break;

      case "job_completed":
        // Telemetry already ingested above
        break;

      default:
        // Handle custom intents
        if ((message.intent as any).type === "request_diagnostics") {
          await this.handleDiagnosticsRequest(message);
        } else if ((message.intent as any).type === "report_issue") {
          await this.handleIssueReport(message);
        } else if ((message.intent as any).type === "get_telemetry") {
          await this.handleTelemetryRequest(message);
        }
        break;
    }
  }

  private async handleTextMessage(message: A2AMessage): Promise<void> {
    const text = ((message.intent as any).text as string) ?? "";
    const query = text.toLowerCase();

    // Check for diagnostic commands
    if (query.includes("diagnose") || query.includes("diagnostic") || query.includes("health check")) {
      const kernelId = this.extractKernelId(text);
      if (kernelId) {
        const telemetry = this.telemetry.getKernel(kernelId);
        if (telemetry) {
          const state = this.telemetryToState(telemetry);
          const result = this.diagnosticEngine.diagnose(state);
          this.reply(message, this.formatDiagnosticResult(result));
          return;
        }
      }
      this.reply(message, "Send me a kernel ID to diagnose, or say 'network status' for the full picture.");
      return;
    }

    // Check for status/telemetry commands
    if (query.includes("status") || query.includes("network") || query.includes("overview")) {
      const snapshot = this.telemetry.snapshot();
      this.reply(message, this.formatTelemetrySnapshot(snapshot));
      return;
    }

    // Check for escalation report
    if (query.includes("escalation") || query.includes("issues") || query.includes("problems")) {
      this.reply(message, this.escalations.formatReport());
      return;
    }

    // Search knowledge base
    const results = this.knowledgeBase.search(text);
    if (results.length > 0) {
      const response = results.map((r, i) =>
        `${i + 1}. **${r.question}**\n${r.answer}`
      ).join("\n\n");
      this.reply(message, response);
    } else {
      this.reply(message, [
        "I couldn't find a specific answer for that. Here's what I can help with:",
        "",
        "- **Adapters**: How to wrap device APIs (HTTP, OPC-UA, Modbus, SiLA 2)",
        "- **Capabilities**: 44 built-in types, pricing, materials",
        "- **Evidence**: Assurance tiers, bundle hashing, IPFS storage",
        "- **Settlement**: Escrow lifecycle, bonds, disputes",
        "- **Network**: Connectivity, message delivery, agent registration",
        "- **Diagnostics**: 'diagnose <kernel-id>' for health check",
        "- **Status**: 'network status' for overview",
        "- **Onboarding**: Step-by-step setup guide",
        "",
        "Try asking something specific, or say 'diagnose kernel_xxx' for a health check.",
      ].join("\n"));
    }
  }

  private async handleError(message: A2AMessage): Promise<void> {
    const intent = message.intent as any;
    const errorMessage = intent.message ?? "Unknown error";
    const code = intent.code ?? "unknown";

    // Track in telemetry
    const existing = this.telemetry.getKernel(message.from);
    if (existing) {
      this.telemetry.ingest(message.from, {
        recentErrors: [...existing.recentErrors.slice(-9), {
          timestamp: message.timestamp,
          message: errorMessage,
          source: message.from,
        }],
      });
    }

    // Auto-escalate critical errors
    if (this.isCritical(code, errorMessage)) {
      const escalation = this.escalations.escalate({
        severity: "critical",
        kernelId: existing?.kernelId ?? message.from,
        agentId: message.from,
        category: this.categorizeError(code),
        title: `Critical error from ${message.from}: ${code}`,
        details: errorMessage,
        suggestedFix: this.suggestFix(code, errorMessage),
      });

      if (this.config.autoEscalate !== false) {
        this.notifyOperator(escalation);
      }
    }

    // Reply with help
    const fix = this.suggestFix(code, errorMessage);
    this.reply(message, fix
      ? `Error noted. Suggested fix: ${fix}`
      : `Error noted: ${errorMessage}. I've logged this for review. Try 'diagnose ${message.from}' for a full health check.`
    );
  }

  private async handleDiagnosticsRequest(message: A2AMessage): Promise<void> {
    const intent = message.intent as any;
    const kernelId = intent.kernelId ?? message.from;
    const telemetry = this.telemetry.getKernel(kernelId);

    if (!telemetry) {
      this.reply(message, `No telemetry available for ${kernelId}. The kernel needs to send at least one message first.`);
      return;
    }

    const state = this.telemetryToState(telemetry);
    // Allow the requester to supplement with more state
    if (intent.state) {
      Object.assign(state, intent.state);
    }

    const result = this.diagnosticEngine.diagnose(state);
    this.reply(message, this.formatDiagnosticResult(result));

    // Auto-escalate if failures found
    if (result.failCount > 0 && this.config.autoEscalate !== false) {
      const escalation = this.escalations.escalate({
        severity: result.failCount > 3 ? "high" : "medium",
        kernelId,
        agentId: message.from,
        category: "general",
        title: `Diagnostic: ${result.failCount} failures for ${kernelId}`,
        details: result.summary,
        suggestedFix: result.checks.find(c => c.status === "fail")?.fix,
      });
      this.notifyOperator(escalation);
    }
  }

  private async handleIssueReport(message: A2AMessage): Promise<void> {
    const intent = message.intent as any;
    const escalation = this.escalations.escalate({
      severity: intent.severity ?? "medium",
      kernelId: intent.kernelId ?? message.from,
      agentId: message.from,
      category: intent.category ?? "general",
      title: intent.title ?? "Issue reported",
      details: intent.details ?? "No details provided",
      suggestedFix: intent.suggestedFix,
    });

    this.reply(message, `Issue logged: ${escalation.id}. Severity: ${escalation.severity}. The operator has been notified.`);
    this.notifyOperator(escalation);
  }

  private async handleTelemetryRequest(message: A2AMessage): Promise<void> {
    const snapshot = this.telemetry.snapshot();
    this.reply(message, this.formatTelemetrySnapshot(snapshot));
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private reply(original: A2AMessage, text: string): void {
    this.bus.send({
      id: `msg_${Date.now()}`,
      conversationId: original.conversationId,
      from: this.id,
      to: original.from,
      intent: { type: "text_message", text } as any,
      timestamp: new Date().toISOString(),
      inReplyTo: original.id,
    });
  }

  private notifyOperator(escalation: Escalation): void {
    const formatted = this.escalations.formatForOperator(escalation);

    // Send via A2A to operator
    this.bus.send({
      id: `msg_${Date.now()}`,
      conversationId: `esc_${escalation.id}`,
      from: this.id,
      to: this.config.operatorAgentId,
      intent: { type: "text_message", text: `ESCALATION:\n${formatted}` } as any,
      timestamp: new Date().toISOString(),
    });

    // Also fire callback if set
    if (this.onOperatorAlert) {
      this.onOperatorAlert(formatted, escalation);
    }
  }

  private checkForEscalations(): void {
    const snapshot = this.telemetry.snapshot();

    // Escalate offline kernels
    for (const kernel of snapshot.kernels) {
      if (kernel.status === "offline") {
        this.escalations.escalate({
          severity: "high",
          kernelId: kernel.kernelId,
          agentId: kernel.agentId,
          category: "network_issue",
          title: `Kernel ${kernel.kernelId} offline`,
          details: `Last seen: ${kernel.lastSeen}. No messages received within timeout window.`,
          suggestedFix: "Check if the kernel process is running. Verify network connectivity to the gateway.",
        });
      }

      // Escalate high error rates
      if (kernel.recentErrors.length > 5) {
        this.escalations.escalate({
          severity: "medium",
          kernelId: kernel.kernelId,
          agentId: kernel.agentId,
          category: "adapter_failure",
          title: `High error rate on ${kernel.kernelId}`,
          details: `${kernel.recentErrors.length} recent errors. Last: ${kernel.recentErrors[kernel.recentErrors.length - 1]?.message}`,
          suggestedFix: "Check adapter connections and device health. Run diagnostics.",
        });
      }
    }
  }

  private telemetryToState(t: KernelTelemetry): KernelState {
    return {
      kernelId: t.kernelId,
      agentStarted: true,
      agentRegistered: true,
      capabilities: t.capabilities.map((type: string) => ({
        type,
        materials: [] as string[],
        assuranceTiers: [0, 1] as number[],
        pricing: { baseCost: "0", perMinute: "0", minimum: "0", currency: "USDC" },
      })),
      adapters: t.adapterStatuses.map((a: { id: string; type: string; status: string; errorCount: number }) => ({
        id: a.id,
        type: a.type as "machine" | "sensor" | "camera",
        status: a.status,
        errorCount: a.errorCount,
      })),
      activeJobs: t.activeJobs,
      completedJobs: t.completedJobs,
      failedJobs: t.failedJobs,
      evidenceBundles: t.evidenceBundles,
      networkConnected: t.status !== "offline",
      escrowMappings: 0,
      pendingSettlements: 0,
      errors: t.recentErrors,
    };
  }

  private formatDiagnosticResult(result: DiagnosticResult): string {
    const lines = [
      `=== Diagnostic Report: ${result.kernelId} ===`,
      result.summary,
      "",
    ];

    const failures = result.checks.filter(c => c.status === "fail");
    if (failures.length > 0) {
      lines.push("FAILURES:");
      for (const check of failures) {
        lines.push(`  [FAIL] ${check.name}: ${check.message}`);
        if (check.fix) lines.push(`    Fix: ${check.fix}`);
      }
      lines.push("");
    }

    const warnings = result.checks.filter(c => c.status === "warn");
    if (warnings.length > 0) {
      lines.push("WARNINGS:");
      for (const check of warnings) {
        lines.push(`  [WARN] ${check.name}: ${check.message}`);
        if (check.fix) lines.push(`    Fix: ${check.fix}`);
      }
    }

    return lines.join("\n");
  }

  private formatTelemetrySnapshot(snapshot: TelemetrySnapshot): string {
    const lines = [
      `=== Network Status (${snapshot.timestamp}) ===`,
      `Health: ${snapshot.networkHealth.toUpperCase()}`,
      `Kernels: ${snapshot.totalOnline} online, ${snapshot.totalDegraded} degraded, ${snapshot.totalOffline} offline`,
      `Active jobs: ${snapshot.totalActiveJobs}`,
    ];

    if (snapshot.kernels.length > 0) {
      lines.push("", "Kernels:");
      for (const k of snapshot.kernels) {
        const status = k.status === "online" ? "[OK]" : k.status === "degraded" ? "[WARN]" : "[OFF]";
        lines.push(`  ${status} ${k.kernelId} — ${k.capabilities.join(", ") || "no capabilities"} — ${k.activeJobs} active, ${k.completedJobs} completed`);
      }
    } else {
      lines.push("", "No kernels connected yet.");
    }

    return lines.join("\n");
  }

  private extractKernelId(text: string): string | undefined {
    const match = text.match(/kernel[_-]\w+/i);
    return match?.[0];
  }

  private isCritical(code: string, message: string): boolean {
    return code === "adapter_crash" || code === "evidence_corruption" || code === "settlement_failure"
      || message.toLowerCase().includes("fatal") || message.toLowerCase().includes("crash");
  }

  private categorizeError(code: string): Escalation["category"] {
    if (code.includes("adapter")) return "adapter_failure";
    if (code.includes("evidence")) return "evidence_issue";
    if (code.includes("settlement") || code.includes("escrow")) return "settlement_failure";
    if (code.includes("network") || code.includes("connect")) return "network_issue";
    if (code.includes("capability")) return "capability_error";
    return "general";
  }

  private suggestFix(code: string, message: string): string | undefined {
    const msg = message.toLowerCase();
    if (msg.includes("timeout")) return "Check device connectivity. Increase pollIntervalMs or timeout values.";
    if (msg.includes("auth") || msg.includes("401") || msg.includes("403")) return "Check API key / auth token. Verify credentials are correct.";
    if (msg.includes("not found") || msg.includes("404")) return "Check the endpoint URL. Verify the device API is running.";
    if (msg.includes("hash") || msg.includes("mismatch")) return "Evidence bundle may have been modified after finalization. Let EvidenceEmitter handle all hashing.";
    if (msg.includes("gas") || msg.includes("insufficient")) return "Wallet needs ETH for gas. Fund the wallet address.";
    if (code === "no_capability") return "Register capabilities with the broker: brokerAgent.registerKernelCapabilities()";
    if (code === "unsupported_intent") return "The kernel agent doesn't handle this intent type. Check supportedIntents list.";
    return undefined;
  }
}
