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
    // A05c F1: this test used to assert Object.prototype here. That inherited prototype was the
    // finding: a polluted Object.prototype could supply members that were never hashed. The snapshot
    // is now prototype-less, so the own "__proto__" key is still plain data and still never becomes
    // a prototype, and there is no Object.prototype behind the object to inherit anything from.
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(value, "__proto__")).toBe(true);
    const own = Object.getOwnPropertyDescriptor(value, "__proto__");
    expect(own).toMatchObject({ writable: true, enumerable: true, configurable: true });
    expect(own?.value).toEqual({ x: 1 });
    expect(Object.getPrototypeOf(own?.value)).toBeNull();
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

// ---------------------------------------------------------------------------
// N15 round 5 (cross-family review A05c, finding F1)
// ---------------------------------------------------------------------------

/**
 * The snapshot used to be a plain JSON.parse tree, so every object in it inherited
 * Object.prototype. All three consumers read it with ordinary property reads, so a
 * polluted prototype supplied members that were never hashed (the verdict's
 * repros: an inherited `proof` made an unsigned credential verify, an inherited
 * `command` reached a builder that was given {}, an inherited `entries` fed an empty
 * ledger). The snapshot is now prototype-less at every depth: a key it does not own
 * reads as undefined. Arrays stay ordinary arrays; every index below their length
 * is an own element.
 */

/** Object.prototype's own names when this file loaded, before any test could pollute it. */
const OBJECT_PROTOTYPE_AT_LOAD = Object.getOwnPropertyNames(Object.prototype).sort();

/**
 * Install `members` on Object.prototype (plain assignment, as an attacker does it) while `fn`
 * runs, and always take them off again, even when `fn` throws. Only `fn` runs inside the window:
 * build inputs first and assert after it returns.
 */
function withPollutedPrototype<T>(members: Record<string, unknown>, fn: () => T): T {
  const target = Object.prototype as unknown as Record<string, unknown>;
  const names = Object.keys(members);
  try {
    for (const name of names) target[name] = members[name];
    return fn();
  } finally {
    for (const name of names) delete target[name];
  }
}

/** Every non-array object and every array reachable from `root` (root included), found by walking own keys. */
function walk(root: unknown): { objects: object[]; arrays: unknown[][] } {
  const objects: object[] = [];
  const arrays: unknown[][] = [];
  const visit = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      arrays.push(v);
      for (let i = 0; i < v.length; i++) visit(v[i]);
      return;
    }
    objects.push(v);
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(root);
  return { objects, arrays };
}

describe("canonicalSnapshot -- a prototype-less tree (N15 round 5, A05c F1)", () => {
  it("A05c F1: every object in the snapshot has a null prototype, at every depth; arrays stay ordinary arrays", () => {
    const { value } = canonicalSnapshot(sample());
    const { objects, arrays } = walk(value);
    expect(objects.length).toBeGreaterThan(4); // the walk really reached the nested objects
    for (const o of objects) expect(Object.getPrototypeOf(o)).toBeNull();
    expect(arrays.length).toBeGreaterThan(1);
    for (const a of arrays) expect(Object.getPrototypeOf(a)).toBe(Array.prototype);
  });

  it("A05c F1: a polluted Object.prototype supplies nothing at any depth: a key the input does not own reads as undefined", () => {
    const input = { top: 1, list: [{ item: 2 }], nested: { deeper: { leaf: 3 } } };
    const polluted = {
      command: "danger",
      proof: "forged",
      entries: ["from the prototype"],
      top: "inherited",
      item: "inherited",
      leaf: "inherited",
    };
    const reads = withPollutedPrototype(polluted, () => {
      // built AND read while the prototype is dirty
      const v = canonicalSnapshot<any>(input).value;
      return {
        own: [v.top, v.list[0].item, v.nested.deeper.leaf],
        missing: [v.command, v.proof, v.entries, v.list[0].command, v.nested.command, v.nested.deeper.proof],
        has: ["command" in v, "command" in v.list[0], "entries" in v.nested.deeper],
      };
    });
    expect(reads.own).toEqual([1, 2, 3]); // own members still win
    expect(reads.missing).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(reads.has).toEqual([false, false, false]);
  });

  it("A05c F1: for...in and `in` see only own members, even when the pollution is enumerable", () => {
    const seen = withPollutedPrototype({ injected: "yes" }, () => {
      const v = canonicalSnapshot<any>({ a: 1, n: { b: 2 } }).value;
      const top: string[] = [];
      for (const k in v) top.push(k);
      const inner: string[] = [];
      for (const k in v.n) inner.push(k);
      return { top, inner, has: "injected" in v };
    });
    expect(seen).toEqual({ top: ["a", "n"], inner: ["b"], has: false });
  });

  it("A05c F1: own members are plain data properties (writable, enumerable, configurable), '__proto__' included, in JSON.parse key order", () => {
    const input = JSON.parse('{"b":1,"a":{"__proto__":{"x":1}},"10":"ten","2":"two"}');
    const { text, value } = canonicalSnapshot<any>(input);
    expect(Object.keys(value)).toEqual(Object.keys(JSON.parse(text))); // integer-like keys first, then the canonical order
    for (const key of Object.keys(value)) {
      expect(Object.getOwnPropertyDescriptor(value, key), key).toMatchObject({ writable: true, enumerable: true, configurable: true });
    }
    expect(Object.keys(value.a)).toEqual(["__proto__"]);
    const own = Object.getOwnPropertyDescriptor(value.a, "__proto__");
    expect(own).toMatchObject({ writable: true, enumerable: true, configurable: true });
    expect(Object.getPrototypeOf(value.a)).toBeNull();
    expect(Object.getPrototypeOf(own?.value)).toBeNull();
  });

  it("the text is canonicalize(input), byte for byte; the tree is the same data as JSON.parse(text); re-snapshotting it changes nothing", () => {
    const input = sample();
    const { text, value } = canonicalSnapshot(input);
    expect(text).toBe(canonicalize(input));
    expect(JSON.stringify(value)).toBe(JSON.stringify(JSON.parse(text)));
    const again = canonicalSnapshot(value);
    expect(again.text).toBe(text);
    expect(Object.getPrototypeOf(again.value)).toBeNull();
  });

  it("A05c F1: is immune to pollution of the descriptor field names: it writes its members with prototype-less descriptors", () => {
    // An inherited `get` or `set` turns an ordinary { value, writable, ... } descriptor into an invalid
    // accessor-and-value descriptor, so a literal descriptor would make the snapshot throw here.
    const input = sample();
    const expected = canonicalSnapshot(input);
    const outcome = withPollutedPrototype(
      { get: () => "POISON", set: () => "POISON", value: "POISON", writable: false, enumerable: false, configurable: false },
      () => {
        try {
          return { ok: true as const, snapshot: canonicalSnapshot(input) };
        } catch (failure) {
          return { ok: false as const, failure };
        }
      },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.snapshot.text).toBe(expected.text);
      expect(outcome.snapshot.value).toEqual(expected.value);
      expect(Object.getPrototypeOf(outcome.snapshot.value)).toBeNull();
    }
  });

  it("A05c F1: builds the tree with the intrinsics captured at load: replacing them afterwards changes nothing", () => {
    const input = sample();
    const expected = canonicalSnapshot(input);
    const holders: Array<[object, string]> = [
      [Object, "create"],
      [Reflect, "defineProperty"],
      [Reflect, "ownKeys"],
      [Reflect, "getOwnPropertyDescriptor"],
      [Array, "isArray"],
      [JSON, "parse"],
    ];
    const saved = holders.map(([holder, key]) => Object.getOwnPropertyDescriptor(holder, key) as PropertyDescriptor);
    let outcome: { text: string; value: unknown } | undefined;
    let failure: unknown;
    for (const [holder, key] of holders) {
      Object.defineProperty(holder, key, {
        value: () => {
          throw new Error("polluted " + key + " ran inside canonicalSnapshot");
        },
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
    try {
      outcome = canonicalSnapshot(input);
    } catch (e) {
      failure = e;
    } finally {
      holders.forEach(([holder, key], i) => Object.defineProperty(holder, key, saved[i]));
    }
    expect(failure).toBeUndefined();
    expect(outcome).toEqual(expected);
    expect(Object.getPrototypeOf(outcome?.value)).toBeNull();
  });

  it("a deep value round-trips as a prototype-less tree, and an absurdly deep one is still a typed refusal", () => {
    let deep: unknown = 0;
    for (let i = 0; i < 400; i++) deep = i % 2 ? [deep] : { k: deep };
    const { text, value } = canonicalSnapshot(deep);
    expect(canonicalize(value)).toBe(text);
    for (const o of walk(value).objects) expect(Object.getPrototypeOf(o)).toBeNull();
    let tooDeep: unknown = 0;
    for (let i = 0; i < 100_000; i++) tooDeep = [tooDeep];
    expect(() => canonicalSnapshot(tooDeep)).toThrow(NonCanonicalValueError);
  });

  it("a wide object keeps every member and its order", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 20_000; i++) wide["k" + ((i * 2654435761) >>> 0).toString(36)] = i;
    const { text, value } = canonicalSnapshot<Record<string, number>>(wide);
    expect(Object.keys(value)).toEqual(Object.keys(JSON.parse(text)));
    expect(Object.keys(value).length).toBe(20_000);
    expect(Object.getPrototypeOf(value)).toBeNull();
  });

  it("leaves Object.prototype exactly as it found it (no test above leaks a pollution)", () => {
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(OBJECT_PROTOTYPE_AT_LOAD);
  });
});
