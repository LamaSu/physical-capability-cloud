import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  DEVICE_CLASS_TEMPLATES,
  EnvelopeRefused,
  SAFETY_ENVELOPE_DOMAIN,
  compileSafetyEnvelope,
  computeSafetyEnvelopeDigest,
  confirmSafetyEnvelope,
  confirmedBodyProblems,
  draftSafetyEnvelope,
  registrationSigningPreimage,
  registrationStatementDigest,
} from "../onboarding/safety-envelope.js";
import type {
  CommandMapV1,
  ConfirmedSafetyEnvelope,
  EnvelopeDecision,
  EStopDeclaration,
  Hazard,
  IntakeLimit,
  ReferenceFinding,
  RegistrationVerifier,
  SafetyEnvelopeBody,
  SafetyEnvelopeInput,
  SafetyEnvelopeRegistration,
  Supervision,
} from "../onboarding/safety-envelope.js";
import { KNOWN_UNITS, ParameterDefinitionSchema, PortTypeSchema } from "../csd/composition.js";
import { CsdEvidenceTierSchema, CsdParameterSchema } from "../csd/schema.js";
import { canonicalize } from "../util/canonical.js";

// ── Fixtures ────────────────────────────────────────────────────────

/** An adapter release manifest digest (well-formed; the tests never resolve it). */
const MANIFEST = `sha256:${"ab".repeat(32)}`;

/** A test registry: its key signs registrations, and `verifyRegistry` is the integration's pinned check. */
const REGISTRY = generateKeyPairSync("ed25519");
const verifyRegistry: RegistrationVerifier = (preimage, signature) => verify(null, preimage, REGISTRY.publicKey, signature);

/** The registry's signed statement that `confirmed` is its device's confirmed envelope. */
function register(confirmed: ConfirmedSafetyEnvelope, deviceId = confirmed.envelope.device.deviceId): SafetyEnvelopeRegistration {
  const statement = { deviceId, envelopeDigest: confirmed.envelopeDigest, registeredAt: "2026-02-01T00:05:00Z" };
  return { ...statement, signature: Buffer.from(sign(null, registrationSigningPreimage(statement), REGISTRY.privateKey)).toString("hex") };
}

/** A full command map per template: one declared command per quantity, plus a declared "stop". */
const COMMAND_MAPS: Record<string, CommandMapV1> = {
  "lab-plate-reader": {
    commands: [
      { name: "setIncubation", params: [{ name: "celsius", quantity: "incubation_temperature", unit: "degC" }] },
      {
        name: "read",
        params: [
          { name: "seconds", quantity: "read_duration", unit: "s" },
          { name: "wavelengthNm", unbounded: { reason: "an optical setting, not a safety quantity", allowed: [340, 405, 450, 600] } },
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
          { name: "labwareSlot", unbounded: { reason: "a deck position, not a safety quantity", allowed: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] } },
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
    device: { deviceId: "dev-1", adapterType: "http-plate-reader", adapterVersion: MANIFEST },
    intake: { limits: [] },
    references: [],
  };
}

/** Every required quantity answered, plus a valid e-stop, rate, supervision, hazards and command map. */
function fullyAnsweredInput(deviceClass: string): SafetyEnvelopeInput {
  return {
    deviceClass,
    device: { deviceId: "dev-1", adapterType: "http-plate-reader", adapterVersion: MANIFEST },
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

/** Compile with the registry's signed registration of this very envelope (the non-adversarial case). */
function compileOwn(confirmed: ConfirmedSafetyEnvelope) {
  return compileSafetyEnvelope(confirmed, register(confirmed), verifyRegistry);
}

/**
 * Compile a body the registry signed as-is, after it was changed and
 * re-digested: isolates the shared body rules, which hold even for a
 * registered body.
 */
function compileRegistered(envelope: SafetyEnvelopeBody, deviceId?: string) {
  const confirmed = { envelope, envelopeDigest: computeSafetyEnvelopeDigest(envelope) };
  return compileSafetyEnvelope(confirmed, register(confirmed, deviceId), verifyRegistry);
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
    expect(() => draftSafetyEnvelope(input)).toThrow(/device\.adapterVersion must be the adapter's manifest digest/);
  });

  it("(astra 153, HIGH 8) refuses an adapterVersion that is not a manifest digest", () => {
    for (const bad of ["1.0.0", "sha256:" + "a".repeat(63), "sha256:" + "A".repeat(64), "0x" + "a".repeat(64)]) {
      const input = emptyInput("lab-plate-reader");
      input.device.adapterVersion = bad;
      expect(() => draftSafetyEnvelope(input), bad).toThrow(/device\.adapterVersion must be the adapter's manifest digest/);
    }
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
      commands: [{ name: "setIncubation", params: [{ name: "celsius", quantity: "incubation_temperature", unit: "degC", unbounded: { reason: "also this", allowed: [1] } }] }],
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

  it("refuses an input carrying NaN or Infinity: it is not JSON data, so the draft is never built from it", () => {
    // The input is copied once as plain JSON data (astra pack 153); a non-finite number cannot come from JSON.
    for (const [min, max] of [[Number.NaN, 40], [20, Number.POSITIVE_INFINITY]]) {
      const input = emptyInput("lab-plate-reader");
      input.intake.limits = [{ field: "f", quantity: "incubation_temperature", unit: "degC", min, max }];
      expect(() => draftSafetyEnvelope(input)).toThrow(/is not a finite number: input must be plain JSON data/);
    }
  });

  it("refuses an input carrying an integer outside the safe range: canonical JSON (D5) has no form for it, so no envelope is built from it", () => {
    // The oracle's canonicalize (D5, #359) refuses such a number, so an envelope holding one would have a digest it cannot recompute.
    for (const [min, max] of [[20, 1e21], [-(2 ** 53), 40]]) {
      const input = emptyInput("lab-plate-reader");
      input.intake.limits = [{ field: "f", quantity: "incubation_temperature", unit: "degC", min, max }];
      expect(() => draftSafetyEnvelope(input)).toThrow(/is an integer outside the safe range, which canonical JSON \(D5\) has no form for: input must be plain JSON data/);
    }
    // The boundary itself is a safe integer: still JSON data, so the draft is built.
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = [{ field: "f", quantity: "incubation_temperature", unit: "degC", min: -(2 ** 53 - 1), max: 2 ** 53 - 1 }];
    expect(() => draftSafetyEnvelope(input)).not.toThrow();
  });

  it("drops an operator answer whose bound is missing or not a number, and asks", () => {
    const input = emptyInput("lab-plate-reader");
    input.intake.limits = [{ field: "f", quantity: "incubation_temperature", unit: "degC", min: "20" as unknown as number, max: 40 }];
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
        value: { min: 15, max: 45 },
        unit: "degC",
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
        value: { min: 10, max: 50 },
        unit: "degC",
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
    expect(() => confirmSafetyEnvelope(emptyInput("lab-plate-reader"), confirmDecision())).toThrow(/unanswered/);
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
    expect(() => confirmSafetyEnvelope(input, confirmDecision())).toThrow(
      /the adapter has not declared its commands; draft again with its command map/,
    );
  });

  it("confirms when edits answer every question, producing a verifiable digest and template-ordered limits", () => {
    const input = emptyInput("lab-plate-reader");
    input.commandMap = COMMAND_MAPS["lab-plate-reader"];
    const draft = draftSafetyEnvelope(input);
    // Edits given in reverse-of-template order, to prove the final order is template-driven.
    const confirmed = confirmSafetyEnvelope(
      input,
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
      input,
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
        value: { min: 15, max: 45 },
        unit: "degC",
      },
    ]);
  });

  it("refuses an edit for a quantity the device class does not bound", () => {
    const draft = draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"));
    expect(() =>
      confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision({ edits: [{ quantity: "warp_factor", min: 1, max: 2 }] })),
    ).toThrow(/not a quantity this device class bounds/);
  });

  it("refuses an edit with min above max", () => {
    const draft = draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"));
    expect(() =>
      confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision({ edits: [{ quantity: "incubation_temperature", min: 40, max: 20 }] })),
    ).toThrow(/is above max/);
  });

  it("(114b-6) refuses a duplicate edit for the same quantity", () => {
    const draft = draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"));
    expect(() =>
      confirmSafetyEnvelope(
        fullyAnsweredInput("lab-plate-reader"),
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
    expect(() => confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision({ confirmedBy: "" }))).toThrow(/confirmedBy is required/);
  });

  it("refuses an invalid confirmedAt", () => {
    const draft = draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"));
    expect(() => confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision({ confirmedAt: "not-a-date" }))).toThrow(
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
      input,
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
      return confirmSafetyEnvelope(input, confirmDecision());
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
      const confirmed = confirmSafetyEnvelope(fullyAnsweredInput(template.id), confirmDecision());
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

  it("refuses a registration whose envelopeDigest is malformed", () => {
    const confirmed = confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision());
    for (const bad of ["not-a-digest", "0x1234", "0X" + "a".repeat(64), confirmed.envelopeDigest.toUpperCase()]) {
      expect(() => compileSafetyEnvelope(confirmed, { ...register(confirmed), envelopeDigest: bad as `0x${string}` }, verifyRegistry), bad).toThrow(
        /envelopeDigest must be 0x \+ 64 lowercase hex/,
      );
    }
  });
});

// ── H. review additions (sensors): one test per rule a mutation could otherwise remove ──

describe("review additions: confirm re-checks what it commits", () => {
  const answered = () => fullyAnsweredInput("lab-plate-reader");

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

  it("refuses an input that leaves a required limit unanswered, naming the missing limit", () => {
    // Confirm drafts again from the input (astra pack 153), so a hand-edited draft cannot drop a question.
    const input = answered();
    input.intake.limits = input.intake.limits.filter((l) => l.quantity !== "read_duration");
    expect(() => confirmSafetyEnvelope(input, confirmDecision())).toThrow(/no confirmed limit for read_duration/);
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
    const confirmed = confirmSafetyEnvelope(fullyAnsweredInput("liquid-handler-ot2"), confirmDecision());
    const compiled = compileOwn(confirmed);
    const want = confirmed.envelope.limits.map((l) => ({ metric: l.quantity, unit: l.unit, min: l.min, max: l.max }));
    expect(compiled.evidence["envelope-conformance"]?.primitives?.[0]?.params).toEqual({ envelope: want });
    expect(compiled.composition.parameters.map((d) => [d.name, d.minimum, d.maximum])).toEqual(
      confirmed.envelope.limits.map((l) => [l.param, { value: l.min, unit: l.unit }, { value: l.max, unit: l.unit }]),
    );
  });

  it("(114b-4a/4d style) refuses a re-digested envelope whose range, e-stop or rate is invalid, via the shared confirmedBodyProblems rules", () => {
    const confirmed = confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision());
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
      expect(() => compileSafetyEnvelope(redigested, register(redigested), verifyRegistry), label).toThrow(reason);
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
    const confirmed = confirmSafetyEnvelope(input, confirmDecision());
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
    const confirmed = confirmSafetyEnvelope(input, confirmDecision());
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
    const confirmed = confirmSafetyEnvelope(input, confirmDecision({ supervision: "remote-supervised", hazards: ["laser"] }));
    expect(confirmed.envelope.supervision).toBe("remote-supervised");
    expect(confirmed.envelope.hazards).toEqual(["laser"]);
  });

  it("refuses a decision with an invalid supervision or hazard", () => {
    const draft = draftSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"));
    expect(() => confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision({ supervision: "sometimes" as unknown as Supervision }))).toThrow(
      /is not attended, unattended or remote-supervised/,
    );
    expect(() => confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision({ hazards: ["radiation"] as unknown as Hazard[] }))).toThrow(
      /unknown hazard/,
    );
  });

  it("compile refuses a re-digested body with an invalid supervision or hazard", () => {
    const confirmed = confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision());

    const badSupervision: SafetyEnvelopeBody = { ...confirmed.envelope, supervision: "sometimes" as unknown as Supervision };
    expect(() => compileRegistered(badSupervision)).toThrow(
      /is not attended, unattended or remote-supervised/,
    );

    const badHazards: SafetyEnvelopeBody = { ...confirmed.envelope, hazards: ["radiation"] as unknown as Hazard[] };
    expect(() => compileRegistered(badHazards)).toThrow(/unknown hazard/);
  });

  it("(114b-5) v1's policy: unattended is a question for a device that moves or heats, and is refused if forced", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.supervision = "unattended";
    const draft = draftSafetyEnvelope(input);
    expect(draft.questions.map((q) => q.about)).toEqual(["supervision"]);
    expect(() => confirmSafetyEnvelope(input, confirmDecision())).toThrow(/unanswered/);

    const confirmed = confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision());
    const bad: SafetyEnvelopeBody = { ...confirmed.envelope, supervision: "unattended" };
    expect(() => compileRegistered(bad)).toThrow(/v1 does not allow unattended operation/);
  });

  it("(114b-5) v1's policy: remote-supervised without an adapter stop is an e-stop question at draft, and unconfirmable", () => {
    const input = fullyAnsweredInput("lab-plate-reader"); // default e-stop: hardware
    input.intake.supervision = "remote-supervised";
    const draft = draftSafetyEnvelope(input);
    const q = draft.questions.find((q) => q.about === "e-stop");
    expect(q).toBeDefined();
    expect(q!.ask).toMatch(/Remote supervision needs a stop the supervisor can trigger remotely/);
    expect(() => confirmSafetyEnvelope(input, confirmDecision())).toThrow(/unanswered/);
  });
});

// ── astra 114b findings (pack 114b, cross-family review) ────────────
// Ports of /mnt/sparkbulk/tmp/sensors/repro/verify-r8-round2.mts. 1b/8-9/10
// exercise compileOperationalEnvelope / OperationalEnvelopeV1Schema and live
// in operational-envelope.test.ts instead.

describe("astra 114b findings", () => {
  const ok = () => confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision());

  it("1a a forged body, self-consistently re-digested, still isn't the registered envelope", () => {
    const confirmed = ok();
    const REGISTERED = register(confirmed);
    const forged: SafetyEnvelopeBody = {
      ...confirmed.envelope,
      limits: confirmed.envelope.limits.map((l) => (l.quantity === "incubation_temperature" ? { ...l, max: l.max + 50 } : l)),
    };
    const forgedDigest = computeSafetyEnvelopeDigest(forged);
    expect(() => compileSafetyEnvelope({ envelope: forged, envelopeDigest: forgedDigest }, REGISTERED, verifyRegistry)).toThrow(
      /not the envelope the registration record committed/,
    );
  });

  it("1c confirmedBy changed after confirmation, with the digest left stale, fails self-consistency first", () => {
    const confirmed = ok();
    const renamed: ConfirmedSafetyEnvelope = {
      envelope: { ...confirmed.envelope, confirmation: { ...confirmed.envelope.confirmation, confirmedBy: "someone-else" } },
      envelopeDigest: confirmed.envelopeDigest, // stale: not recomputed over the changed content
    };
    expect(() => compileSafetyEnvelope(renamed, register(confirmed), verifyRegistry)).toThrow(/changed after it was confirmed/);
  });

  it("1d the genuine envelope against its own registered digest is accepted", () => {
    const confirmed = ok();
    expect(compileOwn(confirmed).envelopeDigest).toBe(confirmed.envelopeDigest);
  });

  it("2a a one-sided reference (max 40), edit 10..50 (loosens): refused without an override", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.limits = input.intake.limits.filter((l) => l.quantity !== "incubation_temperature");
    input.references = [ref({ value: { max: 40 } })];
    const draft = draftSafetyEnvelope(input);
    expect(() =>
      confirmSafetyEnvelope(input, confirmDecision({ edits: [{ quantity: "incubation_temperature", min: 10, max: 50 }] })),
    ).toThrow(/loosens the cited bound/);
  });

  it("2b same edit with an override reason: accepted, sources include operator, reference, override", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.limits = input.intake.limits.filter((l) => l.quantity !== "incubation_temperature");
    input.references = [ref({ value: { max: 40 } })];
    const draft = draftSafetyEnvelope(input);
    const confirmed = confirmSafetyEnvelope(
      input,
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
    const confirmed = confirmSafetyEnvelope(input, confirmDecision({ edits: [{ quantity: "incubation_temperature", min: 10, max: 40 }] }));
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
      confirmSafetyEnvelope(input, confirmDecision({ edits: [{ quantity: "incubation_temperature", min: 15, max: 45 }] })),
    ).toThrow(/loosens the cited bound/);
  });

  it("4a a re-digested body with the unit changed (degC -> K) is refused", () => {
    const confirmed = ok();
    const bad: SafetyEnvelopeBody = {
      ...confirmed.envelope,
      limits: confirmed.envelope.limits.map((l, i) => (i === 0 ? { ...l, unit: "K" as unknown as typeof l.unit } : l)),
    };
    expect(() => compileRegistered(bad)).toThrow(/must be in degC/);
  });

  it("4b a re-digested body with a duplicated limit is refused", () => {
    const confirmed = ok();
    const bad: SafetyEnvelopeBody = {
      ...confirmed.envelope,
      limits: [...confirmed.envelope.limits, { ...confirmed.envelope.limits[0]!, max: confirmed.envelope.limits[0]!.max + 1 }],
    };
    expect(() => compileRegistered(bad)).toThrow(
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
    expect(() => compileRegistered(bad)).toThrow(
      /limits must hold exactly one limit per required quantity/,
    );
  });

  it("4d a body with a blank deviceId is refused: no registration names it, and the shared rules refuse it", () => {
    const confirmed = ok();
    const bad: SafetyEnvelopeBody = { ...confirmed.envelope, device: { ...confirmed.envelope.device, deviceId: " " } };
    expect(() => compileRegistered(bad, "dev-1")).toThrow(/the registration is for another device/);
    expect(confirmedBodyProblems(bad)).toContain("device.deviceId is required");
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
        fullyAnsweredInput("lab-plate-reader"),
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
    expect(() => confirmSafetyEnvelope(input, confirmDecision())).toThrow(/unanswered/);
  });

  it("7c answering with remote-supervised (adapter stop already declared) is accepted", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.eStop = { mechanism: "adapter-stop", stopCommand: "stop" };
    input.intake.supervision = "unattended";
    const draft = draftSafetyEnvelope(input);
    const confirmed = confirmSafetyEnvelope(input, confirmDecision({ supervision: "remote-supervised" }));
    expect(confirmed.envelope.supervision).toBe("remote-supervised");
  });

  it("7d a re-digested unattended body is refused even with a matching digest", () => {
    const confirmed = ok();
    const bad: SafetyEnvelopeBody = { ...confirmed.envelope, supervision: "unattended", eStop: { mechanism: "adapter-stop", stopCommand: "stop" } };
    expect(() => compileRegistered(bad)).toThrow(/v1 does not allow unattended operation/);
  });

  it("the map gap: a command map that sets no read_duration gives a command-map question", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.commandMap = { commands: COMMAND_MAPS["lab-plate-reader"]!.commands.filter((c) => c.name !== "read") };
    const draft = draftSafetyEnvelope(input);
    expect(draft.questions.map((q) => q.about)).toContain("command-map");
    expect(draft.questions.find((q) => q.about === "command-map")?.ask).toMatch(/read_duration/);
  });

  it("(round 4) the deadline (job_duration) needs no parameter: the runtime enforces it as elapsed time", () => {
    // Requiring one only invited a dummy "minutes" parameter (astra pack 153, HIGH 8).
    const input = fullyAnsweredInput("lab-plate-reader");
    input.commandMap = { commands: COMMAND_MAPS["lab-plate-reader"]!.commands.filter((c) => c.name !== "runProtocol") };
    const draft = draftSafetyEnvelope(input);
    expect(draft.questions).toEqual([]);
    const confirmed = confirmSafetyEnvelope(input, confirmDecision());
    expect(confirmed.envelope.limits.map((l) => l.quantity)).toContain("job_duration");
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
  const plate = () => fullyAnsweredInput("lab-plate-reader");
  /** A body changed after confirmation and re-digested, compiled against its own digest, to isolate the shared rules. */
  const redigestedCompile = (mutate: (b: Record<string, any>) => void) => {
    const c = structuredClone(confirmSafetyEnvelope(plate(), confirmDecision())) as unknown as { envelope: Record<string, any>; envelopeDigest: string };
    mutate(c.envelope);
    return () => compileRegistered(c.envelope as unknown as SafetyEnvelopeBody);
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
    expect(withMap((m) => m.commands[0]!.params.push({ name: "note", unbounded: { reason: "  ", allowed: ["x"] } }))).toThrow(/unbounded without a reason/);
  });

  it("confirm: loosening only the MIN side of a cited bound needs an override", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.limits = input.intake.limits.filter((l) => l.quantity !== "incubation_temperature");
    input.references = [ref({ value: { min: 20 } })];
    const draft = draftSafetyEnvelope(input);
    expect(() => confirmSafetyEnvelope(input, confirmDecision({ edits: [{ quantity: "incubation_temperature", min: 10, max: 30 }] }))).toThrow(
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

// ── astra pack 153 (round 3): one observation, signed authority, provenance, a closed command surface ──
// Each first block reproduces the finding at 78c745da (/mnt/sparkbulk/tmp/sensors/repro/repro-r8-153.mts).

describe("astra 153 CRITICAL: what is compiled is exactly what the digest covers", () => {
  const confirmedPlate = () => confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision());

  it("astra's recipe: a sources getter that raises max after canonicalize read it is refused, and never runs", () => {
    const ok = confirmedPlate();
    const registration = register(ok);
    const live = structuredClone(ok) as unknown as { envelope: { limits: Array<Record<string, unknown>> } };
    const limit = live.envelope.limits[0]!;
    const sources = limit.sources;
    let reads = 0;
    Object.defineProperty(limit, "sources", {
      enumerable: true,
      configurable: true,
      get() {
        if (++reads === 2) limit.max = 400;
        return sources;
      },
    });
    expect(() => compileSafetyEnvelope(live as unknown as ConfirmedSafetyEnvelope, registration, verifyRegistry)).toThrow(
      /limits\[0\]\.sources: an accessor .* no code supplied with it may run/,
    );
    expect(reads).toBe(0);
    expect(limit.max).toBe(40);
  });

  it("a proxy anywhere in the envelope is refused before any trap runs", () => {
    const ok = confirmedPlate();
    const live = structuredClone(ok) as unknown as { envelope: Record<string, unknown> };
    let trapped = 0;
    live.envelope.limits = new Proxy(live.envelope.limits as object, {
      get(target, key, receiver) {
        trapped++;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => compileSafetyEnvelope(live as unknown as ConfirmedSafetyEnvelope, register(ok), verifyRegistry)).toThrow(/limits: a proxy/);
    expect(trapped).toBe(0);
  });

  it("an array whose prototype serves an index the array lacks is refused, and the inherited getter never runs", () => {
    const ok = confirmedPlate();
    const live = structuredClone(ok) as unknown as { envelope: { hazards: unknown[] } };
    let ran = false;
    const proto = Object.create(Array.prototype);
    Object.defineProperty(proto, "0", { get: () => ((ran = true), "heat") });
    const hazards: unknown[] = [];
    Object.setPrototypeOf(hazards, proto);
    hazards.length = 1;
    live.envelope.hazards = hazards;
    expect(() => compileSafetyEnvelope(live as unknown as ConfirmedSafetyEnvelope, register(ok), verifyRegistry)).toThrow(
      /hazards: an array with a nonstandard prototype/,
    );
    expect(ran).toBe(false);
  });

  it("a class instance, a function and a hole are not JSON data, and are refused", () => {
    const ok = confirmedPlate();
    const cases: Array<[string, (e: Record<string, any>) => void, RegExp]> = [
      ["a Date", (e) => (e.confirmation.confirmedAt = new Date(0)), /confirmedAt: not a plain object/],
      ["a function", (e) => (e.device.vendor = () => "x"), /vendor: a function is not JSON data/],
      ["a hole", (e) => (e.hazards = Object.assign(new Array(1), {})), /hazards\[0\]: a hole in an array/],
      ["a symbol-free bigint", (e) => (e.maxCommandsPerMinute = 10n), /maxCommandsPerMinute: a bigint is not JSON data/],
    ];
    for (const [label, change, reason] of cases) {
      const live = structuredClone(ok) as unknown as { envelope: Record<string, any> };
      change(live.envelope);
      expect(() => compileSafetyEnvelope(live as unknown as ConfirmedSafetyEnvelope, register(ok), verifyRegistry), label).toThrow(reason);
    }
  });

  it("confirm returns the frozen snapshot it hashed; -0 is hashed and compiled as 0", () => {
    const ok = confirmedPlate();
    expect(Object.isFrozen(ok.envelope)).toBe(true);
    expect(Object.isFrozen(ok.envelope.limits[0])).toBe(true);
    expect(() => {
      (ok.envelope.limits[0] as { max: number }).max = 400;
    }).toThrow(TypeError);
    const zero = structuredClone(ok) as unknown as { envelope: Record<string, any> };
    zero.envelope.limits[2].min = 0;
    const negativeZero = structuredClone(zero);
    negativeZero.envelope.limits[2].min = -0;
    expect(computeSafetyEnvelopeDigest(negativeZero.envelope as SafetyEnvelopeBody)).toBe(computeSafetyEnvelopeDigest(zero.envelope as SafetyEnvelopeBody));
    const body = negativeZero.envelope as SafetyEnvelopeBody;
    const compiled = compileRegistered(body);
    expect(Object.is(compiled.parameters[2]!.min, 0)).toBe(true);
  });

  it("the digest is canonicalize({domain, envelope}), unchanged for plain data", () => {
    const ok = confirmedPlate();
    const expected = "0x" + createHash("sha256").update(canonicalize({ domain: SAFETY_ENVELOPE_DOMAIN, envelope: ok.envelope })).digest("hex");
    expect(ok.envelopeDigest).toBe(expected);
    expect(computeSafetyEnvelopeDigest(structuredClone(ok.envelope) as SafetyEnvelopeBody)).toBe(expected);
  });
});

describe("astra 153 CRITICAL: the copy's other refusals, each with a test of its own", () => {
  const live = () => structuredClone(confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision())) as unknown as { envelope: Record<string, any>; envelopeDigest: string };
  const compileLive = (c: { envelope: Record<string, any>; envelopeDigest: string }) => () =>
    compileSafetyEnvelope(c as unknown as ConfirmedSafetyEnvelope, register(c as unknown as ConfirmedSafetyEnvelope, "dev-1"), verifyRegistry);

  it("an own getter on an array element is refused, and never runs", () => {
    const c = live();
    let ran = false;
    Object.defineProperty(c.envelope.hazards, 0, { enumerable: true, configurable: true, get: () => ((ran = true), "heat") });
    expect(compileLive(c)).toThrow(/hazards\[0\]: an accessor \(a getter or setter\)/);
    expect(ran).toBe(false);
  });

  it("a key named __proto__ is refused (JSON.parse makes it an own key)", () => {
    const c = live();
    c.envelope.device = JSON.parse('{"deviceId":"dev-1","adapterType":"http-plate-reader","adapterVersion":"' + MANIFEST + '","__proto__":{"vendor":"x"}}');
    expect(compileLive(c)).toThrow(/device: a key named __proto__/);
  });

  it("nesting deeper than 64 is refused before it is walked", () => {
    const c = live();
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 70; i++) deep = (deep.next = {}) as Record<string, unknown>;
    c.envelope.device.vendor = root;
    expect(compileLive(c)).toThrow(/nested deeper than 64/);
  });

  it("a cycle is refused", () => {
    const c = live();
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    c.envelope.device.vendor = loop;
    expect(compileLive(c)).toThrow(/vendor\.self: a cycle/);
  });
});

describe("astra 153 MEDIUM references: a registered body that loosens only the MIN side of its cited bound", () => {
  it("is refused without an override, at compile", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.limits = input.intake.limits.filter((l) => l.quantity !== "incubation_temperature");
    input.references = [ref({ value: { min: 20 } })];
    const confirmed = confirmSafetyEnvelope(
      input,
      confirmDecision({ edits: [{ quantity: "incubation_temperature", min: 10, max: 30, override: { reason: "validated at 10 degC" } }] }),
    );
    const body = structuredClone(confirmed.envelope) as unknown as Record<string, any>;
    body.limits[0].sources = body.limits[0].sources.filter((s: { kind: string }) => s.kind !== "override");
    expect(() => compileRegistered(body as unknown as SafetyEnvelopeBody)).toThrow(/loosens the cited bound at least 20 degC, so it must carry exactly one override/);
  });
});

describe("astra 153 CRITICAL: building the snapshot runs no inherited setter, and the check is Node's", () => {
  it("a setter on Array.prototype[0] never runs while the envelope is copied, and cannot substitute a value", () => {
    const ok = confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision());
    const registration = register(ok);
    let ran = false;
    let compiled: ReturnType<typeof compileSafetyEnvelope> | undefined;
    Object.defineProperty(Array.prototype, "0", {
      configurable: true,
      set(this: unknown[]) {
        ran = true;
        Object.defineProperty(this, "0", { value: "substituted", writable: true, enumerable: true, configurable: true });
      },
    });
    try {
      compiled = compileSafetyEnvelope(structuredClone(ok) as ConfirmedSafetyEnvelope, registration, verifyRegistry);
    } finally {
      delete (Array.prototype as unknown as Record<string, unknown>)["0"];
    }
    expect(ran).toBe(false);
    expect(compiled!.parameters[0]).toMatchObject({ key: "incubationTemperature", min: 20, max: 40 });
  });

  it("safety-envelope.ts has no static node:util import (the dashboard's browser build has no node:util)", () => {
    const source = readFileSync(fileURLToPath(new URL("../onboarding/safety-envelope.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/from\s+["']node:util["']|require\(\s*["']node:util["']\s*\)/);
  });

  it("without a trap-free proxy check (a browser, or Node before 20.16), compile refuses rather than copy unchecked", async () => {
    const ok = confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision());
    const registration = register(ok);
    const runtime = process as unknown as { getBuiltinModule?: unknown };
    const original = runtime.getBuiltinModule;
    runtime.getBuiltinModule = undefined;
    try {
      vi.resetModules();
      const fresh = await import("../onboarding/safety-envelope.js");
      expect(() => fresh.compileSafetyEnvelope(structuredClone(ok) as ConfirmedSafetyEnvelope, registration, verifyRegistry)).toThrow(
        /no trap-free proxy check/,
      );
    } finally {
      runtime.getBuiltinModule = original;
      vi.resetModules();
    }
  });
});

describe("astra 153 HIGH authority: only the registry's signature makes a digest a confirmation", () => {
  const ok = () => confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision());

  it("astra's recipe: a self-built body with its own digest, registered under a key that is not the registry's, is refused", () => {
    const built = structuredClone(ok()) as unknown as ConfirmedSafetyEnvelope & { envelope: Record<string, any> };
    built.envelope.limits[0].max = 90;
    built.envelopeDigest = computeSafetyEnvelopeDigest(built.envelope as SafetyEnvelopeBody);
    const attacker = generateKeyPairSync("ed25519");
    const statement = { deviceId: "dev-1", envelopeDigest: built.envelopeDigest, registeredAt: "2026-02-01T00:05:00Z" };
    const selfSigned = { ...statement, signature: Buffer.from(sign(null, registrationSigningPreimage(statement), attacker.privateKey)).toString("hex") };
    expect(() => compileSafetyEnvelope(built, selfSigned, verifyRegistry)).toThrow(/signature does not verify against the registry's key/);
  });

  it("the old call shape (a bare digest as the registration) is refused", () => {
    const c = ok();
    expect(() => compileSafetyEnvelope(c, c.envelopeDigest as unknown as SafetyEnvelopeRegistration, verifyRegistry)).toThrow(EnvelopeRefused);
  });

  it("a registration for another device, or another digest, is refused even when its signature is the registry's", () => {
    const c = ok();
    expect(() => compileSafetyEnvelope(c, register(c, "dev-2"), verifyRegistry)).toThrow(/the registration is for another device/);
    const other = confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision({ confirmedBy: "someone@example.com" }));
    expect(() => compileSafetyEnvelope(c, register(other), verifyRegistry)).toThrow(/not the envelope the registration record committed/);
  });

  it("a missing verifier, a verifier that throws, and one that answers 1 instead of true are all refused", () => {
    const c = ok();
    const r = register(c);
    expect(() => compileSafetyEnvelope(c, r, undefined as unknown as RegistrationVerifier)).toThrow(/a registration verifier .* is required/);
    expect(() =>
      compileSafetyEnvelope(c, r, () => {
        throw new Error("hsm offline");
      }),
    ).toThrow(/does not verify/);
    expect(() => compileSafetyEnvelope(c, r, (() => 1) as unknown as RegistrationVerifier)).toThrow(/does not verify/);
  });

  it("a malformed signature or registeredAt is refused before the verifier is asked", () => {
    const c = ok();
    let asked = 0;
    const counting: RegistrationVerifier = (p, s) => (asked++, verifyRegistry(p, s));
    expect(() => compileSafetyEnvelope(c, { ...register(c), signature: "ab".repeat(63) }, counting)).toThrow(/not an Ed25519 signature/);
    expect(() => compileSafetyEnvelope(c, { ...register(c), registeredAt: "soon" }, counting)).toThrow(/registeredAt must be an ISO-8601 time/);
    expect(asked).toBe(0);
  });

  it("a statement without a deviceId, or with a malformed digest or time, has no digest to sign", () => {
    const c = ok();
    const statement = { deviceId: "dev-1", envelopeDigest: c.envelopeDigest, registeredAt: "2026-02-01T00:05:00Z" };
    expect(() => registrationStatementDigest({ ...statement, deviceId: " " })).toThrow(/the registration needs the deviceId/);
    expect(() => registrationSigningPreimage({ ...statement, envelopeDigest: "0x12" as `0x${string}` })).toThrow(/envelopeDigest must be 0x \+ 64 lowercase hex/);
    expect(() => registrationStatementDigest({ ...statement, registeredAt: "later" })).toThrow(/registeredAt must be an ISO-8601 time/);
  });

  it("the registry signs LO-EV-1's preimage: the UTF-8 of the domain-separated statement digest", () => {
    const c = ok();
    const statement = { deviceId: "dev-1", envelopeDigest: c.envelopeDigest, registeredAt: "2026-02-01T00:05:00Z" };
    const digest = "sha256:" + createHash("sha256").update(canonicalize({ domain: "PCC:safety-envelope-registration:v1", ...statement })).digest("hex");
    const preimage = registrationSigningPreimage(statement);
    expect(Buffer.from(preimage).toString("utf8")).toBe(digest);
    expect(preimage).toHaveLength(71);
  });

  it("a registry signature over a different statement (here, the bare envelope digest) cannot be replayed as a registration", () => {
    const c = ok();
    const tagged = `sha256:${c.envelopeDigest.slice(2)}`;
    const signature = Buffer.from(sign(null, Buffer.from(tagged, "utf8"), REGISTRY.privateKey)).toString("hex");
    const replay = { deviceId: "dev-1", envelopeDigest: c.envelopeDigest, registeredAt: "2026-02-01T00:05:00Z", signature };
    expect(() => compileSafetyEnvelope(c, replay, verifyRegistry)).toThrow(/does not verify/);
  });

  it("a genuine registration compiles, and the output names the registered digest", () => {
    const c = ok();
    expect(compileSafetyEnvelope(c, register(c), verifyRegistry).envelopeDigest).toBe(c.envelopeDigest);
  });
});

describe("astra 153 MEDIUM references: provenance is a rule of every confirmed body", () => {
  const oneSided = () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.intake.limits = input.intake.limits.filter((l) => l.quantity !== "incubation_temperature");
    input.references = [ref({ value: { max: 40 } })];
    return input;
  };

  it("astra's recipe: emptying a draft's referenceBounds changes nothing, since confirm drafts again from the input", () => {
    const input = oneSided();
    const draft = draftSafetyEnvelope(input);
    (draft as { referenceBounds: unknown[] }).referenceBounds = [];
    expect(() =>
      confirmSafetyEnvelope(input, confirmDecision({ edits: [{ quantity: "incubation_temperature", min: 10, max: 50 }] })),
    ).toThrow(/loosens the cited bound at most 40 degC; an override needs a reason/);
  });

  /** A registered body built from the override-carrying confirmation, changed by `change`. */
  const overridden = () =>
    confirmSafetyEnvelope(
      oneSided(),
      confirmDecision({ edits: [{ quantity: "incubation_temperature", min: 10, max: 50, override: { reason: "service note 17" } }] }),
    );
  const changedBody = (change: (limit: Record<string, any>) => void) => {
    const body = structuredClone(overridden().envelope) as unknown as Record<string, any>;
    change(body.limits[0]);
    return body as unknown as SafetyEnvelopeBody;
  };

  it("the override-carrying confirmation compiles", () => {
    expect(compileOwn(overridden()).parameters[0]).toMatchObject({ min: 10, max: 50 });
  });

  it("a registered body that drops the override from a loosening limit is refused", () => {
    const body = changedBody((l) => (l.sources = l.sources.filter((s: { kind: string }) => s.kind !== "override")));
    expect(() => compileRegistered(body)).toThrow(/loosens the cited bound at most 40 degC, so it must carry exactly one override/);
  });

  it("an override naming other citations, an override on a limit that loosens nothing, and two operator sources are refused", () => {
    expect(() =>
      compileRegistered(changedBody((l) => (l.sources[2].overrides = [{ doc: "Some other manual", section: "1" }]))),
    ).toThrow(/the override must name exactly the cited references, in order/);
    expect(() => compileRegistered(changedBody((l) => (l.max = 40)))).toThrow(/an override is recorded, but 10\.\.40 degC loosens no cited bound/);
    expect(() =>
      compileRegistered(changedBody((l) => l.sources.unshift({ kind: "operator", field: "safety.limits" }))),
    ).toThrow(/names exactly one operator source/);
  });

  it("a reference-proposed limit must be exactly its cited bound, from references alone", () => {
    const input = emptyInput("lab-plate-reader");
    input.commandMap = COMMAND_MAPS["lab-plate-reader"];
    input.references = [ref()];
    const decision = confirmDecision({
      edits: [
        { quantity: "read_duration", min: 1, max: 300 },
        { quantity: "job_duration", min: 1, max: 120 },
      ],
      eStop: { mechanism: "hardware" },
      maxCommandsPerMinute: 10,
      supervision: "attended",
      hazards: ["heat"],
    });
    const confirmed = confirmSafetyEnvelope(input, decision);
    expect(confirmed.envelope.limits[0]!.proposedBy).toBe("reference");
    const widened = structuredClone(confirmed.envelope) as unknown as Record<string, any>;
    widened.limits[0].max = 46;
    expect(() => compileRegistered(widened as unknown as SafetyEnvelopeBody)).toThrow(/must be exactly the bound its references cite \(15\.\.45 degC\), not 15\.\.46 degC/);
    const withOperator = structuredClone(confirmed.envelope) as unknown as Record<string, any>;
    withOperator.limits[0].sources.push({ kind: "operator", field: "x" });
    expect(() => compileRegistered(withOperator as unknown as SafetyEnvelopeBody)).toThrow(/must come from references alone/);
  });

  it("malformed sources are refused: none, an unknown kind, a reference in another unit, a bad value, an extra key", () => {
    const cases: Array<[string, (l: Record<string, any>) => void, RegExp]> = [
      ["no sources", (l) => (l.sources = []), /a limit must name its sources/],
      ["unknown kind", (l) => l.sources.push({ kind: "agent", note: "x" }), /a source of kind "agent" is not operator, reference or override/],
      ["unit", (l) => (l.sources[1].unit = "K"), /a reference source must cite the limit's unit degC/],
      ["value", (l) => (l.sources[1].value = { min: 5, max: 1 }), /a reference source gives min 5 above max 1/],
      ["value key", (l) => (l.sources[1].value = { max: 40, typ: 37 }), /a reference source's value holds only min and max/],
      ["extra key", (l) => (l.sources[1].page = 4), /a reference source holds only kind, citation/],
      ["citation", (l) => (l.sources[1].citation = { doc: "Datasheet Rev C" }), /a reference source has a citation without a doc and a section/],
      ["citation key", (l) => (l.sources[1].citation = { doc: "Datasheet Rev C", section: "4.2", page: 7 }), /a reference source has a citation that is not exactly \{doc, section, url\?\}/],
      ["claim", (l) => (l.sources[1].claim = " "), /a reference source needs its claim/],
      ["retrievedAt", (l) => (l.sources[1].retrievedAt = "yesterday"), /a reference source needs a valid retrievedAt/],
      ["override reason", (l) => (l.sources[2].reason = ""), /an override needs the operator's reason/],
      ["operator field", (l) => (l.sources[0].field = ""), /an operator source needs the field it answered/],
    ];
    for (const [label, change, reason] of cases) {
      expect(() => compileRegistered(changedBody(change)), label).toThrow(reason);
    }
  });

  it("a reference without a claim, or with a blank url, is dropped at draft", () => {
    const input = emptyInput("lab-plate-reader");
    input.references = [ref({ claim: " " }), ref({ citation: { doc: "Manual", section: "2", url: "" } })];
    const draft = draftSafetyEnvelope(input);
    expect(draft.limits).toHaveLength(0);
    expect(draft.dropped.map((d) => d.reason)).toEqual(["a reference from Datasheet Rev C states no claim", "a reference from Manual has a blank url"]);
  });
});

describe("astra 153 HIGH 8: no free-form parameter, and the adapter is named by its manifest digest", () => {
  it("astra's recipe: an opaque unbounded payload plus dummy parameters is refused", () => {
    const input = fullyAnsweredInput("lab-plate-reader");
    input.commandMap = {
      commands: [
        { name: "rawCommand", params: [{ name: "payload", unbounded: "device-specific" as unknown as { reason: string; allowed: string[] } }] },
        ...COMMAND_MAPS["lab-plate-reader"]!.commands,
      ],
    };
    expect(() => draftSafetyEnvelope(input)).toThrow(/rawCommand\.payload is unbounded, so it must be exactly \{reason, allowed\?, allowedItems\?\}/);
  });

  it("an unbounded parameter must list distinct non-blank strings or finite numbers, and nothing else", () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["no allowed", { reason: "a slot" }, /must list the values it may carry \(allowed, or allowedItems for a list\)/],
      ["empty allowed", { reason: "a slot", allowed: [] }, /allowed must list the values it may carry/],
      ["empty allowedItems", { reason: "a slot", allowedItems: [] }, /allowedItems must list the values it may carry/],
      ["a duplicate", { reason: "a slot", allowed: [1, 2, 1] }, /the allowed value 1 is listed twice/],
      ["a duplicate item", { reason: "wells", allowedItems: ["A1", "A1"] }, /the allowedItems value "A1" is listed twice/],
      ["an object item", { reason: "wells", allowedItems: [{ row: "A" }] }, /every allowedItems value must be a non-blank string or a finite number/],
      ["an object", { reason: "a slot", allowed: [{ any: true }] }, /every allowed value must be a non-blank string or a finite number/],
      ["a blank string", { reason: "a slot", allowed: [" "] }, /every allowed value must be a non-blank string or a finite number/],
      ["a boolean", { reason: "a slot", allowed: [true] }, /every allowed value must be a non-blank string or a finite number/],
      ["an extra key", { reason: "a slot", allowed: [1], pattern: ".*" }, /must be exactly \{reason, allowed\?, allowedItems\?\}/],
    ];
    for (const [label, unbounded, reason] of cases) {
      const input = fullyAnsweredInput("lab-plate-reader");
      const map = structuredClone(COMMAND_MAPS["lab-plate-reader"]!) as CommandMapV1;
      map.commands[0]!.params.push({ name: "slot", unbounded: unbounded as { reason: string; allowed: number[] } });
      input.commandMap = map;
      expect(() => draftSafetyEnvelope(input), label).toThrow(reason);
    }
    const distinctTypes = fullyAnsweredInput("lab-plate-reader");
    const map = structuredClone(COMMAND_MAPS["lab-plate-reader"]!) as CommandMapV1;
    map.commands[0]!.params.push({ name: "slot", unbounded: { reason: "a slot", allowed: [1, "1"] } });
    distinctTypes.commandMap = map;
    expect(() => draftSafetyEnvelope(distinctTypes)).not.toThrow();
    const wells = fullyAnsweredInput("lab-plate-reader");
    const wellsMap = structuredClone(COMMAND_MAPS["lab-plate-reader"]!) as CommandMapV1;
    wellsMap.commands[1]!.params.push({ name: "wells", unbounded: { reason: "plate wells", allowed: ["all"], allowedItems: ["A1", "B1", "H12"] } });
    wells.commandMap = wellsMap;
    expect(draftSafetyEnvelope(wells).questions).toEqual([]);
  });

  it("a registered body whose adapterVersion is not a manifest digest is refused", () => {
    const body = structuredClone(confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision()).envelope) as unknown as Record<string, any>;
    body.device.adapterVersion = "1.0.0";
    expect(() => compileRegistered(body as unknown as SafetyEnvelopeBody)).toThrow(/adapterVersion must be the adapter's manifest digest/);
  });
});

describe("astra 153: every shape is closed, so nothing is committed and then ignored", () => {
  const body = () => structuredClone(confirmSafetyEnvelope(fullyAnsweredInput("lab-plate-reader"), confirmDecision()).envelope) as unknown as Record<string, any>;
  const cases: Array<[string, (b: Record<string, any>) => void, RegExp]> = [
    ["body", (b) => (b.defaults = { maxTemperature: 300 }), /the envelope holds keys it does not define: defaults/],
    ["limit", (b) => (b.limits[0].fallback = 1), /a limit holds only quantity/],
    ["device", (b) => (b.device.firmware = "2.0"), /device holds only deviceId, adapterType, adapterVersion, vendor and model/],
    ["device vendor", (b) => (b.device.vendor = " "), /device\.vendor, when given, must not be blank/],
    ["device model", (b) => (b.device.model = " "), /device\.model, when given, must not be blank/],
    ["device adapterType", (b) => (b.device.adapterType = " "), /device\.adapterType is required/],
    ["confirmation", (b) => (b.confirmation.session = "abc"), /confirmation holds only confirmedBy and confirmedAt/],
    ["e-stop", (b) => (b.eStop.note = "red button"), /eStop holds only its mechanism/],
    ["command map", (b) => (b.commandMap.version = 2), /the command map holds only commands/],
    ["command", (b) => (b.commandMap.commands[0].raw = true), /has keys other than name and params/],
    ["parameter", (b) => (b.commandMap.commands[0].params[0].scale = 10), /has keys other than name, quantity, unit and unbounded/],
  ];
  for (const [label, change, reason] of cases) {
    it(`refuses an extra key in the ${label}`, () => {
      const b = body();
      change(b);
      expect(() => compileRegistered(b as unknown as SafetyEnvelopeBody)).toThrow(reason);
    });
  }
});
