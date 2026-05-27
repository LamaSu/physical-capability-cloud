/**
 * Resolver + lookup helper tests.
 */

import { describe, it, expect } from "vitest";
import {
  getBridgeDirectory,
  lookupBridge,
  filterByStatus,
  filterByCapabilityType,
} from "../src/resolver.js";
import { OnchainNotImplementedError } from "../src/onchain-source.js";
import type { BridgeDirectory } from "../src/types.js";

const seedDirectory: BridgeDirectory = {
  name: "PCC Bridge Directory",
  timestamp: "2026-05-27T00:00:00Z",
  version: { major: 0, minor: 1, patch: 0 },
  bridges: [
    {
      namespace: "hamilton",
      name: "Hamilton STAR",
      repoUrl: "https://github.com/LamaSu/hamilton-pcc-bridge",
      maintainerAddress: "0x0000000000000000000000000000000000000000",
      adapterPackage: "@pcc/hamilton",
      version: "0.1.0",
      status: "active",
      capabilityTypes: ["liquid-handling-prep"],
    },
    {
      namespace: "trilobio",
      name: "Trilobio",
      repoUrl: "https://github.com/LamaSu/trilobio-pcc-bridge",
      maintainerAddress: "0x0000000000000000000000000000000000000000",
      adapterPackage: "@pcc/trilobio",
      version: "0.1.0",
      status: "experimental",
      capabilityTypes: ["liquid-handling-trilobio"],
    },
    {
      namespace: "pylabrobot",
      name: "PyLabRobot",
      repoUrl: "https://github.com/LamaSu/pylabrobot-pcc-bridge",
      maintainerAddress: "0x0000000000000000000000000000000000000000",
      adapterPackage: "@pcc/adapter-pylabrobot",
      version: "0.1.0",
      status: "deprecated",
    },
  ],
};

function makeMockFetch(body: unknown) {
  return async () =>
    ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => body,
    }) as unknown as Response;
}

describe("getBridgeDirectory (source dispatch)", () => {
  it("defaults to JSON source", async () => {
    const out = await getBridgeDirectory({
      jsonUrl: "https://test.invalid/bridges.json",
      fetchImpl: makeMockFetch(seedDirectory),
    });
    expect(out.bridges).toHaveLength(3);
  });

  it("explicit source: json works the same", async () => {
    const out = await getBridgeDirectory({
      source: "json",
      jsonUrl: "https://test.invalid/bridges.json",
      fetchImpl: makeMockFetch(seedDirectory),
    });
    expect(out.bridges).toHaveLength(3);
  });

  it("source: onchain throws OnchainNotImplementedError in Phase 1", async () => {
    await expect(
      getBridgeDirectory({ source: "onchain" }),
    ).rejects.toBeInstanceOf(OnchainNotImplementedError);
  });

  it("source: auto falls back to JSON in Phase 1", async () => {
    const out = await getBridgeDirectory({
      source: "auto",
      jsonUrl: "https://test.invalid/bridges.json",
      fetchImpl: makeMockFetch(seedDirectory),
    });
    expect(out.bridges).toHaveLength(3);
  });
});

describe("lookupBridge", () => {
  it("returns the hamilton entry by namespace", () => {
    const b = lookupBridge(seedDirectory, "hamilton");
    expect(b).not.toBeNull();
    expect(b!.name).toBe("Hamilton STAR");
  });

  it("returns null for unknown namespace", () => {
    expect(lookupBridge(seedDirectory, "nonexistent")).toBeNull();
  });

  it("is case-sensitive (namespaces are lowercase per schema)", () => {
    expect(lookupBridge(seedDirectory, "Hamilton")).toBeNull();
  });
});

describe("filterByStatus", () => {
  it("returns only active bridges", () => {
    const active = filterByStatus(seedDirectory, "active");
    expect(active).toHaveLength(1);
    expect(active[0]!.namespace).toBe("hamilton");
  });

  it("returns only experimental bridges", () => {
    const exp = filterByStatus(seedDirectory, "experimental");
    expect(exp).toHaveLength(1);
    expect(exp[0]!.namespace).toBe("trilobio");
  });

  it("returns only deprecated bridges", () => {
    const dep = filterByStatus(seedDirectory, "deprecated");
    expect(dep).toHaveLength(1);
    expect(dep[0]!.namespace).toBe("pylabrobot");
  });

  it("returns empty array for removed (none in seed)", () => {
    expect(filterByStatus(seedDirectory, "removed")).toHaveLength(0);
  });
});

describe("filterByCapabilityType", () => {
  it("matches bridges declaring the capability", () => {
    const out = filterByCapabilityType(
      seedDirectory,
      "liquid-handling-prep",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.namespace).toBe("hamilton");
  });

  it("excludes bridges with no declared capabilityTypes", () => {
    const out = filterByCapabilityType(seedDirectory, "anything");
    // pylabrobot has no capabilityTypes in this fixture, so it's excluded
    expect(out.find((b) => b.namespace === "pylabrobot")).toBeUndefined();
  });
});
