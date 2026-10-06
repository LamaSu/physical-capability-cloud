/**
 * The structured log behind GET /api/telemetry/logs and its stream: a sink under the closed
 * observability schema (N107b round 4, F; observability/closed-schema.ts). Its own chokepoint closes
 * what it stores, whatever a producer passes:
 *   - an entry's own fields are the logger's: an id and a time it makes, a level from its vocabulary
 *     (else keyed), the message declared (lit) or keyed, the source declared or keyed ("gateway"
 *     when there is none);
 *   - every other field is closed (closeValue): a declared field keeps its key, anything else
 *     leaves keyed, key and value, at any depth;
 *   - an entry is stored frozen, at every depth (#538 round 3): every read returns the same
 *     immutable record, so no reader can change what a later reader gets.
 */
import { closedText, closeValue, frozen, keyedHash, type Declared } from "./observability/closed-schema.js";

export type LogLevel = "info" | "warn" | "error" | "debug";

const LEVELS: ReadonlySet<string> = new Set<LogLevel>(["info", "warn", "error", "debug"]);

export interface LogEntry {
  id: string;
  timestamp: string;
  level: string;
  message: string;
  source: string;
  [key: string]: unknown;
}

/**
 * Whether a stored field matches a filter value given as itself (#538 round 3, astra source pack):
 * the field holds the value (a declared readable value) or its keyed hash, under its own key or,
 * when its producer did not declare it, under the keyed key. A query compares the stored form,
 * as the audit query does.
 */
function matches(entry: LogEntry, key: string, given: string): boolean {
  const hashed = keyedHash(given);
  return [entry[key], entry[keyedHash(key)]].some((stored) => stored === given || stored === hashed);
}

export class StructuredLogger {
  private entries: LogEntry[] = [];

  log(level: LogLevel, message: Declared, fields: Record<string, unknown> = {}): void {
    const given: Record<string, unknown> = typeof fields === "object" && fields !== null ? fields : { fields };
    let source: unknown;
    let closed: Record<string, unknown> = {};
    try {
      const { source: givenSource, ...rest } = given;
      source = givenSource;
      closed = (closeValue(rest, 1) as Record<string, unknown> | undefined) ?? {};
    } catch {
      closed = {};
    }
    this.entries.push(frozen({
      ...closed,
      id: `log_${Date.now().toString(36)}`,
      timestamp: new Date().toISOString(),
      level: typeof level === "string" && LEVELS.has(level) ? level : keyedHash(level),
      message: closedText(message),
      source: source === undefined ? "gateway" : closedText(source),
    }));
  }

  info(message: Declared, fields?: Record<string, unknown>) { this.log("info", message, fields); }
  warn(message: Declared, fields?: Record<string, unknown>) { this.log("warn", message, fields); }
  error(message: Declared, fields?: Record<string, unknown>) { this.log("error", message, fields); }

  getRecent(limit = 100): LogEntry[] { return this.getEntries(limit); }
  getSources(): string[] { return [...new Set(this.entries.map(e => e.source))]; }
  query(opts: {
    level?: string;
    source?: string;
    since?: string;
    limit?: number;
    jobId?: string;
    kernelId?: string;
    search?: string;
    after?: string;
    before?: string;
  } = {}): LogEntry[] {
    let filtered = [...this.entries];
    if (opts.level) filtered = filtered.filter(e => matches(e, "level", opts.level!));
    if (opts.source) filtered = filtered.filter(e => matches(e, "source", opts.source!));
    if (opts.since != null) filtered = filtered.filter(e => e.timestamp >= opts.since!);
    if (opts.after != null) filtered = filtered.filter(e => e.timestamp > opts.after!);
    if (opts.before != null) filtered = filtered.filter(e => e.timestamp < opts.before!);
    if (opts.jobId) filtered = filtered.filter(e => matches(e, "jobId", opts.jobId!));
    if (opts.kernelId) filtered = filtered.filter(e => matches(e, "kernelId", opts.kernelId!));
    if (opts.search) {
      // A declared message is searched as text; a message no producer declared is stored keyed,
      // so it matches a search for its exact text.
      const s = opts.search.toLowerCase();
      const hashed = keyedHash(opts.search);
      filtered = filtered.filter(e => e.message.toLowerCase().includes(s) || e.message === hashed);
    }
    return filtered.slice(-(opts.limit ?? 100));
  }
  getEntries(limit = 100): LogEntry[] {
    return this.entries.slice(-limit);
  }

  clear(): void { this.entries = []; }
}

export const logger = new StructuredLogger();
