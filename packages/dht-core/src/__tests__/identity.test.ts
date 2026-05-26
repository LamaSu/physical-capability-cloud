import { describe, expect, it } from "vitest";
import {
  canonicalIdentityJson,
  createPeerIdentity,
  endpointsEqual,
  peerIdFromDid,
  preferredEndpoint,
  sortedEndpoints,
} from "../identity.js";
import type { PeerEndpoint } from "../identity.js";

describe("identity", () => {
  describe("createPeerIdentity", () => {
    it("populates required + optional fields", () => {
      const id = createPeerIdentity({
        did: "did:pcc:agent:abc",
        publicKey: "deadbeef",
        endpoints: [{ transport: "websocket-direct", url: "wss://x", priority: 1 }],
        kernelId: "k1",
        agentId: "a1",
      });
      expect(id.did).toBe("did:pcc:agent:abc");
      expect(id.publicKey).toBe("deadbeef");
      expect(id.endpoints).toHaveLength(1);
      expect(id.kernelId).toBe("k1");
      expect(id.agentId).toBe("a1");
    });

    it("defaults endpoints to empty array", () => {
      const id = createPeerIdentity({
        did: "did:pcc:x",
        publicKey: "00",
      });
      expect(id.endpoints).toEqual([]);
    });
  });

  describe("peerIdFromDid", () => {
    it("extracts the last segment of a multi-part DID", () => {
      expect(peerIdFromDid("did:pcc:agent:abc123")).toBe("abc123");
    });

    it("returns the input when no colon present", () => {
      expect(peerIdFromDid("plainstring")).toBe("plainstring");
    });

    it("handles empty string", () => {
      expect(peerIdFromDid("")).toBe("");
    });
  });

  describe("endpointsEqual", () => {
    const e1: PeerEndpoint = { transport: "websocket-direct", url: "wss://a", priority: 1 };
    const e2: PeerEndpoint = { transport: "websocket-relay", url: "wss://b", priority: 2 };
    const e1bDifferentObj: PeerEndpoint = {
      transport: "websocket-direct",
      url: "wss://a",
      priority: 1,
    };

    it("returns true for empty arrays", () => {
      expect(endpointsEqual([], [])).toBe(true);
    });

    it("returns true regardless of order", () => {
      expect(endpointsEqual([e1, e2], [e2, e1bDifferentObj])).toBe(true);
    });

    it("returns false on length mismatch", () => {
      expect(endpointsEqual([e1], [e1, e2])).toBe(false);
    });

    it("returns false on field-level mismatch", () => {
      const e3: PeerEndpoint = { ...e1, url: "wss://c" };
      expect(endpointsEqual([e1], [e3])).toBe(false);
    });
  });

  describe("sortedEndpoints", () => {
    it("orders by priority asc then url", () => {
      const input: PeerEndpoint[] = [
        { transport: "websocket-direct", url: "wss://b", priority: 2 },
        { transport: "websocket-direct", url: "wss://a", priority: 1 },
        { transport: "websocket-direct", url: "wss://c", priority: 1 },
      ];
      const out = sortedEndpoints(input);
      expect(out.map((e) => e.url)).toEqual(["wss://a", "wss://c", "wss://b"]);
    });

    it("does not mutate input", () => {
      const input: PeerEndpoint[] = [
        { transport: "websocket-direct", url: "wss://b", priority: 2 },
        { transport: "websocket-direct", url: "wss://a", priority: 1 },
      ];
      const snap = JSON.stringify(input);
      sortedEndpoints(input);
      expect(JSON.stringify(input)).toBe(snap);
    });
  });

  describe("preferredEndpoint", () => {
    it("returns the lowest-priority endpoint for a transport", () => {
      const id = createPeerIdentity({
        did: "did:pcc:x",
        publicKey: "00",
        endpoints: [
          { transport: "websocket-direct", url: "wss://primary", priority: 1 },
          { transport: "websocket-direct", url: "wss://backup", priority: 5 },
          { transport: "websocket-relay", url: "wss://relay", priority: 1 },
        ],
      });
      expect(preferredEndpoint(id, "websocket-direct")?.url).toBe("wss://primary");
      expect(preferredEndpoint(id, "websocket-relay")?.url).toBe("wss://relay");
    });

    it("returns undefined if no endpoint of that transport exists", () => {
      const id = createPeerIdentity({
        did: "did:pcc:x",
        publicKey: "00",
        endpoints: [{ transport: "websocket-direct", url: "wss://a", priority: 1 }],
      });
      expect(preferredEndpoint(id, "webrtc")).toBeUndefined();
    });
  });

  describe("canonicalIdentityJson", () => {
    it("produces identical output regardless of input field order", () => {
      const a = createPeerIdentity({
        did: "did:pcc:x",
        publicKey: "00",
        endpoints: [
          { transport: "websocket-direct", url: "wss://b", priority: 2 },
          { transport: "websocket-direct", url: "wss://a", priority: 1 },
        ],
        kernelId: "k",
      });
      const b = createPeerIdentity({
        did: "did:pcc:x",
        publicKey: "00",
        endpoints: [
          { transport: "websocket-direct", url: "wss://a", priority: 1 },
          { transport: "websocket-direct", url: "wss://b", priority: 2 },
        ],
        kernelId: "k",
      });
      expect(canonicalIdentityJson(a)).toBe(canonicalIdentityJson(b));
    });

    it("includes nulls for omitted optional fields so the shape is stable", () => {
      const id = createPeerIdentity({ did: "did:pcc:x", publicKey: "00" });
      const json = canonicalIdentityJson(id);
      expect(json).toContain('"agentId":null');
      expect(json).toContain('"kernelId":null');
    });
  });
});
