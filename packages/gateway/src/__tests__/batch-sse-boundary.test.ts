import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { topicSSE } from "../sse/topic-sse.js";
import { streamHub } from "../sse/stream-hub.js";
import { BatchProducer } from "../sse/producers.js";
import { generateBatchEvent, resetBatchGenerator } from "../sse/mock-data-generator.js";
import { batchTracker, sensorPipeline } from "../services.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, initStore } from "../db.js";

// ───────────────────────────────────────────────────────────────────────────
// N49 round 5, F1 (CRITICAL): the shared batch SSE topic carried raw sensor
// readings. /sse/stream/batch/:batchId fans one payload out to every
// authenticated subscriber with no ownership check, and the batch projection
// was applied only inside the BatchTracker forwarder, so any other publisher
// (the sensor pipeline, the mock BatchProducer, a future producer) bypassed it.
// These tests drive a real HTTP SSE subscription against a listening server and
// assert on the bytes on the wire: the projection lives at the stream boundary.
// ───────────────────────────────────────────────────────────────────────────

const PREV_DB = process.env.PCC_DB_PATH;
const PREV_SSE_AUTH = process.env.SSE_AUTH_REQUIRED;
let app: FastifyInstance;
let port: number;
let bob: Record<string, string>; // an authenticated tenant who owns nothing in the victim batch

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.SSE_AUTH_REQUIRED = "true"; // a subscriber must be authenticated, as in production
  closeStore();
  initStore({ seed: false });
  bob = { authorization: `Bearer ${provisionApiKey({ operatorId: "bob@example.com" }).rawKey}` };
  app = Fastify({ logger: false });
  await app.register(topicSSE);
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
});

const clients: SseClient[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

afterAll(async () => {
  for (const c of clients.splice(0)) c.close();
  await app.close();
  closeStore();
  if (PREV_DB === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = PREV_DB;
  if (PREV_SSE_AUTH === undefined) delete process.env.SSE_AUTH_REQUIRED;
  else process.env.SSE_AUTH_REQUIRED = PREV_SSE_AUTH;
});

// ── a minimal SSE client ───────────────────────────────────────────────────

interface Frame {
  id?: string;
  event?: string;
  data?: string;
}

/** The complete frames in `text` (a trailing partial frame is not parsed). */
function parseFrames(text: string): Frame[] {
  const end = text.lastIndexOf("\n\n");
  if (end < 0) return [];
  const frames: Frame[] = [];
  for (const block of text.slice(0, end).split("\n\n")) {
    if (block.startsWith(":")) continue; // heartbeat comment
    const frame: Frame = {};
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) frame.id = line.slice(4);
      else if (line.startsWith("event: ")) frame.event = line.slice(7);
      else if (line.startsWith("data: ")) frame.data = line.slice(6);
    }
    frames.push(frame);
  }
  return frames;
}

class SseClient {
  /** Everything received on the wire, verbatim. */
  text = "";
  status = 0;
  private listeners = new Set<() => void>();

  constructor(private req: http.ClientRequest) {}

  attach(res: http.IncomingMessage): void {
    this.status = res.statusCode ?? 0;
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      this.text += chunk;
      for (const listener of [...this.listeners]) listener();
    });
  }

  frames(): Frame[] {
    return parseFrames(this.text);
  }

  /** Frames that carry an `event:` name (the stream's own `connected` hello has none). */
  events(): Frame[] {
    return this.frames().filter((f) => f.event !== undefined);
  }

  waitFor(predicate: (frames: Frame[]) => boolean, ms = 5000): Promise<Frame[]> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const frames = this.frames();
        if (!predicate(frames)) return;
        cleanup();
        resolve(frames);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting on the stream; received so far:\n${this.text}`));
      }, ms);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      this.listeners.add(check);
      check();
    });
  }

  close(): void {
    this.req.destroy();
  }
}

/** Opens an SSE stream and resolves once the response headers arrive. */
function subscribe(path: string, headers: Record<string, string> = bob): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      client.attach(res);
      resolve(client);
    });
    const client = new SseClient(req);
    clients.push(client);
    req.on("error", reject);
  });
}

/** Subscribes to a batch stream and waits for its hello frame. */
async function subscribeBatch(batchId: string, headers: Record<string, string> = bob): Promise<SseClient> {
  const client = await subscribe(`/sse/stream/batch/${batchId}`, headers);
  expect(client.status).toBe(200);
  await client.waitFor((frames) => frames.length >= 1);
  return client;
}

// ── fixtures ───────────────────────────────────────────────────────────────

const uid = () => crypto.randomUUID();
let seq = 0;

/** Publishes straight onto a batch topic, as any producer could. Returns the event id. */
function publishOnBatchTopic(batchId: string, type: string, payload: unknown, id = `evt-${++seq}-${uid()}`): string {
  streamHub.publish([{ type: "batch", id: batchId }], {
    id,
    type,
    timestamp: new Date().toISOString(),
    topic: { type: "batch", id: batchId },
    payload,
  });
  return id;
}

/**
 * Publishes a legitimate batch_sealed and waits for its frame. The stream writes
 * in publish order, so once this frame has arrived every event published before
 * it has already been through the stream: a safe point for a "was not sent" check.
 */
async function barrier(client: SseClient, batchId: string): Promise<void> {
  const id = publishOnBatchTopic(batchId, "batch_sealed", { slotCount: 1 });
  await client.waitFor((frames) => frames.some((f) => f.id === id));
}

/** A reading as Alice's instrument would report it for her sample in the victim batch. */
function aliceReading(batchId: string, secrets: { tag: string; sampleId: string; jobId: string }) {
  return {
    timestamp: new Date().toISOString(),
    kernelId: `kernel-${uid()}`,
    deviceId: `dev-${uid()}`,
    channel: "nozzle_temp",
    dataType: "scalar" as const,
    unit: "degC" as const,
    value: 217.34567,
    jobId: secrets.jobId,
    stepId: `step-${uid()}`,
    batchId,
    sampleId: secrets.sampleId,
    tags: { patient: secrets.tag },
  };
}

// ───────────────────────────────────────────────────────────────────────────

describe("N49 r5 F1: the shared batch stream is projected at the stream boundary", () => {
  it("is authenticated (a stream without credentials is refused), so the subscriber below is a real tenant", async () => {
    const anon = await subscribe("/sse/stream/batch/anything", {});
    expect(anon.status).toBe(401);
  });

  it("a sensor reading ingested with the victim's batchId never reaches another tenant's subscriber (CRITICAL)", async () => {
    const victim = `victim-${uid()}`;
    const secrets = { tag: `tag-${uid()}`, sampleId: `slot-${uid()}`, jobId: `job-${uid()}` };
    const sub = await subscribeBatch(victim); // bob, an authenticated tenant, on someone else's batch

    const reading = sensorPipeline.ingest(aliceReading(victim, secrets));
    await barrier(sub, victim);

    for (const secret of [secrets.tag, secrets.sampleId, secrets.jobId, "217.34567", reading.id]) {
      expect(sub.text, secret).not.toContain(secret);
    }
    expect(sub.events().map((f) => f.event)).toEqual(["batch_sealed"]); // only the barrier: no sensor_reading
  });

  it("a raw sensor_reading published straight onto the batch topic is dropped, whoever the publisher is", async () => {
    const batchId = `raw-${uid()}`;
    const secret = `tag-${uid()}`;
    const sub = await subscribeBatch(batchId);

    publishOnBatchTopic(batchId, "sensor_reading", { ...aliceReading(batchId, { tag: secret, sampleId: "s", jobId: "j" }), id: "reading-1" });
    await barrier(sub, batchId);

    expect(sub.text).not.toContain(secret);
    expect(sub.events().map((f) => f.event)).toEqual(["batch_sealed"]);
  });

  it("defense in depth: the sensor pipeline does not put a reading on the batch topic at all", () => {
    const batchId = `depth-${uid()}`;
    const reading = aliceReading(batchId, { tag: `tag-${uid()}`, sampleId: `slot-${uid()}`, jobId: `job-${uid()}` });

    sensorPipeline.ingest(reading);

    expect(streamHub.getBufferSize({ type: "batch", id: batchId })).toBe(0);
    // ...while the reading still reaches the topics that legitimate consumers use.
    expect(streamHub.getBufferSize({ type: "kernel", id: reading.kernelId })).toBe(1);
    expect(streamHub.getBufferSize({ type: "device", id: reading.deviceId })).toBe(1);
    expect(streamHub.getBufferSize({ type: "job", id: reading.jobId })).toBe(1);
  });

  it("a sensor reading still arrives on the kernel stream (the dashboard's source) after the batch topic was dropped", async () => {
    const reading = aliceReading(`b-${uid()}`, { tag: "t", sampleId: "s", jobId: `job-${uid()}` });
    const sub = await subscribe(`/sse/stream/kernel/${reading.kernelId}`);
    await sub.waitFor((frames) => frames.length >= 1);

    sensorPipeline.ingest(reading);

    const frames = await sub.waitFor((all) => all.some((f) => f.event === "sensor_reading"));
    expect(JSON.parse(frames.find((f) => f.event === "sensor_reading")!.data!)).toMatchObject({ channel: "nozzle_temp", value: 217.34567 });
  });

  it("the mock BatchProducer's raw per-sample events are dropped; only the aggregate batch events pass", async () => {
    resetBatchGenerator();
    const mockBatchId = generateBatchEvent().batchId; // the id the mock publishes under
    resetBatchGenerator();
    const sub = await subscribeBatch(mockBatchId);

    const producer = new BatchProducer(2);
    producer.start();
    try {
      await sub.waitFor((frames) => frames.some((f) => f.event === "batch_completed"), 15_000);
    } finally {
      producer.stop();
    }

    // 8 sample_added + 32 per-slot events + batch_started are gone: only the two
    // batch-level types remain, and each carries nothing beyond the listed aggregates.
    const events = sub.events();
    expect(events.map((f) => f.event)).toEqual(["batch_sealed", "batch_completed"]);
    const allowed = new Set(["batchId", "slotCount", "completed", "failed"]);
    for (const e of events) {
      const data = JSON.parse(e.data!);
      expect(data.batchId).toBe(mockBatchId);
      expect(Object.keys(data).filter((k) => !allowed.has(k))).toEqual([]);
    }
    for (const leak of ["slotId", "samp_slot_", "sampleLabel", "Sample-A1", "position", "slotIndex"]) {
      expect(sub.text, leak).not.toContain(leak);
    }
  });

  it("a batch_completed aggregate still arrives, with only its allowlisted fields", async () => {
    const batchId = `agg-${uid()}`;
    const secret = `hash-${uid()}`;
    const sub = await subscribeBatch(batchId);

    const sealedId = publishOnBatchTopic(batchId, "batch_sealed", { slotCount: 12, resultHash: secret, sampleLabel: secret });
    const doneId = publishOnBatchTopic(batchId, "batch_completed", { completed: 10, failed: 2, resultHash: secret, slotId: secret, tags: { secret } });
    await sub.waitFor((frames) => frames.some((f) => f.id === doneId));

    const byId = (id: string) => sub.frames().find((f) => f.id === id)!;
    expect(byId(sealedId)).toMatchObject({ event: "batch_sealed" });
    expect(JSON.parse(byId(sealedId).data!)).toEqual({ batchId, slotCount: 12 });
    expect(byId(doneId)).toMatchObject({ event: "batch_completed" });
    expect(JSON.parse(byId(doneId).data!)).toEqual({ batchId, completed: 10, failed: 2 });
    expect(sub.text).not.toContain(secret);
  });

  it("the real BatchTracker flow still shows a subscriber only the sealed and completed aggregates", async () => {
    const label = `patient-${uid()}`;
    const batch = batchTracker.createBatch("kernel-lab", "dev-1", "cap-1", { methodSecret: label });
    const sub = await subscribeBatch(batch.id);

    const slot = batchTracker.addSample(batch.id, {
      position: "A1", jobId: "job-a", stepId: "step-1", sampleLabel: label, userId: `0x${"ab".repeat(20)}`,
    });
    batchTracker.seal(batch.id);
    batchTracker.start(batch.id);
    batchTracker.updateSlotStatus(batch.id, slot.id, "acquiring");
    batchTracker.completeSlot(batch.id, slot.id, `sha256:${uid()}` as never, `results/${label}.json`);
    batchTracker.completeBatch(batch.id);
    await sub.waitFor((frames) => frames.some((f) => f.event === "batch_completed"));

    expect(sub.events().map((f) => f.event)).toEqual(["batch_sealed", "batch_completed"]);
    expect(JSON.parse(sub.events()[0].data!)).toEqual({ batchId: batch.id, slotCount: 1 });
    expect(JSON.parse(sub.events()[1].data!)).toEqual({ batchId: batch.id, completed: 1, failed: 0 });
    expect(sub.text).not.toContain(label);
    expect(sub.text).not.toContain(slot.id);
  });

  it("replayed events (Last-Event-ID) go through the same projection", async () => {
    const batchId = `replay-${uid()}`;
    const secret = `tag-${uid()}`;
    // Published BEFORE anyone subscribes: they sit in the hub's replay buffer.
    publishOnBatchTopic(batchId, "sensor_reading", { ...aliceReading(batchId, { tag: secret, sampleId: "s", jobId: "j" }), id: "reading-2" });
    publishOnBatchTopic(batchId, "sample_added", { slotId: secret, position: "A1", sampleLabel: secret });
    const doneId = publishOnBatchTopic(batchId, "batch_completed", { completed: 3, failed: 1, resultHash: secret });

    const sub = await subscribe(`/sse/stream/batch/${batchId}`, { ...bob, "last-event-id": "an-event-this-hub-never-saw" });
    await sub.waitFor((frames) => frames.some((f) => f.id === doneId));
    await barrier(sub, batchId);

    expect(sub.text).not.toContain(secret);
    expect(sub.events().map((f) => f.event)).toEqual(["batch_completed", "batch_sealed"]);
    expect(JSON.parse(sub.events()[0].data!)).toEqual({ batchId, completed: 3, failed: 1 });
  });

  it("fails closed: odd payloads and prototype-key event types leak nothing and do not break the stream", async () => {
    const batchId = `odd-${uid()}`;
    const secret = `secret-${uid()}`;
    const sub = await subscribeBatch(batchId);

    publishOnBatchTopic(batchId, "batch_sealed", secret); // a string payload
    publishOnBatchTopic(batchId, "batch_completed", [secret]); // an array payload
    publishOnBatchTopic(batchId, "constructor", { completed: 1, secret });
    publishOnBatchTopic(batchId, "__proto__", { completed: 1, secret });
    publishOnBatchTopic(batchId, "toString", { completed: 1, secret });
    await barrier(sub, batchId); // still alive after all of the above

    expect(sub.text).not.toContain(secret);
    // The two aggregate types with a malformed payload carry no aggregate fields, the rest are dropped.
    const events = sub.events();
    expect(events.map((f) => f.event)).toEqual(["batch_sealed", "batch_completed", "batch_sealed"]);
    expect(JSON.parse(events[0].data!)).toEqual({ batchId });
    expect(JSON.parse(events[1].data!)).toEqual({ batchId });
  });

  it("leaves the other topic streams alone: a job stream still delivers its event payload as published", async () => {
    const jobId = `job-${uid()}`;
    const sub = await subscribe(`/sse/stream/job/${jobId}`);
    await sub.waitFor((frames) => frames.length >= 1);

    const id = `evt-${++seq}`;
    streamHub.publish([{ type: "job", id: jobId }], {
      id, type: "job_progress", timestamp: new Date().toISOString(), topic: { type: "job", id: jobId },
      payload: { jobId, progress: 40, note: "plain job data" },
    });

    const frames = await sub.waitFor((all) => all.some((f) => f.id === id));
    expect(frames.find((f) => f.id === id)).toMatchObject({ event: "job_progress" });
    expect(JSON.parse(frames.find((f) => f.id === id)!.data!)).toEqual({ jobId, progress: 40, note: "plain job data" });
  });
});
