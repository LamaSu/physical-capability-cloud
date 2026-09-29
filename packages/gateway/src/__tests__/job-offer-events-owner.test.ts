/**
 * Job-offer events belong to the offer's parties (AG-25 inspection; astra, pack 54:
 * "job-offers.ts owner checks must be inspected"). Reproduced at 4e2c17b5 before
 * any code changed.
 *
 * POST /api/job-offers/:id/events let ANY authenticated key record an event on ANY
 * offer, and the event's author ("by") came from the request BODY. Events drive
 * status: "cancelled" cancelled the offer, bypassing the owner-only
 * DELETE /api/job-offers/:id (4ce61211), and "delivered" marked it delivered.
 *
 * Now the caller must be the offer's poster or the owner of the kernel that
 * claimed it; anyone else gets 403. "cancelled" is the poster's (as DELETE);
 * "delivered", "in_progress" and "pickup" are the claimant's. "by" is the
 * authenticated caller, never the body.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.PCC_SEED_DATA = "false";

const A = "offer-poster-a@x.test";
const B = "stranger-b@x.test";
const C = "claimant-c@x.test";

let app: FastifyInstance;
let getRepos: typeof import("../db.js").getRepos;
let generateApiKey: typeof import("../auth/api-key-auth.js").generateApiKey;
let seq = 0;
let ipSeq = 10;

function seedKey(operatorId: string): string {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: `offer-events-key-${++seq}`,
    keyHash,
    keyPrefix,
    operatorId,
    scopes: JSON.stringify(["operator"]),
    rateLimit: "1000/hour",
    usageCount: "0",
    createdAt: new Date().toISOString(),
  } as never);
  return rawKey;
}

const inj = (method: string, url: string, raw: string, payload?: unknown) =>
  app.inject({
    method: method as never,
    url,
    remoteAddress: `10.105.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    payload: payload as never,
    headers: { authorization: `Bearer ${raw}` },
  });

let keyA: string;
let keyB: string;
let keyC: string;
const kernelC = `kernel-offer-claimant-${Date.now().toString(36)}`;

async function newOffer(claimed: boolean): Promise<string> {
  const id = `offer-ev-${Date.now().toString(36)}-${++seq}`;
  const res = await inj("POST", "/api/job-offers", keyA, {
    id,
    capabilityType: "courier.dispatch",
    requirements: { pickup: { name: "Store", lat: 37.77, lng: -122.42 }, dropoff: { name: "Tower", lat: 37.78, lng: -122.4 } },
    pricing: { amount: 6.7, currency: "USD", model: "fixed" },
  });
  expect(res.statusCode, res.body).toBe(201);
  if (claimed) {
    const c = await inj("POST", `/api/job-offers/${id}/claim`, keyC, { kernelId: kernelC });
    expect(c.statusCode, c.body).toBeLessThan(300);
  }
  return id;
}
const statusOf = async (id: string) => ((await inj("GET", `/api/job-offers/${id}`, keyA)).json() as { offer: { status: string } }).offer.status;

beforeAll(async () => {
  const server = await import("../server.js");
  ({ getRepos } = await import("../db.js"));
  ({ generateApiKey } = await import("../auth/api-key-auth.js"));
  app = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();
  keyA = seedKey(A);
  keyB = seedKey(B);
  keyC = seedKey(C);
  const k = await inj("POST", "/api/kernels", keyC, { id: kernelC, name: "C's courier kernel" });
  expect(k.statusCode, k.body).toBeLessThan(300);
});

afterAll(async () => {
  await app?.close();
});

describe("job-offer events: only the offer's parties record them", () => {
  it("[neg] a stranger cannot cancel another's offer through /events (the owner-only DELETE's side door)", async () => {
    const id = await newOffer(false);
    const res = await inj("POST", `/api/job-offers/${id}/events`, keyB, { event: "cancelled" });
    expect(res.statusCode).toBe(403);
    expect(await statusOf(id)).toBe("open");
  });

  it("[neg] a stranger cannot mark a claimed offer delivered", async () => {
    const id = await newOffer(true);
    const res = await inj("POST", `/api/job-offers/${id}/events`, keyB, { event: "delivered" });
    expect(res.statusCode).toBe(403);
    expect(await statusOf(id)).not.toBe("delivered");
  });

  it("[neg] a stranger cannot post even a note, and cannot name someone else as its author", async () => {
    const id = await newOffer(true);
    const res = await inj("POST", `/api/job-offers/${id}/events`, keyB, { event: "note", by: A, note: "spoofed" });
    expect(res.statusCode).toBe(403);
  });

  it("[neg] the poster cannot mark its own offer delivered: delivery is the claimant's", async () => {
    const id = await newOffer(true);
    const res = await inj("POST", `/api/job-offers/${id}/events`, keyA, { event: "delivered" });
    expect(res.statusCode).toBe(403);
    expect(await statusOf(id)).not.toBe("delivered");
  });

  it("control: the claimant's operator marks it delivered, and the event's author is the caller, not the body", async () => {
    const id = await newOffer(true);
    const res = await inj("POST", `/api/job-offers/${id}/events`, keyC, { event: "delivered", by: "someone-else@x.test" });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { event: { by: string } }).event.by).toBe(C);
    expect(await statusOf(id)).toBe("delivered");
  });

  it("control: the poster cancels an open offer through /events and posts notes", async () => {
    const id = await newOffer(false);
    expect((await inj("POST", `/api/job-offers/${id}/events`, keyA, { event: "note", note: "hello" })).statusCode).toBe(200);
    expect((await inj("POST", `/api/job-offers/${id}/events`, keyA, { event: "cancelled" })).statusCode).toBe(200);
    expect(await statusOf(id)).toBe("cancelled");
  });
});
