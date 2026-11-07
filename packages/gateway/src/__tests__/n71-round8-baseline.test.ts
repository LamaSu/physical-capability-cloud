import { afterEach, describe, expect, it } from "vitest";
import * as ts from "typescript";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baselineFromViolations,
  createViolation,
  loadBaseline,
  newViolations,
  regenerateBaseline,
  staleBaselineEntries,
  validateReviewedAdditions,
  type Violation,
} from "./n71-sink-scanner-engine.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryBaseline(): string {
  const directory = mkdtempSync(join(tmpdir(), "n71-baseline-"));
  temporaryDirectories.push(directory);
  return join(directory, "baseline.json");
}

function occurrences(source: string): Violation[] {
  const sourceFile = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true);
  const result: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === "console.warn") {
      result.push(createViolation("services/review-fixture.ts", "console.warn", node.arguments[0], sourceFile, node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function duplicated(count: number): Violation[] {
  return occurrences(`function run(raw: unknown) { ${"console.warn(raw); ".repeat(count)} }`);
}

function reviewed(row: Violation) {
  return { ...row, classification: "not_a_leak", reason: "Reviewed fixture expression" };
}

describe("N71 round 8: baseline occurrence identity", () => {
  it("flags a second matching sink occurrence against a baseline admitting only the first", () => {
    const [first, second] = duplicated(2);
    expect(first.argText).toBe(second.argText);
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(newViolations([first, second], baselineFromViolations([first]))).toEqual([second]);
  });

  it("keeps a duplicated violation new after default regeneration", () => {
    const path = temporaryBaseline();
    const [first, second] = duplicated(2);
    writeFileSync(path, JSON.stringify(baselineFromViolations([first])));
    const regenerated = regenerateBaseline([first, second], path);
    expect(regenerated.bootstrapped).toBe(false);
    expect(regenerated.removed).toBe(0);
    expect(newViolations([first, second], loadBaseline(path))).toEqual([second]);
  });

  it("bootstraps each occurrence and detects another duplicate before and after regeneration", () => {
    const path = temporaryBaseline();
    const [first, second, third] = duplicated(3);
    const generated = regenerateBaseline([first, second], path);
    expect(generated.bootstrapped).toBe(true);
    expect(generated.baseline[first.file][first.sink]).toHaveLength(2);
    expect(newViolations([first, second, third], generated.baseline)).toEqual([third]);
    regenerateBaseline([first, second, third], path);
    expect(newViolations([first, second, third], loadBaseline(path))).toEqual([third]);
  });

  it("preserves multiplicity even for identical supplied fingerprints", () => {
    const [row] = duplicated(1);
    const single = baselineFromViolations([row]);
    const double = baselineFromViolations([row, { ...row }]);
    expect(double[row.file][row.sink]).toHaveLength(2);
    expect(newViolations([row, { ...row }], single)).toEqual([row]);
    expect(staleBaselineEntries([row], double)).toEqual([row]);
  });

  it("shrinks removed duplicate occurrences without admitting replacements", () => {
    const path = temporaryBaseline();
    const [first, second, third] = duplicated(3);
    writeFileSync(path, JSON.stringify(baselineFromViolations([first, second])));
    const regenerated = regenerateBaseline([first, third], path);
    expect(regenerated.removed).toBe(1);
    expect(regenerated.baseline[first.file][first.sink]).toEqual([
      { argText: first.argText, fingerprint: first.fingerprint },
    ]);
    expect(newViolations([first, third], regenerated.baseline)).toEqual([third]);
    expect(staleBaselineEntries([first, third], regenerated.baseline)).toEqual([]);
  });

  it("keeps fingerprints stable across unrelated line shifts and separates named declarations", () => {
    const source = "function first(raw: unknown) { console.warn(raw); } function second(raw: unknown) { console.warn(raw); }";
    const before = occurrences(source);
    const after = occurrences(`const unrelated = true;\n\n${source}`);
    expect(after.map((row) => row.fingerprint)).toEqual(before.map((row) => row.fingerprint));
    expect(before[0].fingerprint).not.toBe(before[1].fingerprint);
  });

  it("keeps an existing unsafe leaf identity when a sibling argument is formatted", () => {
    const [before] = occurrences("function run(raw: unknown, sibling: unknown) { console.warn(raw, sibling); }");
    const [after] = occurrences("function run(raw: unknown, sibling: unknown) { console.warn(raw, String(sibling)); }");
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(newViolations([after], baselineFromViolations([before]))).toEqual([]);
  });

  it("retains complete long expression identity beyond the former truncation boundary", () => {
    const prefix = `raw.${"member".repeat(40)}`;
    const [first] = occurrences(`function run(raw: any) { console.warn(${prefix}Left); }`);
    const [second] = occurrences(`function run(raw: any) { console.warn(${prefix}Right); }`);
    expect(first.argText.length).toBeGreaterThan(200);
    expect(first.argText).toBe(`${prefix}Left`);
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(newViolations([second], baselineFromViolations([first]))).toEqual([second]);
  });

  it("admits an explicit review only for the exact new occurrence fingerprint", () => {
    const [first, second] = duplicated(2);
    const baseline = baselineFromViolations([first]);
    expect(validateReviewedAdditions([reviewed(second)], [first, second], baseline)).toEqual([second]);
    expect(() => validateReviewedAdditions([reviewed(first)], [first, second], baseline)).toThrow(/currently new/);
    expect(() => validateReviewedAdditions([reviewed(second), reviewed(second)], [first, second], baseline)).toThrow(/distinct/);
    expect(() => validateReviewedAdditions([{ ...reviewed(second), fingerprint: first.fingerprint }], [first, second], baseline)).toThrow(/currently new/);
  });

  it("rejects in-scope and incomplete explicit review rows", () => {
    const [row] = duplicated(1);
    const scoped = { ...row, file: "routes/setup.ts" };
    expect(() => validateReviewedAdditions([reviewed(scoped)], [scoped], {})).toThrow(/outside N71/);
    expect(() => validateReviewedAdditions([{ ...reviewed(row), fingerprint: undefined }], [row], {})).toThrow(/fingerprint/);
    expect(() => validateReviewedAdditions([{ ...reviewed(row), reason: "" }], [row], {})).toThrow(/reason/);
  });
});
