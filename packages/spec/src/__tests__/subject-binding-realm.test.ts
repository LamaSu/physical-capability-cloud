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
let BUNDLE_A: Awaited<ReturnType<typeof bundleFor>>;
let BUNDLE_M3: Awaited<ReturnType<typeof bundleFor>>;
let RELABELLED: EvidenceEvent[] = [];

beforeAll(async () => {
  const A = await bundleFor(JOB_A);
  const B = await bundleFor(JOB_B);
  const M3 = await bundleFor(JOB_A, { settlementUnitId: U3, challengeNonce: N3 });
  A_SORTED_HASHES = A.events.map((e) => e.hash).sort();
  // Job A's events relabelled to job B and re-hashed: they open B's own digest, never A's.
  const relabelled = await seal(
    A.events.map(({ type, timestamp, source, payload }) => ({ type, timestamp, source, payload: { ...payload, jobId: JOB_B } })),
  );
  BUNDLE_A = A;
  BUNDLE_M3 = M3;
  RELABELLED = relabelled;
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
    // #438's step 10: the events are at 2026-09-24T10:00:00Z (1790244000) .. +5 s.
    ["a window that covers the events", { ...A, subject: { ...subjectA, eventTimeWindow: { notBefore: 1790244000, notAfter: 1790244005 } } }],
    ["a window that ends before them", { ...A, subject: { ...subjectA, eventTimeWindow: { notBefore: 1790200000, notAfter: 1790240000 } } }],
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
    "ok",
    "event-time-outside-window@0",
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
  ["Number.isSafeInteger", Number, "isSafeInteger", () => true],
  ["Number.isInteger", Number, "isInteger", () => true],
  ["Date.UTC", Date, "UTC", () => 0],
  ["Date.prototype.getUTCFullYear", Date.prototype, "getUTCFullYear", () => 1970],
  ["Math.floor", Math, "floor", () => 0],
  ["Number", globalThis, "Number", () => 0],
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

/** Hold `target[key] = replacement` until `run` settles, then restore it. */
async function holding<T>(target: object, key: PropertyKey, replacement: PropertyDescriptor, run: () => Promise<T>): Promise<T> {
  const original = Reflect.getOwnPropertyDescriptor(target, key);
  Reflect.defineProperty(target, key, { configurable: true, ...replacement });
  try {
    return await run();
  } finally {
    if (original) Reflect.defineProperty(target, key, original);
    else Reflect.deleteProperty(target, key);
  }
}

describe("sensors' recipes (bus #5381), each patch held until the answer settles", () => {
  // Each one forged an ok out of 51dbabd2's binding leg; the evidence is in the round-4 brief
  // (/mnt/sparkbulk/tmp/evidence-341-realm-repro-51dbabd2.txt). They are targeted, so the test
  // runner's own use of the patched intrinsic keeps working while the patch is held.
  const subjectB = { jobId: JOB_B, kernelId: NODE };

  it("Array.prototype.sort cannot swap job A's signed hashes in for re-hashed job B events", async () => {
    const sort = Array.prototype.sort;
    const r = await holding(Array.prototype, "sort", {
      writable: true,
      value: function (this: unknown[], ...args: unknown[]) {
        if (typeof this[0] === "string" && (this[0] as string).startsWith("sha256:")) return A_SORTED_HASHES.slice();
        return sort.apply(this, args as never);
      },
    }, () => verifyEvidenceSubjectBinding({ bundleHash: BUNDLE_A.bundleHash, events: RELABELLED, subject: subjectB }));
    expect(r).toEqual({ ok: false, reason: "bundle-hash-mismatch" });
  });

  it("JSON.parse cannot answer a snapshot that commits job B for job A's genuine events", async () => {
    const parse = JSON.parse;
    const r = await holding(JSON, "parse", {
      writable: true,
      value: (text: string) => {
        const o = parse(text) as { payload?: { jobId?: string } };
        if (o && o.payload && o.payload.jobId === JOB_A) o.payload.jobId = JOB_B;
        return o;
      },
    }, () => verifyEvidenceSubjectBinding({ ...BUNDLE_A, subject: subjectB }));
    expect(r).toEqual({ ok: false, reason: "job-mismatch", eventIndex: 0 });
  });

  it("Object.prototype.then cannot turn the refusal into ok", async () => {
    const forge = (resolve: (v: unknown) => void) => resolve({ ok: true, events: [] });
    const r = await holding(Object.prototype, "then", {
      get(this: { ok?: unknown; reason?: unknown }) {
        return this && this.ok === false && this.reason === "job-mismatch" ? forge : undefined;
      },
    }, () => verifyEvidenceSubjectBinding({ ...BUNDLE_A, subject: subjectB }));
    expect(r).toEqual({ ok: false, reason: "job-mismatch", eventIndex: 0 });
  });

  it("SubtleCrypto.prototype.digest cannot hash job B's relabelled content as job A's", async () => {
    const subtle = Object.getPrototypeOf(globalThis.crypto.subtle) as { digest: (a: string, d: BufferSource) => Promise<ArrayBuffer> };
    const digest = subtle.digest;
    const carrying = RELABELLED.map((e, i) => ({ ...e, hash: BUNDLE_A.events[i]!.hash }));
    const r = await holding(subtle, "digest", {
      writable: true,
      value: function (this: unknown, alg: string, data: Uint8Array) {
        return digest.call(this, alg, new TextEncoder().encode(new TextDecoder().decode(data).split(JOB_B).join(JOB_A)));
      },
    }, () => verifyEvidenceSubjectBinding({ bundleHash: BUNDLE_A.bundleHash, events: carrying, subject: subjectB }));
    expect(r).toEqual({ ok: false, reason: "event-hash-mismatch", eventIndex: 0 });
  });

  it("a replaced array iterator cannot skip the unit and challenge checks", async () => {
    // Every table of [field, ...] rows iterates as empty, the shape 51dbabd2's checks looped over.
    const iterate = Array.prototype[Symbol.iterator];
    const r = await holding(Array.prototype, Symbol.iterator, {
      writable: true,
      value: function (this: unknown[]) {
        const first = this[0] as unknown;
        if (Array.isArray(first) && typeof first[0] === "string") return iterate.call([]);
        return iterate.call(this);
      },
    }, () =>
      verifyEvidenceSubjectBinding({
        ...BUNDLE_M3,
        subject: { jobId: JOB_A, kernelId: NODE, settlementUnitId: U4, challengeNonce: N4 },
      }));
    expect(r).toEqual({ ok: false, reason: "unit-mismatch", eventIndex: 0 });
  });
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

  it("the time path in delegation-rules.ts (which the binding leg calls) has no ambient method, RegExp or Date either", () => {
    const source = readFileSync(fileURLToPath(new URL("../evidence/delegation-rules.ts", import.meta.url)), "utf8");
    const pieces = [
      [source.indexOf("function digitsAt("), source.indexOf("export type DelegationScopeRuleCode")],
      [source.indexOf("function ownData("), source.indexOf("/**", source.indexOf("function ownData("))],
      [source.indexOf("export function parseEvidenceTimeBound("), source.length],
    ];
    const found: string[] = [];
    for (const [from, to] of pieces) {
      expect(from).toBeGreaterThan(0);
      codeOnly(source.slice(from, to))
        .split("\n")
        .forEach((line, n) => {
          for (const [pattern, what] of [...AMBIENT, [/\bDate\b/, "Date"] as [RegExp, string]]) {
            if (pattern.test(line)) found.push(`delegation-rules.ts (from ${from}) +${n} ${what}: ${line.trim()}`);
          }
        });
    }
    expect(found).toEqual([]);
  });
});
