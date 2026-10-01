import { describe, it, expect } from "vitest";
import { NonCanonicalValueError, canonicalSnapshot, canonicalize } from "../util/canonical.js";
import * as spec from "../index.js";

/**
 * N15 round 4 (cross-family review A05b, finding 3): a consumer that must
 * evaluate what it hashed canonicalizes FIRST, parses the canonical text ONCE,
 * and reads that parsed snapshot, never the object it was handed. canonicalSnapshot
 * is that sequence in one place, so every caller shares one audited
 * implementation (and one captured JSON.parse).
 */

const sample = () => ({
  z: [1, "two", null, { b: 2, a: [true, false] }],
  a: { nested: { deep: -0 } },
  skip: undefined,
  o: Object.assign(Object.create(null), { k: "v" }),
});

describe("canonicalSnapshot (N15 round 4, A05b #3)", () => {
  it("returns the canonical text and the value parsed from exactly that text", () => {
    const input = sample();
    const snapshot = canonicalSnapshot(input);
    expect(snapshot.text).toBe(canonicalize(input));
    expect(snapshot.value).toEqual(JSON.parse(snapshot.text));
    expect(snapshot.value).toEqual({ a: { nested: { deep: 0 } }, o: { k: "v" }, z: [1, "two", null, { a: [true, false], b: 2 }] });
  });

  it("the snapshot hashes back to the same text: canonicalize(value) === text", () => {
    const { text, value } = canonicalSnapshot(sample());
    expect(canonicalize(value)).toBe(text);
  });

  it("is a detached copy: neither side can change the other afterwards", () => {
    const input = { list: [1, 2], obj: { k: "v" } };
    const { text, value } = canonicalSnapshot<{ list: number[]; obj: { k: string } }>(input);
    expect(value).not.toBe(input);
    expect(value.list).not.toBe(input.list);
    input.list.push(3);
    input.obj.k = "changed";
    expect(value).toEqual({ list: [1, 2], obj: { k: "v" } });
    value.list.push(99);
    expect(canonicalize(input)).toBe('{"list":[1,2,3],"obj":{"k":"changed"}}');
    expect(text).toBe('{"list":[1,2],"obj":{"k":"v"}}');
  });

  it("reads a Proxy through its reflection traps only: the snapshot is what the descriptors say, and get never runs", () => {
    let gets = 0;
    const proxy = new Proxy({ command: "safe" } as Record<string, unknown>, {
      get(target, key, receiver) {
        gets++;
        return key === "command" ? "danger" : Reflect.get(target, key, receiver);
      },
    });
    const { text, value } = canonicalSnapshot<{ command: string }>(proxy);
    expect(text).toBe('{"command":"safe"}');
    expect(value.command).toBe("safe");
    expect(gets).toBe(0);
  });

  it("refuses what canonicalize refuses, with the same typed error and path", () => {
    for (const [input, path] of [
      [{ n: Number.NaN }, "$.n"],
      [[1, undefined], "$[1]"],
      [undefined, "$"],
      [Object.defineProperty({}, "x", { get: () => 1, enumerable: true }), "$.x"],
      [{ m: new Map() }, "$.m"],
    ] as Array<[unknown, string]>) {
      let error: unknown;
      try {
        canonicalSnapshot(input);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(NonCanonicalValueError);
      expect((error as NonCanonicalValueError).path).toBe(path);
    }
  });

  it("keeps a '__proto__' member as plain data and never as a prototype", () => {
    const { value } = canonicalSnapshot<Record<string, unknown>>(JSON.parse('{"__proto__":{"x":1},"k":[]}'));
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(value, "__proto__")).toBe(true);
    expect((value as { x?: unknown }).x).toBeUndefined();
  });

  it("parses with the JSON.parse captured at load: replacing it afterwards changes nothing", () => {
    const input = sample();
    const expected = canonicalSnapshot(input);
    const original = JSON.parse;
    let outcome: { text: string; value: unknown } | undefined;
    let failure: unknown;
    JSON.parse = () => {
      throw new Error("polluted JSON.parse ran");
    };
    try {
      outcome = canonicalSnapshot(input);
    } catch (e) {
      failure = e;
    } finally {
      JSON.parse = original;
    }
    expect(failure).toBeUndefined();
    expect(outcome).toEqual(expected);
  });

  it("is exported from the package root next to canonicalize", () => {
    expect(spec.canonicalSnapshot).toBe(canonicalSnapshot);
    expect(spec.canonicalize).toBe(canonicalize);
  });
});
