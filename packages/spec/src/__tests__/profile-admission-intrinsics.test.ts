/**
 * #363 round 9 (steward #5186): the realm-mutation class, across admission's
 * trust path. A validation or commitment decision must not depend on anything
 * that code running after @pcc/spec loaded can change (astra packs 162, 164,
 * 167, 170, 171): here `profileAdmitsBundle`, `computeBundleSetDigest`,
 * `unverifiableProfileTerms` and the evidence-level classification.
 *
 * The patch harness runs in child processes (harness/admission-realm.ts),
 * one per scenario. Each loads @pcc/spec, builds every item, runs them clean,
 * then makes one change after load (replaces an intrinsic, writes a value onto
 * Object.prototype, pushes onto an exported list, recompiles a RegExp, forges
 * a promise resolution), runs them again and undoes it. Every result must be
 * identical to the clean one, or a refusal: a reject (or a hold where the
 * clean result admitted), a throw, or more unverifiable terms. A changed
 * acceptance, digest, term list or level fails the scenario.
 *
 * Why children: vitest runs its own runner in the test's realm. With
 * Array.prototype[Symbol.iterator] replaced across an event-loop turn, vitest
 * itself stalls (a test with no @pcc/spec code in it never completes), so an
 * in-process harness can only test what vitest survives. A child holds only
 * @pcc/spec, the harness and Node, whose internals use their own primordials.
 *
 * The rest of this file changes nothing in its own realm: the structural
 * predicates against the RegExps they replace, a reachability walk for
 * RegExps, frozen exports, and source scans.
 */
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import * as admissionModule from "../evidence/profile-admission.js";
import type { ProfileAdmissionInput } from "../evidence/profile-admission.js";
import * as levelModule from "../evidence/evidence-level.js";
import * as primordials from "../util/primordials.js";

// -- the child realms --
const SPEC_DIR = fileURLToPath(new URL("../../", import.meta.url));
const REALM = fileURLToPath(new URL("./harness/admission-realm.ts", import.meta.url));
const NODE_ARGS = ["--import", "tsx", REALM];

type Row = [kind: string, label: string, value: unknown];
interface Outcome {
  scenario: string;
  clean: Row[];
  patched?: unknown;
  hung?: boolean;
  error?: string;
}

function lastLine(stdout: string): string {
  const lines = stdout.trim().split("\n");
  return lines[lines.length - 1] ?? "";
}

const SCENARIOS: string[] = JSON.parse(lastLine(execFileSync(process.execPath, [...NODE_ARGS, "--list"], { cwd: SPEC_DIR, encoding: "utf8" })));

function runScenario(id: string): Promise<Outcome> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [...NODE_ARGS, id],
      { cwd: SPEC_DIR, encoding: "utf8", timeout: 120_000, maxBuffer: 1 << 26 },
      (err, stdout, stderr) => {
        try {
          resolve(JSON.parse(lastLine(stdout)) as Outcome);
        } catch {
          resolve({ scenario: id, clean: [], error: `${err?.message ?? "no result line"} | ${stderr.slice(-800)}` });
        }
      },
    );
  });
}

const OUTCOMES = new Map<string, Outcome>();

beforeAll(async () => {
  const queue = [...SCENARIOS];
  const workers = Math.max(2, Math.min(8, availableParallelism() - 1));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) OUTCOMES.set(id, await runScenario(id));
    }),
  );
}, 900_000);

const STRICTNESS: Record<string, number> = { admit: 0, hold: 1, reject: 2 };

/** Each row that changed and is not a refusal. */
function violations(clean: Row[], patched: Row[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < clean.length; i++) {
    const [kind, label, before] = clean[i]!;
    const after = patched[i]?.[2];
    const a = JSON.stringify(before);
    const b = JSON.stringify(after);
    if (a === b || after === "threw") continue;
    if (kind === "admission" && typeof after === "object" && after !== null && typeof before === "object" && before !== null) {
      const x = after as { decision: string; admits: boolean };
      const y = before as { decision: string };
      if (x.admits === false && x.decision !== "admit" && STRICTNESS[x.decision]! >= STRICTNESS[y.decision]!) continue;
    }
    if (kind === "terms" && Array.isArray(after) && Array.isArray(before) && after.length > before.length && before.every((t) => after.includes(t))) continue;
    out.push(`${kind} | ${label}: ${a} -> ${b}`);
  }
  if (patched.length !== clean.length) out.push(`${patched.length} rows patched, ${clean.length} clean`);
  return out;
}

describe("the patch harness: nothing changed after load changes a decision, a digest, a term or a level", () => {
  it("lists every scenario the spec names", () => {
    const has = (prefix: string) => SCENARIOS.some((s) => s.startsWith(prefix));
    for (const name of [
      "Array.prototype.map", "Array.prototype.filter", "Array.prototype.some", "Array.prototype.every", "Array.prototype.includes",
      "Array.prototype.indexOf", "Array.prototype.find", "Array.prototype.join", "Array.prototype.push", "Array.prototype.sort",
      "Array.prototype.slice", "Array.prototype.concat", "Array.prototype[Symbol.iterator]", "%ArrayIteratorPrototype%.next",
      "Array.isArray", "Object.keys", "Object.entries", "Object.values", "Object.assign", "Object.freeze", "Object.isFrozen",
      "Object.getOwnPropertyDescriptor", "Object.getPrototypeOf", "Reflect.ownKeys", "JSON.stringify", "String", "Number.isFinite",
      "Date.parse", "Set.prototype.has", "Set.prototype.add", "Map.prototype.get", "RegExp.prototype.test", "RegExp.prototype.exec",
      "String.prototype.trim", "String.prototype.charCodeAt", "Promise.prototype.then", "Hash.prototype.update", "Hash.prototype.digest",
    ]) {
      expect(has(`patch: ${name}`), name).toBe(true);
    }
    expect(SCENARIOS.length).toBeGreaterThan(80);
  });

  it("the clean run is what the builders say, and every realm's clean run is the same (the harness is not vacuous)", () => {
    const reference = OUTCOMES.get(SCENARIOS[0]!)!;
    expect(reference.error).toBeUndefined();
    const rows = reference.clean;
    for (const [kind, label, value] of rows) {
      if (kind === "admission") expect((value as { decision: string }).decision, label).toBe(label.split(":")[0]);
    }
    const value = (label: string) => rows.find((r) => r[1] === label)![2];
    expect(value("digest: golden")).toBe("sha256:0a4e0b2921450b40dcef729559eb0b6ba4eaab9aff844c4a9bc061b90e6285fb");
    expect(value("digest: golden with a unit")).toBe("sha256:965f2f0c50750b5171f2f8dc845c44eb0753bba4f2a5903d6f1d8c7c1b037dc8");
    expect(value("digest: empty")).toBe("threw");
    expect(value("terms: every term at once")).toHaveLength(11);
    expect(value("levels: printer completes, camera inspects")).toBe("inspected_output");
    expect(rows.filter((r) => r[0] === "admission").length).toBeGreaterThanOrEqual(60);
    for (const id of SCENARIOS) {
      if (!id.startsWith("patch: ") && !id.startsWith("data: ")) continue;
      expect(OUTCOMES.get(id)?.clean, id).toEqual(rows);
    }
  });

  /**
   * Scenarios whose rows must be identical, not merely refusals: with
   * Object.prototype.value written, plainDataCopy would still refuse an
   * accessor deep in the bundles, so only the reason shows whether codeInData
   * itself read the descriptor's OWN value (astra pack 162).
   */
  const IDENTICAL = new Set(["recipe: Object.prototype.value written; an accessor deep in the bundles (codeInData)"]);

  for (const id of SCENARIOS) {
    it(id, () => {
      const outcome = OUTCOMES.get(id)!;
      expect(outcome.error, "the child realm ran to completion").toBeUndefined();
      expect(outcome.hung, "every item settled").toBeUndefined();
      expect(Array.isArray(outcome.patched), String(outcome.patched)).toBe(true);
      expect(violations(outcome.clean, outcome.patched as Row[])).toEqual([]);
      if (IDENTICAL.has(id)) expect(outcome.patched).toEqual(outcome.clean);
    });
  }
});

describe("the input boundary terminates", () => {
  it("a cycle anywhere in the data resolves to a reject: never a rejected promise or a stack overflow", async () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const list: unknown[] = [];
    list.push(list);
    for (const [key, value] of [["profile", cyclic], ["subject", cyclic], ["bundles", list]] as const) {
      const r = await admissionModule.profileAdmitsBundle({ [key]: value } as unknown as ProfileAdmissionInput);
      expect(r.decision, key).toBe("reject");
    }
  });
});

// -- what changes nothing in this realm --
/** A seeded generator, so the corpus is the same on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const OLD_DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const ch = (...units: number[]) => String.fromCharCode(...units);

describe("isDecimalValue: exactly the old DECIMAL_VALUE_PATTERN, by code unit, with no RegExp", () => {
  const isDecimalValue = (admissionModule as Record<string, unknown>).isDecimalValue as (v: unknown) => boolean;
  const UNITS = [
    0x30, 0x30, 0x31, 0x32, 0x35, 0x39, 0x30, 0x37, 0x2d, 0x2e, 0x2e, 0x2b, 0x65, 0x45, 0x20, 0x0a, 0x0d, 0x09, 0x0b, 0x0c,
    0xa0, 0x2028, 0xfeff, 0x0660, 0x0663, 0x0966, 0xff11, 0xd800, 0xdc00, 0xd835, 0x2c, 0x5f, 0x78, 0x2f, 0x3a,
  ];
  const EDGES = [
    "", "-", ".", "0", "-0", "00", "-00", "0.", ".5", "-.5", "1e5", "1E5", "+1", "1.", "1..2", "1.2.3", "01", "-01", "10", "100.001",
    "0.0", "-0.0", "1 ", " 1", "1\n", "\n1", "1\r", "1\t", "0x1", "1_000", "1,5", "12.5", "-12.5", "9007199254740993", "0.0000001",
    "-1.", "--1", "1-", "0.5.", ch(0x0663), `1${ch(0xff11)}`, ch(0xd800), `1${ch(0xdc00)}`, `1.${ch(0xd835, 0xdfce)}`, `1${ch(0x2028)}`,
    `${ch(0xfeff)}1`, `1${ch(0xa0)}`, `1${ch(0)}`,
  ];

  it("is exported, and DECIMAL_VALUE_PATTERN is not", () => {
    expect(typeof isDecimalValue).toBe("function");
    expect((admissionModule as Record<string, unknown>).DECIMAL_VALUE_PATTERN).toBeUndefined();
  });

  it("agrees with the old pattern on every edge case: '-', '.', '00', '-0', '0.', '.5', '1e5', '+1', whitespace, a trailing newline, non-ASCII digits, lone surrogates", () => {
    for (const s of EDGES) expect(isDecimalValue(s), JSON.stringify(s)).toBe(OLD_DECIMAL.test(s));
  });

  it("agrees with the old pattern on 25,000 generated strings", () => {
    // Half the strings are drawn from digits, "-" and "." alone, so both answers are common.
    const DECIMALISH = [0x30, 0x30, 0x31, 0x35, 0x39, 0x2d, 0x2e];
    const rand = lcg(363);
    let accepted = 0;
    for (let n = 0; n < 25_000; n++) {
      const units = rand() < 0.5 ? DECIMALISH : UNITS;
      const len = Math.floor(rand() * 9);
      let s = "";
      for (let i = 0; i < len; i++) {
        const pick = rand();
        s += pick < 0.03 ? String.fromCodePoint(0x1d7ce) : ch(units[Math.floor(rand() * units.length)]!);
      }
      const expected = OLD_DECIMAL.test(s);
      if (isDecimalValue(s) !== expected) expect.fail(`isDecimalValue(${JSON.stringify(s)}) !== ${expected}`);
      if (expected) accepted++;
    }
    // The corpus reaches both answers.
    expect(accepted).toBeGreaterThan(2000);
    expect(25_000 - accepted).toBeGreaterThan(2000);
  });

  it("is false for every non-string, where RegExp.prototype.test would coerce", () => {
    for (const v of [12.5, 0, -1, 1n, true, null, undefined, ["1"], { toString: () => "1" }, new String("1")]) {
      expect(isDecimalValue(v), String(v)).toBe(false);
    }
  });
});

const OLD_TAGGED = /^sha256:[0-9a-f]{64}$/;

describe("isTaggedSha256 (util/primordials.ts): exactly signing-preimage.ts's TAGGED_DIGEST_PATTERN, by code unit", () => {
  const isTaggedSha256 = (primordials as Record<string, unknown>).isTaggedSha256 as (v: unknown) => boolean;
  const hex = "0123456789abcdef".repeat(4);

  it("agrees on edge cases", () => {
    expect(typeof isTaggedSha256).toBe("function");
    const cases = [
      `sha256:${hex}`, `SHA256:${hex}`, `sha256-${hex}`, `sha265:${hex}`, `sha256:${hex.toUpperCase()}`, `sha256:${hex}0`, `sha256:${hex.slice(1)}`,
      `sha256:${hex}\n`, ` sha256:${hex}`, `0x${hex}`, "", "sha256:", `sha256:${hex.slice(0, 63)}g`, `sha256:${hex.slice(0, 63)}${ch(0xd800)}`,
    ];
    for (const s of cases) expect(isTaggedSha256(s), JSON.stringify(s)).toBe(OLD_TAGGED.test(s));
  });

  it("agrees on 20,000 near-miss strings, with edits at every position", () => {
    const rand = lcg(167);
    const alphabet = ["0", "9", "a", "f", "g", "A", "F", ":", "s", "h", "2", "5", "6", "\n", ch(0xd800), ch(0x0663)];
    let accepted = 0;
    for (let n = 0; n < 20_000; n++) {
      const chars = `sha256:${hex}`.split("");
      const edits = Math.floor(rand() * 3);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(rand() * (chars.length + 1));
        const kind = rand();
        if (kind < 0.5) chars[at] = alphabet[Math.floor(rand() * alphabet.length)]!;
        else if (kind < 0.75) chars.splice(at, 1);
        else chars.splice(at, 0, alphabet[Math.floor(rand() * alphabet.length)]!);
      }
      const s = chars.join("");
      const expected = OLD_TAGGED.test(s);
      if (isTaggedSha256(s) !== expected) expect.fail(`isTaggedSha256(${JSON.stringify(s)}) !== ${expected}`);
      if (expected) accepted++;
    }
    expect(accepted).toBeGreaterThan(2000);
  });

  it("is false for non-strings", () => {
    for (const v of [undefined, null, 1, [`sha256:${hex}`], { toString: () => `sha256:${hex}` }]) expect(isTaggedSha256(v)).toBe(false);
  });
});

describe("exported data and RegExps", () => {
  const MODULES = [["profile-admission", admissionModule], ["evidence-level", levelModule]] as const;

  it("no RegExp is reachable from the exports of profile-admission or evidence-level (astra pack 167's class)", () => {
    const found: string[] = [];
    const seen = new Set<unknown>();
    const walk = (v: unknown, path: string) => {
      if ((typeof v !== "object" && typeof v !== "function") || v === null || seen.has(v)) return;
      seen.add(v);
      if (Object.prototype.toString.call(v) === "[object RegExp]") found.push(path);
      for (const k of Reflect.ownKeys(v)) {
        const d = Reflect.getOwnPropertyDescriptor(v, k)!;
        if ("value" in d) walk(d.value, `${path}.${String(k)}`);
      }
    };
    for (const [name, mod] of MODULES) for (const k of Object.keys(mod)) walk((mod as Record<string, unknown>)[k], `${name}.${k}`);
    expect(found).toEqual([]);
  });

  it("every exported value of profile-admission and evidence-level that is data is deeply frozen", () => {
    const unfrozen: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (typeof v !== "object" || v === null) return;
      if (!Object.isFrozen(v)) unfrozen.push(path);
      for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k], `${path}.${k}`);
    };
    let objects = 0;
    for (const [name, mod] of MODULES) {
      for (const k of Object.keys(mod)) {
        const v = (mod as Record<string, unknown>)[k];
        if (typeof v === "object" && v !== null) objects++;
        walk(v, `${name}.${k}`);
      }
    }
    expect(objects).toBeGreaterThanOrEqual(6);
    expect(unfrozen).toEqual([]);
  });
});

// -- source scans --
/**
 * The code with comments and strings blanked, and line breaks kept.
 * canonical-intrinsics.test.ts's codeOnly, with one change: a template
 * literal's `${...}` substitutions are kept as code, so a call inside one is
 * scanned too.
 */
function codeOnly(source: string): string {
  let i = 0;
  const code = (untilBrace: boolean): string => {
    let out = "";
    let depth = 0;
    while (i < source.length) {
      const c = source[i]!;
      const next = source[i + 1];
      if (untilBrace && c === "}" && depth === 0) {
        i++;
        return out;
      }
      if (c === "/" && next === "*") {
        const end = source.indexOf("*/", i + 2);
        const stop = end < 0 ? source.length : end + 2;
        out += source.slice(i, stop).replace(/[^\n]/g, " ");
        i = stop;
      } else if (c === "/" && next === "/") {
        const end = source.indexOf("\n", i);
        i = end < 0 ? source.length : end;
      } else if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
        i = j + 1;
        out += '""';
      } else if (c === "`") {
        i++;
        out += '""';
        while (i < source.length && source[i] !== "`") {
          if (source[i] === "\\") i += 2;
          else if (source[i] === "$" && source[i + 1] === "{") {
            i += 2;
            out += "+(" + code(true) + ")+";
          } else {
            if (source[i] === "\n") out += "\n";
            i++;
          }
        }
        i++;
        out += '""';
      } else {
        if (c === "{") depth++;
        if (c === "}") depth--;
        out += c;
        i++;
      }
    }
    return out;
  };
  return code(false);
}

// canonical-intrinsics.test.ts's AMBIENT and NO_REGEXP, extended to the rest of this class.
const AMBIENT: Array<[RegExp, string]> = [
  [/\b(Object|Array|Number|Reflect|JSON|Symbol|Math|String|Date|Set|Map|Promise|Error|globalThis|crypto|Buffer)\s*\./, "a member of an ambient global"],
  [/\bfor\s*\([^)]*\bof\b/, "for...of (the iterator protocol)"],
  [/\bfor\s*\([^)]*\bin\b/, "for...in (it enumerates inherited keys)"],
  [/\.\.\./, "spread or rest (the iterator protocol, or reads through getters)"],
  [/\b(const|let|var)\s*\[/, "array destructuring (the iterator protocol)"],
  [/\(\s*\[[^\]]*\]\s*\)\s*(=>|:)/, "an array-destructuring parameter (the iterator protocol)"],
  [/\bnew\s+(Set|Map|WeakSet|WeakMap|Array|Promise|Date|RegExp|TextEncoder|Uint8Array|Error)\b/, "an ambient constructor"],
  [/\binstanceof\b/, "instanceof"],
  [/[\w$)\]"]\s+in\s+[\w$("[{]/, "the in operator (it consults prototypes)"],
  [/\.(map|filter|forEach|some|every|includes|indexOf|find|findIndex|join|push|pop|shift|unshift|splice|sort|reverse|concat|slice|split|reduce|entries|values|keys|trim|test|exec|has|add|delete|get|set|call|apply|bind|then|catch|finally|padStart|toString|charCodeAt|startsWith|endsWith|replace|match)\(/, "a method looked up at call time"],
  [/[\w$\])]\s*\.\s*[A-Za-z_$][\w$]*\s*\(/, "a method call (looked up at call time)"],
  [/\?\.\s*([A-Za-z_$][\w$]*\s*)?\(/, "an optional call (looked up at call time)"],
  [/\b(String|Number|Boolean|structuredClone|queueMicrotask|setTimeout|parseInt|parseFloat|isNaN|isFinite|fetch)\s*\(/, "an ambient function"],
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
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The load-time captures of node:crypto's Hash: the only ambient reads, and they run once, at load. */
const atLoad = (line: string) => /^const (createHashAtLoad|HashPrototype|HashPrototypeUpdate|HashPrototypeDigest) = /.test(line.trim());

describe("source scans: profile-admission.ts and evidence-level.ts", () => {
  it("the scan sees a call inside a template substitution, and nothing inside a string or comment", () => {
    expect(scan("t", codeOnly("const a = `x${JSON.stringify(b)}y`;"), AMBIENT)).not.toEqual([]);
    expect(scan("t", codeOnly("const a = `x${f(b.c(d))}y`;"), AMBIENT)).not.toEqual([]);
    expect(scan("t", codeOnly('const a = "JSON.stringify(b)"; // JSON.parse(c)'), AMBIENT)).toEqual([]);
    expect(scan("t", codeOnly("if (!(\"value\" in d)) x();"), AMBIENT)).not.toEqual([]);
    expect(scan("t", codeOnly("const [a, b] = c;"), AMBIENT)).not.toEqual([]);
    expect(scan("t", codeOnly("x.map(([why, n]) => why);"), AMBIENT)).not.toEqual([]);
    expect(scan("t", codeOnly("const r = /^a$/;"), NO_REGEXP)).not.toEqual([]);
  });

  it("profile-admission.ts calls only what util/primordials.ts captured, plain loops and operators, and holds no RegExp", () => {
    expect(scan("profile-admission.ts", codeOnly(read("../evidence/profile-admission.ts")), [...AMBIENT, ...NO_REGEXP], atLoad)).toEqual([]);
  });

  it("evidence-level.ts calls only what util/primordials.ts captured, plain loops and operators, and holds no RegExp", () => {
    expect(scan("evidence-level.ts", codeOnly(read("../evidence/evidence-level.ts")), [...AMBIENT, ...NO_REGEXP])).toEqual([]);
  });

  it("util/primordials.ts holds no RegExp and imports nothing (browser-safe: no node: import)", () => {
    const source = read("../util/primordials.ts");
    expect(scan("primordials.ts", codeOnly(source), NO_REGEXP)).toEqual([]);
    expect(source).not.toMatch(/^\s*import\b/m);
  });
});
