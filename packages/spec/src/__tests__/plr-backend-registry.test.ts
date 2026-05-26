/**
 * Tests for plr-backend-registry.ts — schema validation + invariant checks.
 *
 * Doesn't sign anything (signing lives in util/plr-backend-manifest.ts and
 * is tested separately). Validates that the types reject obvious garbage.
 */

import { describe, it, expect } from "vitest";
import {
  BackendRecordSchema,
  BackendManifestSchema,
  BackendManifestAuthorSchema,
  SignedBackendManifestSchema,
  BackendDisabledError,
  PLR_DEFAULT_RATE_BPS,
  PLR_BACKEND_IP_ID_PREFIX,
  type BackendManifest,
  type BackendRecord,
} from "../types/plr-backend-registry.js";

const ZERO_BYTES32 = "0x" + "0".repeat(64);
const HASH_A = "0x" + "a".repeat(64);
const ADDR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const VALID_MODULE_PATH =
  "pylabrobot.liquid_handling.backends.hamilton.STAR";

function makeAuthor(overrides: Partial<{
  address: string;
  groupBps: number;
  name: string;
  handle: string;
  role: "maintainer" | "co-author" | "occasional-contributor";
}> = {}) {
  return {
    address: ADDR_A,
    groupBps: 10000,
    ...overrides,
  };
}

function makeManifest(
  overrides: Partial<BackendManifest> = {},
): BackendManifest {
  return {
    schemaVersion: 1,
    plrModulePath: VALID_MODULE_PATH,
    plrVersionRange: ">=0.2.0 <0.3.0",
    className: "STARBackend",
    authors: [makeAuthor()],
    rateScheduleHash: HASH_A,
    license: "MIT",
    issuedAt: "2026-05-25T00:00:00.000Z",
    ...overrides,
  };
}

function makeRecord(overrides: Partial<BackendRecord> = {}): BackendRecord {
  return {
    modulePath: VALID_MODULE_PATH,
    modulePathKey: HASH_A,
    scheduleHash: HASH_A,
    delegatedAgentId: ZERO_BYTES32,
    manifestCid: HASH_A,
    contributorTokenId: "1",
    registeredAt: 1716700000,
    lastEnabledChange: 1716700000,
    enabled: true,
    ...overrides,
  };
}

// ── BackendRecordSchema ────────────────────────────────────────────────

describe("BackendRecordSchema", () => {
  it("accepts a minimal valid record", () => {
    expect(() => BackendRecordSchema.parse(makeRecord())).not.toThrow();
  });

  it("rejects an invalid PLR module path", () => {
    expect(() =>
      BackendRecordSchema.parse(makeRecord({ modulePath: "not.pylabrobot.x" })),
    ).toThrow();
  });

  it("rejects a non-hex modulePathKey", () => {
    expect(() =>
      BackendRecordSchema.parse(
        makeRecord({ modulePathKey: "0xnothex" }),
      ),
    ).toThrow();
  });

  it("rejects a non-numeric contributorTokenId", () => {
    expect(() =>
      BackendRecordSchema.parse(makeRecord({ contributorTokenId: "abc" })),
    ).toThrow();
  });

  it("accepts a record with a delegated agent", () => {
    expect(() =>
      BackendRecordSchema.parse(makeRecord({ delegatedAgentId: HASH_A })),
    ).not.toThrow();
  });

  it("accepts a disabled record", () => {
    expect(() =>
      BackendRecordSchema.parse(makeRecord({ enabled: false })),
    ).not.toThrow();
  });
});

// ── BackendManifestAuthorSchema ────────────────────────────────────────

describe("BackendManifestAuthorSchema", () => {
  it("accepts a sole maintainer", () => {
    expect(() =>
      BackendManifestAuthorSchema.parse(makeAuthor()),
    ).not.toThrow();
  });

  it("accepts co-author splits", () => {
    expect(() =>
      BackendManifestAuthorSchema.parse(
        makeAuthor({
          address: ADDR_B,
          groupBps: 3000,
          name: "Co Author",
          role: "co-author",
        }),
      ),
    ).not.toThrow();
  });

  it("rejects groupBps > 10000", () => {
    expect(() =>
      BackendManifestAuthorSchema.parse(
        makeAuthor({ groupBps: 10001 }),
      ),
    ).toThrow();
  });

  it("rejects non-EVM addresses", () => {
    expect(() =>
      BackendManifestAuthorSchema.parse(
        makeAuthor({ address: "0xnotanaddress" }),
      ),
    ).toThrow();
  });
});

// ── BackendManifestSchema ──────────────────────────────────────────────

describe("BackendManifestSchema", () => {
  it("accepts a minimal single-author manifest", () => {
    expect(() => BackendManifestSchema.parse(makeManifest())).not.toThrow();
  });

  it("accepts up to 8 co-authors", () => {
    const authors = Array.from({ length: 8 }, (_, i) =>
      makeAuthor({
        address: ("0x" + (i + 1).toString().padStart(40, "0")) as `0x${string}`,
        groupBps: 10000 / 8,
      }),
    );
    expect(() =>
      BackendManifestSchema.parse(makeManifest({ authors })),
    ).not.toThrow();
  });

  it("rejects more than 8 co-authors", () => {
    const authors = Array.from({ length: 9 }, (_, i) =>
      makeAuthor({
        address: ("0x" + (i + 1).toString().padStart(40, "0")) as `0x${string}`,
        groupBps: 1000,
      }),
    );
    expect(() =>
      BackendManifestSchema.parse(makeManifest({ authors })),
    ).toThrow();
  });

  it("rejects empty authors array", () => {
    expect(() =>
      BackendManifestSchema.parse(makeManifest({ authors: [] })),
    ).toThrow();
  });

  it("rejects a manifest with the wrong schemaVersion", () => {
    expect(() =>
      BackendManifestSchema.parse(
        makeManifest({ schemaVersion: 2 as unknown as 1 }),
      ),
    ).toThrow();
  });

  it("rejects a manifest with non-MIT license", () => {
    expect(() =>
      BackendManifestSchema.parse(
        makeManifest({ license: "Apache-2.0" as unknown as "MIT" }),
      ),
    ).toThrow();
  });

  it("accepts a manifest with optional delegatedAgentId", () => {
    expect(() =>
      BackendManifestSchema.parse(
        makeManifest({ delegatedAgentId: HASH_A }),
      ),
    ).not.toThrow();
  });
});

// ── SignedBackendManifestSchema ────────────────────────────────────────

describe("SignedBackendManifestSchema", () => {
  it("accepts a manifest + 65-byte signature", () => {
    expect(() =>
      SignedBackendManifestSchema.parse({
        manifest: makeManifest(),
        signature: "0x" + "ab".repeat(65),
        signerAddress: ADDR_A,
      }),
    ).not.toThrow();
  });

  it("accepts a signed manifest without pre-computed signerAddress", () => {
    expect(() =>
      SignedBackendManifestSchema.parse({
        manifest: makeManifest(),
        signature: "0xdeadbeef",
      }),
    ).not.toThrow();
  });
});

// ── BackendDisabledError ───────────────────────────────────────────────

describe("BackendDisabledError", () => {
  it("includes the modulePath in the message", () => {
    const err = new BackendDisabledError({
      modulePath: VALID_MODULE_PATH,
      author: ADDR_A,
    });
    expect(err.message).toContain(VALID_MODULE_PATH);
    expect(err.message).toContain(ADDR_A);
    expect(err.name).toBe("BackendDisabledError");
  });

  it("works without optional fields", () => {
    const err = new BackendDisabledError({
      modulePath: VALID_MODULE_PATH,
    });
    expect(err.modulePath).toBe(VALID_MODULE_PATH);
    expect(err.author).toBeUndefined();
  });
});

// ── Constants ──────────────────────────────────────────────────────────

describe("PLR backend registry constants", () => {
  it("default rate is 10 bps per validated answer Q1", () => {
    expect(PLR_DEFAULT_RATE_BPS).toBe(10);
  });

  it("ipId prefix is pylabrobot:", () => {
    expect(PLR_BACKEND_IP_ID_PREFIX).toBe("pylabrobot:");
  });
});
