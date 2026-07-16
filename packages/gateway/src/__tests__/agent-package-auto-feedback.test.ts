import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The served agent-package.json must advertise the auto-feedback contract so any
 * LLM harness — whether or not it parses the 22k-char system_prompt — drives its
 * agent to report failures to the durable, admin-readable /api/feedback sink.
 * Wired by scripts/update-agent-package-auto-feedback.mjs; this is its acceptance.
 */
const PKG = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..",
  "apps", "dashboard", "public", "agent-package.json",
);
const pkg = JSON.parse(readFileSync(PKG, "utf8"));

describe("agent-package.json — auto-feedback wiring", () => {
  it("pcc_report points at the durable POST /api/feedback (not the old agent-report)", () => {
    const tool = pkg.tools.find((t: { name: string }) => t.name === "pcc_report");
    expect(tool, "pcc_report tool missing").toBeTruthy();
    expect(tool.endpoint).toEqual({ method: "POST", path: "/api/feedback" });
  });

  it("pcc_report accepts the report_hint send{} fields (method, status, errorCode)", () => {
    const props = pkg.tools.find((t: { name: string }) => t.name === "pcc_report").input_schema.properties;
    for (const f of ["type", "summary", "endpoint", "method", "status", "errorCode", "traceId"]) {
      expect(props[f], `pcc_report missing input field ${f}`).toBeTruthy();
    }
    expect(props.status.type).toBe("integer");
  });

  it("pcc_report advertises the bounded logs array (Phase 2)", () => {
    const logs = pkg.tools.find((t: { name: string }) => t.name === "pcc_report").input_schema.properties.logs;
    expect(logs, "pcc_report.logs missing").toBeTruthy();
    expect(logs.type).toBe("array");
    expect(logs.maxItems).toBe(20);
    for (const f of ["step", "method", "path", "status", "note"]) {
      expect(logs.items.properties[f], `logs item missing ${f}`).toBeTruthy();
    }
  });

  it("has a top-level machine-readable error_reporting contract", () => {
    const er = pkg.error_reporting;
    expect(er, "error_reporting field missing").toBeTruthy();
    expect(er.endpoint).toEqual({ method: "POST", path: "/api/feedback" });
    expect(er.auth).toMatch(/public/i);
    expect(Array.isArray(er.report_when) && er.report_when.length).toBeTruthy();
    expect(er.never_send.join(" ")).toMatch(/key|secret/i); // must warn against leaking secrets
    expect(er.on_error_response).toMatch(/report_hint/);
  });

  it("system_prompt carries the STRICT trigger, not the old soft nudge", () => {
    const sp: string = pkg.system_prompt;
    expect(sp.includes("Report failures automatically")).toBe(true);
    expect(sp.includes("report_hint")).toBe(true);
    // the two old soft mentions must be gone.
    expect(sp.includes("When you get stuck, `pcc_report { trace_id, summary }`")).toBe(false);
    expect(sp.includes("optionally call `pcc_report` with the trace_id")).toBe(false);
  });
});
