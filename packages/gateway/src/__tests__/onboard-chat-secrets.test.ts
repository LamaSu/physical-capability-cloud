/**
 * Negative tests for the onboard-chat secret exposure fix (WP-D D1-D4; bus #2288,
 * board N9).
 *
 * Before the fix, the public /api/onboard/chat pushed each raw tool result into
 * the history, sent it back to the model, persisted it, and replayed it through
 * the public GET /api/onboard/chat/:id behind a guessable id. /api/auth/provision
 * returns a live API key and an Ed25519 private key. These tests pin the fix:
 *   - a secret from a tool result never reaches the DB, the model or GET;
 *   - it reaches the caller exactly once, in that POST's revealedSecrets (the
 *     502 reply too, if the model fails after the tool ran);
 *   - nested secret fields and secret-shaped substrings are both caught;
 *   - error bodies (tool errors, LLM errors) are redacted too;
 *   - ids are 128-bit CSPRNG ids and legacy guessable ids are refused.
 *
 * The app runs the REAL apiGate and the REAL /api/auth/provision route, so the
 * secrets under test are the ones production mints. The Anthropic SDK is replaced
 * by a scripted client that records every request. This file imports nothing the
 * pre-fix code lacks except the _setAgentPackageForTests seam, so each test can be
 * run against the pre-fix route to prove it fails there.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
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
  _resetAnthropicCache,
  _resetAgentPackageCache,
  _setAgentPackageForTests,
} from "../routes/onboard-chat.js";
import { provisionRoutes } from "../routes/provision.js";
import { apiGate } from "../middleware/api-gate.js";
import { provisionApiKey, resolveApiKeyFromToken } from "../auth/api-key-auth.js";
import { initStore, closeStore, getStore } from "../db.js";

// ── Fixtures ────────────────────────────────────────────────────────

const LIVE_KEY = "pcc_live_" + "Q7xR2m".repeat(6) + "_k9";
const PRIVATE_KEY = "0x" + "ab12cd34".repeat(8);
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvci0xIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU";
const PUBLIC_ADDRESS = "0x" + "1234abcd".repeat(5);
const REDACTED = "[REDACTED]";

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
  await app.register(apiGate); // non-encapsulated, exactly as in server.ts
  await app.register(provisionRoutes); // the real key-minting route
  // Authenticated stand-ins (not on apiGate's public list).
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

type Reveal = { tool: string; path: string; value: string };
const revealAt = (body: { revealedSecrets?: Reveal[] }, path: string) =>
  (body.revealedSecrets ?? []).find((s) => s.path === path)?.value;

// ── Route behavior ──────────────────────────────────────────────────

describe("onboard-chat secret exposure (WP-D D1-D4)", () => {
  let app: FastifyInstance;
  let userKey: string; // a signed-in chat user's own key, for the authenticated tools
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    llm.requests.length = 0;
    llm.responses.length = 0;
    _resetAnthropicCache();
    _resetAgentPackageCache();
    _setAgentPackageForTests(PKG);
    app = await buildApp();
    userKey = provisionApiKey({ operatorId: "chat-user@example.com" }).rawKey;
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    _resetAgentPackageCache();
    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  const chat = (payload: Record<string, unknown>, opts: { key?: string; ip?: string } = {}) =>
    app.inject({
      method: "POST",
      url: "/api/onboard/chat",
      payload,
      remoteAddress: opts.ip ?? "198.51.100.1",
      headers: opts.key ? { authorization: `Bearer ${opts.key}` } : {},
    });

  it("secrets minted by the real /api/auth/provision never reach the DB, the model or GET, and are revealed exactly once", async () => {
    llm.responses.push(toolTurn("provision_api_key", "tu_1", { email: "new-operator@example.com" }), endTurn);
    const post = await chat({ message: "sign me up" }, { ip: "198.51.100.11" });
    expect(post.statusCode).toBe(200);
    const body = post.json();
    expect(body.toolCalls[0].status).toBe(201);

    // The minted secrets, read from the one-time reveal. (Code without the fix has no
    // reveal and leaves them in the raw trace; reading them from there makes such
    // code fail on the leak assertions below rather than on a missing field.)
    const trace = body.toolCalls[0].result;
    const apiKey: string = revealAt(body, "$.api_key") ?? trace.api_key;
    const edPrivate: string = revealAt(body, "$.ed25519.private_key") ?? trace.ed25519?.private_key;
    const edPkcs8: string =
      revealAt(body, "$.ed25519.private_key_pkcs8_base64") ?? trace.ed25519?.private_key_pkcs8_base64;
    expect(apiKey).toMatch(/^pcc_live_[0-9a-f]{64}$/);
    expect(edPrivate).toMatch(/^[0-9a-f]{64}$/);
    expect(edPkcs8).toMatch(/^MC4CAQAwBQYDK2VwBCIEI/);

    const secrets = [apiKey, edPrivate, edPkcs8];
    for (const secret of secrets) {
      expect(JSON.stringify(llm.requests)).not.toContain(secret); // never sent to the model
      expect(persistedMessages(body.conversationId)).not.toContain(secret); // never persisted
      expect(JSON.stringify(body.toolCalls)).not.toContain(secret);
      expect(count(post.body, secret)).toBe(1); // in the reply exactly once: the reveal
    }
    expect(trace.api_key).toBe(REDACTED);
    expect(trace.ed25519.private_key_pkcs8_base64).toBe(REDACTED);
    expect(revealAt(body, "$.api_key")).toBe(apiKey);
    expect(revealAt(body, "$.ed25519.private_key_pkcs8_base64")).toBe(edPkcs8);
    // What the user is shown is the real, working key.
    expect(resolveApiKeyFromToken(apiKey)?.operatorId).toBe("new-operator@example.com");
    // The model is told the user saw it once.
    expect(llm.requests).toHaveLength(2);
    expect(JSON.stringify(llm.requests[1])).toContain("shown to the user once");

    // Never replayed.
    const get = await app.inject({ method: "GET", url: `/api/onboard/chat/${body.conversationId}` });
    expect(get.statusCode).toBe(200);
    for (const secret of secrets) expect(get.body).not.toContain(secret);
    expect(get.body).not.toContain("revealedSecrets");

    // One-time: the next turn in the same conversation does not repeat it.
    const next = await chat({ conversationId: body.conversationId, message: "what now?" }, { ip: "198.51.100.11" });
    expect(next.statusCode).toBe(200);
    for (const secret of secrets) expect(next.body).not.toContain(secret);
    expect(next.json().revealedSecrets).toBeUndefined();
    for (const secret of secrets) expect(JSON.stringify(llm.requests)).not.toContain(secret);
  });

  it("a key minted before the model fails is still revealed once, in the 502 reply, and never stored", async () => {
    llm.responses.push(
      toolTurn("provision_api_key", "tu_9", { email: "second@example.com" }),
      new Error("529 overloaded"),
    );
    const post = await chat({ message: "sign me up" }, { ip: "198.51.100.12" });
    expect(post.statusCode).toBe(502);
    const body = post.json();
    expect(body.error).toBe("anthropic_call_failed");
    const apiKey = revealAt(body, "$.api_key");
    expect(apiKey).toMatch(/^pcc_live_[0-9a-f]{64}$/);
    expect(count(post.body, apiKey!)).toBe(1);
    expect(JSON.stringify(llm.requests)).not.toContain(apiKey!);
    expect(persistedMessages(body.conversationId)).not.toContain(apiKey!);
  });

  it("a nested secret field and a string-embedded Bearer JWT are redacted end to end", async () => {
    llm.responses.push(toolTurn("nested_secret", "tu_2"), endTurn);
    const post = await chat({ message: "check" }, { key: userKey });
    expect(post.statusCode).toBe(200);
    const body = post.json();
    expect(body.toolCalls[0].status).toBe(200);

    for (const secret of [PRIVATE_KEY, JWT]) {
      expect(count(post.body, secret)).toBe(1); // the reveal only
      expect(JSON.stringify(llm.requests)).not.toContain(secret);
      expect(persistedMessages(body.conversationId)).not.toContain(secret);
    }
    const traced = body.toolCalls[0].result;
    expect(traced.a.b.privateKey).toBe(REDACTED);
    expect(traced.note).toBe(`use Bearer ${REDACTED} for the next call`);
    // A public 40-hex wallet address is not a secret and survives.
    expect(traced.wallet).toBe(PUBLIC_ADDRESS);
  });

  it("an error-path tool result that echoes a key is redacted", async () => {
    llm.responses.push(toolTurn("boom", "tu_3"), endTurn);
    const post = await chat({ message: "try it" }, { key: userKey });
    expect(post.statusCode).toBe(200);
    const body = post.json();
    expect(body.toolCalls[0].status).toBe(500);
    expect(body.toolCalls[0].result.message).toBe(`upstream rejected key ${REDACTED}`);
    expect(count(post.body, LIVE_KEY)).toBe(1); // the reveal only
    expect(JSON.stringify(body.toolCalls)).not.toContain(LIVE_KEY);
    expect(JSON.stringify(llm.requests)).not.toContain(LIVE_KEY);
    expect(persistedMessages(body.conversationId)).not.toContain(LIVE_KEY);
  });

  it("an LLM error that echoes a key is redacted in the 502 reply and the stored turn", async () => {
    llm.responses.push(new Error(`401 invalid credential ${LIVE_KEY}`));
    const post = await chat({ message: "hello" });
    expect(post.statusCode).toBe(502);
    expect(post.body).not.toContain(LIVE_KEY);
    expect(persistedMessages(post.json().conversationId)).not.toContain(LIVE_KEY);
  });

  it("a secret the user pastes is not sent to the model, stored or replayed", async () => {
    llm.responses.push(endTurn);
    const post = await chat({ message: `my key is ${LIVE_KEY}, please use it` });
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

    const resume = await chat({ conversationId: legacyId, message: "what did I say before?" });
    expect(resume.statusCode).toBe(404);
    expect(resume.json().error).toBe("conversation_not_found");
    expect(llm.requests).toHaveLength(0);
  });

  it("GET redacts a current-format row written before redaction existed", async () => {
    const id = `cnv_${randomBytes(16).toString("base64url")}`;
    insertRow(id, [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: `{"api_key":"${LIVE_KEY}"}` }] }]);
    const get = await app.inject({ method: "GET", url: `/api/onboard/chat/${id}` });
    expect(get.statusCode).toBe(200);
    expect(get.body).not.toContain(LIVE_KEY);
  });

  it("new conversation ids are 128-bit CSPRNG ids, with no Math.random in the id path", async () => {
    delete process.env.ANTHROPIC_API_KEY; // placeholder path: no LLM, just id + persist
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.42);
    const ids = new Set<string>();
    try {
      for (let i = 0; i < 40; i += 1) {
        const post = await chat({ message: "hi" });
        expect(post.statusCode).toBe(200);
        ids.add(post.json().conversationId);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(ids.size).toBe(40); // Math.random was pinned: uniqueness came from the CSPRNG
    for (const id of ids) expect(id).toMatch(/^cnv_[A-Za-z0-9_-]{22}$/);
  });
});
