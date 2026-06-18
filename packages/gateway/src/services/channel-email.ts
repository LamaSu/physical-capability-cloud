/**
 * Channel email transport — Resend HTTP API.
 *
 * Why a service file (not inline in operator-channels.ts):
 *   - Keeps the transport-specific HTTP + env-var logic out of the substrate
 *     surface. The route file stays focused on the envelope contract.
 *   - Lets the test suite mock just `sendEmailViaResend` rather than re-mock
 *     the whole channel dispatch path.
 *
 * Why Resend over SMTP / Postmark:
 *   - Single env var: RESEND_API_KEY.
 *   - REST API; no SMTP server, no MIME assembly, no nodemailer dep.
 *   - Free tier covers 100/day, 3000/mo — fine for substrate notifications.
 *
 * Honest-no-config behaviour:
 *   - When RESEND_API_KEY is missing, return a `ref:noconfig:...` envelope
 *     with `delivered: false, status: "skipped"`. Never lie with
 *     `delivered: true`. The B5 finding ("every channel send is a lie") is
 *     fundamentally about this: a missing transport is preferable to a fake
 *     success.
 *
 * What it deliberately does NOT do:
 *   - Render HTML templates (operator's `describe` slot tells the composer
 *     the wire format; PCC the substrate stays neutral).
 *   - Retry on transient failure (the upstream dispatcher decides retry).
 *   - Track bounces post-send (a webhook from Resend would, in a later PR).
 */

const RESEND_API_URL = "https://api.resend.com/emails";

/**
 * Default From address. Operators can override per-channel by passing
 * `endpoint.fromAddress` on the channel record. Falls back to env-var, then
 * to Resend's sandbox sender domain.
 *
 * Resend rejects un-verified sender domains. The PCC convention is to
 * configure `RESEND_FROM` to a verified address at deploy time
 * (e.g. "noreply@capability.network") and let operators override per channel
 * only when they've verified their own domain inside Resend.
 */
function defaultFromAddress(): string {
  return process.env.RESEND_FROM ?? "PCC <onboarding@resend.dev>";
}

export interface EmailEnvelope {
  to: string;
  subject: string;
  body: string; // plain text body; HTML version derived by simple <pre> wrap
  from?: string;
  replyTo?: string;
}

export type EmailSendStatus = "queued" | "sent" | "bounced" | "skipped";

export interface EmailSendResult {
  /**
   * The transport-side identifier. On success: Resend's `id` (e.g.
   * "f3a8b6e4-7c19-4e8e-9d12-...").
   *
   * On no-config: a structured `ref:noconfig:<env-var>` sentinel — clearly
   * not a real send.
   *
   * On error: `ref:error:<truncated-message>` so the dispatcher has
   * something traceable without leaking secrets.
   */
  ref: string;
  delivered: boolean;
  status: EmailSendStatus;
  deliveredAt?: string;
  error?: string;
}

/**
 * Transport client interface — lets the test suite inject a fake instead of
 * making real HTTP calls. Production callers use `defaultResendClient`.
 */
export interface ResendClient {
  send(
    apiKey: string,
    env: EmailEnvelope,
  ): Promise<{ id?: string; ok: boolean; status: number; errorBody?: string }>;
}

export const defaultResendClient: ResendClient = {
  async send(apiKey, env) {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: env.from ?? defaultFromAddress(),
        to: [env.to],
        subject: env.subject,
        text: env.body,
        // Wrap plain text in <pre> for a readable HTML fallback. Some clients
        // refuse plain-text-only emails; both fields keep deliverability up.
        html: `<pre style="font-family: ui-monospace, monospace; font-size: 13px; white-space: pre-wrap;">${escapeHtml(env.body)}</pre>`,
        reply_to: env.replyTo,
      }),
    });
    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      return { ok: false, status: res.status, errorBody };
    }
    const j = (await res.json().catch(() => null)) as { id?: string } | null;
    return { ok: true, status: res.status, id: j?.id };
  },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Send an email through the configured transport. Returns a structured
 * result; never throws.
 *
 * @param env envelope (to/subject/body, optional from/replyTo)
 * @param client transport client — defaults to live Resend; tests inject
 */
export async function sendEmail(
  env: EmailEnvelope,
  client: ResendClient = defaultResendClient,
): Promise<EmailSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      ref: "ref:noconfig:RESEND_API_KEY_missing",
      delivered: false,
      status: "skipped",
      error:
        "RESEND_API_KEY env var is not configured; email transport is unavailable. " +
        "Set RESEND_API_KEY to enable real delivery, or attach a different transport channel.",
    };
  }

  if (!env.to || !env.subject) {
    return {
      ref: "ref:error:missing-envelope-fields",
      delivered: false,
      status: "bounced",
      error: "email envelope missing `to` or `subject`",
    };
  }

  try {
    const r = await client.send(apiKey, env);
    if (!r.ok) {
      return {
        ref: `ref:error:resend-http-${r.status}`,
        delivered: false,
        status: "bounced",
        error: truncate(r.errorBody ?? `HTTP ${r.status}`, 200),
      };
    }
    return {
      ref: r.id ?? "ref:error:no-id-from-resend",
      delivered: true,
      status: "queued",
      deliveredAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      ref: "ref:error:exception",
      delivered: false,
      status: "bounced",
      error: truncate((e as Error).message ?? String(e), 200),
    };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
