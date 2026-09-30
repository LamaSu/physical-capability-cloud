import { describe, it, expect } from "vitest";

import {
  RESEARCH_LIBRARY,
  RESEARCH_PLACEHOLDERS,
  ResearchLibraryEntrySchema,
  ResearchFindingSchema,
  extractPlaceholders,
  entryInstructsExecution,
  validateResearchLibrary,
  type ResearchLibraryEntry,
} from "../onboarding/research/index.js";
import { INTAKE_FIELD_IDS } from "../onboarding/intake/index.js";

function flattenTriggers(entry: ResearchLibraryEntry): string[] {
  return Array.isArray(entry.trigger) ? entry.trigger : [entry.trigger];
}

// ── 1. Every entry has all required keys ─────────────────────────────────

describe("RESEARCH_LIBRARY — every entry has all required keys", () => {
  it("ships the ~10 initial entries", () => {
    expect(RESEARCH_LIBRARY.length).toBeGreaterThanOrEqual(10);
  });

  it.each(RESEARCH_LIBRARY.map((e) => [e.id, e] as const))("%s conforms to ResearchLibraryEntrySchema", (_id, entry) => {
    const result = ResearchLibraryEntrySchema.safeParse(entry);
    if (!result.success) {
      // eslint-disable-next-line no-console
      console.error(result.error.issues);
    }
    expect(result.success).toBe(true);
  });

  it("every entry has 2-5 searches", () => {
    for (const entry of RESEARCH_LIBRARY) {
      expect(entry.searches.length).toBeGreaterThanOrEqual(2);
      expect(entry.searches.length).toBeLessThanOrEqual(5);
    }
  });
});

// ── 2. ids and triggers are unique ───────────────────────────────────────

describe("RESEARCH_LIBRARY — ids and triggers are unique", () => {
  it("every id is unique", () => {
    const ids = RESEARCH_LIBRARY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every (flattened) trigger fires exactly one entry", () => {
    const triggers = RESEARCH_LIBRARY.flatMap(flattenTriggers);
    expect(new Set(triggers).size).toBe(triggers.length);
  });

  it("identify-make-model fires on both no_candidate and low_confidence", () => {
    const entry = RESEARCH_LIBRARY.find((e) => e.id === "identify-make-model");
    expect(entry).toBeDefined();
    expect(flattenTriggers(entry!)).toEqual(
      expect.arrayContaining(["identify.no_candidate", "identify.low_confidence"]),
    );
  });
});

// ── 3. Every placeholder is in the closed set ────────────────────────────

describe("RESEARCH_LIBRARY — placeholders are a closed set", () => {
  it("extractPlaceholders finds {word} templates", () => {
    expect(extractPlaceholders("find {vendor} {model} manual")).toEqual(["vendor", "model"]);
    expect(extractPlaceholders("no placeholders here")).toEqual([]);
    expect(extractPlaceholders("{vendor} {vendor} repeated")).toEqual(["vendor"]);
  });

  it("every placeholder used in every prompt/searches is in RESEARCH_PLACEHOLDERS", () => {
    const placeholderSet = new Set<string>(RESEARCH_PLACEHOLDERS);
    for (const entry of RESEARCH_LIBRARY) {
      for (const text of [entry.prompt, ...entry.searches]) {
        for (const placeholder of extractPlaceholders(text)) {
          expect(placeholderSet.has(placeholder), `${entry.id}: unknown placeholder {${placeholder}}`).toBe(true);
        }
      }
    }
  });

  it("rejects an entry using a placeholder outside the closed set (mutation check)", () => {
    const mutant: ResearchLibraryEntry = {
      ...RESEARCH_LIBRARY[0]!,
      id: "mutant-entry",
      prompt: "Find the {serialNumber} of this device.",
    };
    const report = validateResearchLibrary([mutant]);
    expect(report.ok).toBe(false);
    expect(report.invalidPlaceholders).toContainEqual({ id: "mutant-entry", placeholder: "serialNumber" });
  });
});

// ── 4. humanConfirmRequired on safety/IO/money entries ───────────────────

describe("RESEARCH_LIBRARY — humanConfirmRequired on safety/IO/money entries", () => {
  it("find-io-ranges and find-safety-limits require human confirmation", () => {
    const ioEntry = RESEARCH_LIBRARY.find((e) => e.id === "find-io-ranges");
    const safetyEntry = RESEARCH_LIBRARY.find((e) => e.id === "find-safety-limits");
    expect(ioEntry?.humanConfirmRequired).toBe(true);
    expect(safetyEntry?.humanConfirmRequired).toBe(true);
  });

  it("validateResearchLibrary reports no missing human-confirm entries", () => {
    const report = validateResearchLibrary();
    expect(report.missingHumanConfirm).toEqual([]);
  });

  it("flags an entry that touches safety but doesn't require human confirmation (mutation check)", () => {
    const mutant: ResearchLibraryEntry = {
      ...RESEARCH_LIBRARY.find((e) => e.id === "find-safety-limits")!,
      id: "mutant-unsafe-entry",
      humanConfirmRequired: false,
    };
    const report = validateResearchLibrary([mutant]);
    expect(report.ok).toBe(false);
    expect(report.missingHumanConfirm).toContain("mutant-unsafe-entry");
  });
});

// ── 5. No entry instructs installing or executing found code ────────────

describe("RESEARCH_LIBRARY — never instructs installing or executing found code", () => {
  it("entryInstructsExecution distinguishes an instruction from a prohibition", () => {
    expect(entryInstructsExecution({ prompt: "Install the driver and run it." } as ResearchLibraryEntry)).toBe(true);
    expect(
      entryInstructsExecution({ prompt: "Do not install or run any code." } as ResearchLibraryEntry),
    ).toBe(false);
    expect(entryInstructsExecution({ prompt: "Find the manual and quote it." } as ResearchLibraryEntry)).toBe(false);
  });

  it("no shipped entry instructs installing or executing code", () => {
    for (const entry of RESEARCH_LIBRARY) {
      expect(entryInstructsExecution(entry), `${entry.id} instructs execution`).toBe(false);
    }
  });

  it("find-open-scaffold explicitly prohibits installing or running found drivers", () => {
    const entry = RESEARCH_LIBRARY.find((e) => e.id === "find-open-scaffold");
    expect(entry?.prompt.toLowerCase()).toMatch(/do not install or run/);
  });
});

// ── 6. Every `fills` target exists in INTAKE_FIELDS ──────────────────────

describe("RESEARCH_LIBRARY — every fills target exists in INTAKE_FIELDS", () => {
  it("every entry's fills resolve to a real intake field id", () => {
    const fieldIdSet = new Set(INTAKE_FIELD_IDS);
    for (const entry of RESEARCH_LIBRARY) {
      for (const fieldId of entry.fills) {
        expect(fieldIdSet.has(fieldId), `${entry.id} fills unknown field "${fieldId}"`).toBe(true);
      }
    }
  });

  it("flags an entry that fills an unknown field id (mutation check)", () => {
    const mutant: ResearchLibraryEntry = {
      ...RESEARCH_LIBRARY[0]!,
      id: "mutant-fills-entry",
      fills: ["not.a.real.field"],
    };
    const report = validateResearchLibrary([mutant]);
    expect(report.ok).toBe(false);
    expect(report.unknownFills).toContainEqual({ id: "mutant-fills-entry", fieldId: "not.a.real.field" });
  });
});

// ── 7. The library, as shipped, is fully valid ───────────────────────────

describe("validateResearchLibrary — the shipped library", () => {
  it("is ok with no findings in any category", () => {
    const report = validateResearchLibrary();
    expect(report).toEqual({
      ok: true,
      schemaErrors: [],
      duplicateIds: [],
      duplicateTriggers: [],
      invalidPlaceholders: [],
      missingHumanConfirm: [],
      installOrExecuteInstructions: [],
      unknownFills: [],
    });
  });

  it("catches a duplicated id across two entries", () => {
    const report = validateResearchLibrary([RESEARCH_LIBRARY[0]!, { ...RESEARCH_LIBRARY[1]!, id: RESEARCH_LIBRARY[0]!.id }]);
    expect(report.ok).toBe(false);
    expect(report.duplicateIds).toContain(RESEARCH_LIBRARY[0]!.id);
  });

  it("catches a duplicated trigger across two entries", () => {
    const report = validateResearchLibrary([
      RESEARCH_LIBRARY[0]!,
      { ...RESEARCH_LIBRARY[1]!, id: "dup-trigger-entry", trigger: RESEARCH_LIBRARY[0]!.trigger },
    ]);
    expect(report.ok).toBe(false);
  });
});

// ── 8. ResearchFindingSchema — a value without a citation is never valid ─

describe("ResearchFindingSchema — a value without a citation can never become a limit", () => {
  const validFinding = {
    claim: "max bed temperature",
    value: 120,
    unit: "C",
    citation: { doc: "Prusa MK4S manual", section: "5.2", url: "https://example.com/manual.pdf" },
    retrievedAt: "2026-09-29T16:40:00Z",
  };

  it("accepts a well-formed finding", () => {
    expect(ResearchFindingSchema.safeParse(validFinding).success).toBe(true);
  });

  it("rejects a finding with no citation at all", () => {
    const { citation: _citation, ...withoutCitation } = validFinding;
    expect(ResearchFindingSchema.safeParse(withoutCitation).success).toBe(false);
  });

  it("rejects a citation missing doc or section", () => {
    expect(
      ResearchFindingSchema.safeParse({ ...validFinding, citation: { section: "5.2" } }).success,
    ).toBe(false);
    expect(
      ResearchFindingSchema.safeParse({ ...validFinding, citation: { doc: "manual" } }).success,
    ).toBe(false);
  });

  it("rejects a finding missing retrievedAt", () => {
    const { retrievedAt: _retrievedAt, ...withoutRetrievedAt } = validFinding;
    expect(ResearchFindingSchema.safeParse(withoutRetrievedAt).success).toBe(false);
  });
});

describe("research findings carry the template quantity for R8 (#4200)", () => {
  it("accepts an optional quantity and still refuses a value without a citation", async () => {
    const { ResearchFindingSchema } = await import("../onboarding/research/index.js");
    const base = {
      claim: "max aspirate volume",
      value: 1000,
      unit: "uL",
      citation: { doc: "OT-2 P1000 GEN2 spec sheet", section: "Volume range" },
      retrievedAt: "2026-09-29T20:00:00Z",
    };
    expect(ResearchFindingSchema.safeParse({ ...base, quantity: "volume" }).success).toBe(true);
    expect(ResearchFindingSchema.safeParse(base).success).toBe(true);
    const { citation: _drop, ...uncited } = base;
    expect(ResearchFindingSchema.safeParse({ ...uncited, quantity: "volume" }).success).toBe(false);
  });

  it("find-safety-limits feeds the e-stop field too", async () => {
    const { RESEARCH_LIBRARY } = await import("../onboarding/research/index.js");
    const entry = RESEARCH_LIBRARY.find((e: { id: string }) => e.id === "find-safety-limits")!;
    expect(entry.fills).toContain("safety.estop");
  });
});
