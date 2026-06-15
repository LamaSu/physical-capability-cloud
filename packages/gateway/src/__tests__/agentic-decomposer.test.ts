/**
 * Composition keystone (#133) — agentic decompose + capability matching.
 *
 * These are PURE-ENGINE tests: the LLM planner and capability matcher are
 * injected as deterministic stubs, so the acceptance criteria are proven with
 * no network and no API key. The route-level integration (real CapabilityFacade
 * matcher, offline heuristic planner) is covered in requests.test.ts.
 *
 * Acceptance:
 *   - "Margherita pizza delivered to Manhattan" yields a make-pizza node matched
 *     to a wood-fired-pizza cap + a delivery node matched to a
 *     local-courier-delivery cap.
 *   - Budget is derived from the matched capability prices (12 + 6 = 18), not 1000.
 *   - Evidence requirements come from the matched capability, not "pdf_proof".
 *   - A non-printing goal NEVER yields a document-printing DAG.
 */

import { describe, it, expect } from "vitest";
import {
  decomposeAgentic,
  createMatcher,
  scoreCapability,
  heuristicPlan,
  deriveEvidence,
  parsePlannedSteps,
  capPrice,
  type CapabilityLite,
  type DecomposerLLM,
} from "../services/agentic-decomposer.js";
import { decomposeRequest } from "../services/request-decomposer.js";
import type { CapabilityRequest } from "@pcc/spec";

// ── The two live seeded caps the keystone must match ──────────────────────────

const MARIOS: CapabilityLite = {
  id: "cap-marios-pizzeria",
  type: "wood-fired-pizza",
  name: "Marios Pizzeria",
  description: "Hand-stretched wood-fired Neapolitan and margherita pizza, baked to order.",
  tags: ["pizza", "margherita", "wood-fired", "food", "neapolitan"],
  materials: ["dough", "san-marzano-tomato", "mozzarella", "basil"],
  kernelId: "kernel-marios",
  pricing: { currency: "USDC", baseCost: "12.00", minimum: "8.00" },
  assuranceTiers: [0, 1, 2],
};

const DAVES: CapabilityLite = {
  id: "cap-daves-delivery",
  type: "local-courier-delivery",
  name: "Daves Delivery",
  description: "Local last-mile courier delivery by bike and car across Manhattan.",
  tags: ["delivery", "courier", "last-mile", "logistics"],
  materials: [],
  kernelId: "kernel-daves",
  pricing: { currency: "USDC", baseCost: "6.00", minimum: "4.00" },
  assuranceTiers: [0, 1],
};

const SEEDED: CapabilityLite[] = [MARIOS, DAVES];

const PIZZA_GOAL = "a 12-inch margherita pizza made and delivered to me in Manhattan";

function makeReq(over: Partial<CapabilityRequest> = {}): CapabilityRequest {
  const now = new Date().toISOString();
  return {
    id: "req-test",
    title: "Order",
    description: "",
    budget: 1000,
    currency: "USDC",
    deadline: now,
    urgency: "standard",
    status: "draft",
    capabilityDag: [],
    totalEstimatedCost: 0,
    totalEstimatedHours: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/** A deterministic LLM stub — plans pizza→make + deliver, like the real model. */
const pizzaLLM: DecomposerLLM = {
  async planSteps() {
    return [
      { name: "Make the pizza", description: "Prepare a 12-inch margherita pizza", searchQuery: "wood-fired margherita pizza", kind: "make" },
      { name: "Deliver to Manhattan", description: "Deliver the pizza to the requester in Manhattan", searchQuery: "local courier delivery Manhattan", kind: "deliver" },
    ];
  },
};

// ── Acceptance: pizza keystone ────────────────────────────────────────────────

describe("agentic decompose — pizza keystone (#133)", () => {
  const matcher = createMatcher(() => SEEDED);

  it("LLM plan: pizza delivered → make(Marios) + delivery(Daves), budget 18, evidence from caps, not published", async () => {
    const req = makeReq({ id: "req-pizza", title: "Margherita pizza", description: PIZZA_GOAL });
    const result = await decomposeAgentic(req, { llm: pizzaLLM, matcher, legacyFallback: decomposeRequest });

    expect(result.usedLLM).toBe(true);
    expect(result.usedFallback).toBe(false);
    expect(result.nodes).toHaveLength(2);
    expect(result.matchedCount).toBe(2);

    const [make, deliver] = result.nodes;

    // make-pizza node matched to Marios' wood-fired-pizza cap
    expect(make.matchStatus).toBe("matched");
    expect(make.matchedCapabilityId).toBe("cap-marios-pizzeria");
    expect(make.matchedCapabilityName).toBe("Marios Pizzeria");
    expect(make.capabilityType).toBe("wood-fired-pizza");

    // delivery node matched to Daves' local-courier-delivery cap
    expect(deliver.matchStatus).toBe("matched");
    expect(deliver.matchedCapabilityId).toBe("cap-daves-delivery");
    expect(deliver.matchedCapabilityName).toBe("Daves Delivery");
    expect(deliver.capabilityType).toBe("local-courier-delivery");

    // budget derived from matched prices (12 + 6 = 18), NOT the old 1000 default
    expect(result.derivedBudget).toBe(18);
    expect(result.totalEstimatedCost).toBe(18);

    // evidence FROM the matched capability, never the old hardcoded pdf_proof
    expect(make.evidenceRequirements).not.toContain("pdf_proof");
    expect(make.evidenceRequirements).toContain("photo_of_completed_item");
    expect(deliver.evidenceRequirements).toContain("delivery_confirmation");

    // dependency ordering: deliver depends on make
    expect(make.dependencies).toEqual([]);
    expect(deliver.dependencies).toEqual([make.id]);

    // status is the engine's job to leave un-published — nodes are pending
    expect(result.nodes.every((n) => n.status === "pending")).toBe(true);
  });

  it("offline heuristic (no LLM): pizza still resolves to Marios + Daves, budget 18", async () => {
    const req = makeReq({ id: "req-pizza-2", title: "Pizza order", description: PIZZA_GOAL });
    const result = await decomposeAgentic(req, { llm: null, matcher, legacyFallback: decomposeRequest });

    expect(result.usedLLM).toBe(false);
    expect(result.usedFallback).toBe(false);
    expect(result.matchedCount).toBe(2);
    expect(result.nodes.map((n) => n.capabilityType).sort()).toEqual([
      "local-courier-delivery",
      "wood-fired-pizza",
    ]);
    expect(result.derivedBudget).toBe(18);
  });

  it("a non-printing goal NEVER yields a document-printing DAG (matched path)", async () => {
    const req = makeReq({ id: "req-pizza-3", description: PIZZA_GOAL });
    const result = await decomposeAgentic(req, { llm: null, matcher, legacyFallback: decomposeRequest });

    const types = result.nodes.map((n) => n.capabilityType);
    expect(types).not.toContain("documentation");
    expect(types).not.toContain("ipp");
    const text = result.nodes.map((n) => `${n.name} ${n.evidenceRequirements.join(",")}`).join(" ").toLowerCase();
    expect(text).not.toMatch(/pdf_proof|courier-pickup|doc-prep/);
  });

  it("a non-printing goal NEVER yields a document DAG even with NO matches (legacy fallback)", async () => {
    const emptyMatcher = createMatcher(() => []);
    const req = makeReq({ id: "req-pizza-4", description: PIZZA_GOAL });
    const result = await decomposeAgentic(req, { llm: null, matcher: emptyMatcher, legacyFallback: decomposeRequest });

    // Nothing matched + no LLM → legacy templates, but tightened detection means
    // "deliver" alone no longer selects the document-print template.
    expect(result.usedFallback).toBe(true);
    const types = result.nodes.map((n) => n.capabilityType);
    expect(types).not.toContain("ipp");
    expect(types).not.toContain("documentation");
    const names = result.nodes.map((n) => n.name.toLowerCase()).join(" ");
    expect(names).not.toMatch(/document preparation|printing|courier pickup/);
  });

  it("derives budget purely from MATCHED prices (unmatched delivery is excluded)", async () => {
    // Only Marios is registered → make matches (12), delivery does not.
    const partialMatcher = createMatcher(() => [MARIOS]);
    const req = makeReq({ id: "req-pizza-5", description: PIZZA_GOAL });
    const result = await decomposeAgentic(req, { llm: pizzaLLM, matcher: partialMatcher, legacyFallback: decomposeRequest });

    expect(result.matchedCount).toBe(1);
    expect(result.nodes[0].matchStatus).toBe("matched");
    expect(result.nodes[1].matchStatus).toBe("none");
    // derived budget = only the matched 12, not the unmatched node's fallback estimate
    expect(result.derivedBudget).toBe(12);
  });
});

// ── Unit: matcher / heuristic / parser ────────────────────────────────────────

describe("scoreCapability", () => {
  it("scores a pizza query high against the pizza cap, ~zero against delivery", () => {
    const pizza = scoreCapability("wood-fired margherita pizza", MARIOS);
    const delivery = scoreCapability("wood-fired margherita pizza", DAVES);
    expect(pizza.strongHit).toBe(true);
    expect(pizza.score).toBeGreaterThan(0.5);
    expect(delivery.score).toBe(0);
  });

  it("matches morphological variants (deliver/delivered/delivery, pizza/pizzeria)", () => {
    expect(scoreCapability("delivered by courier", DAVES).strongHit).toBe(true);
    expect(scoreCapability("a pizza", MARIOS).strongHit).toBe(true);
  });
});

describe("heuristicPlan", () => {
  it("splits a deliver-it goal into make + deliver steps", () => {
    const steps = heuristicPlan({ title: "Pizza", description: PIZZA_GOAL });
    expect(steps).toHaveLength(2);
    expect(steps[0].kind).toBe("make");
    expect(steps[1].kind).toBe("deliver");
    // the make step's query is stripped of delivery words
    expect(steps[0].searchQuery.toLowerCase()).not.toMatch(/deliver/);
  });

  it("produces a single step when there's no delivery clause", () => {
    const steps = heuristicPlan({ title: "HPLC", description: "run an HPLC purity assay" });
    expect(steps).toHaveLength(1);
  });
});

describe("deriveEvidence", () => {
  it("is never the hardcoded pdf_proof and reflects the cap's domain + tier", () => {
    const matched = createMatcher(() => SEEDED);
    return matched.match("wood-fired margherita pizza").then((m) => {
      const ev = deriveEvidence(m, "make");
      expect(ev).not.toContain("pdf_proof");
      expect(ev).toContain("photo_of_completed_item");
      // Marios supports tier 2 → richer evidence
      expect(ev).toContain("kitchen_ticket_log");
    });
  });
});

describe("parsePlannedSteps", () => {
  it("parses a bare JSON array", () => {
    const steps = parsePlannedSteps('[{"name":"Make","searchQuery":"pizza","kind":"make"}]');
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe("Make");
  });
  it("parses a fenced ```json block and ignores prose", () => {
    const steps = parsePlannedSteps('Sure!\n```json\n[{"name":"Deliver","searchQuery":"courier"}]\n```\nDone.');
    expect(steps).toHaveLength(1);
    expect(steps[0].searchQuery).toBe("courier");
  });
  it("returns [] on garbage", () => {
    expect(parsePlannedSteps("not json at all")).toEqual([]);
  });
});

describe("capPrice", () => {
  it("reads baseCost, falling back to minimum", () => {
    expect(capPrice(MARIOS)).toBe(12);
    expect(capPrice({ ...MARIOS, pricing: { currency: "USDC", minimum: "9.50" } })).toBe(9.5);
    expect(capPrice({ ...MARIOS, pricing: undefined })).toBe(0);
  });
});
