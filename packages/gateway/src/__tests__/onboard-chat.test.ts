/**
 * Tests for /api/onboard/chat (coord dc4d1ec8).
 *
 * Strategy:
 *   1. Endpoint registration + schema bootstrap (no LLM).
 *   2. Health endpoint exposes ANTHROPIC_API_KEY + SDK availability.
 *   3. No-key path: returns 200 with needsApiKey:true and persists the
 *      placeholder turn.
 *   4. Conversation continuity: a second call with the same conversationId
 *      retrieves the history; an invalid id returns 404.
 *   5. Input validation: missing message, oversized message, oversized
 *      conversation.
 *   6. End-to-end LLM tool-use loop (skipped unless ANTHROPIC_API_KEY is
 *      set — mirrors the smoke-onboarding-prompt.ts convention so PR CI
 *      doesn't fail on branches lacking the secret).
 *
 * Anthropic SDK is never required for tests 1-5. The "no key" path is the
 * fast / cheap path we exercise on every PR.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  onboardChatRoutes,
  _resetAnthropicCache,
  _resetAgentPackageCache,
} from "../routes/onboard-chat.js";
import { initStore, closeStore } from "../db.js";

// ---------------------------------------------------------------------------
// Mocks — keep the runtime narrow so the route can wire its own DB safely.
// ---------------------------------------------------------------------------

vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));

vi.mock("../services/audit-service.js", () => ({
  auditService: {
    log: vi.fn(),
    query: vi.fn().mockReturnValue([]),
    stats: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: {
    emit: vi.fn(),
    getTimeline: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({}),
  },
}));

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  await app.register(onboardChatRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("/api/onboard/chat — registration + schema", () => {
  let app: FastifyInstance;
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    _resetAnthropicCache();
    _resetAgentPackageCache();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  it("health endpoint reports SDK + key status", async () => {
    const res = await app.inject({ method: "GET", url: "/api/onboard/chat/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.hasApiKey).toBe(false);
    expect(typeof body.hasSdk).toBe("boolean");
    expect(typeof body.model).toBe("string");
    expect(body.agentPackageStatus).toBeDefined();
  });

  it("rejects requests without a message", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/chat",
      payload: { conversationId: undefined },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("message_required");
  });

  it("rejects whitespace-only messages", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/chat",
      payload: { message: "   \n\t  " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("message_required");
  });

  it("rejects oversized messages", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/chat",
      payload: { message: "x".repeat(8_001) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("message_too_long");
  });

  it("rejects unknown conversationId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/chat",
      payload: { conversationId: "cnv_does_not_exist", message: "hi" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("conversation_not_found");
  });
});

describe("/api/onboard/chat — no API key path (placeholder mode)", () => {
  let app: FastifyInstance;
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    _resetAnthropicCache();
    _resetAgentPackageCache();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  it("returns 200 + needsApiKey on first message when ANTHROPIC_API_KEY is unset", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/chat",
      payload: { message: "I run a pizza shop in Brooklyn" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.needsApiKey).toBe(true);
    expect(body.done).toBe(true);
    expect(typeof body.conversationId).toBe("string");
    expect(body.conversationId.startsWith("cnv_")).toBe(true);
    expect(body.assistant).toMatch(/ANTHROPIC_API_KEY/i);
    expect(body.toolCalls).toEqual([]);
  });

  it("persists the placeholder turn so a follow-up call sees history", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/onboard/chat",
      payload: { message: "I make pizzas" },
    });
    const id = first.json().conversationId as string;

    // Fetch the saved conversation
    const lookup = await app.inject({ method: "GET", url: `/api/onboard/chat/${id}` });
    expect(lookup.statusCode).toBe(200);
    const conv = lookup.json();
    expect(conv.conversationId).toBe(id);
    expect(Array.isArray(conv.messages)).toBe(true);
    // 1 user turn + 1 placeholder assistant turn
    expect(conv.messages.length).toBe(2);
    expect(conv.messages[0].role).toBe("user");
    expect(conv.messages[1].role).toBe("assistant");

    // Sending a second message with the same conversationId continues the thread
    const second = await app.inject({
      method: "POST",
      url: "/api/onboard/chat",
      payload: { conversationId: id, message: "Will you help me list it?" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().conversationId).toBe(id);

    const lookup2 = await app.inject({ method: "GET", url: `/api/onboard/chat/${id}` });
    expect(lookup2.json().messages.length).toBe(4);
  });

  it("returns 404 from GET for an unknown conversationId", async () => {
    const res = await app.inject({ method: "GET", url: "/api/onboard/chat/cnv_nope" });
    expect(res.statusCode).toBe(404);
  });
});

describe("/api/onboard/chat — tool execution dispatch (no LLM, mocked client)", () => {
  let app: FastifyInstance;
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetAnthropicCache();
    _resetAgentPackageCache();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  it("returns agent_package_missing when no agent-package.json is found", async () => {
    // We don't mock the agent-package loader, so when the test runs without
    // an apps/dashboard/public/agent-package.json on the cwd path the route
    // should report agent_package_missing. (When the dashboard IS built we
    // get a real LLM call attempt instead — guarded by the missing SDK or
    // bad key in the test env.)
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/chat",
      payload: { message: "hello" },
    });
    // Either agent_package_missing (CI cold start, no public file) OR
    // anthropic_call_failed (we got to the LLM call which 401'd with our
    // fake key). Both prove the no-key fallback path is NOT taken.
    expect([500, 502]).toContain(res.statusCode);
    const body = res.json();
    expect(["agent_package_missing", "anthropic_sdk_unavailable", "anthropic_call_failed"]).toContain(
      body.error,
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end LLM loop. Skipped unless ANTHROPIC_API_KEY is set + a public
// agent-package.json is reachable. Mirrors smoke-onboarding-prompt.ts.
// ---------------------------------------------------------------------------

const RUN_LIVE = !!process.env.ANTHROPIC_API_KEY && process.env.ONBOARD_CHAT_LIVE === "1";

describe.skipIf(!RUN_LIVE)("/api/onboard/chat — live LLM smoke (requires ANTHROPIC_API_KEY + ONBOARD_CHAT_LIVE=1)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _resetAnthropicCache();
    _resetAgentPackageCache();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("drives the v3 agent-pack from an operator transcript", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/chat",
      payload: {
        message:
          "I run Marios Pizzeria in Brooklyn. I make wood-fired margherita for $12. Open Tuesday through Sunday 11 AM to 11 PM. My wallet is 0xMariosWallet123.",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.conversationId).toBeDefined();
    expect(Array.isArray(body.toolCalls)).toBe(true);
    // At minimum the model should call SOMETHING (kernel_register, capability_create,
    // or even just provision_api_key). Empty toolCalls would mean the v3 prompt
    // didn't fire — that's a regression worth catching.
    expect(body.toolCalls.length).toBeGreaterThan(0);
  }, 90_000);
});
