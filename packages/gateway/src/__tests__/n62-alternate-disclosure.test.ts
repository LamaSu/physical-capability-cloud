/**
 * N62, second round (astra pack 89): M3 closed the registration DETAIL read, but
 * two other read surfaces still disclose the same private fields, and the mutation
 * ownership check uses exact string equality where the read uses sameIdentity.
 *
 *  1. CRITICAL — GET /api/telemetry/system dumps registrations.findAll() (serials,
 *     operator blocks, evidence, audit) to ANY key, with no admin gate.
 *  2. CRITICAL — GET /api/operators/by-compliance/:reg returns the `description`
 *     column verbatim, and /prove overloads that column with the full private
 *     evidence record (submitter identity + device model).
 *  3. MEDIUM  — PATCH / DELETE / prove compare owner with `!==`, so a legitimate
 *     caller whose spelling differs from the stored owner (case/Unicode) is 403,
 *     though the detail read (sameIdentity) lets the same caller in.
 *
 * Reproduced at 90a808fc before any code changed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.PCC_SEED_DATA = "false";
const SECRET = "n62-alt-disclosure-admin-key-0123456789";
process.env.PCC_ADMIN_KEY = SECRET;

const A = "n62alt-owner-a@x.test";
const B = "n62alt-other-b@x.test";
const OWNER_UPPER = "N62alt-Owner@Example.com";
const OWNER_LOWER = "n62alt-owner@example.com";
const SERIAL = "SN-PRIVATE-N62ALT-0001";
const PRIVATE_MODEL = "PRIVATE-MODEL-N62ALT";
const REG = "ISO-9001:2015";

let app: FastifyInstance;
let getRepos: typeof import("../db.js").getRepos;
let generateApiKey: typeof import("../auth/api-key-auth.js").generateApiKey;
let seq = 0;
let ipSeq = 20;

function seedKey(operatorId: string): string {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: `n62alt-key-${++seq}`,
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
    remoteAddress: `10.62.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    payload: payload as never,
    headers: { authorization: `Bearer ${raw}`, ...headers },
  });

let keyA: string;
let keyB: string;
let keyOwnerUpper: string;
let keyOwnerLower: string;
let regA: string;
let regOwner: string;

beforeAll(async () => {
  const server = await import("../server.js");
  ({ getRepos } = await import("../db.js"));
  ({ generateApiKey } = await import("../auth/api-key-auth.js"));
  app = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();
  keyA = seedKey(A);
  keyB = seedKey(B);
  keyOwnerUpper = seedKey(OWNER_UPPER);
  keyOwnerLower = seedKey(OWNER_LOWER);

  // A registers (compliance + serial), then proves with a private device model.
  const reg = await inj("POST", "/api/onboard/register", keyA, {}, {
    name: "A's compliant lathe",
    category: "cnc",
    serialNumber: SERIAL,
    complianceRegulations: [REG],
    operator: { email: A, displayName: "A", certifications: [], trainingAcknowledgments: {} },
  });
  expect(reg.statusCode, reg.body).toBeLessThan(300);
  regA = (reg.json() as { registration: { id: string } }).registration.id;
  const proved = await inj("POST", `/api/onboard/registrations/${regA}/prove`, keyA, {}, {
    evidence: { deviceHealth: { status: "idle", model: PRIVATE_MODEL } },
  });
  expect(proved.statusCode, proved.body).toBeLessThan(300);

  // A registration owned by the mixed-case spelling, for the finding-3 mutation test.
  const regU = await inj("POST", "/api/onboard/register", keyOwnerUpper, {}, {
    name: "Owner's mill",
    category: "cnc",
    operator: { email: OWNER_UPPER, displayName: "Owner", certifications: [], trainingAcknowledgments: {} },
  });
  expect(regU.statusCode, regU.body).toBeLessThan(300);
  regOwner = (regU.json() as { registration: { id: string } }).registration.id;
});

afterAll(async () => {
  await app?.close();
});

describe("N62 alternate disclosure (astra pack 89)", () => {
  it("[neg] finding 1: /api/telemetry/system does not hand another key every registration + serial", async () => {
    const res = await inj("GET", "/api/telemetry/system", keyB);
    // Gated (admin-only) — a non-admin key is refused, and nothing leaks either way.
    expect(res.statusCode, res.body).not.toBe(200);
    expect(res.body).not.toContain(SERIAL);
    expect(res.body).not.toContain(A);
  });

  it("control: the admin secret still reads system telemetry", async () => {
    const res = await inj("GET", "/api/telemetry/system", keyB, { "x-admin-key": SECRET });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("[neg] finding 2: the compliance listing never exposes the /prove evidence record", async () => {
    const res = await inj("GET", `/api/operators/by-compliance/${encodeURIComponent(REG)}`, keyB);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(PRIVATE_MODEL);
    expect(res.body).not.toContain("PROOF SUBMITTED");
    expect(res.body).not.toContain(SERIAL);
    // The operator is still discoverable (the row is listed), just without the record.
    expect(res.body).toContain(regA);
  });

  it("[neg] finding 3: a normalized-equivalent owner can PATCH and /prove, as they can already read", async () => {
    const patch = await inj("PATCH", `/api/onboard/registrations/${regOwner}`, keyOwnerLower, {}, { name: "Owner's mill (edited)" });
    expect(patch.statusCode, patch.body).not.toBe(403);
    const prove = await inj("POST", `/api/onboard/registrations/${regOwner}/prove`, keyOwnerLower, {}, {
      evidence: { deviceHealth: { status: "idle" } },
    });
    expect(prove.statusCode, prove.body).not.toBe(403);
    // DELETE too: a fresh registration owned by the mixed-case spelling, deleted
    // by the lowercase key, must not 403.
    const regU2 = await inj("POST", "/api/onboard/register", keyOwnerUpper, {}, {
      name: "Owner's second mill",
      category: "cnc",
      operator: { email: OWNER_UPPER, displayName: "Owner", certifications: [], trainingAcknowledgments: {} },
    });
    const regOwner2 = (regU2.json() as { registration: { id: string } }).registration.id;
    const del = await inj("DELETE", `/api/onboard/registrations/${regOwner2}`, keyOwnerLower);
    expect(del.statusCode, del.body).not.toBe(403);
  });

  it("control: a true stranger still cannot PATCH or prove someone else's registration", async () => {
    expect((await inj("PATCH", `/api/onboard/registrations/${regOwner}`, keyB, {}, { name: "hijack" })).statusCode).toBe(403);
    expect((await inj("POST", `/api/onboard/registrations/${regOwner}/prove`, keyB, {}, { evidence: { deviceHealth: { status: "idle" } } })).statusCode).toBe(403);
  });
});
