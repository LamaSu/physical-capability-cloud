/**
 * Email delivery transport for operator notification channels.
 *
 * Background (B5): the operator-channels dispatch path used to return a fake
 * `delivered: true, ref: "stub:transport-not-wired"` for the `email` transport.
 * An operator who attached an email channel and ran a delivery test was told it
 * worked while NO email ever sent — so operators got no real notification when a
 * job arrived. This module wires a real provider behind the email path, gated on
 * configuration:
 *
 *   - Provider configured (RESEND_API_KEY set) → a delivery test actually POSTs
 *     to the provider and the dispatch `ref` is the provider's real message id.
 *   - No provider configured (this build env, and any deploy that has not set a
 *     key yet) → callers get an explicit "not configured" signal, never a fake
 *     success.
 *
 * Why Resend-over-HTTP and not SMTP/nodemailer: the gateway already speaks to
 * outbound endpoints with the built-in `fetch` (see `sendWebhook` in
 * routes/operator-channels.ts). Resend's send API is a single authenticated
 * POST, so we add a real provider with ZERO new npm dependencies — no install,
 * no new transitive tree to push through Gate A. The `EmailTransport` interface
 * below is provider-neutral; an SMTP/nodemailer-backed implementation can be
 * added later as another `EmailTransport` without touching the dispatch path.
 * `SMTP_URL` is reserved (see `resolveEmailTransport`) for that follow-on.
 *
 * Mockable seam: dispatch resolves the transport via `getEmailTransport()`,
 * which honors a test override set by `__setEmailTransportForTests()`. The test
 * suite asserts "sends when configured" against a fake transport — no live
 * provider and no real API key required in CI or this build env.
 */

/** A composed outbound email, provider-neutral. */
export interface EmailMessage {
  /** Recipient address (the operator's channel `endpoint.address`). */
  to: string;
  subject: string;
  /** Plain-text body. */
  text: string;
  /** Optional sender override; falls back to the transport's default From. */
  from?: string;
}

/** Result of a successful send. */
export interface EmailSendResult {
  /** Provider-assigned message id. Becomes the dispatch `ref`. */
  id: string;
  /** Which provider sent it, e.g. "resend". */
  provider: string;
}

/**
 * A configured way to actually send an email. Implementations talk to a real
 * provider; the test suite supplies a fake one via `__setEmailTransportForTests`.
 */
export interface EmailTransport {
  /** Short provider tag, surfaced in logs and (optionally) the dispatch ref. */
  readonly provider: string;
  /** Send the message, or throw `EmailSendError` if the provider rejects it. */
  send(msg: EmailMessage): Promise<EmailSendResult>;
}

/** Thrown when a configured provider rejects a send (non-2xx, malformed reply). */
export class EmailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailSendError";
  }
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Default From. Resend requires the sending domain to be verified in the
 * account that owns RESEND_API_KEY; override via EMAIL_FROM once a domain is
 * verified for capability.network. Kept here (not a secret) so a misconfigured
 * deploy fails loudly at the provider instead of silently.
 */
const DEFAULT_FROM = "PCC Notifications <notifications@capability.network>";

/**
 * Resend transport — one authenticated POST per message, using the built-in
 * fetch. `fetchImpl` is injectable purely so unit tests can assert the request
 * shape (auth header, body) without a network call; production passes the real
 * global fetch.
 */
export class ResendTransport implements EmailTransport {
  readonly provider = "resend";

  constructor(
    private readonly apiKey: string,
    private readonly defaultFrom: string = DEFAULT_FROM,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(msg: EmailMessage): Promise<EmailSendResult> {
    const res = await this.fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: msg.from ?? this.defaultFrom,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
      }),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        /* body already consumed / not readable — status alone is enough */
      }
      throw new EmailSendError(`resend HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    let data: { id?: string };
    try {
      data = (await res.json()) as { id?: string };
    } catch {
      throw new EmailSendError("resend returned a non-JSON success body");
    }
    if (!data.id) {
      throw new EmailSendError("resend success response missing message id");
    }
    return { id: data.id, provider: this.provider };
  }
}

/**
 * Resolve the configured email transport from the environment, or `null` when
 * no provider is configured. Re-reads env on every call (no import-time freeze),
 * mirroring `config/tenant-enforce.ts`, so deploys and the test suite can toggle
 * configuration without `resetModules`.
 *
 * Selection order:
 *   1. RESEND_API_KEY  → ResendTransport (the wired provider).
 *   2. SMTP_URL        → reserved for a future nodemailer transport. It is
 *      intentionally treated as "not configured" here: wiring SMTP needs the
 *      nodemailer dependency, which is out of scope for this change. Returning
 *      null (honest not-configured) is correct until that lands — see
 *      NOTIFICATION-NOTES.md.
 */
export function resolveEmailTransport(
  env: Record<string, string | undefined> = process.env,
): EmailTransport | null {
  const resendKey = env.RESEND_API_KEY?.trim();
  if (resendKey) {
    const from = env.EMAIL_FROM?.trim() || DEFAULT_FROM;
    return new ResendTransport(resendKey, from);
  }
  return null;
}

/**
 * Test-only override. Set an explicit `EmailTransport` to simulate a configured
 * provider, or `null` to simulate "no provider configured". Pass `undefined` to
 * clear the override and fall back to `resolveEmailTransport(env)`. Mirrors the
 * `_clearOperatorChannelsForTests` seam in the same package.
 */
let _testOverride: EmailTransport | null | undefined;

export function __setEmailTransportForTests(t: EmailTransport | null | undefined): void {
  _testOverride = t;
}

/**
 * The active transport: test override when set, otherwise env-derived. This is
 * the single seam the dispatch path calls — keeping env reads and the test
 * override in one place.
 */
export function getEmailTransport(
  env: Record<string, string | undefined> = process.env,
): EmailTransport | null {
  if (_testOverride !== undefined) return _testOverride;
  return resolveEmailTransport(env);
}
