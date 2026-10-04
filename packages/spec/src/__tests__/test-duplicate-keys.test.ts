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
 * The value of a constant primitive expression, as JavaScript computes it, or
 * undefined when `node` is not one: a string, a template with no
 * substitution, a number, a BigInt, true, false or null, a sign (- or +)
 * applied to one of those, and any of those in parentheses or under a type
 * assertion (`as`, `satisfies`, `<T>`, `!`). TypeScript normalizes a number's
 * text (`0x10` reads "16", `1_000` reads "1000"), but not a BigInt's (`0x10n`
 * reads "0x10n"), so a BigInt is parsed (astra pack 281). Unary plus on a
 * BigInt throws at runtime, so it is not a constant.
 */
function constantValue(node: ts.Node): string | number | bigint | boolean | null | undefined {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return constantValue(node.expression);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isBigIntLiteral(node)) return BigInt(node.text.slice(0, -1).replaceAll("_", ""));
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)) {
    const operand = constantValue(node.operand);
    if (typeof operand === "bigint") return node.operator === ts.SyntaxKind.MinusToken ? -operand : undefined;
    if (typeof operand === "number") return node.operator === ts.SyntaxKind.MinusToken ? -operand : operand;
  }
  return undefined;
}

/**
 * "file:line key" for each key an object literal in `text` names twice. A key
 * is compared as JavaScript stores it (ToPropertyKey): `[1n]`, `[1]`, `"1"`
 * and `1` are one key, and so are `[-0]` and `0`, `[true]` and `true`,
 * `["k" as const]` and `k`. Accessors count by kind: one get and one set of a
 * name are one property, but a second get or set, or an accessor beside a data
 * member, repeats it (astra pack 275). Only a computed key whose value is not
 * a constant primitive (`[name]`, `[f()]`) is skipped.
 */
function duplicateKeys(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const keyOf = (name: ts.PropertyName): string | null => {
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
    const value = constantValue(ts.isComputedPropertyName(name) ? name.expression : name);
    // String(-0) is "0", as ToPropertyKey(-0) is.
    return value === undefined ? null : String(value);
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
  it("finds a repeated key: quoted and bare, numeric, a constant computed key, two getters, an accessor beside data (astra packs 275, 281)", () => {
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
      // astra pack 281: every primitive literal key kind, as JavaScript stores it.
      "const k = { [1n]: 1, \"1\": 2 };",
      "const l = { [0x10n]: 1, 16: 2, 1_0n: 3, [10]: 4 };",
      "const m = { [-1]: 1, \"-1\": 2, [-0]: 3, 0: 4, [+5]: 5, \"5\": 6, [-2n]: 7, \"-2\": 8 };",
      "const n = { [true]: 1, true: 2, [false]: 3, \"false\": 4, [null]: 5, null: 6 };",
      "const o = { [(\"p\")]: 1, p: 2, [\"r\" as const]: 3, r: 4, [1e21]: 5, \"1e+21\": 6, [0.5]: 7, \".5\": 8 };",
      "const q = { [name]: 1, [name]: 2, [f()]: 3, [f()]: 4, [+1n]: 5, [`t${x}`]: 6, [`t${x}`]: 7 };",
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
      "__tests__/fixture.ts:11 1",
      "__tests__/fixture.ts:12 16",
      "__tests__/fixture.ts:12 10",
      "__tests__/fixture.ts:13 -1",
      "__tests__/fixture.ts:13 0",
      "__tests__/fixture.ts:13 5",
      "__tests__/fixture.ts:13 -2",
      "__tests__/fixture.ts:14 true",
      "__tests__/fixture.ts:14 false",
      "__tests__/fixture.ts:14 null",
      "__tests__/fixture.ts:15 p",
      "__tests__/fixture.ts:15 r",
      "__tests__/fixture.ts:15 1e+21",
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
