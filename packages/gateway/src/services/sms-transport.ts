/**
 * SMS delivery transport for operator notification channels.
 *
 * Couriers and other field operators often have no app and no inbox they
 * check promptly — a phone that can receive a text is often the only
 * reliable channel PCC has for them. The auto-notify trigger
 * (services/job-offer-notifier.ts) already calls dispatchToChannels for
 * every operator whose capability matches a newly-posted job offer; before
 * this change the "sms" transport in that dispatch path was one of the
 * honestly-unimplemented ones (delivered:false, error
 * "transport_not_implemented" — see email-transport.ts's header for the
 * bug-B5 history of why that's "honest" rather than a stub success). This
 * module wires a real provider behind the sms path, gated on configuration,
 * mirroring the email transport exactly:
 *
 *   - Provider configured (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN +
 *     TWILIO_FROM_NUMBER all set) → a dispatch actually POSTs to the Twilio
 *     REST API and the dispatch `ref` is the real Twilio message SID.
 *   - No provider configured (this build env, and any deploy that has not
 *     set the three env vars yet) → callers get an explicit "not
 *     configured" signal, never a fake success.
 *
 * Why Twilio-over-HTTP and not the `twilio` npm SDK: same reasoning as
 * ResendTransport in email-transport.ts — the Messages resource is a single
 * Basic-authenticated POST, so we add a real provider with ZERO new npm
 * dependencies (no install, no new transitive tree through Gate A). The
 * `SmsTransport` interface below is provider-neutral; a Vonage/Plivo/SNS-
 * backed implementation can drop in later as another `SmsTransport` without
 * touching the dispatch path in routes/operator-channels.ts.
 *
 * Mockable seam: dispatch resolves the transport via `getSmsTransport()`,
 * which honors a test override set by `__setSmsTransportForTests()` — same
 * shape as `getEmailTransport()`. The test suite asserts both "sends when
 * configured" against a fake transport AND the real `TwilioTransport`
 * request/response shape against an injected `fetch` — no live provider and
 * no real credentials required in CI or this build env.
 */

/** A composed outbound SMS, provider-neutral. */
export interface SmsMessage {
  /** Recipient phone number, E.164 (the operator's channel `endpoint.phoneE164`). */
  to: string;
  /** Message text. Providers segment/concatenate long bodies themselves. */
  body: string;
  /** Optional sender override; falls back to the transport's configured From number. */
  from?: string;
}

/** Result of a successful send. */
export interface SmsSendResult {
  /** Provider-assigned message id (Twilio: the Message SID). Becomes the dispatch `ref`. */
  id: string;
  /** Which provider sent it, e.g. "twilio". */
  provider: string;
}

/**
 * A configured way to actually send an SMS. Implementations talk to a real
 * provider; the test suite supplies a fake one via `__setSmsTransportForTests`.
 */
export interface SmsTransport {
  /** Short provider tag, surfaced in logs and (optionally) the dispatch ref. */
  readonly provider: string;
  /** Send the message, or throw `SmsSendError` if the provider rejects it. */
  send(msg: SmsMessage): Promise<SmsSendResult>;
}

/** Thrown when a configured provider rejects a send (non-2xx, malformed reply). */
export class SmsSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmsSendError";
  }
}

/** Twilio Messages resource endpoint, parameterized by account SID. */
function twilioMessagesUrl(accountSid: string): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
}

/**
 * Twilio transport — one Basic-authenticated POST per message, using the
 * built-in fetch. Twilio's Messages API takes form-urlencoded params (not
 * JSON), so the request body is a `URLSearchParams`. `fetchImpl` is
 * injectable purely so unit tests can assert the request shape (auth header,
 * form body) without a network call; production passes the real global
 * fetch.
 */
export class TwilioTransport implements SmsTransport {
  readonly provider = "twilio";

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly defaultFrom: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(msg: SmsMessage): Promise<SmsSendResult> {
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
    const body = new URLSearchParams({
      To: msg.to,
      From: msg.from ?? this.defaultFrom,
      Body: msg.body,
    });
    const res = await this.fetchImpl(twilioMessagesUrl(this.accountSid), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${auth}`,
      },
      body: body.toString(),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        /* body already consumed / not readable — status alone is enough */
      }
      throw new SmsSendError(`twilio HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    let data: { sid?: string };
    try {
      data = (await res.json()) as { sid?: string };
    } catch {
      throw new SmsSendError("twilio returned a non-JSON success body");
    }
    if (!data.sid) {
      throw new SmsSendError("twilio success response missing message sid");
    }
    return { id: data.sid, provider: this.provider };
  }
}

/**
 * Resolve the configured SMS transport from the environment, or `null` when
 * no provider is configured. Re-reads env on every call (no import-time
 * freeze), mirroring `resolveEmailTransport`, so deploys and the test suite
 * can toggle configuration without `resetModules`.
 *
 * All three env vars are required — Twilio needs the account SID, auth
 * token, AND a From number you own in that account. Partial configuration
 * (e.g. SID + token but no From number) is treated as "not configured": a
 * send would fail at Twilio anyway, and failing closed here gives a clearer
 * error (`sms_not_configured`, caught before any network call) than letting
 * a doomed request reach the provider.
 */
export function resolveSmsTransport(
  env: Record<string, string | undefined> = process.env,
): SmsTransport | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const fromNumber = env.TWILIO_FROM_NUMBER?.trim();
  if (accountSid && authToken && fromNumber) {
    return new TwilioTransport(accountSid, authToken, fromNumber);
  }
  return null;
}

/**
 * Test-only override. Set an explicit `SmsTransport` to simulate a
 * configured provider, or `null` to simulate "no provider configured". Pass
 * `undefined` to clear the override and fall back to `resolveSmsTransport(env)`.
 * Mirrors `__setEmailTransportForTests`.
 */
let _testOverride: SmsTransport | null | undefined;

export function __setSmsTransportForTests(t: SmsTransport | null | undefined): void {
  _testOverride = t;
}

/**
 * The active transport: test override when set, otherwise env-derived. This
 * is the single seam the dispatch path calls — keeping env reads and the
 * test override in one place.
 */
export function getSmsTransport(
  env: Record<string, string | undefined> = process.env,
): SmsTransport | null {
  if (_testOverride !== undefined) return _testOverride;
  return resolveSmsTransport(env);
}
