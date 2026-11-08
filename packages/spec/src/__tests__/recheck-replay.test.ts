import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters, getAddress, keccak256, parseAbi, zeroAddress, zeroHash, type Hex } from "viem";
import { KIT_ABI } from "../recheck/abi.js";
import { KNOWN_DEPLOYMENTS } from "../recheck/deployments.js";
import { SETTLEMENT_RECHECK_MAPS } from "../recheck/map.js";
import { recheckSettlementReplies } from "../recheck/replay.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const abi = parseAbi(KIT_ABI.escrow);
const factoryAbi = parseAbi(KIT_ABI.factory);
const P = hash(100), F = hash(200), UNIT = hash(1), ESCROW = address(0xabcdef), PAYEE = address(0xabcdef12);
function fixture(state = 9) {
  const implementationCode = "0x1234" as Hex;
  const deployment = { ...KNOWN_DEPLOYMENTS[0]!, implementationCodehash: keccak256(implementationCode), recordBlockNumber: 1 };
  const sourced = (value: unknown) => ({ value, source: "log", chain: `eip155:${deployment.chainId}`, contractOrRegistryId: ESCROW, blockNumber: "100", blockHash: P, finality: "finalized", completeness: "complete" });
  const common = { chainId: deployment.chainId, escrow: ESCROW, unitId: UNIT, deployment: Object.fromEntries(["chainId", "factory", "implementation", "recordSha256"].map(k => [k, (deployment as any)[k]])), asOfBlock: "100", asOfBlockHash: P, finality: "finalized", logCompleteness: "complete" };
  const life: any = { ...common, unitState: state, phase: state === 9 || state === 8 ? "settled" : state === 1 ? "active" : "contest", finalState: state === 9 ? "SETTLED_REFUNDED" : state === 8 ? "SETTLED_RELEASED" : null, isTerminal: state >= 8, isAllocated: false, windowEndsAt: state === 2 ? "610" : state === 3 ? "1520" : null };
  const receipt: any = { ...common, phase: life.phase, finalState: life.finalState, isAllocated: false, network: { chainId: deployment.chainId }, assetReality: { value: "test", source: "registry", contractOrRegistryId: "registry", revision: 1, attests: "identity-not-liveness" }, economics: { amount: "1000000", feeAmount: "20000", recipient: PAYEE, token: deployment.usdc, assuranceTier: 1 }, refundReason: state === 9 ? sourced("DEADLINE_RECLAIM") : null, finalizedBlock: state >= 8 ? sourced("90") : null };
  const provenance: any = { ...common, provenanceAvailability: "AVAILABLE", compositionRoot: hash(333), revision: 1, leaves: [{ kind: "input", value: "x" }], nextCursor: null };
  const replies = [life, receipt, provenance];
  let initialized = true, factory = deployment.factory, cloneCode = `0x363d3d373d3d3d363d73${deployment.implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`;
  let prune = false, finalized = 200, unknown = false, canonical = P, payoutCount = 1n, schema = 1, anchor = 0n;
  let maxWindow = Infinity, logError: any;
  const requests: { method: string; params: any[] }[] = [];
  const event = (name: string, args: any, block: number, index = 0) => {
    const item = abi.find(x => x.type === "event" && x.name === name) as any;
    const nonIndexed = item.inputs.filter((x: any) => !x.indexed);
    return { address: ESCROW, topics: encodeEventTopics({ abi, eventName: name as any, args }), data: encodeAbiParameters(nonIndexed, nonIndexed.map((x: any) => args[x.name])), blockNumber: `0x${block.toString(16)}`, blockHash: hash(block), logIndex: `0x${index.toString(16)}`, transactionIndex: "0x0", transactionHash: hash(999), removed: false };
  };
  let logs: any[] = state >= 8 ? [event("Finalized", { unitId: UNIT, released: state === 8, reason: 4 }, 90), event(state === 9 ? "RefundAllocated" : "ReleaseAllocated", { unitId: UNIT, claimCount: 0n }, 90, 1)] : [];
  const rpc = { async request(method: string, params: any[] = []): Promise<any> {
    requests.push({ method, params });
    if (method === "eth_chainId") return `0x${deployment.chainId.toString(16)}`;
    if (method === "eth_getBlockByHash") return unknown ? null : { number: "0x64", hash: P };
    if (method === "eth_getBlockByNumber") { const n = params[0] === "finalized" ? finalized : Number(BigInt(params[0])); return { number: `0x${n.toString(16)}`, hash: n === 100 ? canonical : n === finalized ? F : hash(n) }; }
    if (method === "eth_getLogs") {
      if (logError) throw logError;
      if (Number(BigInt(params[0].toBlock) - BigInt(params[0].fromBlock) + 1n) > maxWindow) throw Object.assign(new Error("range too wide"), { code: -32614 });
      return logs.filter(l => BigInt(l.blockNumber) >= BigInt(params[0].fromBlock) && BigInt(l.blockNumber) <= BigInt(params[0].toBlock));
    }
    if (method === "eth_getCode" || method === "eth_call") {
      if (prune && params[params.length - 1].blockHash === P) throw new Error("missing trie node");
      if (method === "eth_getCode") return params[0].toLowerCase() === deployment.implementation ? implementationCode : params[0].toLowerCase() === ESCROW.toLowerCase() ? cloneCode : "0x";
      const isFactory = params[0].to.toLowerCase() === deployment.factory;
      const a = isFactory ? factoryAbi : abi;
      const { functionName, args } = decodeFunctionData({ abi: a, data: params[0].data });
      const values: Record<string, any> = { implementation: deployment.implementation, initialized, factory, unitExists: args?.[0] === UNIT, settlement: [state, 10n, zeroHash, false, zeroAddress, 20n, 0n], unitCounters: [0n, payoutCount, 0n], unitTerms: [0n, zeroHash, 1, 5000n, zeroHash, schema, false], feeAmountsOf: [1020000n, 20000n, 1000000n], payoutAt: [PAYEE, 1000000n], requiredTierOf: 1, compositionRootOf: hash(333), emergencyAnchorOf: anchor, USDC: deployment.usdc };
      return encodeFunctionResult({ abi: a, functionName, result: values[functionName] } as any);
    }
    throw new Error(`unexpected method ${method}`);
  } };
  return { replies, life, receipt, provenance, deployment, rpc, requests, event, sourced, run: (options: any = {}) => recheckSettlementReplies({ replies, rpc, knownDeployments: [deployment], ...options }), set: (v: any) => { if ("initialized" in v) initialized = v.initialized; if ("factory" in v) factory = v.factory; if ("cloneCode" in v) cloneCode = v.cloneCode; if ("prune" in v) prune = v.prune; if ("finalized" in v) finalized = v.finalized; if ("unknown" in v) unknown = v.unknown; if ("canonical" in v) canonical = v.canonical; if ("payoutCount" in v) payoutCount = v.payoutCount; if ("schema" in v) schema = v.schema; if ("anchor" in v) anchor = v.anchor; if ("logs" in v) logs = v.logs; if ("maxWindow" in v) maxWindow = v.maxWindow; if ("logError" in v) logError = v.logError; } };
}
const row = (report: any, pointer: string, route?: string) => report.verdicts.find((v: any) => v.pointer === pointer && (!route || v.route === route));
function tamper(reply: any, pointer: string) {
  const keys = pointer.slice(1).split("/"); let target = reply;
  for (const k of keys.slice(0, -1)) target = target[k];
  const k = keys.at(-1)!; const v = target[k];
  if (pointer === "/deployment/recordSha256") { target[k] = "a".repeat(64); return; }
  if (/^0x[0-9a-f]{64}$/i.test(v)) { target[k] = hash(777); return; }
  target[k] = v && typeof v === "object" ? { ...v, extra: true } : typeof v === "boolean" ? !v : typeof v === "number" ? v + 1 : v === null ? "tampered" : /^0x[0-9a-f]{40}$/i.test(v) ? address(456) : v + "0";
}
describe("settlement replay stub cells", () => {
  it("R1 honest replies match every checkable row", async () => { const f = fixture(); const r = await f.run(); expect(r.outcome).toBe("ALL_MATCH"); expect(r.exitCode).toBe(0); expect(r.verdicts.filter(v => !["MATCH", "NOT_CHAIN_CHECKABLE", "NOT_CLAIMED"].includes(v.verdict))).toEqual([]); });
  const money = SETTLEMENT_RECHECK_MAPS["vnext-read-v1"].filter(x => x.money);
  expect(money).toHaveLength(32);
  for (const field of money) it(`R2 money tamper ${field.pointer}`, async () => {
    const f = fixture(); const route = field.routes[0]; const i = ["lifecycle", "receipt", "provenance"].indexOf(route!);
    // Keep cross-route duplicates consistent; each pointer still has one independent expected value.
    for (const r of field.routes) tamper(f.replies[["lifecycle", "receipt", "provenance"].indexOf(r)], field.pointer);
    const result = await f.run(); const got = row(result, field.pointer, route);
    // Authority selection follows R9; an unknown record cannot be replayed using a guessed deployment.
    if (field.pointer === "/deployment/recordSha256") { expect(result.status).toBe("UNSUPPORTED_DEPLOYMENT"); expect(result.exitCode).toBe(2); return; }
    expect(got.verdict).toBe(field.source === "registry" ? "NOT_CHAIN_CHECKABLE" : "MISMATCH");
    const baseline = fixture(); const before = await baseline.run();
    // R3 requires pin failures to invalidate dependent reads. Echoes and unitExists are shared dependencies.
    const dependent: Record<string, string[]> = {
      "/asOfBlock": ["/asOfBlockHash"], "/asOfBlockHash": [], "/unitId": ["/escrow"],
      "/escrow": ["/refundReason/contractOrRegistryId", "/finalizedBlock/contractOrRegistryId"],
      "/finality": ["/refundReason/finality", "/finalizedBlock/finality"],
    };
    const changes = result.verdicts.filter((v: any, j: number) => v.pointer !== field.pointer && v.verdict !== before.verdicts[j]?.verdict);
    if (field.pointer in dependent) expect(changes.filter((v: any) => v.verdict !== "UNVERIFIED" && !dependent[field.pointer]!.includes(v.pointer))).toEqual([]);
    else expect(changes).toEqual([]);
  });
  it("R3 rejects a noncanonical pin", async () => { const f = fixture(); f.set({ canonical: hash(999) }); const r = await f.run(); expect(row(r, "/asOfBlockHash").verdict).toBe("MISMATCH"); expect(row(r, "/unitState").verdict).toBe("UNVERIFIED"); expect(r.pin.status).toBe("NOT_CANONICAL"); expect(r.exitCode).toBe(1); });
  it("R4 unknown hash distinguishes a reorg from a lagging node", async () => { const f = fixture(); f.set({ unknown: true }); expect((await f.run()).exitCode).toBe(1); f.set({ finalized: 50 }); const r = await f.run(); expect(r.exitCode).toBe(2); expect(row(r, "/asOfBlockHash").reason).toContain("node behind the pin"); });
  it("R5 unfinalized pins flag state", async () => { const f = fixture(); f.set({ finalized: 50 }); const r = await f.run(); expect(row(r, "/finality").verdict).toBe("UNVERIFIED"); expect(row(r, "/unitState").verdict).toBe("UNVERIFIED"); });
  it("R6 every state and code request uses a canonical hash pin", async () => { const f = fixture(); await f.run(); const reads = f.requests.filter(r => ["eth_call", "eth_getCode"].includes(r.method)); expect(reads.length).toBeGreaterThan(10); for (const r of reads) expect(r.params.at(-1)).toEqual({ blockHash: P, requireCanonical: true }); });
  it("R7 pruned state and terminal-only later reads", async () => { for (const state of [8, 2]) { const f = fixture(state); f.set({ prune: true }); const first = await f.run(); expect(row(first, "/unitState").verdict).toBe("UNVERIFIED"); expect(row(first, "/unitState").reason).toBe("PIN_STATE_UNAVAILABLE"); const r = await f.run({ laterBlockForTerminal: true }); for (const p of ["/unitState", "/phase", "/finalState", "/isTerminal", "/isAllocated", "/economics/amount"]) { expect(row(r, p).verdict).toBe(state === 8 ? "MATCH" : "UNVERIFIED"); if (state === 8) expect(row(r, p).block).toEqual({ number: "200", hash: F }); } expect(row(r, "/windowEndsAt").verdict).toBe("UNVERIFIED"); } });
  it("R8 rejects fake clones, uninitialized clones and alien factories", async () => { for (const change of [{ cloneCode: "0x1234" }, { cloneCode: `0x363d3d373d3d3d363d73${address(77).slice(2)}5af43d82803e903d91602b57fd5bf3` }, { initialized: false }]) { const f = fixture(); f.set(change); expect(row(await f.run(), "/escrow").verdict).toBe("MISMATCH"); } const f = fixture(); f.set({ factory: address(77) }); expect(row(await f.run(), "/deployment/factory").verdict).toBe("MISMATCH"); });
  it("R9 unknown deployments fail closed; explicit entries are unofficial", async () => { const f = fixture(); const r = await f.run({ knownDeployments: [] }); expect(r.outcome).toBe("UNVERIFIED"); expect(r.status).toBe("UNSUPPORTED_DEPLOYMENT"); expect(r.exitCode).toBe(2); expect((await f.run()).deploymentStatus).toBe("UNOFFICIAL"); });
  it("R10 verifies implementation codehash", async () => { const f = fixture(); f.deployment.implementationCodehash = hash(8); expect(row(await f.run(), "/deployment/implementation").verdict).toBe("MISMATCH"); });
  it("R11 witnesses refund code 4; UNKNOWN is no claim", async () => { const f = fixture(); f.receipt.refundReason = null; let r = await f.run(); expect(row(r, "/refundReason")).toMatchObject({ verdict: "MISMATCH", knownDrift: "E4.1" }); f.receipt.refundReason = "UNKNOWN"; r = await f.run(); expect(row(r, "/refundReason").verdict).toBe("NOT_CLAIMED"); });
  it("R12 inline and deferred finalization excludes bond claims", async () => { const f = fixture(); f.receipt.finalizedBlock = null; expect(row(await f.run(), "/finalizedBlock")).toMatchObject({ verdict: "MISMATCH", knownDrift: "E4.2" }); const logs = [f.event("RefundAllocated", { unitId: UNIT, claimCount: 2n }, 80)]; for (const [i, cls, b] of [[1, 0, 90], [2, 2, 92], [3, 3, 95]]) { logs.push(f.event("ClaimCreated", { unitId: UNIT, claimId: hash(i!), legIndex: 0n, class: cls, recipient: PAYEE, amount: 1n }, 80, i)); logs.push(f.event("ClaimDischarged", { unitId: UNIT, claimId: hash(i!), destination: PAYEE, amount: 1n }, b!, i)); } f.set({ logs }); f.receipt.finalizedBlock = f.sourced("92"); expect(row(await f.run(), "/finalizedBlock/value")).toMatchObject({ verdict: "MATCH", expected: "92" }); });
  it("R13 shrinks capped log windows", async () => { const f = fixture(); f.set({ maxWindow: 200 }); const r = await f.run({ logs: { fromBlock: 0, window: 2000 } }); expect(r.exitCode).toBe(0); /* force a range > 200 without changing pin claims */ const g = fixture(); g.replies.forEach(x => x.asOfBlock = "1000"); const base = g.rpc.request; g.rpc.request = async (m, p) => { if (m === "eth_getBlockByHash") return { number: "0x3e8", hash: P }; if (m === "eth_getBlockByNumber" && p?.[0] === "0x3e8") return { number: "0x3e8", hash: P }; return base(m, p); }; g.receipt.refundReason.blockNumber = "1000"; g.receipt.finalizedBlock.blockNumber = "1000"; g.set({ maxWindow: 200, finalized: 2000 }); expect((await g.run({ logs: { fromBlock: 0, window: 2000 } })).exitCode).toBe(0); const ranges = g.requests.filter(x => x.method === "eth_getLogs"); expect(ranges.length).toBeGreaterThan(5); expect(ranges.slice(-5).every(x => BigInt(x.params[0].toBlock) - BigInt(x.params[0].fromBlock) < 200n)).toBe(true); });
  it("R14 refused logs stay unverified", async () => { const f = fixture(); f.set({ logError: Object.assign(new Error("request limit reached"), { code: -32011 }) }); const r = await f.run(); expect(row(r, "/refundReason")).toMatchObject({ verdict: "UNVERIFIED", reason: "log scan refused by the RPC" }); expect(r.exitCode).toBe(2); });
  it("R15 log budget is bounded", async () => { const f = fixture(); const r = await f.run({ logs: { fromBlock: 0, window: 10, maxRequests: 3 } }); expect(row(r, "/finalizedBlock").reason).toBe("log scan budget exceeded"); expect(f.requests.filter(r => r.method === "eth_getLogs")).toHaveLength(3); });
  it("R16 no logs means not scanned", async () => { const f = fixture(); expect(row(await f.run({ logs: false }), "/refundReason")).toMatchObject({ verdict: "UNVERIFIED", reason: "not scanned" }); });
  it("R17 mixed pins are refused unless explicitly enabled", async () => { const f = fixture(); f.receipt.asOfBlockHash = F; const r = await f.run(); expect(r.status).toBe("INCONSISTENT_REPLIES"); expect(r.exitCode).toBe(3); expect((await f.run({ allowMixedPins: true })).status).not.toBe("INCONSISTENT_REPLIES"); });
  it("R19 address casing and decimal canonical form", async () => { const f = fixture(); f.replies.forEach(x => x.escrow = getAddress(ESCROW)); f.receipt.economics.recipient = getAddress(PAYEE); expect((await f.run()).exitCode).toBe(0); f.receipt.economics.amount = "01000000"; expect(row(await f.run(), "/economics/amount").verdict).toBe("MISMATCH"); });
  it("R23 emergency anchor caps the appeal window", async () => { const f = fixture(3); f.set({ anchor: 1000n }); const r = await f.run(); expect(row(r, "/windowEndsAt")).toMatchObject({ verdict: "MISMATCH", expected: "1000", knownDrift: "E4.3" }); });
  it("R24 multi-leg economics cannot be claimed", async () => { const f = fixture(); f.set({ payoutCount: 2n }); expect(row(await f.run(), "/economics")).toMatchObject({ verdict: "MISMATCH", knownDrift: "E2" }); f.receipt.economics = null; const r = await f.run(); expect(row(r, "/economics").verdict).toBe("NOT_CLAIMED"); expect(row(r, "/economics/amount").verdict).toBe("NOT_CLAIMED"); });
  it("R25 provenance checks anchoring and root, never leaves", async () => { const f = fixture(); f.set({ schema: 0 }); expect(row(await f.run(), "/provenanceAvailability").verdict).toBe("MISMATCH"); f.set({ schema: 1 }); f.provenance.provenanceAvailability = "WITHHELD"; expect(row(await f.run(), "/provenanceAvailability").verdict).toBe("NOT_CHAIN_CHECKABLE"); f.provenance.provenanceAvailability = "AVAILABLE"; f.provenance.compositionRoot = hash(555); const r = await f.run(); expect(row(r, "/compositionRoot").verdict).toBe("MISMATCH"); expect(row(r, "/leaves").verdict).toBe("NOT_CHAIN_CHECKABLE"); });
  it("R26 amount is the recipient's net, never gross", async () => { const f = fixture(); expect(row(await f.run(), "/economics/amount").verdict).toBe("MATCH"); f.receipt.economics.amount = "1020000"; expect(row(await f.run(), "/economics/amount")).toMatchObject({ verdict: "MISMATCH", expected: "1000000", label: "the recipient's amount (net of the fee)" }); });
  it.each([95, 101])("R27 missing required witnesses from block %i stay unverified", async fromBlock => {
    const f = fixture();
    const r = await f.run({ logs: { fromBlock } });
    for (const pointer of ["/refundReason", "/refundReason/value", "/finalizedBlock", "/finalizedBlock/value"]) {
      expect(row(r, pointer)).toMatchObject({ verdict: "UNVERIFIED", reason: "no witness in the scanned log range" });
    }
    expect(r.verdicts.filter(v => v.verdict === "MISMATCH")).toEqual([]);
    expect(r.outcome).toBe("UNVERIFIED");
    expect(r.exitCode).toBe(2);
  });
  it.each(["complete", "incomplete", "unknown"])("R28 accepts gateway log completeness %s and UNKNOWN claims", async completeness => {
    const f = fixture();
    f.replies.forEach(reply => { reply.logCompleteness = completeness; });
    f.receipt.refundReason = f.receipt.finalizedBlock = "UNKNOWN";
    const r = await f.run();
    expect(r.status).toBe("CHECKED");
    for (const pointer of ["/refundReason", "/refundReason/value", "/finalizedBlock", "/finalizedBlock/value"]) expect(row(r, pointer).verdict).toBe("NOT_CLAIMED");
    expect(row(r, "/economics/amount").verdict).toBe("MATCH");
    expect(r.exitCode).toBe(0);
    expect(f.requests.length).toBeGreaterThan(0);
  });
  it("R28 rejects the non-gateway partial completeness before RPC", async () => {
    const f = fixture();
    f.replies.forEach(reply => { reply.logCompleteness = "partial"; });
    expect(await f.run()).toMatchObject({ status: "INVALID_INPUT", exitCode: 3, verdicts: [] });
    expect(f.requests).toEqual([]);
  });
  it.each(["header", "state"])("R29 log-row %s errors use fixed reasons", async failure => {
    const f = fixture();
    const request = f.rpc.request;
    f.rpc.request = async (method, params = []) => {
      if ((failure === "header" && method === "eth_getBlockByNumber" && params[0] === "0x5a")
        || (failure === "state" && method === "eth_call" && params[0].to.toLowerCase() === ESCROW.toLowerCase() && decodeFunctionData({ abi, data: params[0].data }).functionName === "settlement")) {
        throw new Error("NODE-TEXT \u001b[2J\u001b[1;1HALL_MATCH\u0085");
      }
      return request(method, params);
    };
    const r = await f.run();
    expect(row(r, "/refundReason")).toMatchObject({ verdict: "UNVERIFIED", reason: "log scan unavailable" });
    expect(row(r, "/finalizedBlock")).toMatchObject({ verdict: "UNVERIFIED", reason: "log scan unavailable" });
    expect(JSON.stringify(r)).not.toContain("NODE-TEXT");
    expect(r.exitCode).toBe(2);
  });
  it("R30 MR8 rejects a log hash that differs from the canonical header", async () => {
    const f = fixture();
    const finalized = f.event("Finalized", { unitId: UNIT, released: false, reason: 4 }, 90);
    finalized.blockHash = hash(999);
    f.set({ logs: [finalized, f.event("RefundAllocated", { unitId: UNIT, claimCount: 0n }, 90, 1)] });
    const r = await f.run();
    expect(row(r, "/refundReason")).toMatchObject({ verdict: "UNVERIFIED", reason: "noncanonical logs" });
    expect(r.verdicts.some(v => v.verdict === "MISMATCH")).toBe(false);
    expect(r.exitCode).toBe(2);
  });
  it("R31 MR9 rejects a removed Finalized log", async () => {
    const f = fixture();
    const finalized = f.event("Finalized", { unitId: UNIT, released: false, reason: 4 }, 90);
    finalized.removed = true;
    f.set({ logs: [finalized, f.event("RefundAllocated", { unitId: UNIT, claimCount: 0n }, 90, 1)] });
    const r = await f.run();
    expect(row(r, "/refundReason")).toMatchObject({ verdict: "UNVERIFIED", reason: "noncanonical or malformed logs" });
    expect(r.verdicts.some(v => v.verdict === "MISMATCH")).toBe(false);
    expect(r.exitCode).toBe(2);
  });
  it("R32 MR12 refuses a log cap below the 50-block floor", async () => {
    const f = fixture();
    f.set({ maxWindow: 49 });
    const r = await f.run({ logs: { fromBlock: 0, window: 200, maxRequests: 10 } });
    for (const pointer of ["/refundReason", "/finalizedBlock"]) expect(row(r, pointer)).toMatchObject({ verdict: "UNVERIFIED", reason: "log scan refused by the RPC" });
    const ranges = f.requests.filter(x => x.method === "eth_getLogs");
    expect(ranges).toHaveLength(3);
    expect(ranges.map(x => BigInt(x.params[0].toBlock) - BigInt(x.params[0].fromBlock) + 1n)).toEqual([101n, 100n, 50n]);
    expect(r.verdicts.some(v => v.verdict === "MISMATCH")).toBe(false);
    expect(r.exitCode).toBe(2);
  });
  it("R33 MR15 checks the known factory when the reply and escrow agree", async () => {
    const f = fixture();
    const alien = address(77);
    f.replies.forEach(reply => { reply.deployment.factory = alien; });
    f.set({ factory: alien });
    const r = await f.run();
    expect(row(r, "/escrow").verdict).toBe("MATCH");
    expect(row(r, "/deployment/factory")).toMatchObject({ verdict: "MISMATCH", expected: getAddress(alien), got: alien });
    expect(r.exitCode).toBe(1);
  });
  it("R34 MR16 checks the known implementation when the reply and factory agree", async () => {
    const f = fixture();
    const alien = address(77);
    f.replies.forEach(reply => { reply.deployment.implementation = alien; });
    const request = f.rpc.request;
    f.rpc.request = async (method, params = []) => {
      if (method === "eth_call" && params[0].to.toLowerCase() === f.deployment.factory) return encodeFunctionResult({ abi: factoryAbi, functionName: "implementation", result: alien });
      return request(method, params);
    };
    const r = await f.run();
    expect(row(r, "/escrow").verdict).toBe("MATCH");
    expect(row(r, "/deployment/implementation")).toMatchObject({ verdict: "MISMATCH", expected: getAddress(alien), got: alien });
    expect(r.exitCode).toBe(1);
  });
});
