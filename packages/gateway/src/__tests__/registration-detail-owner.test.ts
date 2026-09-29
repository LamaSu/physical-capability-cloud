/**
 * N62: GET /api/onboard/registrations/:id returned the FULL registration to any
 * key. Reproduced at 73d6358d (WP-B stacked on #326) before any code changed.
 *
 * The public list is sanitised (id, status, name, capability, createdAt). The
 * detail returned everything: the operator block (the owner's identity and
 * contact), the serial number, space and power requirements, and pricing.
 *
 * Now the full record is its owner's (registrationOwner: the authenticated
 * caller bound at write, WP-B M3), or the admin secret's (#326's adminOrCaller: a
 * wrong secret is refused, never downgraded). Anyone else, and an unknown id,
 * gets 404.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.PCC_SEED_DATA = "false";
const SECRET = "registration-detail-owner-test-key-0123456789";
process.env.PCC_ADMIN_KEY = SECRET;

const A = "reg-owner-a@x.test";
const B = "other-b@x.test";
const SERIAL = "SN-PRIVATE-N62-0001";

let app: FastifyInstance;
let getRepos: typeof import("../db.js").getRepos;
let generateApiKey: typeof import("../auth/api-key-auth.js").generateApiKey;
let seq = 0;
let ipSeq = 10;

function seedKey(operatorId: string): string {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: `n62-key-${++seq}`,
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
    remoteAddress: `10.101.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    payload: payload as never,
    headers: { authorization: `Bearer ${raw}`, ...headers },
  });

let keyA: string;
let keyB: string;
let registrationId: string;

beforeAll(async () => {
  const server = await import("../server.js");
  ({ getRepos } = await import("../db.js"));
  ({ generateApiKey } = await import("../auth/api-key-auth.js"));
  app = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();
  keyA = seedKey(A);
  keyB = seedKey(B);
  const reg = await inj("POST", "/api/onboard/register", keyA, {}, {
    name: "A's lathe",
    category: "cnc",
    serialNumber: SERIAL,
    operator: { email: A, displayName: "A", certifications: [], trainingAcknowledgments: {} },
  });
  expect(reg.statusCode, reg.body).toBeLessThan(300);
  registrationId = (reg.json() as { registration: { id: string } }).registration.id;
});

afterAll(async () => {
  await app?.close();
});

describe("N62: a registration's full record is its owner's (or the admin secret's)", () => {
  it("[neg] another key gets 404, as for an unknown id, and none of the private fields", async () => {
    const res = await inj("GET", `/api/onboard/registrations/${registrationId}`, keyB);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(SERIAL);
    expect(res.body).not.toContain(A);
  });

  it("[neg] an unknown id is a 404 (it used to be 200 with an error body)", async () => {
    expect((await inj("GET", "/api/onboard/registrations/reg-does-not-exist", keyA)).statusCode).toBe(404);
  });

  it("[neg] a WRONG admin secret is refused, not downgraded to the owner view", async () => {
    const res = await inj("GET", `/api/onboard/registrations/${registrationId}`, keyB, { "x-admin-key": "not-the-admin-key" });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(SERIAL);
  });

  it("control: the owner and the admin secret read the full record", async () => {
    const own = await inj("GET", `/api/onboard/registrations/${registrationId}`, keyA);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.body).toContain(SERIAL);
    const asAdmin = await inj("GET", `/api/onboard/registrations/${registrationId}`, keyB, { "x-admin-key": SECRET });
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.body).toContain(SERIAL);
  });

  it("control: the public list stays sanitised and still lists it", async () => {
    const res = await inj("GET", "/api/onboard/registrations", keyB);
    expect(res.body).toContain(registrationId);
    expect(res.body).not.toContain(SERIAL);
  });
});
