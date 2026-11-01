// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPLIT_PRESETS as BUILDER_PRESETS } from "../../pages/BuilderPage.js";
import { PRESETS as PANEL_PRESETS } from "../../components/builder/NegotiationPanel.js";
import { SPLIT_PRESETS as NEGOTIATION_PRESETS } from "../../pages/NegotiationPage.js";
import { PUBLISHER_ROLES } from "../../pages/RateSchedulePublishPage.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

const FEE_WORDING =
  /\bplatform (?:fees?|tax(?:es)?)\b|\bprotocol fees?\b|\bpcc(?:['\u2019]s)? (?:cut|fees?)\b|\bfee (?:rate|collection|recipient|flows?)\b|\b2\.35 ?%/i;
const TREASURY = /(protocol|network) treasury/i;

const PRESET_TABLES = {
  BuilderPage: BUILDER_PRESETS,
  NegotiationPanel: PANEL_PRESETS,
  NegotiationPage: NEGOTIATION_PRESETS,
};
const DASHBOARD_FILES = [
  "apps/dashboard/src/pages/BuilderPage.tsx",
  "apps/dashboard/src/components/builder/NegotiationPanel.tsx",
  "apps/dashboard/src/pages/NegotiationPage.tsx",
  "apps/dashboard/src/pages/RateSchedulePublishPage.tsx",
];
const WHITEPAPERS = [
  "apps/dashboard/public/whitepaper.md",
  "docs/whitepaper.md",
];

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

describe("split presets and published copy", () => {
  it("every split preset excludes treasury roles and labels", () => {
    const violations: string[] = [];
    for (const [table, presets] of Object.entries(PRESET_TABLES)) {
      for (const [name, preset] of Object.entries(presets)) {
        for (const row of preset) {
          if (["network", "network-treasury"].includes(row.role) || /treasury/i.test(row.label)) {
            violations.push(`${table} / ${name}: ${JSON.stringify(row)}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("every split preset sums to 100", () => {
    for (const [table, presets] of Object.entries(PRESET_TABLES)) {
      for (const [name, preset] of Object.entries(presets)) {
        expect(preset.reduce((sum, row) => sum + row.percentage, 0), `${table} / ${name}`).toBe(100);
      }
    }
  });

  it("publisher roles exclude the treasury option and wording", () => {
    expect(PUBLISHER_ROLES.filter((role) =>
      role.value === "network-treasury" || /treasury/i.test(role.label) || /treasury/i.test(role.description),
    )).toEqual([]);
  });

  it("dashboard sources contain no treasury wording", () => {
    const violations = DASHBOARD_FILES.flatMap((path) => {
      const match = read(path).match(TREASURY);
      return match ? [`${path}: ${match[0]}`] : [];
    });
    expect(violations).toEqual([]);
  });

  it("Quick Apply labels match the split preset percentages", () => {
    const source = read("apps/dashboard/src/pages/NegotiationPage.tsx");
    for (const name of ["Single-Step", "Multi-Step", "Community"]) {
      const preset = NEGOTIATION_PRESETS[name];
      expect(source).toContain(`${name} (${preset.map((r) => r.percentage).join("/")})`);
    }
    for (const label of [
      "Single-Step (10/70/10/10)",
      "Multi-Step (5/75/10/10)",
      "Community (20/60/5/5/10)",
    ]) {
      expect(source).not.toContain(label);
    }
  });

  it("whitepapers and MCP copy contain no fee or treasury wording", () => {
    const cardPath = "apps/dashboard/public/.well-known/mcp/server-card.json";
    const sources = [
      ...WHITEPAPERS.map((path) => [path, read(path)]),
      [cardPath, strings(JSON.parse(read(cardPath))).join("\n")],
      ["packages/mcp-server/src/index.ts", read("packages/mcp-server/src/index.ts")],
    ];
    const violations: string[] = [];
    for (const [path, source] of sources) {
      for (const line of source.split("\n")) {
        for (const pattern of [FEE_WORDING, TREASURY]) {
          const match = line.match(pattern);
          if (match) violations.push(`${path}: ${match[0]}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("whitepaper worked examples use the three-way distribution", () => {
    const violations: string[] = [];
    for (const path of WHITEPAPERS) {
      const source = read(path);
      const start = source.indexOf("Customer pays $100 for the full workflow");
      const end = source.indexOf("\n```", start);
      if (start < 0 || end < start) {
        violations.push(`${path}: missing worked-example block or closing fence`);
        continue;
      }
      const block = source.slice(start, end);
      const lines = block.split("\n");
      for (const line of lines.filter((line) => /Network \(\d+%\)/.test(line))) {
        violations.push(`${path}: ${line}`);
      }
      if (!block.includes("CNC Operator (80%):     $32.00")) {
        violations.push(`${path}: ${lines.find((line) => line.includes("CNC Operator")) ?? "missing CNC Operator line"}`);
      }
      if (!block.includes("$2.50 / $20.00 / $2.50]")) {
        violations.push(`${path}: ${lines.find((line) => line.includes("same distribution pattern")) ?? "missing Step 2 distribution line"}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
