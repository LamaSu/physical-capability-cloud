/**
 * plan-edit-intents (product pack section 5, item 10): safe user edits before acceptance become new
 * constraints/intents for the CALLER's agent, never a plan mutation. PCC never applies an edit to a
 * plan; it only turns `edits` (untrusted, `unknown`) into a typed `PlanEditIntent` against a real
 * `PlanPresentation` (built with `presentPlan`, exactly as external-plan-trace.test.ts does).
 */
import { describe, it, expect } from "vitest";
import type { EvidenceRequirement } from "@pcc/spec";
import { acceptExternalPlan, type ExternalPlanSubmission, type ReservationRecord, type SeamDeps } from "../services/external-plan-seam.js";
import type { LiveCapability, LiveKernel } from "../services/plan-snapshot-revalidation.js";
import { presentPlan, type PlanPresentation, type PlanNodePresentation } from "../services/plan-presentation.js";
import { planEditsToIntent, type PlanConstraint } from "../services/plan-edit-intents.js";

// ── World (copied in spirit from external-plan-trace.test.ts's own stand-ins, trimmed to 2 nodes) ──

const A = (b: string) => `0x${b.repeat(20)}` as `0x${string}`;
const OP_PRINT = A("aa");
const OP_MAIL = A("bb");
const PAYER = A("11");
const FEE = A("fe");
const PROGRAM = `0x${"d2".repeat(32)}`;
const NOW = 1_900_000_000;
const PRINT = "document-print-and-mail";
const ASOF = "2026-09-28T00:00:00.000Z";

const LIVE_CAPS: LiveCapability[] = [
  { id: "cap-print", type: PRINT, kernelId: "k-print", pricing: { currency: "USDC", baseCost: "6.50", minimum: "6.50" }, assuranceTiers: [0, 1, 2], tenantId: null },
  { id: "cap-mail", type: "mail.drop", kernelId: "k-mail", pricing: { currency: "USDC", baseCost: "3.25", minimum: "3.25" }, assuranceTiers: [0], tenantId: null },
];
const LIVE_KERNELS: LiveKernel[] = [
  { id: "k-print", operatorAddress: OP_PRINT, status: "online" },
  { id: "k-mail", operatorAddress: OP_MAIL, status: "online" },
];
const CSD_OF_TYPE: Record<string, string> = { [PRINT]: PRINT, "mail.drop": "courier-route" };
const PROGRAMS: Record<string, string> = { [`${PRINT}|tier2`]: PROGRAM };
const EVIDENCE: Record<string, EvidenceRequirement[]> = {
  [`${PRINT}|tier2`]: [
    { requirementId: "print.kernel-log", evidenceTypeId: "execution_completed", tier: 2 },
    { requirementId: "mail.carrier-scan", evidenceTypeId: "courier_pickup_confirmed", tier: 2 },
  ],
  "courier-route|tier0": [{ requirementId: "drop.declared", evidenceTypeId: "decl.self_attested", tier: 0 }],
};

class ReservationStoreStandIn {
  private rows = new Map<string, ReservationRecord & { sealedDigest?: string }>();
  issue(r: ReservationRecord): void {
    this.rows.set(r.reservationId, { ...r });
  }
  load = (id: string): ReservationRecord | null => {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  };
  sealed(id: string): string | undefined {
    return this.rows.get(id)?.sealedDigest;
  }
  consume(id: string, principal: string, plan: { acceptedDealDigest: string }, now: number): { ok: true } | { ok: false; reason: string } {
    const r = this.rows.get(id);
    if (!r) return { ok: false, reason: "not-found" };
    if (r.principal !== principal) return { ok: false, reason: "wrong-principal" };
    if (r.state !== "issued") return { ok: false, reason: "not-issued" };
    if (r.expiresAt <= now) return { ok: false, reason: "expired" };
    r.state = "consumed";
    r.sealedDigest = plan.acceptedDealDigest;
    return { ok: true };
  }
}

const RESERVATION: ReservationRecord = {
  reservationId: "resv-1",
  principal: "agent:buyer-1",
  requestId: "req-42",
  currency: "USDC",
  maxAmountBaseUnits: 20_000_000n,
  expiresAt: NOW + 3600,
  state: "issued",
  payer: PAYER,
};

function world(overrides: { reservation?: Partial<ReservationRecord> } = {}) {
  const store = new ReservationStoreStandIn();
  store.issue({ ...RESERVATION, ...overrides.reservation });
  const deps: SeamDeps = {
    revalidation: {
      loadCapabilities: (ids) => LIVE_CAPS.filter((c) => ids.includes(c.id)),
      loadKernels: (ids) => LIVE_KERNELS.filter((k) => ids.includes(k.id)),
      csdForType: (t) => CSD_OF_TYPE[t] ?? null,
    },
    resolveProgram: (csd, tierKey) => PROGRAMS[`${csd}|${tierKey}`] ?? null,
    assertProgramForTier: ({ csd, tierKey, committedProgramHash }) =>
      committedProgramHash !== null && PROGRAMS[`${csd}|${tierKey}`] === committedProgramHash.toLowerCase() ? { ok: true } : { ok: false, code: "program-hash-mismatch" },
    evidenceFor: (csd, tierKey) => EVIDENCE[`${csd}|${tierKey}`] ?? null,
    loadReservation: store.load,
    policy: { feeBps: 235, feeRecipient: FEE, reclaimAfterSec: 7 * 24 * 3600 },
    now: () => NOW,
  };
  return { store, deps };
}

function agentDag(over: Partial<ExternalPlanSubmission> = {}): ExternalPlanSubmission {
  return {
    requestId: "req-42",
    reservationId: "resv-1",
    nodes: [
      { nodeId: "mail", capabilityId: "cap-mail", price: "3.25", currency: "USDC", tierKey: "tier0", kernelId: "k-mail", operator: OP_MAIL },
      { nodeId: "print", capabilityId: "cap-print", price: "6.50", currency: "USDC", tierKey: "tier2", kernelId: "k-print", operator: OP_PRINT, committedProgramHash: PROGRAM },
    ],
    edges: [{ from: "print", to: "mail" }],
    ...over,
  };
}

const CTX = { principal: "agent:buyer-1" };

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

/** Layer C, state "proposed": no preview anywhere, no live, no money — the bare-minimum money-less case. */
function proposedPresentation(): PlanPresentation {
  return presentPlan({ submission: agentDag(), asOf: ASOF });
}

/** Layer C, state "compiled": has preview (money context) and per-node money/live. */
function compiledPresentation() {
  const { deps } = world();
  const outcome = acceptExternalPlan(agentDag(), CTX, deps);
  if (!outcome.ok) throw new Error("setup: expected acceptance");
  return presentPlan({ submission: agentDag(), outcome, asOf: ASOF });
}

/** Layer B, state "sealed": the accepted deal, immutable. */
function sealedPresentation() {
  const { store, deps } = world();
  const outcome = acceptExternalPlan(agentDag(), CTX, deps);
  if (!outcome.ok) throw new Error("setup: expected acceptance");
  const consumed = store.consume("resv-1", CTX.principal, outcome.plan, NOW);
  if (!consumed.ok) throw new Error("setup: expected consume");
  return presentPlan({ submission: agentDag(), outcome, sealed: { reservationId: "resv-1", acceptedDealDigest: store.sealed("resv-1")! }, asOf: ASOF });
}

/** Layer C, state "needs-requote": nodes carry `live` (from R10's re-quote) but no plan was compiled, so no `money` anywhere and no `preview`. */
function needsRequotePresentation() {
  const dag = agentDag();
  dag.nodes[1] = { ...dag.nodes[1]!, price: "5.00" }; // print's claimed price is stale
  const outcome = acceptExternalPlan(dag, CTX, world().deps);
  return presentPlan({ submission: dag, outcome, asOf: ASOF });
}

const minimalProposed = (nodeId: string, capabilityId = "cap-x"): PlanNodePresentation => ({
  nodeId,
  capabilityId,
  state: "proposed",
  proposed: { price: "1.00", currency: "USDC", tierKey: "tier0", kernelId: "k-x", operator: OP_PRINT },
});

/** Hand-typed: `state: "invalid"` but WITH nodes, so we can prove layout still works while semantics don't.
 *  presentPlan itself never produces an invalid presentation with nodes (its `invalid()` always empties
 *  them) — this exercises the type's edge, exactly as the task permits. */
function invalidWithNodesPresentation(): PlanPresentation {
  return {
    schema: "pcc.plan-presentation.v1",
    layer: "C",
    state: "invalid",
    invalid: { reason: "malformed-input" },
    requestId: null,
    reservationId: null,
    asOf: ASOF,
    nodes: [minimalProposed("n1")],
    edges: [],
  };
}

/** Hand-typed: no `preview`, but node "a" carries `live.currency` and node "b" (a different node) carries
 *  `money.gross.decimals` — a combination `presentPlan` itself never produces (money always comes with a
 *  preview), used to exercise rule 4's "otherwise" fallback across two different nodes. */
function fallbackMoneyPresentation(): PlanPresentation {
  return {
    schema: "pcc.plan-presentation.v1",
    layer: "C",
    state: "proposed",
    requestId: "req-x",
    reservationId: "resv-x",
    asOf: ASOF,
    nodes: [
      {
        ...minimalProposed("a", "cap-a"),
        state: "current",
        live: { capabilityType: "t", kernelId: "k", kernelStatus: "online", csd: "t", operator: OP_PRINT, priceDecimal: "1.00", currency: "USDC", assuranceTiers: [0], matchedCapabilityDigest: "0xaa" },
      },
      {
        ...minimalProposed("b", "cap-b"),
        state: "compiled",
        money: {
          gross: { baseUnits: "100", currency: "BOGUS-IGNORED", decimals: 6 },
          fee: { baseUnits: "1", currency: "BOGUS-IGNORED", decimals: 6 },
          net: { baseUnits: "99", currency: "BOGUS-IGNORED", decimals: 6 },
          payouts: [],
        },
      },
    ],
    edges: [],
  };
}

const ALLOWED_KINDS = new Set<PlanConstraint["kind"]>(["exclude-capability", "exclude-operator", "max-node-price", "max-total", "min-tier", "remove-node", "note"]);

function deepFreeze<T>(x: T): T {
  if (x !== null && (typeof x === "object" || typeof x === "function") && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x as Record<string, unknown>)) deepFreeze(v);
  }
  return x;
}

// ── Purity and totality ──────────────────────────────────────────────────────────────────────────

describe("purity and totality", () => {
  it("never throws for a battery of garbage top-level `edits`", () => {
    const p = proposedPresentation();
    const garbage: unknown[] = [null, undefined, "not-an-array", 42, true, {}, { length: 3 }, new Proxy({}, {}), Symbol("x")];
    for (const g of garbage) {
      expect(() => planEditsToIntent(p, g)).not.toThrow();
      const r = planEditsToIntent(p, g);
      expect(r.constraints).toEqual([]);
      expect(r.layout).toEqual([]);
    }
  });

  it("never mutates `presentation`, even when frozen", () => {
    const live = compiledPresentation();
    const clone = structuredClone(live);
    const frozen = deepFreeze(compiledPresentation());
    const edits = [{ op: "exclude-capability", nodeId: "print", capabilityId: "cap-evil" }, { op: "move-node", nodeId: "mail", x: 1, y: 2 }];
    expect(() => planEditsToIntent(frozen, edits)).not.toThrow();
    planEditsToIntent(live, edits);
    expect(live).toEqual(clone);
    expect(frozen).toEqual(clone);
  });

  it("never mutates `edits`, even when frozen", () => {
    const p = compiledPresentation();
    const edits = [{ op: "note", text: "please hurry" }, { op: "max-total", maxBaseUnits: "500" }];
    const clone = structuredClone(edits);
    const frozen = deepFreeze(structuredClone(edits));
    planEditsToIntent(p, edits);
    expect(edits).toEqual(clone);
    expect(() => planEditsToIntent(p, frozen)).not.toThrow();
    expect(frozen).toEqual(clone);
  });

  it("never produces a plan, submission, price, payer, or an operator/tier ASSIGNMENT — only exclusions and bounds", () => {
    const p = compiledPresentation();
    const edits = [
      { op: "exclude-capability", nodeId: "print", capabilityId: "cap-x" },
      { op: "exclude-operator", operator: OP_MAIL },
      { op: "max-node-price", nodeId: "print", maxBaseUnits: "500" },
      { op: "max-total", maxBaseUnits: "900" },
      { op: "min-tier", nodeId: "mail", tier: 1 },
      { op: "remove-node", nodeId: "mail" },
      { op: "note", nodeId: "print", text: "hi" },
      // deliberately assignment-shaped ops that must never exist as ops
      { op: "assign-operator", nodeId: "print", operator: OP_PRINT },
      { op: "set-tier", nodeId: "print", tier: 2 },
      { op: "set-price", nodeId: "print", price: "1" },
    ];
    const out = planEditsToIntent(p, edits);
    for (const c of out.constraints) expect(ALLOWED_KINDS.has(c.kind)).toBe(true);
    const refusedOps = out.refused.map((r) => r.op);
    expect(refusedOps).toContain("assign-operator");
    expect(refusedOps).toContain("set-tier");
    expect(refusedOps).toContain("set-price");
    for (const r of out.refused) if (["assign-operator", "set-tier", "set-price"].includes(r.op ?? "")) expect(r.reason).toBe("unknown-op");
  });
});

// ── Read-once discipline ─────────────────────────────────────────────────────────────────────────

describe("read-once discipline", () => {
  it("`edits` not an array: one 'unreadable' refusal, everything else empty", () => {
    const p = proposedPresentation();
    for (const bad of [null, undefined, "x", 5, {}]) {
      const out = planEditsToIntent(p, bad);
      expect(out.constraints).toEqual([]);
      expect(out.layout).toEqual([]);
      expect(out.refused).toEqual([{ index: 0, op: null, reason: "unreadable" }]);
    }
  });

  it("a throwing getter on ONE edit refuses only that edit", () => {
    const p = compiledPresentation();
    const poisoned = Object.defineProperty({}, "op", {
      enumerable: true,
      get: () => {
        throw new Error("boom");
      },
    });
    const edits = [{ op: "remove-node", nodeId: "mail" }, poisoned, { op: "remove-node", nodeId: "print" }];
    const out = planEditsToIntent(p, edits);
    expect(out.refused).toEqual([{ index: 1, op: null, reason: "unreadable" }]);
    expect(out.constraints).toEqual([
      { kind: "remove-node", nodeId: "mail" },
      { kind: "remove-node", nodeId: "print" },
    ]);
  });

  it("a getter that throws on a LATER field still reports the op it read successfully", () => {
    const p = compiledPresentation();
    const poisoned = { op: "max-node-price", nodeId: "print" };
    Object.defineProperty(poisoned, "maxBaseUnits", {
      enumerable: true,
      get: () => {
        throw new Error("boom");
      },
    });
    const out = planEditsToIntent(p, [poisoned]);
    expect(out.refused).toEqual([{ index: 0, op: "max-node-price", reason: "unreadable" }]);
  });

  it("a proxied edits array whose length throws or lies, or a revoked proxy, is one 'unreadable' refusal, never a throw", () => {
    const p = compiledPresentation();
    const throwing = new Proxy([], { get: (t, k) => (k === "length" ? (() => { throw new Error("boom"); })() : Reflect.get(t, k)) });
    const lying = new Proxy([], { get: (t, k) => (k === "length" ? -1 : Reflect.get(t, k)) });
    const fractional = new Proxy([], { get: (t, k) => (k === "length" ? 1.5 : Reflect.get(t, k)) });
    const { proxy: revoked, revoke } = Proxy.revocable([], {});
    revoke();
    for (const edits of [throwing, lying, fractional, revoked]) {
      let out: ReturnType<typeof planEditsToIntent> | undefined;
      expect(() => (out = planEditsToIntent(p, edits))).not.toThrow();
      expect(out!.refused).toEqual([{ index: 0, op: null, reason: "unreadable" }]);
      expect(out!.constraints).toEqual([]);
    }
  });

  it("a throwing getter on the array index itself refuses that edit as unreadable", () => {
    const p = compiledPresentation();
    const edits: unknown[] = [{ op: "remove-node", nodeId: "mail" }, null, { op: "remove-node", nodeId: "print" }];
    Object.defineProperty(edits, 1, {
      enumerable: true,
      get: () => {
        throw new Error("boom");
      },
    });
    const out = planEditsToIntent(p, edits);
    expect(out.refused).toEqual([{ index: 1, op: null, reason: "unreadable" }]);
  });

  it("exactly 256 edits is processed normally; 257 refuses the batch as a whole, with ONE entry", () => {
    const p = compiledPresentation();
    const ok256 = Array.from({ length: 256 }, () => ({ op: "note", text: "x" }));
    const out256 = planEditsToIntent(p, ok256);
    expect(out256.refused).toEqual([]);
    expect(out256.constraints).toHaveLength(1); // 256 identical notes dedup to one

    const bad257 = Array.from({ length: 257 }, () => ({ op: "note", text: "x" }));
    const out257 = planEditsToIntent(p, bad257);
    expect(out257.constraints).toEqual([]);
    expect(out257.layout).toEqual([]);
    expect(out257.refused).toEqual([{ index: 256, op: null, reason: "too-many-edits" }]);
    // The work never grows with a caller-chosen length: a sparse array claiming ~2^32 entries is one refusal.
    const sparse: unknown[] = [];
    sparse.length = 2 ** 32 - 1;
    const started = Date.now();
    expect(planEditsToIntent(p, sparse).refused).toEqual([{ index: 256, op: null, reason: "too-many-edits" }]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

// ── Op / node / value validation ─────────────────────────────────────────────────────────────────

describe("unknown op, unknown node, and every malformed value", () => {
  const p = compiledPresentation();

  it("an unrecognized op string is 'unknown-op', carrying the raw op", () => {
    const out = planEditsToIntent(p, [{ op: "teleport-node", nodeId: "print" }]);
    expect(out.refused).toEqual([{ index: 0, op: "teleport-node", reason: "unknown-op" }]);
  });

  it("a non-string op is 'unknown-op' with op: null", () => {
    for (const bad of [{ op: 5 }, { op: null }, { op: {} }, {}]) {
      const out = planEditsToIntent(p, [bad]);
      expect(out.refused).toEqual([{ index: 0, op: null, reason: "unknown-op" }]);
    }
  });

  it("unknown nodeId is 'unknown-node' for every node-scoped op", () => {
    const cases = [
      { op: "exclude-capability", nodeId: "ghost", capabilityId: "cap-x" },
      { op: "max-node-price", nodeId: "ghost", maxBaseUnits: "500" },
      { op: "min-tier", nodeId: "ghost", tier: 1 },
      { op: "remove-node", nodeId: "ghost" },
      { op: "move-node", nodeId: "ghost", x: 1, y: 1 },
      { op: "collapse", nodeId: "ghost", collapsed: true },
      { op: "note", nodeId: "ghost", text: "hi" },
    ];
    for (const c of cases) {
      const out = planEditsToIntent(p, [c]);
      expect(out.refused).toEqual([{ index: 0, op: c.op, reason: "unknown-node" }]);
    }
  });

  it("a note with no nodeId (undefined or null) is a global note, never 'unknown-node'", () => {
    const out = planEditsToIntent(p, [{ op: "note", text: "global one" }, { op: "note", nodeId: null, text: "global two" }]);
    expect(out.refused).toEqual([]);
    expect(out.constraints).toEqual([
      { kind: "note", nodeId: null, text: "global one", authority: "none" },
      { kind: "note", nodeId: null, text: "global two", authority: "none" },
    ]);
  });

  it("capabilityId: empty, too long, or non-printable-ASCII is malformed-value", () => {
    const bad = ["", "x".repeat(129), "has space", "has\ttab", "\x7f-del", 5, null];
    for (const capabilityId of bad) {
      const out = planEditsToIntent(p, [{ op: "exclude-capability", nodeId: "print", capabilityId }]);
      expect(out.refused).toEqual([{ index: 0, op: "exclude-capability", reason: "malformed-value" }]);
    }
    const ok = planEditsToIntent(p, [{ op: "exclude-capability", nodeId: "print", capabilityId: "x".repeat(128) }]);
    expect(ok.refused).toEqual([]);
  });

  it("operator: wrong length, missing 0x, non-hex, or wrong type is malformed-value; a valid one is lowercased", () => {
    const bad = [OP_PRINT.slice(0, -1), OP_PRINT.slice(2), `0x${"zz".repeat(20)}`, "0x" + "AA".repeat(19), 5, null];
    for (const operator of bad) {
      const out = planEditsToIntent(p, [{ op: "exclude-operator", operator }]);
      expect(out.refused).toEqual([{ index: 0, op: "exclude-operator", reason: "malformed-value" }]);
    }
    const mixedCase = `0x${"AaBb".repeat(10)}`;
    const ok = planEditsToIntent(p, [{ op: "exclude-operator", operator: mixedCase }]);
    expect(ok.constraints).toEqual([{ kind: "exclude-operator", operator: mixedCase.toLowerCase() }]);
  });

  it("maxBaseUnits: a JSON number, leading zero, non-digit, empty, or negative is malformed-value — never a number type", () => {
    const bad: unknown[] = ["0", "01", "-5", "5.0", "", "1e3", 500, 500n, null, "9".repeat(79)]; // 79 digits > 78 cap
    for (const maxBaseUnits of bad) {
      const out = planEditsToIntent(p, [{ op: "max-total", maxBaseUnits }]);
      expect(out.refused).toEqual([{ index: 0, op: "max-total", reason: "malformed-value" }]);
    }
    const ok = planEditsToIntent(p, [{ op: "max-total", maxBaseUnits: "1".repeat(78) }]); // exactly 78 digits: allowed
    expect(ok.refused).toEqual([]);
  });

  it("tier: non-integer, out of 0..3, or wrong type is malformed-value", () => {
    const bad = [-1, 4, 1.5, "2", null, Number.NaN];
    for (const tier of bad) {
      const out = planEditsToIntent(p, [{ op: "min-tier", nodeId: "mail", tier }]);
      expect(out.refused).toEqual([{ index: 0, op: "min-tier", reason: "malformed-value" }]);
    }
    for (const tier of [0, 1, 2, 3]) {
      const out = planEditsToIntent(p, [{ op: "min-tier", nodeId: "mail", tier }]);
      expect(out.refused).toEqual([]);
    }
  });

  it("move-node: non-finite x/y (NaN, Infinity, string) is malformed-value", () => {
    const bad = [
      { x: Number.NaN, y: 1 },
      { x: 1, y: Number.POSITIVE_INFINITY },
      { x: "1", y: 1 },
      { x: 1, y: undefined },
    ];
    for (const { x, y } of bad) {
      const out = planEditsToIntent(p, [{ op: "move-node", nodeId: "mail", x, y }]);
      expect(out.refused).toEqual([{ index: 0, op: "move-node", reason: "malformed-value" }]);
    }
  });

  it("collapse: a non-boolean collapsed is malformed-value", () => {
    for (const collapsed of ["true", 1, null, undefined]) {
      const out = planEditsToIntent(p, [{ op: "collapse", nodeId: "mail", collapsed }]);
      expect(out.refused).toEqual([{ index: 0, op: "collapse", reason: "malformed-value" }]);
    }
  });

  it("note text: empty, 501 units, a control char below 0x20 (except \\n), or non-string is malformed-value", () => {
    const bad = ["", "x".repeat(501), "bad\x01char", "bad\ttab", 5, null];
    for (const text of bad) {
      const out = planEditsToIntent(p, [{ op: "note", text }]);
      expect(out.refused).toEqual([{ index: 0, op: "note", reason: "malformed-value" }]);
    }
    const ok = planEditsToIntent(p, [{ op: "note", text: "line one\nline two" }, { op: "note", text: "x".repeat(500) }]);
    expect(ok.refused).toEqual([]);
  });
});

// ── Money context (rule 4) ───────────────────────────────────────────────────────────────────────

describe("money context: the currency from the presentation, the decimals from the server's settlement table", () => {
  it("compiled presentation (has preview): max-node-price and max-total succeed with the preview's currency/decimals", () => {
    const p = compiledPresentation();
    const out = planEditsToIntent(p, [
      { op: "max-node-price", nodeId: "print", maxBaseUnits: "500" },
      { op: "max-total", maxBaseUnits: "900" },
    ]);
    expect(out.refused).toEqual([]);
    expect(out.constraints).toEqual([
      { kind: "max-node-price", nodeId: "print", max: { baseUnits: "500", currency: "USDC", decimals: 6 } },
      { kind: "max-total", max: { baseUnits: "900", currency: "USDC", decimals: 6 } },
    ]);
  });

  it("proposed presentation (no preview, no live, no money): money ops refuse no-money-context; other ops still work", () => {
    const p = proposedPresentation();
    const out = planEditsToIntent(p, [
      { op: "max-node-price", nodeId: "print", maxBaseUnits: "500" },
      { op: "max-total", maxBaseUnits: "900" },
      { op: "exclude-capability", nodeId: "print", capabilityId: "cap-x" },
      { op: "min-tier", nodeId: "print", tier: 1 },
      { op: "remove-node", nodeId: "mail" },
    ]);
    expect(out.refused).toEqual([
      { index: 0, op: "max-node-price", reason: "no-money-context" },
      { index: 1, op: "max-total", reason: "no-money-context" },
    ]);
    expect(out.constraints.map((c) => c.kind).sort()).toEqual(["exclude-capability", "min-tier", "remove-node"]);
  });

  it("before compilation (needs-requote: live terms, no money yet) price edits WORK: the live currency, the table's decimals", () => {
    const p = needsRequotePresentation();
    expect(p.state).toBe("needs-requote");
    expect(p.preview).toBeUndefined();
    const out = planEditsToIntent(p, [{ op: "max-total", maxBaseUnits: "100" }]);
    expect(out.refused).toEqual([]);
    expect(out.constraints).toEqual([{ kind: "max-total", max: { baseUnits: "100", currency: "USDC", decimals: 6 } }]);
  });

  it("no trustworthy context: two different live currencies, an unsettleable currency, or a preview whose decimals disagree with the table", () => {
    const base = needsRequotePresentation();
    const withLive = (currencies: string[]) =>
      ({ ...base, nodes: base.nodes.map((n, i) => (n.live ? { ...n, live: { ...n.live, currency: currencies[i % currencies.length]! } } : n)) }) as PlanPresentation;
    const livesCount = base.nodes.filter((n) => n.live).length;
    expect(livesCount).toBeGreaterThanOrEqual(2); // the fixture has two live nodes, so the mixed case is real
    for (const p of [withLive(["USDC", "USDT"]), withLive(["EUR"])]) {
      expect(planEditsToIntent(p, [{ op: "max-total", maxBaseUnits: "100" }]).refused).toEqual([{ index: 0, op: "max-total", reason: "no-money-context" }]);
    }
    const compiled = compiledPresentation();
    const skewed = { ...compiled, preview: { ...compiled.preview!, gross: { ...compiled.preview!.gross, decimals: 18 } } } as PlanPresentation;
    expect(planEditsToIntent(skewed, [{ op: "max-total", maxBaseUnits: "100" }]).refused).toEqual([{ index: 0, op: "max-total", reason: "no-money-context" }]);
  });

  it("no preview: the currency from the node's live terms, the decimals from the server's table (a node's own money decimals are not the source)", () => {
    const p = fallbackMoneyPresentation();
    expect(p.preview).toBeUndefined();
    const out = planEditsToIntent(p, [{ op: "max-node-price", nodeId: "a", maxBaseUnits: "42" }]);
    expect(out.refused).toEqual([]);
    expect(out.constraints).toEqual([{ kind: "max-node-price", nodeId: "a", max: { baseUnits: "42", currency: "USDC", decimals: 6 } }]);
  });

  it("currency/decimals smuggled inside an edit are ignored entirely", () => {
    const p = compiledPresentation();
    const out = planEditsToIntent(p, [{ op: "max-node-price", nodeId: "print", maxBaseUnits: "500", currency: "EUR", decimals: 2 }]);
    expect(out.constraints).toEqual([{ kind: "max-node-price", nodeId: "print", max: { baseUnits: "500", currency: "USDC", decimals: 6 } }]);
  });
});

// ── Sealed and invalid presentations (rule 5, 6) ─────────────────────────────────────────────────

describe("sealed and invalid presentations: every semantic edit refused, layout still accepted", () => {
  it("layer B alone is enough to freeze a plan, even if a presentation's state disagrees (defense in depth)", () => {
    const p = { ...compiledPresentation(), layer: "B" } as PlanPresentation;
    expect(p.state).toBe("compiled");
    const out = planEditsToIntent(p, [{ op: "remove-node", nodeId: "mail" }, { op: "move-node", nodeId: "mail", x: 1, y: 2 }]);
    expect(out.refused).toEqual([{ index: 0, op: "remove-node", reason: "plan-sealed" }]);
    expect(out.layout).toEqual([{ kind: "position", nodeId: "mail", x: 1, y: 2 }]);
  });

  it("sealed (layer B): semantic edits are plan-sealed; layout edits on real nodes still work", () => {
    const p = sealedPresentation();
    expect(p.layer).toBe("B");
    expect(p.state).toBe("sealed");
    const out = planEditsToIntent(p, [
      { op: "exclude-capability", nodeId: "print", capabilityId: "cap-x" },
      { op: "max-node-price", nodeId: "print", maxBaseUnits: "500" },
      { op: "remove-node", nodeId: "mail" },
      { op: "note", text: "too late" },
      { op: "move-node", nodeId: "print", x: 10, y: 20 },
      { op: "collapse", nodeId: "mail", collapsed: true },
    ]);
    expect(out.refused).toEqual([
      { index: 0, op: "exclude-capability", reason: "plan-sealed" },
      { index: 1, op: "max-node-price", reason: "plan-sealed" },
      { index: 2, op: "remove-node", reason: "plan-sealed" },
      { index: 3, op: "note", reason: "plan-sealed" },
    ]);
    expect(out.constraints).toEqual([]);
    expect(out.layout).toEqual([
      { kind: "collapsed", nodeId: "mail", collapsed: true },
      { kind: "position", nodeId: "print", x: 10, y: 20 },
    ]);
  });

  it("a genuinely invalid presentation (state invalid, layer C, produced by presentPlan) has no nodes: semantic ops are presentation-invalid, layout ops are unknown-node", () => {
    const junk = { requestId: 5, reservationId: null, nodes: "not-an-array", edges: [] };
    const p = presentPlan({ submission: junk as unknown as ExternalPlanSubmission, asOf: ASOF });
    expect(p.state).toBe("invalid");
    expect(p.nodes).toEqual([]);
    const out = planEditsToIntent(p, [
      { op: "remove-node", nodeId: "anything" },
      { op: "move-node", nodeId: "anything", x: 1, y: 1 },
    ]);
    expect(out.refused).toEqual([
      { index: 0, op: "remove-node", reason: "presentation-invalid" },
      { index: 1, op: "move-node", reason: "unknown-node" },
    ]);
  });

  it("hand-typed invalid presentation WITH a node: semantic edits are presentation-invalid; layout on that node still works", () => {
    const p = invalidWithNodesPresentation();
    const out = planEditsToIntent(p, [
      { op: "exclude-capability", nodeId: "n1", capabilityId: "cap-x" },
      { op: "collapse", nodeId: "n1", collapsed: true },
    ]);
    expect(out.refused).toEqual([{ index: 0, op: "exclude-capability", reason: "presentation-invalid" }]);
    expect(out.layout).toEqual([{ kind: "collapsed", nodeId: "n1", collapsed: true }]);
  });
});

// ── Normalization: dedup, stricter-wins, order independence (rule 7) ────────────────────────────

describe("normalization", () => {
  it("stricter wins: min of several max-node-price, min of several max-total, max of several min-tier", () => {
    const p = compiledPresentation();
    const edits = [
      { op: "max-node-price", nodeId: "print", maxBaseUnits: "900" },
      { op: "max-node-price", nodeId: "print", maxBaseUnits: "500" },
      { op: "max-node-price", nodeId: "print", maxBaseUnits: "700" },
      { op: "max-total", maxBaseUnits: "5000" },
      { op: "max-total", maxBaseUnits: "1000" },
      { op: "min-tier", nodeId: "mail", tier: 0 },
      { op: "min-tier", nodeId: "mail", tier: 2 },
      { op: "min-tier", nodeId: "mail", tier: 1 },
    ];
    const out = planEditsToIntent(p, edits);
    expect(out.constraints).toEqual([
      { kind: "max-node-price", nodeId: "print", max: { baseUnits: "500", currency: "USDC", decimals: 6 } },
      { kind: "max-total", max: { baseUnits: "1000", currency: "USDC", decimals: 6 } },
      { kind: "min-tier", nodeId: "mail", tier: 2 },
    ]);
  });

  it("identical constraints are deduped: exclude-capability, exclude-operator, remove-node, and identical notes", () => {
    const p = compiledPresentation();
    const out = planEditsToIntent(p, [
      { op: "exclude-capability", nodeId: "print", capabilityId: "cap-x" },
      { op: "exclude-capability", nodeId: "print", capabilityId: "cap-x" },
      { op: "exclude-capability", nodeId: "print", capabilityId: "cap-y" }, // distinct: kept separately
      { op: "exclude-operator", operator: OP_MAIL },
      { op: "exclude-operator", operator: `0x${"BB".repeat(20)}` }, // same operator, different case (0x kept lowercase): still a dup after lowercasing
      { op: "remove-node", nodeId: "mail" },
      { op: "remove-node", nodeId: "mail" },
      { op: "note", nodeId: "print", text: "same" },
      { op: "note", nodeId: "print", text: "same" },
    ]);
    expect(out.constraints).toEqual([
      { kind: "exclude-capability", nodeId: "print", capabilityId: "cap-x" },
      { kind: "exclude-capability", nodeId: "print", capabilityId: "cap-y" },
      { kind: "exclude-operator", operator: OP_MAIL.toLowerCase() },
      { kind: "remove-node", nodeId: "mail" },
      { kind: "note", nodeId: "print", text: "same", authority: "none" },
    ]);
  });

  it("notes are kept in original relative order, after every other kind, regardless of where they appear among the edits", () => {
    const p = compiledPresentation();
    const out = planEditsToIntent(p, [
      { op: "note", text: "first note" },
      { op: "remove-node", nodeId: "mail" },
      { op: "note", text: "second note" },
      { op: "exclude-operator", operator: OP_PRINT },
      { op: "note", nodeId: "print", text: "third note" },
    ]);
    expect(out.constraints.map((c) => c.kind)).toEqual(["exclude-operator", "remove-node", "note", "note", "note"]);
    const noteTexts = out.constraints.filter((c) => c.kind === "note").map((c) => (c as Extract<PlanConstraint, { kind: "note" }>).text);
    expect(noteTexts).toEqual(["first note", "second note", "third note"]);
  });

  it("constraints are sorted by kind (the PlanConstraint union order), then nodeId, then value — independent of edit order", () => {
    const p = compiledPresentation();
    const edits = [
      { op: "exclude-capability", nodeId: "print", capabilityId: "cap-b" },
      { op: "exclude-capability", nodeId: "mail", capabilityId: "cap-a" },
      { op: "exclude-capability", nodeId: "print", capabilityId: "cap-a" },
    ];
    const out = planEditsToIntent(p, edits);
    expect(out.constraints).toEqual([
      { kind: "exclude-capability", nodeId: "mail", capabilityId: "cap-a" },
      { kind: "exclude-capability", nodeId: "print", capabilityId: "cap-a" },
      { kind: "exclude-capability", nodeId: "print", capabilityId: "cap-b" },
    ]);
  });

  it("shuffling a fully-valid, non-conflicting edit list produces byte-identical constraints and layout", () => {
    const p = compiledPresentation();
    const edits = [
      { op: "exclude-capability", nodeId: "print", capabilityId: "cap-a" },
      { op: "exclude-capability", nodeId: "mail", capabilityId: "cap-b" },
      { op: "exclude-operator", operator: OP_MAIL },
      { op: "max-node-price", nodeId: "print", maxBaseUnits: "900" },
      { op: "max-node-price", nodeId: "print", maxBaseUnits: "500" }, // min should win regardless of order
      { op: "max-total", maxBaseUnits: "1000" },
      { op: "min-tier", nodeId: "mail", tier: 0 },
      { op: "min-tier", nodeId: "mail", tier: 2 }, // max should win regardless of order
      { op: "remove-node", nodeId: "mail" },
      { op: "note", text: "a plan-wide note" },
    ];
    const forward = planEditsToIntent(p, edits);
    const reversed = planEditsToIntent(p, [...edits].reverse());
    const shuffled = planEditsToIntent(p, [edits[4]!, edits[0]!, edits[7]!, edits[2]!, edits[9]!, edits[1]!, edits[5]!, edits[8]!, edits[3]!, edits[6]!]);
    expect(forward.refused).toEqual([]);
    expect(reversed.constraints).toEqual(forward.constraints);
    expect(shuffled.constraints).toEqual(forward.constraints);
    expect(reversed.layout).toEqual(forward.layout);
    expect(shuffled.layout).toEqual(forward.layout);
  });
});

// ── Layout (rule 6) ──────────────────────────────────────────────────────────────────────────────

describe("layout: never a constraint", () => {
  it("move-node yields zero constraints, only a layout entry", () => {
    const p = compiledPresentation();
    const out = planEditsToIntent(p, [{ op: "move-node", nodeId: "print", x: 12.5, y: -3 }]);
    expect(out.constraints).toEqual([]);
    expect(out.layout).toEqual([{ kind: "position", nodeId: "print", x: 12.5, y: -3 }]);
  });

  it("collapse yields zero constraints, only a layout entry", () => {
    const p = compiledPresentation();
    const out = planEditsToIntent(p, [{ op: "collapse", nodeId: "mail", collapsed: true }]);
    expect(out.constraints).toEqual([]);
    expect(out.layout).toEqual([{ kind: "collapsed", nodeId: "mail", collapsed: true }]);
  });

  it("multiple move-node for the same node: the LAST position (by array order) wins", () => {
    const p = compiledPresentation();
    const out = planEditsToIntent(p, [
      { op: "move-node", nodeId: "print", x: 1, y: 1 },
      { op: "move-node", nodeId: "print", x: 2, y: 2 },
      { op: "move-node", nodeId: "print", x: 3, y: 3 },
    ]);
    expect(out.layout).toEqual([{ kind: "position", nodeId: "print", x: 3, y: 3 }]);
  });

  it("multiple collapse for the same node: the LAST value wins", () => {
    const p = compiledPresentation();
    const out = planEditsToIntent(p, [
      { op: "collapse", nodeId: "mail", collapsed: true },
      { op: "collapse", nodeId: "mail", collapsed: false },
    ]);
    expect(out.layout).toEqual([{ kind: "collapsed", nodeId: "mail", collapsed: false }]);
  });

  it("layout entries are sorted by nodeId (position before collapsed for the same node)", () => {
    const p = compiledPresentation();
    const out = planEditsToIntent(p, [
      { op: "collapse", nodeId: "print", collapsed: true },
      { op: "move-node", nodeId: "mail", x: 0, y: 0 },
      { op: "move-node", nodeId: "print", x: 5, y: 5 },
    ]);
    expect(out.layout).toEqual([
      { kind: "position", nodeId: "mail", x: 0, y: 0 },
      { kind: "position", nodeId: "print", x: 5, y: 5 },
      { kind: "collapsed", nodeId: "print", collapsed: true },
    ]);
  });
});

// ── Basis (rule 8) ───────────────────────────────────────────────────────────────────────────────

describe("basis: copied from the presentation, never from the edits", () => {
  it("compiled presentation: requestId, reservationId, planId, asOf, layer, state all copied", () => {
    const p = compiledPresentation();
    const out = planEditsToIntent(p, []);
    expect(out.basis).toEqual({ requestId: p.requestId, reservationId: p.reservationId, planId: p.planId, asOf: p.asOf, layer: p.layer, state: p.state });
    expect(out.basis.planId).not.toBeNull();
  });

  it("proposed presentation: no planId on the presentation becomes null in the basis", () => {
    const p = proposedPresentation();
    expect(p.planId).toBeUndefined();
    const out = planEditsToIntent(p, []);
    expect(out.basis).toEqual({ requestId: p.requestId, reservationId: p.reservationId, planId: null, asOf: p.asOf, layer: "C", state: "proposed" });
  });

  it("basis fields are never influenced by the edits", () => {
    const p = proposedPresentation();
    const out = planEditsToIntent(p, [{ op: "note", text: "ignore me for basis" }, { requestId: "hijacked", layer: "B", state: "sealed" }]);
    expect(out.basis).toEqual({ requestId: p.requestId, reservationId: p.reservationId, planId: null, asOf: p.asOf, layer: "C", state: "proposed" });
  });
});

describe("schema", () => {
  it("always stamps the v1 schema", () => {
    const out = planEditsToIntent(proposedPresentation(), []);
    expect(out.schema).toBe("pcc.plan-edit-intent.v1");
  });

  it("empty edits produces empty everything", () => {
    const out = planEditsToIntent(compiledPresentation(), []);
    expect(out).toMatchObject({ constraints: [], layout: [], refused: [] });
  });
});

// ── astra review of #432 (round 1) ───────────────────────────────────────────────────────────────

describe("F1: every decision comes from one snapshot of the presentation, taken before any edit is touched", () => {
  /** An edits array whose `length` getter runs `during`: the caller's code, running while its edits are read. */
  const editsRunning = (list: unknown[], during: () => void) =>
    new Proxy(list, {
      get: (target, key, receiver) => {
        if (key === "length") during();
        return Reflect.get(target, key, receiver);
      },
    });
  const asNodes = (p: PlanPresentation, nodes: unknown) => {
    (p as unknown as { nodes: unknown }).nodes = nodes;
  };

  it("a length getter that flips layer and state cannot unseal the plan (the reviewer's reproduction)", () => {
    const p = sealedPresentation();
    const out = planEditsToIntent(
      p,
      editsRunning([{ op: "remove-node", nodeId: "mail" }], () => {
        p.layer = "C";
        p.state = "compiled";
      }),
    );
    expect(out.basis).toMatchObject({ layer: "B", state: "sealed" });
    expect(out.constraints).toEqual([]);
    expect(out.refused).toEqual([{ index: 0, op: "remove-node", reason: "plan-sealed" }]);
  });

  it("nor can it revive an invalid presentation that still lists nodes", () => {
    const p = invalidWithNodesPresentation();
    const out = planEditsToIntent(
      p,
      editsRunning([{ op: "note", text: "x" }, { op: "remove-node", nodeId: "n1" }], () => {
        p.state = "proposed";
      }),
    );
    expect(out.constraints).toEqual([]);
    expect(out.refused.map((r) => r.reason)).toEqual(["presentation-invalid", "presentation-invalid"]);
  });

  it("nor can it add a node the presentation did not list, or move the money context", () => {
    const p = compiledPresentation();
    const out = planEditsToIntent(
      p,
      editsRunning([{ op: "remove-node", nodeId: "ghost" }, { op: "max-total", maxBaseUnits: "500" }], () => {
        p.nodes = [...p.nodes, minimalProposed("ghost")];
        p.preview!.gross.currency = "EUR";
      }),
    );
    expect(out.refused).toEqual([{ index: 0, op: "remove-node", reason: "unknown-node" }]);
    expect(out.constraints).toEqual([{ kind: "max-total", max: { baseUnits: "500", currency: "USDC", decimals: 6 } }]);
  });

  it("totality: a length getter that nulls the node list neither throws nor changes the answer", () => {
    const list = [{ op: "remove-node", nodeId: "mail" }, { op: "move-node", nodeId: "mail", x: 1, y: 2 }, { op: "max-total", maxBaseUnits: "9" }];
    const control = planEditsToIntent(compiledPresentation(), list);
    const p = compiledPresentation();
    let out: ReturnType<typeof planEditsToIntent> | undefined;
    expect(() => {
      out = planEditsToIntent(p, editsRunning(list, () => asNodes(p, null)));
    }).not.toThrow();
    expect(out).toEqual(control);
  });

  it("totality: a node list that is not an array, or holds anything but nodes, makes the presentation invalid and never throws", () => {
    const list = [{ op: "remove-node", nodeId: "mail" }, { op: "move-node", nodeId: "mail", x: 1, y: 1 }, { op: "note", text: "x" }];
    // [node list, whether node "mail" is still a known node in it]
    const cases: Array<[unknown, boolean]> = [
      [null, false],
      [undefined, false],
      ["x", false],
      [5, false],
      [{}, false],
      [[null], false],
      [[7], false],
      [[{ nodeId: 5 }], false],
      [[{ ...minimalProposed("mail") }, null], true],
    ];
    for (const [nodes, mailKnown] of cases) {
      const p = compiledPresentation();
      asNodes(p, nodes);
      let out: ReturnType<typeof planEditsToIntent> | undefined;
      expect(() => {
        out = planEditsToIntent(p, list);
      }).not.toThrow();
      expect(out!.constraints, JSON.stringify(nodes)).toEqual([]);
      // Every semantic edit is refused; the layout edit stands only for a node that is really listed.
      expect(out!.refused.map((r) => r.reason), JSON.stringify(nodes)).toEqual(mailKnown ? ["presentation-invalid", "presentation-invalid"] : ["presentation-invalid", "unknown-node", "presentation-invalid"]);
      expect(out!.layout, JSON.stringify(nodes)).toEqual(mailKnown ? [{ kind: "position", nodeId: "mail", x: 1, y: 1 }] : []);
      // The basis is still the presentation's own: a bad node list does not make the rest unreadable.
      expect(out!.basis, JSON.stringify(nodes)).toEqual({ requestId: p.requestId, reservationId: p.reservationId, planId: p.planId, asOf: p.asOf, layer: p.layer, state: p.state });
    }
  });

  it("totality: a presentation that cannot be read at all is invalid, and never throws", () => {
    const unreadable = new Proxy({}, { get: () => { throw new Error("boom"); } }) as unknown as PlanPresentation;
    const throwingState = compiledPresentation();
    Object.defineProperty(throwingState, "state", { get: () => { throw new Error("boom"); } });
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const p of [unreadable, throwingState, revoked as unknown as PlanPresentation, null as unknown as PlanPresentation, undefined as unknown as PlanPresentation]) {
      let out: ReturnType<typeof planEditsToIntent> | undefined;
      expect(() => {
        out = planEditsToIntent(p, [{ op: "remove-node", nodeId: "mail" }, { op: "move-node", nodeId: "mail", x: 1, y: 1 }]);
      }).not.toThrow();
      expect(out!.constraints).toEqual([]);
      expect(out!.layout).toEqual([]);
      expect(out!.refused.map((r) => r.reason)).toEqual(["presentation-invalid", "unknown-node"]);
      expect(out!.basis).toEqual({ requestId: null, reservationId: null, planId: null, asOf: "", layer: "C", state: "invalid" });
    }
  });
});
