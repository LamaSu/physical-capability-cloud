/**
 * Tests for composition-manifest.ts — schema validation + manifestHash determinism.
 */

import { describe, it, expect } from "vitest";
import {
  CompositionManifestSchema,
  CompositionEntrySchema,
  computeManifestHash,
  type CompositionEntry,
  type CompositionManifest,
} from "../types/composition-manifest.js";

const ZERO_HASH = "0x" + "0".repeat(64);
const HASH_ALICE = "0x" + "a".repeat(64);
const HASH_BOB = "0x" + "b".repeat(64);

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const CAROL = "0x3333333333333333333333333333333333333333";

function makeEntry(overrides: Partial<CompositionEntry> = {}): CompositionEntry {
  return {
    ipId: "ip-cap-001",
    role: "protocol-author",
    contributorAddress: ALICE,
    rateScheduleHash: HASH_ALICE,
    ...overrides,
  };
}

function makeManifest(
  entries: CompositionEntry[],
  capabilityIpId = "ip-cap-001",
): CompositionManifest {
  const partial = {
    capabilityIpId,
    entries,
    builtAt: "2026-04-22T00:00:00.000Z",
  };
  return { ...partial, manifestHash: computeManifestHash(partial) };
}

// ── Schema validation ─────────────────────────────────────────────────

describe("CompositionEntrySchema", () => {
  it("accepts a minimal valid entry", () => {
    expect(() => CompositionEntrySchema.parse(makeEntry())).not.toThrow();
  });

  it("rejects malformed contributorAddress", () => {
    expect(() =>
      CompositionEntrySchema.parse(makeEntry({ contributorAddress: "not-an-address" })),
    ).toThrow();
  });

  it("rejects malformed rateScheduleHash", () => {
    expect(() =>
      CompositionEntrySchema.parse(makeEntry({ rateScheduleHash: "0xnope" })),
    ).toThrow();
  });

  it("accepts all canonical roles", () => {
    const roles = [
      "operator",
      "verifier",
      "insurer",
      "integrator",
      "protocol-author",
      "model-author",
      "dataset-contributor",
      "pilot",
      "curator",
      "assembler",
      "network-treasury",
    ] as const;
    for (const role of roles) {
      expect(() =>
        CompositionEntrySchema.parse(makeEntry({ role })),
      ).not.toThrow();
    }
  });

  it("accepts optional groupBps in valid range", () => {
    expect(() =>
      CompositionEntrySchema.parse(makeEntry({ groupBps: 5000 })),
    ).not.toThrow();
    expect(() =>
      CompositionEntrySchema.parse(makeEntry({ groupBps: 11_000 })),
    ).toThrow();
  });
});

describe("CompositionManifestSchema", () => {
  it("accepts a manifest with one entry", () => {
    const m = makeManifest([makeEntry()]);
    expect(() => CompositionManifestSchema.parse(m)).not.toThrow();
  });

  it("accepts an empty entries array (operator-residual-only)", () => {
    const m = makeManifest([]);
    expect(() => CompositionManifestSchema.parse(m)).not.toThrow();
    expect(m.entries).toHaveLength(0);
  });

  it("rejects a manifest with malformed manifestHash", () => {
    expect(() =>
      CompositionManifestSchema.parse({
        capabilityIpId: "ip-cap-001",
        entries: [],
        builtAt: "2026-04-22T00:00:00Z",
        manifestHash: "not-a-hash",
      }),
    ).toThrow();
  });

  it("multiple roles for one capability validate", () => {
    const m = makeManifest([
      makeEntry({ role: "protocol-author", contributorAddress: ALICE, rateScheduleHash: HASH_ALICE }),
      makeEntry({ role: "verifier", contributorAddress: BOB, rateScheduleHash: HASH_BOB }),
      makeEntry({
        role: "integrator",
        contributorAddress: CAROL,
        rateScheduleHash: ZERO_HASH,
        ipId: "ip-adapter-001",
      }),
    ]);
    expect(() => CompositionManifestSchema.parse(m)).not.toThrow();
    expect(m.entries).toHaveLength(3);
  });
});

// ── computeManifestHash determinism ────────────────────────────────────

describe("computeManifestHash", () => {
  it("returns a 0x-prefixed 64-hex digest", () => {
    const m = makeManifest([makeEntry()]);
    expect(m.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("two structurally identical manifests yield identical hashes", () => {
    const m1 = makeManifest([
      makeEntry({ role: "protocol-author" }),
      makeEntry({ role: "verifier", contributorAddress: BOB }),
    ]);
    const m2 = makeManifest([
      makeEntry({ role: "protocol-author" }),
      makeEntry({ role: "verifier", contributorAddress: BOB }),
    ]);
    expect(m1.manifestHash).toBe(m2.manifestHash);
  });

  it("entry ORDER is significant (different order → different hash)", () => {
    const eA = makeEntry({ role: "protocol-author" });
    const eB = makeEntry({ role: "verifier", contributorAddress: BOB });

    const m1 = makeManifest([eA, eB]);
    const m2 = makeManifest([eB, eA]);
    expect(m1.manifestHash).not.toBe(m2.manifestHash);
  });

  it("different capabilityIpId yields different hash even with same entries", () => {
    const a = makeManifest([makeEntry()], "ip-cap-001");
    const b = makeManifest([makeEntry()], "ip-cap-002");
    expect(a.manifestHash).not.toBe(b.manifestHash);
  });

  it("builtAt does NOT affect the hash (purely audit metadata)", () => {
    const entries = [makeEntry()];
    const a = computeManifestHash({ capabilityIpId: "ip-cap-001", entries, builtAt: "2026-01-01T00:00:00Z" });
    const b = computeManifestHash({ capabilityIpId: "ip-cap-001", entries, builtAt: "2026-12-31T23:59:59Z" });
    expect(a).toBe(b);
  });

  it("changing one entry's rateScheduleHash changes manifestHash", () => {
    const a = makeManifest([makeEntry({ rateScheduleHash: HASH_ALICE })]);
    const b = makeManifest([makeEntry({ rateScheduleHash: HASH_BOB })]);
    expect(a.manifestHash).not.toBe(b.manifestHash);
  });
});
