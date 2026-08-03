/**
 * ui-artifact hardening — sol security-pass regression suite (findings #5/#7/#10).
 *
 * The pre-existing ui-artifact.test.ts pins the pcc_live_/pcc_test_ prefix +
 * percent-encoding + nested-location coverage. THIS suite pins the additional
 * hardening the sol pass landed on the on-ramp artifact:
 *   - expanded credential detection: vendor-agnostic Bearer tokens + JWTs +
 *     base64-wrapped PCC keys, and the FAIL-CLOSED node-walk budget (#5/#10);
 *   - manifest resource caps (sections / windows / actions / list limit / list
 *     meta / pollMs floor) and the BYTE-measured (not code-unit) size guard (#7).
 * Kept as a separate file so this test commit is on-ramp-hardening-only.
 */

import { describe, expect, it } from "vitest";
import {
  containsApiKey,
  DashboardManifestSchema,
  DASHBOARD_CSD_URL,
  MIN_POLL_MS,
  MAX_SECTIONS,
  MAX_WINDOWS_PER_SECTION,
  MAX_ACTIONS_PER_WINDOW,
  MAX_LIST_LIMIT,
  MAX_MANIFEST_BYTES,
} from "./ui-artifact.js";

/** A minimal VALID manifest; callers override one field to exercise a single cap. */
function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    csd: DASHBOARD_CSD_URL,
    title: "T",
    sections: [{ windows: [{ kind: "note", text: "hi" }] }],
    ...overrides,
  };
}

const okParse = (m: unknown) => DashboardManifestSchema.safeParse(m).success;

describe("containsApiKey — expanded credential detection (sol pass #10)", () => {
  it("flags a real Bearer token (credential-shaped: >=20 chars incl a digit/dot)", () => {
    expect(containsApiKey({ note: "Authorization: Bearer sk-9f8a7b6c5d4e3f2a1b0c9d8e" })).toBe(true);
    expect(containsApiKey("bearer aaaaaaaaaaaaaaaaaaa1")).toBe(true);
  });

  it("does NOT flag benign 'Bearer' prose (no credential shape) — no false positive", () => {
    expect(containsApiKey({ text: "Bearer authentication is required." })).toBe(false);
    expect(containsApiKey("the bearer of good news")).toBe(false);
  });

  it("flags a JWT (eyJ…​.eyJ…​.sig)", () => {
    expect(containsApiKey({ x: "eyJhbGciOi.eyJzdWIiOi.SflKxwRJSMeKKF2QT4" })).toBe(true);
  });

  it("flags a PCC key hidden inside a base64 blob", () => {
    const b64 = Buffer.from("prefix pcc_live_deadbeefdeadbeef tail").toString("base64");
    expect(containsApiKey({ blob: b64 })).toBe(true);
  });

  it("does NOT flag a benign base64 blob", () => {
    const b64 = Buffer.from("just some ordinary content, nothing secret here").toString("base64");
    expect(containsApiKey({ blob: b64 })).toBe(false);
  });

  it("FAILS CLOSED when the node-walk budget is exhausted (returns true = reject)", () => {
    // > 20000 nodes, NO key present — exhaustion must be treated as key-bearing
    // so a caller cannot pad an object to push a trailing key past the scan.
    const huge = Array.from({ length: 25000 }, (_, i) => "n" + i);
    expect(containsApiKey({ big: huge })).toBe(true);
  });
});

describe("DashboardManifestSchema — resource caps (sol pass #5/#7)", () => {
  it("accepts a minimal valid manifest", () => {
    expect(okParse(baseManifest())).toBe(true);
  });

  it("floors pollMs at MIN_POLL_MS (a shared dashboard can't fast-poll auth'd endpoints)", () => {
    const metric = (pollMs: number) =>
      baseManifest({ sections: [{ windows: [{ kind: "metric", label: "x", binding: { path: "/api/x", pollMs } }] }] });
    expect(okParse(metric(MIN_POLL_MS))).toBe(true);
    expect(okParse(metric(MIN_POLL_MS - 1))).toBe(false);
  });

  it("caps list limit at MAX_LIST_LIMIT", () => {
    const list = (limit: number) =>
      baseManifest({ sections: [{ windows: [{ kind: "list", binding: { path: "/api/x" }, item: { title: "t" }, limit }] }] });
    expect(okParse(list(MAX_LIST_LIMIT))).toBe(true);
    expect(okParse(list(MAX_LIST_LIMIT + 1))).toBe(false);
  });

  it("caps list meta selectors at 12 (looped per rendered row)", () => {
    const meta = (n: number) =>
      baseManifest({ sections: [{ windows: [{ kind: "list", binding: { path: "/api/x" }, item: { title: "t", meta: Array(n).fill("f") } }] }] });
    expect(okParse(meta(12))).toBe(true);
    expect(okParse(meta(13))).toBe(false);
  });

  it("caps sections at MAX_SECTIONS", () => {
    const sections = (n: number) =>
      baseManifest({ sections: Array(n).fill({ windows: [{ kind: "note", text: "x" }] }) });
    expect(okParse(sections(MAX_SECTIONS))).toBe(true);
    expect(okParse(sections(MAX_SECTIONS + 1))).toBe(false);
  });

  it("caps windows-per-section at MAX_WINDOWS_PER_SECTION", () => {
    const windows = (n: number) =>
      baseManifest({ sections: [{ windows: Array(n).fill({ kind: "note", text: "x" }) }] });
    expect(okParse(windows(MAX_WINDOWS_PER_SECTION))).toBe(true);
    expect(okParse(windows(MAX_WINDOWS_PER_SECTION + 1))).toBe(false);
  });

  it("caps actions-per-window at MAX_ACTIONS_PER_WINDOW", () => {
    const action = { id: "a", label: "L", kind: "post", path: "/api/x", confirm: "inline", intentText: "pcc: x" };
    const bar = (n: number) =>
      baseManifest({ sections: [{ windows: [{ kind: "actions", actions: Array(n).fill(action) }] }] });
    expect(okParse(bar(MAX_ACTIONS_PER_WINDOW))).toBe(true);
    expect(okParse(bar(MAX_ACTIONS_PER_WINDOW + 1))).toBe(false);
  });
});

describe("DashboardManifestSchema — byte-measured size guard (sol re-review #7)", () => {
  it("rejects a manifest over MAX_MANIFEST_BYTES", () => {
    const big = baseManifest({ sections: [{ windows: [{ kind: "note", text: "a".repeat(MAX_MANIFEST_BYTES + 100) }] }] });
    expect(okParse(big)).toBe(false);
  });

  it("measures UTF-8 BYTES, not UTF-16 code units — multibyte can't slip past", () => {
    // 90k '€' = 90k UTF-16 code units (< MAX) but 270k UTF-8 bytes (> MAX).
    // A code-unit check would PASS this; the byte check must REJECT it.
    const text = "€".repeat(90000);
    expect(text.length).toBeLessThan(MAX_MANIFEST_BYTES); // code-unit measure would pass
    const m = baseManifest({ sections: [{ windows: [{ kind: "note", text }] }] });
    expect(okParse(m)).toBe(false); // byte measure rejects
  });
});

describe("DashboardManifestSchema — credential refine on the share boundary", () => {
  it("rejects a manifest carrying a raw pcc_live_ key", () => {
    expect(okParse(baseManifest({ sections: [{ windows: [{ kind: "note", text: "key pcc_live_deadbeef" }] }] }))).toBe(false);
  });

  it("rejects a manifest carrying a Bearer token (expanded refine, sol #10)", () => {
    expect(okParse(baseManifest({ sections: [{ windows: [{ kind: "note", text: "Authorization: Bearer sk-9f8a7b6c5d4e3f2a1b0c" }] }] }))).toBe(false);
  });
});
