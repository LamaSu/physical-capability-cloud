/**
 * Tests for Story Protocol DB tables and StoryRepository.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store, StoryRepository } from "../index.js";

describe("@pcc/store — Story Protocol tables", () => {
  let store: Store;

  beforeEach(() => {
    // Seed false — we control all data
    store = createStore({ seed: false });
  });

  afterEach(() => {
    store.close();
  });

  // ── IP Registrations ────────────────────────────────────────────────────────

  describe("storyIpRegistrations", () => {
    it("inserts and retrieves an IP registration by ipId", () => {
      const reg = store.repos.story.insertIpRegistration({
        ipId: "0xip1",
        nftTokenId: "1",
        licenseTermsId: "10",
        txHash: "0xtx1",
        capabilityId: null,
        csdUrl: "pcc://capabilities/cap-001",
        chain: "story-aeneid",
        registeredAt: "2026-03-21T00:00:00.000Z",
      });
      expect(reg).toBeDefined();
      expect(reg!.ipId).toBe("0xip1");

      const found = store.repos.story.findIpById("0xip1");
      expect(found).toBeDefined();
      expect(found!.chain).toBe("story-aeneid");
      expect(found!.nftTokenId).toBe("1");
    });

    it("returns undefined for an unknown ipId", () => {
      const found = store.repos.story.findIpById("0xnonexistent");
      expect(found).toBeUndefined();
    });

    it("lists all IP registrations", () => {
      store.repos.story.insertIpRegistration({
        ipId: "0xip2",
        nftTokenId: "2",
        licenseTermsId: "11",
        txHash: "0xtx2",
        capabilityId: null,
        csdUrl: null,
        chain: "story",
        registeredAt: new Date().toISOString(),
      });
      store.repos.story.insertIpRegistration({
        ipId: "0xip3",
        nftTokenId: "3",
        licenseTermsId: "12",
        txHash: "0xtx3",
        capabilityId: null,
        csdUrl: null,
        chain: "story-aeneid",
        registeredAt: new Date().toISOString(),
      });
      const all = store.repos.story.listIpRegistrations();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it("deletes an IP registration", () => {
      store.repos.story.insertIpRegistration({
        ipId: "0xip-del",
        nftTokenId: "99",
        licenseTermsId: "1",
        txHash: "0xtx-del",
        capabilityId: null,
        csdUrl: null,
        chain: "story-aeneid",
        registeredAt: new Date().toISOString(),
      });
      store.repos.story.deleteIpRegistration("0xip-del");
      expect(store.repos.story.findIpById("0xip-del")).toBeUndefined();
    });
  });

  // ── Derivative Links ────────────────────────────────────────────────────────

  describe("storyDerivativeLinks", () => {
    beforeEach(() => {
      // Insert parent IP registration first (FK dependency)
      store.repos.story.insertIpRegistration({
        ipId: "0xparent-ip",
        nftTokenId: "10",
        licenseTermsId: "1",
        txHash: "0xtxparent",
        capabilityId: null,
        csdUrl: null,
        chain: "story-aeneid",
        registeredAt: new Date().toISOString(),
      });
      store.repos.story.insertIpRegistration({
        ipId: "0xchild-ip",
        nftTokenId: "11",
        licenseTermsId: "1",
        txHash: "0xtxchild",
        capabilityId: null,
        csdUrl: null,
        chain: "story-aeneid",
        registeredAt: new Date().toISOString(),
      });
    });

    it("inserts and retrieves a derivative link", () => {
      const link = store.repos.story.insertDerivativeLink({
        id: "link-001",
        parentIpId: "0xparent-ip",
        childIpId: "0xchild-ip",
        licenseTokenId: "5",
        jobId: null,
        evidenceBundleHash: "sha256:" + "a".repeat(64),
        txHash: "0xtxlink",
        linkedAt: new Date().toISOString(),
      });
      expect(link).toBeDefined();
      expect(link!.parentIpId).toBe("0xparent-ip");
      expect(link!.childIpId).toBe("0xchild-ip");
    });

    it("finds all derivative links by parent IP", () => {
      store.repos.story.insertDerivativeLink({
        id: "link-002",
        parentIpId: "0xparent-ip",
        childIpId: "0xchild-ip",
        licenseTokenId: "6",
        jobId: null,
        evidenceBundleHash: null,
        txHash: "0xtxlink2",
        linkedAt: new Date().toISOString(),
      });
      const children = store.repos.story.findDerivativeLinksByParent("0xparent-ip");
      expect(children.length).toBeGreaterThanOrEqual(1);
      expect(children.every((l) => l.parentIpId === "0xparent-ip")).toBe(true);
    });

    it("returns empty array when no derivatives exist", () => {
      const links = store.repos.story.findDerivativeLinksByParent("0xnone");
      expect(links).toHaveLength(0);
    });
  });

  // ── Royalty Splits ──────────────────────────────────────────────────────────

  describe("storyRoyaltySplits", () => {
    beforeEach(() => {
      store.repos.story.insertIpRegistration({
        ipId: "0xip-royalty",
        nftTokenId: "20",
        licenseTermsId: "3",
        txHash: "0xtxroyalty",
        capabilityId: null,
        csdUrl: null,
        chain: "story-aeneid",
        registeredAt: new Date().toISOString(),
      });
    });

    it("inserts and retrieves royalty splits for an IP", () => {
      store.repos.story.insertRoyaltySplit({
        id: "split-001",
        ipId: "0xip-royalty",
        address: "0xdesigner",
        role: "designer",
        percentage: 10,
        label: "CSD Author",
      });
      store.repos.story.insertRoyaltySplit({
        id: "split-002",
        ipId: "0xip-royalty",
        address: "0xoperator",
        role: "operator",
        percentage: 70,
        label: "Machine Operator",
      });
      store.repos.story.insertRoyaltySplit({
        id: "split-003",
        ipId: "0xip-royalty",
        address: "0xverifier",
        role: "verifier",
        percentage: 10,
        label: "Evidence Verifier",
      });
      store.repos.story.insertRoyaltySplit({
        id: "split-004",
        ipId: "0xip-royalty",
        address: "0xtreasury",
        role: "curator",
        percentage: 10,
        label: "Network Treasury",
      });

      const splits = store.repos.story.findRoyaltySplitsByIp("0xip-royalty");
      expect(splits).toHaveLength(4);
      const total = splits.reduce((s, x) => s + x.percentage, 0);
      expect(total).toBe(100);
    });

    it("finds splits by wallet address", () => {
      store.repos.story.insertRoyaltySplit({
        id: "split-addr-1",
        ipId: "0xip-royalty",
        address: "0xmulti-operator",
        role: "operator",
        percentage: 80,
        label: "Operator",
      });
      const splits = store.repos.story.findRoyaltySplitsByAddress("0xmulti-operator");
      expect(splits.length).toBeGreaterThanOrEqual(1);
    });

    it("deletes splits for an IP", () => {
      store.repos.story.insertRoyaltySplit({
        id: "split-del-1",
        ipId: "0xip-royalty",
        address: "0xtemp",
        role: "operator",
        percentage: 100,
        label: "Temp",
      });
      store.repos.story.deleteRoyaltySplitsByIp("0xip-royalty");
      const splits = store.repos.story.findRoyaltySplitsByIp("0xip-royalty");
      expect(splits).toHaveLength(0);
    });
  });

  // ── Revenue Claims ──────────────────────────────────────────────────────────

  describe("storyRevenueClaims", () => {
    beforeEach(() => {
      store.repos.story.insertIpRegistration({
        ipId: "0xip-claims",
        nftTokenId: "30",
        licenseTermsId: "4",
        txHash: "0xtxclaims",
        capabilityId: null,
        csdUrl: null,
        chain: "story-aeneid",
        registeredAt: new Date().toISOString(),
      });
    });

    it("inserts and retrieves a revenue claim", () => {
      const claim = store.repos.story.insertRevenueClaim({
        id: "claim-001",
        ipId: "0xip-claims",
        claimerAddress: "0xclaimer1",
        amount: "100000000000000000",  // 0.1 WIP in wei
        txHash: "0xtxclaim1",
        claimedAt: new Date().toISOString(),
      });
      expect(claim).toBeDefined();
      expect(claim!.claimerAddress).toBe("0xclaimer1");
      expect(claim!.amount).toBe("100000000000000000");
    });

    it("finds claims by IP", () => {
      store.repos.story.insertRevenueClaim({
        id: "claim-002",
        ipId: "0xip-claims",
        claimerAddress: "0xclaimer2",
        amount: "50000000000000000",
        txHash: "0xtxclaim2",
        claimedAt: new Date().toISOString(),
      });
      const claims = store.repos.story.findRevenueClaimsByIp("0xip-claims");
      expect(claims.length).toBeGreaterThanOrEqual(1);
      expect(claims.every((c) => c.ipId === "0xip-claims")).toBe(true);
    });

    it("finds claims by claimer address", () => {
      store.repos.story.insertRevenueClaim({
        id: "claim-003",
        ipId: "0xip-claims",
        claimerAddress: "0xclaimer-known",
        amount: "75000000000000000",
        txHash: "0xtxclaim3",
        claimedAt: new Date().toISOString(),
      });
      const claims = store.repos.story.findRevenueClaimsByClaimer("0xclaimer-known");
      expect(claims.length).toBeGreaterThanOrEqual(1);
    });

    it("amount is stored as string (bigint-safe)", () => {
      const bigAmount = "999999999999999999999999";
      store.repos.story.insertRevenueClaim({
        id: "claim-big",
        ipId: "0xip-claims",
        claimerAddress: "0xbig",
        amount: bigAmount,
        txHash: "0xtxbig",
        claimedAt: new Date().toISOString(),
      });
      const claims = store.repos.story.findRevenueClaimsByClaimer("0xbig");
      expect(claims[0].amount).toBe(bigAmount);
    });
  });

  // ── StoryRepository exported from barrel ────────────────────────────────────

  describe("StoryRepository class export", () => {
    it("is exported from the package barrel", () => {
      expect(StoryRepository).toBeDefined();
      expect(typeof StoryRepository).toBe("function");
    });

    it("repos.story is a StoryRepository instance", () => {
      expect(store.repos.story).toBeInstanceOf(StoryRepository);
    });
  });
});
