/**
 * astra pack 91b, F2: the confirmation of a credential-minting call must name the
 * identity the credential is actually minted for.
 *
 * A held provision_api_key shows the person `bindsTo` before they confirm. The chat
 * used to pick the email before the wallet and to say that an identity-free request
 * cannot mint. POST /api/auth/provision does the opposite: a walletAddress (proven by
 * the caller's SIWE session) wins over an email, and a request that names nobody mints
 * for the signed-in session's wallet. So a SIWE session for wallet W holding
 * { email: "new@example.com", walletAddress: W } was shown the email and minted for W,
 * and { } was shown "the gateway refuses to mint" and minted for W.
 *
 * The oracle here is the REAL route: the app runs the real apiGate and the real
 * /api/auth/provision, confirms the hold, and reads the operator the minted key
 * belongs to. Whatever the chat showed must be that operator.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { randomUUID } from "node:crypto";

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
// Provisioning is limited to 5 per IP per hour; these tests mint many keys from one address.
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: vi.fn(() => true),
  canSiweVerify: vi.fn(() => true),
  canSiweNonce: vi.fn(() => true),
}));

import {
  onboardChatRoutes,
  _resetAnthropicCache,
  _resetAgentPackageCache,
  _setAgentPackageForTests,
  _forgetHeldActionsForTests,
} from "../routes/onboard-chat.js";
import { provisionRoutes } from "../routes/provision.js";
import { apiGate } from "../middleware/api-gate.js";
import { resolveApiKeyFromToken } from "../auth/api-key-auth.js";
import { initStore, closeStore, getRepos } from "../db.js";

const WALLET = "0x" + "dead".repeat(10); // a synthetic wallet
const OTHER_WALLET = "0x" + "beef".repeat(10);
const NEW_EMAIL = "new@example.com";

const tool = (name: string, method: string, path: string) => ({
  name,
  description: `${name}. More detail here.`,
  input_schema: { type: "object", properties: {} },
  endpoint: { method, path },
});

const PKG = {
  system_prompt: "test system prompt",
  tools: [tool("provision_api_key", "POST", "/api/auth/provision")],
};

const calls = (...blocks: Array<[name: string, input?: Record<string, unknown>]>) => ({
  content: blocks.map(([name, input], i) => ({ type: "tool_use", id: `tu_${i}_${name}_${randomUUID()}`, name, input: input ?? {} })),
  stop_reason: "tool_use",
});
const endTurn = { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" };

type Headers = Record<string, string>;
const sameIdentity = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

describe("onboard-chat credential binding (astra pack 91b F2)", () => {
  let app: FastifyInstance;
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    llm.requests.length = 0;
    llm.responses.length = 0;
    _resetAnthropicCache();
    _resetAgentPackageCache();
    _setAgentPackageForTests(PKG);
    _forgetHeldActionsForTests();

    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    app = Fastify({ logger: false });
    await app.register(cookie, { secret: "onboard-chat-binding-test-cookie-secret" });
    await app.register(apiGate);
    await app.register(provisionRoutes);
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

  const chat = (payload: Record<string, unknown>, headers: Headers = {}) =>
    app.inject({ method: "POST", url: "/api/onboard/chat", payload, headers, remoteAddress: "198.51.100.91" });

  /** A SIWE session for `address`: the same rows /api/auth/verify writes. */
  const siwe = (address: string) => {
    const token = randomUUID();
    const now = Date.now();
    getRepos().sessions.insert({
      id: randomUUID(),
      walletAddress: address,
      token,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      lastActiveAt: new Date(now).toISOString(),
    });
    return { token, bearer: { authorization: `Bearer ${token}` }, cookie: { cookie: `pcc_session=${app.signCookie(token)}` } };
  };

  /**
   * The model calls provision_api_key(input) for `headers`. If the chat holds it, the
   * person confirms it, and the result says who the confirmation named and whose
   * credential the real route then minted.
   */
  const holdThenConfirm = async (headers: Headers, input: Record<string, unknown>) => {
    llm.responses.push(calls(["provision_api_key", input]), endTurn);
    const post = await chat({ message: "sign me up" }, headers);
    expect(post.statusCode).toBe(200);
    const body = post.json();
    const attempt = body.toolCalls.find((t: { name: string }) => t.name === "provision_api_key");
    if (!body.pendingActions) return { held: undefined, attempt, mintedFor: undefined as string | undefined };
    const view = body.pendingActions[0] as { actionId: string; bindsTo?: string; summary: string };
    const confirm = await chat({ conversationId: body.conversationId, confirmActionId: view.actionId }, headers);
    const reveal = ((confirm.json().revealedSecrets ?? []) as Array<{ path: string; value: string }>).find((s) => s.path === "$.api_key");
    return { held: view, attempt, mintedFor: reveal ? resolveApiKeyFromToken(reveal.value)?.operatorId : undefined };
  };

  // Oracle: whatever identity a held credential-minting call shows, confirming it mints
  // for exactly that identity. (A call the chat refuses to hold shows nothing and mints nothing.)
  const CASES: Array<[label: string, who: "session" | "session-cookie" | "anonymous", input: Record<string, unknown>]> = [
    ["session W, { email, walletAddress: W }: the wallet wins in the route", "session", { email: NEW_EMAIL, walletAddress: WALLET }],
    ["session W, { }: the route mints for the session's wallet", "session", {}],
    ["session W by cookie, { }: the same", "session-cookie", {}],
    ["session W, { walletAddress: W }", "session", { walletAddress: WALLET }],
    ["session W, { email }: an explicit email wins over the ambient session", "session", { email: NEW_EMAIL }],
    ["anonymous, { email }", "anonymous", { email: NEW_EMAIL }],
  ];

  it.each(CASES)("[neg] the identity a hold names is the identity that is minted: %s", async (_label, who, input) => {
    const session = siwe(WALLET);
    const headers: Headers = who === "session" ? session.bearer : who === "session-cookie" ? session.cookie : {};
    const out = await holdThenConfirm(headers, input);
    if (out.held !== undefined) {
      expect(out.mintedFor, `confirming minted a key; the hold said it binds to ${JSON.stringify(out.held.bindsTo)}`).toBeDefined();
      expect(
        sameIdentity(out.held.bindsTo, out.mintedFor),
        `the confirmation named ${JSON.stringify(out.held.bindsTo)} but the credential was minted for ${out.mintedFor}`,
      ).toBe(true);
    } else {
      expect(out.mintedFor).toBeUndefined(); // refused before any hold: nothing was minted
    }
  });
});
