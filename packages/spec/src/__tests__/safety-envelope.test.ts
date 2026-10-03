import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  DEVICE_CLASS_TEMPLATES,
  EnvelopeRefused,
  SAFETY_ENVELOPE_DOMAIN,
  compileSafetyEnvelope,
  computeSafetyEnvelopeDigest,
  confirmSafetyEnvelope,
  draftSafetyEnvelope,
} from "../onboarding/safety-envelope.js";
import type {
  CommandMapV1,
  ConfirmedSafetyEnvelope,
  EnvelopeDecision,
  EStopDeclaration,
  Hazard,
  IntakeLimit,
  ReferenceFinding,
  SafetyEnvelopeBody,
  SafetyEnvelopeInput,
  Supervision,
} from "../onboarding/safety-envelope.js";
import { KNOWN_UNITS, ParameterDefinitionSchema, PortTypeSchema } from "../csd/composition.js";
import { CsdEvidenceTierSchema, CsdParameterSchema } from "../csd/schema.js";
import { canonicalize } from "../util/canonical.js";

// ── Fixtures ────────────────────────────────────────────────────────

/** A full command map per template: one declared command per quantity, plus a declared "stop". */
const COMMAND_MAPS: Record<string, CommandMapV1> = {
  "lab-plate-reader": {
    commands: [
      { name: "setIncubation", params: [{ name: "celsius", quantity: "incubation_temperature", unit: "degC" }] },
      {
        name: "read",
        params: [
          { name: "seconds", quantity: "read_duration", unit: "s" },
          { name: "wavelengthNm", unbounded: "an optical setting, not a safety quantity" },
        ],
      },
      { name: "runProtocol", params: [{ name: "minutes", quantity: "job_duration", unit: "min" }] },
      { name: "stop", params: [] },
    ],
  },
  "liquid-handler-ot2": {
    commands: [
      { name: "aspirate", params: [{ name: "volumeUl", quantity: "aspirate_volume", unit: "uL" }] },
      { name: "dispense", params: [{ name: "volumeUl", quantity: "dispense_volume", unit: "uL" }] },
      { name: "setModuleTemp", params: [{ name: "celsius", quantity: "module_temperature", unit: "degC" }] },
      {
        name: "runProtocol",
        params: [
          { name: "minutes", quantity: "run_duration", unit: "min" },
          { name: "labwareSlot", unbounded: "a deck position, not a safety quantity" },
        ],
      },
      { name: "stop", params: [] },
    ],
  },
};

/** Correct-unit operator answers for every required quantity of each template. */
const GOOD_ANSWERS: Record<string, IntakeLimit[]> = {
  "lab-plate-reader": [
    { field: "intake.incubation_temperature", quantity: "incubation_temperature", unit: "degC", min: 20, max: 40 },
    { field: "intake.read_duration", quantity: "read_duration", unit: "s", min: 1, max: 300 },
    { field: "intake.job_duration", quantity: "job_duration", unit: "min", min: 1, max: 120 },
  ],
  "liquid-handler-ot2": [
    { field: "intake.aspirate_volume", quantity: "aspirate_volume", unit: "uL", min: 1, max: 300 },
    { field: "intake.dispense_volume", quantity: "dispense_volume", unit: "uL", min: 1, max: 300 },
    { field: "intake.module_temperature", quantity: "module_temperature", unit: "degC", min: 4, max: 95 },
    { field: "intake.run_duration", quantity: "run_duration", unit: "min", min: 1, max: 120 },
  ],
};

/** Bare-minimum input: valid device identity (incl. adapterVersion), nothing else answered. */
function emptyInput(deviceClass: string): SafetyEnvelopeInput {
  return {
    deviceClass,
    device: { deviceId: "dev-1", adapterType: "http-plate-reader", adapterVersion: "1.0.0" },
    intake: { limits: [] },
    references: [],
  };
}

/** Every required quantity answered, plus a valid e-stop, rate, supervision, hazards and command map. */
function fullyAnsweredInput(deviceClass: string): SafetyEnvelopeInput {
  return {
    deviceClass,
    device: { deviceId: "dev-1", adapterType: "http-plate-reader", adapterVersion: "1.0.0" },
    commandMap: COMMAND_MAPS[deviceClass],
    intake: {
      limits: (GOOD_ANSWERS[deviceClass] ?? []).map((a) => ({ ...a })),
      eStop: { mechanism: "hardware" },
      supervision: "attended",
      hazards: ["heat"],
      maxCommandsPerMinute: 10,
    },
    references: [],
  };
}

/** A well-formed R5 reference finding for incubation_temperature (lab-plate-reader), overridable. */
function ref(overrides: Partial<ReferenceFinding> = {}): ReferenceFinding {
  return {
    quantity: "incubation_temperature",
    unit: "degC",
    value: { min: 15, max: 45 },
    claim: "operating range per datasheet",
    citation: { doc: "Datasheet Rev C", section: "4.2" },
    retrievedAt: "2026-01-15T00:00:00Z",
    ...overrides,
  };
}

function confirmDecision(overrides: Partial<EnvelopeDecision> = {}): EnvelopeDecision {
  return {
    confirmedBy: "operator@example.com",
    confirmedAt: "2026-02-01T00:00:00Z",
    ...overrides,
  };
}

/** Compile using the confirmed digest as its own registration-committed digest (the non-adversarial case). */
function compileOwn(confirmed: ConfirmedSafetyEnvelope) {
  return compileSafetyEnvelope(confirmed, confirmed.envelopeDigest);
}

// ── A. draft: malformed input is refused ───────────────────────────

describe("draftSafetyEnvelope: malformed input is refused", () => {
  it("throws EnvelopeRefused (not a generic Error) for malformed input", () => {
    expect(() => draftSafetyEnvelope(emptyInput("no-such-device"))).toThrow(EnvelopeRefused);
  });

  it("refuses an unknown deviceClass", () => {
    expect(() => draftSafetyEnvelope(emptyInput("no-such-device"))).toThrow(/unknown deviceClass/);
  });

  it("refuses a missing device.deviceId", () => {
    const input = emptyInput("lab-plate-reader");
    input.device.deviceId = "";
    expect(() => draftSafetyEnvelope(input)).toThrow(/device\.deviceId is required/);
  });

  it("refuses a missing device.adapterType", () => {
    const input = emptyInput("lab-plate-reader");
    input.device.adapterType = "";
    expect(() => draftSafetyEnvelope(input)).toThrow(/device\.adapterType is required/);
  });

  it("refuses a missing device.adapterVersion", () => {
    const input = emptyInput("lab-plate-reader");
    input.device.adapterVersion = "";
    expect(() => draftSafetyEnvelope(input)).toThrow(/device\.adapterVersion is required/);
  });

  it("refuses intake.limits that is not an array", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = "nope" as unknown as IntakeLimit[];
    expect(() => draftSafetyEnvelope(input)).toThrow(/intake\.limits must be an array/);
  });

  it("refuses references that is not an array", () => {
    const input = emptyInput("lab-plate-reader");
    input.references = "nope" as unknown as ReferenceFinding[];
    expect(() => draftSafetyEnvelope(input)).toThrow(/references must be an array/);
  });

  it("refuses an invalid eStop.mechanism", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.eStop = { mechanism: "remote-shutdown" as unknown as EStopDeclaration["mechanism"] };
    expect(() => draftSafetyEnvelope(input)).toThrow(/is not hardware, adapter-stop or none/);
  });

  it("refuses a maxCommandsPerMinute of 0", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.maxCommandsPerMinute = 0;
    expect(() => draftSafetyEnvelope(input)).toThrow(/maxCommandsPerMinute must be an integer/);
  });

  it("refuses a maxCommandsPerMinute of -1", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.maxCommandsPerMinute = -1;
    expect(() => draftSafetyEnvelope(input)).toThrow(/maxCommandsPerMinute must be an integer/);
  });

  it("refuses a maxCommandsPerMinute of 1.5", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.maxCommandsPerMinute = 1.5;
    expect(() => draftSafetyEnvelope(input)).toThrow(/maxCommandsPerMinute must be an integer/);
  });

  it("refuses a commandMap command without a name", () => {
    const input = emptyInput("lab-plate-reader");
    input.commandMap = { commands: [{ name: "", params: [] } as unknown as { name: string; params: [] }] };
    expect(() => draftSafetyEnvelope(input)).toThrow(/commandMap: command 0 needs a name/);
  });

  it("refuses a commandMap parameter that neither sets a quantity nor says unbounded", () => {
    const input = emptyInput("lab-plate-reader");
    input.commandMap = { commands: [{ name: "setIncubation", params: [{ name: "celsius" }] }] };
    expect(() => draftSafetyEnvelope(input)).toThrow(/must either set a quantity .* or say why it sets none/);
  });

  it("refuses a commandMap parameter that both sets a quantity and says unbounded", () => {
    const input = emptyInput("lab-plate-reader");
    input.commandMap = {
      commands: [{ name: "setIncubation", params: [{ name: "celsius", quantity: "incubation_temperature", unit: "degC", unbounded: "also this" }] }],
    };
    expect(() => draftSafetyEnvelope(input)).toThrow(/must either set a quantity .* or say why it sets none/);
  });

  it("refuses a commandMap parameter that sets a quantity this class does not bound", () => {
    const input = emptyInput("lab-plate-reader");
    input.commandMap = { commands: [{ name: "aspirate", params: [{ name: "volumeUl", quantity: "aspirate_volume", unit: "uL" }] }] };
    expect(() => draftSafetyEnvelope(input)).toThrow(/which this class does not bound/);
  });

  it("refuses a commandMap command declared twice", () => {
    const input = emptyInput("lab-plate-reader");
    input.commandMap = { commands: [{ name: "stop", params: [] }, { name: "stop", params: [] }] };
    expect(() => draftSafetyEnvelope(input)).toThrow(/"stop" is declared twice/);
  });
});

// ── B. draft: nothing is ever defaulted ────────────────────────────

describe("draftSafetyEnvelope: nothing is ever defaulted", () => {
  for (const template of Object.values(DEVICE_CLASS_TEMPLATES)) {
    it(`gives zero limits and exactly one question per requirement, plus e-stop, command-rate, supervision, hazards and command-map, for ${template.id}`, () => {
      const draft = draftSafetyEnvelope(emptyInput(template.id));
      expect(draft.limits).toHaveLength(0);
      expect(draft.questions).toHaveLength(template.requires.length + 5);
      for (const req of template.requires) {
        expect(draft.questions.filter((q) => q.about === req.quantity)).toHaveLength(1);
      }
      for (const about of ["e-stop", "command-rate", "supervision", "hazards", "command-map"]) {
        expect(draft.questions.filter((q) => q.about === about), about).toHaveLength(1);
      }
      expect(draft.commandMap).toBeNull();
      expect(draft.supervision).toBeNull();
      expect(draft.hazards).toBeNull();
    });

    it(`never uses a template step value as a limit bound for ${template.id}`, () => {
      const draft = draftSafetyEnvelope(emptyInput(template.id));
      const steps = template.requires.map((r) => r.step);
      expect(draft.limits).toHaveLength(0);
      for (const limit of draft.limits) {
        expect(steps).not.toContain(limit.min);
        expect(steps).not.toContain(limit.max);
      }
    });
  }
});

// ── C. draft: operator answers ─────────────────────────────────────

describe("draftSafetyEnvelope: operator answers", () => {
  it("uses correct-unit operator answers directly, with no questions", () => {
    for (const template of Object.values(DEVICE_CLASS_TEMPLATES)) {
      const draft = draftSafetyEnvelope(fullyAnsweredInput(template.id));
      expect(draft.questions).toHaveLength(0);
      expect(draft.limits).toHaveLength(template.requires.length);
      for (const limit of draft.limits) {
        const answer = GOOD_ANSWERS[template.id]!.find((a) => a.quantity === limit.quantity)!;
        expect(limit.proposedBy).toBe("operator");
        expect(limit.min).toBe(answer.min);
        expect(limit.max).toBe(answer.max);
        expect(limit.unit).toBe(answer.unit);
        expect(limit.sources).toEqual([{ kind: "operator", field: answer.field }]);
      }
    }
  });

  it("drops an operator answer in the wrong unit, and keeps the question", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = [{ field: "f", quantity: "incubation_temperature", unit: "K", min: 293, max: 313 }];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    const dropped = draft.dropped.find((d) => d.quantity === "incubation_temperature");
    expect(dropped).toBeDefined();
    expect(dropped!.reason).toMatch(/"K"/);
    expect(draft.questions.some((q) => q.about === "incubation_temperature")).toBe(true);
  });

  it("drops an operator answer with min above max", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = [{ field: "f", quantity: "incubation_temperature", unit: "degC", min: 40, max: 20 }];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    expect(draft.dropped.some((d) => d.quantity === "incubation_temperature" && /above max/.test(d.reason))).toBe(true);
    expect(draft.questions.some((q) => q.about === "incubation_temperature")).toBe(true);
  });

  it("drops an operator answer that has only a max (no min)", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = [{ field: "f", quantity: "incubation_temperature", unit: "degC", max: 40 }];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    expect(
      draft.dropped.some((d) => d.quantity === "incubation_temperature" && /finite min and a finite max/.test(d.reason)),
    ).toBe(true);
    expect(draft.questions.some((q) => q.about === "incubation_temperature")).toBe(true);
  });

  it("drops an operator answer that is NaN or Infinity", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = [
      { field: "f", quantity: "incubation_temperature", unit: "degC", min: Number.NaN, max: Number.POSITIVE_INFINITY },
    ];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    expect(draft.dropped.some((d) => d.quantity === "incubation_temperature")).toBe(true);
    expect(draft.questions.some((q) => q.about === "incubation_temperature")).toBe(true);
  });

  it("asks 'Which is it?' when two operator answers for the same quantity differ", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = [
      { field: "f1", quantity: "incubation_temperature", unit: "degC", min: 20, max: 40 },
      { field: "f2", quantity: "incubation_temperature", unit: "degC", min: 15, max: 35 },
    ];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    const q = draft.questions.find((q) => q.about === "incubation_temperature");
    expect(q).toBeDefined();
    expect(q!.ask).toMatch(/Which is it\?/);
  });

  it("accepts two identical operator answers for the same quantity", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = [
      { field: "f1", quantity: "incubation_temperature", unit: "degC", min: 20, max: 40 },
      { field: "f2", quantity: "incubation_temperature", unit: "degC", min: 20, max: 40 },
    ];
    const draft = draftSafetyEnvelope(input);
    const limit = draft.limits.find((l) => l.quantity === "incubation_temperature");
    expect(limit).toBeDefined();
    expect(limit!.min).toBe(20);
    expect(limit!.max).toBe(40);
    expect(draft.questions.some((q) => q.about === "incubation_temperature")).toBe(false);
  });
});

// ── D. draft: e-stop ────────────────────────────────────────────────

describe("draftSafetyEnvelope: e-stop", () => {
  it("asks a question when eStop is missing", () => {
    const draft = draftSafetyEnvelope(emptyInput("lab-plate-reader"));
    const q = draft.questions.find((q) => q.about === "e-stop");
    expect(q).toBeDefined();
    expect(q!.ask).toMatch(/emergency/);
  });

  it('asks a question for "none" on a class that moves or heats', () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.eStop = { mechanism: "none" };
    const draft = draftSafetyEnvelope(input);
    const q = draft.questions.find((q) => q.about === "e-stop");
    expect(q).toBeDefined();
    expect(q!.ask).toMatch(/moves or heats/);
  });

  it('asks a question for "adapter-stop" without a stopCommand', () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.eStop = { mechanism: "adapter-stop" };
    const draft = draftSafetyEnvelope(input);
    const q = draft.questions.find((q) => q.about === "e-stop");
    expect(q).toBeDefined();
    expect(q!.ask).toMatch(/Which adapter command stops the device\?/);
  });

  it('asks no question for "hardware"', () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.eStop = { mechanism: "hardware" };
    const draft = draftSafetyEnvelope(input);
    expect(draft.questions.some((q) => q.about === "e-stop")).toBe(false);
  });

  it("(114b) asks a question for 'adapter-stop' naming a command the map does not declare", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.eStop = { mechanism: "adapter-stop", stopCommand: "halt" };
    const draft = draftSafetyEnvelope(input);
    const q = draft.questions.find((q) => q.about === "e-stop");
    expect(q).toBeDefined();
    expect(q!.ask).toMatch(/not one of the adapter's declared commands/);
  });

  it("asks no question for 'adapter-stop' naming a declared command", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.eStop = { mechanism: "adapter-stop", stopCommand: "stop" };
    const draft = draftSafetyEnvelope(input);
    expect(draft.questions.some((q) => q.about === "e-stop")).toBe(false);
  });
});

// ── E. draft: references ───────────────────────────────────────────

describe("draftSafetyEnvelope: references", () => {
  it("proposes a limit from a single cited reference, with no question", () => {
    const input = emptyInput("lab-plate-reader");
    input.references = [ref()];
    const draft = draftSafetyEnvelope(input);
    const limit = draft.limits.find((l) => l.quantity === "incubation_temperature");
    expect(limit).toBeDefined();
    expect(limit!.proposedBy).toBe("reference");
    expect(limit!.min).toBe(15);
    expect(limit!.max).toBe(45);
    expect(limit!.sources).toEqual([
      {
        kind: "reference",
        citation: { doc: "Datasheet Rev C", section: "4.2" },
        retrievedAt: "2026-01-15T00:00:00Z",
        claim: "operating range per datasheet",
      },
    ]);
    expect(draft.questions.some((q) => q.about === "incubation_temperature")).toBe(false);
  });

  it("drops a reference with an empty citation doc", () => {
    const input = emptyInput("lab-plate-reader");
    input.references = [ref({ citation: { doc: "", section: "4.2" } })];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    expect(
      draft.dropped.some((d) => d.quantity === "incubation_temperature" && /cannot propose a limit/.test(d.reason)),
    ).toBe(true);
    expect(draft.questions.some((q) => q.about === "incubation_temperature")).toBe(true);
  });

  it("drops a reference with an empty citation section", () => {
    const input = emptyInput("lab-plate-reader");
    input.references = [ref({ citation: { doc: "Datasheet Rev C", section: "" } })];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    expect(
      draft.dropped.some((d) => d.quantity === "incubation_temperature" && /cannot propose a limit/.test(d.reason)),
    ).toBe(true);
    expect(draft.questions.some((q) => q.about === "incubation_temperature")).toBe(true);
  });

  it("drops a reference with an invalid retrievedAt", () => {
    const input = emptyInput("lab-plate-reader");
    input.references = [ref({ retrievedAt: "not-a-date" })];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    expect(
      draft.dropped.some((d) => d.quantity === "incubation_temperature" && /no valid retrievedAt/.test(d.reason)),
    ).toBe(true);
    expect(draft.questions.some((q) => q.about === "incubation_temperature")).toBe(true);
  });

  it("drops a reference in the wrong unit", () => {
    const input = emptyInput("lab-plate-reader");
    input.references = [ref({ unit: "K", value: { min: 288, max: 318 } })];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    expect(draft.dropped.some((d) => d.quantity === "incubation_temperature" && /"K"/.test(d.reason))).toBe(true);
    expect(draft.questions.some((q) => q.about === "incubation_temperature")).toBe(true);
  });

  it("proposes the tightest overlapping range from multiple references", () => {
    const input = emptyInput("lab-plate-reader");
    input.references = [
      ref({ value: { min: 15, max: 45 }, citation: { doc: "Manual A", section: "1" } }),
      ref({ value: { min: 20, max: 40 }, citation: { doc: "Manual B", section: "2" } }),
    ];
    const draft = draftSafetyEnvelope(input);
    const limit = draft.limits.find((l) => l.quantity === "incubation_temperature");
    expect(limit).toBeDefined();
    expect(limit!.min).toBe(20); // max of the mins
    expect(limit!.max).toBe(40); // min of the maxes
    expect(limit!.proposedBy).toBe("reference");
    expect(limit!.sources).toHaveLength(2);
  });

  it("asks a question when references disagree (non-overlapping ranges)", () => {
    const input = emptyInput("lab-plate-reader");
    input.references = [
      ref({ value: { min: 10, max: 20 }, citation: { doc: "Manual A", section: "1" } }),
      ref({ value: { min: 30, max: 40 }, citation: { doc: "Manual B", section: "2" } }),
    ];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    const q = draft.questions.find((q) => q.about === "incubation_temperature");
    expect(q).toBeDefined();
    expect(q!.ask).toMatch(/do not overlap/);
  });

  it("asks a question when a reference is tighter than the operator's answer, with no limit yet", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = [{ field: "f", quantity: "incubation_temperature", unit: "degC", min: 10, max: 50 }];
    input.references = [ref({ value: { min: 20, max: 40 } })]; // tighter than 10..50 on both sides
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    const q = draft.questions.find((q) => q.about === "incubation_temperature");
    expect(q).toBeDefined();
    expect(q!.ask).toMatch(/Confirm your range or tighten it/);
  });

  it("keeps the operator's limit when a reference is looser, but lists the reference among its sources", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = [{ field: "f", quantity: "incubation_temperature", unit: "degC", min: 20, max: 40 }];
    input.references = [ref({ value: { min: 10, max: 50 } })]; // looser than 20..40 on both sides
    const draft = draftSafetyEnvelope(input);
    const limit = draft.limits.find((l) => l.quantity === "incubation_temperature");
    expect(limit).toBeDefined();
    expect(limit!.min).toBe(20);
    expect(limit!.max).toBe(40);
    expect(limit!.proposedBy).toBe("operator");
    expect(limit!.sources).toEqual([
      { kind: "operator", field: "f" },
      {
        kind: "reference",
        citation: { doc: "Datasheet Rev C", section: "4.2" },
        retrievedAt: "2026-01-15T00:00:00Z",
        claim: "operating range per datasheet",
      },
    ]);
    expect(draft.questions.some((q) => q.about === "incubation_temperature")).toBe(false);
  });

  it("(114b-6 setup) records a referenceBound for a quantity a usable reference speaks to", () => {
    const input = emptyInput("lab-plate-reader");
    input.references = [ref()];
    const draft = draftSafetyEnvelope(input);
    const bound = draft.referenceBounds.find((b) => b.quantity === "incubation_temperature");
    expect(bound).toBeDefined();
    expect(bound).toMatchObject({ quantity: "incubation_temperature", unit: "degC", min: 15, max: 45 });
    expect(bound!.sources).toHaveLength(1);
  });

  it("records no referenceBound for a quantity with no usable reference", () => {
    const draft = draftSafetyEnvelope(emptyInput("lab-plate-reader"));
    expect(draft.referenceBounds).toHaveLength(0);
  });
});

// ── F. confirm ──────────────────────────────────────────────────────

describe("confirmSafetyEnvelope", () => {
  it("refuses when questions remain unanswered", () => {
    const draft = draftSafetyEnvelope(emptyInput("lab-plate-reader"));
    expect(() => confirmSafetyEnvelope(draft, confirmDecision())).toThrow(/unanswered/);
  });

  it("(114b) refuses confirm outright when the draft has no command map, even with every other question answered", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = GOOD_ANSWERS["lab-plate-reader"]!.map((a) => ({ ...a }));
    input.intake.eStop = { mechanism: "hardware" };
    input.intake.supervision = "attended";
    input.intake.hazards = ["heat"];
    input.intake.maxCommandsPerMinute = 10;
    const draft = draftSafetyEnvelope(input);
    expect(draft.commandMap).toBeNull();
    expect(() => confirmSafetyEnvelope(draft, confirmDecision())).toThrow(
      /the adapter has not declared its commands; draft again with its command map/,
    );
  });

  it("confirms when edits answer every question, producing a verifiable digest and template-ordered limits", () => {
    const input = emptyInput("lab-plate-reader");
    input.commandMap = COMMAND_MAPS["lab-plate-reader"];
    const draft = draftSafetyEnvelope(input);
    // Edits given in reverse-of-template order, to prove the final order is template-driven.
    const confirmed = confirmSafetyEnvelope(
      draft,
      confirmDecision({
        edits: [
          { quantity: "job_duration", min: 1, max: 120 },
          { quantity: "read_duration", min: 1, max: 300 },
          { quantity: "incubation_temperature", min: 20, max: 40 },
        ],
        eStop: { mechanism: "hardware" },
        maxCommandsPerMinute: 10,
        supervision: "attended",
        hazards: ["heat"],
      }),
    );

    expect(confirmed.envelopeDigest).toMatch(/^0x[0-9a-f]{64}$/);
    const recomputed =
      "0x" +
      createHash("sha256")
        .update(canonicalize({ domain: SAFETY_ENVELOPE_DOMAIN, envelope: confirmed.envelope }))
        .digest("hex");
    expect(confirmed.envelopeDigest).toBe(recomputed);

    expect(confirmed.envelope.limits.map((l) => l.quantity)).toEqual(["incubation_temperature", "read_duration", "job_duration"]);
    expect(confirmed.envelope.confirmation).toEqual({ confirmedBy: "operator@example.com", confirmedAt: "2026-02-01T00:00:00Z" });
    for (const limit of confirmed.envelope.limits) {
      expect(limit.proposedBy).toBe("operator");
      expect(limit.sources[0]).toEqual({ kind: "operator", field: "confirmation" });
    }
  });

  it("keeps earlier reference sources when an edit overwrites a reference-proposed limit", () => {
    const input = emptyInput("lab-plate-reader");
    input.commandMap = COMMAND_MAPS["lab-plate-reader"];
    input.references = [ref()]; // proposes incubation_temperature 15..45 from Datasheet Rev C
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")?.proposedBy).toBe("reference");

    const confirmed = confirmSafetyEnvelope(
      draft,
      confirmDecision({
        edits: [
          { quantity: "incubation_temperature", min: 18, max: 42, override: { reason: "operator judgment, within the cited 15..45" } },
          { quantity: "read_duration", min: 1, max: 300 },
          { quantity: "job_duration", min: 1, max: 120 },
        ],
        eStop: { mechanism: "hardware" },
        maxCommandsPerMinute: 10,
        supervision: "attended",
        hazards: ["heat"],
      }),
    );
    const incubation = confirmed.envelope.limits.find((l) => l.quantity === "incubation_temperature")!;
    expect(incubation.proposedBy).toBe("operator");
    expect(incubation.min).toBe(18);
    expect(incubation.max).toBe(42);
    // 18..42 is within the cited 15..45, so it does not loosen — no override source is added even though one was given.
    expect(incubation.sources).toEqual([
      { kind: "operator", field: "confirmation" },
      {
        kind: "reference",
        citation: { doc: "Datasheet Rev C", section: "4.2" },
        retrievedAt: "2026-01-15T00:00:00Z",
        claim: "operating range per datasheet",
      },
    ]);
  });

  it("refuses an edit for a quantity the device class does not bound", () => {
    const draft = draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"));
    expect(() =>
      confirmSafetyEnvelope(draft, confirmDecision({ edits: [{ quantity: "warp_factor", min: 1, max: 2 }] })),
    ).toThrow(/not a quantity this device class bounds/);
  });

  it("refuses an edit with min above max", () => {
    const draft = draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"));
    expect(() =>
      confirmSafetyEnvelope(draft, confirmDecision({ edits: [{ quantity: "incubation_temperature", min: 40, max: 20 }] })),
    ).toThrow(/is above max/);
  });

  it("(114b-6) refuses a duplicate edit for the same quantity", () => {
    const draft = draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"));
    expect(() =>
      confirmSafetyEnvelope(
        draft,
        confirmDecision({
          edits: [
            { quantity: "incubation_temperature", min: 20, max: 30 },
            { quantity: "incubation_temperature", min: 20, max: 35 },
          ],
        }),
      ),
    ).toThrow(/given twice/);
  });

  it("refuses an empty confirmedBy", () => {
    const draft = draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"));
    expect(() => confirmSafetyEnvelope(draft, confirmDecision({ confirmedBy: "" }))).toThrow(/confirmedBy is required/);
  });

  it("refuses an invalid confirmedAt", () => {
    const draft = draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"));
    expect(() => confirmSafetyEnvelope(draft, confirmDecision({ confirmedAt: "not-a-date" }))).toThrow(
      /confirmedAt must be an ISO-8601 time/,
    );
  });

  it("answers the e-stop and command-rate questions via decision fields", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.eStop = undefined;
    input.intake.maxCommandsPerMinute = undefined;
    const draft = draftSafetyEnvelope(input);
    expect(draft.questions.some((q) => q.about === "e-stop")).toBe(true);
    expect(draft.questions.some((q) => q.about === "command-rate")).toBe(true);

    const confirmed = confirmSafetyEnvelope(
      draft,
      confirmDecision({ eStop: { mechanism: "hardware" }, maxCommandsPerMinute: 7 }),
    );
    expect(confirmed.envelope.eStop).toEqual({ mechanism: "hardware" });
    expect(confirmed.envelope.maxCommandsPerMinute).toBe(7);
  });

  it("is deterministic, and changes if a limit bound, the device id, the e-stop, supervision, or hazards change", () => {
    const ADAPTER_STOP: EStopDeclaration = { mechanism: "adapter-stop", stopCommand: "stop" };
    const build = (opts: {
      deviceId?: string;
      incubationMax?: number;
      eStop?: EStopDeclaration;
      supervision?: Supervision;
      hazards?: Hazard[];
    }) => {
      const input = fullyAnsweredInput("lab-plate-reader");
      if (opts.deviceId) input.device.deviceId = opts.deviceId;
      if (opts.incubationMax !== undefined) {
        input.intake.limits = input.intake.limits.map((l) =>
          l.quantity === "incubation_temperature" ? { ...l, max: opts.incubationMax! } : l,
        );
      }
      if (opts.eStop) input.intake.eStop = opts.eStop;
      if (opts.supervision) input.intake.supervision = opts.supervision;
      if (opts.hazards) input.intake.hazards = opts.hazards;
      const draft = draftSafetyEnvelope(input);
      return confirmSafetyEnvelope(draft, confirmDecision());
    };

    const base = build({ hazards: ["heat", "mechanical"] });
    const same = build({ hazards: ["heat", "mechanical"] });
    const boundChanged = build({ incubationMax: 41, hazards: ["heat", "mechanical"] });
    const deviceChanged = build({ deviceId: "dev-2", hazards: ["heat", "mechanical"] });
    const eStopChanged = build({ eStop: ADAPTER_STOP, hazards: ["heat", "mechanical"] });
    // Held at the same (valid) e-stop as eStopChanged, so only supervision differs between them.
    const supervisionChanged = build({ eStop: ADAPTER_STOP, supervision: "remote-supervised", hazards: ["heat", "mechanical"] });
    const hazardsChanged = build({ hazards: ["laser"] });
    const hazardsReordered = build({ hazards: ["mechanical", "heat"] });
    const hazardsWithDuplicate = build({ hazards: ["heat", "heat", "mechanical"] });

    expect(same.envelopeDigest).toBe(base.envelopeDigest);
    expect(boundChanged.envelopeDigest).not.toBe(base.envelopeDigest);
    expect(deviceChanged.envelopeDigest).not.toBe(base.envelopeDigest);
    expect(eStopChanged.envelopeDigest).not.toBe(base.envelopeDigest);
    expect(supervisionChanged.envelopeDigest).not.toBe(eStopChanged.envelopeDigest);
    expect(hazardsChanged.envelopeDigest).not.toBe(base.envelopeDigest);
    // Canonical ordering means order and duplicates never affect the digest.
    expect(hazardsReordered.envelopeDigest).toBe(base.envelopeDigest);
    expect(hazardsWithDuplicate.envelopeDigest).toBe(base.envelopeDigest);
  });
});

// ── G. compile ──────────────────────────────────────────────────────

describe("compileSafetyEnvelope", () => {
  for (const template of Object.values(DEVICE_CLASS_TEMPLATES)) {
    it(`compiles a confirmed envelope end to end for ${template.id}, against its own committed digest`, () => {
      const draft = draftSafetyEnvelope(fullyAnsweredInput(template.id));
      const confirmed = confirmSafetyEnvelope(draft, confirmDecision());
      const compiled = compileOwn(confirmed);

      expect(compiled.parameters).toHaveLength(template.requires.length);
      for (const req of template.requires) {
        const answer = GOOD_ANSWERS[template.id]!.find((a) => a.quantity === req.quantity)!;
        const param = compiled.parameters.find((p) => p.key === req.param);
        expect(param).toBeDefined();
        expect(param).toMatchObject({ min: answer.min, max: answer.max, unit: req.unit, required: true, type: "number" });
        expect(CsdParameterSchema.safeParse(param).success).toBe(true);
      }

      for (const tier of Object.values(compiled.evidence)) {
        expect(CsdEvidenceTierSchema.safeParse(tier).success).toBe(true);
        const primitive = tier.primitives?.[0];
        expect(primitive?.id).toBe("telemetry.envelope_conformance");
        const envelopeParam = primitive?.params?.["envelope"];
        expect(Array.isArray(envelopeParam)).toBe(true);
        expect(envelopeParam).not.toBe("builtin-defaults");
        for (const entry of envelopeParam as unknown[]) {
          expect(entry).toHaveProperty("metric");
          expect(entry).toHaveProperty("unit");
          expect(entry).toHaveProperty("min");
          expect(entry).toHaveProperty("max");
        }
      }

      for (const def of compiled.composition.parameters) {
        expect(ParameterDefinitionSchema.safeParse(def).success).toBe(true);
      }
      for (const port of Object.values(compiled.composition.outputPorts)) {
        expect(PortTypeSchema.safeParse(port).success).toBe(true);
      }

      expect(compiled.envelopeDigest).toBe(confirmed.envelopeDigest);
    });
  }

  it("refuses a malformed committedDigest", () => {
    const confirmed = confirmSafetyEnvelope(draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader")), confirmDecision());
    for (const bad of ["not-a-digest", "0x1234", "0X" + "a".repeat(64), confirmed.envelopeDigest.toUpperCase()]) {
      expect(() => compileSafetyEnvelope(confirmed, bad), bad).toThrow(/the committed digest must be 0x \+ 64 lowercase hex/);
    }
  });
});

// ── H. review additions (sensors): one test per rule a mutation could otherwise remove ──

describe("review additions: confirm re-checks what it commits", () => {
  const answered = () => draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"));

  it("refuses an e-stop mechanism outside hardware, adapter-stop or none in the decision", () => {
    const bogus = { mechanism: "remote-kill" } as unknown as EStopDeclaration;
    expect(() => confirmSafetyEnvelope(answered(), confirmDecision({ eStop: bogus }))).toThrow(/is not hardware, adapter-stop or none/);
  });

  it("refuses e-stop none in the decision for a device that moves or heats", () => {
    expect(() => confirmSafetyEnvelope(answered(), confirmDecision({ eStop: { mechanism: "none" } }))).toThrow(/moves or heats needs an e-stop/);
  });

  it("refuses an adapter stop without its command in the decision", () => {
    expect(() => confirmSafetyEnvelope(answered(), confirmDecision({ eStop: { mechanism: "adapter-stop" } }))).toThrow(/adapter stop needs its command/);
  });

  it("(114b) refuses an adapter stop naming an undeclared command in the decision", () => {
    expect(() =>
      confirmSafetyEnvelope(answered(), confirmDecision({ eStop: { mechanism: "adapter-stop", stopCommand: "halt" } })),
    ).toThrow(/not one of the adapter's declared commands/);
  });

  it("refuses a decision rate that is not an integer >= 1", () => {
    for (const rate of [0, -3, 2.5]) {
      expect(() => confirmSafetyEnvelope(answered(), confirmDecision({ maxCommandsPerMinute: rate })), String(rate)).toThrow(
        /maxCommandsPerMinute must be an integer >= 1/,
      );
    }
  });

  it("commits only the e-stop's own fields", () => {
    const extra = { mechanism: "hardware", note: "big red button", stopCommand: 7 } as unknown as EStopDeclaration;
    const confirmed = confirmSafetyEnvelope(answered(), confirmDecision({ eStop: extra }));
    expect(confirmed.envelope.eStop).toEqual({ mechanism: "hardware" });
  });

  it("refuses a draft that lacks a required limit even when it lists no question", () => {
    const draft = answered();
    const handEdited = { ...draft, limits: draft.limits.filter((l) => l.quantity !== "read_duration"), questions: [] };
    expect(() => confirmSafetyEnvelope(handEdited, confirmDecision())).toThrow(/no confirmed limit for read_duration/);
  });
});

describe("review additions: references", () => {
  it("asks when a reference is tighter on the min side only", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = [{ field: "f", quantity: "incubation_temperature", unit: "degC", min: 10, max: 40 }];
    input.references = [ref({ value: { min: 20, max: 40 } })];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    expect(draft.questions.find((q) => q.about === "incubation_temperature")?.ask).toMatch(/Confirm your range or tighten it/);
  });

  it("asks when a reference is tighter on the max side only", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = [{ field: "f", quantity: "incubation_temperature", unit: "degC", min: 20, max: 50 }];
    input.references = [ref({ value: { min: 20, max: 40 } })];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    expect(draft.questions.find((q) => q.about === "incubation_temperature")?.ask).toMatch(/Confirm your range or tighten it/);
  });

  it("drops a reference whose range is unusable (min above max)", () => {
    const input = emptyInput("lab-plate-reader");
    input.references = [ref({ value: { min: 45, max: 15 } })];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    expect(draft.dropped.some((d) => d.quantity === "incubation_temperature" && /Datasheet Rev C/.test(d.reason))).toBe(true);
    expect(draft.questions.some((q) => q.about === "incubation_temperature")).toBe(true);
  });
});

describe("review additions: compile carries the confirmed values exactly", () => {
  it("puts the confirmed limits in the #53 params and the composition bounds, value for value", () => {
    const confirmed = confirmSafetyEnvelope(draftSafetyEnvelope(fullyAnsweredInput("liquid-handler-ot2")), confirmDecision());
    const compiled = compileOwn(confirmed);
    const want = confirmed.envelope.limits.map((l) => ({ metric: l.quantity, unit: l.unit, min: l.min, max: l.max }));
    expect(compiled.evidence["envelope-conformance"]?.primitives?.[0]?.params).toEqual({ envelope: want });
    expect(compiled.composition.parameters.map((d) => [d.name, d.minimum, d.maximum])).toEqual(
      confirmed.envelope.limits.map((l) => [l.param, { value: l.min, unit: l.unit }, { value: l.max, unit: l.unit }]),
    );
  });

  it("(114b-4a/4d style) refuses a re-digested envelope whose range, e-stop or rate is invalid, via the shared confirmedBodyProblems rules", () => {
    const confirmed = confirmSafetyEnvelope(draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader")), confirmDecision());
    const cases: Array<[string, (b: SafetyEnvelopeBody) => SafetyEnvelopeBody, RegExp]> = [
      ["min above max", (b) => ({ ...b, limits: b.limits.map((l, i) => (i === 0 ? { ...l, min: l.max + 1 } : l)) }), /is above max/],
      ["e-stop none", (b) => ({ ...b, eStop: { mechanism: "none" } }), /moves or heats needs an e-stop/],
      ["bogus e-stop", (b) => ({ ...b, eStop: { mechanism: "x" } as unknown as EStopDeclaration }), /is not hardware, adapter-stop or none/],
      ["rate 0", (b) => ({ ...b, maxCommandsPerMinute: 0 }), /maxCommandsPerMinute must be an integer >= 1/],
    ];
    for (const [label, change, reason] of cases) {
      const body = change(confirmed.envelope);
      const digest = computeSafetyEnvelopeDigest(body);
      const redigested: ConfirmedSafetyEnvelope = { envelope: body, envelopeDigest: digest };
      expect(() => compileSafetyEnvelope(redigested, digest), label).toThrow(reason);
    }
  });
});

// ── R5 findings and one-sided bounds ───────────────────────────────

describe("draftSafetyEnvelope: R5 findings and one-sided bounds (lab-plate-reader, incubation_temperature, degC)", () => {
  it("a single upper-only reference gives no limit, and asks for the lowest", () => {
    const input = emptyInput("lab-plate-reader");
    input.references = [ref({ value: { max: 95 } })];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    const q = draft.questions.find((q) => q.about === "incubation_temperature");
    expect(q).toBeDefined();
    expect(q!.ask).toMatch(/at most 95 degC/);
    expect(q!.ask).toMatch(/lowest/);
  });

  it("a single lower-only reference gives no limit, and asks for the highest", () => {
    const input = emptyInput("lab-plate-reader");
    input.references = [ref({ value: { min: 4 } })];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    const q = draft.questions.find((q) => q.about === "incubation_temperature");
    expect(q).toBeDefined();
    expect(q!.ask).toMatch(/at least 4 degC/);
    expect(q!.ask).toMatch(/highest/);
  });

  it("combines a lower-only reference from one doc and an upper-only reference from another into one limit", () => {
    const input = emptyInput("lab-plate-reader");
    input.references = [
      ref({ value: { min: 4 }, citation: { doc: "Doc A", section: "1" } }),
      ref({ value: { max: 95 }, citation: { doc: "Doc B", section: "2" } }),
    ];
    const draft = draftSafetyEnvelope(input);
    const limit = draft.limits.find((l) => l.quantity === "incubation_temperature");
    expect(limit).toBeDefined();
    expect(limit!.min).toBe(4);
    expect(limit!.max).toBe(95);
    expect(limit!.proposedBy).toBe("reference");
    expect(limit!.sources).toHaveLength(2);
  });

  it("asks a 'do not overlap' question when a lower-only and an upper-only reference conflict", () => {
    const input = emptyInput("lab-plate-reader");
    input.references = [
      ref({ value: { min: 40 }, citation: { doc: "Doc A", section: "1" } }),
      ref({ value: { max: 20 }, citation: { doc: "Doc B", section: "2" } }),
    ];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    const q = draft.questions.find((q) => q.about === "incubation_temperature");
    expect(q).toBeDefined();
    expect(q!.ask).toMatch(/do not overlap/);
  });

  it("a one-sided reference tighter only on the max side (operator has an answer) asks to confirm or tighten", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = [{ field: "f", quantity: "incubation_temperature", unit: "degC", min: 10, max: 50 }];
    input.references = [ref({ value: { max: 40 } })];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    const q = draft.questions.find((q) => q.about === "incubation_temperature");
    expect(q).toBeDefined();
    expect(q!.ask).toMatch(/Confirm your range or tighten it/);
  });

  it("a one-sided reference looser on the min side (operator has an answer) keeps the operator's limit, listing the reference", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = [{ field: "f", quantity: "incubation_temperature", unit: "degC", min: 10, max: 50 }];
    input.references = [ref({ value: { min: 5 } })];
    const draft = draftSafetyEnvelope(input);
    const limit = draft.limits.find((l) => l.quantity === "incubation_temperature");
    expect(limit).toBeDefined();
    expect(limit!.min).toBe(10);
    expect(limit!.max).toBe(50);
    expect(limit!.proposedBy).toBe("operator");
    expect(limit!.sources).toHaveLength(2);
    expect(draft.questions.some((q) => q.about === "incubation_temperature")).toBe(false);
  });

  it("drops a malformed reference value, each with a reason naming the doc, and keeps the question", () => {
    const cases: Array<[string, unknown]> = [
      ["no value key", undefined],
      ["value is a number", 95],
      ["value is empty (bounds neither side)", {}],
      ["min is not a finite number", { min: "4" }],
      ["min above max", { min: 50, max: 10 }],
    ];
    for (const [label, value] of cases) {
      const input = emptyInput("lab-plate-reader");
      input.references = [ref({ value: value as unknown as ReferenceFinding["value"] })];
      const draft = draftSafetyEnvelope(input);
      expect(draft.limits.find((l) => l.quantity === "incubation_temperature"), label).toBeUndefined();
      expect(
        draft.dropped.some((d) => d.quantity === "incubation_temperature" && d.reason.includes("Datasheet Rev C")),
        label,
      ).toBe(true);
      expect(draft.questions.some((q) => q.about === "incubation_temperature"), label).toBe(true);
    }
  });
});

// ── supervision and hazards ─────────────────────────────────────────

describe("draftSafetyEnvelope / confirmSafetyEnvelope / compileSafetyEnvelope: supervision and hazards", () => {
  it("missing supervision and hazards each give a question, and the draft carries null for both", () => {
    const draft = draftSafetyEnvelope(emptyInput("lab-plate-reader"));
    expect(draft.questions.some((q) => q.about === "supervision")).toBe(true);
    expect(draft.questions.some((q) => q.about === "hazards")).toBe(true);
    expect(draft.supervision).toBeNull();
    expect(draft.hazards).toBeNull();
  });

  it('hazards [] ("none") gives no question, and the confirmed body carries an empty array', () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.hazards = [];
    const draft = draftSafetyEnvelope(input);
    expect(draft.questions.some((q) => q.about === "hazards")).toBe(false);
    expect(draft.hazards).toEqual([]);
    const confirmed = confirmSafetyEnvelope(draft, confirmDecision());
    expect(confirmed.envelope.hazards).toEqual([]);
  });

  it("draft refuses an invalid supervision value", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.supervision = "sometimes" as unknown as Supervision;
    expect(() => draftSafetyEnvelope(input)).toThrow(/is not attended, unattended or remote-supervised/);
  });

  it("draft refuses hazards that is not a list", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.hazards = "heat" as unknown as Hazard[];
    expect(() => draftSafetyEnvelope(input)).toThrow(/hazards must be a list/);
  });

  it("draft refuses an unknown hazard", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.hazards = ["heat", "radiation"] as unknown as Hazard[];
    expect(() => draftSafetyEnvelope(input)).toThrow(/unknown hazard/);
  });

  it("deduplicates and canonically orders hazards, in both the draft and the confirmed body", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.hazards = ["mechanical", "heat", "heat"];
    const draft = draftSafetyEnvelope(input);
    expect(draft.hazards).toEqual(["heat", "mechanical"]);
    const confirmed = confirmSafetyEnvelope(draft, confirmDecision());
    expect(confirmed.envelope.hazards).toEqual(["heat", "mechanical"]);
  });

  it("the decision answers open supervision and hazards questions", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = GOOD_ANSWERS["lab-plate-reader"]!.map((a) => ({ ...a }));
    input.intake.eStop = { mechanism: "adapter-stop", stopCommand: "stop" };
    input.intake.maxCommandsPerMinute = 10;
    input.commandMap = COMMAND_MAPS["lab-plate-reader"];
    const draft = draftSafetyEnvelope(input);
    expect(draft.questions.map((q) => q.about)).toEqual(["supervision", "hazards"]);
    const confirmed = confirmSafetyEnvelope(draft, confirmDecision({ supervision: "remote-supervised", hazards: ["laser"] }));
    expect(confirmed.envelope.supervision).toBe("remote-supervised");
    expect(confirmed.envelope.hazards).toEqual(["laser"]);
  });

  it("refuses a decision with an invalid supervision or hazard", () => {
    const draft = draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"));
    expect(() => confirmSafetyEnvelope(draft, confirmDecision({ supervision: "sometimes" as unknown as Supervision }))).toThrow(
      /is not attended, unattended or remote-supervised/,
    );
    expect(() => confirmSafetyEnvelope(draft, confirmDecision({ hazards: ["radiation"] as unknown as Hazard[] }))).toThrow(
      /unknown hazard/,
    );
  });

  it("compile refuses a re-digested body with an invalid supervision or hazard", () => {
    const confirmed = confirmSafetyEnvelope(draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader")), confirmDecision());

    const badSupervision: SafetyEnvelopeBody = { ...confirmed.envelope, supervision: "sometimes" as unknown as Supervision };
    const digest1 = computeSafetyEnvelopeDigest(badSupervision);
    expect(() => compileSafetyEnvelope({ envelope: badSupervision, envelopeDigest: digest1 }, digest1)).toThrow(
      /is not attended, unattended or remote-supervised/,
    );

    const badHazards: SafetyEnvelopeBody = { ...confirmed.envelope, hazards: ["radiation"] as unknown as Hazard[] };
    const digest2 = computeSafetyEnvelopeDigest(badHazards);
    expect(() => compileSafetyEnvelope({ envelope: badHazards, envelopeDigest: digest2 }, digest2)).toThrow(/unknown hazard/);
  });

  it("(114b-5) v1's policy: unattended is a question for a device that moves or heats, and is refused if forced", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.supervision = "unattended";
    const draft = draftSafetyEnvelope(input);
    expect(draft.questions.map((q) => q.about)).toEqual(["supervision"]);
    expect(() => confirmSafetyEnvelope(draft, confirmDecision())).toThrow(/unanswered/);

    const confirmed = confirmSafetyEnvelope(draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader")), confirmDecision());
    const bad: SafetyEnvelopeBody = { ...confirmed.envelope, supervision: "unattended" };
    const digest = computeSafetyEnvelopeDigest(bad);
    expect(() => compileSafetyEnvelope({ envelope: bad, envelopeDigest: digest }, digest)).toThrow(/v1 does not allow unattended operation/);
  });

  it("(114b-5) v1's policy: remote-supervised without an adapter stop is an e-stop question at draft, and unconfirmable", () => {
    const input = fullyAnsweredInput("lab-plate-reader"); // default e-stop: hardware
    input.intake.supervision = "remote-supervised";
    const draft = draftSafetyEnvelope(input);
    const q = draft.questions.find((q) => q.about === "e-stop");
    expect(q).toBeDefined();
    expect(q!.ask).toMatch(/Remote supervision needs a stop the supervisor can trigger remotely/);
    expect(() => confirmSafetyEnvelope(draft, confirmDecision())).toThrow(/unanswered/);
  });
});

// ── astra 114b findings (pack 114b, cross-family review) ────────────
// Ports of /mnt/sparkbulk/tmp/sensors/repro/verify-r8-round2.mts. 1b/8-9/10
// exercise compileOperationalEnvelope / OperationalEnvelopeV1Schema and live
// in operational-envelope.test.ts instead.

describe("astra 114b findings", () => {
  const ok = () => confirmSafetyEnvelope(draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader")), confirmDecision());

  it("1a a forged body, self-consistently re-digested, still isn't the registered envelope", () => {
    const confirmed = ok();
    const REGISTERED = confirmed.envelopeDigest;
    const forged: SafetyEnvelopeBody = {
      ...confirmed.envelope,
      limits: confirmed.envelope.limits.map((l) => (l.quantity === "incubation_temperature" ? { ...l, max: l.max + 50 } : l)),
    };
    const forgedDigest = computeSafetyEnvelopeDigest(forged);
    expect(() => compileSafetyEnvelope({ envelope: forged, envelopeDigest: forgedDigest }, REGISTERED)).toThrow(
      /not the envelope the registration record committed/,
    );
  });

  it("1c confirmedBy changed after confirmation, with the digest left stale, fails self-consistency first", () => {
    const confirmed = ok();
    const renamed: ConfirmedSafetyEnvelope = {
      envelope: { ...confirmed.envelope, confirmation: { ...confirmed.envelope.confirmation, confirmedBy: "someone-else" } },
      envelopeDigest: confirmed.envelopeDigest, // stale: not recomputed over the changed content
    };
    expect(() => compileSafetyEnvelope(renamed, confirmed.envelopeDigest)).toThrow(/changed after it was confirmed/);
  });

  it("1d the genuine envelope against its own registered digest is accepted", () => {
    const confirmed = ok();
    expect(compileSafetyEnvelope(confirmed, confirmed.envelopeDigest).envelopeDigest).toBe(confirmed.envelopeDigest);
  });

  it("2a a one-sided reference (max 40), edit 10..50 (loosens): refused without an override", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.limits = input.intake.limits.filter((l) => l.quantity !== "incubation_temperature");
    input.references = [ref({ value: { max: 40 } })];
    const draft = draftSafetyEnvelope(input);
    expect(() =>
      confirmSafetyEnvelope(draft, confirmDecision({ edits: [{ quantity: "incubation_temperature", min: 10, max: 50 }] })),
    ).toThrow(/loosens the cited bound/);
  });

  it("2b same edit with an override reason: accepted, sources include operator, reference, override", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.limits = input.intake.limits.filter((l) => l.quantity !== "incubation_temperature");
    input.references = [ref({ value: { max: 40 } })];
    const draft = draftSafetyEnvelope(input);
    const confirmed = confirmSafetyEnvelope(
      draft,
      confirmDecision({
        edits: [{ quantity: "incubation_temperature", min: 10, max: 50, override: { reason: "firmware 2.1 raised the rating (service note 17)" } }],
      }),
    );
    const limit = confirmed.envelope.limits.find((l) => l.quantity === "incubation_temperature")!;
    expect(limit.sources.map((s) => s.kind)).toEqual(["operator", "reference", "override"]);
  });

  it("2c edit 10..40, within the cited bound: accepted, no override in its sources", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.limits = input.intake.limits.filter((l) => l.quantity !== "incubation_temperature");
    input.references = [ref({ value: { max: 40 } })];
    const draft = draftSafetyEnvelope(input);
    const confirmed = confirmSafetyEnvelope(draft, confirmDecision({ edits: [{ quantity: "incubation_temperature", min: 10, max: 40 }] }));
    const limit = confirmed.envelope.limits.find((l) => l.quantity === "incubation_temperature")!;
    expect(limit.sources.map((s) => s.kind)).toEqual(["operator", "reference"]);
  });

  it("3 conflicting operator answers plus a tighter reference: editing within the operator range still loosens the cited bound", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.limits = [
      ...input.intake.limits.filter((l) => l.quantity !== "incubation_temperature"),
      { field: "a", quantity: "incubation_temperature", unit: "degC", min: 20, max: 40 },
      { field: "b", quantity: "incubation_temperature", unit: "degC", min: 15, max: 45 },
    ];
    input.references = [ref({ value: { min: 20, max: 30 } })]; // tighter than either operator answer
    const draft = draftSafetyEnvelope(input);
    expect(draft.questions.some((q) => q.about === "incubation_temperature")).toBe(true);
    expect(draft.referenceBounds.find((b) => b.quantity === "incubation_temperature")).toMatchObject({ min: 20, max: 30 });
    expect(() =>
      confirmSafetyEnvelope(draft, confirmDecision({ edits: [{ quantity: "incubation_temperature", min: 15, max: 45 }] })),
    ).toThrow(/loosens the cited bound/);
  });

  it("4a a re-digested body with the unit changed (degC -> K) is refused", () => {
    const confirmed = ok();
    const bad: SafetyEnvelopeBody = {
      ...confirmed.envelope,
      limits: confirmed.envelope.limits.map((l, i) => (i === 0 ? { ...l, unit: "K" as unknown as typeof l.unit } : l)),
    };
    const digest = computeSafetyEnvelopeDigest(bad);
    expect(() => compileSafetyEnvelope({ envelope: bad, envelopeDigest: digest }, digest)).toThrow(/must be in degC/);
  });

  it("4b a re-digested body with a duplicated limit is refused", () => {
    const confirmed = ok();
    const bad: SafetyEnvelopeBody = {
      ...confirmed.envelope,
      limits: [...confirmed.envelope.limits, { ...confirmed.envelope.limits[0]!, max: confirmed.envelope.limits[0]!.max + 1 }],
    };
    const digest = computeSafetyEnvelopeDigest(bad);
    expect(() => compileSafetyEnvelope({ envelope: bad, envelopeDigest: digest }, digest)).toThrow(
      /limits must hold exactly one limit per required quantity/,
    );
  });

  it("4c a re-digested body with an extra (unbounded) limit is refused", () => {
    const confirmed = ok();
    const bad: SafetyEnvelopeBody = {
      ...confirmed.envelope,
      limits: [
        ...confirmed.envelope.limits,
        { quantity: "spindle", unit: "m/s" as unknown as SafetyEnvelopeBody["limits"][number]["unit"], param: "spindle", min: 0, max: 2, proposedBy: "operator", sources: [] },
      ],
    };
    const digest = computeSafetyEnvelopeDigest(bad);
    expect(() => compileSafetyEnvelope({ envelope: bad, envelopeDigest: digest }, digest)).toThrow(
      /limits must hold exactly one limit per required quantity/,
    );
  });

  it("4d a re-digested body with a blank deviceId is refused", () => {
    const confirmed = ok();
    const bad: SafetyEnvelopeBody = { ...confirmed.envelope, device: { ...confirmed.envelope.device, deviceId: " " } };
    const digest = computeSafetyEnvelopeDigest(bad);
    expect(() => compileSafetyEnvelope({ envelope: bad, envelopeDigest: digest }, digest)).toThrow(/device\.deviceId is required/);
  });

  it("5 the #53 evidence params carry {metric, unit, min, max} per limit", () => {
    const confirmed = ok();
    const compiled = compileOwn(confirmed);
    const params = compiled.evidence["envelope-conformance"]!.primitives![0]!.params!["envelope"] as Array<Record<string, unknown>>;
    const first = confirmed.envelope.limits[0]!;
    expect(params[0]).toEqual({ metric: first.quantity, unit: first.unit, min: first.min, max: first.max });
  });

  it("6 two edits naming the same quantity are refused", () => {
    const draft = draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"));
    expect(() =>
      confirmSafetyEnvelope(
        draft,
        confirmDecision({
          edits: [
            { quantity: "incubation_temperature", min: 20, max: 30 },
            { quantity: "incubation_temperature", min: 20, max: 35 },
          ],
        }),
      ),
    ).toThrow(/given twice/);
  });

  it("7a unattended supervision (with a declared adapter stop) still asks a supervision question", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.eStop = { mechanism: "adapter-stop", stopCommand: "stop" };
    input.intake.supervision = "unattended";
    const draft = draftSafetyEnvelope(input);
    expect(draft.questions.map((q) => q.about)).toEqual(["supervision"]);
  });

  it("7b confirming that unattended draft unchanged is refused", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.eStop = { mechanism: "adapter-stop", stopCommand: "stop" };
    input.intake.supervision = "unattended";
    const draft = draftSafetyEnvelope(input);
    expect(() => confirmSafetyEnvelope(draft, confirmDecision())).toThrow(/unanswered/);
  });

  it("7c answering with remote-supervised (adapter stop already declared) is accepted", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.eStop = { mechanism: "adapter-stop", stopCommand: "stop" };
    input.intake.supervision = "unattended";
    const draft = draftSafetyEnvelope(input);
    const confirmed = confirmSafetyEnvelope(draft, confirmDecision({ supervision: "remote-supervised" }));
    expect(confirmed.envelope.supervision).toBe("remote-supervised");
  });

  it("7d a re-digested unattended body is refused even with a matching digest", () => {
    const confirmed = ok();
    const bad: SafetyEnvelopeBody = { ...confirmed.envelope, supervision: "unattended", eStop: { mechanism: "adapter-stop", stopCommand: "stop" } };
    const digest = computeSafetyEnvelopeDigest(bad);
    expect(() => compileSafetyEnvelope({ envelope: bad, envelopeDigest: digest }, digest)).toThrow(/v1 does not allow unattended operation/);
  });

  it("the map gap: a command map that sets no job_duration gives a command-map question", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.commandMap = { commands: COMMAND_MAPS["lab-plate-reader"]!.commands.filter((c) => c.name !== "runProtocol") };
    const draft = draftSafetyEnvelope(input);
    expect(draft.questions.map((q) => q.about)).toContain("command-map");
    expect(draft.questions.find((q) => q.about === "command-map")?.ask).toMatch(/job_duration/);
  });

  it("the undeclared stop: adapter-stop naming a command outside the map gives an e-stop question", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.eStop = { mechanism: "adapter-stop", stopCommand: "halt" };
    const draft = draftSafetyEnvelope(input);
    expect(draft.questions.map((q) => q.about)).toContain("e-stop");
  });
});

// ── Mutation-found gaps (round-2 mutation run, 14 of 15 survivors; the 15th is equivalent) ──
describe("mutation-found gaps: every rule has a test of its own", () => {
  const plate = () => draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"));
  /** A body changed after confirmation and re-digested, compiled against its own digest, to isolate the shared rules. */
  const redigestedCompile = (mutate: (b: Record<string, any>) => void) => {
    const c = structuredClone(confirmSafetyEnvelope(plate(), confirmDecision())) as unknown as { envelope: Record<string, any>; envelopeDigest: string };
    mutate(c.envelope);
    const d = computeSafetyEnvelopeDigest(c.envelope as unknown as SafetyEnvelopeBody);
    return () => compileSafetyEnvelope({ envelope: c.envelope as unknown as SafetyEnvelopeBody, envelopeDigest: d }, d);
  };
  const withMap = (mutate: (m: CommandMapV1) => void) => {
    const input = fullyAnsweredInput("lab-plate-reader");
    const map = structuredClone(input.commandMap!) as CommandMapV1;
    mutate(map);
    return () => draftSafetyEnvelope({ ...input, commandMap: map });
  };

  it("map: a parameter that sets a quantity in another unit is refused", () => {
    expect(withMap((m) => (m.commands[0]!.params[0]!.unit = "degF"))).toThrow(/sets incubation_temperature in "degF", not degC/);
  });
  it("map: a parameter declared twice in one command is refused", () => {
    expect(withMap((m) => m.commands[0]!.params.push({ ...m.commands[0]!.params[0]! }))).toThrow(/declared twice/);
  });
  it("map: an unbounded parameter needs a nonblank reason", () => {
    expect(withMap((m) => m.commands[0]!.params.push({ name: "note", unbounded: "  " }))).toThrow(/unbounded without a reason/);
  });

  it("confirm: loosening only the MIN side of a cited bound needs an override", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.limits = input.intake.limits.filter((l) => l.quantity !== "incubation_temperature");
    input.references = [ref({ value: { min: 20 } })];
    const draft = draftSafetyEnvelope(input);
    expect(() => confirmSafetyEnvelope(draft, confirmDecision({ edits: [{ quantity: "incubation_temperature", min: 10, max: 30 }] }))).toThrow(
      /loosens the cited bound at least 20 degC/,
    );
  });

  it("confirm: a decision cannot set unattended on a device that moves or heats", () => {
    expect(() => confirmSafetyEnvelope(plate(), confirmDecision({ supervision: "unattended" }))).toThrow(/unattended operation/);
  });

  it("compile: the shared rules refuse a re-digested body with a wrong version, confirmation, quantity, param, proposedBy or map", () => {
    expect(redigestedCompile((b) => (b.envelopeVersion = 2))).toThrow(/envelopeVersion must be 1/);
    expect(redigestedCompile((b) => (b.confirmation.confirmedBy = " "))).toThrow(/confirmedBy is required/);
    expect(redigestedCompile((b) => (b.confirmation.confirmedAt = "not-a-time"))).toThrow(/confirmedAt must be an ISO-8601 time/);
    expect(redigestedCompile((b) => (b.limits[0].quantity = "incubation_temp"))).toThrow(/limit 0 must be incubation_temperature/);
    expect(redigestedCompile((b) => (b.limits[0].param = "heaterSetpoint"))).toThrow(/must bound the parameter incubationTemperature/);
    expect(redigestedCompile((b) => (b.limits[0].proposedBy = "agent"))).toThrow(/proposedBy must be operator or reference/);
    expect(redigestedCompile((b) => b.commandMap.commands.push({ ...b.commandMap.commands[0] }))).toThrow(/commandMap: command "setIncubation" is declared twice/);
  });
});
