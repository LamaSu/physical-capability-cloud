import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "@pcc/store";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { apiGate } from "../middleware/api-gate.js";
import { __resetScopeCacheForTests, scopeChecker } from "../middleware/scope-checker.js";
import {
  __resetOnboardChatForTest,
  ONBOARD_CHAT_GLOBAL_LIMIT as L,
  ONBOARD_CHAT_GLOBAL_WINDOW_MS,
} from "../middleware/security-hardening.js";
import { onboardChatRoutes, _resetAgentPackageCache, _resetAnthropicCache } from "../routes/onboard-chat.js";

const sdk = vi.hoisted(() => ({ create: vi.fn(), unavailable: false }));
const cryptoState = vi.hoisted(() => ({ bytes16: undefined as Buffer | undefined }));
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return {
    ...original,
    randomBytes: (...args: any[]) => {
      if (args[0] === 16 && args.length === 1 && cryptoState.bytes16) return Buffer.from(cryptoState.bytes16);
      return (original.randomBytes as (...args: any[]) => unknown)(...args);
    },
  };
});
vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    constructor() { if (sdk.unavailable) throw new Error("SDK unavailable for this cell"); }
    messages = { create: sdk.create };
  },
}));
vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../services/audit-service.js", () => ({
  auditService: { log: vi.fn(), query: vi.fn().mockReturnValue([]), stats: vi.fn().mockReturnValue([]) },
}));
vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn(), getTimeline: vi.fn().mockReturnValue([]), getStats: vi.fn().mockReturnValue({}) },
}));

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
type PackTool = { name: string; input_schema?: Record<string, unknown>; endpoint?: { method: string; path: string } };
const pack = JSON.parse(readFileSync(`${REPO}/apps/dashboard/public/agent-package.json`, "utf8")) as { tools: PackTool[] };
const CHAT = "/api/onboard/chat";
const SECRET = "synthetic-chat-gates-admin-secret";
const MISSING = `cnv_${"f".repeat(32)}`;
const MODEL_REFUSAL = { error: "model_not_allowed", message: "The onboarding chat chooses its own model." };
const RATE_REFUSAL = {
  error: "rate_limited",
  message: "Too many chat messages from this address. Try again in a few minutes.",
  retry_after_seconds: 600,
};
const BUSY = {
  error: "chat_busy",
  message: "The onboarding chat is busy right now. Try again later.",
  retry_after_seconds: ONBOARD_CHAT_GLOBAL_WINDOW_MS / 1000,
};
const endTurn = () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Ready to help." }] });
const toolTurn = (name: string, input: Record<string, unknown>, id = "tool_gate_1") => ({
  stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }],
});
const keyPath = (path: string) => path === "/api/auth" || path.startsWith("/api/auth/");
const toolNamed = (name: string) => {
  const tool = pack.tools.find(t => t.name === name);
  if (!tool?.endpoint) throw new Error(`Real pack tool ${name} has no endpoint`);
  return tool as PackTool & { endpoint: { method: string; path: string } };
};
function rowCount(): number {
  return (getStore().db.get(sql`SELECT count(*) AS n FROM onboard_chat_conversations`) as { n: number }).n;
}
function stored(id: string) {
  return getStore().db.get(sql`SELECT * FROM onboard_chat_conversations WHERE id = ${id}`);
}
const twoTurns = [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" }];
function insertConversation(id: string, messages: unknown[] = twoTurns) {
  const now = "2026-01-01T00:00:00.000Z";
  getStore().db.run(sql`INSERT INTO onboard_chat_conversations (id, messages, created_at, updated_at)
    VALUES (${id}, ${JSON.stringify(messages)}, ${now}, ${now})`);
}
function resetChat() {
  _resetAnthropicCache();
  _resetAgentPackageCache();
  sdk.create.mockReset().mockImplementation(async () => endTurn());
  sdk.unavailable = false;
}

// No proxies are trusted: inject's remoteAddress is exactly the req.ip the limiter sees.
describe("onboarding chat gates with a bare gateway", () => {
  let app: FastifyInstance;
  let urls: string[];
  beforeEach(async () => {
    __resetOnboardChatForTest();
    vi.stubEnv("PCC_DB_PATH", ":memory:");
    vi.stubEnv("DATABASE_URL", ":memory:");
    vi.stubEnv("ANTHROPIC_API_KEY", "fake-sdk-key-no-network");
    resetChat();
    closeStore();
    initStore({ seed: false });
    app = Fastify({ logger: false });
    urls = [];
    app.addHook("onRequest", async req => { urls.push(req.url); });
    for (const name of ["provision_api_key", "list_api_keys", "revoke_api_key", "setup_detect", "check_invite", "get_token_allowance"]) {
      const tool = toolNamed(name);
      app.route({
        method: tool.endpoint.method as "GET" | "POST" | "DELETE",
        url: tool.endpoint.path.replace(/\{([^}]+)\}/g, ":$1"),
        handler: async req => ({ params: req.params, query: req.query, body: req.body ?? null }),
      });
    }
    await app.register(onboardChatRoutes);
    await app.ready();
  });
  afterEach(async () => {
    await app?.close();
    closeStore();
    _resetAnthropicCache();
    _resetAgentPackageCache();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  const injected = () => urls.filter(url => url !== CHAT);
  const post = (payload: Record<string, unknown> = { message: "Help me onboard." }, remoteAddress = "198.51.100.1") =>
    app.inject({ method: "POST", url: CHAT, payload, remoteAddress });
  // At most ten messages per address, leaving E out of the global-budget cells.
  const budgetPost = (index: number, payload?: Record<string, unknown>) =>
    post(payload, `203.0.113.${Math.floor(index / 10) + 1}`);
  const nextPost = () => post({ message: "Next message." }, "203.0.113.250");

  it("K1 the chat neither offers nor runs a tool under /api/auth/", async () => {
    const eligible = pack.tools.filter(t => t.name && t.input_schema);
    const excluded = eligible.filter(t => keyPath(t.endpoint?.path ?? "")).map(t => t.name);
    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded).toEqual(expect.arrayContaining(["provision_api_key", "list_api_keys", "revoke_api_key"]));
    const expected = eligible.filter(t => !keyPath(t.endpoint?.path ?? "")).map(t => t.name);
    const names = ["provision_api_key", "list_api_keys", "revoke_api_key", "setup_detect"];
    sdk.create.mockResolvedValueOnce({
      stop_reason: "tool_use",
      content: names.map((name, i) => ({ type: "tool_use", name, id: `key_gate_${i}`, input: name === "revoke_api_key" ? { keyId: "test-key" } : {} })),
    });
    const res = await post();
    expect(res.statusCode, res.body).toBe(200);
    expect(sdk.create.mock.calls[0][0].tools.map((t: PackTool) => t.name)).toEqual(expected);
    expect(res.json().toolCalls.map((t: { name: string }) => t.name)).toEqual(names);
    for (const call of res.json().toolCalls.slice(0, 3)) {
      expect(call.status).toBe(404);
      expect(call.result).toStrictEqual({ error: "unknown_tool", name: call.name });
    }
    expect(res.json().toolCalls[3].status).toBe(200);
    expect(injected()).toEqual(["/api/setup/detect"]);
    expect(urls.some(url => keyPath(new URL(url, "http://test.invalid").pathname))).toBe(false);
  });

  it("K1d-1 a path parameter stays one segment", async () => {
    sdk.create.mockResolvedValueOnce(toolTurn("check_invite", { code: "../../auth/keys" }));
    const res = await post();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().toolCalls[0].status).toBe(200);
    expect(injected()).toEqual(["/api/onboard/check/..%2F..%2Fauth%2Fkeys"]);
    expect(res.json().toolCalls[0].result.params).toEqual({ code: "../../auth/keys" });
    expect(urls.some(url => keyPath(new URL(url, "http://test.invalid").pathname))).toBe(false);
  });

  it.each([
    { code: "." }, { code: ".." }, { code: "" }, { code: null }, {}, { code: [".."] },
  ])("K1d-2 a missing, null, empty, . or .. path parameter is refused before any call (%j)", async input => {
    let secondRequest: { messages: { content: unknown }[] } | undefined;
    sdk.create.mockResolvedValueOnce(toolTurn("check_invite", input)).mockImplementationOnce(async request => {
      secondRequest = structuredClone(request);
      return endTurn();
    });
    const res = await post();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().toolCalls[0].status).toBe(400);
    expect(res.json().toolCalls[0].result).toStrictEqual({ error: "invalid_path_param", param: "code" });
    expect(injected()).toEqual([]);
    expect(secondRequest?.messages.some(message => Array.isArray(message.content) && message.content.some(block =>
      block.type === "tool_result" && block.tool_use_id === "tool_gate_1"
      && JSON.parse(block.content).error === "invalid_path_param"))).toBe(true);
  });

  it("K1d-3 path parameters refuse the first invalid segment in template order", async () => {
    for (const [input, param] of [
      [{ tokenAddress: "..", owner: ".", spender: "" }, "tokenAddress"],
      [{ tokenAddress: "token", owner: "..", spender: "." }, "owner"],
      [{ tokenAddress: "token", owner: "owner", spender: [".."] }, "spender"],
      [{ tokenAddress: "..", owner: { toString: "not callable" }, spender: "spender" }, "tokenAddress"],
    ] as const) {
      sdk.create.mockResolvedValueOnce(toolTurn("get_token_allowance", input));
      const res = await post();
      expect(res.json().toolCalls[0]).toMatchObject({ status: 400, result: { error: "invalid_path_param", param } });
      expect(injected()).toEqual([]);
    }
  });

  it("K3 conversation ids are cnv_ plus 32 lowercase hex, and only that shape continues", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await post();
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().conversationId).toMatch(/^cnv_[0-9a-f]{32}$/);
      ids.push(res.json().conversationId);
    }
    expect(ids[0]).not.toBe(ids[1]);
    const control = `cnv_${"1a".repeat(16)}`;
    const invalidIds = [
      `cnv_${Date.now().toString(36)}_abcdef`, `cnv_${"a".repeat(31)}`, `cnv_${"a".repeat(33)}`,
      `cnv_${"AB".repeat(16)}`, `xcnv_${"a".repeat(32)}`,
    ];
    for (const id of [control, ...invalidIds]) insertConversation(id);
    sdk.create.mockClear();
    const good = await post({ message: "Continue", conversationId: control });
    expect(good.statusCode, good.body).toBe(200);
    expect(good.json().conversationId).toBe(control);
    expect(sdk.create).toHaveBeenCalledTimes(1);
    for (const conversationId of [...invalidIds, true, 123, [control], { id: control }, `${control}\n`]) {
      const before = typeof conversationId === "string" ? stored(conversationId) : undefined;
      sdk.create.mockClear();
      const reads = vi.spyOn(getStore().db, "all");
      const writes = vi.spyOn(getStore().db, "run");
      const res = await post({ message: "Continue", conversationId });
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json()).toStrictEqual({ error: "conversation_not_found" });
      expect(reads).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      reads.mockRestore();
      writes.mockRestore();
      expect(sdk.create).not.toHaveBeenCalled();
      if (typeof conversationId === "string") expect(stored(conversationId)).toStrictEqual(before);
    }
    for (const conversationId of ["", null, false, 0]) {
      const res = await post({ message: "New conversation", conversationId });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().conversationId).toMatch(/^cnv_[0-9a-f]{32}$/);
    }
  });

  it("K3b the conversation id comes from 16 random bytes", async () => {
    cryptoState.bytes16 = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
    try {
      const res = await post();
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().conversationId).toBe("cnv_000102030405060708090a0b0c0d0e0f");
    } finally {
      cryptoState.bytes16 = undefined;
    }
  });

  it("K4 a model field is refused before any read, write or model call", async () => {
    const health = await app.inject({ url: `${CHAT}/health` });
    const model = health.json().model;
    for (const value of ["claude-opus-4-1", model, "", null]) {
      const count = rowCount();
      const reads = vi.spyOn(getStore().db, "all");
      const writes = vi.spyOn(getStore().db, "run");
      const res = await post({ message: "Help", model: value });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toStrictEqual(MODEL_REFUSAL);
      expect(reads).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      reads.mockRestore();
      writes.mockRestore();
      expect(rowCount()).toBe(count);
      expect(sdk.create).not.toHaveBeenCalled();
    }
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const count = rowCount();
    const placeholder = await post({ message: "Help", model: "claude-opus-4-1" });
    expect(placeholder.statusCode).toBe(400);
    expect(placeholder.json()).toStrictEqual(MODEL_REFUSAL);
    expect(rowCount()).toBe(count);
    expect(sdk.create).not.toHaveBeenCalled();
    vi.stubEnv("ANTHROPIC_API_KEY", "fake-sdk-key-no-network");
    const control = `cnv_${"2a".repeat(16)}`;
    insertConversation(control);
    const reads = vi.spyOn(getStore().db, "all");
    const writes = vi.spyOn(getStore().db, "run");
    const continued = await post({ message: "Help", model, conversationId: control });
    expect(continued.statusCode).toBe(400);
    expect(continued.json()).toStrictEqual(MODEL_REFUSAL);
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    reads.mockRestore();
    writes.mockRestore();
    expect(sdk.create).not.toHaveBeenCalled();
    const res = await post({ message: "Help", max_tokens: 1, system: "client", tools: [], messages: [], extra: "client" });
    expect(res.statusCode, res.body).toBe(200);
    expect(sdk.create.mock.calls[0][0].model).toBe(model);
    expect(sdk.create.mock.calls[0][0].max_tokens).toBe(4096);
    expect(sdk.create.mock.calls[0][0].system).not.toBe("client");
    expect(sdk.create.mock.calls[0][0].tools.length).toBeGreaterThan(0);
    expect(sdk.create.mock.calls[0][0].messages[0]).toEqual({ role: "user", content: "Help" });
    expect(sdk.create.mock.calls[0][0]).not.toHaveProperty("extra");
  });

  it("K4b a model field is refused even for an unknown conversation id", async () => {
    const reads = vi.spyOn(getStore().db, "all");
    const writes = vi.spyOn(getStore().db, "run");
    const res = await post({ message: "Help", model: "claude-opus-4-1", conversationId: MISSING });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toStrictEqual(MODEL_REFUSAL);
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("K5 each address gets 20 messages per 10 minutes", async () => {
    for (let i = 0; i < 20; i++) expect((await post(undefined, "198.51.100.10")).statusCode).toBe(200);
    const reads = vi.spyOn(getStore().db, "all");
    const writes = vi.spyOn(getStore().db, "run");
    const blocked = await post(undefined, "198.51.100.10");
    expect(blocked.statusCode, blocked.body).toBe(429);
    expect(blocked.json()).toStrictEqual(RATE_REFUSAL);
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    reads.mockRestore();
    writes.mockRestore();
    expect(sdk.create).toHaveBeenCalledTimes(20);
    expect(rowCount()).toBe(20);
    expect((await post(undefined, "198.51.100.11")).statusCode).toBe(200);
    expect(sdk.create).toHaveBeenCalledTimes(21);
    expect(rowCount()).toBe(21);
  });

  it("K5b every POST counts toward the limit", async () => {
    for (let i = 0; i < 20; i++) {
      const res = await post({ message: "" }, "198.51.100.12");
      expect(res.statusCode).toBe(400);
      expect(res.json()).toStrictEqual({ error: "message_required" });
    }
    const res = await post(undefined, "198.51.100.12");
    expect(res.statusCode).toBe(429);
    expect(res.json()).toStrictEqual(RATE_REFUSAL);
    // E must precede message, model and id validation, even once the window is full.
    for (const payload of [{ message: "" }, { message: "x".repeat(8_001) }, { message: "Help", model: null }, { message: "Help", conversationId: "old" }]) {
      const refused = await post(payload, "198.51.100.12");
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toStrictEqual(RATE_REFUSAL);
    }
    expect(sdk.create).not.toHaveBeenCalled();
    expect(rowCount()).toBe(0);
  });

  it("K5c the window reopens after 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    vi.setSystemTime(start);
    for (let i = 0; i < 20; i++) expect((await post(undefined, "198.51.100.13")).statusCode).toBe(200);
    expect((await post(undefined, "198.51.100.13")).statusCode).toBe(429);
    vi.setSystemTime(start + 600_000);
    expect((await post(undefined, "198.51.100.13")).statusCode).toBe(429);
    vi.setSystemTime(start + 600_001);
    expect((await post(undefined, "198.51.100.13")).statusCode).toBe(200);
  });

  it("K5d past the process-wide budget every address gets 429, with no model call or write", async () => {
    expect(L).toBeGreaterThan(21);
    for (let i = 0; i < L; i++) expect((await budgetPost(i)).statusCode).toBe(200);
    expect(sdk.create).toHaveBeenCalledTimes(L);
    expect(rowCount()).toBe(L);
    const writes = vi.spyOn(getStore().db, "run");
    const res = await nextPost();
    expect(res.statusCode, res.body).toBe(429);
    expect(res.json()).toStrictEqual(BUSY);
    expect(writes).not.toHaveBeenCalled();
    expect(sdk.create).toHaveBeenCalledTimes(L);
    expect(rowCount()).toBe(L);
    expect(injected()).toEqual([]);
  });

  it("K5e refused and placeholder-mode POSTs do not count toward the budget", async () => {
    const fullId = `cnv_${"b".repeat(32)}`;
    insertConversation(fullId, Array.from({ length: 80 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "Turn" })));
    const refused = [
      [{ message: "" }, 400, { error: "message_required" }],
      [{ message: "Help", model: "claude-opus-4-1" }, 400, MODEL_REFUSAL],
      [{ message: "Help", conversationId: "cnv_old_abcdef" }, 404, { error: "conversation_not_found" }],
      [{ message: "Help", conversationId: MISSING }, 404, { error: "conversation_not_found" }],
      [{ message: "Help", conversationId: fullId }, 400, { error: "conversation_too_long", message: "Start a new conversation — this one has 80+ turns." }],
    ] as const;
    for (let i = 0; i < refused.length; i++) {
      const [payload, status, body] = refused[i];
      const res = await post(payload, `198.51.100.${30 + i}`);
      expect(res.statusCode, res.body).toBe(status);
      expect(res.json()).toStrictEqual(body);
    }
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    for (let i = 0; i < 3; i++) {
      const res = await post(undefined, `198.51.100.${40 + i}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().needsApiKey).toBe(true);
    }
    expect(sdk.create).not.toHaveBeenCalled();
    vi.stubEnv("ANTHROPIC_API_KEY", "fake-sdk-key-no-network");
    // E2 must be after the client check: a failed constructor spends no budget.
    sdk.unavailable = true;
    const unavailable = await post(undefined, "198.51.100.50");
    expect(unavailable.statusCode).toBe(500);
    expect(unavailable.json().error).toBe("anthropic_sdk_unavailable");
    expect(sdk.create).not.toHaveBeenCalled();
    sdk.unavailable = false;
    for (let i = 0; i < L; i++) expect((await budgetPost(i)).statusCode).toBe(200);
    expect(sdk.create).toHaveBeenCalledTimes(L);
    const res = await nextPost();
    expect(res.statusCode).toBe(429);
    expect(res.json()).toStrictEqual(BUSY);
  });

  it("K5f the budget reopens after its window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    vi.setSystemTime(start);
    for (let i = 0; i < L; i++) expect((await budgetPost(i)).statusCode).toBe(200);
    const blocked = await nextPost();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toStrictEqual(BUSY);
    vi.setSystemTime(start + ONBOARD_CHAT_GLOBAL_WINDOW_MS);
    expect((await post(undefined, "203.0.113.249")).statusCode).toBe(429);
    vi.setSystemTime(start + ONBOARD_CHAT_GLOBAL_WINDOW_MS + 1);
    expect((await post(undefined, "203.0.113.248")).statusCode).toBe(200);
    expect(sdk.create).toHaveBeenCalledTimes(L + 1);
  });

  it("K5g a message counts once toward the budget, however many model calls it makes", async () => {
    expect(pack.tools.some(t => t.name === "not_a_pack_tool_chat_gate")).toBe(false);
    sdk.create.mockImplementation(async () => sdk.create.mock.calls.length % 2
      ? toolTurn("not_a_pack_tool_chat_gate", {}) : endTurn());
    for (let i = 0; i < L; i++) expect((await budgetPost(i)).statusCode).toBe(200);
    expect(sdk.create).toHaveBeenCalledTimes(2 * L);
    const res = await nextPost();
    expect(res.statusCode).toBe(429);
    expect(res.json()).toStrictEqual(BUSY);
    expect(sdk.create).toHaveBeenCalledTimes(2 * L);
    expect(rowCount()).toBe(L);
    expect(injected()).toEqual([]);
  });
});

describe("onboarding transcript gate through authentication and scopes", () => {
  let app: FastifyInstance;
  let id: string;
  let callers: Array<{ name: string; headers: Record<string, string>; status: number }>;
  beforeEach(async () => {
    __resetOnboardChatForTest();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PCC_DB_PATH", ":memory:");
    vi.stubEnv("PCC_SEED_DATA", "false");
    vi.stubEnv("PCC_ADMIN_KEY", SECRET);
    vi.stubEnv("TENANT_ENFORCE", "");
    delete process.env.TENANT_ENFORCE;
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    resetChat();
    closeStore();
    initStore({ seed: false });
    __resetScopeCacheForTests();
    app = Fastify({ logger: false });
    app.decorateRequest("userId", null);
    app.decorateRequest("apiKeyId", null);
    app.decorateRequest("operatorId", null);
    await app.register(cookie, { secret: "synthetic-chat-gates-cookie-secret" });
    await app.register(apiGate);
    await app.register(scopeChecker);
    await app.register(onboardChatRoutes);
    await app.ready();
    const key = (scopes: string[]) => ({ authorization: `Bearer ${provisionApiKey({ operatorId: `chat-gate-${scopes.join("-")}`, scopes }).rawKey}` });
    const basic = key(["operator:basic"]);
    const star = key(["*"]);
    const admin = key(["admin"]);
    const token = "synthetic-chat-gates-wallet-session";
    const now = new Date().toISOString();
    getRepos().sessions.insert({ id: token, token, walletAddress: "0xaabbccddeeff00112233445566778899aabbccdd",
      createdAt: now, lastActiveAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    callers = [
      { name: "no credential", headers: {}, status: 401 },
      { name: "admin secret alone", headers: { "x-admin-key": SECRET }, status: 401 },
      { name: "operator:basic key", headers: basic, status: 404 },
      { name: "star key", headers: star, status: 404 },
      { name: "wallet session bearer", headers: { authorization: `Bearer ${token}` }, status: 404 },
      { name: "wallet session cookie", headers: { cookie: `pcc_session=${app.signCookie(token)}` }, status: 404 },
      { name: "admin scope key", headers: admin, status: 200 },
      { name: "basic key plus admin secret", headers: { ...basic, "x-admin-key": SECRET }, status: 200 },
    ];
    const res = await app.inject({ method: "POST", url: CHAT, payload: { message: "Stored question" } });
    expect(res.statusCode, res.body).toBe(200);
    id = res.json().conversationId;
  });
  afterEach(async () => {
    await app?.close();
    closeStore();
    __resetScopeCacheForTests();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])("K2-1 a transcript read answers only an onboarding admin (caller %i)", async index => {
    const caller = callers[index];
    const reads = vi.spyOn(getStore().db, "all");
    const res = await app.inject({ url: `${CHAT}/${id}`, headers: caller.headers });
    expect(res.statusCode, `${caller.name}: ${res.body}`).toBe(caller.status);
    if (index < 2) expect(res.json().error).toBe("api_key_required");
    else if (index < 6) expect(res.json()).toStrictEqual({ error: "not_found" });
    else {
      expect(res.json().conversationId).toBe(id);
      expect(res.json().messages).toEqual(JSON.parse((stored(id) as { messages: string }).messages));
      expect(res.json().messages).toHaveLength(2);
    }
    if (index < 6) expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    const head = await app.inject({ method: "HEAD", url: `${CHAT}/${id}` });
    expect(head.statusCode).toBe(401);
  });

  it("K2-2 for anyone but an admin, a stored id and a missing id get the same reply", async () => {
    for (const caller of callers.slice(0, 6)) {
      const found = await app.inject({ url: `${CHAT}/${id}`, headers: caller.headers });
      const missing = await app.inject({ url: `${CHAT}/${MISSING}`, headers: caller.headers });
      expect(found.statusCode, caller.name).toBe(caller.status);
      expect(missing.statusCode, caller.name).toBe(found.statusCode);
      expect(missing.body, caller.name).toBe(found.body);
    }
  });

  it("K2-3 an admin gets 404 for a missing id", async () => {
    for (const caller of callers.slice(6)) {
      const res = await app.inject({ url: `${CHAT}/${MISSING}`, headers: caller.headers });
      expect(res.statusCode, caller.name).toBe(404);
      expect(res.json()).toStrictEqual({ error: "not_found" });
    }
  });

  it("K2-4 health stays public", async () => {
    for (const method of ["GET", "HEAD"] as const) {
      const res = await app.inject({ method, url: `${CHAT}/health` });
      expect(res.statusCode, res.body).toBe(200);
    }
  });
});
