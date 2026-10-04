/**
 * #345's final evidence-level.ts under post-load realm mutation (steward #5186,
 * evidence #6440). Nothing that runs after @pcc/spec loads may change a level, a
 * verdict, a contradiction or an input refusal it returns. On master 37adc7bf it
 * could: with Array.prototype.indexOf replaced after load,
 * meetsEvidenceLevel("submitted", "inspected_output") answered true.
 *
 * The patch harness runs in child processes (harness/evidence-level-realm.ts),
 * one per scenario: load, build every item, run them clean, make one change
 * (replace an intrinsic, write onto Object.prototype, push onto an exported
 * list), run them again and undo it. Every answer must be IDENTICAL to the clean
 * one. Children, because vitest runs in the realm of the test it runs (see
 * profile-admission-intrinsics.test.ts on #519).
 *
 * The rest of this file changes nothing in its own realm: source scans (the
 * rules of #519's profile-admission-intrinsics.test.ts), frozen exports, no
 * reachable RegExp, and the principal-id predicate held equal to the pattern it
 * replaced.
 */
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import * as levelModule from "../evidence/evidence-level.js";
import { evidenceLevelOfBundles, type AuthenticatedBundle } from "../evidence/evidence-level.js";

// -- the child realms --
const SPEC_DIR = fileURLToPath(new URL("../../", import.meta.url));
const REALM = fileURLToPath(new URL("./harness/evidence-level-realm.ts", import.meta.url));
const NODE_ARGS = ["--import", "tsx", REALM];

type Row = [label: string, value: unknown];
interface Outcome {
  scenario: string;
  clean: Row[];
  patched?: unknown;
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

/** The one scenario allowed to change answers, and only toward refusal (see below). */
const MOCK_SCENARIO = "Object.prototype.mock = true";

/** Each answer that changed. */
function changes(clean: Row[], patched: Row[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < clean.length; i++) {
    const [label, before] = clean[i]!;
    const a = JSON.stringify(before);
    const b = JSON.stringify(patched[i]?.[1]);
    if (a !== b) out.push(`${label}: ${a} -> ${b}`);
  }
  return out;
}

describe("evidence-level answers do not change under post-load realm mutation (harness/evidence-level-realm.ts)", () => {
  it("lists the scenarios, and every child answers with the same clean rows", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(50);
    const first = OUTCOMES.get(SCENARIOS[0]!);
    expect(first?.error).toBeUndefined();
    expect(first?.clean.length).toBeGreaterThanOrEqual(100);
    for (const id of SCENARIOS) expect(JSON.stringify(OUTCOMES.get(id)?.clean), id).toBe(JSON.stringify(first?.clean));
  });

  it.each(SCENARIOS)("%s", (id) => {
    const outcome = OUTCOMES.get(id)!;
    expect(outcome.error, "the child failed").toBeUndefined();
    expect(Array.isArray(outcome.patched), String(outcome.patched)).toBe(true);
    const changed = changes(outcome.clean, outcome.patched as Row[]);
    if (id === MOCK_SCENARIO) {
      // payload.mock keeps isFabricated's own read (E5 pins it: evidence-level.test.ts, the
      // payload trap test). Written on Object.prototype it makes every event fabricated, so it
      // may only refuse: no level, and no contradiction derived from a fabricated bundle.
      for (const line of changed) expect(line, "a change that is not a refusal").toMatch(/-> (null|\[\]|\[(\{"bundleIndex":\d+,"eventIndex":\d+,"level":null\},?)+\])$/);
      expect(changed.length).toBeGreaterThan(0);
    } else {
      expect(changed).toEqual([]);
    }
  });
});

// -- source scans: #519's rules (profile-admission-intrinsics.test.ts), unchanged --
/**
 * The code with comments and strings blanked, and line breaks kept. A template
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
function scan(label: string, code: string, rules: Array<[RegExp, string]>): string[] {
  const found: string[] = [];
  code.split("\n").forEach((line, n) => {
    for (const [pattern, what] of rules) if (pattern.test(line)) found.push(`${label}:${n + 1} ${what}: ${line.trim()}`);
  });
  return found;
}
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("source scans: evidence-level.ts", () => {
  it("the scan sees a call inside a template substitution, and nothing inside a string or comment", () => {
    expect(scan("t", codeOnly("const a = `x${JSON.stringify(b)}y`;"), AMBIENT)).not.toEqual([]);
    expect(scan("t", codeOnly('const a = "JSON.stringify(b)"; // JSON.parse(c)'), AMBIENT)).toEqual([]);
    expect(scan("t", codeOnly("if (!(\"value\" in d)) x();"), AMBIENT)).not.toEqual([]);
    expect(scan("t", codeOnly("for (const k of ks) x();"), AMBIENT)).not.toEqual([]);
    expect(scan("t", codeOnly("const r = /^a$/;"), NO_REGEXP)).not.toEqual([]);
  });

  it("evidence-level.ts calls only what util/primordials.ts captured, plain loops and operators, and holds no RegExp, at load as at call time", () => {
    expect(scan("evidence-level.ts", codeOnly(read("../evidence/evidence-level.ts")), [...AMBIENT, ...NO_REGEXP])).toEqual([]);
  });

  it("util/primordials.ts holds no RegExp and imports nothing (browser-safe: no node: import)", () => {
    const source = read("../util/primordials.ts");
    expect(scan("primordials.ts", codeOnly(source), NO_REGEXP)).toEqual([]);
    expect(source).not.toMatch(/^\s*import\b/m);
  });
});

describe("evidence-level's exported data and RegExps", () => {
  it("no RegExp is reachable from evidence-level's exports (astra pack 167's class)", () => {
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
    for (const k of Object.keys(levelModule)) walk((levelModule as Record<string, unknown>)[k], `evidence-level.${k}`);
    expect(found).toEqual([]);
  });

  it("every exported value of evidence-level that is data is deeply frozen", () => {
    const unfrozen: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (typeof v !== "object" || v === null) return;
      if (!Object.isFrozen(v)) unfrozen.push(path);
      for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k], `${path}.${k}`);
    };
    let objects = 0;
    for (const k of Object.keys(levelModule)) {
      const v = (levelModule as Record<string, unknown>)[k];
      if (typeof v === "object" && v !== null) objects++;
      walk(v, `evidence-level.${k}`);
    }
    expect(objects).toBeGreaterThanOrEqual(7);
    expect(unfrozen).toEqual([]);
  });
});

// -- the operator principal id: the code-unit predicate equals the pattern it replaced --
const OLD_PATTERN = /^eip155:([1-9][0-9]*):0x[0-9a-f]{40}$/;
const oldAccepts = (s: string): boolean => {
  const match = OLD_PATTERN.exec(s);
  return match !== null && Number.isSafeInteger(Number(match[1]));
};
/** The predicate, through the public API: a declared trustDomain it refuses throws. */
const accepts = (s: string): boolean => {
  try {
    evidenceLevelOfBundles([{ events: [], trustDomain: s } as AuthenticatedBundle]);
    return true;
  } catch (err) {
    if ((err as Error).name !== "EvidenceLevelInputError") throw err;
    return false;
  }
};

describe("the operator principal id predicate equals /^eip155:([1-9][0-9]*):0x[0-9a-f]{40}$/ with a safe-integer chain id", () => {
  const hex = "0123456789abcdef".repeat(3).slice(0, 40);
  const valid = (chain: string, h = hex) => `eip155:${chain}:0x${h}`;

  it("agrees on the edge cases", () => {
    const cases = [
      valid("1"), valid("9"), valid("10"), valid("8453"), valid("0"), valid("01"), valid(""),
      valid("900719925474099"), valid("9007199254740991"), valid("9007199254740992"), valid("9007199254740990"),
      valid("9999999999999999"), valid("1000000000000000"), valid("10000000000000000"), valid("18446744073709551616"),
      valid("1", hex.toUpperCase()), valid("1", hex.slice(0, 39)), valid("1", `${hex}a`), valid("1", `${hex.slice(0, 39)}g`),
      `${valid("1")}\n`, `${valid("1")} `, ` ${valid("1")}`, `EIP155:1:0x${hex}`, `eip155:1:0X${hex}`, `eip155::0x${hex}`,
      `eip155:1:${hex}`, `eip155:1::0x${hex}`, `eip155:1:0x${hex}\u0000`, valid("١"), valid("１"), valid("1١"),
      "", "eip155:", "eip155:1", "eip155:1:", "eip155:1:0x", `eip15:1:0x${hex}`, `eip1555:1:0x${hex}`,
    ];
    for (const s of cases) expect(accepts(s), JSON.stringify(s)).toBe(oldAccepts(s));
  });

  it("agrees on 30,000 generated strings (seeded)", () => {
    let seed = 0x5eed;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = "0123456789abcdefABCDEFgx:eip\n ١１";
    const digits = (n: number) => {
      let out = "";
      for (let i = 0; i < n; i++) out += "0123456789"[rand(10)];
      return out;
    };
    let agreed = 0;
    let accepted = 0;
    for (let k = 0; k < 30_000; k++) {
      let s = valid(rand(4) === 0 ? digits(1 + rand(20)) : `${1 + rand(9)}${digits(rand(17))}`);
      const edits = rand(3);
      for (let e = 0; e < edits; e++) {
        const at = rand(s.length + 1);
        const op = rand(3);
        const c = alphabet[rand(alphabet.length)]!;
        s = op === 0 ? s.slice(0, at) + c + s.slice(at + 1) : op === 1 ? s.slice(0, at) + c + s.slice(at) : s.slice(0, at) + s.slice(at + 1);
      }
      expect(accepts(s), JSON.stringify(s)).toBe(oldAccepts(s));
      agreed++;
      if (oldAccepts(s)) accepted++;
    }
    expect(agreed).toBe(30_000);
    expect(accepted).toBeGreaterThan(3_000); // both sides of the predicate are exercised
  });
});
