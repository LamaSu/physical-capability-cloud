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
import { provisionApiKey, resolveApiKeyFromToken } from "../auth/api-key-auth.js";
import * as provisionIdentity from "../auth/provision-identity.js";
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
  tools: [tool("provision_api_key", "POST", "/api/auth/provision"), tool("redeem_invite", "POST", "/api/onboard/redeem")],
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
  /** Every request the chat dispatched (the chat's own endpoints excluded). */
  let dispatched: Array<{ method: string; url: string }>;
  const spies: Array<{ mockRestore: () => void }> = [];
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    dispatched = [];
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
    app.addHook("onRequest", async (req) => {
      if (!req.url.startsWith("/api/onboard/chat")) dispatched.push({ method: req.method, url: req.url });
    });
    await app.register(apiGate);
    await app.register(provisionRoutes);
    app.post("/api/onboard/redeem", async () => ({ success: true }));
    await app.register(onboardChatRoutes);
    await app.ready();
  });

  afterEach(async () => {
    for (const spy of spies.splice(0)) spy.mockRestore(); // only this file's own spies: the module mocks above stay as they are
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
    if (!body.pendingActions) return { body, held: undefined, attempt, confirm: undefined, mintedFor: undefined as string | undefined };
    const view = body.pendingActions[0] as { actionId: string; bindsTo?: string; summary: string };
    const confirm = (await chat({ conversationId: body.conversationId, confirmActionId: view.actionId }, headers)).json();
    const reveal = ((confirm.revealedSecrets ?? []) as Array<{ path: string; value: string }>).find((s) => s.path === "$.api_key");
    return { body, held: view, attempt, confirm, mintedFor: reveal ? resolveApiKeyFromToken(reveal.value)?.operatorId : undefined };
  };

  const provisionCalls = () => dispatched.filter((d) => d.url === "/api/auth/provision");

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

  // ── The fix: the chat asks the route's own resolver, and refuses what it cannot answer ──

  it("[neg] a wallet and an email together are two identities: refused, not guessed (session W, { email, walletAddress: W })", async () => {
    const session = siwe(WALLET);
    const out = await holdThenConfirm(session.bearer, { email: NEW_EMAIL, walletAddress: WALLET });
    expect(out.held).toBeUndefined();
    expect(out.body.pendingActions).toBeUndefined();
    expect(out.attempt).toMatchObject({ status: 400, result: { error: "ambiguous_identity" } });
    expect(out.attempt.result.message).toContain("ONE");
    expect(provisionCalls()).toEqual([]); // nothing reached the route
    expect(getRepos().apiKeys.countByOperator(WALLET)).toBe(0);
    expect(getRepos().apiKeys.countByOperator(NEW_EMAIL)).toBe(0);
  });

  it("an identity-free request under a SIWE session is shown as the session's wallet, and mints for it", async () => {
    const session = siwe(WALLET);
    const out = await holdThenConfirm(session.bearer, {});
    expect(out.held).toMatchObject({ bindsTo: WALLET });
    expect(out.held?.summary).toContain(`bound to ${WALLET} (you named no email or wallet, so it is the wallet your signed-in session proves)`);
    expect(out.held?.summary).not.toContain("refuses");
    expect(out.confirm.confirmedAction).toMatchObject({ tool: "provision_api_key", status: 201 });
    expect(out.mintedFor).toBe(WALLET);
    const reveals = out.confirm.revealedSecrets as Array<{ boundTo?: string }>;
    for (const r of reveals) expect(r.boundTo).toBe(WALLET);
  });

  it("a wallet the session proves is shown as that wallet, and mints for it", async () => {
    const session = siwe(WALLET);
    const out = await holdThenConfirm(session.cookie, { walletAddress: WALLET });
    expect(out.held).toMatchObject({ bindsTo: WALLET });
    expect(out.held?.summary).toContain(`bound to ${WALLET} (the wallet your signed-in session proves)`);
    expect(out.mintedFor).toBe(WALLET);
  });

  it("an explicit email wins over an ambient session, in the display exactly as in the route (trimmed, as typed)", async () => {
    const session = siwe(WALLET);
    const out = await holdThenConfirm(session.bearer, { email: `  ${NEW_EMAIL} ` });
    expect(out.held).toMatchObject({ bindsTo: NEW_EMAIL });
    expect(out.held?.summary).toContain(`bound to ${NEW_EMAIL}. `);
    expect(out.mintedFor).toBe(NEW_EMAIL);
  });

  it.each([
    ["a wallet the session does not prove", "session", { walletAddress: OTHER_WALLET }, 401, "wallet_not_verified"],
    ["a wallet with no session at all", "anonymous", { walletAddress: WALLET }, 401, "wallet_not_verified"],
    ["a malformed wallet", "session", { walletAddress: "0x1234" }, 400, "invalid_wallet_address"],
    ["nobody named, no session", "anonymous", {}, 400, "identifier_required"],
    ["a malformed email", "anonymous", { email: "not-an-email" }, 400, "invalid_email"],
    ["a blank email (an explicit email never falls through to the session)", "session", { email: "   " }, 400, "invalid_email"],
    ["an email that is not a string", "session", { email: 5 }, 400, "invalid_type"],
  ] as const)("[neg] %s is refused with the route's own answer, before anything is held", async (_label, who, input, status, error) => {
    const session = siwe(WALLET);
    const out = await holdThenConfirm(who === "session" ? session.bearer : {}, input as Record<string, unknown>);
    expect(out.held).toBeUndefined();
    expect(out.body.pendingActions).toBeUndefined();
    expect(out.attempt).toMatchObject({ status, result: { error } });
    expect(provisionCalls()).toEqual([]);
  });

  it("[neg] an API-key chat that also carries a session cookie does not get the session's wallet: only the key is forwarded", async () => {
    const session = siwe(WALLET);
    const { rawKey } = provisionApiKey({ operatorId: "alice@example.com", scopes: ["operator"] });
    const out = await holdThenConfirm({ authorization: `Bearer ${rawKey}`, ...session.cookie }, {});
    // The dispatched call would carry the key alone, so the route would refuse an identity-free request.
    expect(out.held).toBeUndefined();
    expect(out.attempt).toMatchObject({ status: 400, result: { error: "identifier_required" } });
    expect(provisionCalls()).toEqual([]);
    expect(getRepos().apiKeys.countByOperator(WALLET)).toBe(0);
  });

  it("the caller's own email under their key is shown as typed, and the key it mints is the same identity", async () => {
    const { rawKey } = provisionApiKey({ operatorId: "alice@example.com", scopes: ["operator"] });
    const out = await holdThenConfirm({ authorization: `Bearer ${rawKey}` }, { email: "Alice@Example.com" });
    expect(out.held).toMatchObject({ bindsTo: "Alice@Example.com" });
    expect(out.confirm.confirmedAction).toMatchObject({ status: 201 });
    expect(out.mintedFor).toBe("alice@example.com"); // the delegating key's own operatorId: the same identity under the fold
  });

  it("[neg] confirming refuses, and mints nothing, when the route's resolver no longer gives the identity that was shown", async () => {
    const session = siwe(WALLET);
    llm.responses.push(calls(["provision_api_key", {}]), endTurn);
    const post = await chat({ message: "sign me up" }, session.bearer);
    const held = post.json();
    expect(held.pendingActions[0]).toMatchObject({ bindsTo: WALLET });

    // State moved between the hold and the confirmation (or the rules drifted): the same
    // request now resolves to another wallet. The call must not run.
    const drift = vi.spyOn(provisionIdentity, "selectProvisionIdentity").mockReturnValue({
      ok: true,
      source: "session",
      operatorId: OTHER_WALLET,
      siweVerified: true,
    });
    spies.push(drift);
    llm.responses.push(endTurn);
    const confirm = await chat({ conversationId: held.conversationId, confirmActionId: held.pendingActions[0].actionId }, session.bearer);
    expect(confirm.statusCode).toBe(200);
    const body = confirm.json();
    expect(body.confirmedAction).toMatchObject({ tool: "provision_api_key", status: 409 });
    expect(body.toolCalls[0].result).toMatchObject({ error: "identity_changed" });
    expect(body.toolCalls[0].result.message).toContain(OTHER_WALLET);
    expect(body.toolCalls[0].result.message).toContain("Nothing was minted");
    expect(body.revealedSecrets).toBeUndefined();
    expect(provisionCalls()).toEqual([]);
    expect(getRepos().apiKeys.countByOperator(WALLET)).toBe(0);
    expect(getRepos().apiKeys.countByOperator(OTHER_WALLET)).toBe(0);

    // The hold is spent either way: a replay does not run it.
    drift.mockRestore();
    const replay = await chat({ conversationId: held.conversationId, confirmActionId: held.pendingActions[0].actionId }, session.bearer);
    expect(replay.statusCode).toBe(409);
    expect(provisionCalls()).toEqual([]);
  });

  it("another session of the same wallet confirms a held credential: the identity is the same wallet however it is cased, so nothing is refused (F3 by design)", async () => {
    const first = siwe(WALLET);
    const second = siwe(WALLET.toUpperCase().replace("0X", "0x")); // the same wallet, stored in another letter case
    llm.responses.push(calls(["provision_api_key", {}]), endTurn);
    const held = (await chat({ message: "sign me up" }, first.bearer)).json();
    expect(held.pendingActions[0]).toMatchObject({ bindsTo: WALLET });
    llm.responses.push(endTurn);
    const confirm = (await chat({ conversationId: held.conversationId, confirmActionId: held.pendingActions[0].actionId }, second.bearer)).json();
    expect(confirm.confirmedAction).toMatchObject({ tool: "provision_api_key", status: 201 });
    const reveal = (confirm.revealedSecrets as Array<{ path: string; value: string }>).find((r) => r.path === "$.api_key");
    expect(resolveApiKeyFromToken(reveal!.value)?.operatorId.toLowerCase()).toBe(WALLET);
  });

  it("[neg] confirming refuses with the route's own answer when the identity can no longer be resolved at all", async () => {
    const session = siwe(WALLET);
    llm.responses.push(calls(["provision_api_key", {}]), endTurn);
    const held = (await chat({ message: "sign me up" }, session.bearer)).json();
    spies.push(
      vi.spyOn(provisionIdentity, "selectProvisionIdentity").mockReturnValue({
        ok: false,
        status: 400,
        body: { error: "identifier_required", message: "nobody is named" },
      }),
    );
    llm.responses.push(endTurn);
    const body = (await chat({ conversationId: held.conversationId, confirmActionId: held.pendingActions[0].actionId }, session.bearer)).json();
    expect(body.confirmedAction).toMatchObject({ status: 400 });
    expect(body.toolCalls[0].result).toMatchObject({ error: "identifier_required" });
    expect(provisionCalls()).toEqual([]);
  });

  // ── redeem_invite: the account is the email, and nothing else ───────────────────

  it("a held redeem_invite names the email of the account, and ignores a wallet; without an email it is refused", async () => {
    const { rawKey } = provisionApiKey({ operatorId: "alice@example.com", scopes: ["operator"] });
    const asAlice = { authorization: `Bearer ${rawKey}` };
    llm.responses.push(calls(["redeem_invite", { inviteCode: "INV-1", email: NEW_EMAIL, password: "synthetic-pw" }]), endTurn);
    const held = (await chat({ message: "redeem it" }, asAlice)).json();
    expect(held.pendingActions[0]).toMatchObject({ tool: "redeem_invite", bindsTo: NEW_EMAIL });

    llm.responses.push(calls(["redeem_invite", { inviteCode: "INV-1", walletAddress: WALLET }]), endTurn);
    const refused = (await chat({ message: "redeem it" }, asAlice)).json();
    expect(refused.pendingActions).toBeUndefined();
    expect(refused.toolCalls[0]).toMatchObject({ status: 400, result: { error: "email_required" } });
  });

  // ── The route itself: one precedence, pinned where the chat and the route both read it ──

  describe("POST /api/auth/provision resolves its identity through the shared resolver", () => {
    const provision = (payload: Record<string, unknown>, headers: Headers = {}) =>
      app.inject({ method: "POST", url: "/api/auth/provision", payload, headers, remoteAddress: "198.51.100.92" });

    it("a proven wallet wins over an email in the same body", async () => {
      const session = siwe(WALLET);
      const res = await provision({ email: NEW_EMAIL, walletAddress: WALLET }, session.bearer);
      expect(res.statusCode).toBe(201);
      expect(res.json().operator_id).toBe(WALLET);
    });

    it("an explicit email wins over an ambient session", async () => {
      const session = siwe(WALLET);
      const res = await provision({ email: NEW_EMAIL }, session.bearer);
      expect(res.statusCode).toBe(201);
      expect(res.json().operator_id).toBe(NEW_EMAIL);
    });

    it("a session with nothing named mints for the session's wallet; no session and nothing named is refused", async () => {
      const session = siwe(WALLET);
      const ok = await provision({}, session.bearer);
      expect(ok.statusCode).toBe(201);
      expect(ok.json().operator_id).toBe(WALLET);
      const none = await provision({});
      expect(none.statusCode).toBe(400);
      expect(none.json().error).toBe("identifier_required");
    });
  });
});
