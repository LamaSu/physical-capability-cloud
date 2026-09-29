/**
 * WP-A round 6 (board N2): BROKER_OPERATORS no longer opens an ADMIN view.
 *
 * Two handlers still granted admin authority to whoever's key carried an operatorId
 * on BROKER_OPERATORS, the same allowlist-identity pattern the admin-gates review
 * rejected (wpa-326-admingates-astra):
 * - GET /api/operator/diagnostics showed every operator's uploads, with IPs;
 * - POST /api/operator/support/:threadId/reply let the caller reply AS "admin" on
 *   ANY thread.
 * Both now need the admin SECRET. A wrong secret is refused, never downgraded.
 * Both also fail closed without an attached identity (rule 7): the list returned
 * every upload, and the reply skipped its owner check when either side was missing.
 *
 * The first block runs on the real server (createGateway: apiGate, scope-checker,
 * every route). The rule-7 block mounts just the two route plugins, with no auth
 * layer in front, so the handler's own guard is what answers.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.PCC_SEED_DATA = "false";
const SECRET = "broker-admin-views-test-key-0123456789";
process.env.PCC_ADMIN_KEY = SECRET;
const BROKER = "broker-operator@x.test";
process.env.BROKER_OPERATORS = BROKER;
const TENANT_B = "tenant-b@x.test";

let app: FastifyInstance;
let getRepos: typeof import("../db.js").getRepos;
let generateApiKey: typeof import("../auth/api-key-auth.js").generateApiKey;
let seq = 0;
let ipSeq = 10;

function seedKey(operatorId: string, scopes: string[]): string {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: `broker-views-key-${++seq}`,
    keyHash,
    keyPrefix,
    operatorId,
    scopes: JSON.stringify(scopes),
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
    remoteAddress: `10.89.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    payload: payload as never,
    headers: { authorization: `Bearer ${raw}`, ...headers },
  });
const secret = { "x-admin-key": SECRET };
const wrongSecret = { "x-admin-key": "not-the-admin-key" };

const bundle = (kernelId: string) => ({
  kernelId,
  encrypted: { ciphertext_b64: "Y2lwaGVy", iv_b64: "aXY=", salt_b64: "c2FsdA==", tag_b64: "dGFn" },
  bundleHash: "sha256:00",
  bundleSize: 6,
  logLineCount: 1,
  systemPlatform: "linux",
  collectedAt: new Date().toISOString(),
});

let broker: string;
let tenantB: string;
let tenantBUploadId: string;
let tenantBThread: string;

beforeAll(async () => {
  const server = await import("../server.js");
  ({ getRepos } = await import("../db.js"));
  ({ generateApiKey } = await import("../auth/api-key-auth.js"));
  const gw = await server.createGateway(0);
  app = gw.app as unknown as FastifyInstance;
  await app.ready();
  broker = seedKey(BROKER, ["operator"]);
  tenantB = seedKey(TENANT_B, ["operator"]);

  const up = await inj("POST", "/api/operator/diagnostics", tenantB, {}, bundle(TENANT_B));
  expect(up.statusCode).toBe(200);
  tenantBUploadId = (up.json() as { uploadId?: string; id?: string }).uploadId ?? (up.json() as { id: string }).id;
  const th = await inj("POST", "/api/operator/support", tenantB, {}, { kernelId: "kernel-tenant-b", message: "tenant B needs help" });
  expect(th.statusCode).toBe(200);
  tenantBThread = (th.json() as { threadId: string }).threadId;
});

afterAll(async () => {
  await app?.close();
});

describe("GET /api/operator/diagnostics: the admin view needs the secret", () => {
  it("[neg] a BROKER_OPERATORS key without the secret sees only its own uploads, and no IPs", async () => {
    const res = await inj("GET", "/api/operator/diagnostics", broker);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { uploads: Array<{ id: string; ip?: string }>; scoped: boolean };
    expect(body.scoped).toBe(true);
    expect(body.uploads.map((u) => u.id)).not.toContain(tenantBUploadId);
    expect(body.uploads.every((u) => u.ip === undefined)).toBe(true);
  });

  it("[neg] a wrong secret is refused, not downgraded to the scoped view", async () => {
    const res = await inj("GET", "/api/operator/diagnostics", broker, wrongSecret);
    expect(res.statusCode).toBe(403);
  });

  it("control: the secret opens the admin view, IPs included", async () => {
    const res = await inj("GET", "/api/operator/diagnostics", broker, secret);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { uploads: Array<{ id: string; ip?: string }>; scoped: boolean };
    expect(body.scoped).toBe(false);
    const mine = body.uploads.find((u) => u.id === tenantBUploadId);
    expect(mine?.ip).toBeTypeOf("string");
  });

  it("control: the owner still sees its own upload", async () => {
    const res = await inj("GET", "/api/operator/diagnostics", tenantB);
    expect((res.json() as { uploads: Array<{ id: string }> }).uploads.map((u) => u.id)).toContain(tenantBUploadId);
  });
});

describe("POST /api/operator/support/:threadId/reply: replying as admin needs the secret", () => {
  it("[neg] a BROKER_OPERATORS key without the secret cannot reply on another operator's thread", async () => {
    const res = await inj("POST", `/api/operator/support/${tenantBThread}/reply`, broker, {}, { message: "I am support" });
    expect(res.statusCode).toBe(403);
  });

  it("[neg] a wrong secret is refused", async () => {
    const res = await inj("POST", `/api/operator/support/${tenantBThread}/reply`, broker, wrongSecret, { message: "x" });
    expect(res.statusCode).toBe(403);
  });

  it("control: the secret replies as admin; the owner replies as operator", async () => {
    const asAdmin = await inj("POST", `/api/operator/support/${tenantBThread}/reply`, broker, secret, { message: "support here" });
    expect(asAdmin.statusCode).toBe(200);
    const asOwner = await inj("POST", `/api/operator/support/${tenantBThread}/reply`, tenantB, {}, { message: "thanks" });
    expect(asOwner.statusCode).toBe(200);
    const thread = await inj("GET", `/api/operator/support/${tenantBThread}`, tenantB);
    const froms = (thread.json() as { thread: { messages: Array<{ from: string; text: string }> } }).thread.messages.map(
      (m) => `${m.from}:${m.text}`,
    );
    expect(froms).toEqual(["operator:tenant B needs help", "admin:support here", "operator:thanks"]);
  });
});

describe("rule 7: no attached identity fails closed (route plugins with no auth layer in front)", () => {
  let bare: FastifyInstance;

  beforeAll(async () => {
    const { diagnosticLogRoutes } = await import("../routes/diagnostic-logs.js");
    const { supportMessageRoutes } = await import("../routes/support-messages.js");
    bare = Fastify({ logger: false });
    // A test-only identity seam: the header stands in for what apiGate attaches.
    bare.addHook("onRequest", async (req) => {
      const who = req.headers["x-test-operator"];
      if (typeof who === "string") (req as unknown as { operatorId: string }).operatorId = who;
    });
    await bare.register(diagnosticLogRoutes);
    await bare.register(supportMessageRoutes);
    await bare.ready();
  });

  afterAll(async () => {
    await bare?.close();
  });

  it("[neg] the diagnostics list with no identity is 401, not every upload", async () => {
    await bare.inject({ method: "POST", url: "/api/operator/diagnostics", payload: bundle("some-kernel") });
    const res = await bare.inject({ method: "GET", url: "/api/operator/diagnostics" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("some-kernel");
  });

  it("[neg] a thread with no recorded owner cannot be answered by just anyone", async () => {
    const th = await bare.inject({
      method: "POST",
      url: "/api/operator/support",
      payload: { kernelId: "ownerless-kernel", message: "no identity attached" },
    });
    const { threadId } = th.json() as { threadId: string };
    const res = await bare.inject({
      method: "POST",
      url: `/api/operator/support/${threadId}/reply`,
      headers: { "x-test-operator": "someone-else@x.test" },
      payload: { message: "hijack" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("[neg] a reply with no identity at all is 401", async () => {
    const th = await bare.inject({
      method: "POST",
      url: "/api/operator/support",
      headers: { "x-test-operator": "owner@x.test" },
      payload: { kernelId: "owned-kernel", message: "hello" },
    });
    const { threadId } = th.json() as { threadId: string };
    const res = await bare.inject({ method: "POST", url: `/api/operator/support/${threadId}/reply`, payload: { message: "x" } });
    expect(res.statusCode).toBe(401);
  });
});
