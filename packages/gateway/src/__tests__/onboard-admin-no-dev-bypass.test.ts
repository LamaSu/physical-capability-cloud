/**
 * astra pack 89b, NEW CRITICAL: onboarding's own admin check (isOnboardAdmin)
 * failed OPEN when PCC_ADMIN_KEY was unset and NODE_ENV was "development" or
 * "test": any ordinary operator could approve, reject or activate ANOTHER
 * operator's registration, and approve/activate answered with the full private
 * row (serial number, operator block). The shared admin helper had already
 * dropped that environment exception; these three handlers did not use it.
 *
 * The run here is exactly the deployment shape that was open: NODE_ENV
 * "development", no PCC_ADMIN_KEY. Every admin transition must now refuse a
 * caller without the admin secret, write nothing, and return no registration.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

const savedEnv = { NODE_ENV: process.env.NODE_ENV, PCC_ADMIN_KEY: process.env.PCC_ADMIN_KEY };
process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "development";
process.env.PCC_SEED_DATA = "false";
delete process.env.PCC_ADMIN_KEY;

const A = "devbypass-owner-a@x.test";
const B = "devbypass-other-b@x.test";
const SERIAL = "SN-PRIVATE-DEVBYPASS-0001";

let app: FastifyInstance;
let getRepos: typeof import("../db.js").getRepos;
let generateApiKey: typeof import("../auth/api-key-auth.js").generateApiKey;
let seq = 0;
let ipSeq = 40;

function seedKey(operatorId: string): string {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: `devbypass-key-${++seq}`,
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

const inj = (method: string, url: string, raw: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: method as never,
    url,
    remoteAddress: `10.89.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    payload: payload as never,
    headers: { authorization: `Bearer ${raw}`, ...headers },
  });

let keyA: string;
let keyB: string;

async function registerAsA(name: string): Promise<string> {
  const reg = await inj("POST", "/api/onboard/register", keyA, {
    name,
    category: "cnc",
    serialNumber: SERIAL,
    operator: { email: A, displayName: "A", certifications: [], trainingAcknowledgments: {} },
  });
  expect(reg.statusCode, reg.body).toBeLessThan(300);
  return (reg.json() as { registration: { id: string } }).registration.id;
}

beforeAll(async () => {
  const server = await import("../server.js");
  ({ getRepos } = await import("../db.js"));
  ({ generateApiKey } = await import("../auth/api-key-auth.js"));
  app = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();
  keyA = seedKey(A);
  keyB = seedKey(B);
});

afterAll(async () => {
  await app?.close();
  if (savedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedEnv.NODE_ENV;
  if (savedEnv.PCC_ADMIN_KEY === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = savedEnv.PCC_ADMIN_KEY;
});

describe("onboarding admin transitions have no development bypass (astra pack 89b)", () => {
  it("[neg] astra's reproduction: B approves A's registration with no X-Admin-Key under NODE_ENV=development and no PCC_ADMIN_KEY: refused, nothing approved, no row returned", async () => {
    const id = await registerAsA("A's lathe (approve)");
    const before = getRepos().registrations.findById(id)?.status;
    const res = await inj("POST", `/api/onboard/registrations/${id}/approve`, keyB, { expectedEvidenceDigest: "none" });
    expect(res.statusCode, res.body).toBe(503); // admin_key_unconfigured, in development too
    expect(res.body).not.toContain(SERIAL);
    expect(res.body).not.toContain(A);
    expect(getRepos().registrations.findById(id)?.status).toBe(before);
  });

  it("[neg] B rejects A's registration: refused, nothing changes", async () => {
    const id = await registerAsA("A's lathe (reject)");
    const before = getRepos().registrations.findById(id)?.status;
    const res = await inj("POST", `/api/onboard/registrations/${id}/reject`, keyB, {});
    expect(res.statusCode, res.body).toBe(503); // admin_key_unconfigured, in development too
    expect(res.body).not.toContain(SERIAL);
    expect(getRepos().registrations.findById(id)?.status).toBe(before);
  });

  it("[neg] B activates A's registration: refused, nothing changes, no row returned", async () => {
    const id = await registerAsA("A's lathe (activate)");
    const before = getRepos().registrations.findById(id)?.status;
    const res = await inj("POST", `/api/onboard/registrations/${id}/activate`, keyB, {});
    expect(res.statusCode, res.body).toBe(503); // admin_key_unconfigured, in development too
    expect(res.body).not.toContain(SERIAL);
    expect(getRepos().registrations.findById(id)?.status).toBe(before);
  });

  it("[neg] even the owner A cannot approve its own registration without the admin secret", async () => {
    const id = await registerAsA("A's lathe (self-approve)");
    const res = await inj("POST", `/api/onboard/registrations/${id}/approve`, keyA, { expectedEvidenceDigest: "none" });
    expect(res.statusCode, res.body).toBe(503); // admin_key_unconfigured, in development too
  });
});
