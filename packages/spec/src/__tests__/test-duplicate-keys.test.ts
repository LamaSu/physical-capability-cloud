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

/** "file:line key" for each key an object literal in `text` names twice. Get/set accessor pairs and computed keys are skipped. */
function duplicateKeys(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const keyOf = (name: ts.PropertyName): string | null => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
    if (ts.isNumericLiteral(name)) return String(Number(name.text));
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const seen = new Set<string>();
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) continue;
        const key = property.name === undefined ? null : keyOf(property.name);
        if (key === null) continue;
        if (seen.has(key)) {
          const { line } = source.getLineAndCharacterOfPosition(property.getStart(source));
          found.push(`${relative(SRC, file)}:${line + 1} ${key}`);
        }
        seen.add(key);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("spec's tests: no object literal names a key twice (astra pack 271 LOW)", () => {
  it("finds a repeated key, including one quoted and one bare, and ignores spreads, accessor pairs and computed keys", () => {
    const text = [
      "const a = { x: 1, y: 2, x: 3 };",
      "const b = { 'k': 1, k: 2 };",
      "const c = { ...a, ...a, [b.k]: 1, [b.k]: 2, get v() { return 1; }, set v(_n) {} };",
      "const d = { 1: 'one', '1': 'uno' };",
    ].join("\n");
    expect(duplicateKeys(join(SRC, "__tests__", "fixture.ts"), text)).toEqual(["__tests__/fixture.ts:1 x", "__tests__/fixture.ts:2 k", "__tests__/fixture.ts:4 1"]);
  });

  it("no test file under src has one", () => {
    const files = testFiles(SRC);
    expect(files.length).toBeGreaterThan(20);
    const found: string[] = [];
    for (const file of files) found.push(...duplicateKeys(file, readFileSync(file, "utf8")));
    expect(found).toEqual([]);
  });
});
