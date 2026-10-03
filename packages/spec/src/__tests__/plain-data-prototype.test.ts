/**
 * astra pack 162 (gpt-5.6-sol, #336 @d382255e): plainDataCopy must not consult
 * a prototype, or call a method looked up at call time, while it decides what
 * the copy holds.
 *   HIGH 2:   `"value" in descriptor` reads Object.prototype, so a polluted
 *             `value` made an accessor pass as data and supplied its value.
 *   MEDIUM 3: `for...of` over Object.keys ran Array.prototype[Symbol.iterator].
 *   HIGH 4:   the isProxy loader accepted whatever `process.getBuiltinModule`
 *             answered, inherited or replaced, so a check that says "no proxy"
 *             or runs the traps itself was trusted.
 * The same property for every other intrinsic the copy calls is checked below:
 * each is replaced after load, and the copy must neither call it nor change.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { plainDataCopy, trapFreeProxyCheck } from "../util/plain-data.js";

afterEach(() => {
  delete (Object.prototype as Record<string, unknown>).value;
  delete (Object.prototype as Record<string, unknown>).getBuiltinModule;
});

describe("astra 162: a polluted prototype cannot pass an accessor off as data", () => {
  it("HIGH 2, astra's recipe: an inherited `value` getter neither runs nor supplies an object member", () => {
    // The accessor is defined first: once Object.prototype.value exists, a descriptor
    // literal inherits it, and defineProperty refuses "both accessors and a value".
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "x", {
      enumerable: true,
      get() {
        throw new Error("must not run");
      },
    });
    let ran = false;
    Object.defineProperty(Object.prototype, "value", {
      configurable: true,
      get() {
        ran = true;
        return "substituted";
      },
    });
    let r: ReturnType<typeof plainDataCopy>;
    try {
      r = plainDataCopy(input);
    } finally {
      delete (Object.prototype as Record<string, unknown>).value;
    }
    expect(ran).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("HIGH 2, the array form: an inherited `value` cannot stand in for an accessor element", () => {
    const input: unknown[] = [1];
    Object.defineProperty(input, 0, {
      enumerable: true,
      get() {
        throw new Error("must not run");
      },
    });
    Object.defineProperty(Object.prototype, "value", { configurable: true, writable: true, value: "substituted" });
    let r: ReturnType<typeof plainDataCopy>;
    try {
      r = plainDataCopy(input);
    } finally {
      delete (Object.prototype as Record<string, unknown>).value;
    }
    expect(r.ok).toBe(false);
  });

  it("MEDIUM 3, astra's recipe: a replaced Array.prototype[Symbol.iterator] neither runs nor drops keys", () => {
    const original = Array.prototype[Symbol.iterator];
    let ran = false;
    Array.prototype[Symbol.iterator] = function* () {
      ran = true;
    } as typeof original;
    let r: ReturnType<typeof plainDataCopy>;
    try {
      r = plainDataCopy({ a: 1 });
    } finally {
      Array.prototype[Symbol.iterator] = original;
    }
    expect(ran).toBe(false);
    expect(r).toEqual({ ok: true, value: Object.assign(Object.create(null), { a: 1 }) });
  });
});

describe("astra 162 HIGH 4: the proxy check is Node's own, or there is none", () => {
  async function loadWith(patch: () => () => void): Promise<typeof import("../util/plain-data.js")> {
    vi.resetModules();
    const restore = patch();
    try {
      return await import("../util/plain-data.js");
    } finally {
      restore();
    }
  }

  function trappedProxy(trapped: string[]): object {
    return new Proxy(
      {},
      {
        getPrototypeOf(t) {
          trapped.push("getPrototypeOf");
          return Reflect.getPrototypeOf(t);
        },
        ownKeys(t) {
          trapped.push("ownKeys");
          return Reflect.ownKeys(t);
        },
        getOwnPropertyDescriptor(t, k) {
          trapped.push("getOwnPropertyDescriptor");
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
      },
    );
  }

  it("astra's recipe: getBuiltinModule replaced before load with one whose isProxy says no; no trap runs", async () => {
    const mod = await loadWith(() => {
      const real = process.getBuiltinModule;
      (process as unknown as Record<string, unknown>).getBuiltinModule = () => ({ types: { isProxy: () => false } });
      return () => {
        (process as unknown as Record<string, unknown>).getBuiltinModule = real;
      };
    });
    const trapped: string[] = [];
    const r = mod.plainDataCopy(trappedProxy(trapped));
    expect(trapped).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it("a check that runs the traps itself is not accepted either", async () => {
    const mod = await loadWith(() => {
      const real = process.getBuiltinModule;
      (process as unknown as Record<string, unknown>).getBuiltinModule = () => ({
        types: { isProxy: (v: object) => (Reflect.ownKeys(v), Reflect.getPrototypeOf(v), false) },
      });
      return () => {
        (process as unknown as Record<string, unknown>).getBuiltinModule = real;
      };
    });
    const trapped: string[] = [];
    const r = mod.plainDataCopy(trappedProxy(trapped));
    expect(trapped).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it("a getBuiltinModule written on Object.prototype (no own one: old Node, a browser shim) is not consulted", async () => {
    const mod = await loadWith(() => {
      const real = Object.getOwnPropertyDescriptor(process, "getBuiltinModule")!;
      delete (process as unknown as Record<string, unknown>).getBuiltinModule;
      Object.defineProperty(Object.prototype, "getBuiltinModule", {
        configurable: true,
        writable: true,
        value: () => ({ types: { isProxy: () => false } }),
      });
      return () => {
        delete (Object.prototype as Record<string, unknown>).getBuiltinModule;
        Object.defineProperty(process, "getBuiltinModule", real);
      };
    });
    const trapped: string[] = [];
    const r = mod.plainDataCopy(trappedProxy(trapped));
    expect(trapped).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it("Node's own check is still found, and plain data still copies", async () => {
    const mod = await loadWith(() => () => {});
    expect(mod.isProxy).not.toBeNull();
    expect(mod.plainDataCopy({ a: [1, { b: "c" }] }).ok).toBe(true);
  });
});

describe("no other intrinsic replaced after load runs, or changes the copy", () => {
  type Slot = [object, PropertyKey, string];
  const SLOTS: Slot[] = [
    [Object, "keys", "Object.keys"],
    [Object, "getOwnPropertyDescriptor", "Object.getOwnPropertyDescriptor"],
    [Object, "getPrototypeOf", "Object.getPrototypeOf"],
    [Object, "defineProperty", "Object.defineProperty"],
    [Object, "create", "Object.create"],
    [Object, "is", "Object.is"],
    [Array, "isArray", "Array.isArray"],
    [Number, "isFinite", "Number.isFinite"],
    [Set.prototype, "has", "Set.prototype.has"],
    [Set.prototype, "add", "Set.prototype.add"],
    [Set.prototype, "delete", "Set.prototype.delete"],
    [Array.prototype, Symbol.iterator, "Array.prototype[Symbol.iterator]"],
  ];
  const SAMPLE = { a: [1, -0, { b: "c", d: [true, null] }], e: { f: 2.5 } };
  const expected = JSON.stringify(plainDataCopy(SAMPLE));

  for (const [owner, key, label] of SLOTS) {
    it(`${label} replaced after load is never called, and the copy is the same`, () => {
      const original = (owner as Record<PropertyKey, unknown>)[key] as (...a: unknown[]) => unknown;
      let calls = 0;
      (owner as Record<PropertyKey, unknown>)[key] = function (this: unknown, ...args: unknown[]) {
        calls++;
        return Reflect.apply(original, this, args);
      };
      let got: ReturnType<typeof plainDataCopy>;
      try {
        got = plainDataCopy(SAMPLE);
      } finally {
        (owner as Record<PropertyKey, unknown>)[key] = original;
      }
      expect(calls).toBe(0);
      expect(JSON.stringify(got)).toBe(expected);
    });
  }

  it("a replaced Object.keys that hides a member cannot drop it from the copy", () => {
    const original = Object.keys;
    Object.keys = (() => []) as typeof Object.keys;
    let got: ReturnType<typeof plainDataCopy>;
    try {
      got = plainDataCopy({ hidden: 1 });
    } finally {
      Object.keys = original;
    }
    expect(JSON.stringify(got)).toBe(JSON.stringify({ ok: true, value: { hidden: 1 } }));
  });

  it("a replaced Object.getOwnPropertyDescriptor cannot pass a getter off as data", () => {
    const original = Object.getOwnPropertyDescriptor;
    Object.getOwnPropertyDescriptor = ((o: object, k: PropertyKey) =>
      k === "x" ? { value: "substituted", writable: true, enumerable: true, configurable: true } : original(o, k)) as typeof original;
    const input = {};
    Object.defineProperty(input, "x", { enumerable: true, get: () => "real" });
    let got: ReturnType<typeof plainDataCopy>;
    try {
      got = plainDataCopy(input);
    } finally {
      Object.getOwnPropertyDescriptor = original;
    }
    expect(got.ok).toBe(false);
  });
});

describe("plain-data.ts calls only what it captured at load (source scan)", () => {
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

  const BANNED: Array<[RegExp, string]> = [
    [/\b(Object|Array|Number|Reflect|JSON|Symbol|Math|String)\s*\./, "a member of an ambient global"],
    [/\bfor\s*\([^)]*\bof\b/, "for...of (the iterator protocol)"],
    [/\.\.\./, "spread (the iterator protocol, or CopyDataProperties)"],
    [/\bnew\s+(Set|Map|WeakSet|WeakMap|Array)\b/, "an ambient constructor"],
    [/\binstanceof\b/, "instanceof"],
    [/\bin\s+(element|member|descriptor|d)\b/, "an `in` test of a descriptor (it reads Object.prototype)"],
    [/\.(has|add|delete|get|set|map|filter|forEach|some|every|includes|indexOf|push|pop|slice|join|keys|values|entries|call|apply|bind)\(/, "a method looked up at call time"],
  ];

  it("outside the load-time captures, plain-data.ts names no ambient global and calls no looked-up method", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const code = codeOnly(readFileSync(fileURLToPath(new URL("../util/plain-data.ts", import.meta.url)), "utf8"));
    const found: string[] = [];
    code.split("\n").forEach((line, n) => {
      // The captures themselves: `const ObjectKeys = Object.keys;` and the like, run once at load.
      if (/^const \w+ = (Array|Number|Object|Proxy|Reflect)(\.[\w.]+)?;$/.test(line.trim())) return;
      for (const [pattern, what] of BANNED) if (pattern.test(line)) found.push(`plain-data.ts:${n + 1} ${what}: ${line.trim()}`);
    });
    expect(found).toEqual([]);
  });

  it("the proxy check comes from the static node:util import, and nothing reads the runtime's process (astra pack 170)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("../util/plain-data.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/^import \{ types as nodeUtilTypes \} from "node:util";$/m);
    const code = codeOnly(source);
    expect(code).not.toMatch(/\bprocess\b|getBuiltinModule|globalThis/);
  });
});

describe("trapFreeProxyCheck: a sanity probe of a candidate check, not its trust anchor", () => {
  const util = process.getBuiltinModule("node:util") as typeof import("node:util");
  const genuine = util.types.isProxy;

  it("Node's own check passes, and answers as it would", () => {
    const check = trapFreeProxyCheck(genuine);
    expect(check).not.toBeNull();
    expect([check!(new Proxy({}, {})), check!(new Proxy([], {})), check!({}), check!([])]).toEqual([true, true, false, false]);
  });

  it("a check that says no, says yes to everything, throws, runs a trap even quietly, or is not a function, gives null", () => {
    const quietTrap = (v: object) => {
      try {
        Reflect.ownKeys(v);
      } catch {
        // swallowed, so only the probe's own record shows the trap ran
      }
      return genuine(v);
    };
    const fakes: unknown[] = [
      () => false,
      () => true,
      () => {
        throw new Error("no");
      },
      quietTrap,
      "not a function",
      undefined,
    ];
    for (const fake of fakes) expect(trapFreeProxyCheck(fake), String(fake)).toBeNull();
  });

  it("astra 170: a stateful check can pass the probe, which is why isProxy's anchor is the loader's node:util, never a probed candidate", () => {
    let calls = 0;
    const stateful = (v: object) => {
      calls++;
      if (calls <= 2) return true;
      if (calls <= 4) return false;
      Reflect.ownKeys(v);
      return false;
    };
    expect(trapFreeProxyCheck(stateful)).not.toBeNull();
  });
});

describe("plainDataCopy: more of the same boundary", () => {
  it("functions written as Object.prototype.get and .set never run, and the copy is unchanged", () => {
    let ran = false;
    // Null-prototype descriptors: once Object.prototype.get exists, a descriptor literal inherits it.
    const data = (value: unknown) => Object.assign(Object.create(null), { configurable: true, writable: true, value }) as PropertyDescriptor;
    let got: ReturnType<typeof plainDataCopy>;
    try {
      Object.defineProperty(Object.prototype, "get", data(() => ((ran = true), 1)));
      Object.defineProperty(Object.prototype, "set", data(() => void (ran = true)));
      got = plainDataCopy({ a: [1, 2, { b: [3] }] });
    } finally {
      delete (Object.prototype as Record<string, unknown>).get;
      delete (Object.prototype as Record<string, unknown>).set;
    }
    expect(ran).toBe(false);
    expect(JSON.stringify(got)).toBe(JSON.stringify({ ok: true, value: { a: [1, 2, { b: [3] }] } }));
  });

  it("a cycle is refused as a cycle, in an object and in an array", () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    const a: unknown[] = [];
    a.push({ back: a });
    for (const v of [o, a]) {
      const r = plainDataCopy(v);
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.reason).toMatch(/a cycle/);
    }
  });

  it("a key named __proto__ is refused, never copied", () => {
    const r = plainDataCopy(JSON.parse('{"a": 1, "__proto__": {"x": 1}}'));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toMatch(/__proto__/);
  });
});

describe("astra 170 HIGH: the proxy check is the module loader's node:util binding, never one the runtime supplies", () => {
  it("astra's recipe: a stateful check offered through process.getBuiltinModule before load passes no probe and is never used", async () => {
    let calls = 0;
    const fake = (v: object) => {
      calls++;
      if (calls <= 2) return true;
      if (calls <= 4) return false;
      Reflect.ownKeys(v); // runs supplied proxy code after any probe
      return false;
    };
    vi.resetModules();
    const real = Object.getOwnPropertyDescriptor(process, "getBuiltinModule")!;
    Object.defineProperty(process, "getBuiltinModule", { ...real, value: () => ({ types: { isProxy: fake } }) });
    let mod: typeof import("../util/plain-data.js");
    try {
      mod = await import("../util/plain-data.js");
    } finally {
      Object.defineProperty(process, "getBuiltinModule", real);
    }
    let trapped = false;
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          trapped = true;
          return [];
        },
      },
    );
    expect(mod.isProxy).not.toBeNull();
    expect(mod.isProxy!(proxy)).toBe(true);
    const copy = mod.plainDataCopy({ inner: proxy });
    expect(copy.ok).toBe(false);
    expect(trapped).toBe(false);
  });
});

describe("the probe still guards the binding: a node:util whose isProxy fails it gives null", () => {
  it("with node:util offering an isProxy that says no, isProxy is null and every object is refused", async () => {
    vi.resetModules();
    vi.doMock("node:util", () => ({ types: { isProxy: () => false } }));
    try {
      const fresh = await import("../util/plain-data.js");
      expect(fresh.isProxy).toBeNull();
      expect(fresh.plainDataCopy({ a: 1 }).ok).toBe(false);
    } finally {
      vi.doUnmock("node:util");
      vi.resetModules();
    }
  });
});
