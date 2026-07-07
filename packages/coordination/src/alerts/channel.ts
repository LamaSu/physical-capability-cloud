/**
 * Alert channel — ONE console/log stub (there is no `@pcc/alerts` package;
 * per the spec this is intentionally minimal, not a placeholder for
 * something bigger being built here). The Brain sends an alert for
 * high/critical-severity reactions in ADDITION to enqueuing a durable queue
 * item — the queue is for approval workflows (may sit unresolved for
 * hours), an alert is for "a human should notice this right now."
 *
 * `AlertChannel` is the seam: swap {@link ConsoleAlertChannel} for a real
 * Slack/PagerDuty/email channel later without touching brain/supervisor.ts.
 */

export type AlertSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface AlertPayload {
  severity: AlertSeverity;
  title: string;
  details?: string;
  /** ISO-8601. Defaults to "now" if omitted. */
  at?: string;
}

export interface AlertChannel {
  send(alert: AlertPayload): void | Promise<void>;
}

export interface ConsoleAlertChannelOptions {
  /** Prepended to every line, e.g. "brain" -> "[coordination:brain] ...". */
  prefix?: string;
  /** Injectable sink for tests. Defaults to `console.log`. */
  sink?: (line: string) => void;
}

export class ConsoleAlertChannel implements AlertChannel {
  private readonly prefix: string;
  private readonly sink: (line: string) => void;

  constructor(opts: ConsoleAlertChannelOptions = {}) {
    this.prefix = opts.prefix ? `:${opts.prefix}` : "";
    this.sink = opts.sink ?? ((line: string) => console.log(line));
  }

  send(alert: AlertPayload): void {
    const at = alert.at ?? new Date().toISOString();
    const details = alert.details ? ` — ${alert.details}` : "";
    this.sink(`[coordination${this.prefix}] ${at} ${alert.severity.toUpperCase()} ${alert.title}${details}`);
  }
}
