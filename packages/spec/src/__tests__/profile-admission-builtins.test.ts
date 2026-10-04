/**
 * profile-admission.ts reads nothing from a built-in object except through a
 * primordial captured at load (steward DECISIONS 01:30, astra pack 289).
 *
 * A typed array's `length` is an accessor inherited from %TypedArray%.prototype,
 * so `bytes.length` runs whatever code replaced it after load; pack 289 made a
 * keyless delegation verify that way. The regex scan in
 * profile-admission-intrinsics.test.ts finds calls, not reads. This check uses
 * the TypeScript checker, so it knows each receiver's static type, and it is a
 * CLOSED allowlist. On a value whose type is a built-in, only these are allowed:
 *   - a numeric element read or write (`bytes[i]`, `list[i]`, `text[i]`):
 *     integer-indexed and array elements are own, and never consult a prototype;
 *   - `length` of an array or a string, which is own data, never inherited.
 * Anything else is reported: every other property read, and every method call,
 * on a typed array, ArrayBuffer, DataView, Map, Set, WeakMap, WeakSet, WeakRef,
 * Promise, RegExp, Date, Error, Function, array, string, number, boolean or bigint.
 * A call of a function VALUE (a captured primordial, or a local function) is not
 * a property access, so it is allowed.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SPEC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADMISSION = join(SPEC_DIR, "src", "evidence", "profile-admission.ts");

/** The built-in object types whose every property read goes through a primordial. */
const BUILTIN_OBJECTS = new Set([
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "Buffer",
  "ArrayBuffer", "SharedArrayBuffer", "DataView",
  "Map", "ReadonlyMap", "Set", "ReadonlySet", "WeakMap", "WeakSet", "WeakRef",
  "Promise", "PromiseLike", "RegExp", "RegExpMatchArray", "Date", "Error", "Function", "CallableFunction", "NewableFunction",
]);
/** The built-in object types whose own `length` is data: arrays. */
const ARRAYS = new Set(["Array", "ReadonlyArray"]);

function compilerOptions(): ts.CompilerOptions {
  const configPath = ts.findConfigFile(SPEC_DIR, ts.sys.fileExists, "tsconfig.json")!;
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!;
  return { ...parsed.options, noEmit: true };
}

/**
 * Each part of `type` (a union's members, nullish left out) as the built-in it
 * is, or null for a type that is not one: "object:<name>", "array", "string",
 * "number", "boolean", "bigint", "function".
 */
function builtinKinds(checker: ts.TypeChecker, type: ts.Type, program: ts.Program): string[] {
  const parts = type.isUnion() ? type.types : [type];
  const kinds: string[] = [];
  for (const part of parts) {
    if (part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never)) continue;
    // A receiver whose type is unknown to the checker could be any built-in: the allowlist is closed, so it is refused.
    if (part.flags & ts.TypeFlags.Any) kinds.push("any");
    else if (part.flags & ts.TypeFlags.StringLike) kinds.push("string");
    else if (part.flags & ts.TypeFlags.NumberLike) kinds.push("number");
    else if (part.flags & ts.TypeFlags.BooleanLike) kinds.push("boolean");
    else if (part.flags & ts.TypeFlags.BigIntLike) kinds.push("bigint");
    else {
      const symbol = part.getSymbol() ?? part.aliasSymbol;
      const fromLib = symbol?.declarations?.some((d) => {
        const file = d.getSourceFile();
        return program.isSourceFileDefaultLibrary(file) || /[\\/]node_modules[\\/]@types[\\/]node[\\/]/.test(file.fileName);
      });
      const name = symbol?.getName();
      if (fromLib && name !== undefined && ARRAYS.has(name)) kinds.push("array");
      else if (fromLib && name !== undefined && BUILTIN_OBJECTS.has(name)) kinds.push(`object:${name}`);
      else if (part.getCallSignatures().length > 0 && part.getProperties().length === 0) kinds.push("function");
    }
  }
  return kinds;
}

/**
 * "file:line what: text" for each read or call on a built-in that the allowlist
 * does not name: in the whole file, or only inside the function declarations
 * named in `functions`.
 */
function builtinReads(program: ts.Program, fileName: string, functions?: ReadonlySet<string>): string[] {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(fileName)!;
  const found: string[] = [];
  const report = (node: ts.Node, what: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push(`${fileName.split(/[\\/]/).pop()}:${line + 1} ${what}: ${node.getText(source).slice(0, 80)}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const kinds = builtinKinds(checker, checker.getTypeAtLocation(node.expression), program);
      const name = node.name.text;
      for (const kind of kinds) {
        const ownLength = name === "length" && (kind === "array" || kind === "string");
        if (!ownLength) report(node, `.${name} on a ${kind}`);
      }
    } else if (ts.isElementAccessExpression(node)) {
      const kinds = builtinKinds(checker, checker.getTypeAtLocation(node.expression), program);
      const numeric = (checker.getTypeAtLocation(node.argumentExpression).flags & ts.TypeFlags.NumberLike) !== 0;
      for (const kind of kinds) {
        const indexable = kind === "array" || kind === "string" || /^object:(Int|Uint|Float|BigInt|BigUint)\d*(Clamped)?Array$|^object:Buffer$/.test(kind);
        if (!(numeric && indexable)) report(node, `[${node.argumentExpression.getText(source)}] on a ${kind}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  if (functions === undefined) visit(source);
  else {
    const scoped = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined && functions.has(node.name.text)) visit(node);
      else ts.forEachChild(node, scoped);
    };
    scoped(source);
  }
  return found;
}

/** A program over one in-memory file, with the spec's compiler options and the default library. */
function programOf(fileName: string, text: string): ts.Program {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...rest) =>
    name === fileName ? ts.createSourceFile(name, text, languageVersion, true) : getSourceFile(name, languageVersion, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === fileName || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => (name === fileName ? text : readFile(name));
  return ts.createProgram([fileName], options, host);
}

describe("profile-admission.ts reads nothing from a built-in except through a primordial (DECISIONS 01:30, astra pack 289)", () => {
  it("the check finds every read and call on a built-in (or on an `any`, which could be one) that the allowlist does not name, and nothing it names", () => {
    const fileName = join(SPEC_DIR, "src", "__tests__", "builtin-reads-fixture.ts");
    const text = [
      "declare const bytes: Uint8Array; declare const list: number[]; declare const ro: readonly string[]; declare const s: string;",
      "declare const p: Promise<number>; declare const m: Map<string, number>; declare const st: Set<string>; declare const re: RegExp;",
      "declare const d: Date; declare const buf: ArrayBuffer; declare const f: (x: number) => number; declare const maybe: Uint8Array | null;",
      "declare const n: number; declare const rec: { length: number; then: number }; declare const loose: any;",
      "export const ok = [bytes[0], list[1], list.length, ro.length, ro[0], s.length, s[0], f(1), rec.length, rec.then];",
      "export const a = bytes.length;",
      "export const b = list.push(1);",
      "export const c = s.slice(1);",
      "export const e = p.then(() => 1);",
      "export const g = m.get(\"k\");",
      "export const h = st.has(\"x\");",
      "export const i = re.test(\"x\");",
      "export const j = d.getTime();",
      "export const k = buf.byteLength;",
      "export const l = f.call(null, 1);",
      "export const o = maybe!.byteOffset;",
      "export const q = bytes[\"length\"];",
      "export const r = n.toString();",
      "export const t = ro.map((x) => x);",
      "export const u = loose.length;",
    ].join("\n");
    const found = builtinReads(programOf(fileName, text), fileName).map((line) => line.split(" ").slice(0, 1).join(""));
    expect(found).toEqual([
      "builtin-reads-fixture.ts:6",
      "builtin-reads-fixture.ts:7",
      "builtin-reads-fixture.ts:8",
      "builtin-reads-fixture.ts:9",
      "builtin-reads-fixture.ts:10",
      "builtin-reads-fixture.ts:11",
      "builtin-reads-fixture.ts:12",
      "builtin-reads-fixture.ts:13",
      "builtin-reads-fixture.ts:14",
      "builtin-reads-fixture.ts:15",
      "builtin-reads-fixture.ts:16",
      "builtin-reads-fixture.ts:17",
      "builtin-reads-fixture.ts:18",
      "builtin-reads-fixture.ts:19",
      "builtin-reads-fixture.ts:20",
    ]);
  }, 60_000);

  it("nor do the modules admission calls on its trusted path: the levels, binding, plain-data copies, governance, canonicalize and isFabricated", () => {
    const evidence = (rel: string) => join(SPEC_DIR, "src", "evidence", rel);
    const util = (rel: string) => join(SPEC_DIR, "src", "util", rel);
    const targets: Array<[string, ReadonlySet<string> | undefined]> = [
      [evidence("evidence-level.ts"), undefined],
      [evidence("subject-binding.ts"), undefined],
      [evidence("measurement-profile.ts"), undefined],
      [util("plain-data.ts"), undefined],
      // Admission calls only these functions of their files (sha256 and hashBundle use crypto.subtle; it does not).
      [util("canonical.ts"), new Set(["canonicalize"])],
      [evidence("is-fabricated.ts"), new Set(["isFabricated"])],
    ];
    const program = ts.createProgram(targets.map(([file]) => file), compilerOptions());
    const found: string[] = [];
    for (const [file, functions] of targets) found.push(...builtinReads(program, file, functions));
    expect(found).toEqual([]);
    // The scoping is real: the rest of canonical.ts does read built-ins.
    expect(builtinReads(program, util("canonical.ts")).length).toBeGreaterThan(0);
  }, 60_000);

  it("profile-admission.ts has none", () => {
    const program = ts.createProgram([ADMISSION], compilerOptions());
    // Every import resolves and every type is known, so no receiver is silently `any` (which the check would pass).
    expect(program.getSemanticDiagnostics(program.getSourceFile(ADMISSION)).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))).toEqual([]);
    expect(builtinReads(program, ADMISSION)).toEqual([]);
  }, 60_000);
});
