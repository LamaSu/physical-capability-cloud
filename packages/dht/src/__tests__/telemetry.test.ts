import { describe, it, expect, beforeEach, vi } from "vitest";
import { DHTTelemetry, dhtTelemetry } from "../telemetry.js";
import type { DHTMetricEvent } from "../telemetry.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Collect all metric events emitted during a callback */
function collectEvents(
  telemetry: DHTTelemetry,
  fn: () => void,
): DHTMetricEvent[] {
  const received: DHTMetricEvent[] = [];
  const listener = (event: DHTMetricEvent) => received.push(event);
  telemetry.onMetric(listener);
  fn();
  telemetry.offMetric(listener);
  return received;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("DHTTelemetry", () => {
  let tel: DHTTelemetry;

  beforeEach(() => {
    tel = new DHTTelemetry();
  });

  // ── peerConnected ─────────────────────────────────────────────────────────

  describe("peerConnected", () => {
    it("increments peersConnected and peersTotal", () => {
      tel.peerConnected("peer-1");
      const m = tel.getMetrics();
      expect(m.peersConnected).toBe(1);
      expect(m.peersTotal).toBe(1);
    });

    it("emits peer_connected event with peerId", () => {
      const events = collectEvents(tel, () => tel.peerConnected("peer-abc"));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("peer_connected");
      expect(events[0].data).toMatchObject({ peerId: "peer-abc" });
    });

    it("increments counters on each call", () => {
      tel.peerConnected("p1");
      tel.peerConnected("p2");
      tel.peerConnected("p3");
      const m = tel.getMetrics();
      expect(m.peersConnected).toBe(3);
      expect(m.peersTotal).toBe(3);
    });
  });

  // ── peerDisconnected ──────────────────────────────────────────────────────

  describe("peerDisconnected", () => {
    it("decrements peersConnected (floor at 0)", () => {
      tel.peerConnected("p1");
      tel.peerConnected("p2");
      tel.peerDisconnected("p1", "timeout");
      const m = tel.getMetrics();
      expect(m.peersConnected).toBe(1);
    });

    it("does not go below 0 for peersConnected", () => {
      tel.peerDisconnected("nobody", "gone");
      expect(tel.getMetrics().peersConnected).toBe(0);
    });

    it("emits peer_disconnected event with peerId and reason", () => {
      const events = collectEvents(tel, () =>
        tel.peerDisconnected("peer-x", "timeout"),
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("peer_disconnected");
      expect(events[0].data).toMatchObject({ peerId: "peer-x", reason: "timeout" });
    });
  });

  // ── queryStarted ──────────────────────────────────────────────────────────

  describe("queryStarted", () => {
    it("increments queriesTotal", () => {
      tel.queryStarted({ type: "fdm_print" });
      expect(tel.getMetrics().queriesTotal).toBe(1);
    });

    it("emits query_started event with filter", () => {
      const filter = { type: "laser_cut", materials: ["Aluminum"] };
      const events = collectEvents(tel, () => tel.queryStarted(filter));
      expect(events[0].type).toBe("query_started");
      expect(events[0].data).toMatchObject({ filter });
    });
  });

  // ── queryCompleted ────────────────────────────────────────────────────────

  describe("queryCompleted", () => {
    it("increments queriesSucceeded", () => {
      tel.queryCompleted(5, 120);
      expect(tel.getMetrics().queriesSucceeded).toBe(1);
    });

    it("emits query_completed with resultCount and durationMs", () => {
      const events = collectEvents(tel, () => tel.queryCompleted(3, 250));
      expect(events[0].type).toBe("query_completed");
      expect(events[0].data).toMatchObject({ resultCount: 3, durationMs: 250 });
    });
  });

  // ── queryTimeout ──────────────────────────────────────────────────────────

  describe("queryTimeout", () => {
    it("increments queriesFailed", () => {
      tel.queryTimeout({ type: "missing" });
      expect(tel.getMetrics().queriesFailed).toBe(1);
    });

    it("emits query_timeout with filter", () => {
      const filter = { type: "nope" };
      const events = collectEvents(tel, () => tel.queryTimeout(filter));
      expect(events[0].type).toBe("query_timeout");
      expect(events[0].data).toMatchObject({ filter });
    });
  });

  // ── announcementReceived ──────────────────────────────────────────────────

  describe("announcementReceived", () => {
    it("increments announcementsTotal and announcementsActive", () => {
      tel.announcementReceived("did:pcc:k1", ["fdm_print"]);
      const m = tel.getMetrics();
      expect(m.announcementsTotal).toBe(1);
      expect(m.announcementsActive).toBe(1);
    });

    it("emits announcement_received with kernelDid and capabilityTypes", () => {
      const events = collectEvents(tel, () =>
        tel.announcementReceived("did:pcc:k2", ["laser_cut", "cnc"]),
      );
      expect(events[0].type).toBe("announcement_received");
      expect(events[0].data).toMatchObject({
        kernelDid: "did:pcc:k2",
        capabilityTypes: ["laser_cut", "cnc"],
      });
    });
  });

  // ── announcementExpired ───────────────────────────────────────────────────

  describe("announcementExpired", () => {
    it("decrements announcementsActive (floor at 0)", () => {
      tel.announcementReceived("did:pcc:k1", ["fdm_print"]);
      tel.announcementExpired("did:pcc:k1");
      expect(tel.getMetrics().announcementsActive).toBe(0);
    });

    it("does not go below 0 for announcementsActive", () => {
      tel.announcementExpired("nobody");
      expect(tel.getMetrics().announcementsActive).toBe(0);
    });

    it("emits announcement_expired with kernelDid", () => {
      const events = collectEvents(tel, () =>
        tel.announcementExpired("did:pcc:k1"),
      );
      expect(events[0].type).toBe("announcement_expired");
      expect(events[0].data).toMatchObject({ kernelDid: "did:pcc:k1" });
    });
  });

  // ── gossipForwarded ───────────────────────────────────────────────────────

  describe("gossipForwarded", () => {
    it("increments gossipForwarded counter", () => {
      tel.gossipForwarded("msg-1", 3);
      expect(tel.getMetrics().gossipForwarded).toBe(1);
    });

    it("emits gossip_forwarded with messageId and ttl", () => {
      const events = collectEvents(tel, () => tel.gossipForwarded("msg-x", 5));
      expect(events[0].type).toBe("gossip_forwarded");
      expect(events[0].data).toMatchObject({ messageId: "msg-x", ttl: 5 });
    });
  });

  // ── gossipDropped ─────────────────────────────────────────────────────────

  describe("gossipDropped", () => {
    it("increments gossipDropped counter", () => {
      tel.gossipDropped("msg-2", "ttl_exhausted");
      expect(tel.getMetrics().gossipDropped).toBe(1);
    });

    it("emits gossip_dropped with messageId and reason", () => {
      const events = collectEvents(tel, () =>
        tel.gossipDropped("msg-y", "duplicate"),
      );
      expect(events[0].type).toBe("gossip_dropped");
      expect(events[0].data).toMatchObject({ messageId: "msg-y", reason: "duplicate" });
    });
  });

  // ── registryPruned ────────────────────────────────────────────────────────

  describe("registryPruned", () => {
    it("emits registry_pruned with count", () => {
      const events = collectEvents(tel, () => tel.registryPruned(7));
      expect(events[0].type).toBe("registry_pruned");
      expect(events[0].data).toMatchObject({ count: 7 });
    });

    it("does not change any metric counter", () => {
      const before = tel.getMetrics();
      tel.registryPruned(5);
      const after = tel.getMetrics();
      expect(after).toEqual(before);
    });
  });

  // ── nodeStarted / nodeStopped ─────────────────────────────────────────────

  describe("nodeStarted", () => {
    it("emits node_started event", () => {
      const events = collectEvents(tel, () => tel.nodeStarted());
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("node_started");
    });
  });

  describe("nodeStopped", () => {
    it("emits node_stopped event", () => {
      const events = collectEvents(tel, () => tel.nodeStopped());
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("node_stopped");
    });
  });

  // ── event structure ───────────────────────────────────────────────────────

  describe("event structure", () => {
    it("emitted events have type, timestamp, and data fields", () => {
      const events = collectEvents(tel, () => tel.peerConnected("p1"));
      const evt = events[0];
      expect(typeof evt.type).toBe("string");
      expect(typeof evt.timestamp).toBe("string");
      expect(typeof evt.data).toBe("object");
      // timestamp should be a valid ISO string
      expect(() => new Date(evt.timestamp)).not.toThrow();
      expect(new Date(evt.timestamp).toISOString()).toBe(evt.timestamp);
    });
  });

  // ── getMetrics snapshot ───────────────────────────────────────────────────

  describe("getMetrics()", () => {
    it("returns a snapshot, not a live reference", () => {
      const snap1 = tel.getMetrics();
      tel.peerConnected("p1");
      const snap2 = tel.getMetrics();
      // snap1 should not have been mutated
      expect(snap1.peersConnected).toBe(0);
      expect(snap2.peersConnected).toBe(1);
    });

    it("initial metrics are all zero", () => {
      const m = tel.getMetrics();
      expect(m.peersConnected).toBe(0);
      expect(m.peersTotal).toBe(0);
      expect(m.queriesTotal).toBe(0);
      expect(m.queriesSucceeded).toBe(0);
      expect(m.queriesFailed).toBe(0);
      expect(m.announcementsTotal).toBe(0);
      expect(m.announcementsActive).toBe(0);
      expect(m.gossipForwarded).toBe(0);
      expect(m.gossipDropped).toBe(0);
    });
  });

  // ── getRecentEvents ───────────────────────────────────────────────────────

  describe("getRecentEvents()", () => {
    it("returns events in insertion order", () => {
      tel.nodeStarted();
      tel.peerConnected("p1");
      tel.queryStarted({ type: "fdm" });
      const events = tel.getRecentEvents();
      expect(events[0].type).toBe("node_started");
      expect(events[1].type).toBe("peer_connected");
      expect(events[2].type).toBe("query_started");
    });

    it("returns a copy, not the internal array", () => {
      tel.nodeStarted();
      const snap1 = tel.getRecentEvents();
      tel.nodeStopped();
      const snap2 = tel.getRecentEvents();
      // snap1 should not have grown
      expect(snap1).toHaveLength(1);
      expect(snap2).toHaveLength(2);
    });
  });

  // ── rolling buffer cap at 200 ─────────────────────────────────────────────

  describe("rolling buffer cap", () => {
    it("caps recent events buffer at 200", () => {
      // Emit 220 events
      for (let i = 0; i < 220; i++) {
        tel.peerConnected(`peer-${i}`);
      }
      const events = tel.getRecentEvents();
      expect(events.length).toBe(200);
    });

    it("oldest events are dropped when buffer is full", () => {
      // Emit peer_connected for p0..p219
      for (let i = 0; i < 220; i++) {
        tel.peerConnected(`peer-${i}`);
      }
      const events = tel.getRecentEvents();
      // The first event in the buffer should be for peer-20 (p0..p19 dropped)
      expect(events[0].data).toMatchObject({ peerId: "peer-20" });
      // The last event should be for peer-219
      expect(events[199].data).toMatchObject({ peerId: "peer-219" });
    });

    it("buffer stays at exactly 200 after more events", () => {
      for (let i = 0; i < 250; i++) {
        tel.gossipForwarded(`msg-${i}`, 3);
      }
      expect(tel.getRecentEvents()).toHaveLength(200);
    });
  });

  // ── onMetric / offMetric ──────────────────────────────────────────────────

  describe("onMetric / offMetric", () => {
    it("onMetric subscribes to metric events", () => {
      const received: DHTMetricEvent[] = [];
      tel.onMetric((evt) => received.push(evt));
      tel.nodeStarted();
      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("node_started");
    });

    it("offMetric unsubscribes the listener", () => {
      const received: DHTMetricEvent[] = [];
      const listener = (evt: DHTMetricEvent) => received.push(evt);
      tel.onMetric(listener);
      tel.nodeStarted();
      tel.offMetric(listener);
      tel.nodeStopped();
      // Only the first event should have been received
      expect(received).toHaveLength(1);
    });
  });

  // ── singleton ─────────────────────────────────────────────────────────────

  describe("singleton dhtTelemetry", () => {
    it("is an instance of DHTTelemetry", () => {
      expect(dhtTelemetry).toBeInstanceOf(DHTTelemetry);
    });

    it("is the same reference on each import", async () => {
      const { dhtTelemetry: imported } = await import("../telemetry.js");
      expect(imported).toBe(dhtTelemetry);
    });
  });
});
