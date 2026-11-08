import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAbi, toFunctionSelector, toEventSelector, type AbiFunction, type AbiEvent } from "viem";
import { VNextSettlementEscrowABI, VNextSettlementEscrowFactoryABI } from "@pcc/contracts/vnext";
import {
  SETTLEMENT_RECHECK_MAPS, KIT_ABI, KNOWN_DEPLOYMENTS, KIT_VERSION,
  recheckKitDescriptor, PHASE_BY_STATE, FINAL_STATE_BY_STATE, TERMINAL_STATES, ALLOCATED_STATES,
} from "@pcc/spec/recheck";
import { settlementRecheckKitRoutes } from "../routes/settlement-recheck-kit.js";
import { settlementReadRoutes, setSettlementUnitReader, type SettlementUnitReader } from "../routes/settlement-read.js";
import { UnitState } from "../settlement/unit-state-mapper.js";
import { vnextDeploymentRecord } from "../services/paid-scope-activation-terms.js";

const contractsRoot = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string) => readFileSync(path, "utf8");
const MAP = SETTLEMENT_RECHECK_MAPS["vnext-read-v1"];
const ABI = { escrow: parseAbi(KIT_ABI.escrow), factory: parseAbi(KIT_ABI.factory) };
const UNIT = "0x" + "ab".repeat(32);
const SNAP = { asOfBlock: 100n, asOfBlockHash: "0x" + "cd".repeat(32), finality: "finalized", logCompleteness: "complete" } as const;
const DEPLOYMENT = { chainId: 84532, factory: "0x" + "fa".repeat(20), implementation: "0x" + "1e".repeat(20), recordSha256: "ab".repeat(32) };
const ROUTES = ["lifecycle", "receipt", "provenance"] as const;
type Route = typeof ROUTES[number];
type Body = Record<string, any>;
const bodies: Record<Route, Body[]> = { lifecycle: [], receipt: [], provenance: [] };
const statuses: number[] = [];
function setEnv(name: string, value: string | undefined) {
  vi.stubEnv(name, value ?? "");
  if (value === undefined) delete process.env[name];
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); setSettlementUnitReader(null); });
function reader(state: UnitState, over: Partial<SettlementUnitReader> = {}): SettlementUnitReader {
  return {
    binding: async () => ({ chainId: 84532, escrow: "0xEscrow", deployment: DEPLOYMENT, windows: { challengeWindow: 600n, appealWindow: 1500n } }),
    pinSnapshot: async () => SNAP,
    readAnchors: async () => ({ state, assertedAt: 1000n, challengedAt: 2000n, assertionCutoff: 3000n, remainingClaimCount: state >= 8 ? 0n : state >= 6 ? 1n : undefined }),
    readRefundWitness: async () => ({ finalized: { released: false, code: 2 } }),
    readZeroingDischargeBlock: async () => 99n,
    readEconomics: async () => ({ amount: "100", feeAmount: "5", recipient: "0xPayee", token: "0xUSDC", assuranceTier: 1 }),
    readAssetIdentity: async () => ({ assetReality: "test", registryId: "r1", revision: 3 }),
    readProvenance: async () => ({ availability: "AVAILABLE", compositionRoot: "0xroot", revision: 1, leaves: [{ kind: "a", value: "one" }, { kind: "b", value: "two" }], nextCursor: "cursor-2" }),
    readOwnerTenant: async () => null, ...over,
  };
}
async function collect(state: UnitState, over: Partial<SettlementUnitReader> = {}) {
  setSettlementUnitReader(reader(state, over));
  const app = Fastify();
  app.addHook("onRequest", async req => { (req as unknown as { tenantId: string }).tenantId = "tenant-a"; });
  await app.register(settlementReadRoutes);
  try {
    for (const route of ROUTES) {
      const res = await app.inject({ method: "GET", url: `/api/settlement/units/${UNIT}/${route}` });
      statuses.push(res.statusCode); bodies[route].push(res.json());
    }
  } finally { await app.close(); }
}
beforeAll(async () => {
  for (const state of [1,2,3,4,5,6,7,8,9] as UnitState[]) await collect(state);
  await collect(UnitState.SETTLED_REFUNDED, { pinSnapshot: async () => ({ ...SNAP, logCompleteness: "incomplete" }), readRefundWitness: async () => ({}), readZeroingDischargeBlock: async () => undefined });
  await collect(UnitState.FUNDED_ACTIVE, { readEconomics: async () => undefined });
  await collect(UnitState.FUNDED_ACTIVE, { readAssetIdentity: async () => ({ assetReality: "unknown", registryId: "r2" }) });
  for (const availability of ["WITHHELD", "UNANCHORED"] as const) await collect(UnitState.FUNDED_ACTIVE, { readProvenance: async () => ({ availability }) });
  setSettlementUnitReader(null);
});
function flatten(value: unknown, prefix = "", out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    out.add(prefix + "/*"); for (const element of value) flatten(element, prefix + "/*", out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) { const pointer = prefix + "/" + key; out.add(pointer); flatten(item, pointer, out); }
  }
  return out;
}
const sorted = (items: Iterable<string>) => [...items].sort();
const canonical = (item: AbiFunction | AbiEvent) => `${item.name}(${item.inputs.map(p => p.type).join(",")})`;
const selector = (item: AbiFunction | AbiEvent) => item.type === "event" ? toEventSelector(item) : toFunctionSelector(item);
const PINS: Record<string, string> = {
  "settlement(bytes32)": "0x115785ee", "unitCounters(bytes32)": "0x0c5aca79", "unitTerms(bytes32)": "0x2ad489ed",
  "feeAmountsOf(bytes32)": "0x6c523346", "payoutAt(bytes32,uint256)": "0x1e7d162f", "requiredTierOf(bytes32)": "0x984ba332",
  "compositionRootOf(bytes32)": "0xae576fd7", "unitExists(bytes32)": "0xb0db18ad", "emergencyAnchorOf(bytes32)": "0xff6ef8e5",
  "initialized()": "0x158ef93e", "factory()": "0xc45a0155", "USDC()": "0x89a30271", "implementation()": "0x5c60da1b",
  "Finalized(bytes32,bool,uint8)": "0x376ddd15bbb3f80631b75629ce073b8e7b0986c38539b19ecafd468fb2a2fb1a",
  "EscalationResolved(bytes32,bytes32,uint8,bool)": "0x80f5cfd14e62601fb5210041726f0eb0dce1b48cb7cbb8a53e6da99ec56c721c",
  "ReleaseAllocated(bytes32,uint256)": "0x027f6e4c8ebce37645149e6b0b68699811e190b74ecfb619734822cb35219420",
  "RefundAllocated(bytes32,uint256)": "0x2fece9b6f1acc81b244c4bde917d4737df62bda83258eb681240460113bb3d58",
  "ClaimCreated(bytes32,bytes32,uint256,uint8,address,uint256)": "0xca2397b5fee9c9ff08e892bdb054290eafb220ecd68be7853f4948d6db277571",
  "ClaimDischarged(bytes32,bytes32,address,uint256)": "0xe525c1af03c162ad35592aff4c9388ae955424eba5f84af4f87ba47dfc944c1a",
};

describe("N266 kit conformance", () => {
  it.each(ROUTES)("C1 %s map pointers equal real body pointers, both ways", route => {
    const mapPointers = MAP.filter(row => row.routes.includes(route)).map(row => row.pointer);
    const actual = new Set(bodies[route].flatMap(body => [...flatten(body)]));
    expect(sorted(actual), `missing=${mapPointers.filter(p => !actual.has(p))}; extra=${[...actual].filter(p => !mapPointers.includes(p))}`).toEqual(sorted(mapPointers));
    // Every specimen must include mandatory fields, even when other specimens have them.
    for (const body of bodies[route]) {
      const expected = mapPointers.filter(pointer => {
        if (pointer === "/assetReality/revision" && body.assetReality && body.assetReality.revision === undefined) return false;
        const parts = pointer.slice(1).split("/"); let parent: any = body;
        for (const part of parts.slice(0, -1)) {
          parent = part === "*" ? parent?.[0] : parent?.[part];
          if (parent === null || (parent !== undefined && typeof parent !== "object")) return false;
        }
        if (route === "provenance" && body.provenanceAvailability !== "AVAILABLE" && ["/compositionRoot", "/revision", "/leaves", "/nextCursor"].some(p => pointer === p || pointer.startsWith(p + "/"))) return false;
        return true;
      });
      expect(sorted(flatten(body)), `pointer diff in ${route}: ${JSON.stringify(body)}`).toEqual(sorted(expected));
    }
  });
  it("C2 at least nine successful lifecycle and receipt specimens", () => {
    expect(bodies.lifecycle.length).toBeGreaterThanOrEqual(9); expect(bodies.receipt.length).toBeGreaterThanOrEqual(9);
    expect(statuses.every(status => status === 200), statuses.join(",")).toBe(true);
    expect(bodies.receipt.some(b => b.refundReason?.value === "BACKUP_NO_RELEASE")).toBe(true);
    expect(bodies.receipt.some(b => b.refundReason === "UNKNOWN" && b.finalizedBlock === "UNKNOWN")).toBe(true);
    expect(bodies.receipt.some(b => b.economics === null && b.assetReality === null)).toBe(true);
  });
  it("C3 money rows are the design's literal pointer list", () => {
    const common = ["/chainId", "/escrow", "/unitId", "/deployment", "/deployment/chainId", "/deployment/factory", "/deployment/implementation", "/deployment/recordSha256", "/asOfBlock", "/asOfBlockHash", "/finality"];
    const expected = {
      lifecycle: [...common, "/unitState", "/phase", "/finalState", "/isTerminal", "/isAllocated", "/windowEndsAt"],
      receipt: [...common, "/phase", "/finalState", "/isAllocated", "/network", "/network/chainId", "/assetReality", "/assetReality/value", "/assetReality/attests", "/economics", "/economics/amount", "/economics/feeAmount", "/economics/recipient", "/economics/token", "/economics/assuranceTier", "/refundReason", "/refundReason/value", "/finalizedBlock", "/finalizedBlock/value"],
      provenance: common,
    };
    for (const route of ROUTES) expect(sorted(MAP.filter(row => row.money && row.routes.includes(route)).map(row => row.pointer))).toEqual(sorted(expected[route]));
  });
  it("C4 every call/log has an ABI item, arity and output; derived inputs resolve", () => {
    for (const row of MAP) {
      for (const read of row.reads) if (read.kind === "call" || read.kind === "logs") {
        const item = ABI[read.contract].find(item => item.type === (read.kind === "call" ? "function" : "event") && item.name === (read.kind === "call" ? read.fn : read.event)) as AbiFunction | AbiEvent | undefined;
        expect(item, `${row.pointer}: ${JSON.stringify(read)}`).toBeDefined();
        if (read.kind === "call") {
          expect(read.args).toHaveLength(item!.inputs.length);
          const outputs = (item as AbiFunction).outputs;
          expect(outputs.some((output, i) => output.name === read.output || String(i) === read.output), `${read.fn} output ${read.output}`).toBe(true);
        } else expect(item!.inputs[read.unitIdTopic - 1]).toMatchObject({ name: "unitId", indexed: true });
      }
      const sources = Array.isArray(row.source) ? row.source : [row.source];
      if (sources.includes("derived")) {
        expect(Array.isArray(row.inputs), row.pointer).toBe(true);
        for (const input of row.inputs ?? []) expect(input.startsWith("deployment.") ? input.slice(11) in KNOWN_DEPLOYMENTS[0] : MAP.some(other => other.pointer === input), `${row.pointer} input ${input}`).toBe(true);
      }
    }
  });
  it("C5 all thirteen selectors and six topic0s equal independent cast literals", () => {
    const items = [...ABI.escrow, ...ABI.factory] as (AbiFunction | AbiEvent)[];
    expect(items).toHaveLength(Object.keys(PINS).length);
    for (const item of items) expect(selector(item), canonical(item)).toBe(PINS[canonical(item)]);
  });
  it("C6 overlapping contracts ABI items have identical selectors/topics", () => {
    for (const contract of ["escrow", "factory"] as const) {
      const real = contract === "escrow" ? VNextSettlementEscrowABI : VNextSettlementEscrowFactoryABI;
      for (const item of ABI[contract] as (AbiFunction | AbiEvent)[]) {
        const peer = (real as readonly (AbiFunction | AbiEvent)[]).find(other => other.type === item.type && other.name === item.name);
        if (peer) expect(selector(item), canonical(item)).toBe(selector(peer));
      }
    }
  });
  it("C7 every item matches Solidity inputs, view returns or public getter type", () => {
    const types = (params: string) => params.trim() === "" ? [] : params.split(",").map(p => p.trim().split(/\s+/).filter(p => !["calldata", "memory", "indexed"].includes(p))[0].replace(/^(UnitState|ClaimClass)$/, "uint8"));
    for (const contract of ["escrow", "factory"] as const) {
      const src = read(join(contractsRoot, `src/${contract === "escrow" ? "VNextSettlementEscrow" : "VNextSettlementEscrowFactory"}.sol`)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      for (const item of ABI[contract] as (AbiFunction | AbiEvent)[]) {
        if (item.type === "event") {
          const match = src.match(new RegExp(`event\\s+${item.name}\\s*\\(([^)]*)\\)\\s*;`));
          expect(match, canonical(item)).not.toBeNull(); expect(types(match![1])).toEqual(item.inputs.map(p => p.type));
          expect(match![1].split(",").map(p => /\bindexed\b/.test(p))).toEqual(item.inputs.map(p => Boolean(p.indexed)));
        } else {
          const match = src.match(new RegExp(`function\\s+${item.name}\\s*\\(([^)]*)\\)([^{};]*)`));
          if (match) {
            expect(types(match[1]), canonical(item)).toEqual(item.inputs.map(p => p.type));
            expect(match[2], item.name).toMatch(/\bview\b/);
            const returns = match[2].match(/returns\s*\(([^)]*)\)/);
            expect(returns, item.name).not.toBeNull(); expect(types(returns![1]), `${item.name} return types`).toEqual(item.outputs.map(p => p.type));
          } else {
            const getter = src.match(new RegExp(`(\\w+)\\s+public\\s+(?:immutable\\s+)?${item.name}\\s*[;=]`));
            expect(getter, item.name).not.toBeNull(); expect(item.inputs).toEqual([]); expect(item.outputs.map(p => p.type)).toEqual([getter![1]]);
          }
        }
      }
    }
  });
  it("C8 known deployments exactly match every committed record", () => {
    setEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", "1");
    const directory = join(contractsRoot, "deployments/vnext");
    const networks = readdirSync(directory, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(join(directory, d.name, "CANONICAL.json"))).map(d => d.name).sort();
    expect(KNOWN_DEPLOYMENTS.map(d => d.network).sort()).toEqual(networks);
    for (const deployment of KNOWN_DEPLOYMENTS) {
      const record = vnextDeploymentRecord(contractsRoot, deployment.network); expect(record).not.toBeNull();
      for (const key of ["chainId", "factory", "implementation", "usdc", "scheduleId", "scheduleTestnetOnly", "challengeWindowSec", "appealWindowSec", "backupWindowSec", "emergencyReviewWindowSec", "recordSha256"] as const) expect(deployment[key], key).toEqual(record![key]);
      const raw = JSON.parse(read(join(directory, deployment.network, "CANONICAL.json")));
      expect(deployment.implementationCodehash).toBe(raw.implementationCodehash.toLowerCase()); expect(deployment.recordBlockNumber).toBe(raw.blockNumber);
      expect(deployment.readSurface in SETTLEMENT_RECHECK_MAPS).toBe(true);
    }
  });
  it("C9 human table exactly covers every route/pointer and states the version/hash", () => {
    const doc = read(join(repoRoot, "docs/SETTLEMENT_RECHECK.md"));
    const rows = [...doc.matchAll(/^\| (lifecycle|receipt|provenance) \| `(\/[^`]+)` \|/gm)].map(m => `${m[1]} ${m[2]}`);
    const expected = MAP.flatMap(row => row.routes.map(route => `${route} ${row.pointer}`));
    expect(sorted(rows)).toEqual(sorted(expected)); expect(doc).toContain(KIT_VERSION); expect(doc).toContain(recheckKitDescriptor().kitSha256);
    expect(doc).not.toMatch(/\bnpx\b|\bnpm i(nstall)?\b|registry\.npmjs/);
  });
  it("C9b canonical-record layout and redeploy prerequisite are explicit in both paragraphs", () => {
    const doc = read(join(repoRoot, "docs/SETTLEMENT_RECHECK.md"));
    const text = "The record layout holds one canonical record per network (deployments/vnext/<network>/CANONICAL.json), and C8 requires one kit entry per such record. A pre-redeploy reply stays re-checkable after a same-network redeploy only once a location for superseded records exists; the next same-network redeploy has to define it first.";
    const paragraphs = doc.split("\n\n").filter(paragraph => paragraph.startsWith("The ABI is included") || paragraph.startsWith("Each deployment names"));
    expect(paragraphs).toHaveLength(2);
    for (const paragraph of paragraphs) { expect(paragraph).toContain(text); expect(paragraph).not.toMatch(/\bN\d+\b/); }
    expect(doc.split(text)).toHaveLength(3);
    expect(doc).not.toMatch(/retain/i);
  });
  it("C10 deliberate version/hash pair", () => {
    expect([KIT_VERSION, recheckKitDescriptor().kitSha256]).toEqual(["1.0.0", "76eaac0a40b6a8adc2c57f4c5040f0b2ab009d826c54e45b0b6b2a4d516cc817"]);
  });
  it("C11 public static descriptor, exact serialization, hash, headers and no env read", async () => {
    const app = Fastify(); await app.register(settlementRecheckKitRoutes);
    try {
      setEnv("PCC_VNEXT_RECORD_NETWORK", "base-sepolia"); setEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", "1");
      const first = await app.inject({ method: "GET", url: "/.well-known/pcc-settlement-recheck.json" });
      setEnv("PCC_VNEXT_RECORD_NETWORK", undefined); setEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", undefined);
      const second = await app.inject({ method: "GET", url: "/.well-known/pcc-settlement-recheck.json" });
      expect(first.statusCode).toBe(200); expect(first.headers["content-type"]).toMatch(/^application\/json/); expect(first.headers["access-control-allow-origin"]).toBe("*"); expect(first.headers["cache-control"]).toBe("public, max-age=300");
      expect(first.body).toBe(second.body); expect(first.json()).toEqual(recheckKitDescriptor());
      const { kitSha256, ...content } = first.json(); expect(kitSha256).toBe(createHash("sha256").update(JSON.stringify(content), "utf8").digest("hex"));
    } finally { await app.close(); }
  });
  it("C12 derived phase/terminal/allocated tables match real states 1-9", () => {
    for (let state = 1; state <= 9; state++) {
      const body = bodies.lifecycle[state - 1]; expect(body.unitState).toBe(state);
      expect(PHASE_BY_STATE[state]).toBe(body.phase); expect(FINAL_STATE_BY_STATE[state]).toBe(body.finalState);
      expect(TERMINAL_STATES.includes(state)).toBe(body.isTerminal); expect(ALLOCATED_STATES.includes(state)).toBe(body.isAllocated);
      const receipt = bodies.receipt[state - 1]; expect(receipt.phase).toBe(body.phase); expect(receipt.finalState).toBe(body.finalState); expect(receipt.isAllocated).toBe(body.isAllocated);
    }
  });
  it("C13 amount is the recipient's net, with matching descriptor and documentation", async () => {
    const phrase = "the recipient's amount (net of the fee)";
    const row = MAP.find(row => row.pointer === "/economics/amount")!;
    expect(row.rule.toLowerCase()).toContain(phrase); expect(row.reads).toContainEqual({ kind: "call", contract: "escrow", fn: "payoutAt", args: ["unitId", "0"], output: "amount" });
    expect(row.reads.some(read => read.kind === "call" && read.output === "g_")).toBe(false);
    expect(row.reads.some(read => read.kind === "call" && read.fn === "feeAmountsOf" && (read.output === "g_" || read.output === "0"))).toBe(false);
    const app = Fastify(); await app.register(settlementRecheckKitRoutes);
    try { const res = await app.inject({ method: "GET", url: "/.well-known/pcc-settlement-recheck.json" }); expect(res.json().readSurfaces["vnext-read-v1"].find((r: any) => r.pointer === "/economics/amount")).toEqual(row); } finally { await app.close(); }
    const doc = read(join(repoRoot, "docs/SETTLEMENT_RECHECK.md")); expect(doc.split("\n").find(line => line.startsWith("| receipt | `/economics/amount` |"))!.toLowerCase()).toContain(phrase);
    const source = read(fileURLToPath(new URL("../routes/settlement-read.ts", import.meta.url)));
    expect(source).toMatch(/export interface EconomicsRecord\s*\{\s*\/\*\* The recipient's amount \(net of the fee\):[^]*?\*\/\s*amount: string;/);
  });
  it("C14 every kit item is pinned in Forge and ABIDOC section 7", () => {
    const freeze = read(join(contractsRoot, "test/VNextAbiFreeze.t.sol"));
    const section7 = read(join(repoRoot, "docs/VNEXT_SETTLEMENT_ABI.md")).split("## 7.")[1].split("## 8.")[0];
    for (const item of [...ABI.escrow, ...ABI.factory] as (AbiFunction | AbiEvent)[]) {
      const pin = PINS[canonical(item)];
      expect(pin, canonical(item)).toBeDefined();
      expect(freeze, canonical(item)).toMatch(new RegExp(`assertEq\\(\\w+\\.${item.name}\\.selector, bytes${item.type === "event" ? 32 : 4}\\(${pin}\\)`));
      expect(section7, canonical(item)).toContain("`" + canonical(item) + "`");
    }
  });
});
