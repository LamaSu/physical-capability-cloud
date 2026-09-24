import { describe, it, expect } from "vitest";
import { NonCanonicalValueError, canonicalize, sha256, hashEvent, hashBundle, verifyEventHash, verifyBundleHash } from "../util/canonical.js";
import type { EvidenceEvent, EvidenceBundle } from "../types/evidence.js";
import type { SHA256, Signature } from "../types/common.js";

describe("canonicalize", () => {
  it("sorts object keys lexicographically", () => {
    const result = canonicalize({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  it("handles nested objects with sorted keys", () => {
    const result = canonicalize({ b: { d: 1, c: 2 }, a: 3 });
    expect(result).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it("handles arrays preserving order", () => {
    const result = canonicalize([3, 1, 2]);
    expect(result).toBe("[3,1,2]");
  });

  it("handles strings with proper quoting", () => {
    expect(canonicalize("hello")).toBe('"hello"');
  });

  it("handles null", () => {
    expect(canonicalize(null)).toBe("null");
  });

  it("handles booleans", () => {
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
  });

  it("omits undefined values", () => {
    const result = canonicalize({ a: 1, b: undefined, c: 3 });
    expect(result).toBe('{"a":1,"c":3}');
  });

  it("includes null values", () => {
    const result = canonicalize({ a: 1, b: null });
    expect(result).toBe('{"a":1,"b":null}');
  });

  it("is deterministic — same data always produces same output", () => {
    const obj = { type: "execution_completed", timestamp: "2026-01-01T00:00:00Z", payload: { duration: 120 } };
    const r1 = canonicalize(obj);
    const r2 = canonicalize(obj);
    expect(r1).toBe(r2);
  });

  it("different key order produces same canonical form", () => {
    const a = canonicalize({ x: 1, y: 2 });
    const b = canonicalize({ y: 2, x: 1 });
    expect(a).toBe(b);
  });
});

describe("sha256", () => {
  it("produces a valid sha256: prefixed hash", async () => {
    const hash = await sha256("hello world");
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("is deterministic", async () => {
    const h1 = await sha256("test input");
    const h2 = await sha256("test input");
    expect(h1).toBe(h2);
  });

  it("different inputs produce different hashes", async () => {
    const h1 = await sha256("input A");
    const h2 = await sha256("input B");
    expect(h1).not.toBe(h2);
  });
});

describe("hashEvent / verifyEventHash", () => {
  const mockEvent: EvidenceEvent = {
    id: "ev_test1",
    type: "execution_completed",
    timestamp: "2026-01-15T10:30:00Z",
    source: {
      deviceId: "dev_printer1",
      deviceType: "controller",
      kernelId: "kernel_shop1",
    },
    payload: { duration_seconds: 3600, layer_count: 150 },
    hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as SHA256,
  };

  it("hashes an event deterministically", async () => {
    const hash = await hashEvent(mockEvent);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const hash2 = await hashEvent(mockEvent);
    expect(hash).toBe(hash2);
  });

  it("verifies a correctly hashed event", async () => {
    const correctHash = await hashEvent(mockEvent);
    const eventWithCorrectHash: EvidenceEvent = { ...mockEvent, hash: correctHash };
    expect(await verifyEventHash(eventWithCorrectHash)).toBe(true);
  });

  it("rejects an incorrectly hashed event", async () => {
    expect(await verifyEventHash(mockEvent)).toBe(false);
  });
});

describe("hashBundle / verifyBundleHash", () => {
  it("hashes a bundle from its events' hashes", async () => {
    const events: EvidenceEvent[] = [
      {
        id: "ev_1",
        type: "gcode_hash_verified",
        timestamp: "2026-01-15T10:00:00Z",
        source: { deviceId: "dev_1", deviceType: "controller", kernelId: "k1" },
        payload: {},
        hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as SHA256,
      },
      {
        id: "ev_2",
        type: "execution_completed",
        timestamp: "2026-01-15T10:30:00Z",
        source: { deviceId: "dev_1", deviceType: "controller", kernelId: "k1" },
        payload: {},
        hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as SHA256,
      },
    ];

    const bundleHash = await hashBundle(events);
    expect(bundleHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("is order-independent (events sorted by hash)", async () => {
    const evA: EvidenceEvent = {
      id: "ev_a", type: "gcode_hash_verified", timestamp: "2026-01-15T10:00:00Z",
      source: { deviceId: "d", deviceType: "controller", kernelId: "k" },
      payload: {},
      hash: "sha256:aaaa000000000000000000000000000000000000000000000000000000000000" as SHA256,
    };
    const evB: EvidenceEvent = {
      id: "ev_b", type: "execution_completed", timestamp: "2026-01-15T10:30:00Z",
      source: { deviceId: "d", deviceType: "controller", kernelId: "k" },
      payload: {},
      hash: "sha256:bbbb000000000000000000000000000000000000000000000000000000000000" as SHA256,
    };

    const h1 = await hashBundle([evA, evB]);
    const h2 = await hashBundle([evB, evA]);
    expect(h1).toBe(h2);
  });
});

describe("canonicalize — only JSON values have a canonical form", () => {
  // Each of these used to produce text no JSON consumer could reproduce
  // (cross-repo byte test, crossrepo-accepted-bundle-v1.json "nonJson").
  const refused: Array<[string, unknown, string]> = [
    ["NaN", { x: Number.NaN }, "$.x"],
    ["Infinity", { x: Number.POSITIVE_INFINITY }, "$.x"],
    ["-Infinity", [1, Number.NEGATIVE_INFINITY], "$[1]"],
    ["bigint", { n: BigInt(10) }, "$.n"],
    ["Date", { at: new Date(0) }, "$.at"],
    ["Map", { m: new Map([["a", 1]]) }, "$.m"],
    ["Set", { s: new Set([1]) }, "$.s"],
    ["function", { f: () => 1 }, "$.f"],
    ["symbol", { s: Symbol("s") }, "$.s"],
    ["typed array", { b: new Uint8Array([1, 2]) }, "$.b"],
    ["class instance", { c: new (class Point { x = 1; })() }, "$.c"],
  ];
  for (const [name, value, path] of refused) {
    it(`refuses ${name} and names where it is`, () => {
      let err: unknown;
      try {
        canonicalize(value);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(NonCanonicalValueError);
      expect((err as NonCanonicalValueError).path).toBe(path);
    });
  }

  it("still accepts every JSON value, byte-identical to before", () => {
    const value = {
      s: "é\u0000\"",
      n: -0,
      f: 1.5,
      e: 1e-7,
      t: true,
      z: null,
      a: [1, null, { b: 2 }],
      skip: undefined,
      o: Object.assign(Object.create(null), { k: "v" }),
    };
    expect(canonicalize(value)).toBe(
      '{"a":[1,null,{"b":2}],"e":1e-7,"f":1.5,"n":0,"o":{"k":"v"},"s":"é\\u0000\\"","t":true,"z":null}',
    );
    expect(JSON.parse(canonicalize(value))).toEqual(JSON.parse(JSON.stringify(value)));
  });
});

describe("canonicalize — number policy D5, sparse arrays and cycles (oracle #2473)", () => {
  const refusedAt = (value: unknown): string => {
    try {
      canonicalize(value);
    } catch (e) {
      if (e instanceof NonCanonicalValueError) return e.path;
      throw e;
    }
    return "accepted";
  };

  it("refuses an integer outside the safe range: it has already lost precision", () => {
    expect(refusedAt({ n: 1e21 })).toBe("$.n");
    expect(refusedAt([2 ** 53])).toBe("$[0]");
    expect(refusedAt([-(2 ** 53)])).toBe("$[0]");
    expect(refusedAt({ n: 123456789012345680000 })).toBe("$.n");
    expect(refusedAt({ n: Number.MAX_VALUE })).toBe("$.n");
  });

  it("the shared cross-repo corpus 'numbers' case is refused at its first unsafe integer", () => {
    const numbers = [0, -0, 1, -1, 1e21, 1.5e-7, 0.30000000000000004, 123456789012345680000, 5e-324, 1.7976931348623157e308];
    expect(refusedAt(numbers)).toBe("$[4]");
  });

  it("keeps every safe number's bytes exactly as JSON writes them", () => {
    const safe = [Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 0, -0, 1.5e-7, 0.30000000000000004, 5e-324, 3.14];
    expect(canonicalize(safe)).toBe(JSON.stringify(safe));
    expect(canonicalize(safe)).toBe("[9007199254740991,-9007199254740991,0,0,1.5e-7,0.30000000000000004,5e-324,3.14]");
  });

  it("refuses a hole and an explicit undefined element alike: JSON has neither", () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(refusedAt([1, , 3])).toBe("$[1]");
    expect(refusedAt({ a: [1, 2, , 4] })).toBe("$.a[2]");
    expect(refusedAt([1, undefined, 3])).toBe("$[1]");
    expect(refusedAt(undefined)).toBe("$");
    // An undefined OBJECT member is still omitted, exactly as JSON.stringify omits it.
    expect(canonicalize({ a: 1, gone: undefined })).toBe('{"a":1}');
  });

  it("refuses a cycle with a named error instead of overflowing the stack", () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(refusedAt(o)).toBe("$.self");
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(refusedAt(arr)).toBe("$[1]");
  });

  it("a value shared twice without a cycle is still fine", () => {
    const shared = { k: "v" };
    expect(canonicalize({ p: shared, q: [shared, shared] })).toBe('{"p":{"k":"v"},"q":[{"k":"v"},{"k":"v"}]}');
  });
});

describe("canonicalize — only a plain JSON tree, so evaluators read only what was hashed (N15 round 2)", () => {
  const refusedAt = (value: unknown): string => {
    try {
      canonicalize(value);
    } catch (e) {
      if (e instanceof NonCanonicalValueError) return e.path;
      throw e;
    }
    return "accepted";
  };

  it("refuses an index that exists only on a substituted prototype", () => {
    const arr = new Array(1);
    Object.setPrototypeOf(arr, Object.assign(Object.create(Array.prototype), { 0: 7 }));
    expect((arr as unknown[])[0]).toBe(7); // an evaluator would read 7
    expect(refusedAt(arr)).toBe("$");
  });

  it("refuses an index inherited from a polluted Array.prototype", () => {
    const proto = Array.prototype as unknown as Record<number, unknown>;
    proto[0] = 7;
    try {
      const arr = new Array(1);
      expect(arr[0]).toBe(7);
      expect(refusedAt(arr)).toBe("$[0]");
    } finally {
      delete proto[0];
    }
  });

  it("refuses an Array subclass and a named property on an array", () => {
    class Tagged extends Array<number> {}
    expect(refusedAt({ a: Tagged.from([1]) })).toBe("$.a");
    const named = Object.assign([1, 2], { jobId: "job-b" });
    expect(refusedAt({ a: named })).toBe("$.a.jobId");
  });

  it("refuses non-enumerable and symbol-keyed properties an evaluator could read", () => {
    const payload = Object.defineProperty({ ok: true }, "jobId", { value: "job-b", enumerable: false });
    expect((payload as { jobId?: string }).jobId).toBe("job-b");
    expect(refusedAt({ payload })).toBe("$.payload.jobId");
    const sym = Symbol("jobId");
    expect(refusedAt({ [sym]: "job-b" })).toBe("$[Symbol(jobId)]");
  });

  it("refuses accessors without ever running them", () => {
    let calls = 0;
    const getter = {
      get jobId() {
        calls++;
        return "job-b";
      },
    };
    expect(refusedAt(getter)).toBe("$.jobId");
    const element = Object.defineProperty([0], 0, { get: () => (calls++, 1), enumerable: true });
    expect(refusedAt(element)).toBe("$[0]");
    expect(() => canonicalize(getter)).toThrow(/accessor property/);
    expect(() => canonicalize(element)).toThrow(/accessor element/);
    expect(calls).toBe(0);
  });

  it("an event carrying a hidden, unhashed jobId cannot be hashed at all", async () => {
    const payload = Object.defineProperty({ step: 1 }, "jobId", { value: "job-b", enumerable: false });
    const event = { type: "execution_completed", timestamp: "2026-09-24T00:00:00.000Z", source: { deviceId: "d", deviceType: "machine", kernelId: "k" }, payload };
    await expect(hashEvent(event as never)).rejects.toBeInstanceOf(NonCanonicalValueError);
  });

  it("anything JSON.parse produces is accepted, and round-trips to the same text", () => {
    const text = canonicalize({ z: [1, "two", { three: null, four: [true, false] }], a: { nested: { deep: -0.5 } }, o: Object.create(null) });
    expect(canonicalize(JSON.parse(text))).toBe(text);
    expect(canonicalize(JSON.parse('{"__proto__":{"x":1},"k":[]}'))).toBe('{"__proto__":{"x":1},"k":[]}');
  });
});
