import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { isAdminCaller } from "../auth/admin-caller.js";
import { countAdminKeyFields } from "../middleware/relay-admin-gate.js";
import { getRepos } from "../db.js";
import { getConversations, getRecentMessages, isAgentBridgeReady } from "../agent-bridge.js";

vi.mock("../agent-bridge.js", async (original) => {
  const real = await original<typeof import("../agent-bridge.js")>();
  return {
    ...real,
    getConversations: vi.fn(real.getConversations),
    getRecentMessages: vi.fn(real.getRecentMessages),
    isAgentBridgeReady: vi.fn(real.isAgentBridgeReady),
  };
});

const paths = ["/api/agents/live/conversations", "/api/agents/live/messages"] as const;
const secret = "synthetic-admin-secret-n350";
const markerMessage: ReturnType<typeof getRecentMessages>[number] = {
  id: "synthetic-n350-message-marker",
  conversationId: "synthetic-n350-conversation-marker",
  from: "synthetic-n350-user",
  to: "synthetic-n350-broker",
  intent: { type: "discover_capabilities" },
  timestamp: "2026-01-01T00:00:00.000Z",
};
const markerConversation: ReturnType<typeof getConversations>[number] = {
  id: "synthetic-n350-conversation-marker",
  participants: [markerMessage.from, markerMessage.to],
  messages: [markerMessage],
  status: "active",
  topic: "synthetic-n350-topic",
  createdAt: markerMessage.timestamp,
  updatedAt: markerMessage.timestamp,
};
const readSpies = {
  getConversations: vi.mocked(getConversations),
  getRecentMessages: vi.mocked(getRecentMessages),
  isAgentBridgeReady: vi.mocked(isAgentBridgeReady),
};
let app: FastifyInstance;
let keys: ReturnType<typeof provisionApiKey>[];
let handlerRequest: FastifyRequest | undefined;

function restoreEnv() {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("PCC_SEED_DATA", "false");
  vi.stubEnv("SERVE_DASHBOARD", "false");
  vi.stubEnv("PCC_ADMIN_KEY", secret);
  vi.stubEnv("TENANT_ENFORCE", "");
  delete process.env.TENANT_ENFORCE;
}

const bearer = (index = 0) => ({ authorization: `Bearer ${keys[index].rawKey}` });

function request(path: typeof paths[number], headers: Record<string, string>, method: "GET" | "HEAD" = "GET") {
  for (const spy of Object.values(readSpies)) spy.mockClear();
  handlerRequest = undefined;
  return app.inject({ method, url: path, headers });
}

function expectNoRead() {
  for (const [name, spy] of Object.entries(readSpies)) expect(spy, name).not.toHaveBeenCalled();
}

async function expectForbidden(path: typeof paths[number], headers: Record<string, string>, method: "GET" | "HEAD" = "GET") {
  const res = await request(path, headers, method);
  expectNoRead();
  expect(res.statusCode).toBe(403);
  expect(res.body).toBe(method === "HEAD" ? "" : '{"error":"forbidden"}');
  for (const marker of [markerConversation.id, markerMessage.id]) expect(res.body).not.toContain(marker);
}

async function expectAllowed(path: typeof paths[number], headers: Record<string, string>, method: "GET" | "HEAD" = "GET") {
  if (path === paths[0]) readSpies.getConversations.mockReturnValueOnce([markerConversation]);
  else readSpies.getRecentMessages.mockReturnValueOnce([markerMessage]);
  readSpies.isAgentBridgeReady.mockReturnValueOnce(true);
  const res = await request(path, headers, method);
  expect(res.statusCode).toBe(200);
  expect(readSpies.isAgentBridgeReady).toHaveBeenCalledTimes(1);
  if (path === paths[0]) {
    expect(readSpies.getConversations).toHaveBeenCalledTimes(1);
    expect(readSpies.getRecentMessages).not.toHaveBeenCalled();
  } else {
    expect(readSpies.getRecentMessages).toHaveBeenCalledTimes(1);
    expect(readSpies.getRecentMessages).toHaveBeenCalledWith(50);
    expect(readSpies.getConversations).not.toHaveBeenCalled();
  }
  if (method === "HEAD") expect(res.body).toBe("");
  else expect(res.json()).toEqual(path === paths[0]
    ? { conversations: [markerConversation], source: "live" }
    : { messages: [markerMessage], source: "live" });
}

beforeAll(async () => {
  restoreEnv();
  const { createGateway } = await import("../server.js");
  app = (await createGateway(0)).app as unknown as FastifyInstance;
  app.addHook("preHandler", async (req) => { handlerRequest = req; });
  await app.ready();
  keys = [["admin"], ["*"], ["*", "admin"], ["admin", "*"], ["operator:basic"]].map((scopes, index) =>
    provisionApiKey({ operatorId: `synthetic-n350-operator-${index}`, name: `synthetic-n350-key-${index}`, scopes }),
  );
}, 180_000);

beforeEach(restoreEnv);

afterAll(async () => {
  try { await app?.close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

describe("agents live routes require admins and refuse before any read", () => {
  it("AL1 an admin-scope key receives 200 with the read controls", async () => {
    for (const path of paths) await expectAllowed(path, bearer());
  });

  it("AL2 one valid admin header beside an operator key receives 200", async () => {
    for (const path of paths) await expectAllowed(path, { ...bearer(4), "x-admin-key": secret });
  });

  it("AL3 a key without admin scope gets 403 before any read", async () => {
    for (const path of paths) await expectForbidden(path, bearer(4));
  });

  it("AL4 wildcard scopes in either order get 403 before any read", async () => {
    expect(JSON.parse(getRepos().apiKeys.findById(keys[3].record!.id)!.scopes!)).toEqual(["admin", "*"]);
    for (const index of [1, 2, 3]) {
      for (const path of paths) await expectForbidden(path, bearer(index));
    }
  });

  it("AL5 a wrong admin header beside an admin-scope key gets 403 before any read", async () => {
    for (const path of paths) await expectForbidden(path, { ...bearer(), "x-admin-key": "synthetic-n350-wrong-secret" });
  });

  it("AL6 a wildcard admin header gets 403 before any read", async () => {
    vi.stubEnv("PCC_ADMIN_KEY", "*");
    try {
      for (const path of paths) await expectForbidden(path, { ...bearer(), "x-admin-key": "*" });
    } finally { vi.stubEnv("PCC_ADMIN_KEY", secret); }
  });

  it("AL6b blank admin headers get 403 before any read, with the secret blank or unset", async () => {
    try {
      for (const configured of ["", "   "]) {
        vi.stubEnv("PCC_ADMIN_KEY", configured);
        for (const path of paths) {
          await expectForbidden(path, { ...bearer(), "x-admin-key": configured });
          expect(handlerRequest?.routeOptions.url).toBe(path);
          expect(countAdminKeyFields(handlerRequest!)).toBe(1);
          expect(handlerRequest?.headers["x-admin-key"]).toBe(configured);
          const fields = handlerRequest!.raw.rawHeaders.flatMap((name, index, raw) =>
            index % 2 === 0 && name.toLowerCase() === "x-admin-key" ? [raw[index + 1]] : []);
          expect(fields).toEqual([configured]);
        }
      }
      delete process.env.PCC_ADMIN_KEY;
      expect(Object.keys(process.env)).not.toContain("PCC_ADMIN_KEY");
      for (const path of paths) {
        for (const header of ["", "undefined"]) {
          await expectForbidden(path, { ...bearer(), "x-admin-key": header });
          const captured = handlerRequest;
          if (!captured) throw new Error("Handler request required");
          expect(captured.routeOptions.url).toBe(path);
          expect(countAdminKeyFields(captured)).toBe(1);
          expect(captured.headers["x-admin-key"]).toBe(header);
          const fields = captured.raw.rawHeaders.flatMap((name, index, raw) =>
            index % 2 === 0 && name.toLowerCase() === "x-admin-key" ? [raw[index + 1]] : []);
          expect(fields).toEqual([header]);
        }
      }
    } finally { vi.stubEnv("PCC_ADMIN_KEY", secret); }
  });

  it("AL7 a session gets 403 before any read and its admin-header control gets 200", async () => {
    const token = "synthetic-n350-session";
    const now = Date.now();
    getRepos().sessions.insert({ id: token, token, walletAddress: "0x1111111111111111111111111111111111111111", createdAt: new Date(now).toISOString(), lastActiveAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString() });
    const cookie = `pcc_session=${app.signCookie(token)}`;
    for (const path of paths) {
      await expectForbidden(path, { cookie });
      await expectAllowed(path, { cookie, "x-admin-key": secret });
    }
  });

  it("AL8 HEAD gives an operator 403 before any read and an admin 200 with reads", async () => {
    for (const path of paths) {
      await expectForbidden(path, bearer(4), "HEAD");
      await expectAllowed(path, bearer(), "HEAD");
    }
  });

  it("AL9 TENANT_ENFORCE gives every caller 403 before any read only for literal true per request", async () => {
    vi.stubEnv("TENANT_ENFORCE", "true");
    for (const headers of [bearer(), { ...bearer(4), "x-admin-key": secret }, { ...bearer(), "x-admin-key": secret }]) {
      for (const path of paths) await expectForbidden(path, headers);
    }
    vi.stubEnv("TENANT_ENFORCE", "false");
    for (const path of paths) await expectAllowed(path, bearer());
    for (const flag of ["TRUE", " true", "1"]) {
      vi.stubEnv("TENANT_ENFORCE", flag);
      for (const path of paths) await expectAllowed(path, bearer());
    }
    delete process.env.TENANT_ENFORCE;
    for (const path of paths) await expectAllowed(path, bearer());
  });

  it("AL10 duplicate admin fields refuse without key fallback and no header permits admin scopes", () => {
    const req = {
      raw: { rawHeaders: ["X-Admin-Key", secret, "x-admin-key", secret] },
      headers: { "x-admin-key": `${secret}, ${secret}` },
      apiKeyId: keys[0].record!.id,
    } as unknown as FastifyRequest;
    expect(isAdminCaller(req)).toBe(false);
    req.raw.rawHeaders = [];
    delete req.headers["x-admin-key"];
    expect(isAdminCaller(req)).toBe(true);
  });

  it("AL11 admin helper errors refuse", () => {
    const req = { get raw() { throw new Error("synthetic-n350-request-error"); } } as unknown as FastifyRequest;
    expect(isAdminCaller(req)).toBe(false);
    const adminKey = keys[0].record;
    if (!adminKey) throw new Error("Admin key record required");
    const unreadable = {
      apiKeyId: adminKey.id,
      headers: {},
      get raw() { throw new Error("synthetic-n350-admin-request-error"); },
    } as unknown as FastifyRequest;
    expect(isAdminCaller(unreadable)).toBe(false);
    const missingRaw = {
      apiKeyId: adminKey.id,
      headers: {},
    } as unknown as FastifyRequest;
    expect(isAdminCaller(missingRaw)).toBe(false);
  });
});
