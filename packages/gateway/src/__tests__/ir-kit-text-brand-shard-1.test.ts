import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { LIST_PROFILES } from "../mcp/dashboard-ir.js";
import { listFieldLabel, UNAVAILABLE } from "../mcp/dashboard-ir-renderer.js";
import { lintTextSinks } from "../../../spec/src/__tests__/ui-kit-text-sinks-lint.js";

import {
  irPaths,
  mutationAudits,
  mutationLines,
  readConfig,
  overriddenProgram,
  N5_EXPECTED_DIAGNOSTICS,
  GUARD_SHARDS,
  GUARD_TIMEOUT_MS,
  initializeGuard,
} from "./ir-kit-text-brand-guard.js";
const MUTATIONS = GUARD_SHARDS[1]!;
beforeAll(async () => { await initializeGuard(MUTATIONS, 1); }, GUARD_TIMEOUT_MS);

describe("IR text guard Program shard 1", () => {
  it.each(MUTATIONS)("reports injected $name on its own source line", ({ name }) => {
    const expected = mutationLines.get(name)!;
    expect(mutationAudits.get(name)!.findings.filter((f) => f.file === expected.file && f.line === expected.line && f.rule === expected.rule), name).not.toEqual([]);
  });
  it("N5 inventories laundering and already-blocked any routes under both configurations", () => {
    const mutations = MUTATIONS.filter((mutation) => mutation.name.startsWith("N5"));
    const path = irPaths[0]!;
    let text = readFileSync(path, "utf8");
    const starts: number[] = [];
    for (const [index, mutation] of mutations.entries()) {
      starts.push(text.length);
      text += `\nnamespace ProbeInventory${index} {\n${mutation.code}\n}\n`;
    }
    const diagnostics = ["tsconfig.json", "tsconfig.browser.json"].map((name) => {
      const probe = overriddenProgram(new Map([[path, text]]), { ...readConfig(name), fileNames: [path] });
      const file = probe.getSourceFile(path)!;
      return [...probe.getSyntacticDiagnostics(file), ...probe.getSemanticDiagnostics(file)];
    });
    const rows = mutations.map((mutation, index) => {
      const codes = diagnostics.map((items) => items.filter((item) => (item.start ?? 0) >= starts[index]! && (item.start ?? 0) < (starts[index + 1] ?? text.length)).map((item) => item.code));
      const findings = mutationAudits.get(mutation.name)!.findings.filter((finding) => finding.line >= mutationLines.get(mutation.name)!.line);
      return { name: mutation.name, guard: findings.map(({ rule, detail }) => ({ rule, detail })), node: codes[0], browser: codes[1], lint: lintTextSinks(mutation.code, { file: path, scriptKind: ts.ScriptKind.TS, sinks: [] }).map((issue) => issue.rule) };
    });
    console.log("N5-ROUTE-INVENTORY", JSON.stringify(rows));
    // Opaque objects make some former string-widening routes fail tsc before
    // runtime. Keep every Program and still require its guard finding above.
    for (const row of rows) {
      expect(row.node, `${row.name} node diagnostics`).toEqual(N5_EXPECTED_DIAGNOSTICS[row.name]!.node);
      expect(row.browser, `${row.name} browser diagnostics`).toEqual(N5_EXPECTED_DIAGNOSTICS[row.name]!.browser);
    }
  });
});
