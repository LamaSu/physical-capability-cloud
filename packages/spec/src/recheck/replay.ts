import { decodeEventLog, decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toEventSelector, type Abi, type Hex } from "viem";
import { KIT_ABI } from "./abi.js";
import { KNOWN_DEPLOYMENTS } from "./deployments.js";
import { KIT_VERSION, recheckKitDescriptor } from "./descriptor.js";
import { ALLOCATED_STATES, FINAL_STATE_BY_STATE, PHASE_BY_STATE, SETTLEMENT_RECHECK_MAPS, TERMINAL_STATES } from "./map.js";
import type { RecheckDeployment, RecheckField, RecheckRoute } from "./types.js";
import type { RecheckRpc } from "./rpc.js";
export { httpRpc, RecheckRpcError } from "./rpc.js";
export type { RecheckRpc } from "./rpc.js";

export type RecheckVerdict = "MATCH" | "MISMATCH" | "UNVERIFIED" | "NOT_CHAIN_CHECKABLE" | "NOT_CLAIMED";
export interface RecheckBlock { number: string; hash: string }
export interface RecheckRowVerdict {
  route: RecheckRoute;
  pointer: string;
  verdict: RecheckVerdict;
  expected: unknown;
  got: unknown;
  block: RecheckBlock | null;
  reason?: string;
  knownDrift?: RecheckField["knownDrift"];
  label: string;
}
export interface RecheckReport {
  kitVersion: typeof KIT_VERSION;
  kitSha256: string;
  status: "CHECKED" | "INVALID_INPUT" | "INCONSISTENT_REPLIES" | "UNSUPPORTED_DEPLOYMENT";
  outcome: "ALL_MATCH" | "MISMATCH" | "UNVERIFIED";
  exitCode: 0 | 1 | 2 | 3;
  deployment: RecheckDeployment | null;
  deploymentStatus: "OFFICIAL" | "UNOFFICIAL" | "UNSUPPORTED";
  pin: { status: "FINALIZED" | "NOT_CANONICAL" | "NODE_BEHIND" | "NOT_FINALIZED" | "UNVERIFIED"; number?: string; hash?: string };
  pins: RecheckReport["pin"][];
  verdicts: RecheckRowVerdict[];
  reason?: string;
}
export interface RecheckOptions {
  replies: unknown;
  rpc: RecheckRpc;
  knownDeployments?: readonly RecheckDeployment[];
  logs?: false | { fromBlock?: number | bigint; window?: number; maxRequests?: number };
  laterBlockForTerminal?: boolean;
  allowMixedPins?: boolean;
}
type Reply = Record<string, any>;
const escrowAbi = parseAbi(KIT_ABI.escrow);
const factoryAbi = parseAbi(KIT_ABI.factory);
const decimal = /^\d+$/;
const address = /^0x[0-9a-fA-F]{40}$/;
const hash = /^0x[0-9a-fA-F]{64}$/;
const pruned = /missing trie node|header not found|state.*not available|pruned|historical state/i;
const frozen = new Set(["/unitState", "/phase", "/finalState", "/isTerminal", "/isAllocated", "/economics"]);
const hexNumber = (n: number | bigint | string) => `0x${BigInt(n).toString(16)}`;
const same = (a: unknown, b: unknown): boolean => {
  if (typeof a === "string" && typeof b === "string" && /^0x[0-9a-f]+$/i.test(a) && /^0x[0-9a-f]+$/i.test(b)) return a.toLowerCase() === b.toLowerCase();
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a), bk = Object.keys(b);
    return ak.length === bk.length && ak.every(k => Object.hasOwn(b, k) && same((a as Reply)[k], (b as Reply)[k]));
  }
  return a === b;
};
const at = (o: any, pointer: string): any => {
  const keys = pointer.slice(1).split("/");
  const walk = (v: any, i: number): any => i === keys.length ? v ?? null : keys[i] === "*" ? (Array.isArray(v) ? v.map(x => walk(x, i + 1)) : []) : walk(v?.[keys[i]!], i + 1);
  return walk(o, 0);
};
const object = (v: unknown): v is Reply => v !== null && typeof v === "object" && !Array.isArray(v);
const shape = (got: unknown, expected: unknown): boolean => expected === null ? got === null : object(got) && object(expected) && same(Object.keys(got).sort(), Object.keys(expected).sort());
const reasonOf = (e: unknown) => pruned.test(String((e as Error)?.message ?? e)) ? "PIN_STATE_UNAVAILABLE" : "RPC read unavailable";
const logReasons = new Set(["not scanned", "log scan budget exceeded", "log scan refused by the RPC", "log scan unavailable", "noncanonical or malformed logs", "logs outside scan range", "noncanonical logs", "no witness in the scanned log range"]);
const logReasonOf = (e: unknown) => reasonOf(e) === "PIN_STATE_UNAVAILABLE" ? "PIN_STATE_UNAVAILABLE" : e instanceof Error && logReasons.has(e.message) ? e.message : "log scan unavailable";
function infer(reply: Reply): RecheckRoute {
  if ("unitState" in reply) return "lifecycle";
  if ("economics" in reply || "network" in reply) return "receipt";
  if ("provenanceAvailability" in reply) return "provenance";
  throw new Error("reply route is not recognizable");
}
function normalize(input: unknown): { route: RecheckRoute; reply: Reply }[] {
  const entries = Array.isArray(input) ? input.map(reply => ({ route: undefined, reply })) : object(input) ? Object.entries(input).map(([route, reply]) => ({ route, reply })) : [];
  if (!entries.length) throw new Error("at least one reply is required");
  return entries.map(({ route, reply }) => {
    if (!object(reply) || !Number.isSafeInteger(reply.chainId) || reply.chainId <= 0 || !address.test(reply.escrow) || !hash.test(reply.unitId)
      || !object(reply.deployment) || !Number.isSafeInteger(reply.deployment.chainId) || !address.test(reply.deployment.factory) || !address.test(reply.deployment.implementation)
      || typeof reply.deployment.recordSha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(reply.deployment.recordSha256)
      || typeof reply.asOfBlock !== "string" || !decimal.test(reply.asOfBlock) || !hash.test(reply.asOfBlockHash)
      || typeof reply.finality !== "string" || !["complete", "incomplete", "unknown"].includes(reply.logCompleteness)) throw new Error("invalid reply shape");
    const r = route ?? infer(reply);
    if (!["lifecycle", "receipt", "provenance"].includes(r)) throw new Error("invalid reply route");
    const required = r === "lifecycle" ? ["unitState", "phase", "finalState", "isTerminal", "isAllocated", "windowEndsAt"] : r === "receipt" ? ["phase", "finalState", "isAllocated", "network", "assetReality", "economics", "refundReason", "finalizedBlock"] : ["provenanceAvailability"];
    if (required.some(k => !(k in reply))) throw new Error("incomplete reply");
    const finalStateShape = reply.finalState === null || typeof reply.finalState === "string";
    if ((r === "lifecycle" || r === "receipt") && (typeof reply.phase !== "string" || !finalStateShape || typeof reply.isAllocated !== "boolean")) throw new Error("invalid lifecycle claims");
    if (r === "lifecycle" && (!Number.isSafeInteger(reply.unitState) || typeof reply.isTerminal !== "boolean" || (reply.windowEndsAt !== null && typeof reply.windowEndsAt !== "string"))) throw new Error("invalid lifecycle shape");
    if (r === "receipt") {
      if (!object(reply.network) || !Number.isSafeInteger(reply.network.chainId) || (reply.assetReality !== null && !object(reply.assetReality))) throw new Error("invalid receipt shape");
      if (reply.economics !== null && (!object(reply.economics) || ["amount", "feeAmount", "recipient", "token"].some(k => typeof reply.economics[k] !== "string") || !Number.isSafeInteger(reply.economics.assuranceTier))) throw new Error("invalid economics shape");
      for (const k of ["refundReason", "finalizedBlock"]) if (reply[k] !== null && reply[k] !== "UNKNOWN" && (!object(reply[k]) || typeof reply[k].value !== "string")) throw new Error("invalid sourced claim");
    }
    if (r === "provenance" && typeof reply.provenanceAvailability !== "string") throw new Error("invalid provenance shape");
    return { route: r as RecheckRoute, reply };
  });
}
function deploymentValid(d: RecheckDeployment): boolean {
  return object(d) && Number.isSafeInteger(d.chainId) && d.chainId > 0 && address.test(d.factory) && address.test(d.implementation) && address.test(d.usdc)
    && hash.test(d.implementationCodehash) && /^[0-9a-f]{64}$/.test(d.recordSha256) && Number.isSafeInteger(d.recordBlockNumber) && d.recordBlockNumber >= 0
    && [d.challengeWindowSec, d.appealWindowSec, d.backupWindowSec, d.emergencyReviewWindowSec].every(n => Number.isSafeInteger(n) && n >= 0)
    && typeof d.network === "string" && typeof d.scheduleId === "string" && typeof d.scheduleTestnetOnly === "boolean" && Object.hasOwn(SETTLEMENT_RECHECK_MAPS, d.readSurface);
}
interface Header { number: string; hash: string }
function header(value: unknown): Header | null {
  if (value === null) return null;
  if (!object(value) || typeof value.number !== "string" || !/^0x[0-9a-f]+$/i.test(value.number) || !hash.test(value.hash)) throw new Error("unidentifiable block");
  return { number: BigInt(value.number).toString(), hash: value.hash.toLowerCase() };
}
function reader(rpc: RecheckRpc, d: RecheckDeployment, reply: Reply, block: Header) {
  const pin = { blockHash: block.hash, requireCanonical: true };
  const cache = new Map<string, Promise<any>>();
  const cached = (k: string, read: () => Promise<any>) => { let p = cache.get(k); if (!p) { p = read(); cache.set(k, p); } return p; };
  const call = (fn: string, contract = "escrow", args: readonly unknown[] = []): Promise<any> => cached(`${contract}:${fn}:${JSON.stringify(args, (_k, v) => typeof v === "bigint" ? v.toString() : v)}`, async () => {
    const abi: Abi = contract === "factory" ? factoryAbi : escrowAbi;
    const data = encodeFunctionData({ abi, functionName: fn, args } as never);
    const result = await rpc.request("eth_call", [{ to: contract === "factory" ? d.factory : reply.escrow, data }, pin]);
    return decodeFunctionResult({ abi, functionName: fn, data: result as Hex });
  });
  const code = (who: string): Promise<Hex> => cached(`code:${who}`, async () => {
    const result = await rpc.request("eth_getCode", [who, pin]);
    if (typeof result !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(result)) throw new Error("invalid code");
    return result as Hex;
  });
  const read = async (fn: string, output: string, contract = "escrow", args: readonly string[] = ["unitId"]) => {
    const value = await call(fn, contract, args.map(a => a === "unitId" ? reply.unitId : BigInt(a)));
    const item = (contract === "factory" ? factoryAbi : escrowAbi).find(x => x.type === "function" && x.name === fn);
    if (!item || item.type !== "function") throw new Error("unsupported ABI read");
    const i = output === "0" ? 0 : item.outputs.findIndex(x => "name" in x && x.name === output);
    if (i < 0) throw new Error("unsupported ABI output");
    return item.outputs.length === 1 ? value : value[i];
  };
  return { call, code, read, block };
}
type Reader = ReturnType<typeof reader>;
interface LogResult { refund: string | null; finalized: string | null }
async function scanLogs(options: RecheckOptions, d: RecheckDeployment, reply: Reply, pin: Header): Promise<LogResult> {
  if (options.logs === false) throw new Error("not scanned");
  const settings = options.logs ?? {};
  let start = BigInt(settings.fromBlock ?? d.recordBlockNumber);
  const end = BigInt(pin.number);
  let window = settings.window ?? 2000;
  const maxRequests = settings.maxRequests ?? 1000;
  let requests = 0;
  const logs: any[] = [];
  const events = escrowAbi.filter(x => x.type === "event");
  while (start <= end) {
    if (requests >= maxRequests) throw new Error("log scan budget exceeded");
    const stop = start + BigInt(window - 1) < end ? start + BigInt(window - 1) : end;
    try {
      requests++;
      const batch = await options.rpc.request("eth_getLogs", [{ address: reply.escrow, fromBlock: hexNumber(start), toBlock: hexNumber(stop), topics: [events.map(toEventSelector)] }]);
      if (!Array.isArray(batch)) throw new Error("invalid log response");
      logs.push(...batch); start = stop + 1n;
    } catch (e) {
      const code = (e as { code?: number }).code, message = String((e as Error)?.message ?? e);
      if (code === -32011 || code === 429 || /request limit reached|rate.?limit|\b429\b/i.test(message)) throw new Error("log scan refused by the RPC");
      if (code === -32614 || code === -32005 || /range|limit(ed)? to|too (many|large|wide)/i.test(message)) {
        if (window <= 50) throw new Error("log scan refused by the RPC");
        window = Math.max(50, Math.floor(window / 2)); continue;
      }
      throw new Error("log scan unavailable");
    }
  }
  const seen = new Set<string>(), headers = new Map<string, Header | null>();
  const decoded: { name: string; args: any; number: bigint; index: bigint }[] = [];
  for (const log of logs) {
    if (!object(log) || log.removed || !same(log.address, reply.escrow) || !Array.isArray(log.topics) || !hash.test(log.blockHash)
      || !/^0x[0-9a-f]+$/i.test(log.blockNumber) || !/^0x[0-9a-f]+$/i.test(log.logIndex)) throw new Error("noncanonical or malformed logs");
    const n = BigInt(log.blockNumber);
    if (n < BigInt(settings.fromBlock ?? d.recordBlockNumber) || n > end) throw new Error("logs outside scan range");
    const key = `${log.blockHash}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!headers.has(log.blockNumber)) headers.set(log.blockNumber, header(await options.rpc.request("eth_getBlockByNumber", [log.blockNumber, false])));
    if (!same(headers.get(log.blockNumber)?.hash, log.blockHash)) throw new Error("noncanonical logs");
    const event = decodeEventLog({ abi: escrowAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
    if (!same((event.args as any).unitId, reply.unitId)) continue;
    decoded.push({ name: event.eventName, args: event.args, number: n, index: BigInt(log.logIndex) });
  }
  decoded.sort((a, b) => a.number < b.number ? -1 : a.number > b.number ? 1 : a.index < b.index ? -1 : a.index > b.index ? 1 : 0);
  let refund: string | null = null, finalized: string | null = null;
  let allocation: bigint | undefined;
  const jobs = new Map<string, boolean>();
  for (const event of decoded) {
    const a = event.args;
    if (event.name === "Finalized" && !a.released) refund = ({ 2: "BACKUP_NO_RELEASE", 3: "EMERGENCY_SILENCE", 4: "DEADLINE_RECLAIM" } as Record<number, string>)[Number(a.reason)] ?? null;
    if (event.name === "EscalationResolved" && !a.upheld) refund = Number(a.role) === 1 ? "APPEAL_OVERTURN" : Number(a.role) === 2 ? "EMERGENCY_OVERTURN" : null;
    if (event.name === "ReleaseAllocated" || event.name === "RefundAllocated") { allocation = a.claimCount; if (allocation === 0n) finalized = event.number.toString(); }
    if (event.name === "ClaimCreated" && Number(a.class) <= 2) jobs.set(a.claimId.toLowerCase(), false);
    if (event.name === "ClaimDischarged" && jobs.has(a.claimId.toLowerCase())) {
      jobs.set(a.claimId.toLowerCase(), true);
      if (allocation !== undefined && allocation > 0n && BigInt(jobs.size) === allocation && [...jobs.values()].every(Boolean)) finalized = event.number.toString();
    }
  }
  return { refund, finalized };
}

/** Replays claims using the embedded map. No descriptor or gateway data can supply rules. */
export async function recheckSettlementReplies(options: RecheckOptions): Promise<RecheckReport> {
  const report: RecheckReport = { kitVersion: KIT_VERSION, kitSha256: recheckKitDescriptor().kitSha256, status: "CHECKED", outcome: "UNVERIFIED", exitCode: 2, deployment: null, deploymentStatus: "UNSUPPORTED", pin: { status: "UNVERIFIED" }, pins: [], verdicts: [] };
  let entries: ReturnType<typeof normalize>;
  try {
    entries = normalize(options.replies);
    const settings = options.logs || {};
    if ((settings.fromBlock !== undefined && (BigInt(settings.fromBlock) < 0n || (typeof settings.fromBlock === "number" && !Number.isSafeInteger(settings.fromBlock))))
      || [settings.window, settings.maxRequests].some(n => n !== undefined && (!Number.isSafeInteger(n) || n <= 0))) throw new Error("invalid log settings");
    if (options.knownDeployments?.some(d => !deploymentValid(d))) throw new Error("invalid deployment file");
  } catch {
    return { ...report, status: "INVALID_INPUT", exitCode: 3, reason: "invalid replies or replay options" };
  }
  for (let i = 0; i < entries.length; i++) for (const b of entries.slice(i + 1)) {
    const a = entries[i]!.reply;
    const differentPins = !same(a.asOfBlock, b.reply.asOfBlock) || !same(a.asOfBlockHash, b.reply.asOfBlockHash);
    const stable = ["chainId", "escrow", "unitId", "deployment"];
    const shared = Object.keys(a).filter(k => Object.hasOwn(b.reply, k));
    const keys = options.allowMixedPins && differentPins ? stable : shared;
    if (keys.some(k => !same(a[k], b.reply[k]))) return { ...report, status: "INCONSISTENT_REPLIES", exitCode: 3, reason: "replies disagree across routes" };
  }
  const known = options.knownDeployments ?? KNOWN_DEPLOYMENTS;
  // Group pins so mixed replies never borrow state from another block.
  for (const { route, reply } of entries) {
    const d = known.find(x => x.recordSha256 === reply.deployment.recordSha256);
    if (!d || !(Object.hasOwn(SETTLEMENT_RECHECK_MAPS, d.readSurface))) {
      report.status = "UNSUPPORTED_DEPLOYMENT";
      report.verdicts.push({ route, pointer: "/deployment/recordSha256", verdict: "UNVERIFIED", expected: null, got: reply.deployment.recordSha256, block: null, reason: "UNSUPPORTED_DEPLOYMENT", label: "known deployment record" });
      continue;
    }
    report.deployment = d;
    report.deploymentStatus = KNOWN_DEPLOYMENTS.some(x => same(x, d)) ? "OFFICIAL" : "UNOFFICIAL";
    const map = SETTLEMENT_RECHECK_MAPS[d.readSurface as keyof typeof SETTLEMENT_RECHECK_MAPS];
    let byHash: Header | null = null, canonical: Header | null = null, finalized: Header | null = null, chainId: number | undefined, pinError: string | undefined;
    const pin: RecheckReport["pin"] = { status: "UNVERIFIED", number: reply.asOfBlock, hash: reply.asOfBlockHash };
    try {
      finalized = header(await options.rpc.request("eth_getBlockByNumber", ["finalized", false]));
      byHash = header(await options.rpc.request("eth_getBlockByHash", [reply.asOfBlockHash, false]));
      canonical = header(await options.rpc.request("eth_getBlockByNumber", [hexNumber(reply.asOfBlock), false]));
      const chain = await options.rpc.request("eth_chainId", []);
      if (typeof chain !== "string" || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid chain id");
      chainId = Number(BigInt(chain));
      if (!finalized) pinError = "node has no finalized head";
      else if (!byHash) { pin.status = BigInt(reply.asOfBlock) > BigInt(finalized.number) ? "NODE_BEHIND" : "NOT_CANONICAL"; }
      else if (!canonical || !same(canonical.hash, reply.asOfBlockHash) || !same(byHash.hash, reply.asOfBlockHash) || canonical.number !== BigInt(reply.asOfBlock).toString() || byHash.number !== BigInt(reply.asOfBlock).toString()) pin.status = "NOT_CANONICAL";
      else pin.status = BigInt(reply.asOfBlock) > BigInt(finalized.number) ? "NOT_FINALIZED" : "FINALIZED";
    } catch { pinError = "pin could not be checked by the RPC"; }
    report.pins.push(pin); if (report.pins.length === 1) report.pin = pin;
    const block = { number: BigInt(reply.asOfBlock).toString(), hash: reply.asOfBlockHash.toLowerCase() };
    const reads = reader(options.rpc, d, reply, block);
    const later = finalized ? reader(options.rpc, d, reply, finalized) : undefined;
    let logResult: Promise<LogResult> | undefined;
    const settlementState = async (r: Reader) => Number(await r.read("settlement", "state_"));
    const expected = async (field: RecheckField, r: Reader): Promise<{ value: unknown; matches?: boolean; nc?: boolean }> => {
      const p = field.pointer;
      const got = at(reply, p);
      const result = (value: unknown, matches?: boolean, nc?: boolean) => ({ value, matches, nc });
      if (p === "/chainId" || p === "/deployment/chainId" || p === "/network/chainId") return result(chainId, chainId === d.chainId && same(got, chainId));
      if (p === "/deployment") { const v = { chainId: d.chainId, factory: d.factory, implementation: d.implementation, recordSha256: d.recordSha256 }; return result(v, shape(got, v)); }
      if (p === "/deployment/recordSha256") return result(d.recordSha256);
      if (p === "/network") return result({ chainId }, shape(got, { chainId }));
      if (p === "/asOfBlock") return result(byHash?.number ?? null);
      if (p === "/asOfBlockHash") return result(canonical?.hash ?? null);
      if (p === "/finality") return result("finalized");
      if (p === "/escrow") {
        const code = await r.code(reply.escrow);
        const initialized = await r.call("initialized");
        const exists = await r.call("unitExists", "escrow", [reply.unitId]);
        const runtime = `0x363d3d373d3d3d363d73${d.implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`;
        return result(reply.escrow, same(code, runtime) && initialized === true && exists === true);
      }
      if (p === "/unitId") { const exists = await r.call("unitExists", "escrow", [reply.unitId]); return result(exists ? reply.unitId : null, exists === true); }
      if (p === "/deployment/factory") { const v = await r.call("factory"); return result(v, same(got, v) && same(v, d.factory)); }
      if (p === "/deployment/implementation") { const v = await r.call("implementation", "factory"); const code = await r.code(d.implementation); return result(v, same(got, v) && same(v, d.implementation) && same(keccak256(code), d.implementationCodehash)); }
      if (p === "/phase") return result(PHASE_BY_STATE[await settlementState(r)] ?? null);
      if (p === "/finalState") return result(FINAL_STATE_BY_STATE[await settlementState(r)] ?? null);
      if (p === "/isTerminal") return result(TERMINAL_STATES.includes(await settlementState(r)));
      if (p === "/isAllocated") return result(ALLOCATED_STATES.includes(await settlementState(r)));
      if (p === "/windowEndsAt") {
        const state = await settlementState(r);
        let value: bigint | null = null;
        if (state === 2 || state === 5) value = BigInt(await r.read("settlement", "assertedAt_")) + BigInt(d.challengeWindowSec);
        if (state === 3) { value = BigInt(await r.read("settlement", "challengedAt_")) + BigInt(d.appealWindowSec); const anchor = BigInt(await r.read("emergencyAnchorOf", "0")); if (anchor !== 0n && anchor < value) value = anchor; }
        if (state === 4) value = BigInt(await r.read("unitTerms", "reclaimAt_")) - BigInt(d.challengeWindowSec + d.appealWindowSec);
        return result(value === null ? null : value.toString());
      }
      if (p === "/assetReality/source") return result("registry");
      if (p === "/assetReality/attests") return result("identity-not-liveness");
      if (p === "/economics") { const count = await r.read("unitCounters", "payoutCount_"); const v = { amount: "the recipient's amount (net of the fee)", feeAmount: "decimal", recipient: "address", token: d.usdc, assuranceTier: "tier" }; return result(count === 1n ? v : null, count === 1n && shape(got, v)); }
      if (p.startsWith("/refundReason") || p.startsWith("/finalizedBlock")) {
        logResult ??= scanLogs(options, d, reply, block);
        const logs = await logResult;
        const state = await settlementState(reads);
        const base = p.startsWith("/refundReason") ? "/refundReason" : "/finalizedBlock";
        const required = base === "/refundReason" ? [7, 9].includes(state) : TERMINAL_STATES.includes(state);
        const found = base === "/refundReason" ? logs.refund : logs.finalized;
        // Every refund and settlement path emits a witness; absence means the scan is incomplete.
        if (required && found === null) throw new Error("no witness in the scanned log range");
        const value = required ? found : null;
        const envelope = value === null ? null : { value, source: "log", chain: `eip155:${d.chainId}`, contractOrRegistryId: reply.escrow, blockNumber: reply.asOfBlock, blockHash: reply.asOfBlockHash, finality: reply.finality, completeness: reply.logCompleteness };
        if (p === base) return result(envelope, shape(got, envelope));
        return result(envelope?.[p.slice(base.length + 1) as keyof typeof envelope] ?? null);
      }
      if (p === "/provenanceAvailability") return Number(await r.read("unitTerms", "compositionSchemaVersion_")) === 0 ? result("UNANCHORED") : result(null, undefined, true);
      if (p === "/compositionRoot" && reply.provenanceAvailability !== "AVAILABLE") return result(null, undefined, true);
      const read = field.reads.find(x => x.kind === "call");
      if (read?.kind === "call") {
        const v = await r.read(read.fn, read.output, read.contract, read.args);
        const wire = typeof v === "bigint" ? v.toString() : v;
        return result(wire, p === "/economics/token" ? same(got, wire) && same(wire, d.usdc) : undefined);
      }
      throw new Error("unsupported embedded map rule");
    };
    let escrowTrusted: boolean | undefined;
    for (const field of map.filter(x => x.routes.includes(route))) {
      const p = field.pointer, got = at(reply, p);
      const v: RecheckRowVerdict = { route, pointer: p, verdict: "UNVERIFIED", expected: null, got, block: null, knownDrift: field.knownDrift, label: p === "/economics/amount" ? "the recipient's amount (net of the fee)" : field.rule };
      report.verdicts.push(v);
      const sources = Array.isArray(field.source) ? field.source : [field.source];
      const parent = p.split("/")[1]!;
      if (sources.every(s => ["registry", "gateway-claim", "offchain"].includes(s))) { v.verdict = "NOT_CHAIN_CHECKABLE"; continue; }
      if (got === "UNKNOWN" || (parent === "economics" && reply.economics === null) || (p.includes("/", 1) && ["refundReason", "finalizedBlock", "assetReality"].includes(parent) && (reply[parent] === null || reply[parent] === "UNKNOWN"))) { v.verdict = "NOT_CLAIMED"; continue; }
      const stateRow = !["chain-header", "kit", "echo"].includes(typeof field.source === "string" ? field.source : "") || p === "/unitId" || ["refundReason", "finalizedBlock"].includes(parent);
      if (pinError || (["NODE_BEHIND", "NOT_FINALIZED", "UNVERIFIED"].includes(pin.status) && (stateRow || ["/asOfBlock", "/asOfBlockHash", "/finality"].includes(p)))) { v.reason = pinError ?? (pin.status === "NODE_BEHIND" ? "node behind the pin" : "pin is not finalized by the node"); continue; }
      if (pin.status === "NOT_CANONICAL" && !["/chainId", "/deployment", "/deployment/chainId", "/deployment/recordSha256", "/asOfBlock", "/asOfBlockHash", "/finality", "/network", "/network/chainId"].includes(p)) { v.reason = "NOT_CANONICAL"; continue; }
      if (escrowTrusted === false && stateRow && p !== "/unitId") { v.reason = "escrow identity check failed"; continue; }
      try {
        v.block = block;
        const e = await expected(field, reads);
        v.expected = e.value;
        if (p === "/escrow") escrowTrusted = e.matches;
        v.verdict = e.nc ? "NOT_CHAIN_CHECKABLE" : (e.matches ?? same(got, e.value)) ? "MATCH" : "MISMATCH";
      } catch (e) {
        const logRow = ["refundReason", "finalizedBlock"].includes(parent);
        v.reason = logRow ? logReasonOf(e) : reasonOf(e);
        if (v.reason === "PIN_STATE_UNAVAILABLE" && options.laterBlockForTerminal && reply.finalState !== null && reply.finalState !== undefined && later && (frozen.has(p) || p.startsWith("/economics/"))) {
          try { const e = await expected(field, later); v.expected = e.value; v.block = later.block; v.verdict = (e.matches ?? same(got, e.value)) ? "MATCH" : "MISMATCH"; delete v.reason; } catch { /* Original pin remains unavailable. */ }
        }
      }
    }
  }
  const mismatch = report.verdicts.some(x => x.verdict === "MISMATCH");
  const unavailable = report.verdicts.some(x => x.verdict === "UNVERIFIED") || report.status === "UNSUPPORTED_DEPLOYMENT";
  report.outcome = mismatch ? "MISMATCH" : unavailable ? "UNVERIFIED" : "ALL_MATCH";
  report.exitCode = mismatch ? 1 : unavailable ? 2 : 0;
  return report;
}
