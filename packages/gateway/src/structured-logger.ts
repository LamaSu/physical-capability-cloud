/**
 * Structured logger stub — prevents build errors when telemetry routes are present.
 */

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogEntry {
  id: string;
  timestamp: string;
  level: string;
  message: string;
  source: string;
  [key: string]: unknown;
}

export class StructuredLogger {
  private entries: LogEntry[] = [];

  log(level: string, message: string, extra: Partial<Omit<LogEntry, "id" | "timestamp" | "message" | "level">> = {}) {
    this.entries.push({
      id: `log_${Date.now().toString(36)}`,
      timestamp: new Date().toISOString(),
      level,
      message,
      source: "gateway",
      ...extra,
    });
  }

  info(message: string, extra?: Partial<LogEntry>) { this.log("info", message, { source: "gateway", ...extra }); }
  warn(message: string, extra?: Partial<LogEntry>) { this.log("warn", message, { source: "gateway", ...extra }); }
  error(message: string, extra?: Partial<LogEntry>) { this.log("error", message, { source: "gateway", ...extra }); }

  getRecent(limit = 100): LogEntry[] { return this.getEntries(limit); }
  getSources(): string[] { return [...new Set(this.entries.map(e => e.source))]; }
  query(opts: { level?: string; source?: string; since?: string; limit?: number } = {}): LogEntry[] {
    let filtered = [...this.entries];
    if (opts.level) filtered = filtered.filter(e => e.level === opts.level);
    if (opts.source) filtered = filtered.filter(e => e.source === opts.source);
    if (opts.since) filtered = filtered.filter(e => e.timestamp >= opts.since);
    return filtered.slice(-(opts.limit ?? 100));
  }
  getEntries(limit = 100): LogEntry[] {
    return this.entries.slice(-limit);
  }

  clear(): void { this.entries = []; }
}

export const logger = new StructuredLogger();
