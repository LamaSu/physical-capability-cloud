#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recheckKitDescriptor } from "./descriptor.js";
import { KNOWN_DEPLOYMENTS } from "./deployments.js";
import { httpRpc } from "./rpc.js";
import { recheckSettlementReplies } from "./replay.js";
import type { RecheckDeployment } from "./types.js";

export interface RecheckCliIO {
  fetch?: typeof fetch;
  readFile?: (path: string) => Promise<string>;
  stdin?: () => Promise<string>;
  env?: Record<string, string | undefined>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}
const usage = "Usage: pcc-settlement-recheck --rpc <url> --reply <file|-> [--reply <file|->] [--gateway <origin>] [--no-logs] [--from-block N] [--log-window N] [--max-log-requests N] [--later-block-for-terminal] [--allow-mixed-pins] [--deployment-file <path>] [--json]";
const stdin = async () => { let s = ""; for await (const chunk of process.stdin) s += String(chunk); return s; };
const url = (value: string, originOnly = false) => {
  const u = new URL(value);
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || (originOnly && (u.pathname !== "/" || u.search || u.hash))) throw new Error("invalid URL");
  return u;
};

/** Injectable I/O keeps the CLI's HTTP behavior testable without sockets or subprocesses. */
export async function runCli(args: readonly string[], io: RecheckCliIO = {}): Promise<0 | 1 | 2 | 3> {
  const env = io.env ?? process.env;
  const redact = (s: string) => env.PCC_API_KEY ? s.split(env.PCC_API_KEY).join("[REDACTED]") : s;
  const out = (s: string) => (io.stdout ?? (s => { process.stdout.write(s); }))(redact(s));
  const err = (s: string) => (io.stderr ?? (s => { process.stderr.write(s); }))(redact(s));
  const fetcher = io.fetch ?? globalThis.fetch;
  const read = io.readFile ?? (p => readFile(p, "utf8"));
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const files: string[] = [];
  const bools = ["--no-logs", "--later-block-for-terminal", "--allow-mixed-pins", "--json"];
  const valued = ["--rpc", "--reply", "--gateway", "--from-block", "--log-window", "--max-log-requests", "--deployment-file"];
  let rpcUrl: URL, gateway: URL | undefined, replies: unknown[], knownDeployments: readonly RecheckDeployment[] | undefined;
  let fromBlock: bigint | undefined, window: number | undefined, maxRequests: number | undefined;
  try {
    for (let i = 0; i < args.length; i++) {
      const flag = args[i]!;
      if (bools.includes(flag)) { flags.add(flag); continue; }
      if (!valued.includes(flag)) throw new Error("unknown option");
      const value = args[++i];
      if (!value || (value.startsWith("--"))) throw new Error("missing option value");
      if (flag === "--reply") files.push(value);
      else { if (values.has(flag)) throw new Error("duplicate option"); values.set(flag, value); }
    }
    if (!values.has("--rpc") || !files.length || files.filter(x => x === "-").length > 1) throw new Error("RPC and replies are required");
    rpcUrl = url(values.get("--rpc")!);
    gateway = values.has("--gateway") ? url(values.get("--gateway")!, true) : undefined;
    for (const key of ["--from-block", "--log-window", "--max-log-requests"]) {
      const v = values.get(key);
      if (v !== undefined && (!/^(0|[1-9][0-9]*)$/.test(v) || (key !== "--from-block" && (BigInt(v) <= 0n || BigInt(v) > BigInt(Number.MAX_SAFE_INTEGER))))) throw new Error("invalid numeric option");
    }
    fromBlock = values.has("--from-block") ? BigInt(values.get("--from-block")!) : undefined;
    window = values.has("--log-window") ? Number(values.get("--log-window")) : undefined;
    maxRequests = values.has("--max-log-requests") ? Number(values.get("--max-log-requests")) : undefined;
    replies = [];
    for (const file of files) { const v = JSON.parse(await (file === "-" ? (io.stdin ?? stdin)() : read(file))); replies.push(...(Array.isArray(v) ? v : [v])); }
    if (values.has("--deployment-file")) {
      const v = JSON.parse(await read(values.get("--deployment-file")!));
      const extra = Array.isArray(v) ? v : [v];
      // Explicit records override the corresponding embedded record; the report marks differing records UNOFFICIAL.
      knownDeployments = [...extra, ...KNOWN_DEPLOYMENTS.filter(d => !extra.some(x => x?.recordSha256 === d.recordSha256))];
    }
  } catch {
    err(`Invalid usage or input. ${usage}\n`); return 3;
  }
  let descriptorWarning = false;
  if (gateway) {
    const origin = gateway.origin;
    const gatewayGet = async (path: string) => {
      const target = new URL(path, origin);
      if (target.origin !== origin) throw new Error("gateway origin changed");
      const headers: Record<string, string> = { Accept: "application/json" };
      if (env.PCC_API_KEY) headers.Authorization = `Bearer ${env.PCC_API_KEY}`;
      const response = await fetcher(target.href, { headers, redirect: "error", signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error("gateway request refused");
      return response.json();
    };
    try {
      const descriptor = await gatewayGet("/.well-known/pcc-settlement-recheck.json") as { kitSha256?: unknown };
      descriptorWarning = descriptor.kitSha256 !== recheckKitDescriptor().kitSha256;
    } catch { err("Warning: gateway descriptor could not be compared.\n"); }
    if (descriptorWarning) err("Warning: served kitSha256 differs from the embedded kitSha256; using the embedded kit.\n");
    try {
      // A saved reply supplies the unit and hash; all three fetched routes request that exact snapshot.
      const seed = replies[0] as { unitId?: unknown; asOfBlockHash?: unknown };
      if (typeof seed?.unitId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(seed.unitId) || typeof seed.asOfBlockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(seed.asOfBlockHash)) throw new Error("missing gateway unit/pin");
      replies = [];
      for (const route of ["lifecycle", "receipt", "provenance"]) replies.push(await gatewayGet(`/api/settlement/units/${encodeURIComponent(seed.unitId)}/${route}?asOf=${encodeURIComponent(seed.asOfBlockHash)}`));
    } catch { err("Could not fetch gateway replies.\n"); return 3; }
  }
  const report = await recheckSettlementReplies({ replies, rpc: httpRpc(rpcUrl.href, { fetch: fetcher }), knownDeployments, logs: flags.has("--no-logs") ? false : { fromBlock, window, maxRequests }, laterBlockForTerminal: flags.has("--later-block-for-terminal"), allowMixedPins: flags.has("--allow-mixed-pins") });
  const output = { ...report, rpc: { origin: rpcUrl.origin }, statement: "Chain agreement does not establish brokerage or current state." };
  // Strip controls from field values before serialization, preserving only our own output newlines.
  const printable: typeof output = JSON.parse(JSON.stringify(output, (_key, value) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "") : value));
  // Never echo node/gateway error strings: they may contain authorization data supplied by a remote server.
  if (flags.has("--json")) out(`${JSON.stringify(printable)}\n`);
  else {
    out(`${printable.outcome} (${printable.deploymentStatus}); pin ${printable.pin.status}; kit ${printable.kitVersion} ${printable.kitSha256}\n`);
    out(`RPC ${printable.rpc.origin}\n${printable.statement}\n`);
    for (const v of printable.verdicts) out(`${v.route} ${v.pointer}: ${v.verdict}${v.reason ? ` (${v.reason})` : ""}\n`);
  }
  return report.exitCode;
}
function isDirectRun(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isDirectRun()) {
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => { process.stderr.write("Replay failed.\n"); process.exitCode = 2; });
}
