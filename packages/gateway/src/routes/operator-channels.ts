/**
 * Operator channels — generic backend-integration substrate.
 *
 * Any operator of any capability (pizza shop, biolab, machine shop, driver,
 * delivery cooperative, solo human) can attach 0..N "channels" to their
 * operator record. A channel is one way PCC will notify the operator when a
 * job lands, and optionally how PCC will receive structured replies back.
 *
 * What this file deliberately does NOT do:
 *   - It does not name Square, Toast, Twilio, SendGrid, or any specific vendor.
 *   - It does not hardcode any specific message format.
 *   - It does not assume the operator has a tech stack at all.
 *
 * Specificity lives one level up, in the operator's onboarding agent dialogue.
 * The agent (Claude/ChatGPT inside the operator's own session, talking to the
 * person setting things up) is what asks: "What system do you already use to
 * receive orders? Walk me through it." From that conversation, the agent
 * derives a channel record and POSTs it here. PCC the substrate stays neutral
 * about which transports and formats exist — every operator gets to invent
 * their own as long as it fits the channel envelope below.
 *
 * The envelope captures the minimum needed for PCC to deliver a job and (if
 * the operator wants two-way comms) accept structured replies. The envelope
 * intentionally has a `describe` slot — a freeform description the operator's
 * agent uses to remember what it was integrating with. The agent is the one
 * that translates between PCC's job schema and the operator's actual system.
 *
 * Result: zero adapter code per integration. New backend types appear by
 * conversation, not by code change. The platform team never has to ship
 * "Toast support" — the first Toast operator's agent figures it out during
 * onboarding, captures the recipe in the `describe` field, and any later
 * Toast operator gets a head-start by reusing that recipe.
 */

import type { FastifyInstance } from "fastify";
import { randomBytes, createHmac } from "node:crypto";
import { getEmailTransport } from "../services/email-transport.js";
import { getSmsTransport } from "../services/sms-transport.js";

/**
 * The transport is "what wire does the message go over." It stays small and
 * stable — these are the half-dozen ways one computer can ping another in 2026
 * without inventing a protocol. Everything specific to a vendor lives in the
 * `describe` field, not here.
 */
export type ChannelTransport =
  | "webhook"   // POST JSON to a URL the operator gave us
  | "email"     // SMTP, address provided by operator
  | "sms"       // E.164 phone number
  | "voice"     // outbound call placed by an external voice provider
  | "push"      // a push token (mobile / desktop) supplied by the operator
  | "mqtt"      // a topic on a broker the operator runs
  | "file"      // write to a path / object-store key the operator polls
  | "manual";   // no machine endpoint — the SSE dashboard is the only sink

/**
 * Direction = does PCC just push, or does the operator's system push back too?
 *   out      : PCC → operator only
 *   in-out   : the operator's system will also POST replies / status back
 *   in       : operator's system POSTs unsolicited (e.g. "we are now closed")
 * The in/in-out directions imply a reply URL on the PCC side; we mint it.
 */
export type ChannelDirection = "out" | "in-out" | "in";

/**
 * Availability — when this operator (or this capability) is reachable.
 *
 * Same envelope pattern as the channel layer: a small stable enum + a
 * `describe` slot for everything that doesn't fit the enum. PCC the
 * substrate stays neutral on scheduling complexity. The operator's agent
 * picks the simplest mode that captures their reality and writes a
 * `describe` for anything weird ("the lab is open 9-5 weekdays except
 * Wednesday afternoons when the autoclave runs").
 *
 * Mirrors the design pattern from PR #98's `sla` JSON shape:
 *   - structured enum for the common 80%
 *   - free-form `describe` for the rest
 *   - nullable / never enforced at the substrate level
 *
 * The capabilities table already carries an `availability` JSON column
 * (Record<string, unknown>) — this type is the recommended shape stored
 * inside that column. We do NOT change the column type, keeping the
 * substrate back-compat with everything previously written there.
 */
export type AvailabilityMode =
  | "always"                // 24/7 — most digital capabilities, "make a large pepperoni"
  | "windows"               // explicit allowed time windows + recurrence
  | "cron"                  // POSIX cron expression
  | "manual-claim"          // operator hits "I'm available" / "I'm busy" toggle
  | "delegate-to-agent";    // operator's agent answers "are you free at T?" live

export interface AvailabilityWindow {
  /** ISO-8601 datetime OR "HH:mm" when daysOfWeek is set (recurring). */
  start: string;
  /** ISO-8601 datetime OR "HH:mm" when daysOfWeek is set (recurring). */
  end: string;
  /** 0=Sun ... 6=Sat. Omit for one-shot windows. */
  daysOfWeek?: number[];
  /** IANA timezone, e.g. "America/Los_Angeles". Defaults to top-level timezone. */
  timezone?: string;
}

export interface AvailabilityRecord {
  mode: AvailabilityMode;
  /** For mode: "windows" — list of allowed windows. */
  windows?: AvailabilityWindow[];
  /** For mode: "cron" — standard POSIX cron expression. */
  cron?: string;
  /** Default IANA timezone for any window/cron expression. */
  timezone?: string;
  /** For mode: "delegate-to-agent" — URL the substrate POSTs availability queries to. */
  agentEndpoint?: string;
  /**
   * Free-form description of availability. The operator's agent fills this
   * in during onboarding. PCC does not parse it; downstream agents read it
   * when negotiating a job slot. Example:
   *   "Open 9–5 Pacific Mon–Fri except Wed 2–5pm when the autoclave runs.
   *    For weekends or rush jobs, ping the owner — usually says yes for
   *    +20% rush fee."
   */
  describe?: string;
}

/** Parse the capability `availability` JSON column into a typed record (or null). */
export function parseAvailability(raw: unknown): AvailabilityRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const mode = r.mode;
  if (typeof mode !== "string") return null;
  const valid: AvailabilityMode[] = [
    "always",
    "windows",
    "cron",
    "manual-claim",
    "delegate-to-agent",
  ];
  if (!valid.includes(mode as AvailabilityMode)) return null;
  return {
    mode: mode as AvailabilityMode,
    windows: Array.isArray(r.windows) ? (r.windows as AvailabilityWindow[]) : undefined,
    cron: typeof r.cron === "string" ? r.cron : undefined,
    timezone: typeof r.timezone === "string" ? r.timezone : undefined,
    agentEndpoint: typeof r.agentEndpoint === "string" ? r.agentEndpoint : undefined,
    describe: typeof r.describe === "string" ? r.describe : undefined,
  };
}

/** Inverse of parseAvailability. Strips undefined keys for a clean JSON column write. */
export function serializeAvailability(a: AvailabilityRecord): Record<string, unknown> {
  const out: Record<string, unknown> = { mode: a.mode };
  if (a.windows) out.windows = a.windows;
  if (a.cron) out.cron = a.cron;
  if (a.timezone) out.timezone = a.timezone;
  if (a.agentEndpoint) out.agentEndpoint = a.agentEndpoint;
  if (a.describe) out.describe = a.describe;
  return out;
}

export interface ChannelRecord {
  id: string;
  operatorSlug: string;
  /** Free-form short label shown to humans: "Front counter printer", "Owner's phone". */
  label: string;
  transport: ChannelTransport;
  direction: ChannelDirection;
  /**
   * Endpoint of the channel. Shape depends on transport:
   *   webhook -> {url}
   *   email   -> {address}
   *   sms     -> {phoneE164}
   *   voice   -> {phoneE164, locale?}
   *   push    -> {token, platform}
   *   mqtt    -> {brokerUrl, topic}
   *   file    -> {scheme, path}   // file://, s3://, etc
   *   manual  -> {}
   */
  endpoint: Record<string, unknown>;
  /**
   * Reference into the credential vault. We do not store secrets here — the
   * operator's onboarding agent vaults the credential (OAuth token, HMAC
   * shared secret, API key) and passes us back a handle. Dispatch resolves
   * the handle just-in-time.
   */
  credentialRef?: string;
  /**
   * The plain-English description of how to talk to whatever's on the other
   * end. This is the slot the operator's onboarding agent uses to remember
   * "POST to this URL with this JSON shape" or "send the SMS with the order
   * number first, then the items each on their own line." It is the contract
   * between this operator and PCC, written by the operator's agent. PCC
   * itself does not parse it — the dispatch helper hands it to whatever
   * agent is composing the outbound message.
   *
   * Examples (operator-authored, varied by setup):
   *   "Send SMS in this format: 'PCC #{jobId} | {description} | {priceUSD}'.
   *    I will reply Y / N within 90s."
   *   "POST JSON, top-level keys: order_id, line_items[], deadline_iso. I
   *    will POST back to your reply URL with {order_id, status}."
   *   "Send the photo evidence URL inline — my system fetches it and prints
   *    the receipt with the photo."
   */
  describe: string;
  /** Operator-authored: "what should I do if PCC sends me an evidence request?" etc. */
  replyContract?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ChannelDispatchPayload {
  jobId: string;
  contextRef: string;       // opaque pointer into PCC for the agent to fetch full job
  summary: string;          // one-line human summary so a phone notification renders well
  priceUSD?: number;
  deadlineSec?: number;
}

interface ChannelDispatchResult {
  channelId: string;
  transport: ChannelTransport;
  delivered: boolean;
  /** Provider message id on a real send (e.g. the Resend id). Absent on failure. */
  ref?: string;
  /**
   * Machine-readable failure code when `delivered` is false. Lets the
   * operator's agent and the dashboard distinguish an honest "not configured"
   * (`email_not_configured`) from a transport that isn't wired
   * (`transport_not_implemented`), a bad endpoint (`invalid_endpoint`), or a
   * provider rejection (`send_failed`).
   */
  error?: string;
  warning?: string;
}

// In-memory store. The substrate-wide SQLite layer will absorb this; the
// interface above is what survives the migration.
const channels = new Map<string, ChannelRecord>();
const byOperator = new Map<string, Set<string>>();

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return "ch_" + randomBytes(8).toString("hex");
}

/**
 * Input shape for attaching a channel via either HTTP or A2A skill.
 * Strictly a subset of ChannelRecord — the substrate fills id + timestamps.
 */
export interface ChannelInput {
  label: string;
  transport: ChannelTransport;
  direction?: ChannelDirection;
  endpoint?: Record<string, unknown>;
  credentialRef?: string;
  describe: string;
  replyContract?: string;
  enabled?: boolean;
}

/** `endpoint` shape for `transport: "sms"` — see `ChannelRecord.endpoint`'s doc comment. */
export interface SmsEndpoint {
  /** E.164 phone number, e.g. "+14155551234". */
  phoneE164: string;
}

/**
 * E.164 format check: "+" followed by 1-15 digits, first digit 1-9 (no
 * leading zero, no separators). This is the wire format Twilio's Messages
 * API (and the SMS transport generally) requires for `To`/`From`.
 */
function isE164(phone: string): boolean {
  return /^\+[1-9]\d{1,14}$/.test(phone);
}

/**
 * Programmatic attach — used by HTTP route AND by the A2A `pcc-attach-channel`
 * skill (so an agent doesn't have to make a second HTTP call).
 *
 * Throws on validation failure with a `code` property so callers can branch.
 */
export function attachChannel(operatorSlug: string, input: ChannelInput): ChannelRecord {
  if (!input.transport) {
    throw Object.assign(new Error("transport required"), { code: "invalid_body" });
  }
  if (!input.label) {
    throw Object.assign(new Error("label required"), { code: "invalid_body" });
  }
  if (!input.describe || input.describe.trim().length < 4) {
    throw Object.assign(
      new Error(
        "describe required — say in plain English how PCC should talk to your system. Your onboarding agent should have written this.",
      ),
      { code: "invalid_body" },
    );
  }
  if (input.transport === "sms") {
    const phone = (input.endpoint as Partial<SmsEndpoint> | undefined)?.phoneE164;
    if (typeof phone !== "string" || !isE164(phone)) {
      throw Object.assign(
        new Error(
          "sms channel requires endpoint.phoneE164 in E.164 format, e.g. +14155551234",
        ),
        { code: "invalid_endpoint" },
      );
    }
  }
  const ch: ChannelRecord = {
    id: newId(),
    operatorSlug,
    label: input.label,
    transport: input.transport,
    direction: input.direction ?? "out",
    endpoint: input.endpoint ?? {},
    credentialRef: input.credentialRef,
    describe: input.describe,
    replyContract: input.replyContract,
    enabled: input.enabled ?? true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  channels.set(ch.id, ch);
  let set = byOperator.get(operatorSlug);
  if (!set) { set = new Set(); byOperator.set(operatorSlug, set); }
  set.add(ch.id);
  return ch;
}

/** List all channels for an operator. */
export function getChannelsByOperator(operatorSlug: string): ChannelRecord[] {
  const ids = byOperator.get(operatorSlug);
  if (!ids) return [];
  return Array.from(ids).map((i) => channels.get(i)).filter((c): c is ChannelRecord => !!c);
}

/**
 * Generic dispatch. PCC does not interpret `describe` — it hands the channel
 * + payload to whatever agent is composing the outbound message and lets the
 * agent produce the wire-format. For machine transports (webhook/mqtt/file)
 * the agent emits a body; we send it.
 *
 * For the demo path we ship a minimal "naive" composer that does the obvious
 * thing per transport. The richer LLM-driven composer is a follow-on and can
 * be swapped in without changing this surface.
 */
export async function dispatchToChannels(
  operatorSlug: string,
  payload: ChannelDispatchPayload,
): Promise<ChannelDispatchResult[]> {
  const ids = byOperator.get(operatorSlug);
  if (!ids || ids.size === 0) {
    return [{ channelId: "", transport: "manual", delivered: true, ref: "no-channels-attached" }];
  }
  const results: ChannelDispatchResult[] = [];
  for (const id of ids) {
    const ch = channels.get(id);
    if (!ch || !ch.enabled) continue;
    results.push(await dispatchOne(ch, payload));
  }
  return results;
}

async function dispatchOne(
  ch: ChannelRecord,
  p: ChannelDispatchPayload,
): Promise<ChannelDispatchResult> {
  try {
    switch (ch.transport) {
      case "manual":
        return { channelId: ch.id, transport: "manual", delivered: true };
      case "webhook":
        return await sendWebhook(ch, p);
      case "email":
        return await sendEmail(ch, p);
      case "sms":
        return await sendSms(ch, p);
      case "voice":
      case "push":
      case "mqtt":
      case "file":
        // These transports have no real provider wired yet. Be honest:
        // delivered=false with a clear code — NOT a fake success. (The old
        // code returned delivered:true + ref "stub:transport-not-wired" here,
        // which told operators a message sent when none did — bug B5.) Each
        // provider is a per-transport follow-on with the same shape as the
        // email/sms paths above.
        console.log(
          `[op-channel] ${ch.transport} transport not implemented; would dispatch to ` +
            `operator=${ch.operatorSlug} endpoint=${JSON.stringify(ch.endpoint)} ` +
            `describe="${ch.describe.slice(0, 80)}" payload=${JSON.stringify(p)}`,
        );
        return {
          channelId: ch.id,
          transport: ch.transport,
          delivered: false,
          error: "transport_not_implemented",
          warning: `${ch.transport} transport is not wired yet; nothing was sent`,
        };
    }
  } catch (e) {
    return {
      channelId: ch.id,
      transport: ch.transport,
      delivered: false,
      error: "send_failed",
      warning: (e as Error).message,
    };
  }
}

/**
 * Email dispatch — the wired path (bug B5 fix).
 *
 *   - No `endpoint.address`            → delivered:false, error invalid_endpoint.
 *   - No provider configured           → delivered:false, error email_not_configured
 *                                        (honest: this build env has no key).
 *   - Provider configured + send OK    → delivered:true, ref = provider message id.
 *   - Provider rejects the send        → throws; caught by dispatchOne as send_failed.
 *
 * The transport is resolved through `getEmailTransport()`, the mockable seam:
 * tests inject a fake transport, production reads RESEND_API_KEY from env.
 */
async function sendEmail(
  ch: ChannelRecord,
  p: ChannelDispatchPayload,
): Promise<ChannelDispatchResult> {
  const address = (ch.endpoint as { address?: string }).address;
  if (!address) {
    return {
      channelId: ch.id,
      transport: "email",
      delivered: false,
      error: "invalid_endpoint",
      warning: "email channel has no endpoint.address",
    };
  }
  const transport = getEmailTransport();
  if (!transport) {
    return {
      channelId: ch.id,
      transport: "email",
      delivered: false,
      error: "email_not_configured",
      warning:
        "no email provider configured — set RESEND_API_KEY to enable email delivery; nothing was sent",
    };
  }
  const result = await transport.send({
    to: address,
    subject: emailSubject(p),
    text: emailBody(ch, p),
  });
  return { channelId: ch.id, transport: "email", delivered: true, ref: result.id };
}

/** One-line subject for the notification email. */
function emailSubject(p: ChannelDispatchPayload): string {
  return `PCC job ${p.jobId}: ${p.summary}`.slice(0, 200);
}

/** Plain-text body — the obvious naive composer, same role as sendWebhook's JSON. */
function emailBody(ch: ChannelRecord, p: ChannelDispatchPayload): string {
  const lines = [p.summary, "", `Job: ${p.jobId}`, `Context: ${p.contextRef}`];
  if (typeof p.priceUSD === "number") lines.push(`Price: $${p.priceUSD} USD`);
  if (typeof p.deadlineSec === "number") lines.push(`Respond within: ${p.deadlineSec}s`);
  lines.push("", `— PCC (channel: ${ch.label})`);
  return lines.join("\n");
}

/**
 * SMS dispatch — Twilio-backed (this change, closing NOTIFICATION-NOTES.md
 * gap #3 for the sms transport).
 *
 *   - No `endpoint.phoneE164`        → delivered:false, error invalid_endpoint.
 *     (attachChannel already rejects this at attach time — see isE164 above
 *     — this is defense-in-depth for channels reaching this state some other
 *     way, e.g. a PATCH that doesn't re-validate, mirroring sendEmail's own
 *     belt-and-suspenders invalid_endpoint check.)
 *   - No provider configured         → delivered:false, error sms_not_configured
 *                                      (honest: TWILIO_* env unset in this build env).
 *   - Provider configured + send OK  → delivered:true, ref = Twilio message SID.
 *   - Provider rejects the send      → throws; caught by dispatchOne as send_failed.
 *
 * The transport is resolved through `getSmsTransport()`, the mockable seam:
 * tests inject a fake transport, production reads TWILIO_ACCOUNT_SID /
 * TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER from env.
 */
async function sendSms(
  ch: ChannelRecord,
  p: ChannelDispatchPayload,
): Promise<ChannelDispatchResult> {
  const phoneE164 = (ch.endpoint as Partial<SmsEndpoint>).phoneE164;
  if (!phoneE164) {
    return {
      channelId: ch.id,
      transport: "sms",
      delivered: false,
      error: "invalid_endpoint",
      warning: "sms channel has no endpoint.phoneE164",
    };
  }
  const transport = getSmsTransport();
  if (!transport) {
    return {
      channelId: ch.id,
      transport: "sms",
      delivered: false,
      error: "sms_not_configured",
      warning:
        "no SMS provider configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER to enable SMS delivery; nothing was sent",
    };
  }
  const result = await transport.send({ to: phoneE164, body: smsBody(ch, p) });
  return { channelId: ch.id, transport: "sms", delivered: true, ref: result.id };
}

/**
 * Short plain-text body — SMS has no subject line and real per-segment cost,
 * so this stays terser than emailBody's multi-line composer (no contextRef:
 * it's an internal API path, not something a phone recipient can act on).
 */
function smsBody(ch: ChannelRecord, p: ChannelDispatchPayload): string {
  const parts = [p.summary];
  if (typeof p.priceUSD === "number") parts.push(`$${p.priceUSD} USD`);
  if (typeof p.deadlineSec === "number") parts.push(`respond within ${p.deadlineSec}s`);
  parts.push(`Job ${p.jobId} (${ch.label})`);
  return parts.join(" — ");
}

async function sendWebhook(
  ch: ChannelRecord,
  p: ChannelDispatchPayload,
): Promise<ChannelDispatchResult> {
  const url = (ch.endpoint as { url?: string }).url;
  if (!url) {
    return {
      channelId: ch.id,
      transport: "webhook",
      delivered: false,
      warning: "no endpoint.url",
    };
  }
  const body = JSON.stringify({
    source: "pcc.capability.network",
    sentAt: nowIso(),
    operator: ch.operatorSlug,
    channel: { id: ch.id, label: ch.label, describe: ch.describe },
    job: p,
  });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ch.credentialRef) {
    const secret = await resolveSecret(ch.credentialRef);
    if (secret) {
      const sig = createHmac("sha256", secret).update(body).digest("hex");
      headers["x-pcc-signature"] = `sha256=${sig}`;
    }
  }
  const r = await fetch(url, { method: "POST", headers, body });
  return r.ok
    ? { channelId: ch.id, transport: "webhook", delivered: true, ref: r.headers.get("x-request-id") ?? undefined }
    : { channelId: ch.id, transport: "webhook", delivered: false, warning: `HTTP ${r.status}` };
}

/**
 * Vault resolution. The real vault lives in the gatecraft-credentials layer
 * (see ai/research/gatecraft); this stub keeps the surface stable so the
 * rest of the system can develop against it. Returns undefined if the
 * reference is unknown — dispatch falls back to unsigned send + warning.
 */
async function resolveSecret(ref: string): Promise<string | undefined> {
  return process.env[`PCC_VAULT_${ref.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`];
}

// ── HTTP routes ────────────────────────────────────────────────────────────

export async function operatorChannelsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/operators/:slug/channels — add a channel.
   * Called by the operator's onboarding agent after it has had the
   * conversation that produced the channel record. PCC accepts any
   * combination of fields that satisfies the envelope.
   */
  app.post<{
    Params: { slug: string };
    Body: ChannelInput;
  }>("/api/operators/:slug/channels", async (req, reply) => {
    try {
      const ch = attachChannel(req.params.slug, req.body ?? ({} as ChannelInput));
      return reply.status(201).send({ channel: ch });
    } catch (e) {
      const err = e as Error & { code?: string };
      return reply.status(400).send({
        error: err.code ?? "invalid_body",
        message: err.message,
      });
    }
  });

  app.get<{ Params: { slug: string } }>(
    "/api/operators/:slug/channels",
    async (req, reply) => {
      const ids = byOperator.get(req.params.slug);
      const list = ids ? Array.from(ids).map((i) => channels.get(i)).filter(Boolean) : [];
      return reply.status(200).send({ channels: list });
    },
  );

  app.patch<{
    Params: { id: string };
    Body: Partial<ChannelRecord>;
  }>("/api/operators/channels/:id", async (req, reply) => {
    const ch = channels.get(req.params.id);
    if (!ch) return reply.status(404).send({ error: "not_found" });
    const merged: ChannelRecord = {
      ...ch,
      ...req.body,
      id: ch.id,
      operatorSlug: ch.operatorSlug,
      createdAt: ch.createdAt,
      updatedAt: nowIso(),
    };
    channels.set(ch.id, merged);
    return reply.status(200).send({ channel: merged });
  });

  app.delete<{ Params: { id: string } }>(
    "/api/operators/channels/:id",
    async (req, reply) => {
      const ch = channels.get(req.params.id);
      if (!ch) return reply.status(404).send({ error: "not_found" });
      channels.delete(ch.id);
      byOperator.get(ch.operatorSlug)?.delete(ch.id);
      return reply.status(200).send({ deleted: true });
    },
  );

  /**
   * POST /api/operators/:slug/channels/test — fire a synthetic job at every
   * enabled channel so the operator's agent (and the human watching) can
   * verify the integration end-to-end before any real job lands.
   */
  app.post<{ Params: { slug: string } }>(
    "/api/operators/:slug/channels/test",
    async (req, reply) => {
      const results = await dispatchToChannels(req.params.slug, {
        jobId: "test_" + randomBytes(4).toString("hex"),
        contextRef: "synthetic",
        summary: "TEST DISPATCH — your channel is wired up correctly.",
      });
      return reply.status(200).send({ results });
    },
  );
}

/** Test helper. */
export function _clearOperatorChannelsForTests(): void {
  channels.clear();
  byOperator.clear();
}
