/**
 * The agentic decomposer emits `matchedCapabilityDigest` on every MATCHED node
 * and never on an unmatched one.
 *
 * This is the field composition's compositionRoot guard and bridge's job-offer
 * producer (PR #294) bind to instead of the mutable capabilityId. Until this
 * wiring, "every real plan was matched but digest-less" and both consumers
 * correctly refused everything. These tests pin the contract from the
 * PRODUCER side: present iff matched, 0x + 64 hex, and computed from the SAME
 * resolved price/currency/tiers the node is priced with — so the digest and
 * the price a buyer sees can never disagree about the deal.
 */

import { describe, it, expect } from "vitest";
import type { CapabilityRequest } from "@pcc/spec";
import {
  decomposeAgentic,
  createMatcher,
  type CapabilityLite,
  type DecomposerLLM,
} from "../services/agentic-decomposer.js";
import { matchedCapabilityDigest } from "../services/matched-capability-digest.js";

const PIZZA: CapabilityLite = {
  id: "cap-marios-wood-fired-pizza",
  type: "wood-fired-pizza",
  name: "Mario's 12-inch Margherita",
  description: "wood fired pizza oven, neapolitan style",
  tags: ["pizza", "food", "wood-fired"],
  materials: ["dough", "mozzarella"],
  kernelId: "kernel-marios",
  pricing: { currency: "USDC", baseCost: "12" },
  assuranceTiers: [1, 0],
};

const COURIER: CapabilityLite = {
  id: "cap-daves-courier",
  type: "local-courier-delivery",
  name: "Dave's Local Courier",
  description: "same-day local delivery by bike courier",
  tags: ["delivery", "courier"],
  kernelId: "kernel-daves",
  pricing: { currency: "USDC", baseCost: "6" },
  assuranceTiers: [0, 1],
};

/** A deterministic planner so the test controls which steps match. */
function plannerReturning(steps: Array<{ name: string; searchQuery: string; kind?: "make" | "deliver" | "generic" }>): DecomposerLLM {
  return {
    async planSteps() {
      return steps.map((s) => ({
        name: s.name,
        description: s.name,
        searchQuery: s.searchQuery,
        kind: s.kind ?? "generic",
      }));
    },
  };
}

function request(id: string): CapabilityRequest {
  const now = new Date().toISOString();
  return {
    id,
    title: "a margherita pizza made and delivered",
    description: "make a 12-inch margherita and deliver it locally",
    budget: 0,
    currency: "USDC",
    deadline: now,
    urgency: "standard",
    status: "draft",
    capabilityDag: [],
    totalEstimatedCost: 0,
    totalEstimatedHours: 0,
    createdAt: now,
    updatedAt: now,
  } as unknown as CapabilityRequest;
}

const HEX32 = /^0x[0-9a-f]{64}$/;

describe("decomposeAgentic — matchedCapabilityDigest on nodes", () => {
  it("every MATCHED node carries a 0x+64hex digest; an UNMATCHED node carries none", async () => {
    const result = await decomposeAgentic(request("req-1"), {
      llm: plannerReturning([
        { name: "Make the pizza", searchQuery: "wood fired pizza margherita", kind: "make" },
        { name: "Deliver it", searchQuery: "local courier delivery", kind: "deliver" },
        { name: "Impossible leg", searchQuery: "quantum flux capacitor calibration", kind: "generic" },
      ]),
      matcher: createMatcher(() => [PIZZA, COURIER]),
    });

    const nodes = result.capabilityDag ?? (result as any).nodes;
    expect(nodes.length).toBe(3);

    const matched = nodes.filter((n: any) => n.matchStatus === "matched");
    const unmatched = nodes.filter((n: any) => n.matchStatus !== "matched");
    expect(matched.length, "two legs must match the seeded caps").toBe(2);
    expect(unmatched.length, "the impossible leg must not match").toBe(1);

    for (const n of matched) {
      expect(n.matchedCapabilityDigest, `${n.name} must carry a digest`).toMatch(HEX32);
    }
    // The consumers' fail-closed guards treat a matched node WITHOUT a digest
    // as uncommittable — so an unmatched node must not carry one that looks
    // like a match.
    expect(unmatched[0].matchedCapabilityDigest).toBeUndefined();
    expect(unmatched[0].matchedCapabilityId).toBeUndefined();
  });

  it("the digest is computed from the SAME resolved price/currency/tiers the node is priced with", async () => {
    const result = await decomposeAgentic(request("req-2"), {
      llm: plannerReturning([{ name: "Make the pizza", searchQuery: "wood fired pizza", kind: "make" }]),
      matcher: createMatcher(() => [PIZZA]),
    });
    const nodes = result.capabilityDag ?? (result as any).nodes;
    const node = nodes[0];
    expect(node.matchStatus).toBe("matched");
    expect(node.matchedCapabilityId).toBe(PIZZA.id);

    // Recompute independently from the capability the way toMatched resolves
    // it. If these ever diverge, a commitment could bind to a different deal
    // than the one the buyer was quoted.
    const expected = matchedCapabilityDigest({
      capabilityId: PIZZA.id,
      capabilityType: PIZZA.type,
      kernelId: PIZZA.kernelId,
      price: Number(PIZZA.pricing!.baseCost),
      currency: PIZZA.pricing!.currency!,
      assuranceTiers: PIZZA.assuranceTiers!,
    });
    expect(node.matchedCapabilityDigest).toBe(expected);
    expect(node.estimatedCost).toBe(12);
  });

  it("two plans that match the same capability get the SAME digest; a price change moves it", async () => {
    const deps = {
      llm: plannerReturning([{ name: "Make the pizza", searchQuery: "wood fired pizza", kind: "make" as const }]),
    };
    const a = await decomposeAgentic(request("req-3a"), { ...deps, matcher: createMatcher(() => [PIZZA]) });
    const b = await decomposeAgentic(request("req-3b"), { ...deps, matcher: createMatcher(() => [PIZZA]) });
    const repriced = await decomposeAgentic(request("req-3c"), {
      ...deps,
      matcher: createMatcher(() => [{ ...PIZZA, pricing: { currency: "USDC", baseCost: "13" } }]),
    });
    const dig = (r: any) => (r.capabilityDag ?? r.nodes)[0].matchedCapabilityDigest;
    expect(dig(a)).toBe(dig(b));
    expect(dig(repriced)).not.toBe(dig(a));
  });

  it("is stable when the capability's assuranceTiers arrive in a different order", async () => {
    const deps = {
      llm: plannerReturning([{ name: "Make the pizza", searchQuery: "wood fired pizza", kind: "make" as const }]),
    };
    const a = await decomposeAgentic(request("req-4a"), { ...deps, matcher: createMatcher(() => [PIZZA]) });
    const b = await decomposeAgentic(request("req-4b"), {
      ...deps,
      matcher: createMatcher(() => [{ ...PIZZA, assuranceTiers: [0, 1] }]),
    });
    const dig = (r: any) => (r.capabilityDag ?? r.nodes)[0].matchedCapabilityDigest;
    expect(dig(a)).toBe(dig(b));
  });
});
