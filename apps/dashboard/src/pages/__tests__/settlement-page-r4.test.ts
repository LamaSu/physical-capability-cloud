/**
 * Cross-family review r3 of #425 (rm-px3-425-r3-5716e01f, SHIP-WITH-FIXES), M1: the selected
 * epoch's detail headings labeled byAgent/byOperation — which count intents, not the operations
 * a batch actually carries — as "By Agent"/"By Operation" with no indication they are an intent
 * count. Source check only, like settlement-page-truth.test.ts: the headings are static strings,
 * not built from gateway data, so page text is enough to pin them. The banner's own wording is
 * pinned at the unit level (settlement-r4.test.ts), and its page-level wiring is already pinned
 * by settlement-page-flush.test.tsx's "sends exactly one POST" test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(resolve(here, "..", "SettlementPage.tsx"), "utf-8");

describe("SettlementPage epoch-detail headings say what byAgent/byOperation count (review r3 of #425, M1)", () => {
  it("the byAgent section is headed 'Intents by Agent', not a bare 'By Agent'", () => {
    expect(page).toContain("Intents by Agent");
    expect(page).not.toMatch(/>\s*By Agent\s*</);
  });

  it("the byOperation section is headed 'Intents by Operation', not a bare 'By Operation'", () => {
    expect(page).toContain("Intents by Operation");
    expect(page).not.toMatch(/>\s*By Operation\s*</);
  });
});
