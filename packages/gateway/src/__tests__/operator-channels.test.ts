/**
 * Tests for the operator-channels substrate (slots 3 + 4 of the four-slot
 * machine/human onboarding picture; complements PR #98 sla/author-integration).
 *
 * Coverage:
 *   Helpers
 *     - attachChannel happy path + validation (missing transport/label/describe)
 *     - getChannelsByOperator
 *     - parseAvailability / serializeAvailability round-trip + reject invalid mode
 *   HTTP routes
 *     - POST /api/operators/:slug/channels       — creates channel, returns 201
 *     - POST … with missing describe             — 400 invalid_body
 *     - GET  /api/operators/:slug/channels       — lists attached
 *     - PATCH /api/operators/channels/:id        — partial update
 *     - DELETE /api/operators/channels/:id       — removes
 *     - POST /api/operators/:slug/channels/test  — dispatches synthetic job
 *   A2A skill: pcc-attach-channel
 *     - single-channel shorthand                 — COMPLETED + 1 attached
 *     - batch via channels[]                     — COMPLETED + N attached
 *     - missing operatorSlug                     — FAILED
 *   A2A skill: pcc-author-integration extension
 *     - with channels[] + availability           — kernel + capability + channels
 *                                                  attached in one shot, slug derived
 *
 * Dispatch behaviour for non-webhook transports is implementation-stubbed
 * (logs only); covered by attaching + checking dispatchToChannels return shape,
 * not by hitting a real provider.
 */

import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  attachChannel,
  getChannelsByOperator,
  dispatchToChannels,
  parseAvailability,
  serializeAvailability,
  operatorChannelsRoutes,
  _clearOperatorChannelsForTests,
  type AvailabilityRecord,
} from "../routes/operator-channels.js";
import { a2aTasksRoutes, __resetA2ATasksForTest } from "../routes/a2a-tasks.js";
import { initStore, closeStore } from "../db.js";

// ── Helper tests (no Fastify needed) ─────────────────────────────────────────

describe("attachChannel + getChannelsByOperator", () => {
  beforeEach(() => _clearOperatorChannelsForTests());

  it("attaches a valid channel and returns it", () => {
    const ch = attachChannel("pizza-shop-alpha", {
      label: "Counter printer",
      transport: "webhook",
      describe: "POST JSON with order_id, items, total_usd to the local printer",
      endpoint: { url: "http://10.0.0.5:9100/print" },
    });
    expect(ch.id).toMatch(/^ch_/);
    expect(ch.operatorSlug).toBe("pizza-shop-alpha");
    expect(ch.transport).toBe("webhook");
    expect(ch.direction).toBe("out");
    expect(ch.enabled).toBe(true);
    expect(getChannelsByOperator("pizza-shop-alpha")).toHaveLength(1);
  });

  it("rejects channel without describe (too short)", () => {
    expect(() =>
      attachChannel("op-1", { label: "x", transport: "sms", describe: "hi" } as any),
    ).toThrow(/describe required/);
  });

  it("rejects missing transport", () => {
    expect(() =>
      attachChannel("op-1", { label: "x", describe: "long enough describe" } as any),
    ).toThrow(/transport required/);
  });

  it("rejects missing label", () => {
    expect(() =>
      attachChannel("op-1", { transport: "sms", describe: "long enough describe" } as any),
    ).toThrow(/label required/);
  });

  it("isolates channels per operator slug", () => {
    attachChannel("op-1", { label: "a", transport: "manual", describe: "dashboard only" });
    attachChannel("op-2", { label: "b", transport: "manual", describe: "dashboard only" });
    expect(getChannelsByOperator("op-1")).toHaveLength(1);
    expect(getChannelsByOperator("op-2")).toHaveLength(1);
    expect(getChannelsByOperator("op-3")).toHaveLength(0);
  });
});

// ── Availability parse/serialize tests ───────────────────────────────────────

describe("parseAvailability / serializeAvailability", () => {
  it("round-trips an always-mode record", () => {
    const rec: AvailabilityRecord = { mode: "always" };
    const parsed = parseAvailability(serializeAvailability(rec));
    expect(parsed).toEqual(rec);
  });

  it("round-trips a windows record with describe + timezone", () => {
    const rec: AvailabilityRecord = {
      mode: "windows",
      windows: [
        { start: "09:00", end: "17:00", daysOfWeek: [1, 2, 3, 4, 5] },
      ],
      timezone: "America/Los_Angeles",
      describe: "Open 9-5 Mon-Fri, closed weekends",
    };
    const parsed = parseAvailability(serializeAvailability(rec));
    expect(parsed).toEqual(rec);
  });

  it("returns null for an invalid mode", () => {
    expect(parseAvailability({ mode: "whenever" })).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parseAvailability(null)).toBeNull();
    expect(parseAvailability("string")).toBeNull();
    expect(parseAvailability(42)).toBeNull();
  });
});

// ── dispatchToChannels behaviour ─────────────────────────────────────────────

describe("dispatchToChannels", () => {
  beforeEach(() => _clearOperatorChannelsForTests());

  it("returns a no-channels marker when none attached", async () => {
    const res = await dispatchToChannels("op-empty", {
      jobId: "j_1",
      contextRef: "ctx",
      summary: "hi",
    });
    expect(res).toHaveLength(1);
    expect(res[0]!.ref).toBe("no-channels-attached");
  });

  it("succeeds via manual transport with no external call", async () => {
    attachChannel("op-manual", {
      label: "Dashboard only",
      transport: "manual",
      describe: "We just watch the operator dashboard",
    });
    const res = await dispatchToChannels("op-manual", {
      jobId: "j_2",
      contextRef: "ctx",
      summary: "test",
    });
    expect(res).toHaveLength(1);
    expect(res[0]!.delivered).toBe(true);
    expect(res[0]!.transport).toBe("manual");
  });

  it("skips disabled channels", async () => {
    const ch = attachChannel("op-toggle", {
      label: "Counter",
      transport: "manual",
      describe: "Off for the night",
      enabled: false,
    });
    expect(ch.enabled).toBe(false);
    const res = await dispatchToChannels("op-toggle", {
      jobId: "j_3",
      contextRef: "ctx",
      summary: "test",
    });
    // No enabled channels remain → falls through with no-channels marker
    expect(res).toEqual([]);
  });
});

// ── HTTP route tests ─────────────────────────────────────────────────────────

describe("operator-channels HTTP routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _clearOperatorChannelsForTests();
    app = Fastify({ logger: false });
    await app.register(operatorChannelsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    // no-op; per-test app teardown handled below
  });

  it("POST /api/operators/:slug/channels creates a channel with 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/operators/shop-alpha/channels",
      payload: {
        label: "Counter printer",
        transport: "webhook",
        describe: "POST JSON to the receipt printer; staff watches the dashboard too",
        endpoint: { url: "http://10.0.0.5/print" },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.channel.id).toMatch(/^ch_/);
    expect(body.channel.transport).toBe("webhook");
    expect(body.channel.operatorSlug).toBe("shop-alpha");
    await app.close();
  });

  it("POST without describe returns 400 invalid_body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/operators/shop-alpha/channels",
      payload: { label: "x", transport: "sms" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
    await app.close();
  });

  it("GET /api/operators/:slug/channels lists attached channels", async () => {
    attachChannel("shop-beta", {
      label: "Phone",
      transport: "sms",
      describe: "Text the owner E.164 on every new order",
      endpoint: { phoneE164: "+14155551234" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/operators/shop-beta/channels",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().channels).toHaveLength(1);
    await app.close();
  });

  it("PATCH /api/operators/channels/:id updates fields", async () => {
    const ch = attachChannel("shop-gamma", {
      label: "Old label",
      transport: "manual",
      describe: "Dashboard only for now",
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/operators/channels/${ch.id}`,
      payload: { label: "New label", enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().channel.label).toBe("New label");
    expect(res.json().channel.enabled).toBe(false);
    await app.close();
  });

  it("DELETE /api/operators/channels/:id removes the channel", async () => {
    const ch = attachChannel("shop-delta", {
      label: "Temp",
      transport: "manual",
      describe: "Dashboard only, temporary entry for the demo",
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/operators/channels/${ch.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
    expect(getChannelsByOperator("shop-delta")).toHaveLength(0);
    await app.close();
  });

  it("POST /api/operators/:slug/channels/test dispatches synthetic job", async () => {
    attachChannel("shop-epsilon", {
      label: "Dashboard",
      transport: "manual",
      describe: "Watching the operator screen during dinner rush",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/operators/shop-epsilon/channels/test",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results[0]!.delivered).toBe(true);
    await app.close();
  });
});

// ── A2A skill tests: pcc-attach-channel + pcc-author-integration extension ──

describe("A2A skills: pcc-attach-channel + author-integration extension", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    process.env.PCC_A2A_AUTH_DISABLED = "true";
    initStore({ seed: true });
    app = Fastify({ logger: false });
    await app.register(a2aTasksRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    delete process.env.PCC_A2A_AUTH_DISABLED;
  });

  beforeEach(() => {
    _clearOperatorChannelsForTests();
    __resetA2ATasksForTest();
  });

  it("pcc-attach-channel with single-channel shorthand attaches one channel", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          skill: "pcc-attach-channel",
          params: {
            operatorSlug: "pizza-place-alpha",
            label: "Counter receipt printer",
            transport: "webhook",
            describe: "POST to the printer's HTTP endpoint, plain text body",
            endpoint: { url: "http://10.0.0.42:9100" },
          },
        },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.state).toBe("COMPLETED");
    expect(body.result.artifacts[0].data.attached).toHaveLength(1);
    expect(body.result.artifacts[0].data.totalChannelsNow).toBe(1);
  });

  it("pcc-attach-channel batch attaches all entries", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/send",
        params: {
          skill: "pcc-attach-channel",
          params: {
            operatorSlug: "lab-beta",
            channels: [
              {
                label: "Owner phone",
                transport: "sms",
                describe: "SMS the owner for every new HPLC sample arrival",
                endpoint: { phoneE164: "+14155551234" },
              },
              {
                label: "MQTT broker",
                transport: "mqtt",
                describe: "Publish to topic /lab/incoming-jobs on the local broker",
                endpoint: { brokerUrl: "mqtt://10.0.0.1:1883", topic: "/lab/jobs" },
              },
            ],
          },
        },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.state).toBe("COMPLETED");
    expect(body.result.artifacts[0].data.attached).toHaveLength(2);
    expect(body.result.artifacts[0].data.totalChannelsNow).toBe(2);
  });

  it("pcc-attach-channel without operatorSlug returns RPC error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tasks/send",
        params: {
          skill: "pcc-attach-channel",
          params: { label: "x", transport: "manual", describe: "abcd" },
        },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error?.code).toBeDefined();
  });

  it("pcc-author-integration with channels[] + availability attaches both in one shot", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tasks/send",
        params: {
          skill: "pcc-author-integration",
          params: {
            lane: "human",
            name: "Tony's Pizza",
            type: "make-pizza",
            description: "Wood-fired Neapolitan",
            operatorSlug: "tonys-pizza",
            location: { lat: 37.7, lng: -122.4 },
            pricing: { currency: "USDC", baseCost: 12 },
            sla: { acceptanceWindowSec: 60, completionDeadlineSec: 1800 },
            availability: {
              mode: "windows",
              windows: [{ start: "11:00", end: "22:00", daysOfWeek: [1, 2, 3, 4, 5, 6, 0] }],
              timezone: "America/Los_Angeles",
              describe: "Open 11am-10pm daily, closed Christmas",
            },
            channels: [
              {
                label: "Receipt printer",
                transport: "webhook",
                describe: "POST plain text ticket to the local printer URL",
                endpoint: { url: "http://10.0.0.5/print" },
              },
              {
                label: "Owner phone",
                transport: "sms",
                describe: "Backup text to the owner if printer fails",
                endpoint: { phoneE164: "+14155551234" },
              },
            ],
          },
        },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.state).toBe("COMPLETED");
    const data = body.result.artifacts[0].data;
    expect(data.kernelId).toBeTruthy();
    expect(data.operatorSlug).toBe("tonys-pizza");
    expect(data.channelsAttached).toBe(2);
    expect(data.channels).toHaveLength(2);
    expect(data.availability?.mode).toBe("windows");
    expect(data.agentCardUrl).toContain("/agent-card.json");
    expect(getChannelsByOperator("tonys-pizza")).toHaveLength(2);
  });

  it("pcc-author-integration derives operatorSlug from name when not provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tasks/send",
        params: {
          skill: "pcc-author-integration",
          params: {
            lane: "machine",
            name: "My Opentrons OT-2",
            type: "liquid-handling",
            location: { lat: 0, lng: 0 },
          },
        },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.state).toBe("COMPLETED");
    expect(body.result.artifacts[0].data.operatorSlug).toBe("my-opentrons-ot-2");
  });
});
