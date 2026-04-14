/**
 * Tests for TemplateSuggestionService.
 *
 * Uses in-memory SQLite via initStore({ seed: false }).
 * Templates are inserted directly via getRepos().templateStore using
 * field names that match the actual drizzle schema in
 * packages/db/src/schema/templates.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initStore, closeStore, getRepos } from "../db.js";
import { TemplateSuggestionService } from "../services/template-suggestion-service.js";

// ── Setup/Teardown ────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.PCC_DB_PATH = ":memory:";
  closeStore();
  initStore({ seed: false });
});

afterEach(() => {
  closeStore();
  delete process.env.PCC_DB_PATH;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function insertCapabilityTemplate(overrides: Record<string, unknown> = {}) {
  const repos = getRepos();
  return repos.templateStore.insertCapabilityTemplate({
    id: `cap-tmpl-${Math.random().toString(36).slice(2)}`,
    name: "FDM 3D Printing Template",
    capabilityType: "3d-printing",
    description: "Standard FDM template",
    status: "active",
    version: "1.0",
    usageCount: 0,
    forkCount: 0,
    rating: null,
    ratingCount: 0,
    templateData: {},
    authorId: null,
    tags: null,
    forkedFrom: null,
    isVerified: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
}

function insertMachineProfile(overrides: Record<string, unknown> = {}) {
  const repos = getRepos();
  return repos.templateStore.insertMachineProfile({
    id: `mach-prof-${Math.random().toString(36).slice(2)}`,
    machineName: "Prusa MK4",
    capabilityType: "3d-printing",
    profileData: { adapterType: "octoprint" },
    kernelId: null,
    authorId: null,
    status: "active",
    tags: null,
    usageCount: 0,
    rating: null,
    ratingCount: 0,
    isVerified: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TemplateSuggestionService", () => {
  // ── suggest() — empty DB ──────────────────────────────────────────────────

  describe("suggest() — empty database", () => {
    it("returns an empty array when no templates exist and capabilityType given", () => {
      const svc = new TemplateSuggestionService();
      const results = svc.suggest({ capabilityType: "3d-printing" });
      expect(results).toEqual([]);
    });

    it("returns an empty array when no templates exist and machineModel given", () => {
      const svc = new TemplateSuggestionService();
      const results = svc.suggest({ machineModel: "Prusa MK4" });
      expect(results).toEqual([]);
    });

    it("returns an empty array when called with no options", () => {
      const svc = new TemplateSuggestionService();
      const results = svc.suggest({});
      expect(results).toEqual([]);
    });
  });

  // ── suggest() — capability templates ─────────────────────────────────────

  describe("suggest() — capability template matching", () => {
    it("returns a capability suggestion when an active template matches capabilityType", () => {
      insertCapabilityTemplate({ capabilityType: "3d-printing", status: "active" });
      const svc = new TemplateSuggestionService();
      const results = svc.suggest({ capabilityType: "3d-printing" });
      expect(results.length).toBeGreaterThan(0);
      const capSuggestion = results.find((r) => r.type === "capability");
      expect(capSuggestion).toBeDefined();
    });

    it("each capability suggestion has the required shape", () => {
      insertCapabilityTemplate({ capabilityType: "cnc", name: "CNC Mill Template", status: "active" });
      const svc = new TemplateSuggestionService();
      const results = svc.suggest({ capabilityType: "cnc" });
      const suggestion = results[0];
      expect(suggestion).toMatchObject({
        type: "capability",
        templateId: expect.any(String),
        name: expect.any(String),
        matchReason: expect.any(String),
        confidence: expect.any(Number),
      });
    });

    it("confidence is between 0 and 1", () => {
      insertCapabilityTemplate({ capabilityType: "laser-cutting", status: "active" });
      const svc = new TemplateSuggestionService();
      const results = svc.suggest({ capabilityType: "laser-cutting" });
      for (const s of results) {
        expect(s.confidence).toBeGreaterThanOrEqual(0);
        expect(s.confidence).toBeLessThanOrEqual(1);
      }
    });

    it("drafts are returned as fallback when no active templates match", () => {
      insertCapabilityTemplate({ capabilityType: "hplc", status: "draft" });
      const svc = new TemplateSuggestionService();
      const results = svc.suggest({ capabilityType: "hplc" });
      // draft fallback path: confidence is 0.6
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].confidence).toBe(0.6);
    });

    it("returns at most 3 capability suggestions even with many active templates", () => {
      for (let i = 0; i < 5; i++) {
        insertCapabilityTemplate({
          capabilityType: "3d-printing",
          name: `Template ${i}`,
          status: "active",
          usageCount: i,
          rating: 4,
        });
      }
      const svc = new TemplateSuggestionService();
      const results = svc.suggest({ capabilityType: "3d-printing" });
      const capSuggestions = results.filter((r) => r.type === "capability");
      expect(capSuggestions.length).toBeLessThanOrEqual(3);
    });
  });

  // ── suggest() — machine profile matching ─────────────────────────────────

  describe("suggest() — machine profile matching", () => {
    it("returns a machine suggestion when machineModel matches profile name exactly", () => {
      insertMachineProfile({ machineName: "Prusa MK4", capabilityType: "3d-printing" });
      const svc = new TemplateSuggestionService();
      const results = svc.suggest({ machineModel: "Prusa MK4" });
      const machineSuggestion = results.find((r) => r.type === "machine");
      expect(machineSuggestion).toBeDefined();
    });

    it("fuzzy matches partial machine name (word-level)", () => {
      insertMachineProfile({ machineName: "Prusa MK4", capabilityType: "3d-printing" });
      const svc = new TemplateSuggestionService();
      // "Prusa" is one word of "Prusa MK4"
      const results = svc.suggest({ machineModel: "Prusa" });
      const machineSuggestion = results.find((r) => r.type === "machine");
      expect(machineSuggestion).toBeDefined();
    });

    it("does not return machine suggestion when model has no word overlap with any profile", () => {
      insertMachineProfile({ machineName: "Prusa MK4", capabilityType: "3d-printing" });
      const svc = new TemplateSuggestionService();
      const results = svc.suggest({ machineModel: "Bambu X1" });
      const machineSuggestion = results.find((r) => r.type === "machine");
      expect(machineSuggestion).toBeUndefined();
    });

    it("machine suggestion has confidence between 0 and 1", () => {
      insertMachineProfile({ machineName: "Prusa MK4", capabilityType: "3d-printing" });
      const svc = new TemplateSuggestionService();
      const results = svc.suggest({ machineModel: "Prusa MK4" });
      for (const s of results) {
        expect(s.confidence).toBeGreaterThanOrEqual(0);
        expect(s.confidence).toBeLessThanOrEqual(1);
      }
    });
  });

  // ── suggest() — sorted by confidence ─────────────────────────────────────

  describe("suggest() — sorted by confidence descending", () => {
    it("returns results in descending confidence order when multiple types match", () => {
      insertCapabilityTemplate({ capabilityType: "3d-printing", status: "active", rating: 5, usageCount: 100 });
      insertMachineProfile({ machineName: "Prusa MK4", capabilityType: "3d-printing" });
      const svc = new TemplateSuggestionService();
      const results = svc.suggest({ capabilityType: "3d-printing", machineModel: "Prusa MK4" });
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].confidence).toBeGreaterThanOrEqual(results[i].confidence);
      }
    });
  });

  // ── suggest() — handles missing optional fields ────────────────────────────

  describe("suggest() — handles missing optional fields gracefully", () => {
    it("does not throw when capabilityType is undefined", () => {
      expect(() => new TemplateSuggestionService().suggest({ machineModel: "Prusa MK4" })).not.toThrow();
    });

    it("does not throw when machineModel is undefined", () => {
      expect(() => new TemplateSuggestionService().suggest({ capabilityType: "3d-printing" })).not.toThrow();
    });

    it("does not throw when all options are undefined", () => {
      expect(() => new TemplateSuggestionService().suggest({})).not.toThrow();
    });
  });
});
