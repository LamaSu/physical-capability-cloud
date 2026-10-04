/**
 * profile-admission.ts, and the functions it calls on its trusted path, pass the DEFAULT-DENY check in
 * builtin-reads-check.ts (steward DECISIONS 01:30 and #6792, astra packs 289, 291): every node that
 * runs after load is one of the forms the check names, under that form's condition, or it fails.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { charAt, hasOwn, listAt } from "../util/primordials.js";
import { builtinReads, compilerOptions, programOf, type CheckOptions } from "./builtin-reads-check.js";

const SPEC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADMISSION = join(SPEC_DIR, "src", "evidence", "profile-admission.ts");
const OPTIONS: CheckOptions = {
  primordials: /[\\/]src[\\/]util[\\/](primordials|plain-data)\.ts$/,
  // awaitedHere pins a promise's constructor; legAnswer answers a boolean or an ownPromise (util/primordials.ts).
  awaitWrappers: new Set(["awaitedHere", "legAnswer"]),
};

describe("profile-admission.ts passes the default-deny check (DECISIONS 01:30, steward #6792, astra packs 289, 291)", () => {
  it("allows exactly the forms it names, and refuses every other form, astra pack 291's included (a self-test)", () => {
    const fileName = join(SPEC_DIR, "src", "__tests__", "builtin-reads-fixture.ts");
    const head = [
      "import { hasOwn, ObjectCreate, awaitedHere, charAt } from \"../util/primordials.js\";",
      "import * as nc from \"node:crypto\";",
      "import { verify } from \"node:crypto\";",
      "declare const bytes: Uint8Array; declare const list: number[]; declare const ro: readonly string[]; declare const s: string;",
      "declare const p: Promise<number>; declare const m: Map<string, number>; declare const f: (x: number) => number;",
      "declare const n: number; declare const rec: { length: number; then: number; inner: { x: number } }; declare const loose: any;",
      "declare const maybe: Uint8Array | null; declare const o: { toString(): string }; declare function shrink(): boolean; let t = \"abc\"; const resetT = () => { t = \"\"; };",
      "class Derived extends Uint8Array {} declare const derived: Derived; declare const both: Uint8Array & { tag: 1 };",
      "const capturedVerify = verify; const capturedGet = Map.prototype.get; const capturedNs = nc.hash; const capturedLater = (() => verify)();",
      "const Uint8ArrayCtor = Uint8Array;",
    ];
    const allowed = [
      "export function okTyped(i: number) { const out = new Uint8ArrayCtor(4); out[i] = bytes[i]! + bytes[99]! + derived[0]!; return out; }",
      "export function okLength() { return list.length + ro.length + s.length + rec.length + rec.then + rec.inner.x; }",
      "export function okOwn(i: number) { if (hasOwn(list, i)) return list[i]; return i > 0 && hasOwn(ro, i) ? ro[i] : undefined; }",
      "export function okGuards(k: string, r: Record<string, number>, i: number) { const a = hasOwn(r, k) && r[k]! > 0; if (hasOwn(list, i)) { const first = list[i]; return a ? first : 0; } return hasOwn(r, k) ? (r as Record<string, number>)[k] : 0; }",
      "export function okWrites() { const stack = [1, 2]; stack.length = stack.length - 1; return (f as (x: number) => number)(stack.length); }",
      "export function okString() { let out = \"\"; for (let i = 0; i < s.length; i++) out += charAt(s, i); return out; }",
      "export function okRecord(k: string) { const r = ObjectCreate(null) as Record<string, number>; r[k] = 1; r.x = 2; return r[k]! + r.x!; }",
      "export function okCalls() { return f(1) + (undefined === undefined ? NaN : Infinity); }",
      "export async function okAwait() { return await awaitedHere(p); }",
      "export function okOps(a: number, b: string) { let c = a; c += 1; c++; return `${a}${b}` + (a < c ? -a : ~a) + (typeof b === \"string\" ? 1 : 0); }",
      "export function okLiterals() { return { a: 1, [\"b\"]: 2, c: [1, 2, 3], d() { return 1; } }; }",
      "export function okControl(x: number) { try { switch (x) { case 1: return 1; default: break; } } catch { return 0; } finally { x = 0; } while (x < 1) x++; do { x--; } while (x > 0); return x; }",
    ];
    const refused = [
      "export function a() { return bytes.length; }",
      "export const b = () => list.push(1);",
      "export function c() { return s.slice(1); }",
      "export function e() { return p.then(() => 1); }",
      "export function g() { return m.get(\"k\"); }",
      "export function h() { return f.call(null, 1); }",
      "export function i() { return maybe!.byteOffset; }",
      "export function j() { return bytes[\"length\"]; }",
      "export function k() { return n.toString(); }",
      "export function l() { return loose.length; }",
      // astra pack 291:
      "export function hole() { const holes: number[] = []; holes.length = 1; return holes[0]; }",
      "export function outOfRange() { return s[99]; }",
      "export function unbounded(i: number) { return list[i]; }",
      "export function stringStep() { let out = 0; for (let i = 0; i < s.length; i += 2) out += s[i]!.length; return out; }",
      "export function destructure() { const { byteLength } = bytes; return byteLength; }",
      "export function inOperator() { return \"length\" in bytes; }",
      "export function subclass() { return derived.byteLength; }",
      "export function intersection() { return both.byteLength; }",
      "export function constrained<T extends Uint8Array>(t: T) { return t.byteOffset; }",
      "export function namespaceRead() { return nc[\"verify\"]; }",
      "export function namespaceDot() { return nc.verify; }",
      "export function liveBinding() { return verify; }",
      "export function global() { return JSON; }",
      // default-deny: forms nobody listed fail closed.
      "export function forIn(x: object) { for (const key in x) return key; return null; }",
      "export function forOf() { for (const x of list) return x; return 0; }",
      "export function spread() { return [...list]; }",
      "export function arrayPattern() { const [first] = list; return first; }",
      "export function objectSpread() { return { ...rec }; }",
      "export function instanceOf(x: unknown) { return x instanceof Uint8Array; }",
      "export function looseEquality(x: unknown) { return x == null; }",
      "export function deleteMember(r: Record<string, number>) { return delete r.x; }",
      "export function regex() { return /a/; }",
      "export function tagged() { return f`x`; }",
      "export function templateObject() { return `${o}`; }",
      "export function plusObject() { return \"\" + o; }",
      "export function unpinnedAwait() { return (async () => await p)(); }",
      "export function guardWrongIndex(i: number, j: number) { if (hasOwn(list, i)) return list[j]; return 0; }",
      "export function lookAlike(i: number) { const hasOwn = (_l: unknown, _i: number) => true; if (hasOwn(list, i)) return list[i]; return 0; }",
      "export function inheritedWrite(r: { x: number }) { r.x = 1; return r; }",
      "export function recordRead(r: Record<string, number>, k: string) { return r[k]; }",
      "export const notCalledAtLoad = () => verify;",
      "export function memberCall(r: { go(): number }) { return r.go(); }",
      "export function classExpression() { return class {}; }",
      // A call between the check and the read could remove the element, so the read is not proven own.
      "export function mutatedBetween(i: number) { return hasOwn(list, i) && shrink() ? list[i] : 0; }",
      "export function mutatedInBranch(i: number) { if (hasOwn(list, i)) { shrink(); return list[i]; } return 0; }",
      "export function guardWrongReceiver(i: number) { return hasOwn(list, i) ? ro[i] : undefined; }",
      "export function lengthOfRecord(r: { length: number }) { r.length = 0; return r; }",
      "export function lengthFromObject() { const stack = [1]; stack.length = loose; return stack; }",
      "export function objectKey() { const r = ObjectCreate(null) as Record<string, number>; return r[loose]; }",
      "export function lookAlikeCreate(k: string) { const ObjectCreate = (_p: null) => ({}) as Record<string, number>; const r = ObjectCreate(null); return r[k]; }",
      // astra pack 293: a loop bound proves nothing at the read (a shadowed string or index, or a call that
      // reassigns the string), so a string's element is read only through charAt, even in a canonical loop.
      "export function canonicalLoop() { let out = 0; for (let i = 0; i < s.length; i++) out += s[i]!.length; return out; }",
      "export function shadowedRange() { for (let i = 0; i < s.length; i++) { const s = \"\"; return s[i]; } return \"\"; }",
      "export function shadowedIndex() { for (let i = 0; i < s.length; i++) { const i = 99; return s[i]; } return \"\"; }",
      "export function reassignedByCall() { for (let i = 0; i < t.length; i++) { resetT(); return t[i]; } return \"\"; }",
    ];
    const text = [...head, ...allowed, ...refused].join("\n");
    const lines = builtinReads(programOf(SPEC_DIR, fileName, text), fileName, OPTIONS);
    const reported = new Set(lines.map((line) => Number(line.split(" ")[0]!.split(":")[1])));
    const firstAllowed = head.length + 1;
    const firstRefused = head.length + allowed.length + 1;
    // Every misclassified line at once, so a failure (or a mutation run) names all of them.
    const wrong: string[] = [];
    for (let k = 0; k < head.length; k++) if (reported.has(k + 1)) wrong.push(`a load-time line was reported: ${head[k]}`);
    for (let k = 0; k < allowed.length; k++) {
      if (reported.has(firstAllowed + k)) wrong.push(`allowed line reported: ${allowed[k]} => ${lines.filter((l) => l.includes(`:${firstAllowed + k} `)).join("; ")}`);
    }
    for (let k = 0; k < refused.length; k++) if (!reported.has(firstRefused + k)) wrong.push(`refused line not reported: ${refused[k]}`);
    expect(wrong).toEqual([]);
  }, 60_000);

  it("the forms it refuses do read a prototype, and the helpers it requires do not (astra pack 291's controls)", () => {
    const written: Array<[object, string]> = [];
    let seen: unknown[] = [];
    try {
      Object.defineProperty(Array.prototype, "0", { value: "from Array.prototype", writable: true, configurable: true, enumerable: false });
      written.push([Array.prototype, "0"]);
      Object.defineProperty(String.prototype, "5", { value: "from String.prototype", writable: true, configurable: true, enumerable: false });
      written.push([String.prototype, "5"]);
      const holes: unknown[] = new Array(1);
      const text: string = "ab";
      // Read while the prototypes are written; compared after they are restored, so nothing else sees them.
      seen = [holes[0], text[5], listAt(holes, 0), hasOwn(holes, 0), charAt(text, 5)];
    } finally {
      for (const [target, key] of written) delete (target as Record<string, unknown>)[key];
    }
    // A hole and an out-of-range index continue to the prototype (the refused `hole` and `outOfRange` forms)...
    expect(seen.slice(0, 2)).toEqual(["from Array.prototype", "from String.prototype"]);
    // ...and the forms the check takes instead stop at the value's own data.
    expect(seen.slice(2)).toEqual([undefined, false, ""]);
    expect(Object.prototype.hasOwnProperty.call(Array.prototype, "0") || Object.prototype.hasOwnProperty.call(String.prototype, "5")).toBe(false);
  });

  it("so do the modules admission calls on its trusted path: the levels, binding, plain-data copies, governance, canonicalize and isFabricated", () => {
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
    const program = ts.createProgram(targets.map(([file]) => file), compilerOptions(SPEC_DIR));
    const found: string[] = [];
    for (const [file, functions] of targets) found.push(...builtinReads(program, file, OPTIONS, functions));
    expect(found).toEqual([]);
    // The scoping is real: the rest of canonical.ts does read built-ins.
    expect(builtinReads(program, util("canonical.ts"), OPTIONS).length).toBeGreaterThan(0);
  }, 60_000);

  it("profile-admission.ts has none", () => {
    const program = ts.createProgram([ADMISSION], compilerOptions(SPEC_DIR));
    // Every import resolves and every type is known, so no receiver is silently `any` (which the check refuses anyway).
    expect(program.getSemanticDiagnostics(program.getSourceFile(ADMISSION)).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))).toEqual([]);
    expect(builtinReads(program, ADMISSION, OPTIONS)).toEqual([]);
  }, 60_000);
});
