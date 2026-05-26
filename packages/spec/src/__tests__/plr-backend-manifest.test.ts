/**
 * Tests for util/plr-backend-manifest.ts.
 *
 * Focus areas:
 *   - deriveBackendIpId matches the on-chain formula bit-for-bit
 *     (tested in PLRBackendRegistry.t.sol's test_deriveIpId_isDeterministic;
 *     here we just verify the off-chain side is deterministic)
 *   - Canonical bytes are stable across key-order shuffles
 *   - sum-bps validation
 *   - Address ↔ bytes32 round-trip for the Phase 1 delegatedAgentId
 */

import { describe, it, expect } from "vitest";
import {
  canonicalizeBackendManifest,
  deriveBackendIpId,
  manifestCid,
  sumAuthorBps,
  validateAuthorGroupBps,
  isStructurallyValidBackendManifest,
  addressToDelegatedAgentBytes32,
  delegatedAgentBytes32ToAddress,
} from "../util/plr-backend-manifest.js";
import type {
  BackendManifest,
  BackendManifestAuthor,
} from "../types/plr-backend-registry.js";

const MODULE_PATH = "pylabrobot.liquid_handling.backends.hamilton.STAR";
const HASH_A = "0x" + "a".repeat(64);

function author(
  overrides: Partial<BackendManifestAuthor> = {},
): BackendManifestAuthor {
  return {
    address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    groupBps: 10000,
    ...overrides,
  };
}

function manifest(overrides: Partial<BackendManifest> = {}): BackendManifest {
  return {
    schemaVersion: 1,
    plrModulePath: MODULE_PATH,
    plrVersionRange: ">=0.2.0 <0.3.0",
    className: "STARBackend",
    authors: [author()],
    rateScheduleHash: HASH_A,
    license: "MIT",
    issuedAt: "2026-05-25T00:00:00.000Z",
    ...overrides,
  };
}

// ── deriveBackendIpId ──────────────────────────────────────────────────

describe("deriveBackendIpId", () => {
  it("is deterministic for the same inputs", () => {
    const a = deriveBackendIpId(MODULE_PATH, 0);
    const b = deriveBackendIpId(MODULE_PATH, 0);
    expect(a).toBe(b);
  });

  it("differs across major versions", () => {
    const v0 = deriveBackendIpId(MODULE_PATH, 0);
    const v1 = deriveBackendIpId(MODULE_PATH, 1);
    expect(v0).not.toBe(v1);
  });

  it("differs across module paths", () => {
    const star = deriveBackendIpId(MODULE_PATH, 0);
    const ot2 = deriveBackendIpId(
      "pylabrobot.liquid_handling.backends.opentrons.OT2",
      0,
    );
    expect(star).not.toBe(ot2);
  });

  it("returns a 0x-prefixed bytes32 (66 chars)", () => {
    const id = deriveBackendIpId(MODULE_PATH, 0);
    expect(id).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it("rejects out-of-range majorVersion", () => {
    expect(() => deriveBackendIpId(MODULE_PATH, -1)).toThrow();
    expect(() => deriveBackendIpId(MODULE_PATH, 256)).toThrow();
    expect(() => deriveBackendIpId(MODULE_PATH, 1.5)).toThrow();
  });
});

// ── canonicalizeBackendManifest ────────────────────────────────────────

describe("canonicalizeBackendManifest", () => {
  it("is stable across object-key-order shuffles", () => {
    const m1 = manifest();
    const m2: BackendManifest = {
      issuedAt: m1.issuedAt,
      license: m1.license,
      rateScheduleHash: m1.rateScheduleHash,
      authors: m1.authors,
      className: m1.className,
      plrVersionRange: m1.plrVersionRange,
      plrModulePath: m1.plrModulePath,
      schemaVersion: m1.schemaVersion,
    };
    expect(canonicalizeBackendManifest(m1)).toBe(canonicalizeBackendManifest(m2));
  });

  it("changes when content changes", () => {
    expect(canonicalizeBackendManifest(manifest({ className: "X" }))).not.toBe(
      canonicalizeBackendManifest(manifest({ className: "Y" })),
    );
  });
});

// ── manifestCid ────────────────────────────────────────────────────────

describe("manifestCid", () => {
  it("is deterministic", async () => {
    const m = manifest();
    const a = await manifestCid(m);
    const b = await manifestCid(m);
    expect(a).toBe(b);
  });

  it("differs across distinct manifests", async () => {
    const a = await manifestCid(manifest({ className: "A" }));
    const b = await manifestCid(manifest({ className: "B" }));
    expect(a).not.toBe(b);
  });

  it("returns a 0x-prefixed bytes32", async () => {
    const cid = await manifestCid(manifest());
    expect(cid).toMatch(/^0x[a-f0-9]{64}$/);
  });
});

// ── sumAuthorBps / validateAuthorGroupBps ──────────────────────────────

describe("sumAuthorBps", () => {
  it("sums correctly", () => {
    expect(
      sumAuthorBps([
        author({ groupBps: 6000 }),
        author({ groupBps: 3000 }),
        author({ groupBps: 1000 }),
      ]),
    ).toBe(10000);
  });

  it("returns 0 for empty array", () => {
    expect(sumAuthorBps([])).toBe(0);
  });
});

describe("validateAuthorGroupBps", () => {
  it("returns null for valid sums", () => {
    expect(
      validateAuthorGroupBps([author({ groupBps: 10000 })]),
    ).toBeNull();
    expect(
      validateAuthorGroupBps([
        author({ groupBps: 5000 }),
        author({ groupBps: 5000 }),
      ]),
    ).toBeNull();
  });

  it("returns an error message for bad sums", () => {
    expect(
      validateAuthorGroupBps([author({ groupBps: 9999 })]),
    ).toContain("10000");
  });
});

describe("isStructurallyValidBackendManifest", () => {
  it("accepts a valid manifest", () => {
    expect(isStructurallyValidBackendManifest(manifest())).toBe(true);
  });

  it("rejects a manifest with bad bps sum", () => {
    expect(
      isStructurallyValidBackendManifest(
        manifest({ authors: [author({ groupBps: 5000 })] }),
      ),
    ).toBe(false);
  });
});

// ── address ↔ bytes32 round-trip ───────────────────────────────────────

describe("addressToDelegatedAgentBytes32 / delegatedAgentBytes32ToAddress", () => {
  it("round-trips correctly", () => {
    const addr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
    const b32 = addressToDelegatedAgentBytes32(addr);
    expect(b32).toMatch(/^0x[a-f0-9]{64}$/);
    expect(delegatedAgentBytes32ToAddress(b32)).toBe(addr);
  });

  it("left-pads with zeros so the address is in the last 20 bytes", () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;
    const b32 = addressToDelegatedAgentBytes32(addr);
    // Expect 24 leading zero hex chars followed by the address (40 chars).
    expect(b32).toBe(
      "0x000000000000000000000000" + addr.slice(2),
    );
  });

  it("rejects invalid addresses", () => {
    expect(() =>
      addressToDelegatedAgentBytes32("0xnotanaddress" as `0x${string}`),
    ).toThrow();
  });

  it("decodes zero bytes32 to address(0)", () => {
    const zero = "0x" + "0".repeat(64);
    expect(delegatedAgentBytes32ToAddress(zero as `0x${string}`)).toBe(
      "0x0000000000000000000000000000000000000000",
    );
  });
});
