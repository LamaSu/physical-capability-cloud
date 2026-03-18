/**
 * EscalationManager — Tracks issues that need operator attention.
 *
 * Categorizes issues by severity, deduplicates, and formats
 * escalation reports for the operator (you).
 */

export type EscalationSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface Escalation {
  id: string;
  timestamp: string;
  severity: EscalationSeverity;
  kernelId: string;
  agentId: string;
  category: "adapter_failure" | "evidence_issue" | "settlement_failure" | "network_issue" |
            "capability_error" | "security_alert" | "onboarding_help" | "general";
  title: string;
  details: string;
  suggestedFix?: string;
  acknowledged: boolean;
  resolvedAt?: string;
}

export interface EscalationReport {
  timestamp: string;
  totalOpen: number;
  bySeverity: Record<EscalationSeverity, number>;
  byCategory: Record<string, number>;
  critical: Escalation[];
  high: Escalation[];
  recent: Escalation[];
}

export class EscalationManager {
  private escalations: Map<string, Escalation> = new Map();
  private idCounter = 0;

  /** Create a new escalation */
  escalate(params: Omit<Escalation, "id" | "timestamp" | "acknowledged">): Escalation {
    const id = `esc_${++this.idCounter}_${Date.now()}`;
    const escalation: Escalation = {
      ...params,
      id,
      timestamp: new Date().toISOString(),
      acknowledged: false,
    };

    // Deduplicate: if a similar escalation exists for the same kernel and category, update it
    const existing = [...this.escalations.values()].find(
      e => e.kernelId === params.kernelId
        && e.category === params.category
        && !e.resolvedAt
        && e.title === params.title
    );

    if (existing) {
      existing.details = params.details;
      existing.timestamp = new Date().toISOString();
      existing.severity = this.maxSeverity(existing.severity, params.severity);
      return existing;
    }

    this.escalations.set(id, escalation);
    return escalation;
  }

  /** Acknowledge an escalation */
  acknowledge(id: string): void {
    const esc = this.escalations.get(id);
    if (esc) esc.acknowledged = true;
  }

  /** Resolve an escalation */
  resolve(id: string): void {
    const esc = this.escalations.get(id);
    if (esc) esc.resolvedAt = new Date().toISOString();
  }

  /** Get all open (unresolved) escalations */
  getOpen(): Escalation[] {
    return [...this.escalations.values()]
      .filter(e => !e.resolvedAt)
      .sort((a, b) => {
        const sevOrder: Record<EscalationSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
        return sevOrder[a.severity] - sevOrder[b.severity];
      });
  }

  /** Get escalations for a specific kernel */
  getForKernel(kernelId: string): Escalation[] {
    return [...this.escalations.values()]
      .filter(e => e.kernelId === kernelId && !e.resolvedAt);
  }

  /** Generate a summary report for the operator */
  generateReport(): EscalationReport {
    const open = this.getOpen();
    const bySeverity: Record<EscalationSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    const byCategory: Record<string, number> = {};

    for (const esc of open) {
      bySeverity[esc.severity]++;
      byCategory[esc.category] = (byCategory[esc.category] ?? 0) + 1;
    }

    return {
      timestamp: new Date().toISOString(),
      totalOpen: open.length,
      bySeverity,
      byCategory,
      critical: open.filter(e => e.severity === "critical"),
      high: open.filter(e => e.severity === "high"),
      recent: open.slice(0, 10),
    };
  }

  /** Format a single escalation for display */
  formatForOperator(esc: Escalation): string {
    const severity = esc.severity.toUpperCase();
    const lines = [
      `[${severity}] ${esc.title}`,
      `  Kernel: ${esc.kernelId} | Agent: ${esc.agentId}`,
      `  Category: ${esc.category}`,
      `  Time: ${esc.timestamp}`,
      `  Details: ${esc.details}`,
    ];
    if (esc.suggestedFix) {
      lines.push(`  Fix: ${esc.suggestedFix}`);
    }
    return lines.join("\n");
  }

  /** Format the full report for the operator */
  formatReport(): string {
    const report = this.generateReport();
    if (report.totalOpen === 0) {
      return "No open escalations. All systems nominal.";
    }

    const lines = [
      `=== PCC Support Escalation Report ===`,
      `Time: ${report.timestamp}`,
      `Open: ${report.totalOpen} (${report.bySeverity.critical} critical, ${report.bySeverity.high} high, ${report.bySeverity.medium} medium, ${report.bySeverity.low} low)`,
      "",
    ];

    if (report.critical.length > 0) {
      lines.push("--- CRITICAL ---");
      for (const esc of report.critical) {
        lines.push(this.formatForOperator(esc));
        lines.push("");
      }
    }

    if (report.high.length > 0) {
      lines.push("--- HIGH ---");
      for (const esc of report.high) {
        lines.push(this.formatForOperator(esc));
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  private maxSeverity(a: EscalationSeverity, b: EscalationSeverity): EscalationSeverity {
    const order: EscalationSeverity[] = ["critical", "high", "medium", "low", "info"];
    return order[Math.min(order.indexOf(a), order.indexOf(b))];
  }
}
