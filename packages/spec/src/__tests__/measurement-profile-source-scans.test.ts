/**
 * Source scans of #336's measurement profile and its load-time intrinsics (astra pack 170):
 * measurement-profile.ts and util/primordials.ts call nothing looked up at call time and use no
 * RegExp, and the profile's exported data is frozen. canonicalize is #359's, whose own tests
 * cover its intrinsics (canonical-intrinsics.test.ts).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as profileModule from "../evidence/measurement-profile.js";

describe("source scans: measurement-profile.ts and util/primordials.ts", () => {
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
