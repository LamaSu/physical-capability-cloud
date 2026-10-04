/**
 * astra pack 170: the PRODUCTION `canonicalize` now calls only intrinsics
 * captured at load. Two properties are checked here:
 *   1. byte equality with the implementation it replaces, on the edge cases
 *      and on a seeded corpus of nested values;
 *   2. under each intrinsic replaced after load, the same bytes.
 * Plus source scans: canonicalize, measurement-profile.ts and
 * util/primordials.ts call nothing looked up at call time, and use no RegExp.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as profileModule from "../evidence/measurement-profile.js";
import { canonicalize } from "../util/canonical.js";

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

describe("canonicalize is byte-identical to the implementation it replaces", () => {
  it("on every edge case", () => {
    for (let i = 0; i < EDGES.length; i++) expect(canonicalize(EDGES[i]), `edge ${i}`).toBe(legacyCanonicalize(EDGES[i]));
  });

  it("on 3000 seeded nested values", () => {
    const rand = lcg(170);
    for (let i = 0; i < 3000; i++) {
      const v = generate(rand, 4);
      expect(canonicalize(v), `value ${i}`).toBe(legacyCanonicalize(v));
    }
  });
});

describe("canonicalize writes the same bytes with any intrinsic replaced after load", () => {
  const SAMPLE = { b: [3, -0, { d: "x", c: [true, null, undefined] }, , 4], a: "\u00e9", "": 1.5e-7, z: { y: [] }, "10": NaN, "2": 0 };
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

describe("canonicalize reads only an array's own indices", () => {
  it("an index Array.prototype serves never fills a hole", () => {
    const holed = [1, , 3];
    const clean = canonicalize(holed);
    Object.defineProperty(Array.prototype, "1", { configurable: true, writable: true, value: "served" });
    let got: string;
    try {
      got = canonicalize(holed);
    } finally {
      delete (Array.prototype as unknown as Record<string, unknown>)["1"];
    }
    expect(clean).toBe("[1,,3]");
    expect(got).toBe(clean);
  });
});

describe("source scans: canonicalize, measurement-profile.ts and util/primordials.ts", () => {
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
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  const AMBIENT: Array<[RegExp, string]> = [
    [/\b(Object|Array|Number|Reflect|JSON|Symbol|Math|String|Date|Set|Map|Promise)\s*\./, "a member of an ambient global"],
    [/\bfor\s*\([^)]*\bof\b/, "for...of (the iterator protocol)"],
    [/\[\s*\.\.\./, "array spread (the iterator protocol)"],
    [/\bnew\s+(Set|Map|WeakSet|WeakMap|Array)\b/, "an ambient constructor"],
    [/\binstanceof\b/, "instanceof"],
    [/\.(map|filter|forEach|some|every|includes|indexOf|join|push|pop|shift|unshift|splice|sort|reverse|concat|slice|split|reduce|entries|values|keys|trim|test|exec|has|add|delete|get|set|call|apply|bind)\(/, "a method looked up at call time"],
    [/\b(String|Number|Boolean)\s*\(/, "an ambient conversion function"],
  ];
  const NO_REGEXP: Array<[RegExp, string]> = [
    [/\bRegExp\b/, "a RegExp"],
    [/\.(regex|test|exec|match|matchAll|search)\(/, "a regex method"],
    [/(^|[=(,:!&|?;{}[<>+\-*%~^]|\breturn|\btypeof)\s*\/(?![/*])/, "a regex literal"],
  ];
  function scan(label: string, code: string, rules: Array<[RegExp, string]>, skip: (line: string) => boolean = () => false): string[] {
    const found: string[] = [];
    code.split("\n").forEach((line, n) => {
      if (skip(line)) return;
      for (const [pattern, what] of rules) if (pattern.test(line)) found.push(`${label}:${n + 1} ${what}: ${line.trim()}`);
    });
    return found;
  }

  it("canonicalize itself calls only what util/primordials.ts captured at load", () => {
    const source = read("../util/canonical.ts");
    const start = source.indexOf("export function canonicalize(");
    const end = source.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(0);
    expect(scan("canonicalize", codeOnly(source.slice(start, end + 2)), [...AMBIENT, ...NO_REGEXP])).toEqual([]);
  });

  it("measurement-profile.ts calls only captured intrinsics and checks no format with a RegExp", () => {
    // The load-time captures of node:crypto's Hash are the only ambient reads, and they run once, at load.
    const atLoad = (line: string) => /^const (createHashAtLoad|HashPrototype|HashPrototypeUpdate|HashPrototypeDigest) = /.test(line.trim());
    expect(scan("measurement-profile.ts", codeOnly(read("../evidence/measurement-profile.ts")), [...AMBIENT, ...NO_REGEXP], atLoad)).toEqual([]);
  });

  it("util/primordials.ts holds no RegExp", () => {
    expect(scan("primordials.ts", codeOnly(read("../util/primordials.ts")), NO_REGEXP)).toEqual([]);
  });

  it("measurement-profile's exported data is frozen, so nothing can widen what validation accepts", () => {
    const exported = Object.entries(profileModule).filter(([, v]) => typeof v === "object" && v !== null);
    expect(exported.length).toBeGreaterThan(0);
    for (const [name, v] of exported) expect(Object.isFrozen(v), name).toBe(true);
  });
});
