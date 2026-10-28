/**
 * Each event is hashed at the version its source declares; other writers are
 * refused. Exercise the real operator evidence route using the shared spec's
 * event-hash writer vectors and inspect the persisted event and bundle rows.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { canonicalize, hashBundle, sha256, verifyEventHash, type EvidenceEvent } from "@pcc/spec";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { jobRoutes } from "../routes/jobs.js";
import { kernelRoutes } from "../routes/kernels.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { apiGate } from "../middleware/api-gate.js";

interface VectorEvent {
  id: string;
  type: string;
  timestamp: string;
  source: {
    deviceId: string;
    deviceType: string;
    kernelId: string;
    writer?: unknown;
  };
  payload: {
    jobId: string;
    [key: string]: unknown;
  };
  hash: string;
}

interface VectorCase {
  id: string;
  event: VectorEvent;
}

interface VectorSet {
  events: VectorCase[];
  invalidWriters: VectorCase[];
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const vectors = JSON.parse(
  readFileSync(
    join(REPO, "packages/spec/src/evidence/vectors/event-hash-writer.v2.json"),
    "utf8",
  ),
) as VectorSet;

function vector(id: string): VectorCase {
  const found = [...vectors.events, ...vectors.invalidWriters].find(
    (entry) => entry.id === id,
  );
  if (!found) throw new Error(`Missing event-hash vector: ${id}`);
  return found;
}

// Both identifiers come from the vectors, not from independently invented fixtures.
const JOB = vector("unmarked-v1").event.payload.jobId;
const KERNEL = vector("unmarked-v1").event.source.kernelId;

function withoutHash(event: VectorEvent): Omit<VectorEvent, "hash"> {
  const copy = structuredClone(event);
  Reflect.deleteProperty(copy, "hash");
  return copy;
}

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });

  // Authenticate as the recorded operator and provide the proven wallet required
  // for evidence submission. Use the same route setup as the existing relay tests.
  const operator = getRepos().kernels.findById("kernel-nyc")!.operatorAddress;
  const { rawKey } = provisionApiKey({
    operatorId: operator,
    name: "relay-event-hash-version-test",
    scopes: ["*"],
  });

  app.addHook("onRequest", async (req) => {
    req.headers.authorization ??= `Bearer ${rawKey}`;
    const proven = req.headers["x-test-proven-wallet"];
    if (typeof proven === "string") {
      (req as unknown as { provenWallet: string }).provenWallet = proven;
      req.provenWalletCarrier = "key";
    }
  });

  await app.register(apiGate);
  await app.register(kernelRoutes);
  await app.register(jobRoutes);
  await app.register(operatorRelayRoutes);
  await app.ready();

  return app;
}

const asDecidingOperator = () => ({
  "x-test-proven-wallet":
    getRepos().kernels.findById("kernel-nyc")!.operatorAddress,
});

const bundlesFor = (jobId: string) =>
  getRepos().evidence.findByJob(jobId).length;

describe("operator evidence relay: event hash version follows source writer", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();

    // The vectors commit to one job and one kernel. Give those exact identifiers
    // real repository rows, retaining the seeded operator's wallet authority.
    const seededKernel = getRepos().kernels.findById("kernel-nyc");
    expect(seededKernel).toBeDefined();

    getRepos().kernels.insert({
      ...seededKernel!,
      id: KERNEL,
    });

    const seededJob = getRepos().jobs.findAll()[0];
    expect(seededJob).toBeDefined();

    getRepos().jobs.insert({
      ...seededJob!,
      id: JOB,
      kernelId: KERNEL,
      evidenceBundleId: null,
    });

    expect(getRepos().kernels.findById(KERNEL)?.operatorAddress).toBe(
      seededKernel!.operatorAddress,
    );
    expect(getRepos().jobs.findById(JOB)?.kernelId).toBe(KERNEL);
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  async function postEvidence(evidence: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/operator/evidence",
      headers: asDecidingOperator(),
      payload: {
        jobId: JOB,
        kernelId: KERNEL,
        evidence,
      },
    });
  }

  function storedEventAt(bundleId: string, index: number) {
    const rows = getRepos().evidence.findEventsByBundle(bundleId);
    const row = rows.find((event) => event.id === `${bundleId}:${index}`);
    expect(row).toBeDefined();
    return row!;
  }

  async function expectRefused(
    evidence: Record<string, unknown>,
    refusal: { error: string; eventIndex?: number },
  ) {
    const before = bundlesFor(JOB);
    const response = await postEvidence(evidence);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      ...refusal,
      stored: false,
      jobId: JOB,
    });

    // A refused request must not leave a new evidence bundle behind.
    expect(bundlesFor(JOB)).toBe(before);
  }

  it("reads exactly five vectors sharing the same job and kernel", () => {
    expect(vectors.events.map((entry) => entry.id)).toEqual([
      "unmarked-v1",
      "kernel-written-v2",
      "old-kernel-forgery",
    ]);

    expect(vectors.invalidWriters.map((entry) => entry.id)).toEqual([
      "adapter-writer",
      "boolean-writer",
    ]);

    const allCases = [...vectors.events, ...vectors.invalidWriters];
    expect(allCases).toHaveLength(5);

    for (const entry of allCases) {
      expect(entry.event.payload.jobId).toBe(JOB);
      expect(entry.event.source.kernelId).toBe(KERNEL);
    }
  });

  it("unmarked-v1 is stored with the unchanged v1 canonical hash", async () => {
    const event = vector("unmarked-v1").event;

    expect(
      Object.prototype.hasOwnProperty.call(event.source, "writer"),
    ).toBe(false);

    const v1Hash = await sha256(
      canonicalize({
        type: event.type,
        timestamp: event.timestamp,
        source: event.source,
        payload: event.payload,
      }),
    );

    expect(event.hash).toBe(v1Hash);

    const response = await postEvidence({ events: [event] });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body).toMatchObject({
      stored: true,
      hashModel: "event_bundle_hash",
      eventsStored: 1,
    });

    const rows = getRepos().evidence.findEventsByBundle(body.bundleId);
    expect(rows).toHaveLength(1);

    const stored = storedEventAt(body.bundleId, 0);
    expect(stored.hash).toBe(event.hash);
    expect(stored.hash).toBe(v1Hash);
  });

  it("kernel-written-v2 is stored with its declared v2 hash", async () => {
    const event = vector("kernel-written-v2").event;

    expect(
      Object.prototype.hasOwnProperty.call(event.source, "writer"),
    ).toBe(true);
    expect(event.source.writer).toBe("kernel");

    const response = await postEvidence({ events: [event] });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body).toMatchObject({
      stored: true,
      hashModel: "event_bundle_hash",
      eventsStored: 1,
    });

    const rows = getRepos().evidence.findEventsByBundle(body.bundleId);
    expect(rows).toHaveLength(1);
    expect(storedEventAt(body.bundleId, 0).hash).toBe(event.hash);
  });

  it("old-kernel-forgery is refused when its supplied hash uses v1", async () => {
    await expectRefused(
      { events: [vector("old-kernel-forgery").event] },
      { error: "event_hash_mismatch", eventIndex: 0 },
    );
  });

  for (const entry of vectors.invalidWriters) {
    it(`${entry.id} is refused with and without a supplied hash`, async () => {
      await expectRefused(
        { events: [entry.event] },
        { error: "event_writer_invalid", eventIndex: 0 },
      );

      await expectRefused(
        { events: [withoutHash(entry.event)] },
        { error: "event_writer_invalid", eventIndex: 0 },
      );
    });
  }

  for (const writer of [null, false] as const) {
    it(`an own ${String(writer)} writer is refused with and without a supplied hash`, async () => {
      const event = structuredClone(vector("unmarked-v1").event);
      event.source.writer = writer;

      expect(
        Object.prototype.hasOwnProperty.call(event.source, "writer"),
      ).toBe(true);

      await expectRefused(
        { events: [event] },
        { error: "event_writer_invalid", eventIndex: 0 },
      );

      await expectRefused(
        { events: [withoutHash(event)] },
        { error: "event_writer_invalid", eventIndex: 0 },
      );
    });
  }

  it("kernel-written-v2 without a supplied hash gets its computed v2 hash", async () => {
    const event = vector("kernel-written-v2").event;
    const unhashed = withoutHash(event);

    expect(
      Object.prototype.hasOwnProperty.call(unhashed, "hash"),
    ).toBe(false);

    const response = await postEvidence({ events: [unhashed] });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body).toMatchObject({
      stored: true,
      hashModel: "event_bundle_hash",
      eventsStored: 1,
    });

    expect(storedEventAt(body.bundleId, 0).hash).toBe(event.hash);
  });

  it("a mixed unmarked-v1 and kernel-written-v2 bundle stores both selected hashes", async () => {
    const unmarked = vector("unmarked-v1").event;
    const marked = vector("kernel-written-v2").event;

    const response = await postEvidence({
      events: [withoutHash(unmarked), withoutHash(marked)],
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body).toMatchObject({
      stored: true,
      hashModel: "event_bundle_hash",
      eventsStored: 2,
    });

    const rows = getRepos().evidence.findEventsByBundle(body.bundleId);
    expect(rows).toHaveLength(2);

    expect(storedEventAt(body.bundleId, 0).hash).toBe(unmarked.hash);
    expect(storedEventAt(body.bundleId, 1).hash).toBe(marked.hash);

    const expectedBundleHash = await hashBundle(
      [unmarked, marked] as unknown as EvidenceEvent[],
    );

    expect(body.contentHash).toBe(expectedBundleHash);

    const storedBundle = getRepos().evidence.findById(body.bundleId);
    expect(storedBundle).toBeDefined();
    expect(storedBundle!.bundleHash).toBe(expectedBundleHash);
  });

  it("reports eventIndex 1 when the second event has an invalid writer", async () => {
    await expectRefused(
      {
        events: [
          vector("unmarked-v1").event,
          vector("adapter-writer").event,
        ],
      },
      { error: "event_writer_invalid", eventIndex: 1 },
    );
  });

  it("refuses a claimed bundle hash built from v1 hashes of marked events", async () => {
    const marked = vector("kernel-written-v2").event;
    const oldKernel = vector("old-kernel-forgery").event;

    const v1Claim = await hashBundle(
      [oldKernel] as unknown as EvidenceEvent[],
    );

    await expectRefused(
      {
        events: [withoutHash(marked)],
        bundleHash: v1Claim,
      },
      { error: "bundle_hash_mismatch" },
    );
  });

  it("stored rows keep the source as hashed and reproduce their stored hashes", async () => {
    const unmarked = vector("unmarked-v1").event;
    const marked = vector("kernel-written-v2").event;

    const response = await postEvidence({
      events: [withoutHash(unmarked), withoutHash(marked)],
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    const rows = getRepos().evidence.findEventsByBundle(body.bundleId);
    expect(rows).toHaveLength(2);

    for (const [index, event] of [unmarked, marked].entries()) {
      const stored = storedEventAt(body.bundleId, index);
      expect(stored.source).toEqual(event.source);
      expect(
        await verifyEventHash({
          id: stored.id,
          type: stored.type,
          timestamp: stored.timestamp,
          source: stored.source,
          payload: stored.payload,
          hash: stored.hash,
        } as unknown as EvidenceEvent),
      ).toBe(true);
    }

    expect(await hashBundle(rows as unknown as EvidenceEvent[])).toBe(
      getRepos().evidence.findById(body.bundleId)!.bundleHash,
    );
  });

  it("an inherited writer does not count: unmarked-v1 keeps its v1 hash", async () => {
    const event = vector("unmarked-v1").event;

    const response = await (async () => {
      Object.defineProperty(Object.prototype, "writer", {
        value: "kernel",
        configurable: true,
        writable: true,
        enumerable: false,
      });
      try {
        return await postEvidence({ events: [event] });
      } finally {
        Reflect.deleteProperty(Object.prototype, "writer");
      }
    })();

    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "writer")).toBe(false);
    expect(response.statusCode).toBe(200);
    expect(storedEventAt(response.json().bundleId, 0).hash).toBe(event.hash);
  });

  for (const writer of ["", 0, 1, {}, [], ["kernel"], "Kernel", "kernel "]) {
    it(`an own ${JSON.stringify(writer)} writer is refused with and without a supplied hash`, async () => {
      const event = structuredClone(vector("unmarked-v1").event);
      event.source.writer = structuredClone(writer);

      await expectRefused(
        { events: [event] },
        { error: "event_writer_invalid", eventIndex: 0 },
      );

      await expectRefused(
        { events: [withoutHash(event)] },
        { error: "event_writer_invalid", eventIndex: 0 },
      );
    });
  }

  it("the writer refusal comes before the job check", async () => {
    const event = withoutHash(vector("adapter-writer").event);
    event.payload.jobId = `${JOB}-other`;

    await expectRefused(
      { events: [event] },
      { error: "event_writer_invalid", eventIndex: 0 },
    );
  });
});
