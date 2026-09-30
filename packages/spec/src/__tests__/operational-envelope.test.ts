/**
 * Tests for onboarding/operational-envelope.ts: the runtime envelope the
 * kernel's governor and pcc-node enforce. Strict: no defaults, limits keyed
 * by quantity, numbers only, 0 is a bound (bus #4074 G1-G4).
 */

import { describe, it, expect } from "vitest";
import {
  compileOperationalEnvelope,
  OperationalEnvelopeV1Schema,
  type OperationalEnvelopeV1,
} from "../onboarding/operational-envelope.js";
import {
  computeSafetyEnvelopeDigest,
  confirmSafetyEnvelope,
  draftSafetyEnvelope,
  EnvelopeRefused,
  type ConfirmedSafetyEnvelope,
} from "../onboarding/safety-envelope.js";

const AT = "2026-09-29T20:00:00Z";

function confirmedOt2(): ConfirmedSafetyEnvelope {
  const draft = draftSafetyEnvelope({
    deviceClass: "liquid-handler-ot2",
    device: { deviceId: "ot2-sim-1", adapterType: "opentrons" },
    intake: {
      limits: [
        { field: "q1", quantity: "aspirate_volume", unit: "uL", min: 1, max: 300 },
        { field: "q2", quantity: "module_temperature", unit: "degC", min: 4, max: 95 },
        { field: "q3", quantity: "run_duration", unit: "min", min: 0, max: 120 },
      ],
      eStop: { mechanism: "adapter-stop", stopCommand: "POST /runs/{id}/actions stop" },
      supervision: "attended",
      hazards: ["heat", "mechanical"],
      maxCommandsPerMinute: 60,
    },
    references: [],
  });
  return confirmSafetyEnvelope(draft, { confirmedBy: "op-1", confirmedAt: AT });
}

function confirmedPlateReader(): ConfirmedSafetyEnvelope {
  const draft = draftSafetyEnvelope({
    deviceClass: "lab-plate-reader",
    device: { deviceId: "pr-sim-1", adapterType: "generic-http" },
    intake: {
      limits: [
        { field: "t", quantity: "incubation_temperature", unit: "degC", min: 20, max: 45 },
        { field: "d", quantity: "read_duration", unit: "s", min: 1, max: 600 },
      ],
      eStop: { mechanism: "hardware", stopCommand: "ignored for hardware" },
      supervision: "unattended",
      hazards: ["heat"],
      maxCommandsPerMinute: 30,
    },
    references: [],
  });
  return confirmSafetyEnvelope(draft, { confirmedBy: "op-1", confirmedAt: AT });
}

/** A copy of `env` changed by `mutate`, and the schema's verdict on it. */
function parseChanged(env: OperationalEnvelopeV1, mutate: (e: any) => void) {
  const e = structuredClone(env) as any;
  mutate(e);
  return OperationalEnvelopeV1Schema.safeParse(e);
}

function messages(r: ReturnType<typeof parseChanged>): string {
  return r.success ? "" : r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ");
}

/** Re-digest a changed body, as someone who can recompute the digest would. */
function redigested(c: ConfirmedSafetyEnvelope, mutate: (body: any) => void): ConfirmedSafetyEnvelope {
  const copy = structuredClone(c) as any;
  mutate(copy.envelope);
  copy.envelopeDigest = computeSafetyEnvelopeDigest(copy.envelope);
  return copy;
}

describe("compileOperationalEnvelope: the confirmed envelope, projected for the runtime", () => {
  it("carries every confirmed limit by quantity, the rate, the stop and the digest", () => {
    const c = confirmedOt2();
    const rt = compileOperationalEnvelope(c);
    expect(rt).toEqual({
      envelopeVersion: 1,
      envelopeDigest: c.envelopeDigest,
      deviceClass: "liquid-handler-ot2",
      deviceId: "ot2-sim-1",
      adapterType: "opentrons",
      strict: true,
      limits: [
        { quantity: "aspirate_volume", unit: "uL", min: 1, max: 300 },
        { quantity: "module_temperature", unit: "degC", min: 4, max: 95 },
        { quantity: "run_duration", unit: "min", min: 0, max: 120 },
      ],
      maxCommandsPerMinute: 60,
      eStop: { mechanism: "adapter-stop", stopCommand: "POST /runs/{id}/actions stop" },
      supervision: "attended",
      hazards: ["heat", "mechanical"],
    });
    expect(OperationalEnvelopeV1Schema.safeParse(rt).success).toBe(true);
  });

  it("drops a stop command a hardware stop does not use", () => {
    const rt = compileOperationalEnvelope(confirmedPlateReader());
    expect(rt.eStop).toEqual({ mechanism: "hardware" });
    expect(rt.limits.map((l) => l.quantity)).toEqual(["incubation_temperature", "read_duration"]);
  });

  it("refuses an envelope changed after confirmation", () => {
    const c = structuredClone(confirmedOt2());
    c.envelope.limits[0]!.max = 3000;
    expect(() => compileOperationalEnvelope(c)).toThrow(/changed after it was confirmed/);
  });

  it("refuses a re-digested body the schema refuses, with reasons, not a TypeError", () => {
    const c = confirmedOt2();
    const cases: Array<[string, (b: any) => void, RegExp]> = [
      ["limits not an array", (b) => (b.limits = "x"), /limits: Expected array/],
      ["e-stop none on a device that moves", (b) => (b.eStop = { mechanism: "none" }), /eStop\.mechanism: .*needs an e-stop/],
      ["adapter stop without its command", (b) => delete b.eStop.stopCommand, /eStop\.stopCommand/],
      ["a limit in another unit", (b) => (b.limits[0].unit = "mL"), /aspirate_volume is in uL/],
      ["a required quantity missing", (b) => b.limits.splice(1, 1), /module_temperature has no limit/],
      ["a device with no id", (b) => delete b.device, /deviceId/],
    ];
    for (const [label, mutate, reason] of cases) {
      let caught: unknown;
      try {
        compileOperationalEnvelope(redigested(c, mutate));
      } catch (e) {
        caught = e;
      }
      expect(caught, label).toBeInstanceOf(EnvelopeRefused);
      expect((caught as EnvelopeRefused).reasons.join("; "), label).toMatch(reason);
    }
  });

  it("refuses a device class that has no template", () => {
    const c = redigested(confirmedOt2(), (b) => (b.deviceClass = "unknown-robot"));
    expect(() => compileOperationalEnvelope(c)).toThrow(/unknown deviceClass/);
  });

  it("refuses a re-digested body whose hazards are listed twice", () => {
    const c = redigested(confirmedPlateReader(), (b) => (b.hazards = ["heat", "heat"]));
    expect(() => compileOperationalEnvelope(c)).toThrow(/listed twice/);
  });

  it("refuses hazards out of canonical order, which confirm never produces", () => {
    const c = redigested(confirmedOt2(), (b) => (b.hazards = ["mechanical", "heat"]));
    expect(() => compileOperationalEnvelope(c)).toThrow(/canonical order/);
    const rt = compileOperationalEnvelope(confirmedOt2());
    expect(messages(parseChanged(rt, (e) => (e.hazards = ["mechanical", "heat"])))).toMatch(/hazards must be in canonical order/);
  });
});

describe("OperationalEnvelopeV1Schema: strict, no defaults", () => {
  const rt = compileOperationalEnvelope(confirmedOt2());

  it("refuses a numeric string, NaN, Infinity, and min above max (G4)", () => {
    expect(messages(parseChanged(rt, (e) => (e.limits[0].max = "300")))).toMatch(/limits\.0\.max Expected number, received string/);
    expect(parseChanged(rt, (e) => (e.limits[0].min = NaN)).success).toBe(false);
    expect(parseChanged(rt, (e) => (e.limits[0].max = Infinity)).success).toBe(false);
    expect(messages(parseChanged(rt, (e) => (e.limits[0].min = 500)))).toMatch(/min must not be above max/);
  });

  it("takes 0 as a bound like any other (G1)", () => {
    const r = parseChanged(rt, (e) => {
      e.limits[1].min = 0;
      e.limits[1].max = 0;
    });
    expect(r.success).toBe(true);
  });

  it("refuses a quantity bounded twice, a missing required quantity, and the wrong unit (G3)", () => {
    expect(messages(parseChanged(rt, (e) => e.limits.push({ ...e.limits[0], max: 10 })))).toMatch(/aspirate_volume is bounded twice/);
    expect(messages(parseChanged(rt, (e) => e.limits.splice(2, 1)))).toMatch(/run_duration has no limit/);
    expect(messages(parseChanged(rt, (e) => (e.limits[2].unit = "h")))).toMatch(/run_duration is in min/);
    expect(parseChanged(rt, (e) => (e.limits[0].unit = "rpm")).success).toBe(false);
    expect(parseChanged(rt, (e) => (e.limits = [])).success).toBe(false);
  });

  it("refuses a missing or lenient mode, extra fields, and a bad rate (G2)", () => {
    expect(parseChanged(rt, (e) => (e.strict = false)).success).toBe(false);
    expect(parseChanged(rt, (e) => delete e.strict).success).toBe(false);
    expect(messages(parseChanged(rt, (e) => (e.defaults = { maxTemperature: 300 })))).toMatch(/Unrecognized key/);
    expect(messages(parseChanged(rt, (e) => (e.limits[0].fallback = 1)))).toMatch(/Unrecognized key/);
    for (const rate of [0, -1, 1.5, "60"]) {
      expect(parseChanged(rt, (e) => (e.maxCommandsPerMinute = rate)).success, String(rate)).toBe(false);
    }
    expect(parseChanged(rt, (e) => delete e.maxCommandsPerMinute).success).toBe(false);
  });

  it("refuses invalid supervision or hazards, and accepts an empty hazards list", () => {
    expect(parseChanged(rt, (e) => (e.supervision = "sometimes")).success).toBe(false);
    expect(parseChanged(rt, (e) => delete e.supervision).success).toBe(false);
    expect(parseChanged(rt, (e) => (e.hazards = ["radiation"])).success).toBe(false);
    expect(messages(parseChanged(rt, (e) => (e.hazards = ["heat", "heat"])))).toMatch(/listed twice/);
    expect(parseChanged(rt, (e) => delete e.hazards).success).toBe(false);
    expect(parseChanged(rt, (e) => (e.hazards = [])).success).toBe(true);
  });

  it("refuses a stop that cannot stop the device", () => {
    expect(messages(parseChanged(rt, (e) => (e.eStop = { mechanism: "none" })))).toMatch(/needs an e-stop/);
    const unknownNone = parseChanged(rt, (e) => {
      e.deviceClass = "unknown-robot";
      e.eStop = { mechanism: "none" };
    });
    expect(messages(unknownNone)).toMatch(/needs an e-stop/);
    expect(messages(parseChanged(rt, (e) => (e.eStop.stopCommand = "  ")))).toMatch(/must not be blank/);
    expect(parseChanged(rt, (e) => (e.eStop = { mechanism: "hardware", stopCommand: "x" })).success).toBe(false);
    expect(parseChanged(rt, (e) => (e.eStop = { mechanism: "soft" })).success).toBe(false);
  });

  it("refuses a malformed digest and blank identities", () => {
    expect(messages(parseChanged(rt, (e) => (e.envelopeDigest = "0x" + "AB".repeat(32))))).toMatch(/lowercase hex/);
    expect(parseChanged(rt, (e) => (e.envelopeDigest = "0x1234")).success).toBe(false);
    expect(parseChanged(rt, (e) => (e.deviceId = " ")).success).toBe(false);
    expect(parseChanged(rt, (e) => (e.adapterType = "")).success).toBe(false);
  });

  it("checks only generic rules for a class with no template, and still needs a stop", () => {
    const r = parseChanged(rt, (e) => {
      e.deviceClass = "unknown-robot";
      e.limits = [{ quantity: "spindle_speed", unit: "m/s", min: 0, max: 2 }];
    });
    expect(r.success).toBe(true);
  });

  it("refuses an unbounded side: -Infinity min, or no limits at all for a class with no template", () => {
    expect(parseChanged(rt, (e) => (e.limits[0].min = -Infinity)).success).toBe(false);
    const empty = parseChanged(rt, (e) => {
      e.deviceClass = "unknown-robot";
      e.limits = [];
    });
    expect(messages(empty)).toMatch(/limits Array must contain at least 1/);
  });
});

describe("compileOperationalEnvelope: the projection carries only what the runtime enforces", () => {
  it("drops a stray stop command from a re-digested hardware e-stop", () => {
    const c = redigested(confirmedPlateReader(), (b) => (b.eStop = { mechanism: "hardware", stopCommand: "POST /halt" }));
    expect(compileOperationalEnvelope(c).eStop).toEqual({ mechanism: "hardware" });
  });
});
