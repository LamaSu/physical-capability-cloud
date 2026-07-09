/**
 * Email delivery transport tests (bug B5).
 *
 * B5: the operator-channels dispatch path used to return a fake
 * `delivered:true, ref:"stub:transport-not-wired"` for the email transport, so an
 * operator who attached an email channel and ran a delivery test was told it
 * worked while NO email ever sent. These tests pin the fixed behaviour:
 *
 *   - resolveEmailTransport: env gating (RESEND_API_KEY present/absent/blank,
 *     SMTP_URL reserved-but-not-wired).
 *   - ResendTransport.send: request shape (auth header, recipient, body) +
 *     provider-id parsing + error paths, via an injected fetch (no network).
 *   - dispatchToChannels email path: SENDS when a transport is configured (fake
 *     injected) → delivered:true, ref = the real provider id (never the stub);
 *     honest NOT-configured → delivered:false, error "email_not_configured",
 *     never a fake success.
 *   - The same two paths through the real HTTP /channels/test route.
 *   - Unwired transports (voice/push/mqtt/file) are now honest
 *     (delivered:false), not fake. (sms is now wired too -- see
 *     sms-delivery.test.ts for its equivalent coverage; it is deliberately
 *     no longer in the "unwired" loop below.)
 *
 * Deliberately isolated from the rest of the gateway suite: imports only
 * operator-channels.js (node:crypto + a type-only fastify import + the new
 * email-transport.js) and email-transport.js (zero imports). No @pcc workspace
 * package is loaded, so this file runs without building @pcc/spec or @pcc/store.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  attachChannel,
  dispatchToChannels,
  operatorChannelsRoutes,
  _clearOperatorChannelsForTests,
} from "../routes/operator-channels.js";
import {
  resolveEmailTransport,
  ResendTransport,
  EmailSendError,
  __setEmailTransportForTests,
  type EmailTransport,
  type EmailMessage,
} from "../services/email-transport.js";

/** A fake transport that records what it was asked to send and returns a canned id. */
function fakeTransport(id = "fake-msg-id-123"): EmailTransport & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    provider: "fake",
    sent,
    async send(msg: EmailMessage) {
      sent.push(msg);
      return { id, provider: "fake" };
    },
  };
}

// Global isolation: clear channels + transport override + provider env between
// every test so neither an override nor a stray env key leaks across tests.
beforeEach(() => {
  _clearOperatorChannelsForTests();
  __setEmailTransportForTests(undefined);
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
});

afterEach(() => {
  __setEmailTransportForTests(undefined);
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
});

// ── resolveEmailTransport: env gating ────────────────────────────────────────

describe("resolveEmailTransport (env gating)", () => {
  it("returns null when no provider env is set (this build env)", () => {
    expect(resolveEmailTransport({})).toBeNull();
  });

  it("returns null when only SMTP_URL is set (reserved, not yet wired)", () => {
    expect(resolveEmailTransport({ SMTP_URL: "smtp://user:pass@host:587" })).toBeNull();
  });

  it("ignores a blank/whitespace RESEND_API_KEY", () => {
    expect(resolveEmailTransport({ RESEND_API_KEY: "   " })).toBeNull();
  });

  it("returns a Resend transport when RESEND_API_KEY is set", () => {
    const t = resolveEmailTransport({ RESEND_API_KEY: "re_test_key" });
    expect(t).not.toBeNull();
    expect(t).toBeInstanceOf(ResendTransport);
    expect(t!.provider).toBe("resend");
  });
});

// ── ResendTransport.send: request shape + parsing, no live network ───────────

describe("ResendTransport.send (injected fetch — no network)", () => {
  it("POSTs to Resend with bearer auth and returns the provider message id", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "resend-abc-789" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const t = new ResendTransport("re_live_secret", "From <a@b.com>", fakeFetch);
    const res = await t.send({ to: "ops@shop.com", subject: "Subj", text: "Body" });

    expect(res).toEqual({ id: "resend-abc-789", provider: "resend" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer re_live_secret");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.to).toEqual(["ops@shop.com"]);
    expect(body.from).toBe("From <a@b.com>");
    expect(body.subject).toBe("Subj");
    expect(body.text).toBe("Body");
  });

  it("throws EmailSendError on a non-2xx provider response", async () => {
    const fakeFetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    const t = new ResendTransport("re_bad", undefined, fakeFetch);
    await expect(t.send({ to: "x@y.com", subject: "s", text: "t" })).rejects.toBeInstanceOf(
      EmailSendError,
    );
  });

  it("throws EmailSendError when the success body has no id", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const t = new ResendTransport("re_ok", undefined, fakeFetch);
    await expect(t.send({ to: "x@y.com", subject: "s", text: "t" })).rejects.toThrow(
      /missing message id/,
    );
  });
});

// ── dispatchToChannels: the email path (core B5 acceptance) ──────────────────

describe("dispatchToChannels — email path (B5)", () => {
  it("SENDS and returns the provider id as ref when a transport is configured", async () => {
    const fake = fakeTransport("provider-msg-001");
    __setEmailTransportForTests(fake);
    attachChannel("shop-email", {
      label: "Owner inbox",
      transport: "email",
      describe: "Email the owner on every new order with the job summary",
      endpoint: { address: "thespacekyd@gmail.com" },
    });

    const res = await dispatchToChannels("shop-email", {
      jobId: "j_email_1",
      contextRef: "ctx",
      summary: "New order: large pepperoni",
      priceUSD: 18,
    });

    expect(res).toHaveLength(1);
    expect(res[0]!.transport).toBe("email");
    expect(res[0]!.delivered).toBe(true);
    expect(res[0]!.ref).toBe("provider-msg-001");
    // The whole point of B5: ref is a real provider id, never the stub.
    expect(res[0]!.ref).not.toBe("stub:transport-not-wired");
    // It actually composed and handed a message to the transport.
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.to).toBe("thespacekyd@gmail.com");
    expect(fake.sent[0]!.subject).toContain("j_email_1");
    expect(fake.sent[0]!.text).toContain("New order: large pepperoni");
  });

  it("returns an explicit not-configured error (no fake success) when override is null", async () => {
    __setEmailTransportForTests(null); // simulate "no provider configured"
    attachChannel("shop-email-2", {
      label: "Owner inbox",
      transport: "email",
      describe: "Email the owner on every new order",
      endpoint: { address: "thespacekyd@gmail.com" },
    });

    const res = await dispatchToChannels("shop-email-2", {
      jobId: "j_email_2",
      contextRef: "ctx",
      summary: "New order",
    });

    expect(res).toHaveLength(1);
    expect(res[0]!.delivered).toBe(false);
    expect(res[0]!.error).toBe("email_not_configured");
    expect(res[0]!.ref).toBeUndefined();
    expect(res[0]!.ref).not.toBe("stub:transport-not-wired");
  });

  it("is not-configured by default via the REAL env path (no key set)", async () => {
    // No override (cleared in beforeEach) → getEmailTransport falls through to
    // resolveEmailTransport(process.env), which has no RESEND_API_KEY here.
    attachChannel("shop-email-3", {
      label: "Inbox",
      transport: "email",
      describe: "Email the owner on every order arrival",
      endpoint: { address: "thespacekyd@gmail.com" },
    });
    const res = await dispatchToChannels("shop-email-3", {
      jobId: "j3",
      contextRef: "ctx",
      summary: "x",
    });
    expect(res[0]!.delivered).toBe(false);
    expect(res[0]!.error).toBe("email_not_configured");
  });

  it("flags an email channel that has no endpoint.address", async () => {
    __setEmailTransportForTests(fakeTransport());
    attachChannel("shop-email-4", {
      label: "Bad",
      transport: "email",
      describe: "Email but the address is missing",
      endpoint: {},
    });
    const res = await dispatchToChannels("shop-email-4", {
      jobId: "j4",
      contextRef: "c",
      summary: "s",
    });
    expect(res[0]!.delivered).toBe(false);
    expect(res[0]!.error).toBe("invalid_endpoint");
  });

  it("reports send_failed (not a crash) when the configured provider rejects", async () => {
    __setEmailTransportForTests({
      provider: "boom",
      async send() {
        throw new EmailSendError("resend HTTP 422: invalid recipient");
      },
    });
    attachChannel("shop-email-5", {
      label: "Inbox",
      transport: "email",
      describe: "Email the owner on each order",
      endpoint: { address: "x@y.com" },
    });
    const res = await dispatchToChannels("shop-email-5", {
      jobId: "j5",
      contextRef: "c",
      summary: "s",
    });
    expect(res[0]!.delivered).toBe(false);
    expect(res[0]!.error).toBe("send_failed");
    expect(res[0]!.warning).toContain("422");
  });
});

// ── unwired transports must be honest too (no fake stub success) ─────────────

describe("dispatchToChannels — unwired transports are honest (B5)", () => {
  for (const transport of ["voice", "push", "mqtt", "file"] as const) {
    it(`${transport} returns delivered:false with no stub ref`, async () => {
      attachChannel(`shop-${transport}`, {
        label: `${transport} channel`,
        transport,
        describe: `Reach the operator via ${transport} on each new order`,
        endpoint: {},
      });
      const res = await dispatchToChannels(`shop-${transport}`, {
        jobId: `j_${transport}`,
        contextRef: "c",
        summary: "s",
      });
      expect(res[0]!.delivered).toBe(false);
      expect(res[0]!.error).toBe("transport_not_implemented");
      expect(res[0]!.ref).toBeUndefined();
      expect(res[0]!.ref).not.toBe("stub:transport-not-wired");
    });
  }
});

// ── HTTP route: POST /api/operators/:slug/channels/test ──────────────────────

describe("POST /api/operators/:slug/channels/test — email through the route", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(operatorChannelsRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns delivered:true with the provider ref when configured", async () => {
    __setEmailTransportForTests(fakeTransport("route-msg-77"));
    attachChannel("route-shop", {
      label: "Inbox",
      transport: "email",
      describe: "Email the owner when a new order lands",
      endpoint: { address: "thespacekyd@gmail.com" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/operators/route-shop/channels/test",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results[0].delivered).toBe(true);
    expect(body.results[0].ref).toBe("route-msg-77");
    expect(body.results[0].ref).not.toBe("stub:transport-not-wired");
  });

  it("returns delivered:false + email_not_configured when no provider is set", async () => {
    __setEmailTransportForTests(null);
    attachChannel("route-shop-2", {
      label: "Inbox",
      transport: "email",
      describe: "Email the owner when a new order lands",
      endpoint: { address: "thespacekyd@gmail.com" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/operators/route-shop-2/channels/test",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results[0].delivered).toBe(false);
    expect(body.results[0].error).toBe("email_not_configured");
  });
});
