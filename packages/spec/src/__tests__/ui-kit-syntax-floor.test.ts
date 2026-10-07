import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintUiKitSyntaxFloor } from "./ui-kit-syntax-floor.js";

const kitFile = fileURLToPath(new URL("../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js", import.meta.url));
const kit = readFileSync(kitFile, "utf8");

const syntaxMutations = [
  ["let declaration", "let t = 1;", "ES2015 lexical declaration"],
  ["const declaration", "const t = 1;", "ES2015 lexical declaration"],
  ["arrow", "var f = function () {}; var g = () => 1;", "ES2015 arrow function"],
  ["template", "var t = `copy`;", "ES2015 template literal"],
  ["interpolated template", "var t = `copy ${raw}`;", "ES2015 template literal"],
  ["object spread", "var t = { ...raw };", "ES2015 spread or rest"],
  ["array spread", "var t = [...raw];", "ES2015 spread or rest"],
  ["call spread", "f(...raw);", "ES2015 spread or rest"],
  ["rest parameter", "function f(...raw) {}", "ES2015 spread or rest"],
  ["object destructuring", "var { t } = raw;", "ES2015 destructuring"],
  ["array destructuring", "var [t] = raw;", "ES2015 destructuring"],
  ["object assignment destructuring", "({ t: x } = raw);", "ES2015 destructuring"],
  ["array assignment destructuring", "[x] = raw;", "ES2015 destructuring"],
  ["for-of", "for (var t of raw) {}", "ES2015 for-of"],
  ["class", "class T {}", "ES2015 class"],
  ["class expression", "var t = class {};", "ES2015 class"],
  ["default parameter", "function f(t = raw) {}", "ES2015 default parameter"],
  ["optional catch binding", "try {} catch {}", "ES2019 optional catch binding"],
  ["string code point escape", 'var t = "\\u{1F4B0}";', "ES2015 Unicode code point escape"],
  ["identifier code point escape", 'var \\u{61} = 1;', "ES2015 Unicode code point escape"],
  ["trailing parameter comma", "function f(raw,) {}", "ES2017 trailing parameter comma"],
  ["trailing call comma", "f(raw,);", "ES2017 trailing argument comma"],
  ["trailing constructor comma", "new F(raw,);", "ES2017 trailing argument comma"],
  ["optional property", "raw?.t;", "ES2020 optional chain"],
  ["optional element", "raw?.[t];", "ES2020 optional chain"],
  ["optional call", "raw?.();", "ES2020 optional chain"],
  ["nullish", "raw ?? t;", "ES2020 nullish operator"],
  ["nullish assignment", "raw ??= t;", "ES2020 nullish operator"],
  ["exponentiation", "raw ** 2;", "ES2016 exponentiation"],
  ["exponentiation assignment", "raw **= 2;", "ES2016 exponentiation"],
  ["logical and assignment", "raw &&= t;", "ES2021 logical assignment"],
  ["logical or assignment", "raw ||= t;", "ES2021 logical assignment"],
  ["computed property", "var t = { [key]: raw };", "ES2015 computed property name"],
  ["shorthand property", "var t = { raw };", "ES2015 shorthand property"],
  ["object method", "var t = { f() {} };", "ES2015 method syntax"],
  ["generator", "function* f() {}", "ES2015 generator"],
  ["yield", "function* f() { yield raw; }", "ES2015 yield"],
  ["async", "async function f() {}", "ES2017 async syntax"],
  ["await", "async function f() { await raw; }", "ES2017 async syntax"],
  ["new target", "function f() { return new.target; }", "ES2015 meta property"],
  ["import", 'import t from "pkg";', "ES2015 module syntax"],
  ["export", "export var t = 1;", "ES2015 module syntax"],
  ["dynamic import", 'import("pkg");', "ES2015 module syntax"],
  ["bigint", "var t = 1n;", "ES2020 bigint literal"],
  ["binary number", "var t = 0b10;", "ES2015 binary or octal literal"],
  ["octal number", "var t = 0o10;", "ES2015 binary or octal literal"],
  ["numeric separator", "var t = 1_000;", "ES2021 numeric separator"],
] as const;

describe("plain kit ES5 syntax and ES2015 runtime floor", () => {
  it("has no post-ES5 syntax, modern regex literals, or unguarded newer API calls", () => {
    expect(lintUiKitSyntaxFloor(kit, kitFile)).toEqual([]);
  });
  it.each(syntaxMutations)("reports injected %s on its own line", (_name, source, rule) => {
    const prefix = kit + "\n";
    expect(lintUiKitSyntaxFloor(prefix + source, kitFile)).toContainEqual(expect.objectContaining({ line: prefix.split("\n").length, rule }));
  });
  it.each([
    "/copy/u", "/copy/y", "/copy/s", "/copy/d", "/copy/v",
    "/(?<!copy)x/", "/(?<=copy)x/", "/(?<name>copy)/",
    "/\\p{L}/", "/\\P{L}/", "/\\u{1F4B0}/",
  ])("reports injected modern regex literal %s", (regex) => {
    const prefix = kit + "\n";
    expect(lintUiKitSyntaxFloor(prefix + "var probe = " + regex + ";", kitFile)).toContainEqual(expect.objectContaining({ line: prefix.split("\n").length, rule: "post-ES5 regular expression literal" }));
  });
  it.each([
    ["fromEntries", "Object.fromEntries(raw)"],
    ["flatMap", "raw.flatMap(f)"],
    ["padEnd", 'raw.padEnd(3, "0")'],
    ["padStart", 'raw["padStart"](3, "0")'],
    ["includes", "raw.includes(t)"],
  ])("reports injected %s API outside guarded init", (name, source) => {
    const prefix = kit + "\n";
    expect(lintUiKitSyntaxFloor(prefix + source + ";", kitFile)).toContainEqual(expect.objectContaining({ line: prefix.split("\n").length, rule: "post-ES2015 API outside guarded detector init: " + name }));
  });
  it("permits ES5 syntax, regex literals and ES2015 built-ins", () => {
    expect(lintUiKitSyntaxFloor('var t = {}; var d = Object.create(null); t[k] = raw; function f(x) { return x; } var r = /copy/gim; var m = new Map(); var s = new Set(); var w = new WeakSet(); Object.assign({}, t); Object.freeze(t); raw.normalize("NFKC");')).toEqual([]);
  });
  it("permits modern constructors and newer APIs only under the detector catch, including an immediately executed builder", () => {
    const direct = 'function initClaimDetector() { try { var r = new RegExp("\\\\p{L}", "u"); raw.padEnd(3); } catch (e) { return null; } }';
    expect(lintUiKitSyntaxFloor(direct)).toEqual([]);
    expect(lintUiKitSyntaxFloor('function initClaimDetector() { try { return (function () { var r = new RegExp("(?<!x)y"); raw.padEnd(3); return r; })(); } catch (e) { return null; } }')).toEqual([]);
    expect(lintUiKitSyntaxFloor(direct.replace("try {", "{"))).not.toEqual([]);
    expect(lintUiKitSyntaxFloor('function initClaimDetector() { try { function deferred() { raw.padEnd(3); } } catch (e) { return null; } }')).toContainEqual(expect.objectContaining({ rule: "post-ES2015 API outside guarded detector init: padEnd" }));
    expect(lintUiKitSyntaxFloor('function initClaimDetector() { raw.padEnd(3); try {} catch (e) { return null; } }')).toContainEqual(expect.objectContaining({ rule: "post-ES2015 API outside guarded detector init: padEnd" }));
  });
  it("rejects a regex constructor that can throw before the guarded init", () => {
    expect(lintUiKitSyntaxFloor('var r = new RegExp("(?<!x)y");')).toContainEqual(expect.objectContaining({ rule: "RegExp construction outside guarded detector init" }));
  });
  it("rejects a second detector init", () => {
    expect(lintUiKitSyntaxFloor(kit + '\nfunction initClaimDetector() { try {} catch (e) {} }', kitFile)).toContainEqual(expect.objectContaining({ rule: "detector init must have at most one definition" }));
  });
  it("permits ordinary ES5 string escapes and escaped regex source in strings", () => {
    expect(lintUiKitSyntaxFloor('var t = "\\u2800"; var pattern = "\\\\u{1F4B0}";')).toEqual([]);
  });
});
