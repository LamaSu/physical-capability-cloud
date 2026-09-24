/**
 * N25, "the deal seals execution inputs": plan-json.ts, canonical-plan.ts, and their use in the
 * accepted-plan compiler.
 *
 * The golden vector for VCR is execution-contract.vectors.json. Regenerate it ONLY on a deliberate
 * change to the sealed form, with PCC_WRITE_VECTORS=1, and tell VCR.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  acceptedDealDigest,
  acceptedDealPreimage,
  compileAcceptedPlan,
  type AcceptedPlanInput,
  type AcceptedPlanNode,
  type CompiledAcceptedPlan,
  type CompileViolation,
  type ProgramGate,
} from "./accepted-plan-compiler.js";
import { CANONICAL_PLAN_SCHEMA, planHashOf, type CanonicalPlan } from "./canonical-plan.js";
import { copyPlanJson, EMPTY_PLAN_JSON, PLAN_JSON_LIMITS, type PlanJsonObject } from "./plan-json.js";

const ADDR = (b: string) => `0x${b.repeat(20)}` as `0x${string}`;
const DIG = (b: string) => `0x${b.repeat(32)}`;
const USDC = 1_000_000n;
const PROGRAM_T2 = DIG("d2");
const DOC = "e62809887a42910a8af353d240984a2c971d5bc5567f9e0b046b5c14557dd8f3";

const gate: ProgramGate = ({ csd, tierKey, committedProgramHash }) =>
  csd === "document-print-and-mail" && tierKey === "tier2" && committedProgramHash?.toLowerCase() === PROGRAM_T2
    ? { ok: true }
    : { ok: false, code: "program-hash-mismatch" };

function node(partial: Partial<AcceptedPlanNode> & { nodeId: string }): AcceptedPlanNode {
  return {
    capabilityId: `cap-${partial.nodeId}`,
    capabilityType: "document-printing",
    csd: "document-print-and-mail",
    tierKey: "tier0",
    operator: ADDR("AA"),
    payoutAddress: ADDR("A1"),
    grossBaseUnits: 10n * USDC,
    matchedCapabilityDigest: DIG("0C"),
    committedProgramHash: null,
    evidenceRequirements: [{ requirementId: "r", evidenceTypeId: "receipt.kernel_signed", tier: 0 }],
    ...partial,
  };
}

/** The golden plan: a tier-2 print (with a program) before a mail drop, each with execution JSON. */
function goldenPlan(over: { print?: Partial<AcceptedPlanNode>; mail?: Partial<AcceptedPlanNode> } = {}): AcceptedPlanInput {
  return {
    planId: "plan.resv-1",
    requestId: "req-42",
    payer: ADDR("11"),
    currency: "USDC",
    feeBps: 235,
    feeRecipient: ADDR("fe"),
    reclaimAt: 1_900_604_800n,
    nodes: [
      node({
        nodeId: "print",
        tierKey: "tier2",
        committedProgramHash: PROGRAM_T2.toUpperCase().replace("0X", "0x"),
        grossBaseUnits: 6_500_000n,
        evidenceRequirements: [{ requirementId: "print.kernel-log", evidenceTypeId: "execution_completed", tier: 2 }],
        inputs: { documentHash: DOC, pages: 2, copies: 1, duplex: false, notes: null },
        constraints: { deadline: "2026-09-30T00:00:00.000Z", maxRetries: 2 },
        ...over.print,
      }),
      node({
        nodeId: "mail",
        capabilityType: "mail.drop",
        csd: "courier-route",
        operator: ADDR("bb"),
        payoutAddress: ADDR("b1"),
        grossBaseUnits: 3_250_000n,
        matchedCapabilityDigest: DIG("0d"),
        evidenceRequirements: [{ requirementId: "drop.declared", evidenceTypeId: "decl.self_attested", tier: 0 }],
        inputs: { recipient: { name: "Clerk of Court", city: "Zürich — 東京 ✓", lines: ["60 Centre St"] } },
        ...over.mail,
      }),
    ],
    edges: [{ from: "print", to: "mail" }],
    reservation: { reservationId: "resv-1", requestId: "req-42", currency: "USDC", maxAmountBaseUnits: 20n * USDC },
  };
}

function compiled(p: AcceptedPlanInput = goldenPlan()): CompiledAcceptedPlan {
  const r = compileAcceptedPlan(p, { assertProgramForTier: gate });
  if (!r.ok) throw new Error(JSON.stringify(r.violations));
  return r.plan;
}
const bindingOf = (plan: CompiledAcceptedPlan, id: string) => plan.nodeToUnit.find((b) => b.nodeId === id)!;
const jsonSafe = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

describe("copyPlanJson: exactly JSON, bounded, owned, read once", () => {
  it("copies plain JSON exactly into owned, frozen data (-0 becomes 0)", () => {
    const src = { a: [1, "x", null, true, { b: -0 }], c: { d: "é" } };
    const r = copyPlanJson(src);
    expect(r).toEqual({ ok: true, value: { a: [1, "x", null, true, { b: 0 }], c: { d: "é" } } });
    if (!r.ok) return;
    src.a.push(2);
    (src.c as Record<string, unknown>).d = "changed";
    expect(r.value).toEqual({ a: [1, "x", null, true, { b: 0 }], c: { d: "é" } });
    expect(Object.isFrozen(r.value) && Object.isFrozen(r.value.a) && Object.isFrozen(r.value.c)).toBe(true);
    expect(copyPlanJson({})).toEqual({ ok: true, value: EMPTY_PLAN_JSON });
  });

  it("refuses every non-JSON value, and a top level that is not an object", () => {
    const cases: Array<[unknown, string]> = [
      [null, "not-an-object"],
      [[], "not-an-object"],
      ["x", "not-an-object"],
      [undefined, "not-an-object"],
      [{ a: undefined }, "unsupported-value"],
      [{ a: [1, , 3] }, "unsupported-value"],
      [{ a: 1n }, "unsupported-value"],
      [{ a: () => 1 }, "unsupported-value"],
      [{ a: Symbol("s") }, "unsupported-value"],
      [{ a: new Date(0) }, "unsupported-value"],
      [{ a: new Map() }, "unsupported-value"],
      [{ a: new (class K {})() }, "unsupported-value"],
      [{ a: Number.NaN }, "non-finite-number"],
      [{ a: Infinity }, "non-finite-number"],
      [JSON.parse('{"__proto__": {"polluted": true}}'), "reserved-key"],
    ];
    for (const [v, reason] of cases) expect([v, copyPlanJson(v)]).toEqual([v, { ok: false, reason }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("bounds: exactly at each limit is accepted; one over is refused", () => {
    const L = PLAN_JSON_LIMITS;
    const nest = (depth: number): unknown => (depth === 1 ? {} : { x: nest(depth - 1) });
    const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 0]));
    const at: Array<[unknown, unknown, string]> = [
      [nest(L.maxDepth), nest(L.maxDepth + 1), "too-deep"],
      [keys(L.maxKeysPerObject), keys(L.maxKeysPerObject + 1), "too-many-keys"],
      [{ a: Array(L.maxArrayLength).fill(0) }, { a: Array(L.maxArrayLength + 1).fill(0) }, "array-too-long"],
      [{ a: "s".repeat(L.maxStringLength) }, { a: "s".repeat(L.maxStringLength + 1) }, "string-too-long"],
      [{ ["k".repeat(L.maxKeyLength)]: 1 }, { ["k".repeat(L.maxKeyLength + 1)]: 1 }, "key-too-long"],
    ];
    for (const [ok, over, reason] of at) {
      expect(copyPlanJson(ok).ok).toBe(true);
      expect(copyPlanJson(over)).toEqual({ ok: false, reason });
    }
    // values: 1 root + arrays of 250 zeros -> 1 + 4 * (1 + 250) = 1005 values; one more array tips it over
    const many = (arrays: number) => Object.fromEntries(Array.from({ length: arrays }, (_, i) => [`a${i}`, Array(250).fill(0)]));
    expect(copyPlanJson(many(4)).ok).toBe(true);
    expect(copyPlanJson(many(5))).toEqual({ ok: false, reason: "too-many-values" });
    // size: two 4096-char strings are within every per-value limit but over 8192 canonical bytes
    expect(copyPlanJson({ a: "s".repeat(4000), b: "t".repeat(4000) }).ok).toBe(true);
    expect(copyPlanJson({ a: "s".repeat(4096), b: "t".repeat(4096) })).toEqual({ ok: false, reason: "too-large" });
  });

  it("reads every property once: a getter, a key added mid-read, lying proxies and throws", () => {
    let reads = 0;
    const src = {
      get a() {
        reads++;
        (src as Record<string, unknown>).late = "added"; // grows the object while it is being read
        return reads === 1 ? "first" : "second";
      },
      b: 1,
    };
    expect(copyPlanJson(src)).toEqual({ ok: true, value: { a: "first", b: 1 } });
    expect(reads).toBe(1);
    const boom = () => {
      throw Object.defineProperty({}, "message", { get: () => { throw new Error("never inspected"); } });
    };
    const hostile: unknown[] = [
      Object.defineProperty({}, "a", { enumerable: true, get: boom }),
      new Proxy({}, { ownKeys: boom }),
      new Proxy({}, { getPrototypeOf: boom }),
      { a: new Proxy([], { get: (t, k) => (k === "length" ? -1 : Reflect.get(t, k)) }) },
      { a: new Proxy([], { get: (t, k) => (k === "length" ? "2" : Reflect.get(t, k)) }) },
    ];
    for (const h of hostile) expect(copyPlanJson(h)).toEqual({ ok: false, reason: "unreadable" });
  });
});

describe("canonicalPlan and planHash (N25): VCR's execution contract, sealed per node", () => {
  it("planHashOf is VCR's algorithm, byte-exact against crossrepo-accepted-bundle-v1 (and its one-byte mutation)", () => {
    const v1 = {
      capability: "print.mail/v1",
      amountUsd: "60.00",
      payTo: "operator",
      job: { jobId: "job-pm-0001", milestoneIndex: 0, stepId: "step-mail-0001" },
      inputs: { documentHash: DOC, pages: 2, copies: 1, duplex: false, notes: null },
      constraints: { deadline: "2026-08-28T00:00:00.000Z", maxRetries: 2 },
      recipientCity: "Zürich — 東京 ✓",
    };
    expect(planHashOf(v1 as unknown as CanonicalPlan)).toBe("sha256:77416fd47950a4a9242a5b221b74874e6f482f0c9a6e876a17c91fa95312259e");
    expect(planHashOf({ ...v1, amountUsd: "60.01" } as unknown as CanonicalPlan)).toBe(
      "sha256:08e57676e15f2468e486dba4a86dd50e70d879d4a00ef41d7936c4191ed4153d",
    );
  });

  it("every binding carries its canonicalPlan: server terms (lowercased, exact) plus the node's inputs and constraints", () => {
    const plan = compiled();
    const print = bindingOf(plan, "print");
    expect(print.canonicalPlan).toEqual({
      schema: CANONICAL_PLAN_SCHEMA,
      planId: "plan.resv-1",
      planNodeId: "print",
      capability: { type: "document-printing", id: "cap-print", csd: "document-print-and-mail", matchedCapabilityDigest: DIG("0c") },
      operator: ADDR("aa"),
      payTo: ADDR("a1"),
      amount: { baseUnits: "6500000", currency: "USDC", decimals: 6 },
      job: { jobId: print.jobId, milestoneIndex: print.milestoneIndex, stepId: "print" },
      assurance: {
        tier: 2,
        tierKey: "tier2",
        committedProgramHash: PROGRAM_T2,
        evidence: [{ requirementId: "print.kernel-log", evidenceTypeId: "execution_completed", tier: 2 }],
      },
      inputs: { documentHash: DOC, pages: 2, copies: 1, duplex: false, notes: null },
      constraints: { deadline: "2026-09-30T00:00:00.000Z", maxRetries: 2 },
    });
    for (const b of plan.nodeToUnit) {
      expect(b.planHash).toBe(planHashOf(b.canonicalPlan));
      expect(b.planHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(Object.isFrozen(b.canonicalPlan) && Object.isFrozen(b.canonicalPlan.inputs)).toBe(true);
    }
    expect(bindingOf(plan, "mail").canonicalPlan.constraints).toEqual({}); // absent means {}
  });

  it("absent execution JSON is exactly {}: the same planHash and the same deal", () => {
    const absent = goldenPlan({ mail: { constraints: undefined } });
    const empty = goldenPlan({ mail: { constraints: {} } });
    expect(compiled(absent).acceptedDealDigest).toBe(compiled(empty).acceptedDealDigest);
  });

  it("the deal seals them: one input byte, one constraint, or the payee changes that node's planHash AND the deal; the other node's hash is untouched", () => {
    const base = compiled();
    const variants: Array<[string, AcceptedPlanInput]> = [
      ["pages", goldenPlan({ print: { inputs: { documentHash: DOC, pages: 3, copies: 1, duplex: false, notes: null } } })],
      ["document", goldenPlan({ print: { inputs: { documentHash: DOC.replace(/^e/, "f"), pages: 2, copies: 1, duplex: false, notes: null } } })],
      ["deadline", goldenPlan({ print: { constraints: { deadline: "2026-09-30T00:00:00.001Z", maxRetries: 2 } } })],
      ["payee", goldenPlan({ print: { payoutAddress: ADDR("a2") } })],
    ];
    for (const [name, p] of variants) {
      const v = compiled(p);
      expect([name, bindingOf(v, "print").planHash !== bindingOf(base, "print").planHash]).toEqual([name, true]);
      expect([name, v.acceptedDealDigest !== base.acceptedDealDigest]).toEqual([name, true]);
      expect([name, bindingOf(v, "mail").planHash]).toEqual([name, bindingOf(base, "mail").planHash]);
    }
    // The same inputs on two nodes give two different hashes: a plan cannot be replayed on another node.
    const same = compiled(goldenPlan({ mail: { inputs: goldenPlan().nodes[0]!.inputs } }));
    expect(bindingOf(same, "print").planHash).not.toBe(bindingOf(same, "mail").planHash);
  });

  it("recompute-and-compare catches a tampered plan: a carried planHash, or carried content under the old hash", () => {
    const { acceptedDealDigest: sealed, ...rest } = compiled();
    expect(acceptedDealDigest(rest)).toBe(sealed);
    const swap = (i: number, patch: (b: CompiledAcceptedPlan["nodeToUnit"][number]) => object) => ({
      ...rest,
      nodeToUnit: rest.nodeToUnit.map((b, k) => (k === i ? { ...b, ...patch(b) } : b)),
    });
    const tampered = [
      swap(0, () => ({ planHash: `sha256:${"0".repeat(64)}` })),
      swap(0, (b) => ({ canonicalPlan: { ...b.canonicalPlan, inputs: { ...b.canonicalPlan.inputs, pages: 99 } } })),
      swap(1, (b) => ({ canonicalPlan: { ...b.canonicalPlan, payTo: ADDR("ee") } })),
    ];
    for (const t of tampered) expect(acceptedDealDigest(t as typeof rest)).not.toBe(sealed);
    // hex case carries no meaning
    expect(acceptedDealDigest(swap(0, (b) => ({ planHash: b.planHash.toUpperCase().replace("SHA256:", "sha256:") })) as typeof rest)).toBe(sealed);
  });

  it("invalid execution JSON is refused for EVERY bad field, and the diagnostics do not depend on node order", () => {
    const bad = goldenPlan({
      print: { inputs: { pages: Number.NaN } as unknown as PlanJsonObject },
      mail: { inputs: [] as unknown as PlanJsonObject, constraints: { a: 1n } as unknown as PlanJsonObject },
    });
    const r = compileAcceptedPlan(bad, { assertProgramForTier: gate });
    const expected: CompileViolation[] = [
      { code: "invalid-execution-json", nodeId: "mail", field: "constraints", reason: "unsupported-value" },
      { code: "invalid-execution-json", nodeId: "mail", field: "inputs", reason: "not-an-object" },
      { code: "invalid-execution-json", nodeId: "print", field: "inputs", reason: "non-finite-number" },
    ];
    expect(r.ok === false && [...r.violations].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual(expected);
    const reversed = compileAcceptedPlan({ ...bad, nodes: [...bad.nodes].reverse() }, { assertProgramForTier: gate });
    expect(reversed).toEqual(r);
  });

  it("execution JSON is read once and owned: a flipping getter seals its first value; later caller mutation changes nothing", () => {
    let reads = 0;
    const inputs = {
      get pages() {
        reads++;
        return reads === 1 ? 2 : 3;
      },
      documentHash: DOC,
      copies: 1,
      duplex: false,
      notes: null,
    };
    const p = goldenPlan({ print: { inputs: inputs as unknown as PlanJsonObject } });
    const plan = compiled(p);
    expect(reads).toBe(1);
    expect(plan.acceptedDealDigest).toBe(compiled().acceptedDealDigest);
    (p.nodes[1]!.inputs as { recipient: { name: string } }).recipient.name = "someone else";
    expect(bindingOf(plan, "mail").canonicalPlan.inputs).toEqual(goldenPlan().nodes[1]!.inputs);
  });

  it("the node's inputs and constraints PROPERTIES are read once: a getter that flips between reads seals its first answer", () => {
    const golden = goldenPlan();
    const reads = { inputs: 0, constraints: 0 };
    const print = { ...golden.nodes[0]! } as Record<string, unknown>;
    for (const f of ["inputs", "constraints"] as const) {
      const first = golden.nodes[0]![f];
      Object.defineProperty(print, f, { enumerable: true, get: () => (reads[f]++ === 0 ? first : { swapped: true }) });
    }
    const plan = compiled({ ...golden, nodes: [print as unknown as AcceptedPlanNode, golden.nodes[1]!] });
    expect(reads).toEqual({ inputs: 1, constraints: 1 });
    expect(plan.acceptedDealDigest).toBe(compiled().acceptedDealDigest);
  });
});

describe("acceptedDealPreimage: the bytes R13 stores as the sealed deal (amendment #3231)", () => {
  it("the digest IS sha256 of the preimage's UTF-8 bytes; the preimage carries the settlement terms and each planHash", () => {
    const { acceptedDealDigest: sealed, ...rest } = compiled();
    const pre = acceptedDealPreimage(rest);
    expect(`0x${createHash("sha256").update(pre, "utf8").digest("hex")}`).toBe(sealed);
    expect(acceptedDealDigest(rest)).toBe(sealed);
    const parsed = JSON.parse(pre);
    expect(parsed.domain).toBe("PCC:accepted-deal:v2");
    expect(parsed.jobs.flatMap((j: { units: Array<{ n: string }> }) => j.units.map((u) => typeof u.n))).toEqual(["string", "string"]);
    expect(parsed.nodeToUnit.map((b: { planHash: string }) => b.planHash)).toEqual(rest.nodeToUnit.map((b) => b.planHash));
  });
});

describe("golden vector for VCR (execution-contract.vectors.json)", () => {
  const VECTOR = fileURLToPath(new URL("./execution-contract.vectors.json", import.meta.url));

  function buildVector() {
    const plan = compiled();
    const mutation = (name: string, node: "print" | "mail", p: AcceptedPlanInput, change: string) => {
      const m = compiled(p);
      return { name, node, change, expected: { planHash: bindingOf(m, node).planHash, acceptedDealDigest: m.acceptedDealDigest } };
    };
    return {
      vector: "pcc.composition.accepted-deal/v2",
      note: "Public test data. canonicalPlan per node (N25) and acceptedDealDigest (domain PCC:accepted-deal:v2), from packages/spec/src/csd/accepted-plan-compiler.ts and canonical-plan.ts.",
      algorithms: {
        planHash: "\"sha256:\" + lowercase hex(sha256(UTF-8(canonicalize(canonicalPlan)))), canonicalize from packages/spec/src/util/canonical.ts",
        acceptedDealDigest: "0x + lowercase hex(sha256(UTF-8(canonicalize(preimage)))); the preimage is built by acceptedDealDigest() in accepted-plan-compiler.ts; each nodeToUnit entry carries planHash and canonicalPlanHash = planHash(canonicalPlan)",
      },
      input: jsonSafe(goldenPlan()),
      expected: {
        acceptedDealDigest: plan.acceptedDealDigest,
        nodes: plan.nodeToUnit.map((b) => ({ nodeId: b.nodeId, planHash: b.planHash, canonicalPlan: b.canonicalPlan })),
        compiledPlan: jsonSafe(plan),
      },
      mutations: [
        mutation("print-pages-2-to-3", "print", goldenPlan({ print: { inputs: { documentHash: DOC, pages: 3, copies: 1, duplex: false, notes: null } } }), "print.inputs.pages: 2 -> 3"),
        mutation("mail-constraint-added", "mail", goldenPlan({ mail: { constraints: { maxRetries: 1 } } }), "mail.constraints: {} -> {maxRetries: 1}"),
        mutation("print-payee", "print", goldenPlan({ print: { payoutAddress: ADDR("a2") } }), "print payTo: 0xa1a1... -> 0xa2a2..."),
      ],
    };
  }

  it("the pinned deal and its mutations reproduce exactly", () => {
    const built = buildVector();
    if (process.env.PCC_WRITE_VECTORS === "1") writeFileSync(VECTOR, JSON.stringify(built, null, 2) + "\n");
    const pinned = JSON.parse(readFileSync(VECTOR, "utf8"));
    expect(jsonSafe(built)).toEqual(pinned);
    for (const n of pinned.expected.nodes) expect(planHashOf(n.canonicalPlan)).toBe(n.planHash);
  });
});
