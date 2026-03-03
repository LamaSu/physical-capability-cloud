import { describe, it, expect } from "vitest";
import { canonicalize, sha256, hashEvent, hashBundle, verifyEventHash, verifyBundleHash } from "../util/canonical.js";
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
