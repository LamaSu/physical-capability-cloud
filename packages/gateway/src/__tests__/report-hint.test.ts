import { describe, it, expect } from "vitest";
import { buildReportHint } from "../report-hint.js";

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
});
