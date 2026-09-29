/**
 * Starts the hosted agent from its environment. It refuses to start without a
 * pack pin, caps, prices and a model, and it verifies the pinned pack before it
 * listens. Nothing here logs a key.
 *
 *   PCC_HOSTED_GATEWAY_BASE      the gateway: its /mcp, /mcp/apps and served pack
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
import { loadPinnedPack, type PackPin } from "./pack.js";
import { buildServer } from "./server.js";
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

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`the pack at ${url} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const cfg = readConfig(env);
  const pack = await loadPinnedPack(() => fetchBytes(cfg.packUrl), cfg.pin);
  const meter = new BudgetMeter(new Database(cfg.spendDb), cfg.caps);
  const app = buildServer({
    deps: {
      pack,
      meter,
      price: cfg.price,
      model: cfg.model,
      anthropic: new Anthropic() as unknown as MessagesClient,
      connect: (credential) => connectMcp(cfg.gatewayBase, credential),
      l2Enabled: cfg.l2Enabled,
      // Metadata only, until painpoints' store takes it (item 3) and operator item 99 settles transcripts.
      report: (r) => console.log(JSON.stringify({ attempt: r })),
    },
  });
  await app.listen({ host: cfg.host, port: cfg.port });
  console.log(`hosted agent: pack ${pack.version} (${pack.sha256.slice(0, 12)}), L2 ${cfg.l2Enabled ? "on" : "off"}, listening on ${cfg.host}:${cfg.port}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
