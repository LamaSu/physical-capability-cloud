/**
 * WP-D D6 — the onboarding chat runs tools as exactly its caller.
 *
 *   - POST /api/onboard/chat takes the caller's OWN credential (Bearer API key or
 *     SIWE session), optionally. Each tool call carries exactly that principal to
 *     app.inject, never a server-held key, and the caller's IP.
 *   - An anonymous chat reaches only tools whose endpoint apiGate's own
 *     isPublicRoute() lets through with no credential.
 *   - approve / activate / reject / /api/admin tools are never callable from
 *     chat, whatever the auth: never offered to the model, never requested.
 *
 * The app runs the REAL apiGate (non-encapsulated, as in server.ts) and the real
 * cookie plugin. A root onRequest spy, registered before the gate, records every
 * request the chat makes, so "refused" means no request was made at all.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { randomUUID } from "node:crypto";

const llm = vi.hoisted(() => ({
  requests: [] as Array<{ tools?: Array<{ name: string }> }>,
  responses: [] as unknown[],
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async (args: unknown) => {
        llm.requests.push(JSON.parse(JSON.stringify(args)));
        const next = llm.responses.shift();
        if (next instanceof Error) throw next;
        return next ?? { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" };
      },
    };
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic };
});

vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../services/audit-service.js", () => ({
  auditService: { log: vi.fn(), query: vi.fn().mockReturnValue([]), stats: vi.fn().mockReturnValue([]) },
}));
vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn(), getTimeline: vi.fn().mockReturnValue([]), getStats: vi.fn().mockReturnValue({}) },
}));

import {
  onboardChatRoutes,
  _resetAnthropicCache,
  _resetAgentPackageCache,
  _setAgentPackageForTests,
} from "../routes/onboard-chat.js";
import { apiGate } from "../middleware/api-gate.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { initStore, closeStore, getRepos } from "../db.js";

const COOKIE_SECRET = "onboard-chat-principal-test-cookie-secret";
const WALLET = "0x" + "5eed".repeat(10);

const tool = (name: string, method: string, path: string) => ({
  name,
  description: name,
  input_schema: { type: "object", properties: {} },
  endpoint: { method, path },
});

const PKG = {
  system_prompt: "test system prompt",
  tools: [
    tool("whoami", "GET", "/api/test/whoami"), // authenticated (not on apiGate's public list)
    tool("capability_types", "GET", "/api/capabilities/types"), // public per apiGate
    tool("approve_registration", "POST", "/api/onboard/registrations/{registrationId}/approve"),
    tool("reject_registration", "POST", "/api/onboard/registrations/{registrationId}/reject"),
    tool("activate_registration", "POST", "/api/onboard/registrations/{registrationId}/activate"),
    tool("waitlist_export", "GET", "/api/admin/waitlist"),
    tool("item_details", "GET", "/api/test/items/{id}/details"),
    tool("generate_ui", "POST", "http://localhost:3200/api/test/whoami"),
    // WP-D R3: every tool that changes a registration's status, by name or by route.
    tool("prove_registration", "POST", "/api/onboard/registrations/{registrationId}/prove"),
    tool("submit_registration_evidence", "POST", "/api/onboard/registrations/{registrationId}/prove"),
    tool("remove_registration_record", "DELETE", "/api/onboard/registrations/{registrationId}"),
    tool("registration_step", "POST", "/api/onboard/registrations/{registrationId}/{step}"),
    tool("delete_registration", "GET", "/api/test/whoami"), // a status tool's name on a harmless route
    tool("get_registration", "GET", "/api/onboard/registrations/{registrationId}"), // a read: allowed
  ],
};
const FORBIDDEN = ["approve_registration", "reject_registration", "activate_registration", "waitlist_export"];
const REGISTRATION_STATUS = [
  "prove_registration", "submit_registration_evidence", "remove_registration_record", "registration_step", "delete_registration",
];

/** Every request the chat dispatched (the chat's own endpoints excluded). */
interface Dispatched { method: string; url: string; authorization?: string; cookie?: string; ip: string }

const calls = (...blocks: Array<[name: string, input?: Record<string, unknown>]>) => ({
  content: blocks.map(([name, input], i) => ({ type: "tool_use", id: `tu_${i}_${name}`, name, input: input ?? {} })),
  stop_reason: "tool_use",
});
const endTurn = { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" };

describe("onboard-chat principal forwarding (WP-D D6)", () => {
  let app: FastifyInstance;
  let dispatched: Dispatched[];
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    llm.requests.length = 0;
    llm.responses.length = 0;
    dispatched = [];
    _resetAnthropicCache();
    _resetAgentPackageCache();
    _setAgentPackageForTests(PKG);

    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    app = Fastify({ logger: false });
    await app.register(cookie, { secret: COOKIE_SECRET });
    app.addHook("onRequest", async (req) => {
      if (req.url.startsWith("/api/onboard/chat")) return;
      dispatched.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
        ip: req.ip,
      });
    });
    await app.register(apiGate);
    app.get("/api/test/whoami", async (req) => ({
      apiKeyId: req.apiKeyId ?? null,
      operatorId: req.operatorId ?? null,
      userId: req.userId ?? null,
    }));
    app.get("/api/capabilities/types", async () => ({ types: ["printing"] }));
    // At ac86a404 these registration handlers were ungated; here they just answer.
    for (const verb of ["approve", "reject", "activate", "prove"]) {
      app.post(`/api/onboard/registrations/:id/${verb}`, async () => ({ ok: true, verb, status: "active" }));
    }
    app.post("/api/onboard/registrations/:id/:step", async () => ({ ok: true }));
    app.delete("/api/onboard/registrations/:id", async () => ({ ok: true, status: "deleted" }));
    app.get("/api/onboard/registrations/:id", async (req) => ({ registration: { id: (req.params as { id: string }).id } }));
    app.get("/api/admin/waitlist", async () => ({ emails: ["someone@example.com"] }));
    app.get("/api/test/items/:id/details", async (req) => ({ id: (req.params as { id: string }).id }));
    app.get("/api/test/details", async () => ({ reached: "a route the template does not name" }));
    await app.register(onboardChatRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    _resetAgentPackageCache();
    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  const chat = (headers: Record<string, string> = {}, ip = "198.51.100.23") =>
    app.inject({ method: "POST", url: "/api/onboard/chat", payload: { message: "help me" }, headers, remoteAddress: ip });

  const dispatchedTo = (path: string) => dispatched.filter((d) => d.url.split("?")[0] === path);

  it("an anonymous chat cannot call an authenticated tool: refused before any request is made", async () => {
    llm.responses.push(calls(["whoami"]), endTurn);
    const post = await chat();
    expect(post.statusCode).toBe(200);
    const [trace] = post.json().toolCalls;
    expect(trace.status).toBe(401);
    expect(trace.result.error).toBe("sign_in_required");
    expect(dispatchedTo("/api/test/whoami")).toHaveLength(0);
  });

  it("an anonymous chat reaches a public tool with no credential, as the caller's own IP", async () => {
    llm.responses.push(calls(["capability_types"]), endTurn);
    const post = await chat({}, "203.0.113.7");
    expect(post.statusCode).toBe(200);
    expect(post.json().toolCalls[0]).toMatchObject({ status: 200, result: { types: ["printing"] } });
    const [req] = dispatchedTo("/api/capabilities/types");
    expect(req.authorization).toBeUndefined(); // no server-held key
    expect(req.cookie).toBeUndefined();
    expect(req.ip).toBe("203.0.113.7"); // per-IP limits see the caller, not 127.0.0.1
  });

  it("an API-key chat's tool call carries exactly that principal", async () => {
    const { rawKey, record } = provisionApiKey({ operatorId: "alice@example.com", scopes: ["operator"] });
    llm.responses.push(calls(["whoami"]), endTurn);
    const post = await chat({ authorization: `Bearer ${rawKey}` });
    expect(post.statusCode).toBe(200);
    expect(post.json().toolCalls[0]).toMatchObject({
      status: 200,
      result: { apiKeyId: record!.id, operatorId: "alice@example.com" },
    });
    const [req] = dispatchedTo("/api/test/whoami");
    expect(req.authorization).toBe(`Bearer ${rawKey}`);
    expect(post.body).not.toContain(rawKey); // the caller's own key is never echoed back
  });

  it("a SIWE-session chat (cookie or Bearer session token) runs its tools as that same session", async () => {
    const token = randomUUID();
    const now = Date.now();
    getRepos().sessions.insert({
      id: randomUUID(),
      walletAddress: WALLET,
      token,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      lastActiveAt: new Date(now).toISOString(),
    });

    llm.responses.push(calls(["whoami"]), endTurn);
    const viaCookie = await chat({ cookie: `pcc_session=${app.signCookie(token)}` });
    expect(viaCookie.statusCode).toBe(200);
    expect(viaCookie.json().toolCalls[0]).toMatchObject({ status: 200, result: { userId: WALLET } });

    llm.responses.push(calls(["whoami"]), endTurn);
    const viaBearer = await chat({ authorization: `Bearer ${token}` });
    expect(viaBearer.json().toolCalls[0]).toMatchObject({ status: 200, result: { userId: WALLET } });

    for (const req of dispatchedTo("/api/test/whoami")) {
      expect(req.authorization).toBe(`Bearer ${token}`);
      expect(req.cookie).toBeUndefined(); // no cookie jar is replayed
    }
  });

  it("approve / reject / activate / admin tools are refused anonymously and with a key, and never offered or requested", async () => {
    const { rawKey } = provisionApiKey({ operatorId: "bob@example.com", scopes: ["operator"] });
    for (const headers of [{}, { authorization: `Bearer ${rawKey}` }]) {
      llm.responses.push(
        calls(
          ["approve_registration", { registrationId: "reg-1" }],
          ["reject_registration", { registrationId: "reg-1" }],
          ["activate_registration", { registrationId: "reg-1" }],
          ["waitlist_export"],
        ),
        endTurn,
      );
      const post = await chat(headers);
      expect(post.statusCode).toBe(200);
      const traces = post.json().toolCalls as Array<{ name: string; status: number; result: { error: string } }>;
      expect(traces.map((t) => t.name)).toEqual(FORBIDDEN);
      for (const t of traces) {
        expect(t.status).toBe(403);
        expect(t.result.error).toBe("tool_not_callable_from_chat");
      }
    }
    expect(dispatched.filter((d) => /\/(approve|reject|activate)$|^\/api\/admin\//.test(d.url.split("?")[0]))).toEqual([]);
    // Never offered to the model either.
    for (const request of llm.requests) {
      const offered = (request.tools ?? []).map((t) => t.name);
      expect(offered).toContain("whoami");
      for (const name of FORBIDDEN) expect(offered).not.toContain(name);
    }
  });

  it("a presented credential that resolves to nobody is refused, never downgraded to anonymous", async () => {
    const bogus = await chat({ authorization: `Bearer pcc_live_${"0".repeat(64)}` });
    expect(bogus.statusCode).toBe(401);
    expect(bogus.json().error).toBe("invalid_credential");
    expect(llm.requests).toHaveLength(0);

    // A stale session cookie alone (the browser sends it by itself) leaves the chat anonymous.
    llm.responses.push(endTurn);
    const stale = await chat({ cookie: `pcc_session=${app.signCookie(randomUUID())}` });
    expect(stale.statusCode).toBe(200);
  });

  it("resolves exactly as apiGate does: an unusable header beside a valid session cookie runs as that session", async () => {
    const token = randomUUID();
    const now = Date.now();
    getRepos().sessions.insert({
      id: randomUUID(),
      walletAddress: WALLET,
      token,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      lastActiveAt: new Date(now).toISOString(),
    });
    llm.responses.push(calls(["whoami"]), endTurn);
    const post = await chat({
      authorization: `Bearer pcc_live_${"0".repeat(64)}`,
      cookie: `pcc_session=${app.signCookie(token)}`,
    });
    expect(post.statusCode).toBe(200);
    expect(post.json().toolCalls[0]).toMatchObject({ status: 200, result: { userId: WALLET, apiKeyId: null } });
    const [req] = dispatchedTo("/api/test/whoami");
    expect(req.authorization).toBe(`Bearer ${token}`); // only the resolved session travels
  });

  it("a path param cannot walk a template onto another route, and a non-/api endpoint is refused", async () => {
    const { rawKey } = provisionApiKey({ operatorId: "carol@example.com", scopes: ["operator"] });
    llm.responses.push(calls(["item_details", { id: ".." }], ["item_details", { id: "" }], ["generate_ui"]), endTurn);
    const post = await chat({ authorization: `Bearer ${rawKey}` });
    expect(post.statusCode).toBe(200);
    const [dotdot, empty, external] = post.json().toolCalls;
    expect(dotdot).toMatchObject({ status: 400, result: { error: "invalid_path_param" } });
    expect(empty).toMatchObject({ status: 400, result: { error: "invalid_path_param" } });
    expect(external).toMatchObject({ status: 403, result: { error: "tool_not_callable_from_chat" } });
    expect(dispatchedTo("/api/test/details")).toHaveLength(0);
    expect(dispatchedTo("/api/test/whoami")).toHaveLength(0);
    expect(dispatched.filter((d) => d.url.startsWith("/api/test/items/"))).toHaveLength(0);
  });

  // ── WP-D R3 ─────────────────────────────────────────────────────

  it("prove_registration and every registration-status tool are refused by name and by route, anonymously and with a key", async () => {
    const { rawKey } = provisionApiKey({ operatorId: "dave@example.com", scopes: ["operator"] });
    // The evidence the chat would have to invent: tier 0 accepts deviceHealth alone.
    const evidence = { deviceHealth: { status: "idle", model: "X" } };
    // Signed in first: that is where the pre-fix code ran prove_registration.
    for (const headers of [{ authorization: `Bearer ${rawKey}` }, {}]) {
      llm.responses.push(
        calls(
          ["prove_registration", { registrationId: "reg-1", evidence }],
          ["submit_registration_evidence", { registrationId: "reg-1", evidence }],
          ["remove_registration_record", { registrationId: "reg-1" }],
          ["registration_step", { registrationId: "reg-1", step: "prove" }],
          ["delete_registration"],
        ),
        endTurn,
      );
      const post = await chat(headers);
      expect(post.statusCode).toBe(200);
      const traces = post.json().toolCalls as Array<{ name: string; status: number; result: { error: string } }>;
      expect(traces.map((t) => t.name)).toEqual(REGISTRATION_STATUS);
      for (const t of traces) {
        expect(t.status, t.name).toBe(403);
        expect(t.result.error, t.name).toBe("tool_not_callable_from_chat");
      }
      expect(post.json().pendingActions).toBeUndefined(); // refused outright, never held for confirmation
    }
    // Nothing was requested: no registration write, and not the harmless route behind the status tool's name.
    expect(dispatched.filter((d) => d.url.startsWith("/api/onboard/registrations"))).toEqual([]);
    expect(dispatchedTo("/api/test/whoami")).toEqual([]);
    // Never offered to the model; a registration read still is.
    for (const request of llm.requests) {
      const offered = (request.tools ?? []).map((t) => t.name);
      expect(offered).toContain("get_registration");
      for (const name of REGISTRATION_STATUS) expect(offered).not.toContain(name);
    }
  });

  // ── WP-D R5 ─────────────────────────────────────────────────────

  const get = (id: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: `/api/onboard/chat/${id}`, headers });
  const resume = (id: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: "/api/onboard/chat", payload: { conversationId: id, message: "go on" }, headers });

  it("a signed-in conversation is bound to its principal: GET and resume by anyone else is 404", async () => {
    const alice = provisionApiKey({ operatorId: "alice@example.com", scopes: ["operator"] });
    const bob = provisionApiKey({ operatorId: "bob@example.com", scopes: ["operator"] });
    const asAlice = { authorization: `Bearer ${alice.rawKey}` };
    llm.responses.push(calls(["whoami"]), endTurn);
    const post = await chat(asAlice);
    expect(post.statusCode).toBe(200);
    const id = post.json().conversationId as string;

    // The history now holds what Alice's credential read. Nobody else can read it or continue it.
    for (const headers of [{}, { authorization: `Bearer ${bob.rawKey}` }]) {
      const res = await get(id, headers);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(alice.record!.id);
      const before = llm.requests.length;
      const cont = await resume(id, headers);
      expect(cont.statusCode).toBe(404);
      expect(cont.json().error).toBe("conversation_not_found");
      expect(llm.requests).toHaveLength(before);
    }

    const own = await get(id, asAlice);
    expect(own.statusCode).toBe(200);
    expect(own.body).toContain(alice.record!.id);
    llm.responses.push(endTurn);
    expect((await resume(id, asAlice)).statusCode).toBe(200);
  });

  it("a session's conversation belongs to that wallet session, not to an API key", async () => {
    const token = randomUUID();
    const now = Date.now();
    getRepos().sessions.insert({
      id: randomUUID(),
      walletAddress: WALLET,
      token,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      lastActiveAt: new Date(now).toISOString(),
    });
    const { rawKey } = provisionApiKey({ operatorId: WALLET, scopes: ["operator"] });
    llm.responses.push(endTurn);
    const post = await chat({ cookie: `pcc_session=${app.signCookie(token)}` });
    const id = post.json().conversationId as string;
    expect((await get(id, { authorization: `Bearer ${rawKey}` })).statusCode).toBe(404);
    expect((await get(id)).statusCode).toBe(404);
    expect((await get(id, { authorization: `Bearer ${token}` })).statusCode).toBe(200);
    expect((await get(id, { cookie: `pcc_session=${app.signCookie(token)}` })).statusCode).toBe(200);
  });

  it("a signed-in caller continuing an anonymous conversation gets a fork of their own; the anonymous one is never claimed (L6)", async () => {
    const carol = provisionApiKey({ operatorId: "carol@example.com", scopes: ["operator"] });
    const erin = provisionApiKey({ operatorId: "erin@example.com", scopes: ["operator"] });
    const asCarol = { authorization: `Bearer ${carol.rawKey}` };
    llm.responses.push(endTurn);
    const id = (await chat()).json().conversationId as string;
    expect((await get(id)).statusCode).toBe(200); // the id is the capability
    expect((await get(id, asCarol)).statusCode).toBe(200);

    llm.responses.push(calls(["whoami"]), endTurn);
    const cont = await resume(id, asCarol);
    expect(cont.statusCode).toBe(200);
    const fork = cont.json();
    expect(fork.forkedFrom).toBe(id);
    expect(fork.conversationId).not.toBe(id);
    // Not claimed: the anonymous creator still opens it by its id, and Carol's
    // authenticated read never entered it.
    const anon = await get(id);
    expect(anon.statusCode).toBe(200);
    expect(anon.body).not.toContain(carol.record!.id);
    // Carol's read lives in her fork, which only she can open.
    expect((await get(fork.conversationId)).statusCode).toBe(404);
    expect((await get(fork.conversationId, { authorization: `Bearer ${erin.rawKey}` })).statusCode).toBe(404);
    const own = await get(fork.conversationId, asCarol);
    expect(own.statusCode).toBe(200);
    expect(own.body).toContain(carol.record!.id);
  });
});
