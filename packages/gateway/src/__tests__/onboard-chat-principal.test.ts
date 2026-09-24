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
  ],
};
const FORBIDDEN = ["approve_registration", "reject_registration", "activate_registration", "waitlist_export"];

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
    for (const verb of ["approve", "reject", "activate"]) {
      app.post(`/api/onboard/registrations/:id/${verb}`, async () => ({ ok: true, verb }));
    }
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
    const { rawKey, record } = provisionApiKey({ operatorId: "alice@example.com" });
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
    const { rawKey } = provisionApiKey({ operatorId: "bob@example.com" });
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
    const { rawKey } = provisionApiKey({ operatorId: "carol@example.com" });
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
});
