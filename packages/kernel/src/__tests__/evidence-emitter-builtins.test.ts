/**
 * The emitter's trusted path passes the DEFAULT-DENY check in builtin-reads-check.ts (steward
 * DECISIONS 01:30, #6668, #6792 and 04:06; astra packs 289, 291, 293, 299 and 303): every node that
 * runs after load is one of the forms the check names, under that form's condition, or it fails.
 *
 * The path is COMPUTED (DECISIONS 04:06): evidence-emitter.ts, and every in-repo function it can
 * reach through a call or a function value, @pcc/spec's included (kernelPullCaptureIssue decides
 * whether camera evidence counts: astra pack 299's HIGH). A call whose target the check cannot see,
 * a function value supplied at run time or third-party code, fails closed unless its call site is a
 * named collaborator, with its reason; so does a declaration the closure reaches but does not enter
 * (astra pack 303). The list is closed: an entry that is unexplained, stale or ambiguous fails.
 *
 * The check is a copy of @pcc/spec's (#519); this file's self-tests run the same fixture lines and
 * closure fixtures through the copy, so the two cannot drift apart unnoticed. (The runtime control,
 * that a hole and an index past the end do read a written prototype while an own-data helper does
 * not, is in @pcc/spec's profile-admission-builtins.test.ts.)
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { builtinReads, closureReads, compilerOptions, programOf, programOfFiles, type CheckOptions } from "./builtin-reads-check.js";

const KERNEL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(KERNEL_DIR, "..", "..");
const EMITTER = join(KERNEL_DIR, "src", "evidence-emitter.ts");
/** The repository's own source: what the closure enters (not node_modules, the default library or a declaration file). */
const inRepo = (fileName: string): boolean =>
  fileName.startsWith(join(REPO, "packages")) && !/[\\/]node_modules[\\/]/.test(fileName) && !fileName.endsWith(".d.ts");
/** @pcc/spec resolved to its source, so the closure can enter it (its package exports point at dist); the program spans both packages. */
const SPEC_SOURCE: ts.CompilerOptions = {
  rootDir: REPO,
  baseUrl: REPO,
  paths: { "@pcc/spec": ["packages/spec/src/index.ts"], "@pcc/spec/*": ["packages/spec/src/*"] },
};
const EMITTER_FILE = "packages/kernel/src/evidence-emitter.ts";
/**
 * The emitter's collaborators, each with its reason. Closed: an entry that matches no declaration
 * or call site, or several, or gives no reason, fails the check.
 */
const COLLABORATORS = new Map([
  // Declarations the closure reaches but does not enter: setStorageService binds them as the storage collaborator.
  [
    "packages/kernel/src/evidence-storage.ts:EvidenceStorageService.isReady",
    "the storage collaborator setStorageService takes in: asked only whether to archive a bundle already hashed and signed",
  ],
  [
    "packages/kernel/src/evidence-storage.ts:EvidenceStorageService.archiveBundle",
    "the storage collaborator: handed the signed bundle after hashing and signing; nothing it returns reaches a stored event, a hash or a signature (astra pack 299, answer 1)",
  ],
  // Call sites whose target is supplied at run time, or is third-party code.
  [
    `${EMITTER_FILE}:EvidenceEmitter.constructor:this.#warn()`,
    "the console's warn, bound when this emitter was built, as the constructor takes its other collaborators: it only prints the test-only signer's warning",
  ],
  [
    `${EMITTER_FILE}:signature:this.#signFn()`,
    "the signer the emitter was built with (the constructor's signFn, or the test-only default): it signs the bundle hash after hashing, and its answer is the bundle's signature, which verification checks against that hash",
  ],
  [
    `${EMITTER_FILE}:EvidenceEmitter.#finalizeBundle:this.#storageIsReady()`,
    "the storage collaborator's isReady, bound in setStorageService: asked only whether to archive a bundle already hashed and signed",
  ],
  [
    `${EMITTER_FILE}:ipfsResult:this.#storageArchive()`,
    "the storage collaborator's archiveBundle, bound in setStorageService: handed the signed bundle after hashing and signing; what it returns is kept only as the last archive result",
  ],
  [
    `${EMITTER_FILE}:ipfsResult:SentryStartSpan()`,
    "@sentry/node's startSpan, captured at load: third-party telemetry wrapped around the archive call, after hashing and signing; its answer is kept only as the last archive result",
  ],
  [
    `${EMITTER_FILE}:EvidenceEmitter.#finalizeBundle:listener()`,
    "an onBundle callback the emitter's owner registered: handed the finished, signed bundle; nothing it returns is used",
  ],
]);
const CLOSURE_OPTIONS: CheckOptions = {
  // The trusted hasOwn and ObjectCreate: the emitter's own, and @pcc/spec's (util/primordials.ts, util/plain-data.ts).
  primordials: /[\\/](kernel[\\/]src[\\/]evidence-emitter|spec[\\/]src[\\/]util[\\/](primordials|plain-data))\.ts$/,
  // pinned() gives a native promise the Promise captured at load as its own constructor (steward #6668).
  awaitWrappers: new Set(["pinned"]),
  root: REPO,
  collaborators: COLLABORATORS,
};

describe("the emitter's trusted path passes the default-deny check (DECISIONS 01:30 and 04:06, steward #6668 and #6792, astra packs 289, 291, 293, 299 and 303)", () => {
  it("allows exactly the forms it names, and refuses every other form (the self-test @pcc/spec runs, through this copy)", () => {
    const fileName = join(KERNEL_DIR, "src", "__tests__", "builtin-reads-fixture.ts");
    // @pcc/spec's fixture imports hasOwn, ObjectCreate, awaitedHere and charAt from its primordials; here the fixture
    // declares them itself, so the fixture file is the primordials file.
    const options: CheckOptions = {
      primordials: /[\\/]__tests__[\\/]builtin-reads-fixture\.ts$/,
      awaitWrappers: new Set(["awaitedHere"]),
      root: REPO,
      collaborators: new Map([["packages/kernel/src/__tests__/builtin-reads-fixture.ts:okNamedCollaborator:verify()", "the collaborator this self-test names"]]),
    };
    const head = [
      "const ObjectCreate = Object.create; const HasOwnProperty = Object.prototype.hasOwnProperty; const ReflectApply = Reflect.apply; const StringCharAt = String.prototype.charAt;",
      "function hasOwn(o: object, k: PropertyKey): boolean { return ReflectApply(HasOwnProperty, o, [k]) as boolean; } function awaitedHere<T>(p: Promise<T>): Promise<T> { return p; } function charAt(x: string, i: number): string { return ReflectApply(StringCharAt, x, [i]) as string; }",
      "import * as nc from \"node:crypto\";",
      "import { verify } from \"node:crypto\";",
      "declare const bytes: Uint8Array; declare const list: number[]; declare const ro: readonly string[]; declare const s: string;",
      "declare const p: Promise<number>; declare const m: Map<string, number>; function f(x: number): number { return x; } declare const g: () => number;",
      "declare const n: number; declare const rec: { length: number; then: number; inner: { x: number } }; declare const loose: any;",
      "declare const maybe: Uint8Array | null; declare const o: { toString(): string }; declare function shrink(): boolean; let t = \"abc\"; const resetT = () => { t = \"\"; };",
      "class Derived extends Uint8Array {} declare const derived: Derived; declare const both: Uint8Array & { tag: 1 }; function applyTwice(fn: (x: number) => number, x: number): number { return fn(fn(x)); }",
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
      // astra pack 303: a call through a parameter is seen when every caller passes code written in place.
      "export function okHigherOrder() { return applyTwice((x) => x + 1, 1); }",
      "export const okStaticField = class { static value = f(1); };",
      "export function okNamedCollaborator(input: { verify: () => boolean }) { const verify = input.verify; return verify(); }",
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
      // astra pack 303: a call whose target is supplied at run time fails closed, unless its call site is named.
      "export function callParam(cb: () => number) { return cb(); }",
      "export function callFromData(input: { fn: () => number }) { const fn = input.fn; return fn(); }",
      "export function callDeclared() { return g(); }",
      "export function callLet() { let k = f; k = f; return k(1); }",
      "export class Holder { #run: (x: number) => number = f; go() { return this.#run(1); } }",
      // astra pack 303: an instance field's initializer runs at `new`, after load, even in a class evaluated at load.
      "export const instanceField = class { value = JSON; };",
    ];
    const text = [...head, ...allowed, ...refused].join("\n");
    const lines = builtinReads(programOf(KERNEL_DIR, fileName, text), fileName, options);
    // A collaborator entry that is unexplained, stale or ambiguous is reported on its own line.
    expect(lines.filter((line) => line.startsWith("collaborator "))).toEqual([]);
    const reported = new Set(lines.map((line) => Number(line.split(" ")[0]!.split(":")[1])));
    const firstAllowed = head.length + 1;
    const firstRefused = head.length + allowed.length + 1;
    // Every misclassified line at once, so a failure (or a mutation run) names all of them.
    const wrong: string[] = [];
    for (let k = 0; k < head.length; k++) {
      if (reported.has(k + 1)) wrong.push(`a load-time line was reported: ${head[k]} => ${lines.filter((l) => l.includes(`:${k + 1} `)).join("; ")}`);
    }
    for (let k = 0; k < allowed.length; k++) {
      if (reported.has(firstAllowed + k)) wrong.push(`allowed line reported: ${allowed[k]} => ${lines.filter((l) => l.includes(`:${firstAllowed + k} `)).join("; ")}`);
    }
    for (let k = 0; k < refused.length; k++) if (!reported.has(firstRefused + k)) wrong.push(`refused line not reported: ${refused[k]}`);
    expect(wrong).toEqual([]);
  }, 60_000);

  it("the closure follows calls and stored functions across files, not an import alone, and stops at a named collaborator (a self-test)", () => {
    const dir = join(KERNEL_DIR, "src", "__tests__");
    const seed = join(dir, "closure-seed.ts");
    const lib = join(dir, "closure-lib.ts");
    const files = new Map([
      [
        seed,
        [
          "import { used, notCalled, viaValue, Store } from \"./closure-lib.js\";",
          "const table = [viaValue];",
          "export function entry() { return used(); }",
          "export function entry2() { return table; }",
          "export function entry3(s: Store) { return s.save; }",
          "export type Unused = typeof notCalled;",
        ].join("\n"),
      ],
      [
        lib,
        [
          "export function used() { return helper(); }",
          "function helper() { return JSON; }",
          "export function notCalled() { return Math; }",
          "export function viaValue() { return Reflect; }",
          "export class Store { save() { return Atomics; } }",
        ].join("\n"),
      ],
    ]);
    const options: CheckOptions = {
      primordials: /^$/,
      awaitWrappers: new Set(),
      root: dir,
      collaborators: new Map([["closure-lib.ts:Store.save", "the collaborator this self-test names"]]),
    };
    const { reached, found, collaboratorsUsed } = closureReads(programOfFiles(KERNEL_DIR, files), [seed], options, (fileName) => fileName.startsWith(dir));
    expect(reached).toEqual(expect.arrayContaining(["closure-seed.ts:(the whole file)", "closure-lib.ts:used", "closure-lib.ts:helper", "closure-lib.ts:viaValue"]));
    expect(reached).not.toContain("closure-lib.ts:notCalled");
    expect(reached).not.toContain("closure-lib.ts:Store.save");
    const lines = new Set(found.map((line) => line.split(" ")[0]));
    expect(lines.has("closure-lib.ts:2"), "helper, reached through used()").toBe(true);
    expect(lines.has("closure-lib.ts:4"), "viaValue, stored in a table at load and handed out later").toBe(true);
    expect(lines.has("closure-lib.ts:3"), "notCalled: imported, and named only in a type").toBe(false);
    expect(lines.has("closure-lib.ts:5"), "Store.save: the named collaborator").toBe(false);
    expect(collaboratorsUsed).toEqual(["closure-lib.ts:Store.save"]);
  }, 60_000);


  it("the closure fails closed on a call target it cannot see, runs an instance field after load, and holds collaborator entries exact (astra pack 303)", () => {
    const dir = join(KERNEL_DIR, "src", "__tests__");
    const seed = join(dir, "unseen-seed.ts");
    const files = new Map([
      [
        seed,
        [
          "import { run as runA } from \"./a/shared.js\";",
          "import { run as runB } from \"./b/shared.js\";",
          "export function callback(cb: () => unknown) { return cb(); }",
          "export function viaHelper() { return apply(() => 1); }",
          "function apply(fn: () => unknown) { return fn(); }",
          "export function fromData(input: { fn: () => number }) { const fn = input.fn; return fn() + fn(); }",
          "const C = class { value = JSON; static fixed = 1; };",
          "export function make() { return new C().value; }",
          "export function both() { return [runA(), runB()]; }",
        ].join("\n"),
      ],
      [join(dir, "a", "shared.ts"), "export function run() { return JSON; }"],
      [join(dir, "b", "shared.ts"), "export function run() { return Math; }"],
    ]);
    const options: CheckOptions = {
      primordials: /^$/,
      awaitWrappers: new Set(),
      root: dir,
      collaborators: new Map([
        ["a/shared.ts:run", "named by its path from the root"],
        ["b/shared.ts:run", ""],
        ["shared.ts:run", "a base name alone names no file"],
        ["unseen-seed.ts:fromData:fn()#1", "the first of two calls, named"],
      ]),
    };
    const { found, collaboratorsUsed } = closureReads(programOfFiles(KERNEL_DIR, files), [seed], options, (fileName) => fileName.startsWith(dir));
    const at = (where: string) => found.filter((line) => line.startsWith(`${where} `));
    expect(at("unseen-seed.ts:3"), "a caller's callback: supplied at run time").toHaveLength(1);
    expect(at("unseen-seed.ts:5"), "apply's fn: its one caller passes an arrow").toEqual([]);
    expect(at("unseen-seed.ts:6"), "the second call through data: not named").toHaveLength(1);
    expect(at("unseen-seed.ts:6")[0]).toContain("unseen-seed.ts:fromData:fn()#2");
    expect(at("unseen-seed.ts:7"), "the instance field's JSON runs at new; the static field runs at load").toHaveLength(1);
    expect(at("a/shared.ts:1"), "named: not entered").toEqual([]);
    expect(at("b/shared.ts:1"), "named (without a reason): not entered").toEqual([]);
    expect(found.filter((line) => line.startsWith("collaborator "))).toEqual([
      "collaborator b/shared.ts:run: no reason is given",
      "collaborator shared.ts:run: matches no declaration or call site (a stale entry)",
    ]);
    expect(collaboratorsUsed).toEqual(["a/shared.ts:run", "b/shared.ts:run", "unseen-seed.ts:fromData:fn()#1"]);
  }, 60_000);


  it("so does every in-repo function the emitter can reach, computed from the program: @pcc/spec's camera gate, canonical JSON and ids included (DECISIONS 04:06, astra packs 299 and 303)", () => {
    const program = ts.createProgram([EMITTER], { ...compilerOptions(KERNEL_DIR), ...SPEC_SOURCE });
    // Every import resolves and every type is known, so no receiver is silently `any` (which the check refuses anyway).
    expect(program.getSemanticDiagnostics(program.getSourceFile(EMITTER)).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))).toEqual([]);
    const { reached, found, collaboratorsUsed } = closureReads(program, [EMITTER], CLOSURE_OPTIONS, inRepo);
    // Not vacuous: the closure enters what decides camera evidence, what hashes and what names.
    for (const name of [
      "evidence/kernel-pull-capture.ts:kernelPullCaptureIssue",
      "evidence/kernel-pull-capture.ts:fieldIssue",
      "evidence/is-fabricated.ts:isFabricated",
      "util/canonical.ts:canonicalize",
      "util/ids.ts:generateId",
      "util/primordials.ts:sortedStrings",
      "util/primordials.ts:listAt",
    ]) {
      expect(reached, name).toContain(`packages/spec/src/${name}`);
    }
    expect(collaboratorsUsed).toEqual([...COLLABORATORS.keys()].sort());
    expect(found).toEqual([]);
  }, 120_000);
});
