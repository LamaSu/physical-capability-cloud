/**
 * R10 — the live provider re-read for an externally authored plan.
 *
 * The caller's snapshot is a claim. These tests pin that the server re-reads the live row, that
 * any difference is reported (never absorbed), and that the server's terms — not the caller's —
 * are the ones handed on. The four "REQUIRED" cases are from the pcc-composition charter.
 */
import { describe, it, expect } from "vitest";
import {
  revalidatePlanSnapshots,
  canonicalDecimal,
  decimalToBaseUnits,
  csdSlugFromUrl,
  type LiveCapability,
  type LiveKernel,
  type NodeVerdict,
  type RevalidationDeps,
  type SnapshotClaim,
} from "../services/plan-snapshot-revalidation.js";
import { matchedCapabilityDigest } from "../services/matched-capability-digest.js";
import { capPrice, createMatcher } from "../services/agentic-decomposer.js";

const OP = `0x${"ab".repeat(20)}`;
const OP2 = `0x${"cd".repeat(20)}`;
const PRINT = "document-print-and-mail";

function cap(p: Partial<LiveCapability> & { id: string }): LiveCapability {
  return {
    type: PRINT,
    kernelId: "k-1",
    pricing: { currency: "USDC", baseCost: "6.50", minimum: "6.50" },
    assuranceTiers: [0, 1, 2],
    tenantId: null,
    ...p,
  };
}

const KERNELS: LiveKernel[] = [
  { id: "k-1", operatorAddress: OP, status: "online" },
  { id: "k-2", operatorAddress: OP2, status: "online" },
];

interface Calls {
  caps: string[][];
  kernels: string[][];
}

function deps(caps: LiveCapability[], kernels: LiveKernel[] = KERNELS, calls?: Calls): RevalidationDeps {
  return {
    loadCapabilities: (ids) => {
      calls?.caps.push(ids);
      return caps.filter((c) => ids.includes(c.id));
    },
    loadKernels: (ids) => {
      calls?.kernels.push(ids);
      return kernels.filter((k) => ids.includes(k.id));
    },
    csdForType: (t) => (t === PRINT || t === "mail.drop" ? PRINT : null),
  };
}

function claim(p: Partial<SnapshotClaim> & { nodeId: string }): SnapshotClaim {
  return { capabilityId: "cap-print", price: "6.50", currency: "USDC", tierKey: "tier0", kernelId: "k-1", operator: OP, ...p };
}

/** The deal-snapshot digest exactly as the decomposer computes it for a row at a given price. */
function digestAt(price: number, tiers: number[] = [0, 1, 2], kernelId = "k-1"): string {
  return matchedCapabilityDigest({ capabilityId: "cap-print", capabilityType: PRINT, kernelId, price, currency: "USDC", assuranceTiers: tiers });
}

function only(r: { verdicts: NodeVerdict[] }): NodeVerdict {
  expect(r.verdicts).toHaveLength(1);
  return r.verdicts[0]!;
}

describe("current: the claim matches the live row, and the SERVER's terms come back", () => {
  it("resolves exact base units, the operator, the CSD and the tier from the live rows", () => {
    const r = revalidatePlanSnapshots([claim({ nodeId: "print" })], deps([cap({ id: "cap-print" })]));
    expect(r.ok).toBe(true);
    const v = only(r);
    expect(v.status).toBe("current");
    if (v.status !== "current") return;
    expect(v.resolved).toMatchObject({
      nodeId: "print",
      capabilityId: "cap-print",
      kernelId: "k-1",
      csd: PRINT,
      operator: OP,
      payoutAddress: OP, // no payout-wallet store yet (#1690): the operator address, never the caller's
      priceDecimal: "6.5",
      grossBaseUnits: 6_500_000n,
      currency: "USDC",
      currencyDecimals: 6,
      tier: 0,
      tierKey: "tier0",
      assuranceTiers: [0, 1, 2],
    });
  });

  it("the recomputed digest is the decomposer's own digest for the same row (one definition)", async () => {
    const m = await createMatcher(() => [
      { id: "cap-print", type: PRINT, name: "Print & mail", kernelId: "k-1", pricing: { currency: "USDC", baseCost: "6.50", minimum: "6.50" }, assuranceTiers: [0, 1, 2] },
    ]).match("print and mail", PRINT);
    expect(m).not.toBeNull();
    const v = only(revalidatePlanSnapshots([claim({ nodeId: "print", matchedCapabilityDigest: m!.matchedCapabilityDigest })], deps([cap({ id: "cap-print" })])));
    expect(v.status).toBe("current");
    if (v.status === "current") expect(v.resolved.matchedCapabilityDigest).toBe(m!.matchedCapabilityDigest);
  });

  it("equal amounts in different spellings match; hex case in the digest and operator is not a difference", () => {
    const v = only(
      revalidatePlanSnapshots(
        [claim({ nodeId: "print", price: "6.5000", operator: OP.toUpperCase().replace("0X", "0x"), matchedCapabilityDigest: digestAt(6.5).toUpperCase().replace("0X", "0x") })],
        deps([cap({ id: "cap-print" })]),
      ),
    );
    expect(v.status).toBe("current");
  });
});

describe("stale: any difference is reported with the live re-quote, never absorbed", () => {
  it("REQUIRED: a forged cheaper snapshot (price AND a digest over the forgery) is rejected", () => {
    const forged = claim({ nodeId: "print", price: "5.00", matchedCapabilityDigest: digestAt(5) });
    const r = revalidatePlanSnapshots([forged], deps([cap({ id: "cap-print" })]));
    expect(r.ok).toBe(false);
    const v = only(r);
    expect(v.status).toBe("stale");
    if (v.status !== "stale") return;
    expect(v.diffs.map((d) => d.field)).toEqual(["matchedCapabilityDigest", "price"]);
    expect(v.diffs.find((d) => d.field === "price")).toEqual({ field: "price", claimed: "5", live: "6.5" });
    expect(v.live.grossBaseUnits).toBe(6_500_000n); // the server's price, not the forged one
  });

  it("REQUIRED: a provider price change between quote and accept is stale, and the re-quote is current", () => {
    const quoted = claim({ nodeId: "print", price: "6.50", matchedCapabilityDigest: digestAt(6.5) });
    const raised = [cap({ id: "cap-print", pricing: { currency: "USDC", baseCost: "7.25", minimum: "6.50" } })];
    const v = only(revalidatePlanSnapshots([quoted], deps(raised)));
    expect(v.status).toBe("stale");
    if (v.status !== "stale") return;
    expect(v.diffs.map((d) => d.field)).toEqual(["matchedCapabilityDigest", "price"]);
    // explicit re-quote: re-submit against the live terms
    const requote = claim({ nodeId: "print", price: v.live.priceDecimal, matchedCapabilityDigest: v.live.matchedCapabilityDigest });
    const again = only(revalidatePlanSnapshots([requote], deps(raised)));
    expect(again.status).toBe("current");
    if (again.status === "current") expect(again.resolved.grossBaseUnits).toBe(7_250_000n);
  });

  it("a sub-cent change the digest's toFixed(2) cannot see is still caught by the exact price", () => {
    const live = [cap({ id: "cap-print", pricing: { currency: "USDC", baseCost: "6.504", minimum: "6.50" } })];
    // the digest is blind to it...
    expect(digestAt(6.504)).toBe(digestAt(6.5));
    // ...the exact comparison is not:
    const v = only(revalidatePlanSnapshots([claim({ nodeId: "print", matchedCapabilityDigest: digestAt(6.5) })], deps(live)));
    expect(v.status).toBe("stale");
    if (v.status === "stale") expect(v.diffs).toEqual([{ field: "price", claimed: "6.5", live: "6.504" }]);
  });

  it("REQUIRED: a tier the provider no longer offers is stale", () => {
    const live = [cap({ id: "cap-print", assuranceTiers: [0, 1] })];
    const v = only(revalidatePlanSnapshots([claim({ nodeId: "print", tierKey: "tier2" })], deps(live)));
    expect(v.status).toBe("stale");
    if (v.status === "stale") expect(v.diffs).toEqual([{ field: "tier", claimed: "tier2", live: "tier0,tier1" }]);
  });

  it("a capability moved to another kernel reports the kernel and operator change; live carries the new operator", () => {
    const moved = [cap({ id: "cap-print", kernelId: "k-2" })];
    const v = only(revalidatePlanSnapshots([claim({ nodeId: "print", kernelId: "k-1", operator: OP })], deps(moved)));
    expect(v.status).toBe("stale");
    if (v.status !== "stale") return;
    expect(v.diffs.map((d) => d.field)).toEqual(["kernelId", "operator"]);
    expect(v.live.operator).toBe(OP2);
  });

  it("currency, capability type and CSD cross-checks are compared too", () => {
    const v = only(revalidatePlanSnapshots([claim({ nodeId: "print", currency: "USDT", capabilityType: "mail.drop", csd: "courier-route" })], deps([cap({ id: "cap-print" })])));
    expect(v.status).toBe("stale");
    if (v.status === "stale") expect(v.diffs.map((d) => d.field)).toEqual(["capabilityType", "csd", "currency"]);
  });
});

describe("missing / unavailable / incompatible", () => {
  it("an unknown capability, or one whose kernel is gone, is missing", () => {
    expect(only(revalidatePlanSnapshots([claim({ nodeId: "a", capabilityId: "ghost" })], deps([cap({ id: "cap-print" })])))).toEqual({ nodeId: "a", status: "missing", reason: "capability-not-found" });
    expect(only(revalidatePlanSnapshots([claim({ nodeId: "a" })], deps([cap({ id: "cap-print", kernelId: "k-gone" })])))).toEqual({ nodeId: "a", status: "missing", reason: "kernel-not-found" });
  });

  it("a tenant-scoped capability is visible only to its tenant, and otherwise looks exactly like a missing one", () => {
    const scoped = [cap({ id: "cap-print", tenantId: "t-1" })];
    expect(only(revalidatePlanSnapshots([claim({ nodeId: "a" })], deps(scoped), { tenantId: "t-1" })).status).toBe("current");
    expect(only(revalidatePlanSnapshots([claim({ nodeId: "a" })], deps(scoped), { tenantId: "t-2" }))).toEqual({ nodeId: "a", status: "missing", reason: "capability-not-found" });
    expect(only(revalidatePlanSnapshots([claim({ nodeId: "a" })], deps(scoped))).status).toBe("missing");
  });

  it("a suspended operator, an invalid or zero settlement address, and malformed tiers are unavailable", () => {
    const k = (operatorAddress: string, status = "online"): LiveKernel[] => [{ id: "k-1", operatorAddress, status }];
    const reason = (kernels: LiveKernel[], c = cap({ id: "cap-print" })) => {
      const v = only(revalidatePlanSnapshots([claim({ nodeId: "a" })], deps([c], kernels)));
      return v.status === "unavailable" ? v.reason : v.status;
    };
    expect(reason(k(OP, "suspended"))).toBe("operator-suspended");
    expect(reason(k("not-an-address"))).toBe("operator-address-invalid");
    expect(reason(k(`0x${"00".repeat(20)}`))).toBe("operator-address-invalid");
    expect(reason(KERNELS, cap({ id: "cap-print", assuranceTiers: [0, 7] }))).toBe("malformed-tiers");
  });

  it("astra's counterexample: missing, null or empty live tiers are NEVER defaulted into a sellable tier", () => {
    for (const assuranceTiers of [null, undefined, []] as Array<number[] | null | undefined>) {
      const row = cap({ id: "cap-print" });
      if (assuranceTiers === undefined) delete (row as Partial<LiveCapability>).assuranceTiers;
      else row.assuranceTiers = assuranceTiers;
      const v = only(revalidatePlanSnapshots([claim({ nodeId: "a", tierKey: "tier1" })], deps([row])));
      expect(v).toEqual({ nodeId: "a", status: "unavailable", reason: "malformed-tiers" });
    }
  });

  it("astra's confirmation: a sparse or implausibly long tier array is malformed; a shadowed `every` cannot throw", () => {
    const verdictFor = (assuranceTiers: number[], tierKey = "tier0") =>
      only(revalidatePlanSnapshots([claim({ nodeId: "a", tierKey })], deps([cap({ id: "cap-print", assuranceTiers })])));
    const sparse = new Array<number>(2);
    sparse[0] = 0; // [0, <hole>]: `every` skips the hole
    expect(verdictFor(sparse)).toEqual({ nodeId: "a", status: "unavailable", reason: "malformed-tiers" });
    expect(verdictFor(new Array<number>(1_000_000).fill(0))).toEqual({ nodeId: "a", status: "unavailable", reason: "malformed-tiers" });
    const shadowed = Object.assign([0], { every: null }) as unknown as number[];
    expect(() => verdictFor(shadowed)).not.toThrow();
    expect(verdictFor(shadowed).status).toBe("current"); // a real [0] list: its own methods are never called
  });

  it("REQUIRED (freshness): an operator rotation since the quote is stale even when the claimed digest still matches", () => {
    const rotated: LiveKernel[] = [{ id: "k-1", operatorAddress: `0x${"ef".repeat(20)}`, status: "online" }];
    const v = only(revalidatePlanSnapshots([claim({ nodeId: "a", matchedCapabilityDigest: digestAt(6.5) })], deps([cap({ id: "cap-print" })], rotated)));
    expect(v.status).toBe("stale");
    if (v.status === "stale") expect(v.diffs.map((d) => d.field)).toEqual(["operator"]); // the digest never saw it
  });

  it("a foreign-tenant capability triggers NO kernel lookup (no existence side channel)", () => {
    const calls: Calls = { caps: [], kernels: [] };
    const v = only(revalidatePlanSnapshots([claim({ nodeId: "a" })], deps([cap({ id: "cap-print", tenantId: "t-other" })], KERNELS, calls), { tenantId: "t-1" }));
    expect(v).toEqual({ nodeId: "a", status: "missing", reason: "capability-not-found" });
    expect(calls.caps).toEqual([["cap-print"]]);
    expect(calls.kernels).toEqual([]);
  });

  it("malformed rows from a loader get typed verdicts, never a throw", () => {
    const withCaps = (rows: unknown[], kernels: unknown[] = KERNELS): RevalidationDeps => ({
      ...deps([]),
      loadCapabilities: () => rows as LiveCapability[],
      loadKernels: () => kernels as LiveKernel[],
    });
    const verdictOf = (d: RevalidationDeps) => only(revalidatePlanSnapshots([claim({ nodeId: "a" })], d));
    for (const rows of [[null], [{}], [{ id: 5 }], ["cap-print"]]) {
      expect(verdictOf(withCaps(rows))).toEqual({ nodeId: "a", status: "missing", reason: "capability-not-found" });
    }
    // a row for an id nobody asked for is not attributed to the claim
    expect(verdictOf(withCaps([cap({ id: "cap-other" })])).status).toBe("missing");
    expect(verdictOf(withCaps([{ ...cap({ id: "cap-print" }), type: 7 }]))).toEqual({ nodeId: "a", status: "unavailable", reason: "malformed-live-row" });
    expect(verdictOf(withCaps([cap({ id: "cap-print" })], [null]))).toEqual({ nodeId: "a", status: "missing", reason: "kernel-not-found" });
    expect(verdictOf(withCaps([cap({ id: "cap-print" })], [{ id: "k-1", operatorAddress: OP, status: 1 }]))).toEqual({ nodeId: "a", status: "unavailable", reason: "malformed-live-row" });
  });

  it("a caller-supplied payout address is ignored: the payout is the live operator's", () => {
    const attacker = `0x${"66".repeat(20)}`;
    const v = only(revalidatePlanSnapshots([{ ...claim({ nodeId: "a" }), payoutAddress: attacker } as SnapshotClaim], deps([cap({ id: "cap-print" })])));
    expect(v.status).toBe("current");
    if (v.status === "current") {
      expect(v.resolved.payoutAddress).toBe(OP);
      expect(JSON.stringify(v.resolved, (_k, x) => (typeof x === "bigint" ? x.toString() : x))).not.toContain("6666");
    }
  });

  it("a capability type with no CSD has no evidence contract to settle against: incompatible", () => {
    const v = only(revalidatePlanSnapshots([claim({ nodeId: "a" })], deps([cap({ id: "cap-print", type: "interpretive-dance" })])));
    expect(v).toEqual({ nodeId: "a", status: "incompatible", reason: "no-csd-for-type" });
  });
});

describe("unpriceable: no exact flat price in a settleable currency — never priced at 0, never defaulted", () => {
  const reason = (pricing: LiveCapability["pricing"]) => {
    const v = only(revalidatePlanSnapshots([claim({ nodeId: "a" })], deps([cap({ id: "cap-print", pricing })])));
    return v.status === "unpriceable" ? v.reason : v.status;
  };

  it("an unpriced row is refused where the decomposer's capPrice would say 0", () => {
    expect(capPrice({ id: "x", type: PRINT, name: "", kernelId: "k-1", pricing: undefined })).toBe(0);
    expect(reason(null)).toBe("no-pricing");
    expect(reason({ currency: "USDC" })).toBe("no-pricing");
  });

  it("a missing or unknown currency is refused, not defaulted to USDC", () => {
    expect(reason({ baseCost: "6.50", minimum: "6.50" })).toBe("currency-not-settleable");
    expect(reason({ currency: "EURC", baseCost: "6.50", minimum: "6.50" })).toBe("currency-not-settleable");
    expect(reason({ currency: "constructor", baseCost: "6.50" })).toBe("currency-not-settleable");
  });

  it("variable pricing needs a parameterized quote; a zero variable component is flat", () => {
    expect(reason({ currency: "USDC", baseCost: "6.50", minimum: "6.50", perGram: "0.05" })).toBe("variable-pricing");
    expect(reason({ currency: "USDC", baseCost: "6.50", minimum: "6.50", perGram: "0.00" })).toBe("current");
  });

  it("malformed, zero, finer-than-a-base-unit, out-of-range, or below-minimum prices are refused", () => {
    expect(reason({ currency: "USDC", baseCost: "abc", minimum: "1" })).toBe("malformed-price");
    expect(reason({ currency: "USDC", baseCost: "1e3", minimum: "1" })).toBe("malformed-price");
    expect(reason({ currency: "USDC", baseCost: "0.00", minimum: "0" })).toBe("non-positive-price");
    expect(reason({ currency: "USDC", baseCost: "1.0000001", minimum: "1" })).toBe("sub-base-unit-price");
    expect(reason({ currency: "USDC", baseCost: "1" + "0".repeat(40), minimum: "1" })).toBe("price-out-of-range");
    // the real charge would be the minimum while the digest commits baseCost: refuse, don't pick one
    expect(reason({ currency: "USDC", baseCost: "5.00", minimum: "6.50" })).toBe("below-minimum-charge");
  });
});

describe("invalid claims", () => {
  it("each malformed claim field gets a typed verdict and no load", () => {
    const calls: Calls = { caps: [], kernels: [] };
    const bad: Array<[Partial<SnapshotClaim>, string]> = [
      [{ capabilityId: "" }, "malformed-capability-id"],
      [{ price: "6.5.0" }, "malformed-price"],
      [{ price: "-1" }, "malformed-price"],
      [{ price: "1e3" }, "malformed-price"],
      [{ price: "06.5" }, "malformed-price"],
      [{ price: " 6.5" }, "malformed-price"],
      [{ price: 6.5 as unknown as string }, "malformed-price"],
      [{ currency: "usdc" }, "malformed-currency"],
      [{ tierKey: "TIER2" }, "malformed-tier"],
      [{ tierKey: "tier4" }, "malformed-tier"],
      [{ operator: "0x123" }, "malformed-operator"],
      [{ operator: undefined }, "malformed-operator"], // required: the digest does not cover the operator
      [{ kernelId: ["k-1"] as unknown as string }, "malformed-kernel-id"],
      [{ kernelId: undefined }, "malformed-kernel-id"],
      [{ matchedCapabilityDigest: "0xabc" }, "malformed-cross-check"],
      [{ capabilityType: 7 as unknown as string }, "malformed-cross-check"],
    ];
    for (const [p, reason] of bad) {
      const v = only(revalidatePlanSnapshots([claim({ nodeId: "a", ...p })], deps([cap({ id: "cap-print" })], KERNELS, calls)));
      expect(v).toEqual({ nodeId: "a", status: "invalid-claim", reason });
    }
    expect(calls.caps).toEqual([]); // nothing valid, nothing loaded
    expect(calls.kernels).toEqual([]);
  });

  it("a duplicated node id gets ONE verdict (never two units), regardless of which copy comes first", () => {
    const a = claim({ nodeId: "x", price: "6.50" });
    const b = claim({ nodeId: "x", price: "1.00" });
    const r1 = revalidatePlanSnapshots([a, b], deps([cap({ id: "cap-print" })]));
    const r2 = revalidatePlanSnapshots([b, a], deps([cap({ id: "cap-print" })]));
    expect(r1).toEqual(r2);
    expect(r1.verdicts).toEqual([{ nodeId: "x", status: "invalid-claim", reason: "duplicate-node-id" }]);
  });

  it("a non-string node id is refused without throwing", () => {
    const r = revalidatePlanSnapshots([{ ...claim({ nodeId: "a" }), nodeId: 7 as unknown as string }], deps([cap({ id: "cap-print" })]));
    expect(r.verdicts).toEqual([{ nodeId: "<number>", status: "invalid-claim", reason: "malformed-node-id" }]);
  });
});

describe("determinism, batching and the ok flag", () => {
  const live = [cap({ id: "cap-print" }), cap({ id: "cap-mail", type: "mail.drop", kernelId: "k-2" })];
  const claims = [
    claim({ nodeId: "print" }),
    claim({ nodeId: "mail", capabilityId: "cap-mail", kernelId: "k-2", operator: OP2 }),
    claim({ nodeId: "print-2" }), // a second unit of the same capability
  ];

  it("claim order does not change the result; verdicts are sorted by node id", () => {
    const r1 = revalidatePlanSnapshots(claims, deps(live));
    const r2 = revalidatePlanSnapshots([...claims].reverse(), deps(live));
    expect(r1).toEqual(r2);
    expect(r1.verdicts.map((v) => v.nodeId)).toEqual(["mail", "print", "print-2"]);
    expect(r1.ok).toBe(true);
  });

  it("one batched load per table, with sorted de-duplicated ids", () => {
    const calls: Calls = { caps: [], kernels: [] };
    revalidatePlanSnapshots(claims, deps(live, KERNELS, calls));
    expect(calls.caps).toEqual([["cap-mail", "cap-print"]]);
    expect(calls.kernels).toEqual([["k-1", "k-2"]]);
  });

  it("ok is true only when every node is current, and never for an empty plan", () => {
    expect(revalidatePlanSnapshots([], deps(live))).toEqual({ ok: false, verdicts: [] });
    const oneStale = revalidatePlanSnapshots([...claims, claim({ nodeId: "z", price: "1.00" })], deps(live));
    expect(oneStale.ok).toBe(false);
    expect(oneStale.verdicts.filter((v) => v.status === "current")).toHaveLength(3);
  });

  it("a loader failure propagates: an outage must not read as 'capability not found'", () => {
    const broken: RevalidationDeps = {
      ...deps(live),
      loadCapabilities: () => {
        throw new Error("db down");
      },
    };
    expect(() => revalidatePlanSnapshots(claims, broken)).toThrow("db down");
  });
});

describe("exact-decimal helpers", () => {
  it("canonicalDecimal accepts only plain non-negative decimals and strips trailing zeros", () => {
    expect(canonicalDecimal("6.50")).toBe("6.5");
    expect(canonicalDecimal("7.000")).toBe("7");
    expect(canonicalDecimal("0.000001")).toBe("0.000001");
    expect(canonicalDecimal("0")).toBe("0");
    for (const bad of ["", ".5", "5.", "-1", "+1", "1e3", "06", " 6", "6 ", "0x10", "Infinity", "NaN"]) {
      expect(canonicalDecimal(bad)).toBeNull();
    }
    expect(canonicalDecimal(6.5)).toBeNull();
  });

  it("decimalToBaseUnits is exact and refuses sub-base-unit precision", () => {
    expect(decimalToBaseUnits("6.5", 6)).toBe(6_500_000n);
    expect(decimalToBaseUnits("0.000001", 6)).toBe(1n);
    expect(decimalToBaseUnits("0.0000001", 6)).toBeNull();
    expect(decimalToBaseUnits("9007199254740993", 6)).toBe(9_007_199_254_740_993_000_000n); // past 2^53, exact
  });

  it("csdSlugFromUrl reads the registry URL's slug", () => {
    expect(csdSlugFromUrl("pcc://capabilities/document-print-and-mail/v1")).toBe(PRINT);
    expect(csdSlugFromUrl("https://example.com/x")).toBeNull();
    expect(csdSlugFromUrl(undefined)).toBeNull();
  });
});

describe("round 3 (astra review of 27a23c6e): claims and live rows are read ONCE into owned data", () => {
  it("a tierKey getter that changes after validation cannot make `current` carry an unoffered tier", () => {
    let reads = 0;
    const c = Object.defineProperty(claim({ nodeId: "a" }), "tierKey", { enumerable: true, get: () => (reads++ < 2 ? "tier0" : "tier3") });
    const v = only(revalidatePlanSnapshots([c], deps([cap({ id: "cap-print" })])));
    expect(reads).toBe(1);
    expect(v.status).toBe("current");
    if (v.status === "current") expect([v.resolved.tierKey, v.resolved.tier]).toEqual(["tier0", 0]);
  });

  it("a loader that re-points two claims at one node id after the duplicate check changes nothing", () => {
    const a = claim({ nodeId: "a" });
    const b = claim({ nodeId: "b" });
    const d = deps([cap({ id: "cap-print" })]);
    const sneaky: RevalidationDeps = {
      ...d,
      loadCapabilities: (ids) => {
        (b as { nodeId: string }).nodeId = "a";
        return d.loadCapabilities(ids);
      },
    };
    const r = revalidatePlanSnapshots([a, b], sneaky);
    expect(r.verdicts.map((v) => [v.nodeId, v.status])).toEqual([
      ["a", "current"],
      ["b", "current"],
    ]);
  });

  it("a csdForType callback that mutates the retained row cannot mix kernels: the snapshot's kernel and operator are used", () => {
    const row = cap({ id: "cap-print", kernelId: "k-1" });
    const d = deps([row]);
    const sneaky: RevalidationDeps = {
      ...d,
      csdForType: (t) => {
        (row as { kernelId: string }).kernelId = "k-2";
        return d.csdForType(t);
      },
    };
    const v = only(revalidatePlanSnapshots([claim({ nodeId: "a", kernelId: "k-2", operator: OP })], sneaky));
    expect(v.status).toBe("stale");
    if (v.status === "stale") {
      expect(v.diffs.map((x) => x.field)).toEqual(["kernelId"]);
      expect([v.live.kernelId, v.live.operator]).toEqual(["k-1", OP]); // k-1's own operator, never a mix
    }
  });

  it("a pricing getter cannot split the gross from the digest", () => {
    let reads = 0;
    const row = Object.defineProperty(cap({ id: "cap-print" }), "pricing", {
      enumerable: true,
      get: () => (reads++ === 0 ? { currency: "USDC", baseCost: "6.50", minimum: "6.50" } : { currency: "USDC", baseCost: "7.25", minimum: "6.50" }),
    });
    const v = only(revalidatePlanSnapshots([claim({ nodeId: "a" })], deps([row])));
    expect(reads).toBe(1);
    expect(v.status).toBe("current");
    if (v.status === "current") {
      expect(v.resolved.grossBaseUnits).toBe(6_500_000n);
      expect(v.resolved.matchedCapabilityDigest).toBe(digestAt(6.5)); // the same snapshot priced both
    }
  });

  it("a baseCost getter cannot bypass the minimum-charge check", () => {
    let reads = 0;
    const pricing = Object.defineProperty({ currency: "USDC", minimum: "6.50" }, "baseCost", { enumerable: true, get: () => (reads++ === 1 ? undefined : "5.00") });
    const v = only(revalidatePlanSnapshots([claim({ nodeId: "a", price: "5.00" })], deps([cap({ id: "cap-print", pricing })])));
    expect(reads).toBe(1);
    expect(v).toEqual({ nodeId: "a", status: "unpriceable", reason: "below-minimum-charge" });
  });

  it("throwing getters on a claim or a row are typed verdicts, never exceptions", () => {
    const boom = () => {
      throw new Error("x");
    };
    const c = Object.defineProperty(claim({ nodeId: "a" }), "price", { enumerable: true, get: boom });
    expect(only(revalidatePlanSnapshots([c], deps([cap({ id: "cap-print" })])))).toEqual({ nodeId: "a", status: "invalid-claim", reason: "unreadable-claim" });
    const row = Object.defineProperty(cap({ id: "cap-print" }), "id", { enumerable: true, get: boom });
    // the loader hands the row back untouched (the fixture's filtering loader would itself read the getter)
    expect(only(revalidatePlanSnapshots([claim({ nodeId: "a" })], { ...deps([]), loadCapabilities: () => [row] }))).toEqual({
      nodeId: "a",
      status: "missing",
      reason: "capability-not-found",
    });
    let opReads = 0;
    const k: LiveKernel[] = [Object.defineProperty({ id: "k-1", status: "online" }, "operatorAddress", { enumerable: true, get: () => (opReads++ === 0 ? OP : null) }) as LiveKernel];
    expect(() => revalidatePlanSnapshots([claim({ nodeId: "a" })], deps([cap({ id: "cap-print" })], k))).not.toThrow();
    expect(opReads).toBe(1);
  });

  it("a tier list's length is read once: a proxy cannot shrink it past a hole or grow it past the cap", () => {
    let lengthReads = 0;
    const tiers = new Proxy([0, , 2] as number[], {
      get: (t, k, r) => (k === "length" ? (lengthReads++ === 0 ? 3 : 1) : Reflect.get(t, k, r)),
    });
    const v = only(revalidatePlanSnapshots([claim({ nodeId: "a" })], deps([cap({ id: "cap-print", assuranceTiers: tiers })])));
    expect(lengthReads).toBe(1);
    expect(v).toEqual({ nodeId: "a", status: "unavailable", reason: "malformed-tiers" }); // the hole was seen
  });

  it("an unreadable loader answer (not a list, or a throwing length) is a malformed live answer, not 'not found'", () => {
    const d = deps([cap({ id: "cap-print" })]);
    const answers: unknown[] = [{}, "rows", new Proxy([], { get: (t, k) => (k === "length" ? (() => { throw new Error("x"); })() : Reflect.get(t, k)) })];
    for (const a of answers) {
      const v = only(revalidatePlanSnapshots([claim({ nodeId: "a" })], { ...d, loadCapabilities: () => a as LiveCapability[] }));
      expect(v).toEqual({ nodeId: "a", status: "unavailable", reason: "malformed-live-row" });
    }
    const kv = only(revalidatePlanSnapshots([claim({ nodeId: "a" })], { ...d, loadKernels: () => ({}) as unknown as LiveKernel[] }));
    expect(kv).toEqual({ nodeId: "a", status: "unavailable", reason: "malformed-live-row" });
  });

  it("an unreadable claims list is one typed verdict; a dependency that is not a function is a wiring fault", () => {
    const lying = new Proxy([], { get: (t, k) => (k === "length" ? (() => { throw new Error("x"); })() : Reflect.get(t, k)) });
    expect(revalidatePlanSnapshots(lying as unknown as SnapshotClaim[], deps([]))).toEqual({
      ok: false,
      verdicts: [{ nodeId: "<claims>", status: "invalid-claim", reason: "unreadable-claim" }],
    });
    expect(() => revalidatePlanSnapshots([claim({ nodeId: "a" })], { ...deps([]), csdForType: null as unknown as RevalidationDeps["csdForType"] })).toThrow(TypeError);
  });
});
