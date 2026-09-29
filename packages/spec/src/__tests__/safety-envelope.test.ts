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
  ConfirmedSafetyEnvelope,
  EnvelopeDecision,
  EStopDeclaration,
  IntakeLimit,
  ReferenceFinding,
  SafetyEnvelopeBody,
  SafetyEnvelopeInput,
} from "../onboarding/safety-envelope.js";
import { KNOWN_UNITS, ParameterDefinitionSchema, PortTypeSchema } from "../csd/composition.js";
import { CsdEvidenceTierSchema, CsdParameterSchema } from "../csd/schema.js";
import { canonicalize } from "../util/canonical.js";

// ── Fixtures ────────────────────────────────────────────────────────

/** Correct-unit operator answers for every required quantity of each template. */
const GOOD_ANSWERS: Record<string, IntakeLimit[]> = {
  "lab-plate-reader": [
    { field: "intake.incubation_temperature", quantity: "incubation_temperature", unit: "degC", min: 20, max: 40 },
    { field: "intake.read_duration", quantity: "read_duration", unit: "s", min: 1, max: 300 },
  ],
  "liquid-handler-ot2": [
    { field: "intake.aspirate_volume", quantity: "aspirate_volume", unit: "uL", min: 1, max: 300 },
    { field: "intake.module_temperature", quantity: "module_temperature", unit: "degC", min: 4, max: 95 },
    { field: "intake.run_duration", quantity: "run_duration", unit: "min", min: 1, max: 120 },
  ],
};

/** Bare-minimum input: valid device class and identity, nothing else answered. */
function emptyInput(deviceClass: string): SafetyEnvelopeInput {
  return {
    deviceClass,
    device: { deviceId: "dev-1", adapterType: "http-plate-reader" },
    intake: { limits: [] },
    references: [],
  };
}

/** Every required quantity answered correctly by the operator, plus a valid e-stop and rate. */
function fullyAnsweredInput(deviceClass: string): SafetyEnvelopeInput {
  return {
    deviceClass,
    device: { deviceId: "dev-1", adapterType: "http-plate-reader" },
    intake: {
      limits: (GOOD_ANSWERS[deviceClass] ?? []).map((a) => ({ ...a })),
      eStop: { mechanism: "hardware" },
      maxCommandsPerMinute: 10,
    },
    references: [],
  };
}

/** A well-formed reference finding for incubation_temperature (lab-plate-reader), overridable. */
function ref(overrides: Partial<ReferenceFinding> = {}): ReferenceFinding {
  return {
    quantity: "incubation_temperature",
    unit: "degC",
    min: 15,
    max: 45,
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
});

// ── B. draft: nothing is ever defaulted ────────────────────────────

describe("draftSafetyEnvelope: nothing is ever defaulted", () => {
  for (const template of Object.values(DEVICE_CLASS_TEMPLATES)) {
    it(`gives zero limits and exactly one question per requirement, plus e-stop and command-rate, for ${template.id}`, () => {
      const draft = draftSafetyEnvelope(emptyInput(template.id));
      expect(draft.limits).toHaveLength(0);
      expect(draft.questions).toHaveLength(template.requires.length + 2);
      for (const req of template.requires) {
        expect(draft.questions.filter((q) => q.about === req.quantity)).toHaveLength(1);
      }
      expect(draft.questions.filter((q) => q.about === "e-stop")).toHaveLength(1);
      expect(draft.questions.filter((q) => q.about === "command-rate")).toHaveLength(1);
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
    input.references = [ref({ unit: "K", min: 288, max: 318 })];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    expect(draft.dropped.some((d) => d.quantity === "incubation_temperature" && /"K"/.test(d.reason))).toBe(true);
    expect(draft.questions.some((q) => q.about === "incubation_temperature")).toBe(true);
  });

  it("proposes the tightest overlapping range from multiple references", () => {
    const input = emptyInput("lab-plate-reader");
    input.references = [
      ref({ min: 15, max: 45, citation: { doc: "Manual A", section: "1" } }),
      ref({ min: 20, max: 40, citation: { doc: "Manual B", section: "2" } }),
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
      ref({ min: 10, max: 20, citation: { doc: "Manual A", section: "1" } }),
      ref({ min: 30, max: 40, citation: { doc: "Manual B", section: "2" } }),
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
    input.references = [ref({ min: 20, max: 40 })]; // tighter than 10..50 on both sides
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    const q = draft.questions.find((q) => q.about === "incubation_temperature");
    expect(q).toBeDefined();
    expect(q!.ask).toMatch(/Confirm your range or tighten it/);
  });

  it("keeps the operator's limit when a reference is looser, but lists the reference among its sources", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = [{ field: "f", quantity: "incubation_temperature", unit: "degC", min: 20, max: 40 }];
    input.references = [ref({ min: 10, max: 50 })]; // looser than 20..40 on both sides
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
});

// ── F. confirm ──────────────────────────────────────────────────────

describe("confirmSafetyEnvelope", () => {
  it("refuses when questions remain unanswered", () => {
    const draft = draftSafetyEnvelope(emptyInput("lab-plate-reader"));
    expect(() => confirmSafetyEnvelope(draft, confirmDecision())).toThrow(/unanswered/);
  });

  it("confirms when edits answer every question, producing a verifiable digest and template-ordered limits", () => {
    const draft = draftSafetyEnvelope(emptyInput("lab-plate-reader"));
    // Edits given in reverse-of-template order, to prove the final order is template-driven.
    const confirmed = confirmSafetyEnvelope(
      draft,
      confirmDecision({
        edits: [
          { quantity: "read_duration", min: 1, max: 300 },
          { quantity: "incubation_temperature", min: 20, max: 40 },
        ],
        eStop: { mechanism: "hardware" },
        maxCommandsPerMinute: 10,
      }),
    );

    expect(confirmed.envelopeDigest).toMatch(/^0x[0-9a-f]{64}$/);
    const recomputed =
      "0x" +
      createHash("sha256")
        .update(canonicalize({ domain: SAFETY_ENVELOPE_DOMAIN, envelope: confirmed.envelope }))
        .digest("hex");
    expect(confirmed.envelopeDigest).toBe(recomputed);

    expect(confirmed.envelope.limits.map((l) => l.quantity)).toEqual(["incubation_temperature", "read_duration"]);
    for (const limit of confirmed.envelope.limits) {
      expect(limit.proposedBy).toBe("operator");
      expect(limit.sources[0]).toEqual({ kind: "operator", field: "confirmation" });
    }
  });

  it("keeps earlier reference sources when an edit overwrites a reference-proposed limit", () => {
    const input = emptyInput("lab-plate-reader");
    input.references = [ref()]; // proposes incubation_temperature 15..45 from Datasheet Rev C
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")?.proposedBy).toBe("reference");

    const confirmed = confirmSafetyEnvelope(
      draft,
      confirmDecision({
        edits: [
          { quantity: "incubation_temperature", min: 18, max: 42 },
          { quantity: "read_duration", min: 1, max: 300 },
        ],
        eStop: { mechanism: "hardware" },
        maxCommandsPerMinute: 10,
      }),
    );
    const incubation = confirmed.envelope.limits.find((l) => l.quantity === "incubation_temperature")!;
    expect(incubation.proposedBy).toBe("operator");
    expect(incubation.min).toBe(18);
    expect(incubation.max).toBe(42);
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
    const draft = draftSafetyEnvelope(emptyInput("lab-plate-reader"));
    expect(() =>
      confirmSafetyEnvelope(
        draft,
        confirmDecision({
          edits: [
            { quantity: "warp_factor", min: 1, max: 2 },
            { quantity: "incubation_temperature", min: 20, max: 40 },
            { quantity: "read_duration", min: 1, max: 300 },
          ],
          eStop: { mechanism: "hardware" },
          maxCommandsPerMinute: 10,
        }),
      ),
    ).toThrow(/not a quantity this device class bounds/);
  });

  it("refuses an edit with min above max", () => {
    const draft = draftSafetyEnvelope(emptyInput("lab-plate-reader"));
    expect(() =>
      confirmSafetyEnvelope(
        draft,
        confirmDecision({
          edits: [
            { quantity: "incubation_temperature", min: 40, max: 20 },
            { quantity: "read_duration", min: 1, max: 300 },
          ],
          eStop: { mechanism: "hardware" },
          maxCommandsPerMinute: 10,
        }),
      ),
    ).toThrow(/is above max/);
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

  it("is deterministic, and changes if a limit bound, the device id, or the e-stop changes", () => {
    const build = (opts: { deviceId?: string; incubationMax?: number; eStop?: EStopDeclaration }) => {
      const input = fullyAnsweredInput("lab-plate-reader");
      if (opts.deviceId) input.device.deviceId = opts.deviceId;
      if (opts.incubationMax !== undefined) {
        input.intake.limits = input.intake.limits.map((l) =>
          l.quantity === "incubation_temperature" ? { ...l, max: opts.incubationMax! } : l,
        );
      }
      if (opts.eStop) input.intake.eStop = opts.eStop;
      const draft = draftSafetyEnvelope(input);
      return confirmSafetyEnvelope(draft, confirmDecision());
    };

    const base = build({});
    const same = build({});
    const boundChanged = build({ incubationMax: 41 });
    const deviceChanged = build({ deviceId: "dev-2" });
    const eStopChanged = build({ eStop: { mechanism: "adapter-stop", stopCommand: "STOP" } });

    expect(same.envelopeDigest).toBe(base.envelopeDigest);
    expect(boundChanged.envelopeDigest).not.toBe(base.envelopeDigest);
    expect(deviceChanged.envelopeDigest).not.toBe(base.envelopeDigest);
    expect(eStopChanged.envelopeDigest).not.toBe(base.envelopeDigest);
  });
});

// ── G. compile ──────────────────────────────────────────────────────

describe("compileSafetyEnvelope", () => {
  for (const template of Object.values(DEVICE_CLASS_TEMPLATES)) {
    it(`compiles a confirmed envelope end to end for ${template.id}`, () => {
      const draft = draftSafetyEnvelope(fullyAnsweredInput(template.id));
      const confirmed = confirmSafetyEnvelope(draft, confirmDecision());
      const compiled = compileSafetyEnvelope(confirmed);

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

  it("refuses a confirmed envelope whose limit max was changed after confirmation", () => {
    const draft = draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"));
    const confirmed = confirmSafetyEnvelope(draft, confirmDecision());
    const tampered: ConfirmedSafetyEnvelope = {
      ...confirmed,
      envelope: {
        ...confirmed.envelope,
        limits: confirmed.envelope.limits.map((l) =>
          l.quantity === "incubation_temperature" ? { ...l, max: l.max + 1 } : l,
        ),
      },
    };
    expect(() => compileSafetyEnvelope(tampered)).toThrow(/changed after it was confirmed/);
  });

  it("refuses a confirmed envelope whose device id was changed after confirmation", () => {
    const draft = draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"));
    const confirmed = confirmSafetyEnvelope(draft, confirmDecision());
    const tampered: ConfirmedSafetyEnvelope = {
      ...confirmed,
      envelope: { ...confirmed.envelope, device: { ...confirmed.envelope.device, deviceId: "tampered-id" } },
    };
    expect(() => compileSafetyEnvelope(tampered)).toThrow(/changed after it was confirmed/);
  });

  it("refuses a confirmed envelope whose unit is outside KNOWN_UNITS, even with a matching recomputed digest", () => {
    const draft = draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"));
    const confirmed = confirmSafetyEnvelope(draft, confirmDecision());
    expect(KNOWN_UNITS as readonly string[]).not.toContain("furlongs");
    const badEnvelope: SafetyEnvelopeBody = {
      ...confirmed.envelope,
      limits: confirmed.envelope.limits.map((l) =>
        l.quantity === "incubation_temperature" ? { ...l, unit: "furlongs" as unknown as typeof l.unit } : l,
      ),
    };
    // Recompute the digest over the tampered body so the tamper check itself does not fire —
    // isolating that the unit check is what refuses this envelope.
    const badDigest = computeSafetyEnvelopeDigest(badEnvelope);
    const tampered: ConfirmedSafetyEnvelope = { ...confirmed, envelope: badEnvelope, envelopeDigest: badDigest };
    expect(() => compileSafetyEnvelope(tampered)).toThrow(/no valid confirmed limit for incubation_temperature/);
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
    input.references = [ref({ min: 20, max: 40 })];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    expect(draft.questions.find((q) => q.about === "incubation_temperature")?.ask).toMatch(/Confirm your range or tighten it/);
  });

  it("asks when a reference is tighter on the max side only", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = [{ field: "f", quantity: "incubation_temperature", unit: "degC", min: 20, max: 50 }];
    input.references = [ref({ min: 20, max: 40 })];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
    expect(draft.questions.find((q) => q.about === "incubation_temperature")?.ask).toMatch(/Confirm your range or tighten it/);
  });

  it("drops a reference whose range is unusable (min above max, or a bound missing)", () => {
    for (const bad of [ref({ min: 45, max: 15 }), ref({ min: undefined })]) {
      const input = emptyInput("lab-plate-reader");
      input.references = [bad];
      const draft = draftSafetyEnvelope(input);
      expect(draft.limits.find((l) => l.quantity === "incubation_temperature")).toBeUndefined();
      expect(draft.dropped.some((d) => d.quantity === "incubation_temperature" && /Datasheet Rev C/.test(d.reason))).toBe(true);
      expect(draft.questions.some((q) => q.about === "incubation_temperature")).toBe(true);
    }
  });
});

describe("review additions: compile carries the confirmed values exactly", () => {
  it("puts the confirmed limits in the #53 params and the composition bounds, value for value", () => {
    const confirmed = confirmSafetyEnvelope(draftSafetyEnvelope(fullyAnsweredInput("liquid-handler-ot2")), confirmDecision());
    const compiled = compileSafetyEnvelope(confirmed);
    const want = confirmed.envelope.limits.map((l) => ({ metric: l.quantity, min: l.min, max: l.max }));
    expect(compiled.evidence["envelope-conformance"]?.primitives?.[0]?.params).toEqual({ envelope: want });
    expect(compiled.composition.parameters.map((d) => [d.name, d.minimum, d.maximum])).toEqual(
      confirmed.envelope.limits.map((l) => [l.param, { value: l.min, unit: l.unit }, { value: l.max, unit: l.unit }]),
    );
  });

  it("refuses a re-digested envelope whose range, e-stop or rate is invalid", () => {
    const confirmed = confirmSafetyEnvelope(draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader")), confirmDecision());
    const cases: Array<[string, (b: SafetyEnvelopeBody) => SafetyEnvelopeBody, RegExp]> = [
      ["min above max", (b) => ({ ...b, limits: b.limits.map((l, i) => (i === 0 ? { ...l, min: l.max + 1 } : l)) }), /no valid confirmed limit/],
      ["e-stop none", (b) => ({ ...b, eStop: { mechanism: "none" } }), /moves or heats needs an e-stop/],
      ["bogus e-stop", (b) => ({ ...b, eStop: { mechanism: "x" } as unknown as EStopDeclaration }), /is not hardware, adapter-stop or none/],
      ["rate 0", (b) => ({ ...b, maxCommandsPerMinute: 0 }), /maxCommandsPerMinute must be an integer >= 1/],
    ];
    for (const [label, change, reason] of cases) {
      const body = change(confirmed.envelope);
      const redigested = { ...confirmed, envelope: body, envelopeDigest: computeSafetyEnvelopeDigest(body) };
      expect(() => compileSafetyEnvelope(redigested), label).toThrow(reason);
    }
  });
});
