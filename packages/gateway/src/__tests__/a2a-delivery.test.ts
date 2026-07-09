/**
 * A2A delivery transport tests (signed-task wiring, agent-subnet notification
 * channel).
 *
 * The courier/operator runs the PCC agent package (Claude Code) and
 * registers on the PCC subnet. When a job matches their capability, they
 * should be pinged via a signed A2A task — not SMS/email/credential — and
 * the notification channel should be auto-registered when they onboard, so
 * it's automatic for agent operators. These tests pin that behaviour,
 * mirroring sms-delivery.test.ts's / email-delivery.test.ts's structure:
 *
 *   - resolveA2aTransport: gating on the gateway's OWN agent-card signing
 *     key (../signing-key.ts, PCC_AGENT_CARD_SIGNING_KEY) — no key -> null,
 *     never a fake success.
 *   - PccAgentTaskTransport.send: builds a JSON-RPC 2.0 tasks/send envelope
 *     identical in shape to routes/a2a-tasks.ts's own inbound parser, signs
 *     it with the REAL @pcc/a2a-signing signAgentCard (a generated ES256 test
 *     key, round-tripped through verifyAgentCard to prove it isn't
 *     hand-rolled), and extracts the RECEIVING agent's task id from the
 *     response — never a self-minted id.
 *   - attachChannel: endpoint.agentId + endpoint.endpoint validation for
 *     transport "a2a" (absolute http(s) URL required).
 *   - dispatchToChannels a2a path: SENDS when a transport is configured
 *     (fake injected) -> delivered:true, ref = the real task id; honest
 *     NOT-configured (no signing key) -> delivered:false, error
 *     "a2a_not_configured"; the target agent rejecting -> send_failed.
 *   - autoRegisterA2aChannel: the onboarding-hook primitive — idempotent per
 *     (operatorSlug, agentId), self-heals on endpoint rotation, never
 *     throws.
 *   - POST /api/agents/heartbeat: the second onboarding-hook trigger
 *     ("...or heartbeats") — optional operatorSlug + agentEndpoint on any
 *     heartbeat auto-registers/refreshes the channel, independent of
 *     whether the ASI10 liveness monitor happens to be initialized.
 *
 * Unlike sms-delivery.test.ts / email-delivery.test.ts, this file is NOT
 * workspace-isolated — reusing @pcc/a2a-signing's REAL signer (per the "do
 * NOT hand-roll signing" instruction) means it depends on that package's
 * built dist/, exactly like well-known-signed.test.ts already does.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { generateKeyPair, exportPKCS8 } from "jose";
import { verifyAgentCard } from "@pcc/a2a-signing";
import {
  attachChannel,
  dispatchToChannels,
  getChannelsByOperator,
  autoRegisterA2aChannel,
  _clearOperatorChannelsForTests,
} from "../routes/operator-channels.js";
import {
  resolveA2aTransport,
  PccAgentTaskTransport,
  A2aSendError,
  __setA2aTransportForTests,
  DEFAULT_A2A_SKILL,
  type A2aTransport,
  type A2aTaskMessage,
} from "../services/a2a-transport.js";
import { initSigningKey, _resetForTests } from "../signing-key.js";
import { agentHeartbeatRoutes } from "../routes/agent-heartbeat.js";

const ENV_KEY = "PCC_AGENT_CARD_SIGNING_KEY";
const ENV_KID = "PCC_AGENT_CARD_SIGNING_KID";

/** A fake transport that records what it was asked to send and returns a canned id. */
function fakeA2aTransport(id = "fake-a2a-task-123"): A2aTransport & { sent: A2aTaskMessage[] } {
  const sent: A2aTaskMessage[] = [];
  return {
    provider: "fake",
    sent,
    async send(msg: A2aTaskMessage) {
      sent.push(msg);
      return { id, provider: "fake" };
    },
  };
}

/** Generate a fresh ES256 signing key and load it into signing-key.ts's module cache. */
async function loadTestSigningKey(kid = "test-a2a-kid"): Promise<void> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  process.env[ENV_KEY] = await exportPKCS8(privateKey);
  process.env[ENV_KID] = kid;
  _resetForTests();
  await initSigningKey();
}

function clearTestSigningKey(): void {
  delete process.env[ENV_KEY];
  delete process.env[ENV_KID];
  _resetForTests();
}

// Global isolation: clear channels + transport override + signing key
// between every test so no override/key/env leaks across tests.
beforeEach(() => {
  _clearOperatorChannelsForTests();
  __setA2aTransportForTests(undefined);
  clearTestSigningKey();
});

afterEach(() => {
  _clearOperatorChannelsForTests();
  __setA2aTransportForTests(undefined);
  clearTestSigningKey();
});

// ── resolveA2aTransport: signing-key gating ──────────────────────────────────

describe("resolveA2aTransport (signing-key gating)", () => {
  it("returns null when no signing key is loaded (this build env)", () => {
    expect(resolveA2aTransport()).toBeNull();
  });

  it("returns a transport once a signing key is loaded", async () => {
    await loadTestSigningKey();
    const t = resolveA2aTransport();
    expect(t).not.toBeNull();
    expect(t).toBeInstanceOf(PccAgentTaskTransport);
    expect(t!.provider).toBe("pcc-a2a");
  });

  it("returns null again after the signing key is cleared", async () => {
    await loadTestSigningKey();
    expect(resolveA2aTransport()).not.toBeNull();
    clearTestSigningKey();
    expect(resolveA2aTransport()).toBeNull();
  });
});

// ── PccAgentTaskTransport.send: real signing, injected fetch — no network ───

describe("PccAgentTaskTransport.send (real signing, injected fetch — no network)", () => {
  it("POSTs a signed JSON-RPC tasks/send envelope and returns the receiver's task id", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const sent = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: sent.id,
          result: { id: "a2a-task-recv-001", state: "COMPLETED" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const t = new PccAgentTaskTransport(
      privateKey,
      "test-kid",
      "https://test.capability.network/.well-known/jwks.json",
      fakeFetch,
    );
    const res = await t.send({
      to: "https://courier-agent.example.com/a2a/tasks/send",
      agentId: "agent-courier-1",
      params: { jobId: "job-1", contextRef: "/api/job-offers/job-1", summary: "New courier job available" },
    });

    expect(res).toEqual({ id: "a2a-task-recv-001", provider: "pcc-a2a" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://courier-agent.example.com/a2a/tasks/send");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");

    const sentBody = JSON.parse(String(calls[0]!.init.body));
    expect(sentBody.jsonrpc).toBe("2.0");
    expect(sentBody.method).toBe("tasks/send");
    expect(sentBody.params.skill).toBe(DEFAULT_A2A_SKILL);
    expect(sentBody.params.params.jobId).toBe("job-1");
    expect(sentBody.params.params.agentId).toBe("agent-courier-1");

    // The envelope is genuinely signed — reuses @pcc/a2a-signing, not
    // hand-rolled. Round-trip through the real verifier to prove it.
    expect(Array.isArray(sentBody.signatures)).toBe(true);
    expect(sentBody.signatures).toHaveLength(1);
    const verified = await verifyAgentCard(sentBody, { key: publicKey });
    expect(verified.valid).toBe(true);
    expect(verified.card?.method).toBe("tasks/send");
  });

  it("honors a custom skill name", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const fakeFetch = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { id: "task-custom" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const t = new PccAgentTaskTransport(privateKey, "kid", "https://x.example.com/jwks.json", fakeFetch);
    const res = await t.send({
      to: "https://x.example.com/a2a/tasks/send",
      agentId: "a1",
      skill: "pcc-custom-skill",
      params: {},
    });
    expect(res.id).toBe("task-custom");
  });

  it("throws A2aSendError on a non-2xx response", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const fakeFetch = (async () => new Response("gateway timeout", { status: 504 })) as unknown as typeof fetch;
    const t = new PccAgentTaskTransport(privateKey, "kid", "https://x.example.com/jwks.json", fakeFetch);
    await expect(
      t.send({ to: "https://x.example.com/a2a/tasks/send", agentId: "a1", params: {} }),
    ).rejects.toBeInstanceOf(A2aSendError);
  });

  it("throws A2aSendError when the receiving agent returns a JSON-RPC error", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const fakeFetch = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "unknown skill" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const t = new PccAgentTaskTransport(privateKey, "kid", "https://x.example.com/jwks.json", fakeFetch);
    await expect(
      t.send({ to: "https://x.example.com/a2a/tasks/send", agentId: "a1", params: {} }),
    ).rejects.toThrow(/unknown skill/);
  });

  it("throws A2aSendError when the success response is missing result.id", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: { state: "WORKING" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const t = new PccAgentTaskTransport(privateKey, "kid", "https://x.example.com/jwks.json", fakeFetch);
    await expect(
      t.send({ to: "https://x.example.com/a2a/tasks/send", agentId: "a1", params: {} }),
    ).rejects.toThrow(/result\.id/);
  });

  it("throws A2aSendError on a non-JSON response body", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const fakeFetch = (async () => new Response("<html>not json</html>", { status: 200 })) as unknown as typeof fetch;
    const t = new PccAgentTaskTransport(privateKey, "kid", "https://x.example.com/jwks.json", fakeFetch);
    await expect(
      t.send({ to: "https://x.example.com/a2a/tasks/send", agentId: "a1", params: {} }),
    ).rejects.toThrow(/non-JSON/);
  });
});

// ── attachChannel: a2a endpoint.agentId/endpoint.endpoint validation ────────

describe("attachChannel — a2a endpoint.agentId/endpoint.endpoint validation", () => {
  it("attaches an a2a channel with a valid agentId + http(s) endpoint", () => {
    const ch = attachChannel("op-a2a-1", {
      label: "Courier's own agent",
      transport: "a2a",
      describe: "Push signed A2A tasks to the courier's own registered agent",
      endpoint: { agentId: "agent-courier-1", endpoint: "https://courier-agent.example.com/a2a/tasks/send" },
    });
    expect(ch.transport).toBe("a2a");
    expect((ch.endpoint as { agentId: string }).agentId).toBe("agent-courier-1");
  });

  it("rejects an a2a channel with no endpoint at all", () => {
    expect(() =>
      attachChannel("op-a2a-2", { label: "x", transport: "a2a", describe: "notify my agent" }),
    ).toThrow(/agentId/);
  });

  it("rejects an a2a channel missing endpoint.endpoint", () => {
    expect(() =>
      attachChannel("op-a2a-3", {
        label: "x",
        transport: "a2a",
        describe: "notify my agent",
        endpoint: { agentId: "a1" },
      }),
    ).toThrow(/agentId/);
  });

  it("rejects an a2a channel missing endpoint.agentId", () => {
    expect(() =>
      attachChannel("op-a2a-4", {
        label: "x",
        transport: "a2a",
        describe: "notify my agent",
        endpoint: { endpoint: "https://x.example.com/a2a/tasks/send" },
      }),
    ).toThrow(/agentId/);
  });

  it("rejects a non-http(s) endpoint URL", () => {
    expect(() =>
      attachChannel("op-a2a-5", {
        label: "x",
        transport: "a2a",
        describe: "notify my agent",
        endpoint: { agentId: "a1", endpoint: "ftp://example.com/a2a" },
      }),
    ).toThrow(/agentId/);
  });

  it("rejects a malformed (unparseable) endpoint URL", () => {
    expect(() =>
      attachChannel("op-a2a-6", {
        label: "x",
        transport: "a2a",
        describe: "notify my agent",
        endpoint: { agentId: "a1", endpoint: "not-a-url" },
      }),
    ).toThrow(/agentId/);
  });

  it("the thrown error carries code invalid_endpoint", () => {
    try {
      attachChannel("op-a2a-7", { label: "x", transport: "a2a", describe: "notify my agent", endpoint: {} });
      expect.unreachable("attachChannel should have thrown");
    } catch (e) {
      expect((e as Error & { code?: string }).code).toBe("invalid_endpoint");
    }
  });

  it("does not apply a2a validation to other transports", () => {
    const ch = attachChannel("op-a2a-8", {
      label: "Printer",
      transport: "webhook",
      describe: "POST JSON to the receipt printer",
      endpoint: { url: "http://10.0.0.5/print" },
    });
    expect(ch.transport).toBe("webhook");
  });
});

// ── dispatchToChannels: the a2a path ─────────────────────────────────────────

describe("dispatchToChannels — a2a path", () => {
  it("SENDS and returns the receiver's real task id as ref when a transport is configured", async () => {
    const fake = fakeA2aTransport("a2a-task-provider-001");
    __setA2aTransportForTests(fake);
    attachChannel("shop-a2a", {
      label: "Courier's agent",
      transport: "a2a",
      describe: "Push signed A2A tasks to the courier's registered agent",
      endpoint: { agentId: "agent-1", endpoint: "https://courier.example.com/a2a/tasks/send" },
    });

    const res = await dispatchToChannels("shop-a2a", {
      jobId: "j_a2a_1",
      contextRef: "ctx",
      summary: "New courier job available",
      priceUSD: 12,
    });

    expect(res).toHaveLength(1);
    expect(res[0]!.transport).toBe("a2a");
    expect(res[0]!.delivered).toBe(true);
    expect(res[0]!.ref).toBe("a2a-task-provider-001");
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.to).toBe("https://courier.example.com/a2a/tasks/send");
    expect(fake.sent[0]!.agentId).toBe("agent-1");
    expect(fake.sent[0]!.params.jobId).toBe("j_a2a_1");
    expect(fake.sent[0]!.params.priceUSD).toBe(12);
  });

  it("returns an explicit not-configured error (no fake success) when no signing key is loaded", async () => {
    // No override, no signing key loaded (cleared in beforeEach) -> getA2aTransport
    // falls through to resolveA2aTransport(), which returns null.
    attachChannel("shop-a2a-2", {
      label: "Courier's agent",
      transport: "a2a",
      describe: "notify",
      endpoint: { agentId: "agent-2", endpoint: "https://x.example.com/a2a/tasks/send" },
    });
    const res = await dispatchToChannels("shop-a2a-2", { jobId: "j2", contextRef: "ctx", summary: "New job" });
    expect(res).toHaveLength(1);
    expect(res[0]!.delivered).toBe(false);
    expect(res[0]!.error).toBe("a2a_not_configured");
    expect(res[0]!.ref).toBeUndefined();
  });

  it("reports send_failed (not a crash) when the operator's agent is unreachable/rejects — fail closed", async () => {
    __setA2aTransportForTests({
      provider: "boom",
      async send() {
        throw new A2aSendError("a2a HTTP 404: not found");
      },
    });
    attachChannel("shop-a2a-3", {
      label: "Courier's agent",
      transport: "a2a",
      describe: "notify",
      endpoint: { agentId: "agent-3", endpoint: "https://x.example.com/a2a/tasks/send" },
    });
    const res = await dispatchToChannels("shop-a2a-3", { jobId: "j3", contextRef: "c", summary: "s" });
    expect(res[0]!.delivered).toBe(false);
    expect(res[0]!.error).toBe("send_failed");
    expect(res[0]!.warning).toContain("404");
  });

  it("an operator with NO a2a channel attached (agent not registered) gets no a2a dispatch attempt", async () => {
    const fake = fakeA2aTransport();
    __setA2aTransportForTests(fake);
    // shop-a2a-4 has zero channels attached -> dispatchToChannels short-circuits
    // to the manual "no-channels-attached" placeholder, never touching a2a.
    const res = await dispatchToChannels("shop-a2a-4", { jobId: "j4", contextRef: "c", summary: "s" });
    expect(res).toHaveLength(1);
    expect(res[0]!.transport).toBe("manual");
    expect(fake.sent).toHaveLength(0);
  });
});

// ── autoRegisterA2aChannel: the onboarding/heartbeat hook primitive ─────────

describe("autoRegisterA2aChannel — idempotent onboarding/heartbeat hook", () => {
  it("attaches a new a2a channel for a fresh operator", () => {
    const ch = autoRegisterA2aChannel("op-onboard-1", "agent-1", "https://agent1.example.com/a2a/tasks/send");
    expect(ch).not.toBeNull();
    expect(ch!.transport).toBe("a2a");
    expect(getChannelsByOperator("op-onboard-1")).toHaveLength(1);
  });

  it("an exact repeat registration is a true no-op (same record, no duplicate)", () => {
    const first = autoRegisterA2aChannel("op-onboard-2", "agent-2", "https://agent2.example.com/a2a/tasks/send");
    const second = autoRegisterA2aChannel("op-onboard-2", "agent-2", "https://agent2.example.com/a2a/tasks/send");
    expect(second!.id).toBe(first!.id);
    expect(getChannelsByOperator("op-onboard-2")).toHaveLength(1);
  });

  it("the same agentId re-registering with a NEW endpoint refreshes in place (self-heal)", () => {
    const first = autoRegisterA2aChannel(
      "op-onboard-3",
      "agent-3",
      "https://old-endpoint.example.com/a2a/tasks/send",
    );
    const second = autoRegisterA2aChannel(
      "op-onboard-3",
      "agent-3",
      "https://new-endpoint.example.com/a2a/tasks/send",
    );
    expect(second!.id).toBe(first!.id); // same channel, updated in place
    expect((second!.endpoint as { endpoint: string }).endpoint).toBe(
      "https://new-endpoint.example.com/a2a/tasks/send",
    );
    expect(getChannelsByOperator("op-onboard-3")).toHaveLength(1); // no duplicate
  });

  it("a different agentId for the same operator creates a SEPARATE channel", () => {
    autoRegisterA2aChannel("op-onboard-4", "agent-4a", "https://agent4a.example.com/a2a/tasks/send");
    autoRegisterA2aChannel("op-onboard-4", "agent-4b", "https://agent4b.example.com/a2a/tasks/send");
    expect(getChannelsByOperator("op-onboard-4")).toHaveLength(2);
  });

  it("returns null (never throws) for a malformed endpoint", () => {
    expect(autoRegisterA2aChannel("op-onboard-5", "agent-5", "not-a-url")).toBeNull();
    expect(getChannelsByOperator("op-onboard-5")).toHaveLength(0);
  });

  it("returns null for missing arguments rather than throwing", () => {
    expect(autoRegisterA2aChannel("", "agent-6", "https://x.example.com/a2a")).toBeNull();
    expect(autoRegisterA2aChannel("op-onboard-6", "", "https://x.example.com/a2a")).toBeNull();
    expect(autoRegisterA2aChannel("op-onboard-6", "agent-6", "")).toBeNull();
    expect(getChannelsByOperator("op-onboard-6")).toHaveLength(0);
  });
});

// ── POST /api/agents/heartbeat: the second onboarding-hook trigger ─────────

describe("POST /api/agents/heartbeat — A2A channel auto-registration", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(agentHeartbeatRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("auto-registers an a2a channel when operatorSlug + agentEndpoint are supplied", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/heartbeat",
      payload: {
        agentId: "agent-courier-hb-1",
        operatorSlug: "op-hb-1",
        agentEndpoint: "https://courier-agent.example.com/a2a/tasks/send",
      },
    });
    expect(res.statusCode).toBe(200);
    // Isolated test app — no agent-bridge/heartbeat-monitor init, so the
    // pre-existing heartbeat behaviour degrades gracefully as documented.
    expect(res.json().note).toBe("monitor_not_ready");

    const channels = getChannelsByOperator("op-hb-1");
    expect(channels).toHaveLength(1);
    expect(channels[0]!.transport).toBe("a2a");
    expect((channels[0]!.endpoint as { agentId: string }).agentId).toBe("agent-courier-hb-1");
    expect((channels[0]!.endpoint as { endpoint: string }).endpoint).toBe(
      "https://courier-agent.example.com/a2a/tasks/send",
    );
  });

  it("a second identical heartbeat does not create a duplicate channel", async () => {
    const payload = {
      agentId: "agent-courier-hb-2",
      operatorSlug: "op-hb-2",
      agentEndpoint: "https://courier-agent-2.example.com/a2a/tasks/send",
    };
    await app.inject({ method: "POST", url: "/api/agents/heartbeat", payload });
    await app.inject({ method: "POST", url: "/api/agents/heartbeat", payload });
    expect(getChannelsByOperator("op-hb-2")).toHaveLength(1);
  });

  it("omitting operatorSlug/agentEndpoint is a no-op (pre-existing heartbeat behaviour unchanged)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/heartbeat",
      payload: { agentId: "agent-plain-hb" },
    });
    expect(res.statusCode).toBe(200);
    expect(getChannelsByOperator("agent-plain-hb")).toHaveLength(0);
  });

  it("still 400s when agentId is missing, even with operatorSlug/agentEndpoint present", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/heartbeat",
      payload: { operatorSlug: "op-hb-3", agentEndpoint: "https://x.example.com/a2a/tasks/send" },
    });
    expect(res.statusCode).toBe(400);
    expect(getChannelsByOperator("op-hb-3")).toHaveLength(0);
  });
});
