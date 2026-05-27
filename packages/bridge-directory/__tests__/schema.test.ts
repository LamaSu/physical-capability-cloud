/**
 * Zod schema validation tests — locks the schema against the JSON Schema
 * specified in ai/research/bridge-directory-schema-2026-05-26.md §6.
 */

import { describe, it, expect } from "vitest";
import {
  BridgeDirectorySchema,
  BridgeEntrySchema,
  BridgeStatusSchema,
  BridgeSLASchema,
  parseRegistries,
} from "../src/schema.js";

const validEntry = {
  namespace: "hamilton",
  name: "Hamilton STAR",
  repoUrl: "https://github.com/LamaSu/hamilton-pcc-bridge",
  maintainerAddress: "0x4547ec0879f5d6b7a3c8f2e9a1b4c5d6e7f8901a",
  adapterPackage: "@pcc/hamilton",
  version: "1.2.0",
  status: "active" as const,
};

const validDirectory = {
  name: "PCC Bridge Directory",
  timestamp: "2026-05-27T00:00:00Z",
  version: { major: 0, minor: 1, patch: 0 },
  bridges: [validEntry],
};

describe("BridgeStatusSchema", () => {
  it("accepts the 4 documented statuses", () => {
    for (const s of ["experimental", "active", "deprecated", "removed"]) {
      expect(BridgeStatusSchema.parse(s)).toBe(s);
    }
  });

  it("rejects unknown status strings", () => {
    expect(() => BridgeStatusSchema.parse("retired")).toThrow();
    expect(() => BridgeStatusSchema.parse("")).toThrow();
  });
});

describe("BridgeEntrySchema (required fields)", () => {
  it("accepts a minimal valid entry", () => {
    const out = BridgeEntrySchema.parse(validEntry);
    expect(out.namespace).toBe("hamilton");
    expect(out.maintainerAddress).toBe(
      "0x4547ec0879f5d6b7a3c8f2e9a1b4c5d6e7f8901a",
    );
  });

  it("lowercases maintainerAddress on parse", () => {
    const mixed = {
      ...validEntry,
      maintainerAddress: "0x4547EC0879F5D6B7A3C8F2E9A1B4C5D6E7F8901A",
    };
    const out = BridgeEntrySchema.parse(mixed);
    expect(out.maintainerAddress).toBe(
      "0x4547ec0879f5d6b7a3c8f2e9a1b4c5d6e7f8901a",
    );
  });

  it("rejects invalid namespaces", () => {
    // uppercase
    expect(() =>
      BridgeEntrySchema.parse({ ...validEntry, namespace: "Hamilton" }),
    ).toThrow();
    // leading hyphen
    expect(() =>
      BridgeEntrySchema.parse({ ...validEntry, namespace: "-hamilton" }),
    ).toThrow();
    // too long (>31 chars)
    expect(() =>
      BridgeEntrySchema.parse({
        ...validEntry,
        namespace: "a".repeat(32),
      }),
    ).toThrow();
  });

  it("rejects malformed maintainerAddress", () => {
    expect(() =>
      BridgeEntrySchema.parse({
        ...validEntry,
        maintainerAddress: "0xshort",
      }),
    ).toThrow();
    expect(() =>
      BridgeEntrySchema.parse({
        ...validEntry,
        maintainerAddress: "4547ec0879f5d6b7a3c8f2e9a1b4c5d6e7f8901a", // missing 0x
      }),
    ).toThrow();
  });

  it("rejects malformed semver", () => {
    expect(() =>
      BridgeEntrySchema.parse({ ...validEntry, version: "1.0" }),
    ).toThrow();
    expect(() =>
      BridgeEntrySchema.parse({ ...validEntry, version: "v1.0.0" }),
    ).toThrow();
  });

  it("accepts pre-release semver suffix", () => {
    const out = BridgeEntrySchema.parse({
      ...validEntry,
      version: "1.0.0-beta.1",
    });
    expect(out.version).toBe("1.0.0-beta.1");
  });

  it("rejects unknown top-level fields (strict mode)", () => {
    expect(() =>
      BridgeEntrySchema.parse({ ...validEntry, randomField: "x" }),
    ).toThrow();
  });
});

describe("BridgeEntrySchema (optional fields)", () => {
  it("accepts trustTier 0-3", () => {
    for (const t of [0, 1, 2, 3]) {
      const out = BridgeEntrySchema.parse({ ...validEntry, trustTier: t });
      expect(out.trustTier).toBe(t);
    }
  });

  it("rejects trustTier out of range", () => {
    expect(() =>
      BridgeEntrySchema.parse({ ...validEntry, trustTier: 4 }),
    ).toThrow();
    expect(() =>
      BridgeEntrySchema.parse({ ...validEntry, trustTier: -1 }),
    ).toThrow();
  });

  it("accepts registries with chainId-keyed map", () => {
    const out = BridgeEntrySchema.parse({
      ...validEntry,
      registries: {
        "8453": "0xAaB3F94f8c7e5d9b6a2f1c4d3e5f6a7b8c9d0eA6",
        "84532": "0x43643ebf2a3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e",
      },
    });
    expect(Object.keys(out.registries!)).toHaveLength(2);
  });

  it("rejects registries with non-numeric keys", () => {
    expect(() =>
      BridgeEntrySchema.parse({
        ...validEntry,
        registries: { base: "0xAaB3F94f8c7e5d9b6a2f1c4d3e5f6a7b8c9d0eA6" },
      }),
    ).toThrow();
  });

  it("accepts SLA with all optional fields", () => {
    const out = BridgeEntrySchema.parse({
      ...validEntry,
      sla: {
        uptime: 99.5,
        responseMs: 250,
        contact: "https://example.com/contact",
      },
    });
    expect(out.sla?.uptime).toBe(99.5);
  });

  it("rejects SLA uptime outside 0-100", () => {
    expect(() =>
      BridgeSLASchema.parse({ uptime: 150 }),
    ).toThrow();
    expect(() =>
      BridgeSLASchema.parse({ uptime: -1 }),
    ).toThrow();
  });

  it("accepts extensions with reverse-DNS keys", () => {
    const out = BridgeEntrySchema.parse({
      ...validEntry,
      extensions: {
        "com.lamasu.firmware": "5.2.1",
        "org.pcc.protocol": 2,
      },
    });
    expect(out.extensions?.["com.lamasu.firmware"]).toBe("5.2.1");
  });

  it("rejects extensions with non-namespaced keys", () => {
    expect(() =>
      BridgeEntrySchema.parse({
        ...validEntry,
        extensions: { firmware: "5.2.1" },
      }),
    ).toThrow();
  });

  it("rejects extensions with more than 10 keys", () => {
    const ext: Record<string, string> = {};
    for (let i = 0; i < 11; i++) {
      ext[`com.lamasu.key${i}`] = `v${i}`;
    }
    expect(() =>
      BridgeEntrySchema.parse({ ...validEntry, extensions: ext }),
    ).toThrow();
  });

  it("accepts maintainerENS in the documented pattern", () => {
    const out = BridgeEntrySchema.parse({
      ...validEntry,
      maintainerENS: "lamasu.eth",
    });
    expect(out.maintainerENS).toBe("lamasu.eth");
  });
});

describe("BridgeDirectorySchema", () => {
  it("accepts a minimal valid directory", () => {
    const out = BridgeDirectorySchema.parse(validDirectory);
    expect(out.bridges).toHaveLength(1);
    expect(out.version.major).toBe(0);
  });

  it("rejects missing required envelope fields", () => {
    const { name: _, ...noName } = validDirectory;
    expect(() => BridgeDirectorySchema.parse(noName)).toThrow();
  });

  it("rejects malformed timestamp", () => {
    expect(() =>
      BridgeDirectorySchema.parse({
        ...validDirectory,
        timestamp: "yesterday",
      }),
    ).toThrow();
  });

  it("rejects more than 500 bridges", () => {
    const big = {
      ...validDirectory,
      bridges: Array.from({ length: 501 }, (_, i) => ({
        ...validEntry,
        namespace: `bridge${i}`,
      })),
    };
    expect(() => BridgeDirectorySchema.parse(big)).toThrow();
  });

  it("accepts an empty bridges array", () => {
    const out = BridgeDirectorySchema.parse({
      ...validDirectory,
      bridges: [],
    });
    expect(out.bridges).toHaveLength(0);
  });
});

describe("parseRegistries", () => {
  it("converts string keys to number keys", () => {
    const out = parseRegistries({
      "8453": "0xAaB3F94f8c7e5d9b6a2f1c4d3e5f6a7b8c9d0eA6",
      "84532": "0x43643ebf2a3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e",
    });
    expect(out![8453]).toBe(
      "0xaab3f94f8c7e5d9b6a2f1c4d3e5f6a7b8c9d0ea6",
    );
    expect(out![84532]).toBe(
      "0x43643ebf2a3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e",
    );
  });

  it("returns undefined for undefined input", () => {
    expect(parseRegistries(undefined)).toBeUndefined();
  });
});
