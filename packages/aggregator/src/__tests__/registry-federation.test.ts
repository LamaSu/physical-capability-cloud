/**
 * Tests for the Phase 1 federation extension on IndexedToolRegistry.
 *
 * Verifies:
 *   - Default constructor (no args) preserves pre-federation behavior
 *   - Region context populates regionId/meshId/namespaceId on upsert
 *   - Caller-supplied federation fields win over the context
 *   - ReplicatorAdapter fires on upsert/remove without blocking
 *   - queryByNamespace filters correctly
 *   - Adapter errors do not impact the local upsert
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  IndexedToolRegistry,
  type RegistryRegionContext,
} from "../registry.js";
import type { ReplicatorAdapter } from "../replicator.js";
import {
  type IndexedTool,
  DigitalCaptureClass,
  TrustTier,
} from "@pcc/spec";

const SHA = "sha256:" + "a".repeat(64);

function makeTool(overrides: Partial<IndexedTool> = {}): IndexedTool {
  return {
    id: "tool-x",
    cid: SHA,
    version: "1.0.0",
    source: {
      type: "mcp-directory",
      url: "https://mcp.directory/x",
      fetchedAt: "2026-05-23T00:00:00.000Z",
    },
    ingestedAt: "2026-05-23T00:00:00.000Z",
    ingestionMethod: "mcp-list",
    upstreamUrl: "https://example.com/api",
    skills: ["nlp.summarization"],
    domains: ["data"],
    features: [],
    inputSchema: {},
    description: "summarize documents",
    actionClass: "read",
    assuranceCeiling: DigitalCaptureClass.DCC3,
    trustTier: TrustTier.AUTO_INDEXED,
    knownVulns: [],
    lastFetchedAt: "2026-05-23T00:00:00.000Z",
    invocationCount: 0,
    driftAlerts: [],
    schemaHashHistory: [SHA],
    hostingPeers: [],
    ...overrides,
  };
}

const ctx: RegistryRegionContext = {
  regionId: "us-east-1",
  meshId: "us-east-1-mesh-a",
  defaultNamespaceId: "pcc-public",
};

describe("IndexedToolRegistry — federation extension", () => {
  describe("default constructor (no args)", () => {
    it("does not touch federation fields", () => {
      const reg = new IndexedToolRegistry();
      const tool = makeTool();
      const result = reg.upsert(tool);
      expect(result.regionId).toBeUndefined();
      expect(result.meshId).toBeUndefined();
      expect(result.namespaceId).toBeUndefined();
    });

    it("count and query work as before", () => {
      const reg = new IndexedToolRegistry();
      reg.upsert(makeTool({ id: "a" }));
      reg.upsert(makeTool({ id: "b" }));
      expect(reg.count()).toBe(2);
      expect(reg.query()).toHaveLength(2);
    });
  });

  describe("region context tagging", () => {
    let reg: IndexedToolRegistry;
    beforeEach(() => {
      reg = new IndexedToolRegistry({ regionContext: ctx });
    });

    it("populates regionId/meshId/namespaceId on upsert", () => {
      const result = reg.upsert(makeTool());
      expect(result.regionId).toBe("us-east-1");
      expect(result.meshId).toBe("us-east-1-mesh-a");
      expect(result.namespaceId).toBe("pcc-public");
    });

    it("preserves caller-supplied federation fields (explicit > implicit)", () => {
      const result = reg.upsert(
        makeTool({
          regionId: "eu-west-1",
          meshId: "eu-west-1-mesh-b",
          namespaceId: "tenant-acme",
        }),
      );
      expect(result.regionId).toBe("eu-west-1");
      expect(result.meshId).toBe("eu-west-1-mesh-b");
      expect(result.namespaceId).toBe("tenant-acme");
    });

    it("partial overrides are honored field-by-field", () => {
      const result = reg.upsert(
        makeTool({ namespaceId: "tenant-acme" }),
      );
      expect(result.regionId).toBe("us-east-1"); // from ctx
      expect(result.namespaceId).toBe("tenant-acme"); // from caller
    });

    it("persists the tagged values into the stored record", () => {
      reg.upsert(makeTool({ id: "x" }));
      const stored = reg.get("x");
      expect(stored?.regionId).toBe("us-east-1");
      expect(stored?.namespaceId).toBe("pcc-public");
    });
  });

  describe("queryByNamespace", () => {
    let reg: IndexedToolRegistry;
    beforeEach(() => {
      reg = new IndexedToolRegistry({ regionContext: ctx });
      reg.upsert(makeTool({ id: "public-1" }));
      reg.upsert(makeTool({ id: "public-2" }));
      reg.upsert(makeTool({ id: "acme-1", namespaceId: "tenant-acme" }));
    });

    it("filters to the requested namespace", () => {
      const r = reg.queryByNamespace("pcc-public");
      expect(r.map((t) => t.id).sort()).toEqual(["public-1", "public-2"]);
    });

    it("returns tenant namespace tools", () => {
      const r = reg.queryByNamespace("tenant-acme");
      expect(r.map((t) => t.id)).toEqual(["acme-1"]);
    });

    it("returns empty for unknown namespace", () => {
      expect(reg.queryByNamespace("nope")).toEqual([]);
    });

    it("composes with other filters", () => {
      const r = reg.queryByNamespace("pcc-public", {
        actionClass: "read",
        limit: 1,
      });
      expect(r).toHaveLength(1);
    });
  });

  describe("query with namespaceId filter (no region context)", () => {
    it("still matches tools with explicit namespaceId", () => {
      const reg = new IndexedToolRegistry();
      reg.upsert(makeTool({ id: "a", namespaceId: "x" }));
      reg.upsert(makeTool({ id: "b", namespaceId: "y" }));
      expect(reg.query({ namespaceId: "x" }).map((t) => t.id)).toEqual(["a"]);
    });

    it("with no namespaceId in filter, returns all (pre-federation behavior)", () => {
      const reg = new IndexedToolRegistry();
      reg.upsert(makeTool({ id: "a" }));
      reg.upsert(makeTool({ id: "b", namespaceId: "tagged" }));
      expect(reg.query({})).toHaveLength(2);
    });
  });

  describe("ReplicatorAdapter wiring", () => {
    let upserts: string[];
    let removes: string[];
    let replicator: ReplicatorAdapter;

    beforeEach(() => {
      upserts = [];
      removes = [];
      replicator = {
        onUpsert: (tool) => {
          upserts.push(tool.id);
        },
        onRemove: (id) => {
          removes.push(id);
        },
      };
    });

    it("fires onUpsert with the tagged tool", async () => {
      const reg = new IndexedToolRegistry({ replicator, regionContext: ctx });
      reg.upsert(makeTool({ id: "t-1" }));
      // promise microtask flush
      await new Promise((r) => setImmediate(r));
      expect(upserts).toEqual(["t-1"]);
    });

    it("fires onRemove only when a tool was actually removed", async () => {
      const reg = new IndexedToolRegistry({ replicator });
      reg.upsert(makeTool({ id: "t-1" }));
      reg.remove("t-1");
      reg.remove("does-not-exist");
      await new Promise((r) => setImmediate(r));
      expect(removes).toEqual(["t-1"]);
    });

    it("adapter errors do not propagate to upsert callers", async () => {
      const failing: ReplicatorAdapter = {
        onUpsert: () => {
          throw new Error("replicator down");
        },
        onRemove: () => {
          throw new Error("replicator down");
        },
      };
      const reg = new IndexedToolRegistry({ replicator: failing });
      // No throw expected
      expect(() => reg.upsert(makeTool({ id: "t-1" }))).not.toThrow();
      expect(reg.count()).toBe(1);
      expect(() => reg.remove("t-1")).not.toThrow();
      // give microtask a chance to settle
      await new Promise((r) => setImmediate(r));
    });

    it("adapter onUpsert receives a tool with federation fields when region context is set", async () => {
      let seen: IndexedTool | undefined;
      const cap: ReplicatorAdapter = {
        onUpsert: (tool) => {
          seen = tool;
        },
        onRemove: () => {},
      };
      const reg = new IndexedToolRegistry({
        replicator: cap,
        regionContext: ctx,
      });
      reg.upsert(makeTool({ id: "x" }));
      await new Promise((r) => setImmediate(r));
      expect(seen?.regionId).toBe("us-east-1");
      expect(seen?.namespaceId).toBe("pcc-public");
    });
  });
});
