/**
 * WP-A: request-node ownership, one of the remaining "broader ownership gaps"
 * (astra, pack 47 verdict), each reproduced at a50d68ef before any code changed.
 *
 * - POST /api/requests/:id/nodes/:nodeId/assign set assignedOperator
 *   unconditionally. Any key could take over a node another operator had claimed,
 *   then mark it completed (a request whose nodes all complete becomes completed).
 * - PUT /api/requests/:id/nodes/:nodeId/status skipped its owner check when the node
 *   had no assigned operator (rule 7).
 *
 * Now a node claimed by one operator can be reassigned only by a broker. An unassigned node's status is a broker's to set. Claiming an OPEN node
 * for yourself is unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.PCC_SEED_DATA = "false";
const SECRET = "request-node-owner-test-key-0123456789";
process.env.PCC_ADMIN_KEY = SECRET;
const BROKER = "broker-for-nodes@x.test";
process.env.BROKER_OPERATORS = BROKER;

const A = "reg-owner-a@x.test";
const B = "other-b@x.test";

let app: FastifyInstance;
let getRepos: typeof import("../db.js").getRepos;
let generateApiKey: typeof import("../auth/api-key-auth.js").generateApiKey;
let seq = 0;
let ipSeq = 10;

function seedKey(operatorId: string): string {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: `node-owner-key-${++seq}`,
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

const inj = (method: string, url: string, raw: string, headers: Record<string, string> = {}, payload?: unknown) =>
  app.inject({
    method: method as never,
    url,
    remoteAddress: `10.93.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    payload: payload as never,
    headers: { authorization: `Bearer ${raw}`, ...headers },
  });

const REQUEST = {
  title: "Cute Animatronic Plush Desk Robot",
  description:
    "Build a cute animatronic plush desk robot with servo-driven head movement, arm wave, and idle breathing animations. Soft plush exterior with internal servo mechanism.",
  budget: 2500,
  currency: "USDC",
  urgency: "standard",
};

let keyA: string;
let keyB: string;
let keyBroker: string;

beforeAll(async () => {
  const server = await import("../server.js");
  ({ getRepos } = await import("../db.js"));
  ({ generateApiKey } = await import("../auth/api-key-auth.js"));
  const gw = await server.createGateway(0);
  app = gw.app as unknown as FastifyInstance;
  await app.ready();
  keyA = seedKey(A);
  keyB = seedKey(B);
  keyBroker = seedKey(BROKER);
});

afterAll(async () => {
  await app?.close();
});

/** A fresh request; returns its id and first node id (unassigned). */
async function newRequest(key: string): Promise<{ id: string; node: string }> {
  const res = await inj("POST", "/api/requests", key, {}, REQUEST);
  expect(res.statusCode, res.body).toBeLessThan(300);
  const r = (res.json() as { request: { id: string; capabilityDag: Array<{ id: string }> } }).request;
  expect(r.capabilityDag.length).toBeGreaterThan(0);
  return { id: r.id, node: r.capabilityDag[0].id };
}
const nodeOf = async (id: string, nodeId: string) => {
  const res = await inj("GET", `/api/requests/${id}`, keyA);
  return (res.json() as { request: { capabilityDag: Array<{ id: string; assignedOperator?: string; status: string }> } }).request.capabilityDag.find(
    (n) => n.id === nodeId,
  )!;
};


describe("request nodes: a claimed node is its operator's; an unassigned node's status is a broker's", () => {
  it("[neg] another key cannot take over a node A claimed, nor then complete it", async () => {
    const r = await newRequest(keyA);
    const claim = await inj("POST", `/api/requests/${r.id}/nodes/${r.node}/assign`, keyA, {}, {});
    expect(claim.statusCode, claim.body).toBe(200);
    const takeover = await inj("POST", `/api/requests/${r.id}/nodes/${r.node}/assign`, keyB, {}, {});
    expect(takeover.statusCode).toBe(409);
    const done = await inj("PUT", `/api/requests/${r.id}/nodes/${r.node}/status`, keyB, {}, { status: "completed" });
    expect(done.statusCode).toBe(403);
    const node = await nodeOf(r.id, r.node);
    expect(node.assignedOperator).toBe(A);
    expect(node.status).not.toBe("completed");
  });

  it("[neg] a key that is neither the assignee nor a broker cannot set an UNASSIGNED node's status", async () => {
    const r = await newRequest(keyA);
    const res = await inj("PUT", `/api/requests/${r.id}/nodes/${r.node}/status`, keyB, {}, { status: "completed" });
    expect(res.statusCode).toBe(403);
    expect((await nodeOf(r.id, r.node)).status).not.toBe("completed");
  });

  it("control: claiming an OPEN node for yourself still works, and the claimant sets its status", async () => {
    const r = await newRequest(keyA);
    expect((await inj("POST", `/api/requests/${r.id}/nodes/${r.node}/assign`, keyB, {}, {})).statusCode).toBe(200);
    const res = await inj("PUT", `/api/requests/${r.id}/nodes/${r.node}/status`, keyB, {}, { status: "in_progress" });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("control: a broker reassigns a claimed node and sets an unassigned node's status", async () => {
    const r = await newRequest(keyA);
    expect((await inj("POST", `/api/requests/${r.id}/nodes/${r.node}/assign`, keyA, {}, {})).statusCode).toBe(200);
    const moved = await inj("POST", `/api/requests/${r.id}/nodes/${r.node}/assign`, keyBroker, {}, { operatorId: B });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await nodeOf(r.id, r.node)).assignedOperator).toBe(B);
    const r2 = await newRequest(keyA);
    const st = await inj("PUT", `/api/requests/${r2.id}/nodes/${r2.node}/status`, keyBroker, {}, { status: "bidding" });
    expect(st.statusCode, st.body).toBe(200);
  });

  it("control: claiming a node you already hold again is idempotent (200)", async () => {
    const r = await newRequest(keyA);
    expect((await inj("POST", `/api/requests/${r.id}/nodes/${r.node}/assign`, keyA, {}, {})).statusCode).toBe(200);
    expect((await inj("POST", `/api/requests/${r.id}/nodes/${r.node}/assign`, keyA, {}, {})).statusCode).toBe(200);
  });
});
