/**
 * WP-A round 5 (sol #2963): parseScopeColumn internals that could not be certified.
 * Every layer reads scopes through this parser (scope-checker, DLP redactor,
 * introspection, delegation). It must grant NOTHING for:
 * - an empty value;
 * - a value over 4 KB (refused before JSON.parse);
 * - more than 64 entries;
 * - an empty or over-64-character entry;
 * - any duplicate.
 * Minting refuses the same shapes, so no legitimately minted key can hit them.
 */
import { describe, it, expect } from "vitest";
import { parseScopeColumn, MAX_SCOPE_COLUMN_CHARS } from "../middleware/scope-checker.js";
import { assertMintableScopes } from "../auth/api-key-auth.js";

describe("parseScopeColumn limits", () => {
  it.each<[string, string]>([
    ["an empty value", ""],
    ["a duplicated scope", '["settlement","settlement"]'],
    ["a duplicate hiding among others", '["operator","settlement","operator"]'],
    ["an empty entry", '["settlement",""]'],
    ["an over-64-character entry", JSON.stringify(["settlement", "x".repeat(65)])],
    ["more than 64 entries", JSON.stringify(["settlement", ...Array.from({ length: 64 }, (_, i) => `s${i}`)])],
    // 64 entries of 64 characters: within the count and entry limits, over 4 KB in total.
    ["a value over 4 KB", JSON.stringify(["settlement", ...Array.from({ length: 63 }, (_, i) => `${"y".repeat(62)}${String(i).padStart(2, "0")}`)])],
  ])("[neg] %s grants nothing", (_name, raw) => {
    expect(parseScopeColumn(raw)).toEqual([]);
  });

  it("the size check applies before parsing", () => {
    const big = `["settlement"${" ".repeat(MAX_SCOPE_COLUMN_CHARS)}]`; // valid JSON, only whitespace padding
    expect(parseScopeColumn(big)).toEqual([]);
  });

  it("control: a normal key still parses", () => {
    expect(parseScopeColumn('["operator","settlement"]')).toEqual(["operator", "settlement"]);
    expect(parseScopeColumn("[]")).toEqual([]);
  });
});

describe("minting refuses what the parser would refuse", () => {
  it.each<[string, string[]]>([
    ["duplicates", ["operator", "operator"]],
    ["an over-64-character scope", ["x".repeat(65)]],
    ["more than 64 scopes", Array.from({ length: 65 }, (_, i) => `s${i}`)],
  ])("[neg] %s", (_name, scopes) => {
    expect(() => assertMintableScopes(scopes)).toThrow(/at most 64 distinct scopes/);
  });
});
