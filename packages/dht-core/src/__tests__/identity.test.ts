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

  describe("canonical endpoint order (review E1b, finding 3)", () => {
    const base = { did: "did:pcc:peer:abc", publicKey: "pk" };
    it("endpoints that tie on priority and URL sort by transport, so input order cannot change the preimage", () => {
      const direct: PeerEndpoint = { transport: "websocket-direct", url: "wss://same", priority: 1 };
      const relay: PeerEndpoint = { transport: "websocket-relay", url: "wss://same", priority: 1 };
      const a = canonicalIdentityJson(createPeerIdentity({ ...base, endpoints: [direct, relay] }));
      const b = canonicalIdentityJson(createPeerIdentity({ ...base, endpoints: [relay, direct] }));
      expect(b).toBe(a);
    });

    it("a non-finite priority is refused, never left to keep its input order (review E1c)", () => {
      const a = { transport: "websocket-direct", url: "wss://a", priority: NaN } as PeerEndpoint;
      const b = { transport: "websocket-relay", url: "wss://b", priority: NaN } as PeerEndpoint;
      for (const bad of [NaN, Infinity, -Infinity]) {
        const e = { transport: "websocket-direct", url: "wss://c", priority: bad } as PeerEndpoint;
        expect(() => sortedEndpoints([e]), String(bad)).toThrow(/priority/);
        expect(() => canonicalIdentityJson(createPeerIdentity({ ...base, endpoints: [e] })), String(bad)).toThrow(/priority/);
      }
      expect(() => canonicalIdentityJson(createPeerIdentity({ ...base, endpoints: [a, b] }))).toThrow(/priority/);
      expect(() => canonicalIdentityJson(createPeerIdentity({ ...base, endpoints: [b, a] }))).toThrow(/priority/);
    });

    it("lane-found: an endpoint's key order cannot change the preimage", () => {
      const e1 = { transport: "websocket-direct", url: "wss://a", priority: 1 } as PeerEndpoint;
      const e2 = { priority: 1, url: "wss://a", transport: "websocket-direct" } as PeerEndpoint;
      const a = canonicalIdentityJson(createPeerIdentity({ ...base, endpoints: [e1] }));
      const b = canonicalIdentityJson(createPeerIdentity({ ...base, endpoints: [e2] }));
      expect(b).toBe(a);
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

  // E1 finding 2: equal-priority endpoints enter the hashing/signing preimage,
  // so their order must not depend on host ICU collation.
  describe("equal-priority endpoints sort by UTF-16 code unit, never locale collation", () => {
    const codeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    /** A non-JS mirror of canonicalIdentityJson: priority, then url by code unit. */
    const mirror = (endpoints: PeerEndpoint[]) =>
      JSON.stringify({
        agentId: null,
        did: "did:pcc:x",
        endpoints: [...endpoints].sort((a, b) => a.priority - b.priority || codeUnits(a.url, b.url)),
        kernelId: null,
        publicKey: "00",
      });

    it("x_a vs x-a: the canonical JSON equals the code-unit mirror", () => {
      // "-" (0x2d) < "_" (0x5f) by code unit; ICU collation puts "_" first.
      const endpoints: PeerEndpoint[] = [
        { transport: "websocket-direct", url: "wss://relay.example/x_a", priority: 1 },
        { transport: "websocket-direct", url: "wss://relay.example/x-a", priority: 1 },
      ];
      expect(sortedEndpoints(endpoints).map((e) => e.url)).toEqual([
        "wss://relay.example/x-a",
        "wss://relay.example/x_a",
      ]);
      for (const order of [endpoints, [...endpoints].reverse()]) {
        const id = createPeerIdentity({ did: "did:pcc:x", publicKey: "00", endpoints: order });
        expect(canonicalIdentityJson(id)).toBe(mirror(endpoints));
      }
    });

    it("urls that ICU calls equal still get one order, whatever the input order", () => {
      const endpoints: PeerEndpoint[] = [
        { transport: "websocket-direct", url: "wss://h.example/\u00e9", priority: 1 },
        { transport: "websocket-direct", url: "wss://h.example/e\u0301", priority: 1 },
      ];
      const a = createPeerIdentity({ did: "did:pcc:x", publicKey: "00", endpoints });
      const b = createPeerIdentity({ did: "did:pcc:x", publicKey: "00", endpoints: [...endpoints].reverse() });
      expect(canonicalIdentityJson(a)).toBe(canonicalIdentityJson(b));
      expect(canonicalIdentityJson(a)).toBe(mirror(endpoints));
    });
  });
});
