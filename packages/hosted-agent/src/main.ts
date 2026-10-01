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
 *   ANTHROPIC_API_KEY            read by the Anthropic SDK; never logged
 */
import Anthropic from "@anthropic-ai/sdk";
import Database from "better-sqlite3";
import { BudgetMeter, type BudgetCaps, type MessagesClient, type ModelPrice } from "./budget.js";
import { loadPinnedPack, type PackPin, type PinnedPack } from "./pack.js";
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
  try {
    new URL(gatewayBase);
  } catch {
    throw new ConfigError("PCC_HOSTED_GATEWAY_BASE", "is not a URL");
  }
  const sha256 = required(env, "PCC_HOSTED_PACK_SHA256");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new ConfigError("PCC_HOSTED_PACK_SHA256", "must be 64 lowercase hex digits");
  const portRaw = env.PCC_HOSTED_PORT?.trim() || "4420";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new ConfigError("PCC_HOSTED_PORT", "must be a TCP port");
  const l2 = env.PCC_HOSTED_L2?.trim() ?? "";
  if (l2 !== "" && l2 !== "0" && l2 !== "1") throw new ConfigError("PCC_HOSTED_L2", 'must be "1" or "0"');
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
  };
}

/**
 * Send an attempt report to painpoints' store: the gateway's public
 * /api/feedback (contract v1). It sends NO credential (the user's key is never
 * reused for the service's own reporting), and a failed send never blocks a
 * session from closing.
 */
export function attemptSink(
  gatewayBase: string,
  log: (line: string) => void = (l) => console.log(l),
): (report: AttemptReport) => Promise<void> {
  const url = new URL("/api/feedback", gatewayBase).toString();
  return async (report) => {
    log(JSON.stringify({ attempt: report }));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) log(JSON.stringify({ attemptNotStored: res.status }));
    } catch (err) {
      log(JSON.stringify({ attemptNotSent: err instanceof Error ? err.name : "error" }));
    }
  };
}

async function fetchBytes(url: string): Promise<Uint8Array> {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
