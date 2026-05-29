import { describe, expect, it, beforeEach } from "vitest";
import { SingleRegion, type SingleRegionBackend } from "../region/single-region.js";
import type { RegionConfig, RegionSearchResult } from "../region/types.js";

const cfg: RegionConfig = {
  id: "us-east-1",
  displayName: "US East 1",
  geolocation: { lat: 38.9, lng: -77.0 },
  publicGatewayUrl: "https://us-east-1.capability.network",
  federationOpen: false,
  peerRegions: [],
  publicKey: "deadbeef",
  status: "online",
};

const sampleResult: RegionSearchResult = {
  cid: "sha256:abc",
  region: "us-east-1",
  mesh: "us-east-1-mesh-a",
  toolId: "tool-1",
  score: 0.9,
};

class StubBackend implements SingleRegionBackend {
  searchResults: RegionSearchResult[] = [];
  resolveMap: Record<string, { toolId: string; mesh: string }> = {};

  async localSearch(): Promise<RegionSearchResult[]> {
    return this.searchResults;
  }

  async localResolveCid(
    cid: string,
  ): Promise<{ toolId: string; mesh: string } | null> {
    return this.resolveMap[cid] ?? null;
  }
}

describe("SingleRegion", () => {
  let backend: StubBackend;
  let region: SingleRegion;

  beforeEach(() => {
    backend = new StubBackend();
    region = new SingleRegion(cfg, backend);
  });

  describe("search", () => {
    it("returns local results untouched", async () => {
      backend.searchResults = [sampleResult];
      const r = await region.search({ q: "summarize" });
      expect(r.results).toEqual([sampleResult]);
    });

    it("always marks crossRegionFanoutFired=false in Phase 1", async () => {
      const r = await region.search({ q: "x", crossRegionFallback: true });
      expect(r.crossRegionFanoutFired).toBe(false);
      expect(r.partial).toBe(false);
    });

    it("tags response with its region id", async () => {
      const r = await region.search({});
      expect(r.region).toBe("us-east-1");
    });

    it("throws once stopped", async () => {
      await region.stop();
      await expect(region.search({})).rejects.toThrow(/stopped/);
    });
  });

  describe("resolveCid", () => {
    it("returns null on local miss", async () => {
      expect(await region.resolveCid("sha256:nope")).toBeNull();
    });

    it("returns local-only locator on hit", async () => {
      backend.resolveMap["sha256:abc"] = {
        toolId: "tool-1",
        mesh: "us-east-1-mesh-a",
      };
      const r = await region.resolveCid("sha256:abc");
      expect(r?.regions).toHaveLength(1);
      expect(r?.regions[0]?.region).toBe("us-east-1");
      expect(r?.regions[0]?.url).toBe(cfg.publicGatewayUrl);
    });

    it("throws once stopped", async () => {
      await region.stop();
      await expect(region.resolveCid("x")).rejects.toThrow(/stopped/);
    });
  });

  describe("announce", () => {
    it("is a no-op in Phase 1 (resolves without error)", async () => {
      await expect(
        region.announce({
          cid: "sha256:abc",
          mesh: "us-east-1-mesh-a",
          skills: ["nlp.summarization"],
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("stop", () => {
    it("is idempotent", async () => {
      await region.stop();
      await expect(region.stop()).resolves.toBeUndefined();
    });
  });
});
