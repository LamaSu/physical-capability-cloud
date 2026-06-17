/**
 * Tests for POST /api/onboard/analyze (fix/driver-onboard-analyze).
 *
 * Regression target: the endpoint used to return a hardcoded FDM 3D-printer
 * analysis for ANY input (fed a rideshare description it returned build-volume
 * + nozzle temps + PLA). It now derives the capability from the actual text.
 *
 * Three layers:
 *   1. Pure unit tests on analyzeOnboardingText/heuristicAnalyze — no Fastify,
 *      no DB, no built workspace dist (the module imports @pcc/spec type-only).
 *      This is the always-green acceptance core: rideshare ⇒ not-FDM, FDM ⇒ FDM.
 *   2. Agentic path via an injected fake Anthropic client — proves the v3 LLM
 *      path surfaces input-derived output (mode: "llm"), deterministically and
 *      offline.
 *   3. Route-level integration through onboardRoutes (no API key ⇒ heuristic),
 *      asserting the HTTP contract and that the FDM-stub markers are gone.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  analyzeOnboardingText,
  heuristicAnalyze,
  coalesceAnalysisText,
  type AnalysisAnthropicClient,
} from "../routes/onboard-analysis.js";

const RIDESHARE =
  "I'm a rideshare driver in Chicago. I pick up passengers in my Honda Civic sedan and " +
  "drive them across the city — about 25 trips a day. I also do airport pickups for commuters.";

const FDM =
  "We run a fleet of Prusa MK4 FDM 3D printers. We print in PLA, PETG, and ABS filament " +
  "with a 0.4mm nozzle. Build volume is 250 x 210 x 210 mm and we tune layer height per job.";

// ---------------------------------------------------------------------------
// 1. Pure unit — deterministic heuristic (no API key, no app, no dist).
// ---------------------------------------------------------------------------

describe("heuristicAnalyze — derives capability from input text", () => {
  it("classifies a rideshare description as transport, NOT FDM", () => {
    const result = heuristicAnalyze(RIDESHARE, "doc-1");
    const cap = result.suggestedCapabilities[0];
    expect(cap).toBeDefined();
    expect(cap.type).not.toBe("fdm");
    expect(cap.type).toBe("rideshare");
    // The old stub leaked FDM markers — they must be gone for non-FDM input.
    expect(result.extractedMaterials).not.toContain("PLA");
    expect(result.extractedSpecs["build-volume"]).toBeUndefined();
    expect(JSON.stringify(result).toLowerCase()).not.toContain("nozzle");
  });

  it("classifies an FDM description as fdm", () => {
    const result = heuristicAnalyze(FDM, "doc-2");
    const cap = result.suggestedCapabilities[0];
    expect(cap.type).toBe("fdm");
    expect(result.extractedMaterials).toContain("PLA");
  });

  it("distinguishes CNC, laser, and HPLC descriptions", () => {
    expect(
      heuristicAnalyze("We do 5-axis CNC milling of aluminum on a Haas.", "d").suggestedCapabilities[0].type,
    ).toBe("cnc-3axis");
    expect(
      heuristicAnalyze("CO2 laser cutter for acrylic and plywood sheet.", "d").suggestedCapabilities[0].type,
    ).toBe("laser-cut");
    expect(
      heuristicAnalyze("HPLC chromatography lab, we run analytes against a mobile phase.", "d")
        .suggestedCapabilities[0].type,
    ).toBe("hplc");
  });

  it("falls back to 'custom' for an unclassifiable description", () => {
    const result = heuristicAnalyze("We offer artisanal cheese tasting experiences.", "d");
    expect(result.suggestedCapabilities[0].type).toBe("custom");
  });
});

// ---------------------------------------------------------------------------
// 2. analyzeOnboardingText — no client ⇒ heuristic; injected client ⇒ agentic.
// ---------------------------------------------------------------------------

describe("analyzeOnboardingText — path selection", () => {
  it("uses the heuristic when no client/key is available", async () => {
    const { analysis, mode } = await analyzeOnboardingText(RIDESHARE, { client: null });
    expect(mode).toBe("heuristic");
    expect(analysis.suggestedCapabilities[0].type).not.toBe("fdm");
  });

  it("routes through the agentic LLM path and surfaces input-derived output", async () => {
    // Fake client that classifies from the actual message text (proves the
    // input reaches the model and the result reflects it — not a fixed stub).
    const fakeClient: AnalysisAnthropicClient = {
      messages: {
        create: async (args) => {
          const userText = JSON.stringify(args.messages).toLowerCase();
          const isRide = userText.includes("rideshare") || userText.includes("passenger");
          const input = isRide
            ? {
                suggestedCapabilities: [
                  {
                    type: "rideshare",
                    name: "Rideshare Driver",
                    description: "Passenger transport",
                    materials: [],
                    confidence: 0.88,
                    sourceReason: "Operator describes driving passengers",
                  },
                ],
                extractedSpecs: { service: "passenger transport" },
                extractedMaterials: [],
                extractedTolerances: [],
                confidence: 0.88,
              }
            : {
                suggestedCapabilities: [
                  {
                    type: "fdm",
                    name: "FDM Printing",
                    description: "Filament 3D printing",
                    materials: ["PLA", "PETG"],
                    confidence: 0.9,
                    sourceReason: "Operator describes FDM printers",
                  },
                ],
                extractedSpecs: { process: "FDM" },
                extractedMaterials: ["PLA", "PETG"],
                extractedTolerances: [],
                confidence: 0.9,
              };
          return {
            content: [{ type: "tool_use", id: "tool_1", name: "record_capability_analysis", input }],
            stop_reason: "tool_use",
          };
        },
      },
    };

    const ride = await analyzeOnboardingText(RIDESHARE, { client: fakeClient });
    expect(ride.mode).toBe("llm");
    expect(ride.analysis.suggestedCapabilities[0].type).toBe("rideshare");
    expect(ride.analysis.suggestedCapabilities[0].id).toBeTruthy(); // normalizer stamps an id
    expect(ride.analysis.suggestedCapabilities[0].suggestedParams).toEqual([]);

    const fdm = await analyzeOnboardingText(FDM, { client: fakeClient });
    expect(fdm.mode).toBe("llm");
    expect(fdm.analysis.suggestedCapabilities[0].type).toBe("fdm");
    expect(fdm.analysis.extractedMaterials).toContain("PLA");
  });

  it("falls back to the heuristic (never throws) when the LLM call fails", async () => {
    const throwingClient: AnalysisAnthropicClient = {
      messages: {
        create: async () => {
          throw new Error("boom: upstream 529");
        },
      },
    };
    const { analysis, mode, warning } = await analyzeOnboardingText(FDM, { client: throwingClient });
    expect(mode).toBe("heuristic");
    expect(analysis.suggestedCapabilities[0].type).toBe("fdm"); // heuristic still right
    expect(warning).toMatch(/LLM analysis failed/i);
  });
});

describe("coalesceAnalysisText", () => {
  it("pulls text from common field names and document shapes", () => {
    expect(coalesceAnalysisText({ text: "hi" })).toBe("hi");
    expect(coalesceAnalysisText({ description: "  desc  " })).toBe("desc");
    expect(coalesceAnalysisText({ document: { content: "doc body" } })).toBe("doc body");
    expect(coalesceAnalysisText({ documents: [{ text: "a" }, { text: "b" }] })).toBe("a\nb");
    expect(coalesceAnalysisText("raw string")).toBe("raw string");
    expect(coalesceAnalysisText({})).toBe("");
    expect(coalesceAnalysisText(null)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 3. Route integration — POST /api/onboard/analyze (no key ⇒ heuristic path).
// ---------------------------------------------------------------------------

vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));

vi.mock("../services/audit-service.js", () => ({
  auditService: {
    log: vi.fn(),
    query: vi.fn().mockReturnValue([]),
    stats: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: {
    emit: vi.fn(),
    getTimeline: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({}),
  },
}));

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  // onboardRoutes' /analyze handler does not touch the DB, but other handlers
  // in the plugin do — initialize the store so registration is side-effect free.
  const { initStore } = await import("../db.js");
  initStore({ seed: true });
  const { onboardRoutes } = await import("../routes/onboard.js");

  const app = Fastify({ logger: false });
  await app.register(onboardRoutes);
  await app.ready();
  return app;
}

describe("POST /api/onboard/analyze — route contract", () => {
  let app: FastifyInstance;
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    // Force the deterministic path so CI needs no secret (mirrors onboard-chat tests).
    delete process.env.ANTHROPIC_API_KEY;
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    const { closeStore } = await import("../db.js");
    closeStore();
    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  it("returns a rideshare-shaped analysis for a rideshare description (not FDM)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/analyze",
      payload: { text: RIDESHARE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.mode).toBe("heuristic");
    const cap = body.analysis.suggestedCapabilities[0];
    expect(cap.type).not.toBe("fdm");
    expect(cap.type).toBe("rideshare");
    // The defining symptom of the old stub: FDM markers for non-FDM input.
    expect(body.analysis.extractedMaterials).not.toContain("PLA");
    expect(JSON.stringify(body.analysis).toLowerCase()).not.toContain("nozzle");
  });

  it("still returns FDM for an FDM description", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/analyze",
      payload: { description: FDM },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.analysis.suggestedCapabilities[0].type).toBe("fdm");
    expect(body.analysis.extractedMaterials).toContain("PLA");
  });

  it("rejects a request with no analyzable text", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/analyze",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("text_required");
  });
});
