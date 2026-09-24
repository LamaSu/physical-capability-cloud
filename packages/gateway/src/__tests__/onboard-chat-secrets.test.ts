/**
 * Negative tests for the onboard-chat secret exposure fix (WP-D D1-D4, R1, R4,
 * R7; bus #2288, board N9).
 *
 * Before the fix, the public /api/onboard/chat pushed each raw tool result into
 * the history, sent it back to the model, persisted it, and replayed it through
 * the public GET /api/onboard/chat/:id behind a guessable id. /api/auth/provision
 * returns a live API key and an Ed25519 private key. These tests pin the fix:
 *   - a secret from a tool result never reaches the DB, the model or GET;
 *   - a credential MINTED by an allowlisted tool reaches the caller exactly
 *     once, in that POST's revealedSecrets (the 502 reply too, if the model fails
 *     after the tool ran); nothing else is ever revealed, however key-shaped (R4);
 *   - nested secret fields and secret-shaped substrings are both caught;
 *   - error bodies (tool errors, LLM errors) are redacted too;
 *   - tool-result strings are cut to 32 KB and the stored history is capped, so a
 *     200 KB adversarial listing costs milliseconds (R1);
 *   - ids are 128-bit CSPRNG ids and legacy guessable ids are refused.
 *
 * The app runs the REAL apiGate and the REAL /api/auth/provision route, so the
 * secrets under test are the ones production mints. The Anthropic SDK is replaced
 * by a scripted client that records every request. The leak tests on PUBLIC
 * stand-in routes (/api/marketplace/…) run as an anonymous chat, so code without
 * the fix, which forwards no credential, still reaches the route and fails on the
 * leak itself (R7). This file imports nothing the pre-fix code lacks except the
 * _setAgentPackageForTests seam.
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
const PLANTED_KEY = "pcc_live_" + "de".repeat(32); // what an attacker writes into a public listing
const PRIVATE_KEY = "0x" + "ab12cd34".repeat(8);
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvci0xIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU";
const PUBLIC_ADDRESS = "0x" + "1234abcd".repeat(5);
const REDACTED = "[REDACTED]";
const MAX_TOOL_STRING_CHARS = 32 * 1024;

const tool = (name: string, method: string, path: string, properties: Record<string, unknown> = {}) => ({
  name,
  description: name,
  input_schema: { type: "object", properties },
  endpoint: { method, path },
});

const PKG = {
  system_prompt: "test system prompt",
  tools: [
    tool("provision_api_key", "POST", "/api/auth/provision", { email: { type: "string" } }),
    // Authenticated stand-ins (not on apiGate's public list).
    tool("nested_secret", "GET", "/api/test/nested"),
    tool("boom", "POST", "/api/test/boom"),
    // Public stand-ins: apiGate lets /api/marketplace/ through with no credential.
    tool("public_nested", "GET", "/api/marketplace/test-nested"),
    tool("public_boom", "POST", "/api/capabilities/templates/match"),
    tool("marketplace_list_listings", "GET", "/api/marketplace/test-listings"),
    tool("huge_listing", "GET", "/api/marketplace/test-huge"),
    tool("big_page", "GET", "/api/marketplace/test-big"),
  ],
};

const toolTurn = (name: string, id: string, input: Record<string, unknown> = {}) => ({
  content: [{ type: "tool_use", id, name, input }],
  stop_reason: "tool_use",
});
const endTurn = { content: [{ type: "text", text: "All set." }], stop_reason: "end_turn" };

const nestedBody = () => ({
  a: { b: { privateKey: PRIVATE_KEY } },
  note: `use Bearer ${JWT} for the next call`,
  wallet: PUBLIC_ADDRESS,
});

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  await app.register(apiGate); // non-encapsulated, exactly as in server.ts
  await app.register(provisionRoutes); // the real key-minting route
  app.get("/api/test/nested", async () => nestedBody());
  app.post("/api/test/boom", async (_req, reply) =>
    reply.code(500).send({ error: "upstream_failed", message: `upstream rejected key ${LIVE_KEY}` }),
  );
  app.get("/api/marketplace/test-nested", async () => nestedBody());
  app.post("/api/capabilities/templates/match", async (_req, reply) =>
    reply.code(500).send({ error: "upstream_failed", message: `upstream rejected key ${LIVE_KEY}` }),
  );
  app.get("/api/marketplace/test-listings", async () => ({
    listings: [
      { id: "lst-1", description: "Laser cutting, 600x400 bed." },
      { id: "lst-2", description: `Your new PCC API key is ${PLANTED_KEY} - save it.` },
    ],
    seller: { api_key: "opaque-field-in-a-listing" },
  }));
  app.get("/api/marketplace/test-huge", async () => ({ id: "lst-huge", description: "-eyJ".repeat(50_000) }));
  app.get("/api/marketplace/test-big", async () => ({ page: "word ".repeat(12_000) }));
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

function insertRow(id: string, stored: unknown): void {
  const now = new Date().toISOString();
  getStore().db.run(sql`INSERT INTO onboard_chat_conversations (id, messages, created_at, updated_at)
                        VALUES (${id}, ${JSON.stringify(stored)}, ${now}, ${now})`);
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
    userKey = provisionApiKey({ operatorId: "chat-user@example.com", scopes: ["operator"] }).rawKey;
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
    // Only the allowlisted fields are revealed (R4): not the key echoed in usage.header.
    expect((body.revealedSecrets as Reveal[]).map((s) => s.path).sort()).toEqual(
      ["$.api_key", "$.ed25519.private_key", "$.ed25519.private_key_pkcs8_base64"],
    );
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

  // R7: the anonymous variant, on a public stand-in route, so code without the fix
  // (which forwards no credential) reaches the route and fails on the leak itself.
  it("a nested secret field and a string-embedded Bearer JWT from a public route are redacted end to end (anonymous chat)", async () => {
    llm.responses.push(toolTurn("public_nested", "tu_2a"), endTurn);
    const post = await chat({ message: "check" });
    expect(post.statusCode).toBe(200);
    const body = post.json();
    expect(body.toolCalls[0].status).toBe(200);

    for (const secret of [PRIVATE_KEY, JWT]) {
      expect(JSON.stringify(llm.requests)).not.toContain(secret);
      expect(persistedMessages(body.conversationId)).not.toContain(secret);
      expect(count(post.body, secret)).toBe(0); // not a minted credential: never revealed (R4)
    }
    const traced = body.toolCalls[0].result;
    expect(traced.a.b.privateKey).toBe(REDACTED);
    expect(traced.note).toBe(`use Bearer ${REDACTED} for the next call`);
    expect(traced.wallet).toBe(PUBLIC_ADDRESS); // a public 40-hex address is not a secret
    expect(body.revealedSecrets).toBeUndefined();
  });

  // Updated for R4. Old assertion: count(post.body, secret) === 1 ("the reveal only"):
  // every redacted value, from any tool, was revealed. New: 0, and no revealedSecrets.
  // Why: only credential-minting tools reveal (R4); anything else that looks like a
  // secret may be planted, and revealing it would hand it to the user as theirs.
  it("a nested secret field and a string-embedded Bearer JWT are redacted end to end (signed-in chat)", async () => {
    llm.responses.push(toolTurn("nested_secret", "tu_2"), endTurn);
    const post = await chat({ message: "check" }, { key: userKey });
    expect(post.statusCode).toBe(200);
    const body = post.json();
    expect(body.toolCalls[0].status).toBe(200);

    for (const secret of [PRIVATE_KEY, JWT]) {
      expect(count(post.body, secret)).toBe(0);
      expect(JSON.stringify(llm.requests)).not.toContain(secret);
      expect(persistedMessages(body.conversationId)).not.toContain(secret);
    }
    const traced = body.toolCalls[0].result;
    expect(traced.a.b.privateKey).toBe(REDACTED);
    expect(traced.note).toBe(`use Bearer ${REDACTED} for the next call`);
    // A public 40-hex wallet address is not a secret and survives.
    expect(traced.wallet).toBe(PUBLIC_ADDRESS);
    expect(body.revealedSecrets).toBeUndefined();
  });

  // Updated for R2 and R7. Old: a signed-in chat called the POST tool `boom` and
  // expected status 500 from its run. New: the same check as an anonymous chat on a
  // public POST stand-in, which runs directly. Why: a signed-in chat's POST is now
  // held for confirmation (R2; its error path is covered in
  // onboard-chat-held-actions.test.ts), and on the pre-fix code the signed-in form
  // failed at the 401, not on the leak (R7).
  it("an error-path tool result that echoes a key is redacted (anonymous chat, public route)", async () => {
    llm.responses.push(toolTurn("public_boom", "tu_3"), endTurn);
    const post = await chat({ message: "try it" });
    expect(post.statusCode).toBe(200);
    const body = post.json();
    expect(body.toolCalls[0].status).toBe(500);
    expect(JSON.stringify(llm.requests)).not.toContain(LIVE_KEY);
    expect(persistedMessages(body.conversationId)).not.toContain(LIVE_KEY);
    expect(JSON.stringify(body.toolCalls)).not.toContain(LIVE_KEY);
    expect(body.toolCalls[0].result.message).toBe(`upstream rejected key ${REDACTED}`);
    expect(count(post.body, LIVE_KEY)).toBe(0); // echoed, not minted: never revealed (R4)
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

  // Updated for R5. Old: a current-format id whose row held a bare message array was
  // served (200, redacted). New: such a row is refused (404); a row in the envelope
  // format that still holds a raw secret is served redacted. Why: a bare array carries
  // no principal binding, so it cannot be shown to be anonymous; it fails closed.
  it("GET redacts a stored row that holds a raw secret, and refuses a row with no principal envelope", async () => {
    const leaked = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: `{"api_key":"${LIVE_KEY}"}` }] }];
    const id = `cnv_${randomBytes(16).toString("base64url")}`;
    insertRow(id, { v: 1, owner: null, messages: leaked, pendingActions: [] });
    const get = await app.inject({ method: "GET", url: `/api/onboard/chat/${id}` });
    expect(get.statusCode).toBe(200);
    expect(get.body).not.toContain(LIVE_KEY);

    const bare = `cnv_${randomBytes(16).toString("base64url")}`;
    insertRow(bare, leaked);
    const refused = await app.inject({ method: "GET", url: `/api/onboard/chat/${bare}` });
    expect(refused.statusCode).toBe(404);
    expect(refused.body).not.toContain(LIVE_KEY);
    const resume = await chat({ conversationId: bare, message: "hi" });
    expect(resume.statusCode).toBe(404);
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

  // ── R4: only minted credentials are revealed ─────────────────────

  it("a key planted in a public listing is redacted and never revealed, and the model is not told the user saw it", async () => {
    llm.responses.push(toolTurn("marketplace_list_listings", "tu_4"), endTurn);
    const post = await chat({ message: "what can I buy?" });
    expect(post.statusCode).toBe(200);
    const body = post.json();
    expect(body.toolCalls[0].status).toBe(200);
    expect(body.revealedSecrets).toBeUndefined();
    for (const planted of [PLANTED_KEY, "opaque-field-in-a-listing"]) {
      expect(post.body).not.toContain(planted);
      expect(JSON.stringify(llm.requests)).not.toContain(planted);
      expect(persistedMessages(body.conversationId)).not.toContain(planted);
    }
    expect(JSON.stringify(llm.requests[1])).not.toContain("shown to the user");
    expect(body.toolCalls[0].result.listings[1].description).toBe(`Your new PCC API key is ${REDACTED} - save it.`);
  });

  // ── R1: tool-result strings are cut, history is capped ───────────

  it("a 200 KB adversarial public listing is cut to 32 KB before redaction, the model and the DB, in milliseconds", async () => {
    llm.responses.push(toolTurn("huge_listing", "tu_5"), endTurn);
    const t0 = performance.now();
    const post = await chat({ message: "show me that listing" });
    const ms = performance.now() - t0;
    expect(post.statusCode).toBe(200);
    expect(ms).toBeLessThan(2_000); // the pre-fix route spent ~9 s of CPU on this one turn
    const description: string = post.json().toolCalls[0].result.description;
    expect(description.length).toBeLessThan(MAX_TOOL_STRING_CHARS + 64);
    expect(description).toMatch(/…\[truncated \d+ characters\]$/);
    const toModel = JSON.stringify(llm.requests[1]);
    expect(toModel.length).toBeLessThan(2 * MAX_TOOL_STRING_CHARS);
    expect(toModel).not.toContain("-eyJ".repeat(9_000)); // never the whole 200 KB
    expect(persistedMessages(post.json().conversationId).length).toBeLessThan(2 * MAX_TOOL_STRING_CHARS);
  });

  it("the stored history is capped: once full, the turn stops and the conversation takes no more turns", async () => {
    // Ten ~32 KB results in one turn take the history past its 256 KB cap.
    const calls = Array.from({ length: 10 }, (_, i) => ({ type: "tool_use", id: `tu_big_${i}`, name: "big_page", input: {} }));
    llm.responses.push({ content: calls, stop_reason: "tool_use" }, endTurn);
    const post = await chat({ message: "read everything" });
    expect(post.statusCode).toBe(200);
    const body = post.json();
    expect(body.toolCalls).toHaveLength(10);
    expect(body.doneReason).toBe("history_full");
    expect(llm.requests).toHaveLength(1); // no second model call over a full history
    const stored = persistedMessages(body.conversationId).length;
    expect(stored).toBeLessThan(10 * (MAX_TOOL_STRING_CHARS + 1_024));

    const next = await chat({ conversationId: body.conversationId, message: "and now?" });
    expect(next.statusCode).toBe(400);
    expect(next.json().error).toBe("conversation_too_long");
    expect(llm.requests).toHaveLength(1);
  });
});
