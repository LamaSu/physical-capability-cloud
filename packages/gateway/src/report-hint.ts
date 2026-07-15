/**
 * report_hint — the "report this failure" block PCC attaches to 5xx responses so a
 * cold agent is told, AT the failure site, exactly how to report + its journey trace.
 *
 * Kept as a tiny leaf module (no heavy imports) so it is unit-testable without
 * booting the gateway. Used by server.ts's setErrorHandler; a Phase-2 onSend
 * decorator (covering explicitly-sent 5xx) can reuse it unchanged.
 *
 * Design: ai/research/agent-feedback-auto-design.md
 */

export interface ReportHintSend {
  type: "bug";
  endpoint: string;
  method: string;
  status: number;
  errorCode: string | null;
}

export interface ReportHint {
  tool: "pcc_report";
  how: string;
  auth: string;
  traceId: string | null;
  note: string;
  send: ReportHintSend;
}

export interface BuildReportHintArgs {
  url: string;
  method: string;
  statusCode: number;
  errorCode?: string | null;
  traceId?: string | null;
}

/** The feedback sink itself — never decorate ITS failures with "call it again". */
const FEEDBACK_PATH_RE = /^\/api\/feedback(\/|$)/;

/**
 * Build the report_hint for a failing request, or `null` when the status is not
 * report-worthy. Only real HTTP 5xx (500..599) are decorated: 4xx are client-fixable
 * (bad request, wrong media type, not-found) and nudging an agent to report its own
 * mistake is noise; 600+ is not a valid HTTP status. A failure ON the feedback sink
 * is never decorated — telling an agent to report a /api/feedback error by calling
 * /api/feedback would loop.
 */
export function buildReportHint(args: BuildReportHintArgs): ReportHint | null {
  if (!Number.isFinite(args.statusCode) || args.statusCode < 500 || args.statusCode >= 600) return null;
  const endpoint = args.url.split("?")[0];
  if (FEEDBACK_PATH_RE.test(endpoint)) return null;
  return {
    tool: "pcc_report",
    how: "POST /api/feedback",
    auth: "none — public, no API key required",
    traceId: args.traceId ?? null,
    note:
      "If this blocked you and you can't recover, report it so PCC can fix it. " +
      "Send the send{} block below plus a one-line summary of what you were doing. " +
      "Never include API keys, tokens, or wallet secrets.",
    send: {
      type: "bug",
      endpoint,
      method: args.method,
      status: args.statusCode,
      errorCode: args.errorCode ?? null,
    },
  };
}

export interface DecorateArgs {
  statusCode: number;
  contentType: string;
  url: string;
  method: string;
  traceId?: string | null;
}

/**
 * Decorate a serialized RESPONSE payload with report_hint when it is a JSON 5xx that
 * doesn't already carry one. This is how explicitly-returned 5xx (reply.status(500)
 * .send(...), which never reach setErrorHandler) get the same failure-site nudge —
 * so the package's "any 5xx carries report_hint" contract is actually true. The
 * error code, when present, is read from the body's own `error` field. Returns the
 * payload unchanged on any non-JSON / non-5xx / already-decorated / unparseable case.
 */
export function decorateWithReportHint(payload: string, ctx: DecorateArgs): string {
  if (ctx.statusCode < 500 || ctx.statusCode >= 600) return payload;
  if (!ctx.contentType.toLowerCase().includes("application/json")) return payload;
  let obj: unknown;
  try {
    obj = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return payload;
  const rec = obj as Record<string, unknown>;
  if (rec.report_hint) return payload; // already decorated (e.g. by setErrorHandler)
  const hint = buildReportHint({
    url: ctx.url,
    method: ctx.method,
    statusCode: ctx.statusCode,
    errorCode: typeof rec.error === "string" ? (rec.error as string) : null,
    traceId: ctx.traceId,
  });
  if (!hint) return payload;
  rec.report_hint = hint;
  return JSON.stringify(rec);
}
