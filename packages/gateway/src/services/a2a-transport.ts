/**
 * A2A (agent-to-agent) delivery transport for operator notification channels.
 *
 * Some operators — a solo courier, a small shop — run the PCC agent package
 * inside Claude Code instead of watching an inbox or a phone. For them,
 * SMS/email/webhook are all indirection: the thing that should be pinged is
 * their own agent, directly, over the same A2A protocol PCC itself speaks
 * (routes/a2a-tasks.ts). This module is that channel.
 *
 * The design mirrors sms-transport.ts / email-transport.ts exactly (provider
 * interface + resolve-from-config + test-override seam), with one
 * deliberate difference in what "configured" means:
 *
 *   - sms/email are gated on a THIRD-PARTY credential (TWILIO_*, RESEND_API_KEY).
 *   - a2a is gated on PCC's OWN agent-card signing key (PCC_AGENT_CARD_SIGNING_KEY,
 *     loaded once at boot by ../signing-key.ts and already used to sign
 *     /.well-known/agent-card.json). Reusing that exact key + boot lifecycle
 *     means a2a dispatch is authenticated with the same identity the operator's
 *     agent can already verify PCC by (fetch the JWKS at
 *     `${PCC_GATEWAY_URL}/.well-known/jwks.json`, same as verifying any other
 *     PCC-signed agent card) — no second credential to provision.
 *
 * What "dispatch as a signed A2A task" means concretely: this is NOT PCC's
 * inbound `/a2a/tasks/send` handler (routes/a2a-tasks.ts) — it is an OUTBOUND
 * CLIENT that speaks the identical JSON-RPC 2.0 wire shape
 * ({jsonrpc:"2.0", id, method:"tasks/send", params:{skill, params}}) to the
 * operator's OWN registered agent endpoint. "Any A2A v1.0 compliant agent"
 * (routes/a2a-tasks.ts's own header comment) cuts both ways: PCC accepts
 * tasks/send calls from other agents, and here PCC also PLACES one — to the
 * agent the operator registered (see routes/operator-channels.ts's
 * `autoRegisterA2aChannel` for how that registration happens, and the "a2a"
 * ChannelTransport / A2aEndpoint shape for what gets stored).
 *
 * The whole envelope is signed with @pcc/a2a-signing's `signAgentCard` —
 * despite the name, its `AgentCard` type is `Record<string, unknown>`
 * ("Generic agent card shape — accept any object", see sign-card.ts), so it
 * signs any JSON-serializable payload, not just literal agent cards. Reusing
 * it here (rather than hand-rolling a JWS call against `jose` directly) is
 * the "do NOT hand-roll signing" instruction taken literally: one signing
 * implementation, two call sites (agent cards, and now outbound tasks).
 *
 * "The real A2A task id": per A2A v1.0 semantics (and exactly how PCC's own
 * `dispatchTasksSend` in routes/a2a-tasks.ts behaves), the entity that
 * RECEIVES a tasks/send call mints the task id and returns it in the
 * JSON-RPC result. So the dispatch `ref` here is `result.id` from the
 * operator agent's response — never something this module mints itself.
 * A response with no signatures, a non-2xx status, a JSON-RPC `error`, or a
 * missing `result.id` are all treated as failure (never a fake success),
 * exactly like TwilioTransport/ResendTransport's error paths.
 */

import { randomUUID } from "node:crypto";
import type { KeyLike } from "jose";
import { signAgentCard } from "@pcc/a2a-signing";
import { getActiveSigningKey } from "../signing-key.js";

/** Default A2A skill name the operator's agent is expected to handle. */
export const DEFAULT_A2A_SKILL = "pcc-job-notification";

/** An outbound A2A task dispatch, provider-neutral (mirrors SmsMessage/EmailMessage). */
export interface A2aTaskMessage {
  /** The operator agent's registered endpoint URL — where the signed task is POSTed (the channel's endpoint.endpoint). */
  to: string;
  /**
   * The operator agent's PCC-network identity (the channel's
   * endpoint.agentId). Carried inside the task params so the receiving
   * agent can correlate/authorize the call against its own registration.
   */
  agentId: string;
  /** A2A skill name for this task. Defaults to DEFAULT_A2A_SKILL. */
  skill?: string;
  /** Skill params — the actual job-notification payload. */
  params: Record<string, unknown>;
}

/** Result of a successful dispatch. */
export interface A2aSendResult {
  /** The task id the RECEIVING agent assigned (A2A v1.0 tasks/send `result.id`). Becomes the dispatch `ref`. */
  id: string;
  /** Which mechanism handled it, e.g. "pcc-a2a". */
  provider: string;
}

/**
 * A configured way to actually dispatch a signed A2A task. The real
 * implementation POSTs to the operator's own agent endpoint; the test suite
 * supplies a fake one via `__setA2aTransportForTests`.
 */
export interface A2aTransport {
  /** Short provider tag, surfaced in logs and (optionally) the dispatch ref. */
  readonly provider: string;
  /** Send the task, or throw `A2aSendError` if the target agent rejects/is unreachable. */
  send(msg: A2aTaskMessage): Promise<A2aSendResult>;
}

/** Thrown when the target agent is unreachable, rejects, or replies malformed. */
export class A2aSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A2aSendError";
  }
}

interface A2aJsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: { id?: string; state?: string; [k: string]: unknown };
  error?: { code?: number; message?: string };
}

/**
 * The real transport — one signed POST per task, using the built-in fetch.
 * `fetchImpl` is injectable purely so unit tests can assert the request
 * shape (signed JSON-RPC envelope) without a network call; production
 * passes the real global fetch.
 */
export class PccAgentTaskTransport implements A2aTransport {
  readonly provider = "pcc-a2a";

  constructor(
    private readonly privateKey: KeyLike,
    private readonly kid: string,
    private readonly jwksUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(msg: A2aTaskMessage): Promise<A2aSendResult> {
    const rpcId = `a2a-notify-${randomUUID()}`;
    const envelope = {
      jsonrpc: "2.0" as const,
      id: rpcId,
      method: "tasks/send" as const,
      params: {
        skill: msg.skill ?? DEFAULT_A2A_SKILL,
        params: { ...msg.params, agentId: msg.agentId },
      },
    };

    // Sign the whole envelope — generic signAgentCard, see module header.
    const signed = await signAgentCard(envelope, {
      privateKey: this.privateKey,
      kid: this.kid,
      jwksUrl: this.jwksUrl,
    });

    const res = await this.fetchImpl(msg.to, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signed),
    });

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        /* body already consumed / not readable — status alone is enough */
      }
      throw new A2aSendError(`a2a HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }

    let data: A2aJsonRpcResponse;
    try {
      data = (await res.json()) as A2aJsonRpcResponse;
    } catch {
      throw new A2aSendError("a2a agent returned a non-JSON response");
    }

    if (data.error) {
      throw new A2aSendError(
        `a2a task rejected: ${data.error.message ?? "unknown error"}${
          data.error.code !== undefined ? ` (code ${data.error.code})` : ""
        }`,
      );
    }
    const taskId = data.result?.id;
    if (!taskId || typeof taskId !== "string") {
      throw new A2aSendError("a2a agent response missing result.id (task id)");
    }
    return { id: taskId, provider: this.provider };
  }
}

const GATEWAY_URL = process.env.PCC_GATEWAY_URL ?? "https://capability.network";

/**
 * Resolve the configured A2A transport, or `null` when no signing key is
 * loaded. Unlike resolveSmsTransport(env)/resolveEmailTransport(env) — which
 * re-read raw env on every call — this reads the ALREADY-loaded signing key
 * via `getActiveSigningKey()` (module-scoped cache set once at boot by
 * `initSigningKey()`, see ../signing-key.ts). That module already re-reads
 * its own cache fresh on every call, so this function has the same "no
 * stale freeze" property without re-parsing the PEM a second time.
 *
 * No signing key configured (this build env, and any deploy that hasn't set
 * PCC_AGENT_CARD_SIGNING_KEY yet) -> null -> dispatch reports
 * "a2a_not_configured", never a fake success.
 */
export function resolveA2aTransport(): A2aTransport | null {
  const signingKey = getActiveSigningKey();
  if (!signingKey) return null;
  return new PccAgentTaskTransport(
    signingKey.privateKey,
    signingKey.kid,
    `${GATEWAY_URL}/.well-known/jwks.json`,
  );
}

/**
 * Test-only override. Set an explicit `A2aTransport` to simulate a
 * configured signing key, or `null` to simulate "no signing key configured".
 * Pass `undefined` to clear the override and fall back to
 * `resolveA2aTransport()`. Mirrors `__setSmsTransportForTests`.
 */
let _testOverride: A2aTransport | null | undefined;

export function __setA2aTransportForTests(t: A2aTransport | null | undefined): void {
  _testOverride = t;
}

/**
 * The active transport: test override when set, otherwise
 * `resolveA2aTransport()`. This is the single seam the dispatch path calls.
 */
export function getA2aTransport(): A2aTransport | null {
  if (_testOverride !== undefined) return _testOverride;
  return resolveA2aTransport();
}
