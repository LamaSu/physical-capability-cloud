import { describe, it, expect, beforeEach } from "vitest";
import { PCCNFTClient } from "../pcc-nft-client.js";
import type { PCCAsset } from "../types.js";

describe("PCCNFTClient", () => {
  let client: PCCNFTClient;

  beforeEach(() => {
    client = new PCCNFTClient({ mock: true });
  });

  // ── Mint ────────────────────────────────────────────────────

  describe("mint", () => {
    it("creates an asset with correct fields", async () => {
      const { address, signature } = await client.mint({
        name: "PCC FDM Tier 2",
        uri: "https://pcc.network/metadata/cert-1.json",
        owner: "OwnerPubkey11111111111111111111111111111111",
      });

      expect(address).toBeTruthy();
      expect(address.startsWith("PCC")).toBe(true);
      expect(signature).toBeTruthy();
      expect(signature.length).toBe(88);

      const asset = await client.fetchAsset(address);
      expect(asset).not.toBeNull();
      expect(asset!.name).toBe("PCC FDM Tier 2");
      expect(asset!.uri).toBe("https://pcc.network/metadata/cert-1.json");
      expect(asset!.owner).toBe("OwnerPubkey11111111111111111111111111111111");
      expect(asset!.authority).toBeTruthy();
    });

    it("defaults to permanentlyFrozen=true (soulbound)", async () => {
      const { address } = await client.mint({
        name: "Soulbound Cert",
        uri: "https://example.com/meta.json",
        owner: "OwnerA",
      });

      const asset = await client.fetchAsset(address);
      expect(asset!.frozen).toBe(true);
    });

    it("respects permanentlyFrozen=false when explicitly set", async () => {
      const { address } = await client.mint({
        name: "Transferable NFT",
        uri: "https://example.com/meta.json",
        owner: "OwnerA",
        permanentlyFrozen: false,
      });

      const asset = await client.fetchAsset(address);
      expect(asset!.frozen).toBe(false);
    });

    it("stores attributes as key-value pairs", async () => {
      const { address } = await client.mint({
        name: "CNC Certificate",
        uri: "https://example.com/cnc.json",
        owner: "OwnerB",
        attributes: {
          capabilityType: "cnc-3axis",
          assuranceTier: "3",
          kernelDid: "did:pcc:kernel:shop-42",
          material: "aluminum-6061",
        },
      });

      const asset = await client.fetchAsset(address);
      expect(asset!.attributes).toEqual({
        capabilityType: "cnc-3axis",
        assuranceTier: "3",
        kernelDid: "did:pcc:kernel:shop-42",
        material: "aluminum-6061",
      });
    });

    it("assigns a createdAt timestamp", async () => {
      const before = new Date().toISOString();
      const { address } = await client.mint({
        name: "Timestamped",
        uri: "https://example.com",
        owner: "OwnerC",
      });
      const after = new Date().toISOString();

      const asset = await client.fetchAsset(address);
      expect(asset!.createdAt).toBeTruthy();
      expect(asset!.createdAt >= before).toBe(true);
      expect(asset!.createdAt <= after).toBe(true);
    });

    it("increments totalMinted for each mint", async () => {
      expect(client.totalMinted).toBe(0);

      await client.mint({ name: "A", uri: "u", owner: "O1" });
      expect(client.totalMinted).toBe(1);

      await client.mint({ name: "B", uri: "u", owner: "O2" });
      expect(client.totalMinted).toBe(2);

      await client.mint({ name: "C", uri: "u", owner: "O3" });
      expect(client.totalMinted).toBe(3);
    });

    it("mints with empty attributes when none provided", async () => {
      const { address } = await client.mint({
        name: "No Attrs",
        uri: "https://example.com",
        owner: "OwnerD",
      });

      const asset = await client.fetchAsset(address);
      expect(asset!.attributes).toEqual({});
    });
  });

  // ── Transfer (soulbound invariant) ──────────────────────────

  describe("transfer", () => {
    it("always throws for soulbound assets", async () => {
      const { address } = await client.mint({
        name: "Soulbound",
        uri: "https://example.com",
        owner: "OwnerA",
      });

      await expect(
        client.transfer(address, "NewOwner111111111111111111111111111111111"),
      ).rejects.toThrow("Asset is permanently frozen (soulbound)");
    });

    it("throws even for non-existent addresses", async () => {
      await expect(
        client.transfer("FakeAddress123", "NewOwner"),
      ).rejects.toThrow("Asset is permanently frozen (soulbound)");
    });
  });

  // ── Burn ────────────────────────────────────────────────────

  describe("burn", () => {
    it("destroys the asset so fetchAsset returns null", async () => {
      const { address } = await client.mint({
        name: "ToBeDestroyed",
        uri: "https://example.com",
        owner: "OwnerE",
      });

      expect(await client.fetchAsset(address)).not.toBeNull();

      const result = await client.burn({ assetAddress: address });
      expect(result.signature).toBeTruthy();

      expect(await client.fetchAsset(address)).toBeNull();
    });

    it("decrements collection size on burn", async () => {
      const { address: collAddr } = await client.createCollection({
        name: "Test Collection",
        uri: "https://example.com/coll.json",
      });

      const { address: assetAddr } = await client.mint({
        name: "Member",
        uri: "https://example.com",
        owner: "OwnerF",
        collection: collAddr,
      });

      const collBefore = await client.fetchCollection(collAddr);
      expect(collBefore!.size).toBe(1);

      await client.burn({ assetAddress: assetAddr });

      const collAfter = await client.fetchCollection(collAddr);
      expect(collAfter!.size).toBe(0);
    });

    it("throws when burning non-existent asset", async () => {
      await expect(
        client.burn({ assetAddress: "DoesNotExist" }),
      ).rejects.toThrow("Asset not found");
    });
  });

  // ── Update ──────────────────────────────────────────────────

  describe("update", () => {
    it("updates name and uri", async () => {
      const { address } = await client.mint({
        name: "Original Name",
        uri: "https://example.com/old.json",
        owner: "OwnerG",
      });

      const result = await client.update({
        assetAddress: address,
        newName: "Updated Name",
        newUri: "https://example.com/new.json",
      });

      expect(result.signature).toBeTruthy();

      const asset = await client.fetchAsset(address);
      expect(asset!.name).toBe("Updated Name");
      expect(asset!.uri).toBe("https://example.com/new.json");
    });

    it("merges new attributes with existing ones", async () => {
      const { address } = await client.mint({
        name: "With Attrs",
        uri: "https://example.com",
        owner: "OwnerH",
        attributes: { tier: "2", material: "PLA" },
      });

      await client.update({
        assetAddress: address,
        newAttributes: { material: "PETG", calibrated: "true" },
      });

      const asset = await client.fetchAsset(address);
      expect(asset!.attributes).toEqual({
        tier: "2",
        material: "PETG",
        calibrated: "true",
      });
    });

    it("throws for non-existent asset", async () => {
      await expect(
        client.update({ assetAddress: "NoSuchAsset", newName: "X" }),
      ).rejects.toThrow("Asset not found");
    });
  });

  // ── fetchAsset ──────────────────────────────────────────────

  describe("fetchAsset", () => {
    it("returns null for nonexistent address", async () => {
      const result = await client.fetchAsset("nonexistent_address_12345");
      expect(result).toBeNull();
    });

    it("returns the correct asset for valid address", async () => {
      const { address } = await client.mint({
        name: "Fetchable",
        uri: "https://example.com/fetch.json",
        owner: "OwnerI",
      });

      const asset = await client.fetchAsset(address);
      expect(asset).not.toBeNull();
      expect(asset!.name).toBe("Fetchable");
    });
  });

  // ── Collection ──────────────────────────────────────────────

  describe("collection", () => {
    it("creates a collection with correct fields", async () => {
      const { address } = await client.createCollection({
        name: "PCC Capability Certificates",
        uri: "https://pcc.network/metadata/collection.json",
        maxSize: 10000,
      });

      expect(address).toBeTruthy();

      const coll = await client.fetchCollection(address);
      expect(coll).not.toBeNull();
      expect(coll!.name).toBe("PCC Capability Certificates");
      expect(coll!.uri).toBe("https://pcc.network/metadata/collection.json");
      expect(coll!.size).toBe(0);
      expect(coll!.maxSize).toBe(10000);
      expect(coll!.authority).toBeTruthy();
    });

    it("tracks collection membership on mint", async () => {
      const { address: collAddr } = await client.createCollection({
        name: "Test Coll",
        uri: "https://example.com",
      });

      await client.mint({
        name: "Member 1",
        uri: "u",
        owner: "O1",
        collection: collAddr,
      });
      await client.mint({
        name: "Member 2",
        uri: "u",
        owner: "O2",
        collection: collAddr,
      });

      const coll = await client.fetchCollection(collAddr);
      expect(coll!.size).toBe(2);
    });

    it("rejects mint if collection is full", async () => {
      const { address: collAddr } = await client.createCollection({
        name: "Tiny Coll",
        uri: "https://example.com",
        maxSize: 1,
      });

      await client.mint({
        name: "First",
        uri: "u",
        owner: "O1",
        collection: collAddr,
      });

      await expect(
        client.mint({
          name: "Second",
          uri: "u",
          owner: "O2",
          collection: collAddr,
        }),
      ).rejects.toThrow("full");
    });

    it("rejects mint if collection does not exist", async () => {
      await expect(
        client.mint({
          name: "Orphan",
          uri: "u",
          owner: "O1",
          collection: "NonExistentCollection",
        }),
      ).rejects.toThrow("Collection not found");
    });
  });

  // ── listByOwner ─────────────────────────────────────────────

  describe("listByOwner", () => {
    it("returns only assets owned by the specified owner", async () => {
      await client.mint({ name: "A", uri: "u", owner: "Alice" });
      await client.mint({ name: "B", uri: "u", owner: "Bob" });
      await client.mint({ name: "C", uri: "u", owner: "Alice" });

      const aliceAssets = await client.listByOwner("Alice");
      expect(aliceAssets).toHaveLength(2);
      expect(aliceAssets.every((a) => a.owner === "Alice")).toBe(true);

      const bobAssets = await client.listByOwner("Bob");
      expect(bobAssets).toHaveLength(1);
      expect(bobAssets[0].name).toBe("B");
    });

    it("returns empty array for unknown owner", async () => {
      const assets = await client.listByOwner("Nobody");
      expect(assets).toEqual([]);
    });
  });

  // ── listByCollection ────────────────────────────────────────

  describe("listByCollection", () => {
    it("returns only assets in the specified collection", async () => {
      const { address: coll1 } = await client.createCollection({
        name: "C1",
        uri: "u",
      });
      const { address: coll2 } = await client.createCollection({
        name: "C2",
        uri: "u",
      });

      await client.mint({ name: "A", uri: "u", owner: "O", collection: coll1 });
      await client.mint({ name: "B", uri: "u", owner: "O", collection: coll2 });
      await client.mint({ name: "C", uri: "u", owner: "O", collection: coll1 });

      const coll1Assets = await client.listByCollection(coll1);
      expect(coll1Assets).toHaveLength(2);
      expect(coll1Assets.map((a) => a.name).sort()).toEqual(["A", "C"]);

      const coll2Assets = await client.listByCollection(coll2);
      expect(coll2Assets).toHaveLength(1);
      expect(coll2Assets[0].name).toBe("B");
    });

    it("returns empty array for unknown collection", async () => {
      const assets = await client.listByCollection("NoSuchCollection");
      expect(assets).toEqual([]);
    });
  });

  // ── Zero protocol fees ──────────────────────────────────────

  describe("zero protocol fees", () => {
    it("has no Metaplex fee field or protocol fee on mint", async () => {
      const result = await client.mint({
        name: "Fee Free",
        uri: "https://example.com",
        owner: "OwnerJ",
      });

      // The result contains only address and signature — no fee field
      expect(result).toEqual({
        address: expect.any(String),
        signature: expect.any(String),
      });

      // The asset has no fee-related fields
      const asset = await client.fetchAsset(result.address);
      expect(asset).not.toHaveProperty("protocolFee");
      expect(asset).not.toHaveProperty("metaplexFee");
      expect(asset).not.toHaveProperty("fee");

      // Verify only the expected fields exist
      const keys = Object.keys(asset!).sort();
      expect(keys).toEqual([
        "address",
        "attributes",
        "authority",
        "collection",
        "createdAt",
        "frozen",
        "name",
        "owner",
        "uri",
      ]);
    });
  });

  // ── Authority enforcement ───────────────────────────────────

  describe("authority enforcement", () => {
    it("blocks update from a different client (different authority)", async () => {
      // Mint from client 1
      const { address } = await client.mint({
        name: "Client1 Asset",
        uri: "u",
        owner: "OwnerK",
      });

      // Create a second client (different authority)
      const client2 = new PCCNFTClient({ mock: true });

      // Client2 cannot update client1's asset because authorities differ
      await expect(
        client2.update({ assetAddress: address, newName: "Hijacked" }),
      ).rejects.toThrow("Asset not found");
      // Note: in mock mode, each client has its own isolated state,
      // so the asset won't even be found. On-chain, the authority check
      // would reject the transaction with "Unauthorized".
    });

    it("blocks burn from a different client (different authority)", async () => {
      const { address } = await client.mint({
        name: "Client1 Asset",
        uri: "u",
        owner: "OwnerL",
      });

      const client2 = new PCCNFTClient({ mock: true });

      await expect(
        client2.burn({ assetAddress: address }),
      ).rejects.toThrow("Asset not found");
    });
  });

  // ── Edge cases ──────────────────────────────────────────────

  describe("edge cases", () => {
    it("supports collection without maxSize (unlimited)", async () => {
      const { address } = await client.createCollection({
        name: "Unlimited",
        uri: "u",
      });

      const coll = await client.fetchCollection(address);
      expect(coll!.maxSize).toBeUndefined();

      // Should be able to mint many
      for (let i = 0; i < 10; i++) {
        await client.mint({
          name: `Asset ${i}`,
          uri: "u",
          owner: "O",
          collection: address,
        });
      }

      const collAfter = await client.fetchCollection(address);
      expect(collAfter!.size).toBe(10);
    });

    it("liveAssetCount decreases after burn", async () => {
      await client.mint({ name: "A", uri: "u", owner: "O" });
      const { address } = await client.mint({ name: "B", uri: "u", owner: "O" });
      await client.mint({ name: "C", uri: "u", owner: "O" });

      expect(client.liveAssetCount).toBe(3);
      expect(client.totalMinted).toBe(3);

      await client.burn({ assetAddress: address });

      expect(client.liveAssetCount).toBe(2);
      // totalMinted does not decrease — it tracks all-time mints
      expect(client.totalMinted).toBe(3);
    });
  });
});
