/**
 * SMS delivery transport tests (Twilio wiring, follow-on to bug B5).
 *
 * B5 fixed the email transport and left sms/voice/push/mqtt/file honestly
 * unimplemented (delivered:false, error "transport_not_implemented" — never
 * the old fake `stub:transport-not-wired` success). This change wires a real
 * Twilio-backed provider behind the sms path specifically. These tests pin
 * the wired behaviour, mirroring email-delivery.test.ts's structure:
 *
 *   - resolveSmsTransport: env gating (all three of TWILIO_ACCOUNT_SID /
 *     TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER required; any missing -> null).
 *   - TwilioTransport.send: request shape (Basic auth header, form-urlencoded
 *     body, endpoint URL) + message-SID parsing + error paths, via an
 *     injected fetch (no network).
 *   - attachChannel: endpoint.phoneE164 validation for transport "sms"
 *     (E.164 required; missing/malformed -> invalid_endpoint).
 *   - dispatchToChannels sms path: SENDS when a transport is configured
 *     (fake injected) -> delivered:true, ref = the real Twilio message SID
 *     (never a stub); honest NOT-configured -> delivered:false, error
 *     "sms_not_configured", never a fake success.
 *   - The same two paths through the real HTTP /channels/test route.
 *
 * Deliberately isolated from the rest of the gateway suite, same pattern as
 * email-delivery.test.ts: imports only operator-channels.js (node:crypto +
 * a type-only fastify import + email-transport.js + the new sms-transport.js)
 * and sms-transport.js (zero imports). No @pcc workspace package is loaded,
 * so this file runs without building @pcc/spec or @pcc/store.
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
  resolveSmsTransport,
  TwilioTransport,
  SmsSendError,
  __setSmsTransportForTests,
  type SmsTransport,
  type SmsMessage,
} from "../services/sms-transport.js";

/** A fake transport that records what it was asked to send and returns a canned id. */
function fakeTransport(id = "fake-sms-id-123"): SmsTransport & { sent: SmsMessage[] } {
  const sent: SmsMessage[] = [];
  return {
    provider: "fake",
    sent,
    async send(msg: SmsMessage) {
      sent.push(msg);
      return { id, provider: "fake" };
    },
  };
}

// Global isolation: clear channels + transport override + provider env between
// every test so neither an override nor a stray env key leaks across tests.
beforeEach(() => {
  _clearOperatorChannelsForTests();
  __setSmsTransportForTests(undefined);
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM_NUMBER;
});

afterEach(() => {
  __setSmsTransportForTests(undefined);
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM_NUMBER;
});

// ── resolveSmsTransport: env gating ──────────────────────────────────────────

describe("resolveSmsTransport (env gating)", () => {
  it("returns null when no provider env is set (this build env)", () => {
    expect(resolveSmsTransport({})).toBeNull();
  });

  it("returns null when only TWILIO_ACCOUNT_SID is set", () => {
    expect(resolveSmsTransport({ TWILIO_ACCOUNT_SID: "ACxxx" })).toBeNull();
  });

  it("returns null when SID + token are set but TWILIO_FROM_NUMBER is missing", () => {
    expect(
      resolveSmsTransport({ TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "secret" }),
    ).toBeNull();
  });

  it("ignores a blank/whitespace TWILIO_FROM_NUMBER", () => {
    expect(
      resolveSmsTransport({
        TWILIO_ACCOUNT_SID: "ACxxx",
        TWILIO_AUTH_TOKEN: "secret",
        TWILIO_FROM_NUMBER: "   ",
      }),
    ).toBeNull();
  });

  it("returns a Twilio transport when all three env vars are set", () => {
    const t = resolveSmsTransport({
      TWILIO_ACCOUNT_SID: "ACxxx",
      TWILIO_AUTH_TOKEN: "secret",
      TWILIO_FROM_NUMBER: "+14155550100",
    });
    expect(t).not.toBeNull();
    expect(t).toBeInstanceOf(TwilioTransport);
    expect(t!.provider).toBe("twilio");
  });
});

// ── TwilioTransport.send: request shape + parsing, no live network ──────────

describe("TwilioTransport.send (injected fetch — no network)", () => {
  it("POSTs to the Twilio Messages API with Basic auth + form body, returns the SID", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ sid: "SMabc789" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const t = new TwilioTransport("ACtest123", "authtoken456", "+14155550100", fakeFetch);
    const res = await t.send({ to: "+14155559999", body: "New job available" });

    expect(res).toEqual({ id: "SMabc789", provider: "twilio" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/ACtest123/Messages.json",
    );
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from("ACtest123:authtoken456").toString("base64")}`,
    );
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(body.get("To")).toBe("+14155559999");
    expect(body.get("From")).toBe("+14155550100");
    expect(body.get("Body")).toBe("New job available");
  });

  it("honors a per-message From override", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ sid: "SMoverride" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const t = new TwilioTransport("ACx", "tok", "+14155550100", fakeFetch);
    const res = await t.send({ to: "+14155559999", body: "hi", from: "+14155550200" });
    expect(res.id).toBe("SMoverride");
  });

  it("throws SmsSendError on a non-2xx provider response", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ code: 21211, message: "invalid To number" }), {
        status: 400,
      })) as unknown as typeof fetch;
    const t = new TwilioTransport("ACbad", "tok", "+14155550100", fakeFetch);
    await expect(
      t.send({ to: "not-a-number", body: "t" }),
    ).rejects.toBeInstanceOf(SmsSendError);
  });

  it("throws SmsSendError when the success body has no sid", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ status: "queued" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const t = new TwilioTransport("ACok", "tok", "+14155550100", fakeFetch);
    await expect(t.send({ to: "+14155559999", body: "t" })).rejects.toThrow(
      /missing message sid/,
    );
  });
});

// ── attachChannel: E.164 validation for sms ──────────────────────────────────

describe("attachChannel — sms endpoint.phoneE164 validation", () => {
  beforeEach(() => _clearOperatorChannelsForTests());

  it("attaches an sms channel with a valid E.164 phone number", () => {
    const ch = attachChannel("op-sms-1", {
      label: "Driver phone",
      transport: "sms",
      describe: "Text the driver E.164 on every new courier job",
      endpoint: { phoneE164: "+14155551234" },
    });
    expect(ch.transport).toBe("sms");
    expect((ch.endpoint as { phoneE164: string }).phoneE164).toBe("+14155551234");
  });

  it("rejects an sms channel with no endpoint at all", () => {
    expect(() =>
      attachChannel("op-sms-2", {
        label: "Driver phone",
        transport: "sms",
        describe: "Text the driver on every new courier job",
      }),
    ).toThrow(/phoneE164/);
  });

  it("rejects an sms channel with an empty endpoint object", () => {
    expect(() =>
      attachChannel("op-sms-3", {
        label: "Driver phone",
        transport: "sms",
        describe: "Text the driver on every new courier job",
        endpoint: {},
      }),
    ).toThrow(/phoneE164/);
  });

  it("rejects a non-E.164 phone (missing +)", () => {
    expect(() =>
      attachChannel("op-sms-4", {
        label: "Driver phone",
        transport: "sms",
        describe: "Text the driver on every new courier job",
        endpoint: { phoneE164: "14155551234" },
      }),
    ).toThrow(/E\.164/);
  });

  it("rejects a non-E.164 phone (contains letters/punctuation)", () => {
    expect(() =>
      attachChannel("op-sms-5", {
        label: "Driver phone",
        transport: "sms",
        describe: "Text the driver on every new courier job",
        endpoint: { phoneE164: "+1 (415) 555-1234" },
      }),
    ).toThrow(/E\.164/);
  });

  it("the thrown error carries code invalid_endpoint", () => {
    try {
      attachChannel("op-sms-6", {
        label: "Driver phone",
        transport: "sms",
        describe: "Text the driver on every new courier job",
        endpoint: {},
      });
      expect.unreachable("attachChannel should have thrown");
    } catch (e) {
      expect((e as Error & { code?: string }).code).toBe("invalid_endpoint");
    }
  });

  it("does not apply sms validation to other transports", () => {
    // A webhook channel with no phoneE164 is unrelated and must attach fine.
    const ch = attachChannel("op-sms-7", {
      label: "Printer",
      transport: "webhook",
      describe: "POST JSON to the receipt printer",
      endpoint: { url: "http://10.0.0.5/print" },
    });
    expect(ch.transport).toBe("webhook");
  });
});

// ── dispatchToChannels: the sms path (Twilio wiring, this change) ────────────

describe("dispatchToChannels — sms path (Twilio)", () => {
  it("SENDS and returns the Twilio SID as ref when a transport is configured", async () => {
    const fake = fakeTransport("SM-provider-001");
    __setSmsTransportForTests(fake);
    attachChannel("shop-sms", {
      label: "Driver phone",
      transport: "sms",
      describe: "Text the driver on every new courier job",
      endpoint: { phoneE164: "+14155551234" },
    });

    const res = await dispatchToChannels("shop-sms", {
      jobId: "j_sms_1",
      contextRef: "ctx",
      summary: "New courier job available",
      priceUSD: 12,
    });

    expect(res).toHaveLength(1);
    expect(res[0]!.transport).toBe("sms");
    expect(res[0]!.delivered).toBe(true);
    expect(res[0]!.ref).toBe("SM-provider-001");
    // The whole point of this change: ref is a real provider id, never a stub.
    expect(res[0]!.ref).not.toBe("stub:transport-not-wired");
    // It actually composed and handed a message to the transport.
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.to).toBe("+14155551234");
    expect(fake.sent[0]!.body).toContain("j_sms_1");
    expect(fake.sent[0]!.body).toContain("New courier job available");
  });

  it("returns an explicit not-configured error (no fake success) when override is null", async () => {
    __setSmsTransportForTests(null); // simulate "no provider configured"
    attachChannel("shop-sms-2", {
      label: "Driver phone",
      transport: "sms",
      describe: "Text the driver on every new courier job",
      endpoint: { phoneE164: "+14155551234" },
    });

    const res = await dispatchToChannels("shop-sms-2", {
      jobId: "j_sms_2",
      contextRef: "ctx",
      summary: "New courier job",
    });

    expect(res).toHaveLength(1);
    expect(res[0]!.delivered).toBe(false);
    expect(res[0]!.error).toBe("sms_not_configured");
    expect(res[0]!.ref).toBeUndefined();
    expect(res[0]!.ref).not.toBe("stub:transport-not-wired");
  });

  it("is not-configured by default via the REAL env path (no TWILIO_* vars set)", async () => {
    // No override (cleared in beforeEach) -> getSmsTransport falls through to
    // resolveSmsTransport(process.env), which has no TWILIO_* vars here.
    attachChannel("shop-sms-3", {
      label: "Driver phone",
      transport: "sms",
      describe: "Text the driver on every new courier job",
      endpoint: { phoneE164: "+14155551234" },
    });
    const res = await dispatchToChannels("shop-sms-3", {
      jobId: "j3",
      contextRef: "ctx",
      summary: "x",
    });
    expect(res[0]!.delivered).toBe(false);
    expect(res[0]!.error).toBe("sms_not_configured");
  });

  it("reports send_failed (not a crash) when the configured provider rejects", async () => {
    __setSmsTransportForTests({
      provider: "boom",
      async send() {
        throw new SmsSendError("twilio HTTP 400: invalid To number");
      },
    });
    attachChannel("shop-sms-5", {
      label: "Driver phone",
      transport: "sms",
      describe: "Text the driver on every new courier job",
      endpoint: { phoneE164: "+14155551234" },
    });
    const res = await dispatchToChannels("shop-sms-5", {
      jobId: "j5",
      contextRef: "c",
      summary: "s",
    });
    expect(res[0]!.delivered).toBe(false);
    expect(res[0]!.error).toBe("send_failed");
    expect(res[0]!.warning).toContain("400");
  });
});

// ── HTTP route: POST /api/operators/:slug/channels/test ──────────────────────

describe("POST /api/operators/:slug/channels/test — sms through the route", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(operatorChannelsRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns delivered:true with the Twilio SID when configured", async () => {
    __setSmsTransportForTests(fakeTransport("route-sms-77"));
    attachChannel("route-shop-sms", {
      label: "Driver phone",
      transport: "sms",
      describe: "Text the driver when a new job lands",
      endpoint: { phoneE164: "+14155551234" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/operators/route-shop-sms/channels/test",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results[0].delivered).toBe(true);
    expect(body.results[0].ref).toBe("route-sms-77");
    expect(body.results[0].ref).not.toBe("stub:transport-not-wired");
  });

  it("returns delivered:false + sms_not_configured when no provider is set", async () => {
    __setSmsTransportForTests(null);
    attachChannel("route-shop-sms-2", {
      label: "Driver phone",
      transport: "sms",
      describe: "Text the driver when a new job lands",
      endpoint: { phoneE164: "+14155551234" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/operators/route-shop-sms-2/channels/test",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results[0].delivered).toBe(false);
    expect(body.results[0].error).toBe("sms_not_configured");
  });

  it("rejects an sms channel attach with a malformed phone via 400 invalid_endpoint", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/operators/route-shop-sms-3/channels",
      payload: {
        label: "Driver phone",
        transport: "sms",
        describe: "Text the driver when a new job lands",
        endpoint: { phoneE164: "555-1234" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_endpoint");
  });
});
