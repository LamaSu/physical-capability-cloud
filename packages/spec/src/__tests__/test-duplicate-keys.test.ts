/**
 * No object literal in @pcc/spec's tests names a key twice (astra pack 271 LOW).
 *
 * The tests are not type-checked (tsconfig.json excludes them), so TypeScript's
 * own duplicate-property error never runs on them, and there is no linter. A
 * second key silently wins at runtime, and a test can then assert something
 * other than what it reads. This walks every test file's syntax tree with the
 * TypeScript compiler and lists each repeated key.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Every test source under src: *.test.ts anywhere, and every .ts file under a __tests__ directory. */
function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules") testFiles(path, out);
    } else if (name.endsWith(".test.ts") || (path.includes(`${"/"}__tests__${"/"}`) && name.endsWith(".ts"))) {
      out.push(path);
    }
  }
  return out;
}

/**
 * "file:line key" for each key an object literal in `text` names twice. A
 * constant computed key (`["k"]`, `[1]`, `` [`k`] ``) is its value. Accessors
 * count by kind: one get and one set of a name are one property, but a second
 * get or set, or an accessor beside a data member, repeats it (astra pack 275).
 * Only a computed key whose value is not a literal is skipped.
 */
function duplicateKeys(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const literalKey = (node: ts.Node): string | null => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return String(Number(node.text));
    return null;
  };
  const keyOf = (name: ts.PropertyName): string | null => {
    if (ts.isComputedPropertyName(name)) {
      const expression = name.expression;
      return ts.isIdentifier(expression) ? null : literalKey(expression);
    }
    return literalKey(name);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const kinds = new Map<string, Set<"get" | "set" | "data">>();
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property) || property.name === undefined) continue;
        const key = keyOf(property.name);
        if (key === null) continue;
        const kind = ts.isGetAccessorDeclaration(property) ? "get" : ts.isSetAccessorDeclaration(property) ? "set" : "data";
        const seen = kinds.get(key);
        // Only a getter and a setter of one name may share it, once each.
        const pairs = seen !== undefined && seen.size === 1 && ((kind === "get" && seen.has("set")) || (kind === "set" && seen.has("get")));
        if (seen !== undefined && !pairs) {
          const { line } = source.getLineAndCharacterOfPosition(property.getStart(source));
          found.push(`${relative(SRC, file)}:${line + 1} ${key}`);
        }
        if (seen === undefined) kinds.set(key, new Set([kind]));
        else seen.add(kind);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("spec's tests: no object literal names a key twice (astra pack 271 LOW)", () => {
  it("finds a repeated key: quoted and bare, numeric, a constant computed key, two getters, an accessor beside data (astra pack 275)", () => {
    const text = [
      "const a = { x: 1, y: 2, x: 3 };",
      "const b = { 'k': 1, k: 2 };",
      "const c = { ...a, ...a, [b.k]: 1, [b.k]: 2, [key]: 1, [key]: 2, get v() { return 1; }, set v(_n) {} };",
      "const d = { 1: 'one', '1': 'uno' };",
      "const e = { executorTrustDomains: [], [\"executorTrustDomains\"]: [1] };",
      "const f = { [`t`]: 1, t: 2, [2]: 1, '2': 2 };",
      "const g = { get w() { return 1; }, get w() { return 2; } };",
      "const h = { get z() { return 1; }, z: 2 };",
      "const i = { set s(_n) {}, s: 1 };",
      "const j = { get q() { return 1; }, set q(_n) {}, set q(_m) {} };",
    ].join("\n");
    expect(duplicateKeys(join(SRC, "__tests__", "fixture.ts"), text)).toEqual([
      "__tests__/fixture.ts:1 x",
      "__tests__/fixture.ts:2 k",
      "__tests__/fixture.ts:4 1",
      "__tests__/fixture.ts:5 executorTrustDomains",
      "__tests__/fixture.ts:6 t",
      "__tests__/fixture.ts:6 2",
      "__tests__/fixture.ts:7 w",
      "__tests__/fixture.ts:8 z",
      "__tests__/fixture.ts:9 s",
      "__tests__/fixture.ts:10 q",
    ]);
  });

  it("no test file under src has one", () => {
    const files = testFiles(SRC);
    expect(files.length).toBeGreaterThan(20);
    const found: string[] = [];
    for (const file of files) found.push(...duplicateKeys(file, readFileSync(file, "utf8")));
    expect(found).toEqual([]);
  });
});
