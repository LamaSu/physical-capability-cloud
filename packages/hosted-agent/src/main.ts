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
import { buildServer, errorCategory, totalLog, type ServerOptions } from "./server.js";
import type { AttemptReport } from "./session.js";
import { connectMcp } from "./tools.js";

/** The variables readConfig validates: a closed set (round 7, 243 F2). */
export type ConfigVariable =
  | "PCC_HOSTED_GATEWAY_BASE"
  | "PCC_HOSTED_PACK_SHA256"
  | "PCC_HOSTED_PORT"
  | "PCC_HOSTED_L2"
  | "PCC_HOSTED_TRUSTED_PROXY_HOPS"
  | "PCC_HOSTED_PACK_VERSION"
  | "PCC_HOSTED_MODEL"
  | "PCC_HOSTED_PRICE_INPUT_USD_PER_MTOK"
  | "PCC_HOSTED_PRICE_OUTPUT_USD_PER_MTOK"
  | "PCC_HOSTED_CAP_SESSION_USD"
  | "PCC_HOSTED_CAP_USER_DAY_USD"
  | "PCC_HOSTED_CAP_MONTH_USD"
  | "PCC_HOSTED_SPEND_DB";
const CONFIG_VARIABLE: Readonly<Record<ConfigVariable, true>> = {
  PCC_HOSTED_GATEWAY_BASE: true,
  PCC_HOSTED_PACK_SHA256: true,
  PCC_HOSTED_PORT: true,
  PCC_HOSTED_L2: true,
  PCC_HOSTED_TRUSTED_PROXY_HOPS: true,
  PCC_HOSTED_PACK_VERSION: true,
  PCC_HOSTED_MODEL: true,
  PCC_HOSTED_PRICE_INPUT_USD_PER_MTOK: true,
  PCC_HOSTED_PRICE_OUTPUT_USD_PER_MTOK: true,
  PCC_HOSTED_CAP_SESSION_USD: true,
  PCC_HOSTED_CAP_USER_DAY_USD: true,
  PCC_HOSTED_CAP_MONTH_USD: true,
  PCC_HOSTED_SPEND_DB: true,
};

/** What was wrong with a variable: a closed set, each with its own fixed text. A variable's VALUE is
 * never part of the error, so a secret pasted into the wrong variable is never echoed into a log. */
export type ConfigProblem =
  | "required"
  | "not-a-url"
  | "userinfo"
  | "not-sha256-hex"
  | "not-a-port"
  | "not-a-flag"
  | "not-an-integer"
  | "too-many-hops"
  | "not-a-decimal"
  | "too-large"
  | "too-many-decimals";
const CONFIG_PROBLEM_TEXT: Readonly<Record<ConfigProblem, string>> = {
  required: "is required",
  "not-a-url": "is not a URL",
  userinfo: "must not contain userinfo (a credential in the URL itself)",
  "not-sha256-hex": "must be 64 lowercase hex digits",
  "not-a-port": "must be a TCP port",
  "not-a-flag": 'must be "1" or "0"',
  "not-an-integer": "must be a non-negative integer",
  "too-many-hops": "must be at most 8",
  "not-a-decimal": "is not a plain non-negative decimal",
  "too-large": "is too large",
  "too-many-decimals": "must have at most 3 decimal places (an integer nano-USD per token)",
};

export class ConfigError extends Error {
  constructor(
    readonly variable: ConfigVariable,
    readonly problem: ConfigProblem,
  ) {
    super(`${variable}: ${CONFIG_PROBLEM_TEXT[problem]}`);
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

function required(env: NodeJS.ProcessEnv, name: ConfigVariable): string {
  const v = env[name];
  if (v === undefined || v.trim() === "") throw new ConfigError(name, "required");
  return v.trim();
}

/** An exact decimal (up to 9 places) as an integer number of billionths. */
function billionths(value: string, name: ConfigVariable): number {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(value);
  if (!m) throw new ConfigError(name, "not-a-decimal");
  const n = Number(m[1]) * 1_000_000_000 + Number((m[2] ?? "").padEnd(9, "0"));
  if (!Number.isSafeInteger(n)) throw new ConfigError(name, "too-large");
  return n;
}

/** USD per million tokens → integer nano-USD per token (USD/MTok × 1000). */
function nanoPerToken(value: string, name: ConfigVariable): number {
  const b = billionths(value, name);
  if (b % 1_000_000 !== 0) throw new ConfigError(name, "too-many-decimals");
  return b / 1_000_000;
}

export function readConfig(env: NodeJS.ProcessEnv): HostedConfig {
  const gatewayBase = required(env, "PCC_HOSTED_GATEWAY_BASE");
  let gatewayUrl: URL;
  try {
    gatewayUrl = new URL(gatewayBase);
  } catch {
    throw new ConfigError("PCC_HOSTED_GATEWAY_BASE", "not-a-url");
  }
  // P1 (round 5, 239): credentials never enter tool output AT FETCH TIME --
  // a userinfo-bearing gateway base would put a credential on every outgoing
  // request line this service makes (connectMcp, fetchBytes), which an error
  // or a log could then echo back. The gateway is this service's OWN
  // deploy-time config, never a per-user address, so it has no legitimate
  // reason to carry one.
  if (gatewayUrl.username !== "" || gatewayUrl.password !== "") {
    throw new ConfigError("PCC_HOSTED_GATEWAY_BASE", "userinfo");
  }
  const sha256 = required(env, "PCC_HOSTED_PACK_SHA256");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new ConfigError("PCC_HOSTED_PACK_SHA256", "not-sha256-hex");
  const portRaw = env.PCC_HOSTED_PORT?.trim() || "4420";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new ConfigError("PCC_HOSTED_PORT", "not-a-port");
  const l2 = env.PCC_HOSTED_L2?.trim() ?? "";
  if (l2 !== "" && l2 !== "0" && l2 !== "1") throw new ConfigError("PCC_HOSTED_L2", "not-a-flag");
  const hopsRaw = required(env, "PCC_HOSTED_TRUSTED_PROXY_HOPS");
  if (!/^\d+$/.test(hopsRaw)) throw new ConfigError("PCC_HOSTED_TRUSTED_PROXY_HOPS", "not-an-integer");
  const trustedProxyHops = Number(hopsRaw);
  if (trustedProxyHops > 8) throw new ConfigError("PCC_HOSTED_TRUSTED_PROXY_HOPS", "too-many-hops");
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
const ATTEMPT_OUTCOME: ReadonlySet<unknown> = new Set(["ok", "budget_stop", "failed"]);
const REPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * The line the sink logs for a report: closed fields only, never the report itself (round 8, 246 MEDIUM).
 * The report carries operator config the log has no need for (the model string, the pack version), and a
 * credential pasted into one of those must not reach the log. Every read of the report happens inside one
 * try, and the result holds only members of closed sets and safe integers, so serializing it cannot throw.
 */
function attemptLine(report: unknown): Record<string, unknown> {
  try {
    const r = report as Record<string, unknown> | null;
    const outcome = r?.outcome;
    const phase = r?.phase;
    const seq = r?.seq;
    const durationMs = r?.durationMs;
    const sessionId = r?.sessionId;
    const tokens = r?.tokens as Record<string, unknown> | null | undefined;
    const tokensIn = tokens?.in;
    const tokensOut = tokens?.out;
    return {
      event: "attempt-report",
      ...(ATTEMPT_OUTCOME.has(outcome) ? { outcome } : {}),
      ...(phase === "session" ? { phase } : {}),
      ...(isCount(seq) ? { seq } : {}),
      ...(Number.isSafeInteger(durationMs) ? { durationMs } : {}),
      ...(isCount(tokensIn) ? { tokensIn } : {}),
      ...(isCount(tokensOut) ? { tokensOut } : {}),
      ...(typeof sessionId === "string" && REPORT_ID.test(sessionId) ? { sessionId } : {}),
    };
  } catch {
    return { event: "attempt-report" };
  }
}

export function attemptSink(
  gatewayBase: string,
  log: (line: string) => void = (l) => console.log(l),
): (report: AttemptReport) => Promise<void> {
  const url = new URL("/api/feedback", gatewayBase).toString();
  // Round 7 (243 F1): the sink never throws, so its logger must not either.
  const safeLog = totalLog(log);
  let notAcceptedLogged = false;
  return async (report) => {
    safeLog(JSON.stringify(attemptLine(report)));
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
      safeLog(JSON.stringify({ event: "attempt-report-not-accepted" }));
    }
  };
}

/**
 * A pack fetch answered with a non-2xx status. It carries the numeric status
 * only. R4 (round 3): never `res.statusText`, the response body or `res.url`
 * (the post-redirect location), which the upstream controls. Round 7 (243 F2):
 * not the configured URL either, since an operator's pack URL may carry a token.
 */
export class PackFetchFailed extends Error {
  constructor(readonly status: number) {
    super(`the pack fetch answered ${status}`);
    this.name = "PackFetchFailed";
  }
}

/** Exported so the property is tested directly, not just read. */
export async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new PackFetchFailed(res.status);
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

const PACK_PIN_FIELD: ReadonlySet<unknown> = new Set(["pin", "sha256", "encoding", "version", "shape"]);

/** Operational error codes a startup failure may name: a closed set, so an operator still sees
 * EADDRINUSE or SQLITE_CANTOPEN, and nothing else a thrown value carries. */
const STARTUP_CODE: ReadonlySet<unknown> = new Set([
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "EACCES",
  "EPERM",
  "ENOENT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "SQLITE_CANTOPEN",
  "SQLITE_READONLY",
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB",
  "SQLITE_BUSY",
  "SQLITE_FULL",
  "SQLITE_PERM",
]);

/**
 * The line to log for a startup failure. main().catch hands it every startup
 * rejection: a config error, a pack fetch or pin failure, the spend database,
 * the listener. Round 7 (243 F2): it is TOTAL and CLOSED. No message is ever
 * logged; each failure becomes an event plus fields from closed sets:
 * - a config error's variable and problem code;
 * - a pin mismatch's field (its message echoes the served pack: Q1-B round 2);
 * - a pack fetch's HTTP status;
 * - otherwise the closed category plus an operational code (the error's own,
 *   or its cause's) from STARTUP_CODE.
 * Every read happens inside one try, so a hostile value logs the generic line.
 */
export function formatStartupFailure(err: unknown): string {
  return JSON.stringify(startupFailureLine(err));
}

function startupFailureLine(err: unknown): Record<string, unknown> {
  try {
    if (err instanceof PackPinMismatch) {
      const field: unknown = err.field;
      return PACK_PIN_FIELD.has(field) ? { event: "pack-pin-mismatch", field } : { event: "pack-pin-mismatch" };
    }
    if (err instanceof ConfigError) {
      const variable: unknown = err.variable;
      const problem: unknown = err.problem;
      return {
        event: "config-error",
        ...(typeof variable === "string" && Object.hasOwn(CONFIG_VARIABLE, variable) ? { variable } : {}),
        ...(typeof problem === "string" && Object.hasOwn(CONFIG_PROBLEM_TEXT, problem) ? { problem } : {}),
      };
    }
    if (err instanceof PackFetchFailed) {
      const status: unknown = err.status;
      return { event: "pack-fetch-failed", ...(Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599 ? { status } : {}) };
    }
    const code: unknown = (err as { code?: unknown } | null)?.code;
    const cause: unknown = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
    return {
      event: "startup-failed",
      error: errorCategory(err),
      ...(STARTUP_CODE.has(code) ? { code } : {}),
      ...(STARTUP_CODE.has(cause) ? { cause } : {}),
    };
  } catch {
    return { event: "startup-failed", error: "other" };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(formatStartupFailure(err));
    process.exit(1);
  });
}
