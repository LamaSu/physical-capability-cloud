import { describe, expect, it, beforeEach } from "vitest";
import { PeerManager } from "../peer-manager.js";
import { createPeerIdentity } from "../identity.js";

describe("PeerManager", () => {
  let pm: PeerManager;

  beforeEach(() => {
    pm = new PeerManager();
  });

  describe("upsert", () => {
    it("adds a new peer and returns the KnownPeer record", () => {
      const id = createPeerIdentity({ did: "did:pcc:a", publicKey: "00" });
      const peer = pm.upsert(id);
      expect(peer.did).toBe("did:pcc:a");
      expect(peer.allowed).toBe(true); // default not allowlist mode
      expect(peer.errorCount).toBe(0);
      expect(pm.size()).toBe(1);
    });

    it("updates an existing peer rather than duplicating", () => {
      const id1 = createPeerIdentity({ did: "did:pcc:a", publicKey: "00" });
      const id2 = createPeerIdentity({ did: "did:pcc:a", publicKey: "11", kernelId: "k1" });
      pm.upsert(id1);
      const peer = pm.upsert(id2);
      expect(pm.size()).toBe(1);
      expect(peer.identity.publicKey).toBe("11");
      expect(peer.identity.kernelId).toBe("k1");
    });

    it("refreshes lastSeenMs on re-upsert", () => {
      const id = createPeerIdentity({ did: "did:pcc:a", publicKey: "00" });
      const first = pm.upsert(id);
      const t1 = first.lastSeenMs;
      // tiny delay
      const peer = pm.upsert(id);
      expect(peer.lastSeenMs).toBeGreaterThanOrEqual(t1);
    });
  });

  describe("allowlist mode", () => {
    beforeEach(() => {
      pm = new PeerManager({ allowlistMode: true });
    });

    it("denies new peers by default", () => {
      const id = createPeerIdentity({ did: "did:pcc:a", publicKey: "00" });
      pm.upsert(id);
      expect(pm.isAllowed("did:pcc:a")).toBe(false);
    });

    it("setAllowed flips the flag", () => {
      pm.upsert(createPeerIdentity({ did: "did:pcc:a", publicKey: "00" }));
      expect(pm.setAllowed("did:pcc:a", true)).toBe(true);
      expect(pm.isAllowed("did:pcc:a")).toBe(true);
    });

    it("setAllowed on an unknown peer returns false", () => {
      expect(pm.setAllowed("did:pcc:nobody", true)).toBe(false);
    });

    it("isAllowed returns false for an unknown peer", () => {
      expect(pm.isAllowed("did:pcc:nobody")).toBe(false);
    });

    it("listAllowed and allowedCount reflect the flag", () => {
      pm.upsert(createPeerIdentity({ did: "did:pcc:a", publicKey: "00" }));
      pm.upsert(createPeerIdentity({ did: "did:pcc:b", publicKey: "11" }));
      pm.setAllowed("did:pcc:a", true);
      expect(pm.allowedCount()).toBe(1);
      expect(pm.listAllowed()[0]?.did).toBe("did:pcc:a");
    });
  });

  describe("non-allowlist mode (default)", () => {
    it("returns true for an unknown peer", () => {
      expect(pm.isAllowed("did:pcc:nobody")).toBe(true);
    });
  });

  describe("recordRtt and recordError", () => {
    beforeEach(() => {
      pm.upsert(createPeerIdentity({ did: "did:pcc:a", publicKey: "00" }));
    });

    it("recordRtt stores the value and decays errorCount", () => {
      pm.recordError("did:pcc:a");
      pm.recordError("did:pcc:a");
      expect(pm.get("did:pcc:a")?.errorCount).toBe(2);
      pm.recordRtt("did:pcc:a", 42);
      expect(pm.get("did:pcc:a")?.rttMs).toBe(42);
      expect(pm.get("did:pcc:a")?.errorCount).toBe(1);
    });

    it("recordError on unknown peer is a no-op", () => {
      expect(() => pm.recordError("did:pcc:nobody")).not.toThrow();
    });

    it("recordRtt on unknown peer is a no-op", () => {
      expect(() => pm.recordRtt("did:pcc:nobody", 10)).not.toThrow();
    });
  });

  describe("remove and clear", () => {
    it("remove returns true when peer existed", () => {
      pm.upsert(createPeerIdentity({ did: "did:pcc:a", publicKey: "00" }));
      expect(pm.remove("did:pcc:a")).toBe(true);
      expect(pm.has("did:pcc:a")).toBe(false);
    });

    it("remove returns false for unknown peer", () => {
      expect(pm.remove("did:pcc:nobody")).toBe(false);
    });

    it("clear empties everything", () => {
      pm.upsert(createPeerIdentity({ did: "did:pcc:a", publicKey: "00" }));
      pm.upsert(createPeerIdentity({ did: "did:pcc:b", publicKey: "11" }));
      pm.clear();
      expect(pm.size()).toBe(0);
    });
  });
});
