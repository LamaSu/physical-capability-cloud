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

/**
 * Build the report_hint for a failing request, or `null` when the status is not
 * report-worthy. Only 5xx are decorated: 4xx are client-fixable (bad request, wrong
 * media type, not-found) and nudging an agent to report its own mistake is noise.
 */
export function buildReportHint(args: BuildReportHintArgs): ReportHint | null {
  if (!Number.isFinite(args.statusCode) || args.statusCode < 500) return null;
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
      endpoint: args.url.split("?")[0],
      method: args.method,
      status: args.statusCode,
      errorCode: args.errorCode ?? null,
    },
  };
}
