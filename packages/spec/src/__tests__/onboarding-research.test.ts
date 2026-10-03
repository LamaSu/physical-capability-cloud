import { describe, it, expect } from "vitest";

import {
  RESEARCH_LIBRARY,
  RESEARCH_PLACEHOLDERS,
  ResearchLibraryEntrySchema,
  ResearchCitationSchema,
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

describe("research findings may carry a range value for R8 (#4254)", () => {
  it("accepts {min?, max?} with at least one side and min <= max", async () => {
    const { ResearchFindingSchema } = await import("../onboarding/research/index.js");
    const base = {
      quantity: "volume",
      claim: "aspirate volume range",
      unit: "uL",
      citation: { doc: "OT-2 P1000 GEN2 spec sheet", section: "Volume range" },
      retrievedAt: "2026-09-29T20:00:00Z",
    };
    expect(ResearchFindingSchema.safeParse({ ...base, value: { min: 100, max: 1000 } }).success).toBe(true);
    expect(ResearchFindingSchema.safeParse({ ...base, value: { max: 1000 } }).success).toBe(true);
    expect(ResearchFindingSchema.safeParse({ ...base, value: {} }).success).toBe(false);
    expect(ResearchFindingSchema.safeParse({ ...base, value: { min: 10, max: 1 } }).success).toBe(false);
    expect(ResearchFindingSchema.safeParse({ ...base, value: { min: 1, max: 2, extra: 3 } }).success).toBe(false);
  });
});

// ── 9. Citations must be meaningful (astra 120b, finding 8) ──────────────

describe("ResearchCitationSchema — a citation must say something checkable", () => {
  const base = { doc: "Prusa MK4S manual", section: "5.2" };

  it("refuses a blank doc or section, however the blankness is spelled, and never transforms the value", () => {
    const blanks = ["", " ", "   ", "\t", "\n", " \t\r\n ", String.fromCharCode(0xa0), String.fromCharCode(0x2003, 0xfeff)];
    for (const blank of blanks) {
      expect(ResearchCitationSchema.safeParse({ ...base, doc: blank }).success, JSON.stringify(blank)).toBe(false);
      expect(ResearchCitationSchema.safeParse({ ...base, section: blank }).success, JSON.stringify(blank)).toBe(false);
    }
    // refused, not trimmed: a non-blank value comes back exactly as given
    const padded = ResearchCitationSchema.parse({ doc: "  Prusa manual  ", section: " 5.2 " });
    expect(padded).toEqual({ doc: "  Prusa manual  ", section: " 5.2 " });
  });

  it("url, when present, must be https without credentials", () => {
    for (const ok of ["https://example.com/manual.pdf", "HTTPS://Example.com/x", "https://example.com:8443/a?b=c#d"]) {
      expect(ResearchCitationSchema.safeParse({ ...base, url: ok }).success, ok).toBe(true);
    }
    for (const bad of [
      "http://example.com/manual.pdf",
      "ftp://example.com/manual.pdf",
      "javascript:alert(1)",
      "data:text/plain;base64,AAAA",
      "file:///etc/passwd",
      "blob:https://example.com/x",
      "//example.com/manual.pdf",
      "example.com/manual.pdf",
      "not a url",
      "",
      "https://",
      "https://user:secret@example.com/manual.pdf",
      "https://user@example.com/manual.pdf",
    ]) {
      expect(ResearchCitationSchema.safeParse({ ...base, url: bad }).success, bad).toBe(false);
    }
    expect(ResearchCitationSchema.safeParse(base).success).toBe(true); // url stays optional
  });

  it("contentHash is optional and, when present, sha256: followed by 64 lowercase hex digits", () => {
    const hash = `sha256:${"ab12".repeat(16)}`;
    expect(ResearchCitationSchema.safeParse({ ...base, contentHash: hash }).success).toBe(true);
    for (const bad of [
      "",
      "ab12".repeat(16),
      `sha256:${"ab12".repeat(15)}ab1`,
      `sha256:${"ab12".repeat(16)}0`,
      `sha256:${"AB12".repeat(16)}`,
      `sha1:${"ab12".repeat(16)}`,
      `sha256: ${"ab12".repeat(16)}`,
      `sha256:${"zz".repeat(32)}`,
    ]) {
      expect(ResearchCitationSchema.safeParse({ ...base, contentHash: bad }).success, bad).toBe(false);
    }
  });

  it("is still strict", () => {
    expect(ResearchCitationSchema.safeParse({ ...base, hash: "x" }).success).toBe(false);
  });

  it("a whole finding carries the hash through, and a blank citation still sinks the finding", () => {
    const finding = {
      claim: "max bed temperature",
      value: 120,
      unit: "C",
      citation: { ...base, url: "https://example.com/manual.pdf", contentHash: `sha256:${"cd34".repeat(16)}` },
      retrievedAt: "2026-09-29T16:40:00Z",
    };
    expect(ResearchFindingSchema.parse(finding).citation.contentHash).toBe(`sha256:${"cd34".repeat(16)}`);
    expect(ResearchFindingSchema.safeParse({ ...finding, citation: { doc: " ", section: " " } }).success).toBe(false);
  });
});

// ── 10. The no-execution policy (astra 120b, finding 8) ──────────────────

describe("entryInstructsExecution — a closed policy over all instruction-bearing text", () => {
  const base = RESEARCH_LIBRARY[0]!;
  const withPrompt = (prompt: string): ResearchLibraryEntry => ({ ...base, prompt });

  it("no shipped entry trips it, in any of its text", () => {
    for (const entry of RESEARCH_LIBRARY) expect(entryInstructsExecution(entry), entry.id).toBe(false);
    expect(validateResearchLibrary().installOrExecuteInstructions).toEqual([]);
  });

  it("flags each verb of the closed set, case-insensitively", () => {
    const instructions = [
      "Install the vendor driver",
      "Execute the vendor tool",
      "Run the downloaded driver",
      "Launch the configuration utility",
      "Start the service on the device",
      "Flash the new firmware",
      "Upload the program to the controller",
      "Download and run the installer",
      "Send a command to the printer",
      "Send the command M115",
      "Send this command twice",
      "Send command M503",
      "Connect to the device over serial",
      "SSH into the controller",
      "Open a telnet session",
      "Prefix it with sudo",
      "pip install pylabrobot",
      "npm install serialport",
      "apt install libusb",
      "curl the status endpoint",
      "wget the firmware",
      "Power-cycle the printer",
      "Power cycle the printer",
      "Actuate the valve",
    ];
    for (const text of instructions) {
      expect(entryInstructsExecution(withPrompt(text)), text).toBe(true);
      expect(entryInstructsExecution(withPrompt(text.toUpperCase())), text.toUpperCase()).toBe(true);
    }
  });

  it("is word-boundaried: it does not match inside other words", () => {
    for (const text of [
      "Find the runtime options",
      "Quote the sshd documentation",
      "Find the Prusa curler",
      "Quote the launchpad guide",
      "Quote the overrun limit from the datasheet",
      "Find the preinstall checklist",
    ]) {
      expect(entryInstructsExecution(withPrompt(text)), text).toBe(false);
    }
  });

  it("is excused only by a negation EARLIER in the SAME clause", () => {
    for (const ok of [
      "Do not install or run any code.",
      "Don't run anything.",
      "Do not install anything and never execute it.",
      "You must not flash anything.",
      "You should not connect to the device.",
      "Avoid install or run steps; just read the manual.",
      "Find the driver without install or run steps.",
      "Never upload anything.",
      "Don’t actuate the valve.",
    ]) {
      expect(entryInstructsExecution(withPrompt(ok)), ok).toBe(false);
    }
    for (const bad of [
      "Run it, but do not install it.", // the verb comes BEFORE the negation
      "Do not install A. Execute B.", // the negation is in another clause
      "Do not install anything; run the tool.",
      "Do not install, then run it.", // " then " starts a new clause
      "Never mind. Run the tool!",
      "Do not install\nRun the tool",
    ]) {
      expect(entryInstructsExecution(withPrompt(bad)), bad).toBe(true);
    }
  });

  it("verb-local negation scope: a negation excuses only its own verb and directly-coordinated verbs (astra pack 120c, MEDIUM 8)", () => {
    // Once a negated verb has taken an object, a verb coordinated with it by
    // "and" (not "or"/"," alone) starts a new, un-negated predicate.
    expect(entryInstructsExecution(withPrompt("Do not install A and execute B."))).toBe(true);
    // Plain "or"/", "-coordination with no object in between stays excused.
    expect(entryInstructsExecution(withPrompt("Do not install or run any code."))).toBe(false);
    // A second, later negation re-opens the scope for its own verb.
    expect(entryInstructsExecution(withPrompt("Do not install A, and do not run B."))).toBe(false);
    // Pure coordination under one negation, no object between the verbs.
    expect(entryInstructsExecution(withPrompt("Never install, run, or flash firmware."))).toBe(false);
    // A clean, un-negated instruction in an earlier sentence is still caught,
    // whatever a later sentence says.
    expect(entryInstructsExecution(withPrompt("Install X. Do not run Y."))).toBe(true);
  });

  it("looks at every instruction-bearing member, not just the prompt", () => {
    const run = "Run the downloaded driver.";
    const cases: [string, ResearchLibraryEntry][] = [
      ["goal", { ...base, goal: run }],
      ["prompt", { ...base, prompt: run }],
      ["a search", { ...base, searches: [...base.searches, "then flash firmware to the device"] }],
      ["coaching.ask", { ...base, coaching: { ...base.coaching, ask: run } }],
      ["coaching.why", { ...base, coaching: { ...base.coaching, why: run } }],
      ["mustReturn", { ...base, mustReturn: [...base.mustReturn, "sudo apt install driver"] }],
      ["acceptance", { ...base, acceptance: run }],
    ];
    for (const [where, entry] of cases) expect(entryInstructsExecution(entry), where).toBe(true);
    for (const [where, entry] of cases) {
      const report = validateResearchLibrary([{ ...entry, id: `mutant-${where.toLowerCase().replace(/\W+/g, "-")}` }]);
      expect(report.installOrExecuteInstructions, where).toHaveLength(1);
      expect(report.ok, where).toBe(false);
    }
  });

  it("tolerates a partial entry (only some members present) without throwing", () => {
    expect(entryInstructsExecution({ prompt: "Run it." } as ResearchLibraryEntry)).toBe(true);
    expect(entryInstructsExecution({} as ResearchLibraryEntry)).toBe(false);
    expect(entryInstructsExecution({ prompt: 5, searches: [null, 7] } as unknown as ResearchLibraryEntry)).toBe(false);
  });
});
