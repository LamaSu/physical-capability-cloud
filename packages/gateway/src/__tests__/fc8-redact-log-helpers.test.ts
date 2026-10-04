/**
 * FC-8 round 2 (astra pack 61b, CRITICAL): behavioral tests for the three
 * helpers added to close the e2e scripts' remaining raw-print sites (see
 * fc8-e2e-script-redaction.test.ts for the source-text guards that pin each
 * script's call site to these helpers). Companion to redact-log.test.ts,
 * which covers safeLogJson/redactLogValue/isSensitiveLogKey directly.
 *
 * At 85c9d5bf these three exports do not exist yet — this file fails to
 * resolve its import, which is this test's RED state (see
 * returns/pcc-gateway-work/61c-fc8-repro-85c9d5bf.log for the captured run).
 */
import { describe, it, expect } from "vitest";
import { safeLogResponseText, safeLogErrorName, safeLogId } from "../util/redact-log.js";

const SENTINEL = "SENTINEL-ORACLE-KEY-5f1e";

describe("FC-8 round 2 (astra pack 61b) — safeLogResponseText", () => {
  it("[neg] withholds a sentinel reflected in a JSON header field (astra pack 61b's own repro shape)", () => {
    const out = safeLogResponseText(JSON.stringify({ headers: { "x-oracle-key": SENTINEL } }), 600);
    expect(out).not.toContain(SENTINEL);
  });

  it("[neg] withholds a sentinel in a non-JSON (plain text / error page) response entirely", () => {
    const out = safeLogResponseText(`upstream error: x-oracle-key: ${SENTINEL}`, 500);
    expect(out).not.toContain(SENTINEL);
    expect(out).toBe("[non-JSON response withheld]");
  });

  it("[neg] withholds a Bearer-shaped secret under an innocuous key (shape layer, second line of defense)", () => {
    const out = safeLogResponseText(JSON.stringify({ note: `Bearer ${SENTINEL}` }), 600);
    expect(out).not.toContain(SENTINEL);
  });

  it("keeps an ordinary JSON status/id field readable", () => {
    const out = safeLogResponseText(JSON.stringify({ valid: true, jobId: "job-abc-1" }), 600);
    expect(out).toContain("job-abc-1");
    expect(out).toContain("true");
  });

  it("never throws on malformed or empty input", () => {
    expect(() => safeLogResponseText("{not json", 500)).not.toThrow();
    expect(() => safeLogResponseText("", 500)).not.toThrow();
  });
});

describe("FC-8 round 2 (astra pack 61b) — safeLogErrorName", () => {
  it("[neg] drops an Error's message even when the message carries the sentinel", () => {
    const out = safeLogErrorName(new Error(`x-oracle-key: ${SENTINEL}`));
    expect(out).not.toContain(SENTINEL);
    expect(out).toBe("Error");
  });

  it("[neg] drops a caught non-Error value (string/plain object) wholesale", () => {
    expect(safeLogErrorName(`leaked ${SENTINEL}`)).not.toContain(SENTINEL);
    expect(safeLogErrorName({ message: SENTINEL })).not.toContain(SENTINEL);
    expect(safeLogErrorName(null)).toBe("Error");
    expect(safeLogErrorName(undefined)).toBe("Error");
  });

  it("[neg] rejects a hostile .name that is itself secret-shaped free text", () => {
    const out = safeLogErrorName({ name: `x-oracle-key: ${SENTINEL}` });
    expect(out).not.toContain(SENTINEL);
    expect(out).toBe("Error");
  });

  it("[neg] rejects a hostile .name that smuggles a secret using only id-safe characters", () => {
    const out = safeLogErrorName({ name: `secret-${SENTINEL}` });
    expect(out).not.toContain(SENTINEL);
    expect(out).toBe("Error");
  });

  it("keeps a normal, identifier-shaped custom error name (useful for debugging)", () => {
    class HttpRequestError extends Error {
      constructor(m: string) {
        super(m);
        this.name = "HttpRequestError";
      }
    }
    expect(safeLogErrorName(new HttpRequestError("connection refused"))).toBe("HttpRequestError");
    expect(safeLogErrorName(new TypeError("x"))).toBe("TypeError");
  });
});

describe("FC-8 round 2 (astra pack 61b) — safeLogId", () => {
  it("[neg] falls back instead of printing a free-text / credential-shaped value", () => {
    expect(safeLogId(`Bearer ${SENTINEL}`)).not.toContain(SENTINEL);
    expect(safeLogId(`token=${SENTINEL}`)).not.toContain(SENTINEL);
    expect(safeLogId(`error: ${SENTINEL}`)).not.toContain(SENTINEL);
  });

  it("FC-8 round 4: no longer 'keeps' an id — returns a fixed-length SHA-256 fingerprint instead, deterministic but never the value", () => {
    // Round 2/3's "ID-shaped values pass through unchanged" was the exact
    // defect astra's round-4 review (finding 3) rejected: a credential
    // satisfies an id-shape check just as well as a real id does. The
    // fingerprint reveals nothing about the input, regardless of shape.
    const out = safeLogId("job_hp-printer-fullchain.1");
    expect(out).not.toContain("job_hp-printer-fullchain.1");
    expect(out).toMatch(/^id:[0-9a-f]{12}$/);
    // Deterministic: the same id fingerprints the same way every time, so
    // a reader can still see "this is the same id as three lines up".
    expect(safeLogId("job_hp-printer-fullchain.1")).toBe(out);
    // Different input, different fingerprint.
    expect(safeLogId("job-real-e2e")).not.toBe(out);
    // An id-shaped SECRET fingerprints the same way as any other string —
    // it is never distinguishable from, or reducible to, a real id.
    expect(safeLogId(SENTINEL.replace(/ /g, "-"))).toMatch(/^id:[0-9a-f]{12}$/);
  });

  it("falls back on a non-string or missing value", () => {
    expect(safeLogId(undefined)).toBe("(none)");
    expect(safeLogId(null)).toBe("(none)");
    expect(safeLogId(42)).toBe("(none)");
  });
});

describe("FC-8 round 2 (astra pack 61b) — the report sink (real-e2e-verbose.ts:596-610)", () => {
  it("[neg] a report built the way the script builds it never carries a sentinel that reached a fixed call site", () => {
    // Mirrors real-e2e-verbose.ts's L()/log accumulation: every line a fixed
    // call site would have printed goes into the same array that is later
    // join("\n")-ed into the report file AND sent as printer-job content
    // (:596-610). If the upstream call sites withhold the sentinel, the
    // persisted/transmitted report inherits that for free — this test proves
    // it, rather than just asserting it by construction.
    const log: string[] = [];
    const L = (s: string) => log.push(s);

    // [7b] oracle verification line (was :383)
    const oracleText = JSON.stringify({ headers: { "x-oracle-key": SENTINEL } });
    L(`     Oracle HTTP 200: ${safeLogResponseText(oracleText, 500)}`);

    // [7b-3] Lit provisioning failure line (was :472)
    const litProvision: { usageKey?: string; error?: string } = { error: `lit denied: ${SENTINEL}` };
    L(`     Provisioned: ${litProvision.usageKey ? "yes" : "no"}`);

    // top-level catch (was :619)
    L(`FATAL: ${safeLogErrorName(new Error(`x-oracle-key: ${SENTINEL}`))}`);

    const report = log.join("\n");
    expect(report).not.toContain(SENTINEL);
  });
});
