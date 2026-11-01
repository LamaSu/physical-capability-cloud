import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { LIST_PROFILES } from "../mcp/dashboard-ir.js";
import { listFieldLabel, UNAVAILABLE } from "../mcp/dashboard-ir-renderer.js";
import { lintTextSinks } from "../../../spec/src/__tests__/ui-kit-text-sinks-lint.js";

import {
  gateway,
  src,
  IR_FILES,
  irPaths,
  MINTS,
  DOM,
  program,
  baseAudit,
  mutationAudits,
  mutationLines,
  CALLABLE_PRESENCE,
  literalOnly,
  topLevelMint,
  containingFunction,
  buildInputs,
  lintTargets,
  audit,
  importedText,
  allTsFiles,
  overriddenProgram,
  R2E_SAFE_PROGRAMS,
  GUARD_SHARDS,
  GUARD_PROGRAM_COUNT,
  GUARD_PROGRAM_MANIFEST_SHA256,
  GUARD_TIMEOUT_MS,
  initializeGuard,
} from "./ir-kit-text-brand-guard.js";
const MUTATIONS = GUARD_SHARDS[0]!;
beforeAll(async () => { await initializeGuard(MUTATIONS, 0); }, GUARD_TIMEOUT_MS);

describe("IR kit closed text brand and DOM surface", () => {
  it("pins the complete sorted Program manifest across four workers", () => {
    const programs = GUARD_SHARDS.flat();
    const rows = programs.map(({ name, rule }) => [name, rule]).sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0);
    const serialized = JSON.stringify(rows) + "\n";
    expect(GUARD_SHARDS).toHaveLength(4);
    expect(programs.length).toBe(GUARD_PROGRAM_COUNT);
    expect(new Set(programs.map(({ name }) => name)).size).toBe(GUARD_PROGRAM_COUNT);
    expect(createHash("sha256").update(serialized).digest("hex")).toBe(GUARD_PROGRAM_MANIFEST_SHA256);
    console.log("IR-TEXT-GUARD-MANIFEST", JSON.stringify({ count: programs.length, sha256: GUARD_PROGRAM_MANIFEST_SHA256, shardCounts: GUARD_SHARDS.map((shard) => shard.length) }));
  });
  it("accepts the pinned owner declarations with CRLF line endings", () => {
    const overrides = new Map(irPaths.map((path) => [path, readFileSync(path, "utf8").replace(/\r?\n/g, "\r\n")]));
    expect(audit(overriddenProgram(overrides)).findings).toEqual([]);
  });
  it("keeps intrinsic acquisition receiver-only with unknown prototype results", () => {
    expect(baseAudit.findings.filter((finding) => finding.rule === "intrinsic-escape")).toEqual([]);
  });
  it("type-checks every guarded source without semantic or syntactic diagnostics", () => {
    expect(baseAudit.findings.filter((f) => f.rule === "diagnostic")).toEqual([]);
  });
  it("has no any expressions, unsafe assertions or type-check suppressions", () => {
    expect(baseAudit.findings.filter((f) => ["any", "assertion", "directive"].includes(f.rule))).toEqual([]);
  });
  it("pins captured primordials first, confines stores and rejects built-in/style writes", () => {
    expect(baseAudit.findings.filter((f) => ["captures-first", "brand-confinement", "builtin-write", "style-write", "input-type", "brand-read"].includes(f.rule))).toEqual([]);
  });
  it("mints only in the justified closed function list, without stale entries", () => {
    expect(baseAudit.findings.filter((f) => ["mint", "stale-mint"].includes(f.rule))).toEqual([]);
    expect(MINTS.every((entry) => entry.reason.length > 0)).toBe(true);
  });
  it("confines text imports to reviewed source and test files", () => {
    expect(allTsFiles(src).flatMap((path) => importedText(ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)))).toEqual([]);
  });
  it("allows only reviewed DOM members, without stale entries, and only in the browser entry", () => {
    expect(baseAudit.findings.filter((f) => ["dom", "stale-dom"].includes(f.rule))).toEqual([]);
    expect([...baseAudit.domFiles]).toEqual(["mcp/dashboard-ir-browser-entry.ts"]);
    expect(DOM.every((entry) => entry.reason.length > 0)).toBe(true);
  });
  it("rejects write/call reflection while retaining read-only ownKeys and descriptor.enumerable", () => {
    expect(baseAudit.findings.filter((f) => f.rule === "reflection")).toEqual([]);
  });
  it("F10 permits text-property writes only inside the declared sinks across all four IR files", () => {
    expect(baseAudit.findings.filter((finding) => finding.rule === "text-sink")).toEqual([]);
  });
  it("cross-checks the guard with build inputs and every IR DOM recipient with lint targets", () => {
    expect(baseAudit.findings.filter((f) => f.rule === "inventory")).toEqual([]);
    expect(IR_FILES.map((file) => `packages/gateway/src/mcp/${file}`).sort()).toEqual(buildInputs().sort());
    const receivers = new Set(["dashboard-ir-renderer.ts", ...[...baseAudit.domFiles].map((file) => file.replace(/^mcp\//, ""))]);
    for (const file of receivers) expect(lintTargets()).toContain(file);
  });
  it("rejects inventory drift when a bundled source is absent from the guard", () => {
    const result = audit(program, MINTS, DOM, [...buildInputs(), "unscanned.ts"]);
    expect(result.findings.filter((f) => f.rule === "inventory")).not.toEqual([]);
  });
  it("rejects inventory drift when a DOM recipient is absent from the lint", () => {
    const result = audit(program, MINTS, DOM, buildInputs(), []);
    expect(result.findings.filter((f) => f.rule === "inventory")).not.toEqual([]);
  });
  it("rejects a mint allowance without exactly one declaration", () => {
    const result = audit(program, [...MINTS, { file: "dashboard-ir-renderer.ts", function: "missingMint", reason: "Deliberately absent declaration" }]);
    expect(result.findings.some((finding) => finding.rule === "mint" && finding.detail.includes("missingMint"))).toBe(true);
  });
  it("binds approved mints only to top-level function declarations", () => {
    const file = ts.createSourceFile("probe.ts", 'const unrelated = function stamp() { return "raw"; };', ts.ScriptTarget.Latest, true);
    const statement = file.statements[0]! as ts.VariableStatement;
    expect(topLevelMint(statement.declarationList.declarations[0]!.initializer!, file)).toBe(false);
  });
  it("N3 rejects a mint inside a same-named but different declaration by exact identity", () => {
    // The separate same-name rejection is insufficient: acceptance must also
    // reject the cast inside that declaration, even though its mint key is stamp.
    expect(mutationAudits.get("B1 nested stamp")!.findings).toContainEqual(expect.objectContaining({
      rule: "mint", detail: "Text mint outside closed function list: dashboard-ir-renderer.ts:stamp",
    }));
  });
  it("N3 rejects a predicate arrow inside the approved declaration by exact identity", () => {
    expect(mutationAudits.get("N3 nested predicate inside approved stamp")!.findings).toContainEqual(expect.objectContaining({
      rule: "mint", detail: "Type predicates must not manufacture text brands: dashboard-ir-renderer.ts:stamp",
    }));
  });
  it("rejects removing browserConfig from the actual kits array while its declaration remains", () => {
    const source = readFileSync(join(gateway, "../spec/src/__tests__/ui-kit-text-sinks.lint.test.ts"), "utf8");
    const changed = source.replace("  browserConfig,\n", "");
    expect(changed).not.toBe(source);
    expect(lintTargets(changed)).not.toContain("dashboard-ir-browser-entry.ts");
  });
  it("keeps real DOM elements private to the browser adapter", () => {
    const source = readFileSync(join(src, "mcp/dashboard-ir-browser-entry.ts"), "utf8");
    expect(source).not.toMatch(/\b_el\b/);
    expect(source).toMatch(/new WeakMap/);
  });
  it("covers every list profile field with a PCC-owned label", () => {
    const fields = new Set(Object.values(LIST_PROFILES).flatMap((profile) => [...profile.title, ...profile.meta, ...profile.status]));
    expect(fields.size).toBeGreaterThan(0);
    for (const field of fields) expect(listFieldLabel(field), `Missing PCC label for profiled field ${field}`).not.toBe(UNAVAILABLE);
    expect(listFieldLabel("unprofiled-field")).toBe(UNAVAILABLE);
  });
  it.each(MUTATIONS)("reports injected $name on its own source line", ({ name }) => {
    const expected = mutationLines.get(name)!;
    expect(mutationAudits.get(name)!.findings.filter((f) => f.file === expected.file && f.line === expected.line && f.rule === expected.rule), name).not.toEqual([]);
  });
  it("r2e4 control X21 keeps the constructor prototype route rejected by the spec lint", () => {
    const code = "export function probeX21(d: RDocument, raw: string): RElement { const p = (new Set<unknown>() as { constructor: { prototype: { has(v: unknown): boolean } } }).constructor.prototype; const o = p.has; p.has = function (): boolean { return true; }; try { return el(d, \"pcc-x\", boundStatusText(raw)); } finally { p.has = o; } }";
    const findings = lintTextSinks(code, { file: join(src, "mcp/dashboard-ir-renderer.ts"), scriptKind: ts.ScriptKind.TS, sinks: [] });
    expect(findings.some((finding) => finding.line === 1 && finding.rule === "forbidden .constructor read")).toBe(true);
  });
  it.each(R2E_SAFE_PROGRAMS)("r2e preserves safe $name", ({ file, needle, code }) => {
    const path = join(src, "mcp", file);
    const text = readFileSync(path, "utf8");
    expect(text).toContain(needle);
    const result = audit(overriddenProgram(new Map([[path, text.replace(needle, code)]])));
    expect(result.findings).toEqual([]);
  });
  it.each([
    'const probeParser: (s: string) => unknown = JSON.parse;',
    'function probeIdentity<T>(s: T): T { return s; } const probeF: (s: KitText) => KitText = probeIdentity;',
    'const probeNarrow = { get payload(): KitText { return kitText("checked"); } }; const probeWide: { payload: Readonly<{ t: string }> } = probeNarrow;',
    'const probeNarrow = { get payload(): KitText { return kitText("checked"); } }; const probeWide: Readonly<{ payload: Readonly<{ t: string }> }> = probeNarrow;',
    'const probeNarrow = { get payload(): KitText { return kitText("checked"); } }; const probeWide: { readonly payload: Readonly<{ t: string }> } = probeNarrow;',
    'const probeF: { f(s: KitText): KitText } = { f: (s: KitText): KitText => s };',
    'function probeSink(): { reason?: KitText } { return { reason: kitText("checked") }; }',
    'function probeBox<T>(initial: T) { let saved = initial; return { get payload(): string { return ""; }, set payload(v: T) { saved = v; }, get value(): T { return saved; } }; } const probeNarrow = probeBox("checked"); const probeWide: { payload: string; readonly value: string } = probeNarrow;',
  ])("N5 accepts safe brand-preserving or readonly relations: %s", (code) => {
    const path = irPaths[0]!;
    const result = audit(overriddenProgram(new Map([[path, `${readFileSync(path, "utf8")}\n${code}\n`]])));
    expect(result.findings).toEqual([]);
  });
  it.each([
    "const extraText = \"@ts-ignore\"; const extraRegex = /@ts-ignore/; const extraTemplate = `@ts-ignore ${1}`;",
    "function extraCallable(s: KitText): KitText { return s; } const extraText = extraCallable(kitText(\"checked\"));",
    "function extraCallable(s: KitText): KitText { return s; } const extraHolder: { f(s: KitText): KitText } = { f: extraCallable }; const extraText = extraHolder.f(kitText(\"checked\"));",
  ])("r2d accepts ordinary directive text and permitted callable uses: %s", (code) => {
    const path = irPaths[0]!;
    const result = audit(overriddenProgram(new Map([[path, `${readFileSync(path, "utf8")}\n${code}\n`]])));
    expect(result.findings).toEqual([]);
  });
  it("checks the callback-presence allowance for a real owner and use", () => {
    expect(baseAudit.findings.filter((finding) => finding.rule === "stale-presence")).toEqual([]);
    expect(CALLABLE_PRESENCE.reason.length).toBeGreaterThan(0);
    for (const presence of [
      { ...CALLABLE_PRESENCE, function: "removedOwner" },
      { ...CALLABLE_PRESENCE, parameters: ["onStale", "removedCallback"] },
    ]) {
      const result = audit(program, MINTS, DOM, buildInputs(), lintTargets(), presence);
      expect(result.findings.some((finding) => finding.rule === "stale-presence")).toBe(true);
    }
  });
  it("reports stale mint and DOM allowances", () => {
    const stale = audit(program, [...MINTS, { file: "dashboard-ir.ts", function: "removedMint", reason: "Mutation proves stale mint allowances fail." }], [...DOM, { name: "Element.innerHTML", reason: "Mutation proves stale DOM allowances fail." }]);
    expect(stale.findings.filter((f) => f.rule === "stale-mint")).toEqual([expect.objectContaining({ detail: "Stale mint allowance: removedMint" })]);
    expect(stale.findings.filter((f) => f.rule === "stale-dom")).toEqual([expect.objectContaining({ detail: "Stale DOM allowance: Element.innerHTML" })]);
  });
  it("reports forbidden aliased, namespace and type imports outside the closed files", () => {
    const path = join(src, "unapproved-text-import.ts");
    for (const text of [
      'import { KitText as HiddenBrand } from "./mcp/dashboard-ir.js";',
      'import { kitText as hiddenMint } from "./mcp/dashboard-ir.js";',
      'import type { AgentText } from "./mcp/dashboard-ir.js";',
      'import { registerKitText } from "./mcp/dashboard-ir.js";',
      'import { registerAgentText as registrar } from "./mcp/dashboard-ir.js";',
      'import * as ir from "./mcp/dashboard-ir.js";',
      'type Hidden = import("./mcp/dashboard-ir.js").KitText;',
      'export * from "./mcp/dashboard-ir.js";',
      'export * as ir from "./mcp/dashboard-ir.js";',
      'import ir = require("./mcp/dashboard-ir.js");',
      'const ir = await import("./mcp/dashboard-ir.js");',
      'const ir = require("./mcp/dashboard-ir.js");',
      'const { kitText: mint } = await import("./mcp/dashboard-ir.js");',
      'const { KitText: hidden } = require("./mcp/dashboard-ir.js");',
    ]) expect(importedText(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true))).toEqual([expect.objectContaining({ rule: "import", line: 1 })]);
  });
  it("permits immediate dynamic named imports of unprotected IR exports", () => {
    const path = join(src, "unapproved-text-import.ts");
    for (const text of [
      'const { listRowsOf, LIST_PROFILES } = await import("./mcp/dashboard-ir.js");',
      'const { validateIr: validate } = require("./mcp/dashboard-ir.js");',
    ]) expect(importedText(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true))).toEqual([]);
  });
  it("does not let an anonymous callback inherit a listed outer mint function", () => {
    const s = ts.createSourceFile("nested.ts", 'function stamp() { return (() => raw as KitText)(); }', ts.ScriptTarget.Latest, true);
    let assertion: ts.AsExpression | undefined;
    const find = (n: ts.Node): void => { if (ts.isAsExpression(n)) assertion = n; ts.forEachChild(n, find); };
    find(s);
    expect(containingFunction(assertion!)).toBe("<anonymous>");
  });
  it("recognizes literal-only conditional and parenthesized kitText compositions", () => {
    const s = ts.createSourceFile("literal.ts", 'kitText(flag ? ("Yes") : (`No`)); kitText(raw);', ts.ScriptTarget.Latest, true);
    const first = (s.statements[0] as ts.ExpressionStatement).expression as ts.CallExpression;
    const second = (s.statements[1] as ts.ExpressionStatement).expression as ts.CallExpression;
    expect(literalOnly(first.arguments[0]!)).toBe(true);
    expect(literalOnly(second.arguments[0]!)).toBe(false);
  });
});
