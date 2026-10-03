/**
 * #384 round 9 (steward #5186): checkProfileRegistration under the
 * realm-mutation class (profile-admission-intrinsics.test.ts, #363). Each
 * scenario runs in a child realm (harness/registration-realm.ts): load, build
 * every request, run clean, change one intrinsic or write onto
 * Object.prototype after load, run again. Every result must be identical, or
 * a refusal (`ok: false`). A request that becomes registrable, or a changed
 * profile or digest returned for storage, fails the scenario. Plus a source
 * scan of profile-registration.ts.
 */
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const SPEC_DIR = fileURLToPath(new URL("../../", import.meta.url));
const REALM = fileURLToPath(new URL("./harness/registration-realm.ts", import.meta.url));
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
    execFile(process.execPath, [...NODE_ARGS, id], { cwd: SPEC_DIR, encoding: "utf8", timeout: 120_000, maxBuffer: 1 << 26 }, (err, stdout, stderr) => {
      try {
        resolve(JSON.parse(lastLine(stdout)) as Outcome);
      } catch {
        resolve({ scenario: id, clean: [], error: `${err?.message ?? "no result line"} | ${stderr.slice(-800)}` });
      }
    });
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

/** Each request whose result changed and is not a refusal. */
function violations(clean: Row[], patched: Row[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < clean.length; i++) {
    const [, label, before] = clean[i]!;
    const after = patched[i]?.[2];
    const a = JSON.stringify(before);
    const b = JSON.stringify(after);
    if (a === b || after === "threw") continue;
    if (typeof after === "object" && after !== null && (after as { ok: unknown }).ok === false) continue;
    out.push(`${label}: ${a} -> ${b}`);
  }
  if (patched.length !== clean.length) out.push(`${patched.length} rows patched, ${clean.length} clean`);
  return out;
}

describe("registration: nothing changed after load makes a request registrable, or changes what is stored", () => {
  it("the clean run is what the builders say, in every realm (the harness is not vacuous)", () => {
    const reference = OUTCOMES.get(SCENARIOS[0]!)!;
    expect(reference.error).toBeUndefined();
    for (const [, label, value] of reference.clean) {
      expect((value as { ok: boolean }).ok, label).toBe(label.startsWith("accepted:"));
    }
    const all = reference.clean.find((r) => r[1] === "refused: every problem at once")![2] as { problems: { code: string }[] };
    expect(all.problems.map((p) => p.code)).toEqual(["device-mismatch", "capability-type-mismatch", "unverifiable-term", "digest-mismatch"]);
    for (const id of SCENARIOS) expect(OUTCOMES.get(id)?.clean, id).toEqual(reference.clean);
  });

  for (const id of SCENARIOS) {
    it(id, () => {
      const outcome = OUTCOMES.get(id)!;
      expect(outcome.error, "the child realm ran to completion").toBeUndefined();
      expect(outcome.hung, "every request settled").toBeUndefined();
      expect(Array.isArray(outcome.patched), String(outcome.patched)).toBe(true);
      expect(violations(outcome.clean, outcome.patched as Row[])).toEqual([]);
    });
  }
});

// -- source scan: canonical-intrinsics.test.ts's codeOnly, AMBIENT and NO_REGEXP, as in profile-admission-intrinsics.test.ts --
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

describe("source scan: profile-registration.ts", () => {
  it("calls only what util/primordials.ts captured, plain loops and operators, and holds no RegExp", () => {
    const source = readFileSync(fileURLToPath(new URL("../evidence/profile-registration.ts", import.meta.url)), "utf8");
    expect(scan("profile-registration.ts", codeOnly(source), [...AMBIENT, ...NO_REGEXP])).toEqual([]);
  });
});
