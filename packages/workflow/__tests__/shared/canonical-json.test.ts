import { describe, it, expect } from "vitest";
import {
  canonicalJSON,
  canonicalJSONStrict,
  parseCanonical,
} from "../../src/shared/canonical-json.js";

describe("canonicalJSON — primitives", () => {
  it("serializes strings using JSON.stringify escaping rules", () => {
    expect(canonicalJSON("hello")).toBe('"hello"');
    expect(canonicalJSON('with "quotes" and \\ backslash')).toBe(
      '"with \\"quotes\\" and \\\\ backslash"',
    );
    expect(canonicalJSON("")).toBe('""');
  });

  it("serializes booleans and null", () => {
    expect(canonicalJSON(true)).toBe("true");
    expect(canonicalJSON(false)).toBe("false");
    expect(canonicalJSON(null)).toBe("null");
  });

  it("serializes finite numbers", () => {
    expect(canonicalJSON(0)).toBe("0");
    expect(canonicalJSON(-42)).toBe("-42");
    expect(canonicalJSON(3.14)).toBe("3.14");
    expect(canonicalJSON(1e10)).toBe("10000000000");
  });

  it("treats undefined at root as null", () => {
    // Both undefined and null produce 'null' at top-level per the impl contract.
    expect(canonicalJSON(undefined)).toBe("null");
    expect(canonicalJSON(null)).toBe("null");
  });

  it("throws on NaN and Infinity", () => {
    expect(() => canonicalJSON(Number.NaN)).toThrow(/non-finite/i);
    expect(() => canonicalJSON(Number.POSITIVE_INFINITY)).toThrow(/non-finite/i);
    expect(() => canonicalJSON(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/i);
  });

  it("throws on bigint", () => {
    // Cast through unknown because the public type forbids bigint at the type level.
    expect(() => canonicalJSON(10n as unknown as never)).toThrow(/bigint/i);
  });
});

describe("canonicalJSON — objects & key ordering", () => {
  it("sorts keys lexicographically at every depth", () => {
    const input = { b: 1, a: 2, c: { y: 1, x: 2 } };
    expect(canonicalJSON(input)).toBe('{"a":2,"b":1,"c":{"x":2,"y":1}}');
  });

  it("produces byte-identical output regardless of insertion order", () => {
    const a = canonicalJSON({ foo: 1, bar: 2, baz: 3 });
    const b = canonicalJSON({ baz: 3, bar: 2, foo: 1 });
    const c = canonicalJSON({ bar: 2, baz: 3, foo: 1 });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("omits undefined values in objects but preserves null", () => {
    const obj = { a: 1, b: undefined, c: null } as Record<string, unknown>;
    // undefined keys stripped, null kept
    expect(canonicalJSON(obj as never)).toBe('{"a":1,"c":null}');
  });

  it("handles deeply nested mixed objects/arrays deterministically", () => {
    const input = {
      z: [3, 2, 1],
      a: { q: [{ c: 1, b: 2 }], p: "hi" },
    };
    expect(canonicalJSON(input)).toBe(
      '{"a":{"p":"hi","q":[{"b":2,"c":1}]},"z":[3,2,1]}',
    );
  });
});

describe("canonicalJSON — arrays", () => {
  it("preserves array order", () => {
    expect(canonicalJSON([3, 1, 2])).toBe("[3,1,2]");
  });

  it("serializes empty arrays and empty objects", () => {
    expect(canonicalJSON([])).toBe("[]");
    expect(canonicalJSON({})).toBe("{}");
  });

  it("converts undefined elements to null (JSON.stringify parity)", () => {
    // Using unknown[] to satisfy typing; undefined in arrays must not break serialization.
    const arr = [1, undefined, 2] as unknown as never;
    expect(canonicalJSON(arr)).toBe("[1,null,2]");
  });
});

describe("canonicalJSONStrict & parseCanonical roundtrip", () => {
  it("canonicalJSONStrict accepts CanonicalInput", () => {
    const input = { a: [1, 2], b: "x" };
    expect(canonicalJSONStrict(input)).toBe('{"a":[1,2],"b":"x"}');
  });

  it("parseCanonical roundtrips cleanly", () => {
    const value = { a: { b: [1, 2] }, c: true, d: null };
    const s = canonicalJSON(value);
    const parsed = parseCanonical<typeof value>(s);
    expect(parsed).toEqual(value);
    // And re-serializing yields the identical byte string.
    expect(canonicalJSON(parsed as never)).toBe(s);
  });
});

describe("canonicalJSON — edge cases", () => {
  it("unicode strings serialize consistently", () => {
    // Matches JSON.stringify for non-ASCII (which leaves most chars untouched).
    expect(canonicalJSON("café 日本")).toBe(JSON.stringify("café 日本"));
  });

  it("objects containing numeric-looking keys are sorted lexicographically (string sort)", () => {
    const input = { "10": "a", "2": "b", "1": "c" } as Record<string, unknown>;
    // Lexicographic order: "1" < "10" < "2"
    expect(canonicalJSON(input as never)).toBe('{"1":"c","10":"a","2":"b"}');
  });
});
