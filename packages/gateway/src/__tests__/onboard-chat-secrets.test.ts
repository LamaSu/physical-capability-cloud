/**
 * Negative tests for the onboard-chat secret exposure fix (bus #2288, board N9).
 *
 * The public /api/onboard/chat surface runs agent-package tools anonymously. A
 * tool such as provision_api_key returns a live key, and before this fix the
 * raw tool result was pushed into the history, sent back to the model,
 * persisted, and replayed by the public GET /api/onboard/chat/:id behind a
 * guessable id. These tests pin the fixed behavior:
 *   - a secret from a tool result never reaches the DB, the model or GET;
 *   - it reaches the caller exactly once, in that POST's revealedSecrets;
 *   - nested secret fields and secret-shaped substrings are both caught;
 *   - error bodies (tool errors, LLM errors) are redacted too;
 *   - ids are 128-bit CSPRNG ids and legacy guessable ids are refused.
 *
 * The Anthropic SDK is replaced by a scripted client that records every request.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "@pcc/store";

const llm = vi.hoisted(() => ({
  requests: [] as unknown[],
  responses: [] as unknown[],
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async (args: unknown) => {
        llm.requests.push(JSON.parse(JSON.stringify(args)));
        const next = llm.responses.shift();
        if (next instanceof Error) throw next;
        return next ?? { content: [{ type: "text", text: "All set." }], stop_reason: "end_turn" };
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
  generateConversationId,
  _resetAnthropicCache,
  _resetAgentPackageCache,
  _setAgentPackageForTests,
} from "../routes/onboard-chat.js";
import { redactSecretsDeep, REDACTED_VALUE, type Redaction } from "../redaction.js";
import { initStore, closeStore, getStore } from "../db.js";

// ── Fixtures ────────────────────────────────────────────────────────

const LIVE_KEY = "pcc_live_" + "Q7xR2m".repeat(6) + "_k9";
const PRIVATE_KEY = "0x" + "ab12cd34".repeat(8);
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvci0xIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU";
const PUBLIC_ADDRESS = "0x" + "1234abcd".repeat(5);

const PKG = {
  system_prompt: "test system prompt",
  tools: [
    {
      name: "provision_api_key",
      description: "mint a key",
      input_schema: { type: "object", properties: { email: { type: "string" } } },
      endpoint: { method: "POST", path: "/api/auth/provision" },
    },
    {
      name: "nested_secret",
      description: "returns a nested secret",
      input_schema: { type: "object", properties: {} },
      endpoint: { method: "GET", path: "/api/test/nested" },
    },
    {
      name: "boom",
      description: "fails and echoes a key",
      input_schema: { type: "object", properties: {} },
      endpoint: { method: "POST", path: "/api/test/boom" },
    },
  ],
};

const toolTurn = (name: string, id: string, input: Record<string, unknown> = {}) => ({
  content: [{ type: "tool_use", id, name, input }],
  stop_reason: "tool_use",
});
const endTurn = { content: [{ type: "text", text: "All set." }], stop_reason: "end_turn" };

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  // Stand-ins for the real routes the agent-package tools point at.
  app.post("/api/auth/provision", async (_req, reply) =>
    reply.code(201).send({
      api_key: LIVE_KEY,
      key_id: "key-1",
      operator_id: "op@example.com",
      scopes: ["*"],
      usage: {
        header: `Authorization: Bearer ${LIVE_KEY}`,
        example: `curl -H "Authorization: Bearer ${LIVE_KEY}" https://capability.network/api/capabilities/types`,
      },
    }),
  );
  app.get("/api/test/nested", async () => ({
    a: { b: { privateKey: PRIVATE_KEY } },
    note: `use Bearer ${JWT} for the next call`,
    wallet: PUBLIC_ADDRESS,
  }));
  app.post("/api/test/boom", async (_req, reply) =>
    reply.code(500).send({ error: "upstream_failed", message: `upstream rejected key ${LIVE_KEY}` }),
  );
  await app.register(onboardChatRoutes);
  await app.ready();
  return app;
}

function persistedMessages(id: string): string {
  const rows = getStore().db.all(
    sql`SELECT messages FROM onboard_chat_conversations WHERE id = ${id}`,
  ) as Array<{ messages: string }>;
  return rows.map((r) => r.messages).join("\n");
}

function insertRow(id: string, messages: unknown[]): void {
  const now = new Date().toISOString();
  getStore().db.run(sql`INSERT INTO onboard_chat_conversations (id, messages, created_at, updated_at)
                        VALUES (${id}, ${JSON.stringify(messages)}, ${now}, ${now})`);
}

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

// ── Route behavior ──────────────────────────────────────────────────

describe("onboard-chat secret exposure (N9)", () => {
  let app: FastifyInstance;
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    llm.requests.length = 0;
    llm.responses.length = 0;
    _resetAnthropicCache();
    _resetAgentPackageCache();
    _setAgentPackageForTests(PKG);
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    _resetAgentPackageCache();
    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  it("a provisioned key never reaches the DB, the model or GET, and is revealed exactly once", async () => {
    llm.responses.push(toolTurn("provision_api_key", "tu_1", { email: "op@example.com" }), endTurn);
    const post = await app.inject({ method: "POST", url: "/api/onboard/chat", payload: { message: "sign me up" } });
    expect(post.statusCode).toBe(200);
    const body = post.json();

    // Exactly once in the whole POST reply, and that once is the reveal.
    expect(count(post.body, LIVE_KEY)).toBe(1);
    const reveals = (body.revealedSecrets as Array<{ tool: string; value: string }>).filter((s) => s.value === LIVE_KEY);
    expect(reveals).toHaveLength(1);
    expect(reveals[0].tool).toBe("provision_api_key");
    expect(JSON.stringify(body.toolCalls)).not.toContain(LIVE_KEY);

    // Never sent to the model; the model is told the user saw it once.
    expect(llm.requests).toHaveLength(2);
    expect(JSON.stringify(llm.requests)).not.toContain(LIVE_KEY);
    expect(JSON.stringify(llm.requests[1])).toContain("shown to the user once");

    // Never persisted, never replayed.
    expect(persistedMessages(body.conversationId)).not.toContain(LIVE_KEY);
    const get = await app.inject({ method: "GET", url: `/api/onboard/chat/${body.conversationId}` });
    expect(get.statusCode).toBe(200);
    expect(get.body).not.toContain(LIVE_KEY);
    expect(get.body).not.toContain("revealedSecrets");

    // The reveal is one-time: the next turn in the same conversation does not repeat it.
    const next = await app.inject({
      method: "POST",
      url: "/api/onboard/chat",
      payload: { conversationId: body.conversationId, message: "what now?" },
    });
    expect(next.statusCode).toBe(200);
    expect(next.body).not.toContain(LIVE_KEY);
    expect(next.json().revealedSecrets).toBeUndefined();
    expect(JSON.stringify(llm.requests)).not.toContain(LIVE_KEY);
  });

  it("a nested secret field and a string-embedded Bearer JWT are redacted end to end", async () => {
    llm.responses.push(toolTurn("nested_secret", "tu_2"), endTurn);
    const post = await app.inject({ method: "POST", url: "/api/onboard/chat", payload: { message: "check" } });
    expect(post.statusCode).toBe(200);
    const body = post.json();

    for (const secret of [PRIVATE_KEY, JWT]) {
      expect(count(post.body, secret)).toBe(1); // the reveal only
      expect(JSON.stringify(llm.requests)).not.toContain(secret);
      expect(persistedMessages(body.conversationId)).not.toContain(secret);
    }
    const traced = body.toolCalls[0].result;
    expect(traced.a.b.privateKey).toBe(REDACTED_VALUE);
    expect(traced.note).toContain("Bearer [redacted]");
    // A public 40-hex wallet address is not a secret and survives.
    expect(traced.wallet).toBe(PUBLIC_ADDRESS);
  });

  it("an error-path tool result that echoes a key is redacted", async () => {
    llm.responses.push(toolTurn("boom", "tu_3"), endTurn);
    const post = await app.inject({ method: "POST", url: "/api/onboard/chat", payload: { message: "try it" } });
    expect(post.statusCode).toBe(200);
    const body = post.json();
    expect(body.toolCalls[0].status).toBe(500);
    expect(count(post.body, LIVE_KEY)).toBe(1); // the reveal only
    expect(JSON.stringify(body.toolCalls)).not.toContain(LIVE_KEY);
    expect(JSON.stringify(llm.requests)).not.toContain(LIVE_KEY);
    expect(persistedMessages(body.conversationId)).not.toContain(LIVE_KEY);
  });

  it("an LLM error that echoes a key is redacted in the 502 reply and the stored turn", async () => {
    llm.responses.push(new Error(`401 invalid credential ${LIVE_KEY}`));
    const post = await app.inject({ method: "POST", url: "/api/onboard/chat", payload: { message: "hello" } });
    expect(post.statusCode).toBe(502);
    expect(post.body).not.toContain(LIVE_KEY);
    expect(persistedMessages(post.json().conversationId)).not.toContain(LIVE_KEY);
  });

  it("a secret the user pastes is not sent to the model, stored or replayed", async () => {
    llm.responses.push(endTurn);
    const post = await app.inject({
      method: "POST",
      url: "/api/onboard/chat",
      payload: { message: `my key is ${LIVE_KEY}, please use it` },
    });
    expect(post.statusCode).toBe(200);
    expect(JSON.stringify(llm.requests)).not.toContain(LIVE_KEY);
    const id = post.json().conversationId;
    expect(persistedMessages(id)).not.toContain(LIVE_KEY);
    const get = await app.inject({ method: "GET", url: `/api/onboard/chat/${id}` });
    expect(get.body).not.toContain(LIVE_KEY);
  });

  it("GET and resume refuse a legacy-format id even when the row exists", async () => {
    const legacyId = "cnv_mfz3k2p1_a8b9c0"; // cnv_<Date.now base36>_<6 Math.random chars>
    insertRow(legacyId, [{ role: "user", content: `leaked ${LIVE_KEY}` }]);

    const get = await app.inject({ method: "GET", url: `/api/onboard/chat/${legacyId}` });
    expect(get.statusCode).toBe(404);
    expect(get.body).not.toContain(LIVE_KEY);

    const resume = await app.inject({
      method: "POST",
      url: "/api/onboard/chat",
      payload: { conversationId: legacyId, message: "what did I say before?" },
    });
    expect(resume.statusCode).toBe(404);
    expect(resume.json().error).toBe("conversation_not_found");
    expect(llm.requests).toHaveLength(0);
  });

  it("GET redacts a current-format row written before redaction existed", async () => {
    const id = generateConversationId();
    insertRow(id, [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: `{"api_key":"${LIVE_KEY}"}` }] }]);
    const get = await app.inject({ method: "GET", url: `/api/onboard/chat/${id}` });
    expect(get.statusCode).toBe(200);
    expect(get.body).not.toContain(LIVE_KEY);
  });

  it("new conversation ids are 128-bit CSPRNG ids, with no Math.random in the id path", async () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.42);
    try {
      const ids = new Set(Array.from({ length: 200 }, () => generateConversationId()));
      expect(ids.size).toBe(200);
      for (const id of ids) expect(id).toMatch(/^cnv_[A-Za-z0-9_-]{22}$/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    delete process.env.ANTHROPIC_API_KEY; // placeholder path: no LLM needed
    const post = await app.inject({ method: "POST", url: "/api/onboard/chat", payload: { message: "hi" } });
    expect(post.statusCode).toBe(200);
    expect(post.json().conversationId).toMatch(/^cnv_[A-Za-z0-9_-]{22}$/);
  });
});

// ── redactSecretsDeep unit behavior ─────────────────────────────────

describe("redactSecretsDeep", () => {
  it("replaces secret fields at any depth and secret-shaped substrings anywhere", () => {
    const input = {
      api_key: LIVE_KEY,
      nested: { deeper: [{ operatorWalletPrivateKey: PRIVATE_KEY }] },
      authorization: { scheme: "bearer", value: JWT },
      text: `header: Authorization: Bearer ${JWT}`,
    };
    const seen: Redaction[] = [];
    const out = redactSecretsDeep(input, (r) => seen.push(r));
    const json = JSON.stringify(out);
    for (const secret of [LIVE_KEY, PRIVATE_KEY, JWT]) expect(json).not.toContain(secret);
    expect(out.api_key).toBe(REDACTED_VALUE);
    expect(out.nested.deeper[0].operatorWalletPrivateKey).toBe(REDACTED_VALUE);
    expect(out.authorization).toBe(REDACTED_VALUE);
    expect(seen.map((r) => r.path)).toEqual(
      expect.arrayContaining(["$.api_key", "$.nested.deeper[0].operatorWalletPrivateKey", "$.authorization", "$.text"]),
    );
    expect(seen.find((r) => r.path === "$.text")?.value).toBe(JWT); // "Bearer " prefix stripped
  });

  it("leaves non-secret fields alone and never mutates its input", () => {
    const input = { publicKey: "0x" + "aa".repeat(32).slice(0, 40), idempotencyKey: "abc-123", hasApiKey: false, token: null, wallet: PUBLIC_ADDRESS };
    const copy = JSON.parse(JSON.stringify(input));
    const out = redactSecretsDeep(input);
    expect(input).toEqual(copy);
    expect(out).toEqual(copy);
  });

  it("is idempotent: a second pass changes nothing and reports nothing", () => {
    const once = redactSecretsDeep({ api_key: LIVE_KEY, note: `Bearer ${JWT}` });
    const seen: Redaction[] = [];
    const twice = redactSecretsDeep(once, (r) => seen.push(r));
    expect(twice).toEqual(once);
    expect(seen).toHaveLength(0);
  });

  it("fails closed on a cycle", () => {
    const a: Record<string, unknown> = { name: "loop" };
    a.self = a;
    const out = redactSecretsDeep(a) as Record<string, unknown>;
    expect(out.self).toBe(REDACTED_VALUE);
  });
});
