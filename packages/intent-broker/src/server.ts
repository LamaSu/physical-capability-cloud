/**
 * @pcc/intent-broker — MCP server
 *
 * Phase 2.1 of the intent-network-interception roadmap. Exposes ONE tool —
 * `register_intent` — that any MCP-capable client (Claude Desktop, Cursor,
 * Goose, ChatGPT Apps, etc.) can call when its agent fires an intent-shaped
 * action. The tool POSTs the DemandEnvelope to PCC's /api/intents/ingest
 * endpoint.
 *
 * Configuration (env vars):
 *   PCC_INTENT_INGEST_URL  full https URL of the ingest endpoint
 *                          default: https://capability.network/api/intents/ingest
 *   PCC_API_KEY            Bearer token for the ingest call. Required for
 *                          live posts; absent → tool returns a non-fatal
 *                          {accepted:false, reason:"no_api_key"}.
 *   INTENT_BROKER_LOG_LEVEL  "silent" | "warn" | "info" (default "warn") —
 *                          all output goes to STDERR so it never collides
 *                          with the MCP wire on STDOUT.
 *
 * What this iteration captures: only the DemandEnvelope fields. No request
 * bodies, no PII. Clients hash identities before sending if any.
 *
 * What this iteration does NOT do: proxying other MCP servers through the
 * broker. That needs a transport-routing design and lands in a separate
 * sprint. This server currently surfaces a single callable tool only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DemandEnvelopeSchema } from "@pcc/spec";

// ── Config ─────────────────────────────────────────────────────────────────

export interface BrokerConfig {
  ingestUrl: string;
  apiKey: string | undefined;
  logLevel: "silent" | "warn" | "info";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  return {
    ingestUrl: (
      env.PCC_INTENT_INGEST_URL ??
      "https://capability.network/api/intents/ingest"
    ).replace(/\/$/, ""),
    apiKey: env.PCC_API_KEY,
    logLevel: ((env.INTENT_BROKER_LOG_LEVEL as BrokerConfig["logLevel"]) ??
      "warn"),
  };
}

// ── Logger (stderr only) ───────────────────────────────────────────────────

function makeLogger(level: BrokerConfig["logLevel"]) {
  const rank = { silent: 0, warn: 1, info: 2 } as const;
  return {
    info: (msg: string) => {
      if (rank[level] >= rank.info) process.stderr.write(`[intent-broker] ${msg}\n`);
    },
    warn: (msg: string) => {
      if (rank[level] >= rank.warn) process.stderr.write(`[intent-broker] WARN ${msg}\n`);
    },
  };
}

// ── HTTP forwarder ─────────────────────────────────────────────────────────

export interface ForwardResult {
  accepted: boolean;
  status?: number;
  envelopeId?: string;
  dedupeKey?: string;
  reason?: string;
  error?: string;
}

/**
 * Post an envelope to the configured PCC ingest URL. Returns a structured
 * result the MCP tool can surface to the calling agent. Never throws —
 * transport failures become {accepted:false, reason:"transport_error"}.
 */
export async function forwardEnvelope(
  envelope: unknown,
  cfg: BrokerConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ForwardResult> {
  if (!cfg.apiKey) {
    return {
      accepted: false,
      reason: "no_api_key",
      error:
        "PCC_API_KEY env var is not set; the broker validates and counts the call but does not forward.",
    };
  }

  try {
    const res = await fetchImpl(cfg.ingestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(envelope),
    });

    const status = res.status;
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // ingest returns JSON; non-JSON is treated as upstream error
    }

    if (!res.ok) {
      return {
        accepted: false,
        status,
        reason: "upstream_error",
        error: typeof body === "object" && body !== null ? JSON.stringify(body) : `HTTP ${status}`,
      };
    }

    const okBody = (body ?? {}) as {
      accepted?: boolean;
      envelopeId?: string;
      dedupeKey?: string;
    };
    return {
      accepted: !!okBody.accepted,
      status,
      envelopeId: okBody.envelopeId,
      dedupeKey: okBody.dedupeKey,
    };
  } catch (e) {
    return {
      accepted: false,
      reason: "transport_error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Tool input shape ───────────────────────────────────────────────────────

/**
 * The tool accepts DemandEnvelope-shaped input. We use a permissive input
 * schema at the MCP layer (every field optional / passthrough) and re-validate
 * via DemandEnvelopeSchema before forwarding — the gateway re-validates a
 * third time, so a malformed payload never reaches the wire.
 */
export const RegisterIntentInputShape = {
  envelope: z
    .record(z.unknown())
    .describe(
      "DemandEnvelope JSON object — see @pcc/spec DemandEnvelopeSchema for the full field list. Required: id, source, compositionSignature, capabilityTypes, summary, budgetBand, urgencyBand, createdAt.",
    ),
} as const;

// ── MCP tool result helper ─────────────────────────────────────────────────

function toolResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

// ── Server factory ─────────────────────────────────────────────────────────

export interface CreateServerOptions {
  config?: BrokerConfig;
  fetchImpl?: typeof fetch;
}

/**
 * Build the MCP server instance with the single `register_intent` tool. The
 * caller is responsible for connecting a transport (stdio for the CLI entry,
 * in-memory transport for tests).
 */
export function createIntentBrokerServer(opts: CreateServerOptions = {}): McpServer {
  const cfg = opts.config ?? loadConfig();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const log = makeLogger(cfg.logLevel);

  const server = new McpServer({
    name: "pcc-intent-broker",
    version: "0.1.0",
  });

  server.tool(
    "register_intent",
    [
      "Register a captured demand-intent envelope with PCC.",
      "Call this whenever the calling agent fires an action whose intent shape matches a DemandEnvelope (a job, a request, a capability invocation).",
      "The broker validates the envelope client-side and forwards it to the configured PCC ingest URL.",
      "Returns {accepted, envelopeId, dedupeKey} on success, or {accepted:false, reason, error} otherwise.",
    ].join(" "),
    RegisterIntentInputShape,
    async ({ envelope }: { envelope: Record<string, unknown> }) => {
      const parsed = DemandEnvelopeSchema.safeParse(envelope);
      if (!parsed.success) {
        log.warn(`rejected malformed envelope: ${parsed.error.message}`);
        return toolResult({
          accepted: false,
          reason: "invalid_envelope",
          error: parsed.error.flatten(),
        });
      }
      const result = await forwardEnvelope(parsed.data, cfg, fetchImpl);
      if (result.accepted) {
        log.info(
          `forwarded envelopeId=${result.envelopeId ?? "?"} dedupeKey=${result.dedupeKey ?? "?"}`,
        );
      } else {
        log.warn(`forward rejected: ${result.reason ?? "unknown"} (${result.error ?? ""})`);
      }
      return toolResult(result);
    },
  );

  return server;
}
