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
import { parseScopeColumn, MAX_SCOPE_COLUMN_BYTES } from "../middleware/scope-checker.js";
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
    const big = `["settlement"${" ".repeat(MAX_SCOPE_COLUMN_BYTES)}]`; // valid JSON, only whitespace padding
    expect(parseScopeColumn(big)).toEqual([]);
  });

  it("control: a normal key still parses", () => {
    expect(parseScopeColumn('["operator","settlement"]')).toEqual(["operator", "settlement"]);
    expect(parseScopeColumn("[]")).toEqual([]);
  });
});

describe("the column limit is in UTF-8 BYTES, not characters (round 8, astra FC-7)", () => {
  // "settlement" plus 50 distinct short scopes of 3-byte characters: about 2,300
  // characters, but more than 4,096 UTF-8 bytes. It used to pass the character check.
  const unicodeScopes = ["settlement", ...Array.from({ length: 50 }, (_, i) => `${"€".repeat(28)}${String(i).padStart(2, "0")}`)];
  const raw = JSON.stringify(unicodeScopes);

  it("[neg] the parser grants nothing for a column over 4096 bytes, even if under 4096 characters", () => {
    expect(raw.length).toBeLessThan(MAX_SCOPE_COLUMN_BYTES);
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(MAX_SCOPE_COLUMN_BYTES);
    expect(parseScopeColumn(raw)).toEqual([]);
  });

  it("[neg] minting refuses the same list, so no key is minted that would then hold nothing", () => {
    expect(() => assertMintableScopes(unicodeScopes)).toThrow(/4096 UTF-8 bytes/);
  });

  it("[neg] minting refuses settlement + 63 distinct 64-character ASCII scopes (4,235 bytes; astra authz r2 new defect 2)", () => {
    const scopes = ["settlement", ...Array.from({ length: 63 }, (_, i) => `${"y".repeat(62)}${String(i).padStart(2, "0")}`)];
    expect(Buffer.byteLength(JSON.stringify(scopes), "utf8")).toBe(4235);
    expect(parseScopeColumn(JSON.stringify(scopes))).toEqual([]);
    expect(() => assertMintableScopes(scopes)).toThrow(/4096 UTF-8 bytes/);
  });

  it("control: a normal list mints and parses", () => {
    expect(() => assertMintableScopes(["operator", "settlement"])).not.toThrow();
    expect(parseScopeColumn(JSON.stringify(["operator", "settlement"]))).toEqual(["operator", "settlement"]);
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
