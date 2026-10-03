import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { topicSSE } from "../sse/topic-sse.js";
import { StreamHub, streamHub } from "../sse/stream-hub.js";
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

let marker = 1_000_000;

/** True when `frames` holds the batch_sealed frame whose slotCount is `slotCount`. */
function hasSealed(frames: Frame[], slotCount: number): boolean {
  return frames.some((f) => f.event === "batch_sealed" && f.data !== undefined && JSON.parse(f.data).slotCount === slotCount);
}

/**
 * Publishes a legitimate batch_sealed and waits for its frame. The stream writes
 * in publish order, so once this frame has arrived every event published before
 * it has already been through the stream: a safe point for a "was not sent" check.
 * It finds its frame by a unique slotCount, not by the frame id: since round 6 the
 * batch stream's ids are its own cursors, never the publisher's ids.
 */
async function barrier(client: SseClient, batchId: string): Promise<void> {
  const slotCount = ++marker;
  publishOnBatchTopic(batchId, "batch_sealed", { slotCount });
  await client.waitFor((frames) => hasSealed(frames, slotCount));
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

    publishOnBatchTopic(batchId, "batch_sealed", { slotCount: 12, resultHash: secret, sampleLabel: secret });
    publishOnBatchTopic(batchId, "batch_completed", { completed: 10, failed: 2, resultHash: secret, slotId: secret, tags: { secret } });
    await sub.waitFor((frames) => frames.some((f) => f.event === "batch_completed"));

    const [sealed, done] = sub.events(); // in publish order
    expect(sealed).toMatchObject({ event: "batch_sealed" });
    expect(JSON.parse(sealed.data!)).toEqual({ batchId, slotCount: 12 });
    expect(done).toMatchObject({ event: "batch_completed" });
    expect(JSON.parse(done.data!)).toEqual({ batchId, completed: 10, failed: 2 });
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
    publishOnBatchTopic(batchId, "batch_completed", { completed: 3, failed: 1, resultHash: secret });

    // "0" is the stream's cursor before its first event, so everything buffered is replayed.
    const sub = await subscribe(`/sse/stream/batch/${batchId}`, { ...bob, "last-event-id": "0" });
    await sub.waitFor((frames) => frames.some((f) => f.event === "batch_completed"));
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

// ───────────────────────────────────────────────────────────────────────────
// N49 round 6 (CRITICAL): the SSE envelope bypassed the projection. setupSSE
// wrote the publisher's raw event.id into each frame, so an allowlisted
// batch_sealed or batch_completed could carry a sample id, a job id or a result
// hash in its id, and an id holding CR/LF could inject whole frames. Replay
// matched Last-Event-ID against those same publisher ids. Now the batch
// stream's frame id is its own per-topic cursor, assigned by the hub at
// publish, and every stream guards its id and event lines.
// ───────────────────────────────────────────────────────────────────────────

/** Publishes a uniquely marked batch_sealed and waits until every client has it. */
async function barrierAll(subs: SseClient[], batchId: string): Promise<void> {
  const slotCount = ++marker;
  publishOnBatchTopic(batchId, "batch_sealed", { slotCount });
  for (const sub of subs) await sub.waitFor((frames) => hasSealed(frames, slotCount));
}

describe("N49 r6: the batch stream's SSE envelope carries nothing from the publisher", () => {
  it("an allowlisted batch event's publisher id never reaches the wire; the frame id is the stream's own cursor", async () => {
    const batchId = `env-${uid()}`;
    const secret = `secret-sample-${uid()}`;
    const sub = await subscribeBatch(batchId);

    publishOnBatchTopic(batchId, "batch_sealed", { slotCount: 1 }, secret);
    await sub.waitFor((frames) => frames.some((f) => f.event === "batch_sealed"));

    expect(sub.text).not.toContain(secret);
    expect(sub.events().map((f) => f.id)).toEqual(["1"]); // the first event on this topic
  });

  it("an id carrying CR/LF cannot inject a frame or an event", async () => {
    const batchId = `inject-${uid()}`;
    const secret = `secret-${uid()}`;
    const sub = await subscribeBatch(batchId);

    publishOnBatchTopic(batchId, "batch_sealed", { slotCount: 2 }, `x\nevent: sensor_reading\ndata: ${secret}\n\nid: y`);
    publishOnBatchTopic(batchId, "batch_completed", { completed: 1, failed: 0 }, `x\r\ndata: ${secret}`);
    await barrier(sub, batchId);

    expect(sub.text).not.toContain(secret);
    expect(sub.text).not.toContain("sensor_reading");
    expect(sub.events().map((f) => [f.event, f.id])).toEqual([
      ["batch_sealed", "1"],
      ["batch_completed", "2"],
      ["batch_sealed", "3"],
    ]);
  });

  it("Last-Event-ID resumes from the stream's own cursor: exactly the later events, each with its cursor id", async () => {
    const batchId = `resume-${uid()}`;
    const secret = `secret-${uid()}`;
    const first = await subscribeBatch(batchId);
    publishOnBatchTopic(batchId, "batch_sealed", { slotCount: 4 }, `${secret}-a`);
    await first.waitFor((frames) => frames.some((f) => f.event === "batch_sealed"));
    const seen = first.events()[0];
    first.close();

    publishOnBatchTopic(batchId, "batch_completed", { completed: 3, failed: 1 }, `${secret}-b`);
    publishOnBatchTopic(batchId, "batch_completed", { completed: 4, failed: 0 }, `${secret}-c`);

    const again = await subscribe(`/sse/stream/batch/${batchId}`, { ...bob, "last-event-id": seen.id ?? "" });
    await again.waitFor((frames) => frames.filter((f) => f.event === "batch_completed").length >= 2);
    await barrier(again, batchId);

    expect(seen.id).toBe("1");
    expect(again.events().map((f) => [f.event, f.id])).toEqual([
      ["batch_completed", "2"],
      ["batch_completed", "3"],
      ["batch_sealed", "4"],
    ]);
    expect(first.text + again.text).not.toContain(secret);
  });

  it("a Last-Event-ID that is not this stream's cursor replays nothing, so it is no oracle and leaks nothing", async () => {
    const batchId = `oracle-${uid()}`;
    const secret = `secret-${uid()}`;
    publishOnBatchTopic(batchId, "batch_sealed", { slotCount: 5 }, secret); // buffered before anyone subscribes

    const known = await subscribe(`/sse/stream/batch/${batchId}`, { ...bob, "last-event-id": secret });
    const unknown = await subscribe(`/sse/stream/batch/${batchId}`, { ...bob, "last-event-id": `never-${uid()}` });
    await barrierAll([known, unknown], batchId);

    for (const sub of [known, unknown]) {
      expect(sub.text).not.toContain(secret);
      expect(sub.events()).toHaveLength(1); // only the live barrier: nothing was replayed
    }
  });

  it("each batch topic counts its own cursor", async () => {
    const a = `count-a-${uid()}`;
    const b = `count-b-${uid()}`;
    const subA = await subscribeBatch(a);
    const subB = await subscribeBatch(b);

    publishOnBatchTopic(a, "batch_sealed", { slotCount: 1 });
    publishOnBatchTopic(a, "batch_completed", { completed: 1, failed: 0 });
    publishOnBatchTopic(b, "batch_sealed", { slotCount: 1 });
    await subA.waitFor((frames) => frames.filter((f) => f.event !== undefined).length >= 2);
    await subB.waitFor((frames) => frames.filter((f) => f.event !== undefined).length >= 1);

    expect(subA.events().map((f) => f.id)).toEqual(["1", "2"]);
    expect(subB.events().map((f) => f.id)).toEqual(["1"]);
  });

  it("every stream guards its frame: a kernel event whose id carries CR/LF arrives without an id line and injects nothing", async () => {
    const kernelId = `kernel-${uid()}`;
    const secret = `secret-${uid()}`;
    const sub = await subscribe(`/sse/stream/kernel/${kernelId}`);
    await sub.waitFor((frames) => frames.length >= 1);

    streamHub.publish([{ type: "kernel", id: kernelId }], {
      id: `k\nevent: injected\ndata: ${secret}`, type: "kernel_status", timestamp: new Date().toISOString(),
      topic: { type: "kernel", id: kernelId }, payload: { status: "online" },
    });
    const frames = await sub.waitFor((all) => all.some((f) => f.event === "kernel_status"));

    expect(sub.text).not.toContain("injected");
    expect(sub.text).not.toContain(secret);
    const frame = frames.find((f) => f.event === "kernel_status")!;
    expect(frame.id).toBeUndefined();
    expect(JSON.parse(frame.data!)).toEqual({ status: "online" });
  });

  it("every stream drops an event whose type could break the frame", async () => {
    const kernelId = `kernel-${uid()}`;
    const secret = `secret-${uid()}`;
    const sub = await subscribe(`/sse/stream/kernel/${kernelId}`);
    await sub.waitFor((frames) => frames.length >= 1);
    const publish = (id: string, type: string, payload: unknown) =>
      streamHub.publish([{ type: "kernel", id: kernelId }], { id, type, timestamp: new Date().toISOString(), topic: { type: "kernel", id: kernelId }, payload });

    publish("t1", `kernel_status\ndata: ${secret}`, { status: "x" });
    publish("t2", "kernel_status\r", { status: "y" });
    publish("t3", "kernel_status", { status: "online" }); // well formed: the barrier
    await sub.waitFor((all) => all.some((f) => f.id === "t3"));

    expect(sub.text).not.toContain(secret);
    expect(sub.events().map((f) => f.id)).toEqual(["t3"]);
  });

  it("a job stream keeps the publisher's id when it is a safe one (only the batch stream switched to cursors)", async () => {
    const jobId = `job-${uid()}`;
    const sub = await subscribe(`/sse/stream/job/${jobId}`);
    await sub.waitFor((frames) => frames.length >= 1);

    streamHub.publish([{ type: "job", id: jobId }], {
      id: "evt-safe-1", type: "job_progress", timestamp: new Date().toISOString(),
      topic: { type: "job", id: jobId }, payload: { progress: 10 },
    });
    const frames = await sub.waitFor((all) => all.some((f) => f.event === "job_progress"));
    expect(frames.find((f) => f.event === "job_progress")!.id).toBe("evt-safe-1");
  });
});

describe("StreamHub cursors (N49 r6)", () => {
  it("gives each topic its own monotonic cursor and, in cursor mode, replays only after a cursor; legacy mode is unchanged", () => {
    const hub = new StreamHub(10);
    const topic = { type: "batch" as const, id: "b1" };
    const event = (id: string) => ({ id, type: "batch_sealed", timestamp: "t", topic, payload: {} });
    hub.publish([topic], event("p1"));
    hub.publish([topic], event("p2"));
    hub.publish([topic], event("p3"));

    const resumed: Array<[string, number | undefined]> = [];
    hub.subscribe([topic], (e, cursor) => resumed.push([e.id, cursor?.seq]), "1", { cursor: "seq" });
    expect(resumed).toEqual([["p2", 2], ["p3", 3]]);

    const notACursor: string[] = [];
    hub.subscribe([topic], (e) => notACursor.push(e.id), "p1", { cursor: "seq" });
    expect(notACursor).toEqual([]);

    const legacy: string[] = [];
    hub.subscribe([topic], (e) => legacy.push(e.id), "p1");
    expect(legacy).toEqual(["p2", "p3"]);

    const live: Array<[string, number | undefined]> = [];
    hub.subscribe([topic], (e, cursor) => live.push([e.id, cursor?.seq]));
    hub.publish([topic], event("p4"));
    expect(live).toEqual([["p4", 4]]);
  });
});
