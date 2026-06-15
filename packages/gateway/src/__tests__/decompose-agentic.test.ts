/**
 * Agentic Decomposer + Capability Matcher tests.
 *
 * Covers the composition keystone:
 *   - LLM-emitted DAGs are parsed into CapabilityNodes with matched
 *     capability ids resolved from the live registry.
 *   - The pizza repro: "12-inch margherita pizza made and delivered to me
 *     in Manhattan" → make-pizza node matched to a wood-fired-pizza cap,
 *     deliver node matched to a local-courier-delivery cap.
 *   - Budget is derived from matched capability prices (sum of baseCost
 *     × quantity), NOT hardcoded to 1000.
 *   - evidenceRequirements come from the matched capability's assurance
 *     tier defaults, not from the legacy template's hardcoded list.
 *   - A non-printing goal ("build a CAD file for a bracket") never yields
 *     the document-printing DAG; it matches a relevant cap or returns
 *     match:none.
 *   - When the LLM is unavailable (test override = null), the route falls
 *     back to the legacy template decomposer cleanly.
 *
 * Test strategy: inject a stub LLMClient that returns a pre-baked JSON
 * IntentDag so we don't depend on a live API key. The full pipeline still
 * runs — matching, cost derivation, evidence resolution, persistence.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  requestRoutes,
  resetRequestsStore,
  _setLLMClientForTests,
} from "../routes/requests.js";
import {
  buildDagFromIntent,
  matchCapability,
  parseIntentDag,
  type CandidateCapability,
  type IntentDag,
  type LLMClient,
} from "../services/agentic-decomposer.js";
import { initStore, closeStore, getRepos } from "../db.js";

// ---------------------------------------------------------------------------
// Boot — same in-memory pattern as requests.test.ts.
// ---------------------------------------------------------------------------

beforeAll(() => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
});

afterAll(() => {
  closeStore();
});

// ---------------------------------------------------------------------------
// Fixtures — capabilities seeded explicitly for these tests.
// We use kernel-nyc (already seeded) so we don't have to spin up new kernels.
// ---------------------------------------------------------------------------

const PIZZA_CAP_ID = "cap-test-pizza";
const DELIVERY_CAP_ID = "cap-test-delivery";

function seedTestCapabilities(): void {
  const repos = getRepos();

  // Idempotent — these tests run beforeEach and resetRequestsStore() doesn't
  // wipe the capabilities table. Skip insert if already present.
  if (!repos.capabilities.findById(PIZZA_CAP_ID)) {
    repos.capabilities.insert({
      id: PIZZA_CAP_ID,
      kernelId: "kernel-nyc",
      type: "wood-fired-pizza",
      name: "Marios Pizzeria Wood-Fired Pizza",
      description: "Neapolitan-style wood-fired pizza, 12-14 inch, made to order.",
      materials: ["dough", "tomato", "mozzarella", "basil"],
      assuranceTiers: [0, 1],
      pricing: { currency: "USDC", baseCost: "12.00", minimum: "10.00" },
      availability: {},
      location: { lat: 40.7128, lng: -74.006 },
      queueDepth: 0,
      tags: ["pizza", "food", "wood-fired", "neapolitan"],
    } as any);
  }

  if (!repos.capabilities.findById(DELIVERY_CAP_ID)) {
    repos.capabilities.insert({
      id: DELIVERY_CAP_ID,
      kernelId: "kernel-nyc",
      type: "local-courier-delivery",
      name: "Daves Delivery Local Courier",
      description: "Same-day local courier delivery within Manhattan.",
      materials: [],
      assuranceTiers: [0, 1],
      pricing: { currency: "USDC", baseCost: "6.00", minimum: "5.00" },
      availability: {},
      location: { lat: 40.7128, lng: -74.006 },
      queueDepth: 0,
      tags: ["delivery", "courier", "manhattan", "logistics"],
    } as any);
  }
}

// ---------------------------------------------------------------------------
// Stub LLMClient — emits a baked IntentDag so we test the full pipeline
// without a live API key.
// ---------------------------------------------------------------------------

function makeStubLLM(intent: IntentDag): LLMClient {
  return {
    async completeJSON() {
      return JSON.stringify(intent);
    },
  };
}

const PIZZA_INTENT: IntentDag = {
  goal: "Make and deliver a 12-inch margherita pizza in Manhattan.",
  nodes: [
    {
      nodeId: "make-pizza",
      name: "Make 12-inch margherita pizza",
      description:
        "Hand-stretch dough, top with San Marzano tomato + fresh mozzarella + basil, fire in wood oven.",
      category: "food",
      requiredCapabilityType: "wood-fired-pizza",
      quantity: 1,
      estimatedHours: 0.3,
      dependencies: [],
      parallel: false,
      materials: [],
      evidenceRequirements: ["photo_of_finished_pizza"],
    },
    {
      nodeId: "deliver",
      name: "Deliver to Manhattan address",
      description: "Hand off to courier, last-mile delivery to recipient.",
      category: "logistics",
      requiredCapabilityType: "local-courier-delivery",
      quantity: 1,
      estimatedHours: 0.5,
      dependencies: ["make-pizza"],
      parallel: false,
      materials: [],
      evidenceRequirements: ["delivery_confirmation"],
    },
  ],
};

const BRACKET_INTENT: IntentDag = {
  goal: "Design a CAD file for a mounting bracket.",
  nodes: [
    {
      nodeId: "cad-design",
      name: "Bracket CAD model",
      description: "Parametric STEP file for a 2-bolt mounting bracket.",
      category: "design",
      requiredCapabilityType: "cad",
      quantity: 1,
      estimatedHours: 1.5,
      dependencies: [],
      parallel: false,
      materials: [],
      evidenceRequirements: ["cad_files"],
    },
  ],
};

// ---------------------------------------------------------------------------
// App builder.
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(requestRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Unit tests — matcher + buildDagFromIntent + parseIntentDag
// ---------------------------------------------------------------------------

describe("matchCapability", () => {
  const candidates: CandidateCapability[] = [
    {
      id: PIZZA_CAP_ID,
      kernelId: "kernel-nyc",
      type: "wood-fired-pizza",
      name: "Marios Pizzeria Wood-Fired Pizza",
      baseCostUSDC: 12,
      minimumUSDC: 10,
      assuranceTiers: [0, 1],
      materials: [],
      tags: ["pizza", "food"],
    },
    {
      id: DELIVERY_CAP_ID,
      kernelId: "kernel-nyc",
      type: "local-courier-delivery",
      name: "Daves Delivery",
      baseCostUSDC: 6,
      minimumUSDC: 5,
      assuranceTiers: [0, 1],
      materials: [],
      tags: ["delivery", "courier"],
    },
    {
      id: "cap-nyc-fdm",
      kernelId: "kernel-nyc",
      type: "fdm",
      name: "Prusa MK4 FDM Printing",
      baseCostUSDC: 5,
      minimumUSDC: 5,
      assuranceTiers: [0, 1, 2],
      materials: ["PLA", "PETG"],
      tags: ["fdm", "3d-print"],
    },
  ];

  it("exact-matches by type", () => {
    const m = matchCapability("wood-fired-pizza", candidates);
    expect(m).not.toBeNull();
    expect(m!.capability.id).toBe(PIZZA_CAP_ID);
    expect(m!.score).toBe(1.0);
  });

  it("normalizes snake/underscore to kebab", () => {
    const m = matchCapability("wood_fired_pizza", candidates);
    expect(m).not.toBeNull();
    expect(m!.capability.id).toBe(PIZZA_CAP_ID);
    expect(m!.score).toBeGreaterThanOrEqual(0.95);
  });

  it("returns null for unrelated types (match:none)", () => {
    const m = matchCapability("rocket-launch", candidates);
    expect(m).toBeNull();
  });

  it("fuzzy-matches via substring", () => {
    const m = matchCapability("delivery", candidates);
    expect(m).not.toBeNull();
    expect(m!.capability.id).toBe(DELIVERY_CAP_ID);
  });
});

describe("parseIntentDag", () => {
  it("parses clean JSON", () => {
    const parsed = parseIntentDag(JSON.stringify(PIZZA_INTENT));
    expect(parsed).not.toBeNull();
    expect(parsed!.nodes.length).toBe(2);
  });

  it("strips trailing prose", () => {
    const raw = `Here is the JSON:\n${JSON.stringify(PIZZA_INTENT)}\n\nLet me know if you want to adjust.`;
    const parsed = parseIntentDag(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.nodes.length).toBe(2);
  });

  it("returns null on empty nodes", () => {
    const parsed = parseIntentDag(JSON.stringify({ goal: "x", nodes: [] }));
    expect(parsed).toBeNull();
  });

  it("returns null on garbage", () => {
    expect(parseIntentDag("not json at all")).toBeNull();
    expect(parseIntentDag("")).toBeNull();
  });
});

describe("buildDagFromIntent", () => {
  const candidates: CandidateCapability[] = [
    {
      id: PIZZA_CAP_ID,
      kernelId: "kernel-nyc",
      type: "wood-fired-pizza",
      name: "Marios Pizzeria",
      baseCostUSDC: 12,
      minimumUSDC: 10,
      assuranceTiers: [0, 1],
      materials: [],
    },
    {
      id: DELIVERY_CAP_ID,
      kernelId: "kernel-nyc",
      type: "local-courier-delivery",
      name: "Daves Delivery",
      baseCostUSDC: 6,
      minimumUSDC: 5,
      assuranceTiers: [0, 1],
      materials: [],
    },
  ];

  const req = {
    id: "req-test-pizza",
    title: "Pizza in Manhattan",
    description: "12-inch margherita, delivered.",
    budget: 1000,
    currency: "USDC",
    deadline: "2026-12-31T00:00:00Z",
    urgency: "standard" as const,
    status: "decomposing" as const,
    capabilityDag: [],
    totalEstimatedCost: 0,
    totalEstimatedHours: 0,
    createdAt: "2026-06-15T00:00:00Z",
    updatedAt: "2026-06-15T00:00:00Z",
  };

  it("derives total cost from matched capability prices (12 + 6 = 18 USDC)", () => {
    const result = buildDagFromIntent(req, PIZZA_INTENT, candidates);
    expect(result.totalEstimatedCost).toBeCloseTo(18, 2);
    expect(result.source).toBe("agentic");
    expect(result.matchCount).toBe(2);
  });

  it("attaches matchedCapabilityId per node", () => {
    const result = buildDagFromIntent(req, PIZZA_INTENT, candidates);
    const pizzaNode = result.nodes.find((n) => n.id.endsWith("make-pizza"))!;
    const deliveryNode = result.nodes.find((n) => n.id.endsWith("deliver"))!;
    expect(pizzaNode.matchedCapabilityId).toBe(PIZZA_CAP_ID);
    expect(pizzaNode.matchedKernelId).toBe("kernel-nyc");
    expect(deliveryNode.matchedCapabilityId).toBe(DELIVERY_CAP_ID);
  });

  it("pulls evidenceRequirements from matched capability tier (not hardcoded pdf_proof)", () => {
    const result = buildDagFromIntent(req, PIZZA_INTENT, candidates);
    const pizzaNode = result.nodes.find((n) => n.id.endsWith("make-pizza"))!;
    // Highest tier in the matched cap is 1 → tier-1 defaults = ["bundle_hash", "completion_event"]
    expect(pizzaNode.evidenceRequirements).toEqual(["bundle_hash", "completion_event"]);
    expect(pizzaNode.evidenceRequirements).not.toContain("pdf_proof");
  });

  it("respects dependencies edge — deliver depends on make-pizza", () => {
    const result = buildDagFromIntent(req, PIZZA_INTENT, candidates);
    const pizzaNode = result.nodes.find((n) => n.id.endsWith("make-pizza"))!;
    const deliveryNode = result.nodes.find((n) => n.id.endsWith("deliver"))!;
    expect(deliveryNode.dependencies).toContain(pizzaNode.id);
  });

  it("falls back to placeholder cost when no match (match:none)", () => {
    const result = buildDagFromIntent(req, BRACKET_INTENT, []);
    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].matchedCapabilityId).toBeUndefined();
    // Unmatched fallback = 10 USDC × 1 quantity × 1.0 urgency
    expect(result.nodes[0].estimatedCost).toBeCloseTo(10, 2);
    expect(result.matchCount).toBe(0);
  });

  it("urgency multiplies node cost", () => {
    const rush = { ...req, urgency: "rush" as const };
    const result = buildDagFromIntent(rush, PIZZA_INTENT, candidates);
    // 18 * 1.4 = 25.2
    expect(result.totalEstimatedCost).toBeCloseTo(25.2, 1);
  });

  it("flags decompositionSource as agentic on every node", () => {
    const result = buildDagFromIntent(req, PIZZA_INTENT, candidates);
    for (const n of result.nodes) {
      expect(n.decompositionSource).toBe("agentic");
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests — full route pipeline with the stub LLM injected
// ---------------------------------------------------------------------------

describe("POST /api/requests with agentic decomposer", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetRequestsStore();
    seedTestCapabilities();
    _setLLMClientForTests(makeStubLLM(PIZZA_INTENT));
    app = await buildApp();
  });

  afterEach(async () => {
    _setLLMClientForTests(undefined);
    await app.close();
  });

  it("decomposes pizza request to matched pizza + delivery DAG", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: {
        title: "Pizza in Manhattan",
        description: "a 12-inch margherita pizza made and delivered to me in Manhattan",
        budget: 100,
        urgency: "standard",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.request).toBeDefined();
    expect(body.decomposition.source).toBe("agentic");

    const nodes = body.request.capabilityDag;
    expect(nodes.length).toBe(2);

    const pizzaNode = nodes.find(
      (n: any) => n.capabilityType === "wood-fired-pizza",
    );
    const deliveryNode = nodes.find(
      (n: any) => n.capabilityType === "local-courier-delivery",
    );
    expect(pizzaNode).toBeDefined();
    expect(deliveryNode).toBeDefined();
    expect(pizzaNode.matchedCapabilityId).toBe(PIZZA_CAP_ID);
    expect(deliveryNode.matchedCapabilityId).toBe(DELIVERY_CAP_ID);
  });

  it("derives total cost = 12 + 6 = 18 USDC (not the 1000 default)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: {
        title: "Pizza in Manhattan",
        description: "a 12-inch margherita pizza made and delivered to me in Manhattan",
        budget: 100,
        urgency: "standard",
      },
    });
    const body = res.json();
    expect(body.request.totalEstimatedCost).toBeCloseTo(18, 1);
    // Budget input (100) and totalEstimatedCost are independent — derived
    // cost should reflect MATCHED prices, not the budget cap.
    expect(body.request.totalEstimatedCost).not.toBe(1000);
  });

  it("evidenceRequirements come from matched cap tier, not hardcoded pdf_proof", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: {
        title: "Pizza in Manhattan",
        description: "a 12-inch margherita pizza made and delivered to me in Manhattan",
        budget: 100,
      },
    });
    const body = res.json();
    const nodes = body.request.capabilityDag;
    const all = nodes.flatMap((n: any) => n.evidenceRequirements);
    expect(all).not.toContain("pdf_proof");
    // Tier-1 defaults present
    expect(all.some((e: string) => e === "completion_event")).toBe(true);
  });

  it("non-pizza goal (CAD bracket) never yields a document-printing DAG", async () => {
    // Swap the stub to the CAD-bracket IntentDag for this test.
    _setLLMClientForTests(makeStubLLM(BRACKET_INTENT));
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: {
        title: "CAD file for a bracket",
        description: "build a CAD file for a mounting bracket",
        budget: 100,
      },
    });
    const body = res.json();
    const types = body.request.capabilityDag.map((n: any) => n.capabilityType);
    expect(types).not.toContain("ipp");
    expect(types).not.toContain("documentation");
    expect(types).not.toContain("logistics");
    // The only node is the CAD design node — match:none (no cad cap seeded).
    expect(types).toContain("cad");
    const cadNode = body.request.capabilityDag.find(
      (n: any) => n.capabilityType === "cad",
    );
    expect(cadNode.matchedCapabilityId).toBeUndefined();
  });

  it("falls back to template decomposer when LLM is forced off", async () => {
    _setLLMClientForTests(null); // force fallback
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: {
        title: "HPLC Purity Analysis",
        description: "HPLC analysis and characterization of compound X",
        budget: 500,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // Template decomposer produces lab_analysis nodes — sample-prep present.
    const names = body.request.capabilityDag.map((n: any) => n.name);
    expect(names.some((n: string) => n.toLowerCase().includes("sample"))).toBe(true);
    expect(body.decomposition.source).toBe("template");
  });
});

describe("POST /api/requests/:id/decompose with agentic decomposer", () => {
  let app: FastifyInstance;
  const reqPayload = {
    title: "Pizza in Manhattan",
    description: "a 12-inch margherita pizza made and delivered to me in Manhattan",
    budget: 100,
    urgency: "standard" as const,
  };

  beforeEach(async () => {
    resetRequestsStore();
    seedTestCapabilities();
    _setLLMClientForTests(makeStubLLM(PIZZA_INTENT));
    app = await buildApp();
  });

  afterEach(async () => {
    _setLLMClientForTests(undefined);
    await app.close();
  });

  it("re-decomposes via agentic path and surfaces matched DAG", async () => {
    // Create with the stub LLM
    const created = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: reqPayload,
    });
    const reqId = created.json().request.id;

    // Re-decompose explicitly
    const res = await app.inject({
      method: "POST",
      url: `/api/requests/${reqId}/decompose`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.decomposition.source).toBe("agentic");
    expect(body.decomposition.matchCount).toBe(2);
    const types = body.request.capabilityDag.map((n: any) => n.capabilityType);
    expect(types).toContain("wood-fired-pizza");
    expect(types).toContain("local-courier-delivery");
  });
});
