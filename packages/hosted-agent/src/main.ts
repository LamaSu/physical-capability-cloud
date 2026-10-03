/**
 * Starts the hosted agent from its environment. It refuses to start without a
 * pack pin, caps, prices and a model, and it verifies the pinned pack before it
 * listens. Nothing here logs a key.
 *
 *   PCC_HOSTED_GATEWAY_BASE      the gateway: its /mcp, /mcp/apps, served pack, and
 *                                /api/agent/me (who a signed-in key belongs to)
 *   PCC_HOSTED_PACK_URL          default <gateway base>/agent-package.json
 *   PCC_HOSTED_PACK_VERSION      } the deploy-time pin
 *   PCC_HOSTED_PACK_SHA256       }
 *   PCC_HOSTED_MODEL             the model id (operator item 99)
 *   PCC_HOSTED_PRICE_INPUT_USD_PER_MTOK, PCC_HOSTED_PRICE_OUTPUT_USD_PER_MTOK
 *   PCC_HOSTED_CAP_SESSION_USD, PCC_HOSTED_CAP_USER_DAY_USD, PCC_HOSTED_CAP_MONTH_USD
 *   PCC_HOSTED_SPEND_DB          the spend ledger (SQLite file)
 *   PCC_HOSTED_L2=1              offer L2 tools (default: off)
 *   PCC_HOSTED_HOST              default 127.0.0.1
 *   PCC_HOSTED_PORT              default 4420
 *   PCC_HOSTED_TRUSTED_PROXY_HOPS  how many deployment-proxy hops to trust when reading
 *                                  the client address from X-Forwarded-For (0..8). A
 *                                  deployer must choose: there is no safe default, because
 *                                  guessing wrong either shares one budget address-wide
 *                                  (R2 round 3) or lets a client spoof a fresh one.
 *   ANTHROPIC_API_KEY            read by the Anthropic SDK; never logged
 */
import Anthropic from "@anthropic-ai/sdk";
import Database from "better-sqlite3";
import { BudgetMeter, type BudgetCaps, type MessagesClient, type ModelPrice } from "./budget.js";
import { loadPinnedPack, PackPinMismatch, type PackPin, type PinnedPack } from "./pack.js";
import { gatewayPrincipal } from "./principal.js";
import { buildServer, type ServerOptions } from "./server.js";
import type { AttemptReport } from "./session.js";
import { connectMcp } from "./tools.js";

export class ConfigError extends Error {
  constructor(readonly variable: string, detail: string) {
    super(`${variable}: ${detail}`);
    this.name = "ConfigError";
  }
}

export interface HostedConfig {
  readonly gatewayBase: string;
  readonly packUrl: string;
  readonly pin: PackPin;
  readonly model: string;
  readonly price: ModelPrice;
  readonly caps: BudgetCaps;
  readonly spendDb: string;
  readonly l2Enabled: boolean;
  readonly host: string;
  readonly port: number;
  /** How many deployment-proxy hops to trust for X-Forwarded-For (0..8). Passed
   * straight through to Fastify's own `trustProxy` option (server.ts). */
  readonly trustedProxyHops: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v.trim() === "") throw new ConfigError(name, "is required");
  return v.trim();
}

/** An exact decimal (up to 9 places) as an integer number of billionths. */
function billionths(value: string, name: string): number {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(value);
  if (!m) throw new ConfigError(name, `"${value}" is not a plain non-negative decimal`);
  const n = Number(m[1]) * 1_000_000_000 + Number((m[2] ?? "").padEnd(9, "0"));
  if (!Number.isSafeInteger(n)) throw new ConfigError(name, "is too large");
  return n;
}

/** USD per million tokens → integer nano-USD per token (USD/MTok × 1000). */
function nanoPerToken(value: string, name: string): number {
  const b = billionths(value, name);
  if (b % 1_000_000 !== 0) throw new ConfigError(name, "must have at most 3 decimal places (an integer nano-USD per token)");
  return b / 1_000_000;
}

export function readConfig(env: NodeJS.ProcessEnv): HostedConfig {
  const gatewayBase = required(env, "PCC_HOSTED_GATEWAY_BASE");
  let gatewayUrl: URL;
  try {
    gatewayUrl = new URL(gatewayBase);
  } catch {
    throw new ConfigError("PCC_HOSTED_GATEWAY_BASE", "is not a URL");
  }
  // P1 (round 5, 239): credentials never enter tool output AT FETCH TIME --
  // a userinfo-bearing gateway base would put a credential on every outgoing
  // request line this service makes (connectMcp, fetchBytes), which an error
  // or a log could then echo back. The gateway is this service's OWN
  // deploy-time config, never a per-user address, so it has no legitimate
  // reason to carry one.
  if (gatewayUrl.username !== "" || gatewayUrl.password !== "") {
    throw new ConfigError("PCC_HOSTED_GATEWAY_BASE", "must not contain userinfo (a credential in the URL itself)");
  }
  const sha256 = required(env, "PCC_HOSTED_PACK_SHA256");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new ConfigError("PCC_HOSTED_PACK_SHA256", "must be 64 lowercase hex digits");
  const portRaw = env.PCC_HOSTED_PORT?.trim() || "4420";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new ConfigError("PCC_HOSTED_PORT", "must be a TCP port");
  const l2 = env.PCC_HOSTED_L2?.trim() ?? "";
  if (l2 !== "" && l2 !== "0" && l2 !== "1") throw new ConfigError("PCC_HOSTED_L2", 'must be "1" or "0"');
  const hopsRaw = required(env, "PCC_HOSTED_TRUSTED_PROXY_HOPS");
  if (!/^\d+$/.test(hopsRaw)) throw new ConfigError("PCC_HOSTED_TRUSTED_PROXY_HOPS", "must be a non-negative integer");
  const trustedProxyHops = Number(hopsRaw);
  if (trustedProxyHops > 8) throw new ConfigError("PCC_HOSTED_TRUSTED_PROXY_HOPS", "must be at most 8");
  return {
    gatewayBase,
    packUrl: env.PCC_HOSTED_PACK_URL?.trim() || new URL("/agent-package.json", gatewayBase).toString(),
    pin: { version: required(env, "PCC_HOSTED_PACK_VERSION"), sha256 },
    model: required(env, "PCC_HOSTED_MODEL"),
    price: {
      input: nanoPerToken(required(env, "PCC_HOSTED_PRICE_INPUT_USD_PER_MTOK"), "PCC_HOSTED_PRICE_INPUT_USD_PER_MTOK"),
      output: nanoPerToken(required(env, "PCC_HOSTED_PRICE_OUTPUT_USD_PER_MTOK"), "PCC_HOSTED_PRICE_OUTPUT_USD_PER_MTOK"),
    },
    caps: {
      perSession: billionths(required(env, "PCC_HOSTED_CAP_SESSION_USD"), "PCC_HOSTED_CAP_SESSION_USD"),
      perUserDay: billionths(required(env, "PCC_HOSTED_CAP_USER_DAY_USD"), "PCC_HOSTED_CAP_USER_DAY_USD"),
      perMonth: billionths(required(env, "PCC_HOSTED_CAP_MONTH_USD"), "PCC_HOSTED_CAP_MONTH_USD"),
    },
    spendDb: required(env, "PCC_HOSTED_SPEND_DB"),
    l2Enabled: l2 === "1",
    host: env.PCC_HOSTED_HOST?.trim() || "127.0.0.1",
    port,
    trustedProxyHops,
  };
}

/**
 * Send an attempt report to painpoints' store: the gateway's public
 * /api/feedback (contract v1). It sends NO credential (the user's key is never
 * reused for the service's own reporting), and a failed send never blocks a
 * session from closing.
 *
 * Q6 round 2: master's generic /api/feedback is not the attempt.v1 receiver —
 * it rewrites the report as `kind:"feedback"` and drops contract, sessionId,
 * seq, phase, outcome, harness, pack, tokens and consent. The real receiver
 * (painpoints' #458) is recognized by its OWN answer: a 2xx JSON body whose
 * `sessionId` echoes the report's. Anything else — a non-2xx, a 2xx with no or
 * a different sessionId, a send that throws — is "not accepted", and this sink
 * never claims delivery for it. Logged once per process (this closure's
 * lifetime: one call site for the life of the service) with NO content, since
 * the far end's status/body/URL are not this sink's to repeat into a log.
 */
export function attemptSink(
  gatewayBase: string,
  log: (line: string) => void = (l) => console.log(l),
): (report: AttemptReport) => Promise<void> {
  const url = new URL("/api/feedback", gatewayBase).toString();
  let notAcceptedLogged = false;
  return async (report) => {
    log(JSON.stringify({ attempt: report }));
    let accepted = false;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const body: unknown = await res.json().catch(() => null);
        accepted = body !== null && typeof body === "object" && (body as { sessionId?: unknown }).sessionId === report.sessionId;
      }
    } catch {
      accepted = false;
    }
    if (!accepted && !notAcceptedLogged) {
      notAcceptedLogged = true;
      log(JSON.stringify({ event: "attempt-report-not-accepted" }));
    }
  };
}

/**
 * R4 (round 3, check only): on a non-2xx response, the message carries only
 * the operator's OWN configured `url` and the numeric status — never
 * `res.statusText`, the response body, or `res.url` (the post-redirect
 * location), any of which the upstream gateway (or whatever a redirect
 * pointed at) controls. Exported so the property is tested directly, not just
 * read.
 */
export async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`the pack at ${url} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The model client. It does NOT retry (`maxRetries: 0`): the budget reserves the
 * worst case of ONE request, so an SDK retry would be a second billed attempt
 * behind the same reservation. A failed call is charged its worst case once, and
 * the user may try again, which reserves again.
 */
export function createAnthropicClient(): Anthropic {
  return new Anthropic({ maxRetries: 0 });
}

/** The service's wiring, apart from listening, so it can be tested. */
export function buildServerOptions(
  cfg: HostedConfig,
  pack: PinnedPack,
  meter: BudgetMeter,
  log: (line: string) => void = (l) => console.log(l),
): ServerOptions {
  return {
    deps: {
      pack,
      meter,
      price: cfg.price,
      model: cfg.model,
      anthropic: createAnthropicClient() as unknown as MessagesClient,
      connect: (credential) => connectMcp(cfg.gatewayBase, credential),
      l2Enabled: cfg.l2Enabled,
      // Contract v1, metadata only (no transcript until operator item 99).
      report: attemptSink(cfg.gatewayBase, log),
    },
    // A signed-in budget belongs to the operator the gateway names for the key.
    resolvePrincipal: gatewayPrincipal(cfg.gatewayBase),
    log,
    trustProxy: cfg.trustedProxyHops,
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const cfg = readConfig(env);
  const pack = await loadPinnedPack(() => fetchBytes(cfg.packUrl), cfg.pin);
  const meter = new BudgetMeter(new Database(cfg.spendDb), cfg.caps);
  const app = buildServer(buildServerOptions(cfg, pack, meter));
  await app.listen({ host: cfg.host, port: cfg.port });
  console.log(`hosted agent: pack ${pack.version} (${pack.sha256.slice(0, 12)}), L2 ${cfg.l2Enabled ? "on" : "off"}, listening on ${cfg.host}:${cfg.port}`);
}

/**
 * The line to log for a startup failure (Q1-B round 2). `loadPinnedPack`'s
 * "version" PackPinMismatch echoes the served pack's own `version` field in
 * its message — the SAME upstream trust boundary as the MCP handshake's
 * `serverInfo.version` (Q1-B's original finding), since a compromised or
 * misconfigured gateway serves both. So a PackPinMismatch logs only its
 * closed-set `field`, never the message. Every other startup error (a
 * ConfigError, a pack-fetch HTTP failure) is built entirely from the
 * operator's OWN env vars and config, never from an upstream or caller
 * string, so its message is safe to log in full for operator debugging.
 */
export function formatStartupFailure(err: unknown): string {
  if (err instanceof PackPinMismatch) return JSON.stringify({ event: "pack-pin-mismatch", field: err.field });
  return err instanceof Error ? err.message : String(err);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(formatStartupFailure(err));
    process.exit(1);
  });
}
