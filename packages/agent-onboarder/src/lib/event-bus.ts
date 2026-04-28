// Global in-memory event bus — every integration tool emits here so the UI
// can render real logs/telemetry, not just one-line "called X" badges.
//
// Ported verbatim from `LamaSu/navi` packages/backend/src/lib/event-bus.ts as
// part of Wave 2.5 of the Navi v2 migration. Vendor-agnostic: when PCC's
// observability pipeline (OTel / Sentry) is wired in Wave 4, drop in a
// transport here without changing tool callsites.

export interface AppEvent {
  t: number;
  kind: string;
  sponsor: string;
  text: string;
  session_id?: string;
  level?: "info" | "ok" | "warn" | "err";
  payload?: Record<string, unknown>;
  duration_ms?: number;
}

const log: AppEvent[] = [];
const MAX = 500;

export function emit(e: Omit<AppEvent, "t">): AppEvent {
  const ev = { ...e, t: Date.now() };
  log.push(ev);
  if (log.length > MAX) log.shift();
  return ev;
}

export function tail(since = 0): AppEvent[] {
  return log.filter((e) => e.t > since);
}

export function snapshot(): AppEvent[] {
  return [...log];
}

// Convenience helpers for tool wrappers — emit a BEGIN, run the work, emit END
export async function tracked<T>(
  meta: { kind: string; sponsor: string; text: string; session_id?: string; payload?: Record<string, unknown> },
  fn: () => Promise<T>
): Promise<T> {
  const t0 = Date.now();
  emit({ ...meta, level: "info" });
  try {
    const result = await fn();
    emit({
      kind: meta.kind + ".done",
      sponsor: meta.sponsor,
      text: `${meta.text} done`,
      session_id: meta.session_id,
      level: "ok",
      payload: result && typeof result === "object" ? (result as Record<string, unknown>) : undefined,
      duration_ms: Date.now() - t0,
    });
    return result;
  } catch (e) {
    emit({
      kind: meta.kind + ".err",
      sponsor: meta.sponsor,
      text: `${meta.text} fail: ${e instanceof Error ? e.message : String(e)}`,
      session_id: meta.session_id,
      level: "err",
      duration_ms: Date.now() - t0,
    });
    throw e;
  }
}
