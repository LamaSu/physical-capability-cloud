import { describe, it, expect } from "vitest";
import { NonCanonicalValueError, canonicalize } from "../util/canonical.js";

/**
 * N15 round 4 (cross-family review A05b, finding 1): the encoder assembled its
 * text in ordinary arrays (push / sort / join), so an indexed setter on
 * Array.prototype, or a replaced Array.prototype method, rewrote the bytes of a
 * "trusted" snapshot. These tests pollute the realm AFTER the module loaded and
 * require the output to stay byte-identical, for every intrinsic the encoder
 * could reach at call time.
 *
 * Nothing but the canonicalize call runs inside a pollution window: inputs and
 * expectations are built first, and assertions run after the window closes.
 */

// The test's own reflection, captured at load, so installing and removing the
// pollution keeps working while the very intrinsics under test are replaced.
const defineProperty = Reflect.defineProperty;
const deleteProperty = Reflect.deleteProperty;
const getOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const ownKeys = Reflect.ownKeys;
const toKey = String; // the global binding is itself replaced inside some windows
const ARRAY_PROTOTYPE = Array.prototype;

type Restore = () => void;

const LS = String.fromCharCode(0x2028); // JSON.stringify leaves U+2028 unescaped

/** Walks every encoder path: nesting, sorting (numeric-like, unicode, empty keys), escapes, numbers, omitted members. */
const sample = (): unknown => ({
  z: [1, "two", null, true, { b: 2, a: 1, "10": "ten", "2": "two", "é": "acute", Z: "upper", "": "empty" }],
  alpha: "é" + String.fromCharCode(0) + '"' + "\\" + "\n" + "\t" + LS,
  mid: {
    nested: { deep: [true, false, -0, 1.5e-7, 5e-324, 9007199254740991, -9007199254740991, 0.30000000000000004] },
    aa: 1,
    a: 2,
    "~": 3,
    _: 4,
    "0": 5,
    "00": 6,
    "😀": 7,
  },
  skip: undefined,
  o: Object.assign(Object.create(null), { k: "v", j: [] }),
  list: [[], {}, [[]], [{}]],
  wide: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`k${(i * 7) % 24}`, i])),
  run: Array.from({ length: 24 }, (_, i) => i * 3),
  long: "x".repeat(8),
});

/** The bytes round 3 (bcdf140a) wrote for sample(). The output of the encoder must never change. */
const EXPECTED =
  '{"alpha":"é\\u0000\\"\\\\\\n\\t' + LS + '","list":[[],{},[[]],[{}]],"long":"xxxxxxxx","mid":{"0":5,"00":6,"_":4,"a":2,"aa":1,"nested":{"deep":[true,false,0,1.5e-7,5e-324,9007199254740991,-9007199254740991,0.30000000000000004]},"~":3,"😀":7},"o":{"j":[],"k":"v"},"run":[0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57,60,63,66,69],"wide":{"k0":0,"k1":7,"k10":22,"k11":5,"k12":12,"k13":19,"k14":2,"k15":9,"k16":16,"k17":23,"k18":6,"k19":13,"k2":14,"k20":20,"k21":3,"k22":10,"k23":17,"k3":21,"k4":4,"k5":11,"k6":18,"k7":1,"k8":8,"k9":15},"z":[1,"two",null,true,{"":"empty","10":"ten","2":"two","Z":"upper","a":1,"b":2,"é":"acute"}]}';

/** An independent reference encoder for plain JSON trees (test-only; always runs before any pollution). */
function oracle(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return "[" + v.map(oracle).join(",") + "]";
  const o = v as Record<string, unknown>;
  return (
    "{" +
    Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + oracle(o[k]))
      .join(",") +
    "}"
  );
}

// ── pollution helpers ───────────────────────────────────────────────────────

const thrower = (what: string) => () => {
  throw new Error(`polluted ${what} ran inside canonicalize`);
};

interface Slot {
  holder: object;
  key: PropertyKey;
  name: string;
  previous: PropertyDescriptor | undefined;
}

/** Prepare phase (normal code): every own function-valued data property of `holder`. */
function functionSlots(label: string, holder: object, into: Slot[]): void {
  for (const key of ownKeys(holder)) {
    if (key === "constructor") continue;
    const d = getOwnPropertyDescriptor(holder, key);
    if (d !== undefined && typeof d.value === "function") {
      into.push({ holder, key, name: `${label}.${String(key)}`, previous: d });
    }
  }
}

/** Apply phase: plain indexed loops only, because the iterators and array methods are being replaced. */
function replaceWithThrowers(slots: Slot[]): Restore {
  const count = slots.length;
  for (let i = 0; i < count; i++) {
    const slot = slots[i];
    defineProperty(slot.holder, slot.key, { value: thrower(slot.name), writable: true, configurable: true, enumerable: false });
  }
  return () => {
    for (let i = 0; i < count; i++) {
      const slot = slots[i];
      if (slot.previous) defineProperty(slot.holder, slot.key, slot.previous);
      else deleteProperty(slot.holder, slot.key);
    }
  };
}

function replaceOne(holder: object, key: PropertyKey, value: unknown): Restore {
  const previous = getOwnPropertyDescriptor(holder, key);
  defineProperty(holder, key, { value, writable: true, configurable: true, enumerable: previous?.enumerable ?? false });
  return () => {
    if (previous) defineProperty(holder, key, previous);
    else deleteProperty(holder, key);
  };
}

/** Indexed accessors on `holder`: a getter that returns poison and a setter that throws. */
function indexedTraps(holder: object, count: number): Restore {
  for (let i = 0; i < count; i++) {
    const key = toKey(i);
    if (getOwnPropertyDescriptor(holder, key) !== undefined) throw new Error("test precondition: index already defined");
    defineProperty(holder, key, { configurable: true, get: () => "POISON", set: thrower(`indexed setter [${i}]`) });
  }
  return () => {
    for (let i = 0; i < count; i++) deleteProperty(holder, toKey(i));
  };
}

/** The verdict's repro: an indexed setter that quietly rewrites the collected key "a" to "b". */
function rewriteKeyA(): Restore {
  const previous = getOwnPropertyDescriptor(ARRAY_PROTOTYPE, "0");
  defineProperty(ARRAY_PROTOTYPE, "0", {
    configurable: true,
    set(this: unknown[], value: unknown) {
      defineProperty(this, "0", { configurable: true, enumerable: true, writable: true, value: value === "a" ? "b" : value });
    },
  });
  return () => {
    if (previous) defineProperty(ARRAY_PROTOTYPE, "0", previous);
    else deleteProperty(ARRAY_PROTOTYPE, "0");
  };
}

interface Outcome {
  threw: boolean;
  result: string | undefined;
  failure: unknown;
}

/** Run `fn` with the pollution live. Only `fn` runs inside the window; the result is read after it closes. */
function polluted(install: () => Restore, fn: () => string): Outcome {
  const restore = install();
  try {
    return { threw: false, result: fn(), failure: undefined };
  } catch (failure) {
    return { threw: true, result: undefined, failure };
  } finally {
    restore();
  }
}

/** Every intrinsic holder the encoder (or a refactor of it) could reach, plus the global bindings. */
function everythingSlots(): Slot[] {
  const slots: Slot[] = [];
  const holders: Array<[string, object]> = [
    ["Array.prototype", ARRAY_PROTOTYPE],
    ["Object.prototype", Object.prototype],
    ["Function.prototype", Function.prototype],
    ["String.prototype", String.prototype],
    ["Number.prototype", Number.prototype],
    ["Boolean.prototype", Boolean.prototype],
    ["Symbol.prototype", Symbol.prototype],
    ["WeakSet.prototype", WeakSet.prototype],
    ["WeakMap.prototype", WeakMap.prototype],
    ["Set.prototype", Set.prototype],
    ["Map.prototype", Map.prototype],
    ["JSON", JSON],
    ["Reflect", Reflect],
    ["Object", Object],
    ["Array", Array],
    ["Number", Number],
    ["String", String],
    ["Math", Math],
    ["%ArrayIteratorPrototype%", Object.getPrototypeOf([][Symbol.iterator]())],
  ];
  for (const [label, holder] of holders) functionSlots(label, holder, slots);
  for (const name of ["String", "Number", "Boolean", "Symbol", "Object", "Array", "JSON", "Reflect", "WeakSet", "Set", "Map", "Function", "Math"]) {
    slots.push({ holder: globalThis, key: name, name: `globalThis.${name}`, previous: getOwnPropertyDescriptor(globalThis, name) });
  }
  return slots;
}

/** Everything replaced at once, plus indexed accessors on both prototypes an array write could reach. */
function installEverything(): Restore {
  // Order matters: build the slot list with ordinary code first, then install the indexed accessors
  // (which write no array), and only then replace the intrinsics this helper itself would need.
  const slots = everythingSlots();
  const undoArrayIndices = indexedTraps(ARRAY_PROTOTYPE, 100);
  const undoObjectIndices = indexedTraps(Object.prototype, 100);
  const undoReplacements = replaceWithThrowers(slots);
  return () => {
    undoReplacements();
    undoObjectIndices();
    undoArrayIndices();
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("canonicalize — round 4 (cross-family A05b #1): no mutable array or intrinsic behavior can change the bytes", () => {
  it("anchors the clean bytes: round 3's output, and an independent reference encoder agrees", () => {
    expect(canonicalize(sample())).toBe(EXPECTED);
    expect(oracle(sample())).toBe(EXPECTED);
  });

  it("an indexed setter on Array.prototype[0] cannot rewrite a collected key (the verdict's repro)", () => {
    const input = { a: 1, b: 2 };
    const out = polluted(rewriteKeyA, () => canonicalize(input));
    expect(out.threw).toBe(false);
    expect(out.result).toBe('{"a":1,"b":2}'); // round 3 wrote {"b":2,"b":2}: key a vanished from the hash
  });

  it("the verdict's repro also holds for arrays and a larger sample", () => {
    const input = sample();
    const out = polluted(rewriteKeyA, () => canonicalize(input));
    expect(out.threw).toBe(false);
    expect(out.result).toBe(EXPECTED);
  });

  it("never writes an array index it does not own, never reads one it does not own: 100 indexed accessors on Array.prototype", () => {
    const input = sample();
    const out = polluted(() => indexedTraps(ARRAY_PROTOTYPE, 100), () => canonicalize(input));
    expect(out.failure).toBeUndefined();
    expect(out.result).toBe(EXPECTED);
  });

  it("the same holds for 100 indexed accessors on Object.prototype", () => {
    const input = sample();
    const out = polluted(() => indexedTraps(Object.prototype, 100), () => canonicalize(input));
    expect(out.failure).toBeUndefined();
    expect(out.result).toBe(EXPECTED);
  });

  it("push, sort and join replaced with functions that quietly corrupt, the verdict's other three repros", () => {
    const input = sample();
    for (const [name, corrupt] of [
      ["push", () => 0],
      ["sort", function (this: unknown) { return this; }], // "sorts" by doing nothing
      ["join", () => "JOINED"],
    ] as const) {
      const out = polluted(() => replaceOne(ARRAY_PROTOTYPE, name, corrupt), () => canonicalize(input));
      expect(out.failure, `Array.prototype.${name}`).toBeUndefined();
      expect(out.result, `Array.prototype.${name}`).toBe(EXPECTED);
    }
  });

  describe("every method of Array.prototype, replaced after load", () => {
    const names: Array<string | symbol> = [];
    for (const key of ownKeys(ARRAY_PROTOTYPE)) {
      if (key !== "constructor" && typeof getOwnPropertyDescriptor(ARRAY_PROTOTYPE, key)?.value === "function") names.push(key);
    }
    for (const key of names) {
      it(`Array.prototype.${String(key)}`, () => {
        const input = sample();
        const slots: Slot[] = [{ holder: ARRAY_PROTOTYPE, key, name: String(key), previous: getOwnPropertyDescriptor(ARRAY_PROTOTYPE, key) }];
        const out = polluted(() => replaceWithThrowers(slots), () => canonicalize(input));
        expect(out.failure).toBeUndefined();
        expect(out.result).toBe(EXPECTED);
      });
    }
  });

  describe("every function an intrinsic holder carries, replaced after load", () => {
    const labels: Array<[string, () => object]> = [
      ["Object.prototype", () => Object.prototype],
      ["Function.prototype (call, apply, bind)", () => Function.prototype],
      ["String.prototype", () => String.prototype],
      ["Number.prototype", () => Number.prototype],
      ["Boolean.prototype", () => Boolean.prototype],
      ["Symbol.prototype", () => Symbol.prototype],
      ["WeakSet.prototype (add, has, delete)", () => WeakSet.prototype],
      ["Set.prototype", () => Set.prototype],
      ["Map.prototype", () => Map.prototype],
      ["JSON (stringify, parse)", () => JSON],
      ["Reflect (ownKeys, getOwnPropertyDescriptor, getPrototypeOf, apply ...)", () => Reflect],
      ["Object (getOwnPropertyDescriptor, getPrototypeOf, keys ...)", () => Object],
      ["Array (isArray, from ...)", () => Array],
      ["Number (isFinite, isInteger, isSafeInteger)", () => Number],
      ["String", () => String],
      ["the array iterator (next)", () => Object.getPrototypeOf([][Symbol.iterator]())],
    ];
    for (const [label, holder] of labels) {
      it(label, () => {
        const input = sample();
        const slots: Slot[] = [];
        functionSlots(label, holder(), slots);
        expect(slots.length).toBeGreaterThan(0);
        const out = polluted(() => replaceWithThrowers(slots), () => canonicalize(input));
        expect(out.failure).toBeUndefined();
        expect(out.result).toBe(EXPECTED);
      });
    }

    for (const name of ["String", "Number", "Boolean", "Symbol", "Object", "Array", "JSON", "Reflect", "WeakSet", "Set", "Map", "Function"]) {
      it(`the global binding ${name} itself replaced`, () => {
        const input = sample();
        const slots: Slot[] = [{ holder: globalThis, key: name, name: `globalThis.${name}`, previous: getOwnPropertyDescriptor(globalThis, name) }];
        const out = polluted(() => replaceWithThrowers(slots), () => canonicalize(input));
        expect(out.failure).toBeUndefined();
        expect(out.result).toBe(EXPECTED);
      });
    }
  });

  it("everything replaced at once, with indexed accessors on both prototypes: byte-identical", () => {
    const input = sample();
    const out = polluted(installEverything, () => canonicalize(input));
    expect(out.failure).toBeUndefined();
    expect(out.result).toBe(EXPECTED);
  });

  it("refusals stay typed, and name the same path with the same reason, while everything is replaced", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const withNamed = Object.assign([1, 2], { extra: true });
    const accessor = Object.defineProperty({}, "x", { get: () => 1, enumerable: true });
    const cases: Array<[string, () => unknown]> = [
      ["NaN", () => ({ n: Number.NaN })],
      ["unsafe integer", () => [2 ** 53]],
      ["undefined element", () => [1, undefined]],
      ["hole", () => [1, , 3]], // eslint-disable-line no-sparse-arrays
      ["symbol key", () => ({ [Symbol("s")]: 1 })],
      ["accessor", () => accessor],
      ["named property on an array", () => withNamed],
      ["cycle", () => cyclic],
      ["bigint", () => ({ b: BigInt(1) })],
      ["function", () => ({ f: () => 1 })],
      ["Map", () => ({ m: new Map() })],
      ["a throwing Proxy trap", () => new Proxy({}, { ownKeys() { throw new Error("trap"); } })],
    ];
    const shape = (e: unknown) => (e instanceof NonCanonicalValueError ? { name: e.name, path: e.path, message: e.message } : { notTyped: String(e) });
    for (const [name, make] of cases) {
      const input = make();
      let expected: unknown;
      try {
        canonicalize(input);
      } catch (e) {
        expected = shape(e);
      }
      expect(expected, `${name} is refused when clean`).toMatchObject({ name: "NonCanonicalValueError" });
      const out = polluted(installEverything, () => canonicalize(input));
      expect(out.threw, name).toBe(true);
      expect(shape(out.failure), name).toEqual(expected);
    }
  });

  describe("against an independent reference encoder", () => {
    /** xorshift32: deterministic, so a failure names a reproducible tree. */
    const rng = (seed: number) => {
      let s = seed >>> 0 || 1;
      return () => {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        return s / 0x100000000;
      };
    };
    const keyPool = ["a", "b", "A", "B", "_", "~", "0", "1", "10", "2", "é", "z", "😀", "", "aa", "ab", "ba", "k", String.fromCharCode(0xd83d), String.fromCharCode(0xdc00), LS];
    const textPool = ["", "x", "é", '"', "\\", "\n", String.fromCharCode(0), "😀", String.fromCharCode(0xd83d), LS, "a b"];
    const numberPool = [0, -0, 1, -1, 1.5, 1e-7, 123456789, 0.1 + 0.2, 2 ** 53 - 1, -(2 ** 53 - 1), 5e-324, 1.7976931348623157e308 / 1e300];

    function tree(next: () => number, depth: number): unknown {
      const pick = <T>(pool: T[]): T => pool[Math.floor(next() * pool.length)];
      const roll = next();
      if (depth <= 0 || roll < 0.35) {
        const leaf = next();
        if (leaf < 0.3) return pick(textPool);
        if (leaf < 0.6) return pick(numberPool);
        if (leaf < 0.8) return next() < 0.5;
        return null;
      }
      if (roll < 0.6) {
        const length = Math.floor(next() * 5);
        const out: unknown[] = [];
        for (let i = 0; i < length; i++) out.push(tree(next, depth - 1));
        return out;
      }
      const out: Record<string, unknown> = next() < 0.2 ? Object.create(null) : {};
      const size = Math.floor(next() * 7);
      for (let i = 0; i < size; i++) {
        const value = next() < 0.1 ? undefined : tree(next, depth - 1);
        out[pick(keyPool)] = value;
      }
      return out;
    }

    const trees: unknown[] = [];
    const reference: string[] = [];
    const next = rng(20260930);
    for (let i = 0; i < 300; i++) {
      const t = tree(next, 5);
      trees.push(t);
      reference.push(oracle(t));
    }

    it("matches on 300 random JSON trees", () => {
      for (let i = 0; i < trees.length; i++) expect(canonicalize(trees[i]), `tree ${i}`).toBe(reference[i]);
    });

    it("matches on the same trees with everything replaced", () => {
      const results: string[] = trees.map(() => "");
      const count = trees.length;
      const out = polluted(installEverything, () => {
        for (let i = 0; i < count; i++) results[i] = canonicalize(trees[i]);
        return "done";
      });
      expect(out.failure).toBeUndefined();
      for (let i = 0; i < count; i++) expect(results[i], `tree ${i}`).toBe(reference[i]);
    });
  });

  describe("key order is UTF-16 code-unit order, whatever the key count", () => {
    const alphabet = ["a", "b", "z", "A", "Z", "0", "9", "_", "~", "é", "😀", String.fromCharCode(0xd83d), String.fromCharCode(0xdc00), "\u0000"];
    const keysOf = (count: number, seed: number): string[] => {
      let s = seed >>> 0 || 1;
      const next = () => {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        return s / 0x100000000;
      };
      const seen = new Set<string>();
      while (seen.size < count) {
        let key = "";
        const length = 1 + Math.floor(next() * 4);
        for (let j = 0; j < length; j++) key += alphabet[Math.floor(next() * alphabet.length)];
        seen.add(key);
      }
      return [...seen];
    };
    it("matches the reference for every size from 0 to 70, and a few larger", () => {
      for (const count of [...Array.from({ length: 71 }, (_, i) => i), 100, 257, 1000, 2500]) {
        const o: Record<string, number> = {};
        keysOf(count, count + 7).forEach((k, i) => { o[k] = i; });
        expect(canonicalize(o), `${count} keys`).toBe(oracle(o));
      }
    });

    it("sorts 100,000 keys without quadratic blow-up (the default 5 s test timeout is the bound)", () => {
      const o: Record<string, number> = {};
      for (let i = 0; i < 100_000; i++) o[`k${((i * 2654435761) >>> 0).toString(36)}`] = i;
      const text = canonicalize(o);
      expect(text).toBe(oracle(o));
    });
  });
});
