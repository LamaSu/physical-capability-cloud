import { describe, it, expect } from "vitest";
import { buildReportHint, decorateWithReportHint } from "../report-hint.js";

/**
 * report_hint builder (agent auto-feedback, Phase 1). The block PCC attaches to 5xx
 * responses so a cold agent is told, at the failure site, how to report + its trace.
 */
describe("buildReportHint", () => {
  it("returns a hint for a 500 with the failure pre-filled + the traceId", () => {
    const h = buildReportHint({
      url: "/api/build/contract",
      method: "POST",
      statusCode: 500,
      errorCode: "TIER_MISMATCH",
      traceId: "tr_abcd1234",
    });
    expect(h).not.toBeNull();
    expect(h!.tool).toBe("pcc_report");
    expect(h!.how).toBe("POST /api/feedback");
    expect(h!.auth).toMatch(/public/i);
    expect(h!.traceId).toBe("tr_abcd1234");
    expect(h!.send).toEqual({
      type: "bug",
      endpoint: "/api/build/contract",
      method: "POST",
      status: 500,
      errorCode: "TIER_MISMATCH",
    });
    // the note must warn against leaking secrets.
    expect(h!.note).toMatch(/never include api keys|secret/i);
  });

  it("strips the query string from the endpoint", () => {
    const h = buildReportHint({ url: "/api/jobs?limit=10&offset=0", method: "GET", statusCode: 502 });
    expect(h!.send.endpoint).toBe("/api/jobs");
  });

  it("tolerates a missing errorCode + traceId (nulls, not undefined)", () => {
    const h = buildReportHint({ url: "/api/x", method: "DELETE", statusCode: 503 });
    expect(h!.traceId).toBeNull();
    expect(h!.send.errorCode).toBeNull();
  });

  it("returns null for every 4xx — client-fixable errors are not decorated", () => {
    for (const status of [400, 401, 403, 404, 415, 429, 499]) {
      expect(buildReportHint({ url: "/api/x", method: "POST", statusCode: status }), `status ${status}`).toBeNull();
    }
  });

  it("returns a hint across the 5xx range", () => {
    for (const status of [500, 501, 502, 503, 504]) {
      expect(buildReportHint({ url: "/api/x", method: "GET", statusCode: status })!.send.status).toBe(status);
    }
  });

  it("returns null on a non-finite status (defensive)", () => {
    expect(buildReportHint({ url: "/api/x", method: "GET", statusCode: NaN })).toBeNull();
  });

  it("returns null for 600+ — not a valid HTTP status (review #4)", () => {
    for (const status of [600, 700, 999]) {
      expect(buildReportHint({ url: "/api/x", method: "GET", statusCode: status }), `status ${status}`).toBeNull();
    }
  });

  it("never decorates a failure ON the feedback sink — no report-loop (review #3)", () => {
    expect(buildReportHint({ url: "/api/feedback", method: "POST", statusCode: 500 })).toBeNull();
    expect(buildReportHint({ url: "/api/feedback/agent-report", method: "POST", statusCode: 503 })).toBeNull();
    // a route that merely starts with the word is NOT the feedback sink.
    expect(buildReportHint({ url: "/api/feedbackx", method: "GET", statusCode: 500 })).not.toBeNull();
  });
});

describe("decorateWithReportHint (onSend — covers explicitly-sent 5xx, review #2)", () => {
  const json = "application/json; charset=utf-8";

  it("adds report_hint to a JSON 5xx that lacks one, using the body's error as errorCode", () => {
    const out = decorateWithReportHint(JSON.stringify({ error: "TIER_MISMATCH", message: "nope" }), {
      statusCode: 500, contentType: json, url: "/api/build/contract?x=1", method: "POST", traceId: "tr_1",
    });
    const obj = JSON.parse(out);
    expect(obj.error).toBe("TIER_MISMATCH"); // original body preserved
    expect(obj.report_hint.tool).toBe("pcc_report");
    expect(obj.report_hint.traceId).toBe("tr_1");
    expect(obj.report_hint.send).toMatchObject({ endpoint: "/api/build/contract", method: "POST", status: 500, errorCode: "TIER_MISMATCH" });
  });

  it("leaves an already-decorated response untouched (no double-add from setErrorHandler)", () => {
    const already = JSON.stringify({ error: "internal_error", report_hint: { tool: "pcc_report" } });
    expect(decorateWithReportHint(already, { statusCode: 500, contentType: json, url: "/api/x", method: "GET" })).toBe(already);
  });

  it("passes through non-5xx, non-JSON, non-object, and unparseable payloads unchanged", () => {
    const p = JSON.stringify({ error: "bad" });
    expect(decorateWithReportHint(p, { statusCode: 404, contentType: json, url: "/api/x", method: "GET" })).toBe(p);
    expect(decorateWithReportHint(p, { statusCode: 500, contentType: "text/html", url: "/api/x", method: "GET" })).toBe(p);
    expect(decorateWithReportHint("<html>boom</html>", { statusCode: 500, contentType: "text/html", url: "/api/x", method: "GET" })).toBe("<html>boom</html>");
    expect(decorateWithReportHint("[1,2,3]", { statusCode: 500, contentType: json, url: "/api/x", method: "GET" })).toBe("[1,2,3]");
    expect(decorateWithReportHint("not json", { statusCode: 500, contentType: json, url: "/api/x", method: "GET" })).toBe("not json");
  });

  it("does not decorate a 5xx from the feedback sink itself (no loop)", () => {
    const p = JSON.stringify({ error: "internal_error" });
    expect(decorateWithReportHint(p, { statusCode: 500, contentType: json, url: "/api/feedback", method: "POST" })).toBe(p);
  });
});
