/**
 * #359's canonicalize against the encoder #336 replaced (carried from #336's astra pack 170
 * tests, after #359 made canonicalize refuse non-JSON). On the plain-JSON subset #359 accepts,
 * the bytes are the legacy encoder's, so every hash taken before is unchanged; outside it,
 * NonCanonicalValueError. Each intrinsic replaced after load leaves the bytes unchanged too.
 */

import { describe, expect, it } from "vitest";

import { NonCanonicalValueError, canonicalize } from "../util/canonical.js";

/** canonicalize as it was before astra pack 170: the reference its output must equal. */
function legacyCanonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "[" + value.map(legacyCanonicalize).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + legacyCanonicalize((value as Record<string, unknown>)[k]));
    return "{" + pairs.join(",") + "}";
  }
  return String(value);
}

/** A seeded generator, so the corpus is the same on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const STRING_UNITS = [0x22, 0x5c, 0x2f, 0x08, 0x0c, 0x0a, 0x0d, 0x09, 0x00, 0x1f, 0x7f, 0x41, 0x7a, 0x30, 0xe9, 0x2028, 0x2029, 0xfeff, 0xd800, 0xdc00, 0xd83d, 0xde00, 0x4e2d];
const NUMBERS = [0, -0, 1, -1, 0.1, 1e21, 1e-7, 5e-324, 1.7976931348623157e308, Number.MAX_SAFE_INTEGER + 2, NaN, Infinity, -Infinity, 123456789.125];
const KEYS = ["", "a", "b", "A", "10", "2", "-1", "__proto_", "\u00e9", "\ud83d\ude00", "\ud800", "z", "aa", "a b", "constructor", "toString"];

function generate(rand: () => number, depth: number): unknown {
  const r = rand();
  if (depth <= 0 || r < 0.45) {
    const k = rand();
    if (k < 0.2) return NUMBERS[Math.floor(rand() * NUMBERS.length)];
    if (k < 0.3) return rand() < 0.5;
    if (k < 0.36) return null;
    if (k < 0.4) return undefined;
    let s = "";
    const n = Math.floor(rand() * 6);
    for (let i = 0; i < n; i++) s += String.fromCharCode(STRING_UNITS[Math.floor(rand() * STRING_UNITS.length)]!);
    return s;
  }
  if (r < 0.7) {
    const n = Math.floor(rand() * 5);
    const a: unknown[] = new Array(n);
    // Leave some holes: map skips them and join writes them as nothing.
    for (let i = 0; i < n; i++) if (rand() < 0.85) a[i] = generate(rand, depth - 1);
    return a;
  }
  const o: Record<string, unknown> = rand() < 0.3 ? Object.create(null) : {};
  const n = Math.floor(rand() * 6);
  for (let i = 0; i < n; i++) o[KEYS[Math.floor(rand() * KEYS.length)]!] = generate(rand, depth - 1);
  return o;
}

const EDGES: unknown[] = [
  null, undefined, true, false, 0, -0, NaN, Infinity, -Infinity, 1e21, 5e-7, "", "\u2028", "\ud800", "\ud83d\ude00",
  [], [undefined], [null], new Array(3), [1, , 3], { a: undefined }, { "10": 1, "2": 2, b: 3, a: 4 }, { "": [] },
  Object.assign(Object.create(null), { z: 1, y: [{}] }), { nested: { deeper: [[1, [2, [3]]]] } },
];

/**
 * Whether #359 accepts a value: a plain JSON tree (no undefined as the value or as an array
 * element, no hole, finite numbers within the safe-integer range, plain objects), per its
 * contract in util/canonical.ts. An undefined object member is omitted, as before.
 */
function plainJson(value: unknown): boolean {
  if (value === undefined) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !(Number.isInteger(value) && Math.abs(value) > Number.MAX_SAFE_INTEGER);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!Object.prototype.hasOwnProperty.call(value, i) || value[i] === undefined || !plainJson(value[i])) return false;
    return true;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.keys(value as object).every((k) => (value as Record<string, unknown>)[k] === undefined || plainJson((value as Record<string, unknown>)[k]));
  }
  return false;
}

/** canonicalize's bytes, or "refused" for a NonCanonicalValueError. */
function bytesOrRefusal(value: unknown): string {
  try {
    return canonicalize(value);
  } catch (err) {
    if (err instanceof NonCanonicalValueError) return "refused";
    throw err;
  }
}

describe("on the plain-JSON subset, the legacy encoder's bytes; outside it, a refusal", () => {
  it("on every edge case", () => {
    for (let i = 0; i < EDGES.length; i++) {
      expect(bytesOrRefusal(EDGES[i]), `edge ${i}`).toBe(plainJson(EDGES[i]) ? legacyCanonicalize(EDGES[i]) : "refused");
    }
  });

  it("on 3000 seeded nested values", () => {
    const rand = lcg(170);
    let accepted = 0;
    for (let i = 0; i < 3000; i++) {
      const v = generate(rand, 4);
      const json = plainJson(v);
      if (json) accepted += 1;
      expect(bytesOrRefusal(v), `value ${i}`).toBe(json ? legacyCanonicalize(v) : "refused");
    }
    // Both sides of the boundary are exercised.
    expect(accepted).toBeGreaterThan(300);
    expect(accepted).toBeLessThan(2700);
  });
});

describe("canonicalize writes the same bytes with any intrinsic replaced after load", () => {
  const SAMPLE = { b: [3, -0, { d: "x", c: [true, null] }, 4], a: "\u00e9", "": 1.5e-7, z: { y: [] }, "2": 0 };
  const CLEAN = canonicalize(SAMPLE);
  const PATCHES: Array<[string, object, PropertyKey, unknown]> = [
    ["Array.prototype.map", Array.prototype, "map", () => []],
    ["Array.prototype.join", Array.prototype, "join", () => ""],
    ["Array.prototype.filter", Array.prototype, "filter", () => []],
    ["Array.prototype.sort", Array.prototype, "sort", function (this: unknown[]) { return this; }],
    ["Array.prototype[Symbol.iterator]", Array.prototype, Symbol.iterator, function* () {}],
    ["Array.isArray", Array, "isArray", () => false],
    ["Object.keys", Object, "keys", () => []],
    ["Object.prototype.hasOwnProperty", Object.prototype, "hasOwnProperty", () => false],
    ["JSON.stringify", JSON, "stringify", () => '"x"'],
    ["String", globalThis, "String", () => "x"],
    ["Function.prototype.call", Function.prototype, "call", () => undefined],
  ];
  for (const [label, target, key, replacement] of PATCHES) {
    it(`${label}`, () => {
      const original = Reflect.getOwnPropertyDescriptor(target, key)!;
      Reflect.defineProperty(target, key, { ...original, value: replacement });
      let got: string;
      try {
        got = canonicalize(SAMPLE);
      } finally {
        Reflect.defineProperty(target, key, original);
      }
      expect(got).toBe(CLEAN);
    });
  }
});

describe("a hole is refused, even when Array.prototype serves its index", () => {
  it("an index Array.prototype serves never fills a hole", () => {
    const holed = [1, , 3];
    Object.defineProperty(Array.prototype, "1", { configurable: true, writable: true, value: "served" });
    let got: string;
    try {
      got = bytesOrRefusal(holed);
    } finally {
      delete (Array.prototype as unknown as Record<string, unknown>)["1"];
    }
    expect(got).toBe("refused");
    expect(bytesOrRefusal(holed)).toBe("refused");
  });
});
