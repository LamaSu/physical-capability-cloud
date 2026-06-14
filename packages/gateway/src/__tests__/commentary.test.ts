/**
 * Tests for the sports-commentator narration layer.
 *
 * Strategy:
 *   1. Pure-function tests for event classification + prompt assembly (no network).
 *   2. Session lifecycle: subscribes to streamHub, batches into windows, emits
 *      chunks, stops cleanly.
 *   3. Route registration: a minimal Fastify instance is wired with the
 *      commentary plugin and we hit /api/commentary/status (no auth needed
 *      for the standalone instance).
 *
 * The Anthropic SDK is never actually called — without ANTHROPIC_API_KEY the
 * narrator emits a `needs_api_key` chunk and continues to stream raw windows.
 * That is exactly the path we exercise here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import {
  classifyEvent,
  eventMatchesTopic,
  buildUserMessage,
  startCommentarySession,
  NARRATOR_SYSTEM_PROMPT,
  _resetAnthropicCache,
  type CommentaryChunk,
} from "../services/commentary-narrator.js";
import { streamHub, type StreamEvent } from "../sse/stream-hub.js";
import { commentaryRoutes } from "../routes/commentary.js";

// ── Fixtures ───────────────────────────────────────────────────────

function makeEvent(partial: Partial<StreamEvent> & { type: string }): StreamEvent {
  return {
    id: partial.id ?? `evt-${Math.random().toString(36).slice(2)}`,
    type: partial.type,
    timestamp: partial.timestamp ?? new Date().toISOString(),
    topic: partial.topic ?? { type: "global", id: "*" },
    payload: partial.payload ?? {},
  };
}

// ── classifyEvent ──────────────────────────────────────────────────

describe("classifyEvent", () => {
  it("classifies job-shaped events as 'jobs'", () => {
    expect(classifyEvent(makeEvent({ type: "job.started" }))).toBe("jobs");
    expect(classifyEvent(makeEvent({ type: "execution_completed" }))).toBe("jobs");
    expect(classifyEvent(makeEvent({ type: "protocol.step.advanced" }))).toBe("jobs");
    expect(classifyEvent(makeEvent({ type: "device.heartbeat" }))).toBe("jobs");
    expect(classifyEvent(makeEvent({ type: "sensor_reading" }))).toBe("jobs");
  });

  it("classifies escrow / settlement / payment events as 'escrows'", () => {
    expect(classifyEvent(makeEvent({ type: "escrow.funded" }))).toBe("escrows");
    expect(classifyEvent(makeEvent({ type: "settlement.released" }))).toBe("escrows");
    expect(classifyEvent(makeEvent({ type: "payment.received" }))).toBe("escrows");
    expect(classifyEvent(makeEvent({ type: "milestone.fund" }))).toBe("escrows");
  });

  it("classifies attestation / evidence / mint events as 'attestations'", () => {
    expect(classifyEvent(makeEvent({ type: "attestation.minted" }))).toBe("attestations");
    expect(classifyEvent(makeEvent({ type: "evidence.uploaded" }))).toBe("attestations");
    expect(classifyEvent(makeEvent({ type: "verifier.scored" }))).toBe("attestations");
    expect(classifyEvent(makeEvent({ type: "compliance.report" }))).toBe("attestations");
  });

  it("falls back to 'all' for unknown taxonomy", () => {
    expect(classifyEvent(makeEvent({ type: "weird.unknown.kind" }))).toBe("all");
    expect(classifyEvent(makeEvent({ type: "" }))).toBe("all");
  });
});

// ── eventMatchesTopic ───────────────────────────────────────────────

describe("eventMatchesTopic", () => {
  it("'all' matches everything", () => {
    expect(eventMatchesTopic(makeEvent({ type: "anything" }), "all")).toBe(true);
    expect(eventMatchesTopic(makeEvent({ type: "escrow.funded" }), "all")).toBe(true);
  });

  it("narrower topics filter correctly", () => {
    expect(eventMatchesTopic(makeEvent({ type: "job.created" }), "jobs")).toBe(true);
    expect(eventMatchesTopic(makeEvent({ type: "job.created" }), "escrows")).toBe(false);
    expect(eventMatchesTopic(makeEvent({ type: "escrow.released" }), "escrows")).toBe(true);
    expect(eventMatchesTopic(makeEvent({ type: "attestation.minted" }), "attestations")).toBe(true);
  });
});

// ── buildUserMessage ───────────────────────────────────────────────

describe("buildUserMessage", () => {
  it("renders an event list and prior-narration context", () => {
    const msg = buildUserMessage({
      windowId: "w1-abc",
      events: [
        makeEvent({ type: "job.started", payload: { jobId: "J-1", capability: "fdm" } }),
        makeEvent({ type: "escrow.funded", payload: { amountUsdc: "14.00" } }),
      ],
      priorNarration: ["Earlier we saw the kernel come online."],
    });
    expect(msg).toContain("WINDOW w1-abc");
    expect(msg).toContain("2 event(s)");
    expect(msg).toContain("job.started");
    expect(msg).toContain("escrow.funded");
    expect(msg).toContain("14.00");
    expect(msg).toContain("Earlier we saw the kernel come online.");
  });

  it("handles an empty window gracefully", () => {
    const msg = buildUserMessage({
      windowId: "w-empty",
      events: [],
      priorNarration: [],
    });
    expect(msg).toContain("0 event(s)");
    expect(msg).toContain("(no new events in this window)");
    expect(msg).toContain("(none yet — this is the start of the broadcast)");
  });

  it("caps oversized payloads so a noisy stream cannot blow context", () => {
    const huge = "x".repeat(5000);
    const msg = buildUserMessage({
      windowId: "w-huge",
      events: [makeEvent({ type: "sensor_reading", payload: { trace: huge } })],
      priorNarration: [],
    });
    // ASCII ellipsis marker used in the cap
    expect(msg).toContain("…");
    expect(msg.length).toBeLessThan(2000);
  });
});

// ── system prompt sanity ───────────────────────────────────────────

describe("NARRATOR_SYSTEM_PROMPT", () => {
  it("contains the broadcaster persona + ground rules", () => {
    expect(NARRATOR_SYSTEM_PROMPT).toContain("sports-broadcaster");
    expect(NARRATOR_SYSTEM_PROMPT).toContain("Physical Capability Cloud");
    expect(NARRATOR_SYSTEM_PROMPT).toContain("Self-Attested");
  });

  it("forbids brand hallucination", () => {
    // Must explicitly warn against inventing brands
    expect(NARRATOR_SYSTEM_PROMPT.toLowerCase()).toContain("never invent");
  });

  it("has no emoji (matches user-global anti-emoji rule)", () => {
    // Strip ASCII + the curly ellipsis (which is not an emoji) and check
    // that no non-text symbol characters survive
    const stripped = NARRATOR_SYSTEM_PROMPT.replace(/[\x00-\x7F…—–]/g, "");
    expect(stripped).toBe("");
  });
});

// ── Session lifecycle ──────────────────────────────────────────────

describe("startCommentarySession", () => {
  beforeEach(() => {
    _resetAnthropicCache();
    // Remove any key so the no-key path runs deterministically
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits ready + needs_api_key when ANTHROPIC_API_KEY is absent", async () => {
    const chunks: CommentaryChunk[] = [];
    const session = startCommentarySession(
      { windowMs: 500 },
      (c) => { chunks.push(c); },
    );

    // Give the async kickoff a chance to flush ready + needs_api_key
    await new Promise((r) => setTimeout(r, 50));
    session.stop();
    await session.done;

    const types = chunks.map((c) => c.type);
    expect(types).toContain("ready");
    expect(types).toContain("needs_api_key");
    const needsKey = chunks.find((c) => c.type === "needs_api_key");
    expect(needsKey?.message ?? "").toMatch(/ANTHROPIC_API_KEY/);
  });

  it("subscribes to streamHub and batches events into window chunks", async () => {
    const chunks: CommentaryChunk[] = [];
    const session = startCommentarySession(
      { windowMs: 300, topic: "all" },
      (c) => { chunks.push(c); },
    );

    // Let the session subscribe before publishing
    await new Promise((r) => setTimeout(r, 50));

    // Publish three events through the real streamHub
    streamHub.publish([{ type: "global", id: "*" }], {
      id: "e1", type: "job.started",
      timestamp: new Date().toISOString(),
      topic: { type: "global", id: "*" },
      payload: { jobId: "J-1" },
    });
    streamHub.publish([{ type: "global", id: "*" }], {
      id: "e2", type: "escrow.funded",
      timestamp: new Date().toISOString(),
      topic: { type: "global", id: "*" },
      payload: { amountUsdc: "14.00" },
    });
    streamHub.publish([{ type: "global", id: "*" }], {
      id: "e3", type: "attestation.minted",
      timestamp: new Date().toISOString(),
      topic: { type: "global", id: "*" },
      payload: { verifier: "v1" },
    });

    // Wait for at least one window flush
    await new Promise((r) => setTimeout(r, 500));
    session.stop();
    await session.done;

    const windowChunks = chunks.filter((c) => c.type === "window");
    expect(windowChunks.length).toBeGreaterThanOrEqual(1);

    const totalEvents = windowChunks.reduce(
      (sum, c) => sum + (c.raw_events?.length ?? 0),
      0,
    );
    expect(totalEvents).toBeGreaterThanOrEqual(3);

    const seenTypes = new Set<string>();
    for (const w of windowChunks) {
      for (const e of w.raw_events ?? []) seenTypes.add(e.type);
    }
    expect(seenTypes.has("job.started")).toBe(true);
    expect(seenTypes.has("escrow.funded")).toBe(true);
    expect(seenTypes.has("attestation.minted")).toBe(true);
  });

  it("respects the topic filter and drops non-matching events", async () => {
    const chunks: CommentaryChunk[] = [];
    const session = startCommentarySession(
      { windowMs: 300, topic: "escrows" },
      (c) => { chunks.push(c); },
    );

    await new Promise((r) => setTimeout(r, 50));

    streamHub.publish([{ type: "global", id: "*" }], {
      id: "f1", type: "job.started",
      timestamp: new Date().toISOString(),
      topic: { type: "global", id: "*" },
      payload: {},
    });
    streamHub.publish([{ type: "global", id: "*" }], {
      id: "f2", type: "escrow.funded",
      timestamp: new Date().toISOString(),
      topic: { type: "global", id: "*" },
      payload: { amountUsdc: "5.00" },
    });

    await new Promise((r) => setTimeout(r, 500));
    session.stop();
    await session.done;

    const allRawEvents = chunks
      .filter((c) => c.type === "window")
      .flatMap((c) => c.raw_events ?? []);

    // Only the escrow event should have passed through
    expect(allRawEvents.length).toBeGreaterThanOrEqual(1);
    for (const e of allRawEvents) {
      expect(eventMatchesTopic(e, "escrows")).toBe(true);
    }
  });

  it("stop() releases the subscription cleanly", async () => {
    const chunks: CommentaryChunk[] = [];
    const before = streamHub.getSubscriberCount({ type: "global", id: "*" });
    const session = startCommentarySession(
      { windowMs: 300 },
      (c) => { chunks.push(c); },
    );
    await new Promise((r) => setTimeout(r, 50));
    const during = streamHub.getSubscriberCount({ type: "global", id: "*" });
    expect(during).toBeGreaterThan(before);

    session.stop();
    await session.done;
    const after = streamHub.getSubscriberCount({ type: "global", id: "*" });
    expect(after).toBe(before);
  });
});

// ── Route integration ──────────────────────────────────────────────

describe("commentary routes", () => {
  it("exposes /api/commentary/status with config snapshot", async () => {
    const app = Fastify({ logger: false });
    await app.register(commentaryRoutes);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/commentary/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.route).toBe("/api/commentary/stream");
    expect(typeof body.anthropic_configured).toBe("boolean");
    expect(body.supported_topics).toEqual(["jobs", "escrows", "attestations", "all"]);

    await app.close();
  });

  it("registers POST + GET on /api/commentary/stream", async () => {
    const app = Fastify({ logger: false });
    await app.register(commentaryRoutes);
    await app.ready();

    // We can't easily inject an SSE stream (it never ends), but we can confirm
    // the routes exist by checking the printed routes table. Fastify's radix
    // tree renderer splits a shared path prefix across lines, so we assert on
    // the suffixes + the method tags that always appear together.
    const routes = app.printRoutes();
    expect(routes).toContain("api/commentary/st");
    expect(routes).toMatch(/ream\s*\((?=[^)]*POST)[^)]*GET[^)]*\)/);
    expect(routes).toMatch(/atus\s*\(GET[^)]*\)/);

    await app.close();
  });
});
