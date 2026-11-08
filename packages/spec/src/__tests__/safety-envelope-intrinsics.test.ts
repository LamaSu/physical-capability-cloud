/**
 * astra pack 164 (gpt-5.6-sol, R8 #465 @1938d971): compile called
 * Array.prototype.map after the registration was verified, so a map replaced
 * after load raised an emitted limit from the signed 40 to 400 (reproduced at
 * 1938d971: /mnt/sparkbulk/tmp/sensors/repro/repro-r8-164-at-1938d971.txt).
 *
 * The R8 modules now call only intrinsics primordials.ts captured at load.
 * These tests replace each intrinsic the modules could have used AFTER load,
 * and require draft, confirm and both compilers to produce exactly what they
 * produce untouched (or refuse); never a different value. A source scan keeps
 * any ambient call from coming back.
 */

import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseEd25519SignatureHex, signingPreimage } from "../evidence/signing-preimage.js";
import { compileOperationalEnvelope } from "../onboarding/operational-envelope.js";
import { canonicalJson, fixedHexBytes } from "../onboarding/primordials.js";
import {
  compileSafetyEnvelope,
  confirmSafetyEnvelope,
  draftSafetyEnvelope,
  EnvelopeRefused,
  registrationSigningPreimage,
  registrationStatementDigest,
  type ConfirmedSafetyEnvelope,
  type RegistrationVerifier,
  type SafetyEnvelopeInput,
  type SafetyEnvelopeRegistration,
} from "../onboarding/safety-envelope.js";
import { canonicalize } from "../util/canonical.js";

const MANIFEST = `sha256:${"ab".repeat(32)}`;
const REGISTRY = generateKeyPairSync("ed25519");
const verifyRegistry: RegistrationVerifier = (preimage, signature) => verify(null, preimage, REGISTRY.publicKey, signature);

function input(): SafetyEnvelopeInput {
  return {
    deviceClass: "lab-plate-reader",
    device: { deviceId: "pr-1", adapterType: "generic-http", adapterVersion: MANIFEST },
    commandMap: {
      commands: [
        { name: "setIncubation", params: [{ name: "celsius", quantity: "incubation_temperature", unit: "degC" }] },
        {
          name: "read",
          params: [
            { name: "seconds", quantity: "read_duration", unit: "s" },
            { name: "wells", unbounded: { reason: "plate wells", allowed: ["all"], allowedItems: ["A1", "A2", "H12"] } },
          ],
        },
        { name: "stop", params: [] },
      ],
    },
    intake: {
      limits: [
        { field: "safety.limits", quantity: "incubation_temperature", unit: "degC", min: 20, max: 40 },
        { field: "safety.limits", quantity: "read_duration", unit: "s", min: 1, max: 600 },
        { field: "safety.limits", quantity: "job_duration", unit: "min", min: 1, max: 120 },
      ],
      eStop: { mechanism: "adapter-stop", stopCommand: "stop" },
      supervision: "attended",
      hazards: ["heat"],
      maxCommandsPerMinute: 30,
    },
    references: [
      {
        quantity: "incubation_temperature",
        claim: "rated to 45 degC",
        value: { max: 45 },
        unit: "degC",
        citation: { doc: "Datasheet", section: "3" },
        retrievedAt: "2026-10-01",
      },
    ],
  };
}

const DECISION = { confirmedBy: "op-1", confirmedAt: "2026-10-02T20:00:00Z" };

function register(c: ConfirmedSafetyEnvelope): SafetyEnvelopeRegistration {
  const statement = { deviceId: c.envelope.device.deviceId, envelopeDigest: c.envelopeDigest, registeredAt: "2026-10-02T20:05:00Z" };
  return { ...statement, signature: Buffer.from(sign(null, registrationSigningPreimage(statement), REGISTRY.privateKey)).toString("hex") };
}

type Stage = "draft" | "confirmed" | "csd" | "runtime" | "refusals";

/**
 * Everything the module produces from one input, stage by stage; a stage that
 * throws records the error's name. Serialized only after every patch is
 * restored. The untouched run is the reference.
 */
/**
 * Digests that are well formed except for their digits, and a draft input that
 * carries one, built before any patch is applied (and before CLEAN): the
 * test's own code must not run a replaced intrinsic (astra pack 167).
 */
const NOT_HEX_MANIFEST = `sha256:${"z".repeat(64)}`;
const NOT_HEX_ENVELOPE_DIGEST = `0x${"z".repeat(64)}` as `0x${string}`;
const NOT_HEX_INPUT: SafetyEnvelopeInput = (() => {
  const given = input();
  return { ...given, device: { ...given.device, adapterVersion: NOT_HEX_MANIFEST } };
})();

function runStages(): Record<Stage, unknown> {
  const out = {} as Record<Stage, unknown>;
  const attempt = (stage: Stage, run: () => unknown) => {
    try {
      out[stage] = run();
    } catch (err) {
      out[stage] = { threw: err instanceof EnvelopeRefused ? "EnvelopeRefused" : "other", message: (err as Error)?.message };
    }
  };
  attempt("draft", () => draftSafetyEnvelope(input()));
  let confirmed: ConfirmedSafetyEnvelope | undefined;
  attempt("confirmed", () => (confirmed = confirmSafetyEnvelope(input(), DECISION)));
  const registration = confirmed ? register(confirmed) : undefined;
  attempt("csd", () => compileSafetyEnvelope(confirmed!, registration!, verifyRegistry));
  attempt("runtime", () => compileOperationalEnvelope(confirmed!, registration!, verifyRegistry));
  // Refusals too: a replacement that only shows on bad input (an always-true hasOwnProperty, a trim that
  // never blanks) must not turn a refusal into an acceptance or change its reason.
  const refusals: string[] = [];
  const refusal = (run: () => unknown) => {
    try {
      run();
      refusals.push("ACCEPTED");
    } catch (err) {
      refusals.push(err instanceof EnvelopeRefused ? (err as Error).message : "other error");
    }
  };
  refusal(() => draftSafetyEnvelope({ ...input(), deviceClass: "toString" }));
  refusal(() => confirmSafetyEnvelope(input(), { ...DECISION, confirmedBy: "  " }));
  refusal(() => confirmSafetyEnvelope(input(), { ...DECISION, edits: [{ quantity: "incubation_temperature", min: 20, max: 50 }] }));
  // Digests that are well formed except for their digits: a charCodeAt that reports every unit as "0" must not pass them (astra pack 167).
  refusal(() => draftSafetyEnvelope(NOT_HEX_INPUT));
  refusal(() => registrationSigningPreimage({ deviceId: "pr-1", envelopeDigest: NOT_HEX_ENVELOPE_DIGEST, registeredAt: "2026-10-03T00:05:00Z" }));
  if (confirmed && registration) {
    // structuredClone, not a JSON round trip: the test's own code must not run a replaced intrinsic either.
    const tampered = structuredClone(confirmed) as unknown as { envelope: { limits: Array<Record<string, unknown>> } };
    const limit = tampered.envelope.limits[0]!;
    const max = limit.max;
    Object.defineProperty(limit, "max", { enumerable: true, configurable: true, get: () => max });
    refusal(() => compileSafetyEnvelope(tampered as unknown as ConfirmedSafetyEnvelope, registration, verifyRegistry));
  }
  out.refusals = refusals;
  return out;
}

const CLEAN = (() => {
  const stages = runStages();
  return {
    draft: JSON.stringify(stages.draft),
    confirmed: JSON.stringify(stages.confirmed),
    csd: JSON.stringify(stages.csd),
    runtime: JSON.stringify(stages.runtime),
    refusals: JSON.stringify(stages.refusals),
  };
})();

const ownKeysAtLoad = Reflect.ownKeys;
const descriptorAtLoad = Reflect.getOwnPropertyDescriptor;

/**
 * A value with every writable `max: 40` and `max: 600` raised, as an attacker's
 * replacement would emit. Indexed loops and load-time Reflect only, so it
 * never runs a replaced intrinsic itself.
 */
function raise<T>(value: T, depth = 0): T {
  if (value !== null && typeof value === "object" && depth < 32) {
    const keys = ownKeysAtLoad(value);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const d = descriptorAtLoad(value, key);
      if (!d || d.get || d.set) continue;
      if (key === "max" && (d.value === 40 || d.value === 600) && d.writable) (value as Record<PropertyKey, unknown>)[key] = 4000;
      else raise(d.value, depth + 1);
    }
  }
  return value;
}

type Patch = [label: string, target: object, key: PropertyKey, replacement: (original: any) => unknown];

const ArrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]());
const HashPrototype = Object.getPrototypeOf(createHash("sha256"));

const PATCHES: Patch[] = [
  // astra's recipe first.
  ["Array.prototype.map (astra's recipe)", Array.prototype, "map", (o) => function (this: unknown[], ...a: unknown[]) { return raise(o.apply(this, a)); }],
  ["Array.prototype.filter", Array.prototype, "filter", (o) => function (this: unknown[], ...a: unknown[]) { return raise(o.apply(this, a)); }],
  ["Array.prototype.flatMap", Array.prototype, "flatMap", (o) => function (this: unknown[], ...a: unknown[]) { return raise(o.apply(this, a)); }],
  ["Array.prototype.forEach", Array.prototype, "forEach", (o) => function (this: unknown[], ...a: unknown[]) { raise(this); return o.apply(this, a); }],
  ["Array.prototype.some", Array.prototype, "some", () => () => false],
  ["Array.prototype.every", Array.prototype, "every", () => () => true],
  ["Array.prototype.includes", Array.prototype, "includes", () => () => true],
  ["Array.prototype.find", Array.prototype, "find", () => () => undefined],
  ["Array.prototype.join", Array.prototype, "join", () => () => ""],
  ["Array.prototype.push", Array.prototype, "push", (o) => function (this: unknown[], ...a: unknown[]) { return o.apply(this, raise(a)); }],
  ["Array.prototype.sort", Array.prototype, "sort", (o) => function (this: unknown[]) { return o.call(this).reverse(); }],
  ["Array.prototype.slice", Array.prototype, "slice", (o) => function (this: unknown[], ...a: unknown[]) { return raise(o.apply(this, a)); }],
  ["Array.prototype.concat", Array.prototype, "concat", (o) => function (this: unknown[], ...a: unknown[]) { return raise(o.apply(this, a)); }],
  ["Array.prototype[Symbol.iterator]", Array.prototype, Symbol.iterator, (o) => function (this: unknown[]) { raise(this); return o.call(this); }],
  ["%ArrayIteratorPrototype%.next", ArrayIteratorPrototype, "next", (o) => function (this: unknown) { return raise(o.call(this)); }],
  ["Object.keys", Object, "keys", (o) => (v: object) => (o(v) as string[]).reverse()],
  ["Object.assign", Object, "assign", (o) => (...a: unknown[]) => raise(o(...a))],
  ["Object.freeze", Object, "freeze", () => (v: unknown) => v],
  ["Object.isFrozen", Object, "isFrozen", () => () => true],
  ["Object.getOwnPropertyDescriptor", Object, "getOwnPropertyDescriptor", (o) => (v: object, k: PropertyKey) => raise(o(v, k))],
  ["Object.getPrototypeOf", Object, "getPrototypeOf", () => () => null],
  ["Object.defineProperty", Object, "defineProperty", (o) => (v: object, k: PropertyKey, d: PropertyDescriptor) => o(v, k, raise({ ...d }))],
  ["Object.create", Object, "create", (o) => (p: object | null) => o(p)],
  ["Object.is", Object, "is", () => () => false],
  ["Object.prototype.hasOwnProperty", Object.prototype, "hasOwnProperty", () => () => true],
  ["JSON.parse", JSON, "parse", (o) => (...a: unknown[]) => raise(o(...a))],
  ["JSON.stringify", JSON, "stringify", () => () => '"x"'],
  ["String.prototype.trim", String.prototype, "trim", () => () => "x"],
  ["String.prototype.toLowerCase", String.prototype, "toLowerCase", () => () => "x"],
  ["String.prototype.charCodeAt", String.prototype, "charCodeAt", () => () => 0x30],
  ["RegExp.prototype.exec", RegExp.prototype, "exec", () => () => null],
  ["RegExp.prototype.test", RegExp.prototype, "test", () => () => true],
  ["Number.isFinite", Number, "isFinite", () => () => true],
  ["Number.isInteger", Number, "isInteger", () => () => true],
  ["Date.parse", Date, "parse", () => () => Number.NaN],
  ["Math.max", Math, "max", () => () => 1e9],
  ["Math.min", Math, "min", () => () => -1e9],
  ["Set.prototype.has", Set.prototype, "has", () => () => true],
  ["Map.prototype.get", Map.prototype, "get", () => () => undefined],
  ["Function.prototype.call", Function.prototype, "call", (o) => function (this: Function, ...a: unknown[]) { return raise(o.apply(this, [a[0], ...a.slice(1)])); }],
  ["Function.prototype.apply", Function.prototype, "apply", (o) => function (this: Function, self: unknown, args: unknown[]) { return raise(o.call(this, self, args)); }],
  ["Hash.prototype.digest", HashPrototype, "digest", () => () => "0".repeat(64)],
  ["Hash.prototype.update", HashPrototype, "update", (o) => function (this: unknown) { return o.call(this, "tampered"); }],
  ["TextEncoder.prototype.encode", TextEncoder.prototype, "encode", () => () => new Uint8Array(71)],
];

function withPatch<T>(target: object, key: PropertyKey, replacement: unknown, run: () => T): T {
  const original = Reflect.getOwnPropertyDescriptor(target, key)!;
  Reflect.defineProperty(target, key, { ...original, value: replacement });
  try {
    return run();
  } finally {
    Reflect.defineProperty(target, key, original);
  }
}

describe("astra 164 CRITICAL: an intrinsic replaced after load cannot change what R8 checks or emits", () => {
  it("astra's recipe: with Array.prototype.map replaced, both compilers still emit the signed max 40", () => {
    const confirmed = confirmSafetyEnvelope(input(), DECISION);
    const registration = register(confirmed);
    const originalMap = Array.prototype.map;
    let runtimeMax: unknown;
    let csdMax: unknown;
    try {
      Array.prototype.map = function (this: unknown[], callback: any, thisArg?: unknown) {
        const result = originalMap.call(this, callback, thisArg) as any[];
        for (const value of result) {
          if (value && value.quantity === "incubation_temperature" && value.max === 40) value.max = 400;
          if (value && value.key === "incubationTemperature" && value.max === 40) value.max = 400;
        }
        return result;
      } as typeof Array.prototype.map;
      runtimeMax = compileOperationalEnvelope(confirmed, registration, verifyRegistry).limits[0]!.max;
      csdMax = compileSafetyEnvelope(confirmed, registration, verifyRegistry).parameters[0]!.max;
    } finally {
      Array.prototype.map = originalMap;
    }
    expect(runtimeMax).toBe(40);
    expect(csdMax).toBe(40);
  });

  for (const [label, target, key, make] of PATCHES) {
    it(`with ${label} replaced after load, draft, confirm and both compilers give exactly the untouched result`, () => {
      const original = Reflect.getOwnPropertyDescriptor(target, key)!.value;
      const produced = withPatch(target, key, make(original), runStages);
      // Our code never consults the replacement: draft, confirm and the CSD compile are exactly the untouched ones.
      expect(JSON.stringify(produced.draft)).toBe(CLEAN.draft);
      expect(JSON.stringify(produced.confirmed)).toBe(CLEAN.confirmed);
      expect(JSON.stringify(produced.csd)).toBe(CLEAN.csd);
      expect(JSON.stringify(produced.refusals)).toBe(CLEAN.refusals);
      // The runtime compile also asks zod (third-party code, which does call ambient methods) to validate the
      // frozen candidate. Zod may refuse under a replacement: that is fail closed. It can never change the value.
      const runtime = JSON.stringify(produced.runtime);
      if (runtime !== CLEAN.runtime) expect((produced.runtime as { threw?: string }).threw).toBe("EnvelopeRefused");
    });
  }

  it("data written onto Object.prototype and Array.prototype (min, max, value, get, set, indices) changes nothing either", () => {
    // Data-only prototype pollution, the kind a JSON merge bug can cause: no function is replaced, values appear
    // through inheritance. Every read R8 makes is of an own property, and every descriptor it builds has a null
    // prototype, so none of these is ever seen. The decision edits the cited quantity, so confirm's bound check runs.
    const decision = { ...DECISION, edits: [{ quantity: "incubation_temperature", min: 21, max: 39 }] };
    const stagesWith = (): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      try {
        out.draft = draftSafetyEnvelope(input());
        const confirmed = confirmSafetyEnvelope(input(), decision);
        out.confirmed = confirmed;
        const registration = register(confirmed);
        out.csd = compileSafetyEnvelope(confirmed, registration, verifyRegistry);
        out.runtime = compileOperationalEnvelope(confirmed, registration, verifyRegistry);
      } catch (err) {
        out.threw = (err as Error)?.message;
      }
      return out;
    };
    const clean = JSON.stringify(stagesWith());
    const pollution: Array<[object, PropertyKey, unknown]> = [
      [Object.prototype, "min", 1000],
      [Object.prototype, "max", 4000],
      [Object.prototype, "value", 4000],
      [Object.prototype, "get", 1],
      [Object.prototype, "set", 1],
      [Array.prototype, 0, { max: 4000 }],
      [Array.prototype, 1, "x"],
    ];
    let polluted: Record<string, unknown>;
    try {
      for (const [target, key, value] of pollution) Reflect.defineProperty(target, key, { __proto__: null, value, writable: true, enumerable: false, configurable: true } as PropertyDescriptor);
      polluted = stagesWith();
    } finally {
      for (const [target, key] of pollution) Reflect.deleteProperty(target, key);
    }
    expect(JSON.stringify(polluted!)).toBe(clean);
  });

  it("with Object.prototype.value written, a getter in the envelope is still refused as an accessor, and never runs", () => {
    // An accessor's descriptor has no own `value`; read through `in`, an inherited `value` would make it look like data.
    const confirmed = confirmSafetyEnvelope(input(), DECISION);
    const registration = register(confirmed);
    const tampered = JSON.parse(JSON.stringify(confirmed)) as { envelope: { limits: Array<Record<string, unknown>> } };
    let reads = 0;
    Object.defineProperty(tampered.envelope.limits[0]!, "max", { enumerable: true, configurable: true, get: () => (reads++, 40) });
    let message = "";
    Reflect.defineProperty(Object.prototype, "value", { __proto__: null, value: 40, writable: true, enumerable: false, configurable: true } as PropertyDescriptor);
    try {
      compileSafetyEnvelope(tampered as unknown as ConfirmedSafetyEnvelope, registration, verifyRegistry);
    } catch (err) {
      message = (err as Error).message;
    } finally {
      Reflect.deleteProperty(Object.prototype, "value");
    }
    expect(message).toMatch(/limits\[0\]\.max: an accessor \(a getter or setter\)/);
    expect(reads).toBe(0);
  });

  it("compileSafetyEnvelope's result is frozen, like the runtime envelope", () => {
    const confirmed = confirmSafetyEnvelope(input(), DECISION);
    const csd = compileSafetyEnvelope(confirmed, register(confirmed), verifyRegistry);
    expect(Object.isFrozen(csd)).toBe(true);
    expect(Object.isFrozen(csd.parameters[0])).toBe(true);
    expect(Object.isFrozen(csd.evidence["envelope-conformance"]!.primitives![0]!.params)).toBe(true);
  });

  it("the templates and module constants are frozen when the module loads", async () => {
    const m = await import("../onboarding/safety-envelope.js");
    expect(Object.isFrozen(m.DEVICE_CLASS_TEMPLATES)).toBe(true);
    expect(Object.isFrozen(m.DEVICE_CLASS_TEMPLATES["lab-plate-reader"]!.requires[0])).toBe(true);
    expect(Object.isFrozen(m.HAZARDS)).toBe(true);
    expect(Object.isFrozen(m.SUPERVISION_MODES)).toBe(true);
  });
});

describe("the captured replacements are byte-identical to what they replace", () => {
  const values: unknown[] = [
    null,
    true,
    0,
    -0,
    1.5e-7,
    2 ** 53 - 1,
    -(2 ** 53 - 1),
    "",
    "\u00e9 \u2603 \u2028 \\ \" \u0000",
    [1, "a", null, [2, [3]], { z: 1, a: 2 }],
    { b: 1, a: [true, false], "": 0, "\u00e9": "x", A: { y: null, x: undefined } },
  ];

  it("canonicalJson equals canonicalize on JSON data, including key order by UTF-16 code units", () => {
    for (const v of values) expect(canonicalJson(v)).toBe(canonicalize(v));
    const confirmed = confirmSafetyEnvelope(input(), DECISION);
    expect(canonicalJson(confirmed.envelope)).toBe(canonicalize(confirmed.envelope));
  });

  it("canonicalJson refuses a number canonical JSON has no form for, as D5's canonicalize does: a non-finite one, or an integer outside the safe range", () => {
    // D5 (evidence profile v1 sec 1, #359). Every number of magnitude 2^53 or more is an integer outside the safe range.
    for (const v of [1e21, -1e21, 2 ** 53, -(2 ** 53), 1.5e300, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, { a: [1, { b: 1e21 }] }, [2 ** 53]]) {
      expect(() => canonicalJson(v), JSON.stringify(v) ?? String(v)).toThrow(/canonical JSON has no form for the number/);
    }
  });

  it("the registration preimage equals LO-EV-1's signingPreimage of the statement digest", () => {
    const confirmed = confirmSafetyEnvelope(input(), DECISION);
    const statement = { deviceId: "pr-1", envelopeDigest: confirmed.envelopeDigest, registeredAt: "2026-10-02T20:05:00Z" };
    expect(Array.from(registrationSigningPreimage(statement))).toEqual(Array.from(signingPreimage(registrationStatementDigest(statement))));
  });

  it("the signature parser accepts and refuses exactly what LO-EV-1's parseEd25519SignatureHex does", () => {
    const hex = "0123456789abcdefABCDEF".repeat(6).slice(0, 128);
    for (const value of [hex, `0x${hex}`, `0X${hex}`, hex.toLowerCase(), hex.slice(1), `${hex}0`, `${hex.slice(2)}zz`, 12, `0x${hex.slice(2)}`, ""]) {
      let reference: number[] | null;
      try {
        reference = Array.from(parseEd25519SignatureHex(value));
      } catch {
        reference = null;
      }
      const ours = fixedHexBytes(value, 64);
      expect(ours === null ? null : Array.from(ours), String(value)).toEqual(reference);
    }
  });
});

describe("the R8 modules call no ambient method (source scan)", () => {
  /** The code with comments, strings and template literals blanked, so only calls in code are seen. */
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

  const BANNED: Array<[RegExp, string]> = [
    [/\.(map|filter|flatMap|forEach|some|every|includes|find|findIndex|indexOf|join|push|pop|shift|unshift|splice|sort|reverse|concat|entries|values|trim|test|exec|toLowerCase|toUpperCase|slice|split|startsWith|endsWith|replace|padStart|toString|update|digest|has|add|delete|get|set)\(/, "a method call that would be looked up at call time"],
    [/\bfor\s*\([^)]*\bof\b/, "for...of (the iterator protocol)"],
    [/\[\s*\.\.\./, "array spread (the iterator protocol)"],
    [/\bnew\s+(Set|Map|WeakSet|WeakMap|Array|Uint8Array|TextEncoder)\b/, "an ambient constructor"],
    [/\b(JSON|Object|Array|Number|Math|Date|Reflect|Symbol|Promise)\s*\./, "a member of an ambient global"],
    [/\b(String|Number|Boolean)\s*\(/, "an ambient conversion function"],
    [/\binstanceof\b/, "instanceof"],
    [/\b(canonicalize|signingPreimage|parseEd25519SignatureHex|createHash)\s*\(/, "a shared helper that uses ambient methods"],
  ];

  /**
   * Banned in every R8 module, primordials.ts included, with no exemption: a
   * RegExp object's matcher can be replaced after load by
   * RegExp.prototype.compile, even when the object is frozen (astra pack 167).
   * A slash that follows an operator or punctuation starts a regex literal; a
   * division follows an operand.
   */
  const NO_REGEXP: Array<[RegExp, string]> = [
    [/\bRegExp\b/, "a RegExp"],
    [/\.(regex|test|exec|match|matchAll|search)\(/, "a regex method"],
    [/(^|[=(,:!&|?;{}[<>+\-*%~^]|\breturn|\btypeof)\s*\/(?![/*])/, "a regex literal"],
  ];

  for (const file of ["primordials.ts", "safety-envelope.ts", "operational-envelope.ts"]) {
    it(`${file} checks no format with a RegExp`, () => {
      const code = codeOnly(readFileSync(fileURLToPath(new URL(`../onboarding/${file}`, import.meta.url)), "utf8"));
      const found: string[] = [];
      code.split("\n").forEach((line, n) => {
        for (const [pattern, what] of NO_REGEXP) if (pattern.test(line)) found.push(`${file}:${n + 1} ${what}: ${line.trim()}`);
      });
      expect(found).toEqual([]);
    });
  }

  it("the regex-literal ban sees a literal after = ( , : return and =>, and not a division", () => {
    const literal = NO_REGEXP[2]![0];
    for (const line of ["const P = /^a$/;", "f(/x/)", "g(a, /x/)", "{ k: /x/ }", "return /x/.source;", "const f = () => /x/;"]) expect(literal.test(line), line).toBe(true);
    for (const line of ["const half = total / 2;", "const r = (a + b) / c;", "x = list[0] / y;"]) expect(literal.test(line), line).toBe(false);
  });

  for (const file of ["safety-envelope.ts", "operational-envelope.ts"]) {
    it(`${file} uses only the captured intrinsics`, () => {
      const code = codeOnly(readFileSync(fileURLToPath(new URL(`../onboarding/${file}`, import.meta.url)), "utf8"));
      const lines = code.split("\n");
      const found: string[] = [];
      for (const [pattern, what] of BANNED) {
        lines.forEach((line, n) => {
          // Zod schema construction runs once, at load; its own method names are not ambient calls of ours.
          if (/^\s*(\.|z\.|export const|const \w+ = z)/.test(line) && /\b(z\.|\.(refine|strict|optional|min|superRefine|enum|literal|union|array|number|string|object|int|finite|discriminatedUnion)\()/.test(line)) return;
          if (pattern.test(line)) found.push(`${file}:${n + 1} ${what}: ${line.trim()}`);
        });
      }
      expect(found).toEqual([]);
    });
  }
});
