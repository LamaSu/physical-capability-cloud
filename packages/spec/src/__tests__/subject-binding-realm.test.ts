/**
 * LO-EV-9 under a hostile realm: nothing replaced AFTER @pcc/spec loads changes
 * what verifyEvidenceSubjectBinding answers (sensors' residual, bus #5381; the
 * class astra found in #336's packs 162-170 and #361's E7c).
 *
 * Every patch below replaces an intrinsic the binding leg used to reach, or
 * could reach, at call time: sort, map, join, the iterator protocol, JSON.parse,
 * Object.prototype.then, Promise.prototype.then, RegExp, crypto.subtle and the
 * rest. Each case is verified while the patch is in place (the binding runs to
 * its answer synchronously, with no await inside), the patch is removed, and
 * then the answers are compared with the unpatched baseline. A source scan pins
 * the property structurally: subject-binding.ts calls no method looked up at
 * call time, uses no iterator protocol and no RegExp.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  verifyEvidenceSubjectBinding,
  type EvidenceSubjectBindingInput,
  type EvidenceSubjectBindingResult,
} from "../evidence/subject-binding.js";
import { hashBundle, hashEvent } from "../util/canonical.js";
import type { EvidenceEvent } from "../types/evidence.js";

const JOB_A = "job-realm-a";
const JOB_B = "job-realm-b";
const NODE = "kernel-realm";
const OUTPUT = "sha256:" + "5e".repeat(32);
const U3 = "0x" + "03".repeat(32);
const U4 = "0x" + "04".repeat(32);
const N3 = "0x" + "a3".repeat(32);
const N4 = "0x" + "a4".repeat(32);

type RawEvent = Omit<EvidenceEvent, "id" | "hash">;

async function seal(raw: RawEvent[]): Promise<EvidenceEvent[]> {
  return Promise.all(raw.map(async (e, i) => ({ ...e, id: `ev-${i}`, hash: await hashEvent(e) })));
}

async function bundleFor(jobId: string, unit?: { settlementUnitId: string; challengeNonce: string }) {
  const source = { deviceId: NODE, deviceType: "digital_agent" as const, kernelId: NODE };
  const events = await seal([
    { type: "gcode_hash_verified", timestamp: "2026-09-24T10:00:00.000Z", source, payload: { jobId, kernelId: NODE, ...unit } },
    { type: "execution_started", timestamp: "2026-09-24T10:00:01.000Z", source, payload: { jobId, kernelId: NODE, stepCount: 2, ...unit } },
    { type: "execution_completed", timestamp: "2026-09-24T10:00:05.000Z", source, payload: { jobId, kernelId: NODE, outputHash: OUTPUT, ...unit } },
  ]);
  return { events, bundleHash: await hashBundle(events) };
}

let CASES: Array<[string, EvidenceSubjectBindingInput]> = [];
let BASELINE: EvidenceSubjectBindingResult[] = [];
let A_SORTED_HASHES: string[] = [];

beforeAll(async () => {
  const A = await bundleFor(JOB_A);
  const B = await bundleFor(JOB_B);
  const M3 = await bundleFor(JOB_A, { settlementUnitId: U3, challengeNonce: N3 });
  A_SORTED_HASHES = A.events.map((e) => e.hash).sort();
  // Job A's events relabelled to job B and re-hashed: they open B's own digest, never A's.
  const relabelled = await seal(
    A.events.map(({ type, timestamp, source, payload }) => ({ type, timestamp, source, payload: { ...payload, jobId: JOB_B } })),
  );
  const subjectA = { jobId: JOB_A, kernelId: NODE };
  CASES = [
    ["honest", { ...A, subject: subjectA }],
    ["honest, events reversed (hashBundle sorts)", { bundleHash: A.bundleHash, events: [...A.events].reverse(), subject: subjectA }],
    ["honest, output named", { ...A, subject: { ...subjectA, outputHash: OUTPUT } }],
    ["job A's evidence for job B", { ...A, subject: { jobId: JOB_B, kernelId: NODE } }],
    ["relabelled to B and re-hashed, under A's digest", { bundleHash: A.bundleHash, events: relabelled, subject: { jobId: JOB_B, kernelId: NODE } }],
    ["B's content carrying A's event hashes", { bundleHash: A.bundleHash, events: B.events.map((e, i) => ({ ...e, hash: A.events[i]!.hash })), subject: { jobId: JOB_B, kernelId: NODE } }],
    ["U3/N3 evidence at the legacy subject (E11 F1)", { ...M3, subject: subjectA }],
    ["U3/N3 evidence for unit U4/N4", { ...M3, subject: { ...subjectA, settlementUnitId: U4, challengeNonce: N4 } }],
    ["U3/N3 evidence for its own unit", { ...M3, subject: { ...subjectA, settlementUnitId: U3, challengeNonce: N3 } }],
  ];
  BASELINE = [];
  for (const [, input] of CASES) BASELINE.push(await verifyEvidenceSubjectBinding(input));
});

/** What a result says, as plain JSON, so the baseline and a patched run compare by value. */
const asJson = (r: EvidenceSubjectBindingResult) => JSON.parse(JSON.stringify(r)) as unknown;

it("the baseline is what LO-EV-9 says", () => {
  expect(BASELINE.map((r) => (r.ok ? "ok" : `${r.reason}@${r.eventIndex ?? "-"}`))).toEqual([
    "ok",
    "ok",
    "ok",
    "job-mismatch@0",
    "bundle-hash-mismatch@-",
    "event-hash-mismatch@0",
    "unit-not-in-subject@0",
    "unit-mismatch@0",
    "ok",
  ]);
});

const ArrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]()) as object;
const SubtleCryptoPrototype = Object.getPrototypeOf(globalThis.crypto.subtle) as object;
const forgedOk = { ok: true, events: [] };

const PATCHES: Array<[string, object, PropertyKey, unknown]> = [
  ["Array.prototype.sort (identity)", Array.prototype, "sort", function (this: unknown[]) { return this; }],
  ["Array.prototype.sort (answers job A's signed hashes)", Array.prototype, "sort", () => A_SORTED_HASHES.slice()],
  ["Array.prototype.map", Array.prototype, "map", () => []],
  ["Array.prototype.join", Array.prototype, "join", () => ""],
  ["Array.prototype.filter", Array.prototype, "filter", () => []],
  ["Array.prototype.some", Array.prototype, "some", () => false],
  ["Array.prototype.every", Array.prototype, "every", () => true],
  ["Array.prototype[Symbol.iterator]", Array.prototype, Symbol.iterator, function* () {}],
  ["%ArrayIteratorPrototype%.next", ArrayIteratorPrototype, "next", () => ({ done: true, value: undefined })],
  ["Array.isArray (false)", Array, "isArray", () => false],
  ["Array.isArray (true)", Array, "isArray", () => true],
  ["Array.from", Array, "from", () => []],
  ["Object.keys", Object, "keys", () => []],
  ["Object.getOwnPropertyDescriptor", Object, "getOwnPropertyDescriptor", () => undefined],
  ["Object.getPrototypeOf", Object, "getPrototypeOf", () => null],
  ["Object.create", Object, "create", () => ({})],
  ["Object.freeze", Object, "freeze", (o: unknown) => o],
  ["Object.is", Object, "is", () => true],
  ["Object.prototype.hasOwnProperty", Object.prototype, "hasOwnProperty", () => true],
  ["Reflect.apply", Reflect, "apply", () => true],
  ["Function.prototype.call", Function.prototype, "call", () => undefined],
  ["JSON.stringify", JSON, "stringify", () => '"x"'],
  ["JSON.parse (a passing snapshot)", JSON, "parse", () => ({ type: "x", payload: { jobId: JOB_B, kernelId: NODE }, source: { kernelId: NODE } })],
  ["String", globalThis, "String", () => "x"],
  ["String.prototype.charCodeAt", String.prototype, "charCodeAt", () => 0x61],
  ["RegExp.prototype.test", RegExp.prototype, "test", () => true],
  ["RegExp.prototype.exec", RegExp.prototype, "exec", () => null],
  ["Number.isFinite", Number, "isFinite", () => false],
  ["Promise.prototype.then (forges ok)", Promise.prototype, "then", function (onFulfilled: (v: unknown) => unknown) { return onFulfilled(forgedOk); }],
  ["Promise.prototype.constructor", Promise.prototype, "constructor", function () {}],
  ["Object.prototype.then (turns a refusal into ok)", Object.prototype, "then", function (resolve: (v: unknown) => void) { resolve(forgedOk); }],
  ["SubtleCrypto.prototype.digest", SubtleCryptoPrototype, "digest", async () => new ArrayBuffer(32)],
  ["TextEncoder.prototype.encode", TextEncoder.prototype, "encode", () => new Uint8Array(0)],
];

describe("after load, a replaced intrinsic changes no answer of the binding leg", () => {
  for (const [label, target, key, replacement] of PATCHES) {
    it(label, async () => {
      const original = Reflect.getOwnPropertyDescriptor(target, key);
      const patched: PropertyDescriptor = original
        ? { ...original, value: replacement }
        : { value: replacement, writable: true, configurable: true, enumerable: false };
      const pending: Array<Promise<EvidenceSubjectBindingResult>> = [];
      Reflect.defineProperty(target, key, patched);
      try {
        // By index: the test itself must not use what it has replaced.
        for (let i = 0; i < CASES.length; i++) pending[i] = verifyEvidenceSubjectBinding(CASES[i]![1]);
      } finally {
        if (original) Reflect.defineProperty(target, key, original);
        else Reflect.deleteProperty(target, key);
      }
      const answers = await Promise.all(pending);
      for (let i = 0; i < CASES.length; i++) {
        expect(asJson(answers[i]!), `${label}: ${CASES[i]![0]}`).toEqual(asJson(BASELINE[i]!));
        expect(Object.isFrozen(answers[i]!), `${label}: ${CASES[i]![0]} result frozen`).toBe(true);
      }
    });
  }
});

describe("source scan: subject-binding.ts calls only what was captured at load", () => {
  /** The code with comments, strings and template literals blanked. */
  function codeOnly(source: string): string {
    let out = "";
    let i = 0;
    while (i < source.length) {
      const c = source[i]!;
      const next = source[i + 1];
      if (c === "/" && next === "*") {
        const end = source.indexOf("*/", i + 2);
        i = end < 0 ? source.length : end + 2;
        out += " ";
      } else if (c === "/" && next === "/") {
        const end = source.indexOf("\n", i);
        i = end < 0 ? source.length : end;
      } else if (c === '"' || c === "'" || c === "`") {
        let j = i + 1;
        while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
        i = j + 1;
        out += '""';
      } else {
        out += c;
        i++;
      }
    }
    return out;
  }

  const AMBIENT: Array<[RegExp, string]> = [
    [/\b(Object|Array|Number|Reflect|JSON|Symbol|Math|String|Date|Set|Map|Promise|crypto)\s*\./, "a member of an ambient global"],
    [/\bfor\s*\([^)]*\bof\b/, "for...of (the iterator protocol)"],
    [/\[\s*\.\.\./, "array spread (the iterator protocol)"],
    [/\bnew\s+(Set|Map|WeakSet|WeakMap|Array|Promise|TextEncoder)\b/, "an ambient constructor"],
    [/\binstanceof\b/, "instanceof"],
    [/\bawait\b/, "an await (a thenable lookup at call time)"],
    [/\.(map|filter|forEach|some|every|includes|indexOf|join|push|pop|shift|unshift|splice|sort|reverse|concat|slice|split|reduce|entries|values|keys|trim|test|exec|has|add|delete|get|set|call|apply|bind|then|catch|finally)\(/, "a method looked up at call time"],
    [/\b(String|Number|Boolean)\s*\(/, "an ambient conversion function"],
    [/\bRegExp\b/, "a RegExp"],
    [/(^|[=(,:!&|?;{}[<>+\-*%~^]|\breturn|\btypeof)\s*\/(?![/*])/, "a regex literal"],
  ];

  it("no ambient method, iterator, RegExp or await outside the load-time captures", () => {
    const source = readFileSync(fileURLToPath(new URL("../evidence/subject-binding.ts", import.meta.url)), "utf8");
    // The two captures that run once, at load: charCodeAt, and node:crypto's Hash methods.
    const atLoad = (line: string) => /^const StringCharCodeAt = uncurryThis\(String\.prototype\.charCodeAt\)/.test(line.trim());
    const found: string[] = [];
    codeOnly(source)
      .split("\n")
      .forEach((line, n) => {
        if (atLoad(line)) return;
        for (const [pattern, what] of AMBIENT) if (pattern.test(line)) found.push(`subject-binding.ts:${n + 1} ${what}: ${line.trim()}`);
      });
    expect(found).toEqual([]);
  });
});
