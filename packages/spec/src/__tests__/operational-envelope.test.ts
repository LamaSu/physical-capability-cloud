/**
 * Tests for onboarding/operational-envelope.ts: the runtime envelope the
 * kernel's governor and pcc-node enforce. Strict: no defaults, limits keyed
 * by quantity in exact template order, numbers only, 0 is a bound, the
 * command surface is closed (bus #4074 G1-G4).
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
  type CommandMapV1,
  type ConfirmedSafetyEnvelope,
} from "../onboarding/safety-envelope.js";

const AT = "2026-09-29T20:00:00Z";

const OT2_MAP: CommandMapV1 = {
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
};

const PLATE_MAP: CommandMapV1 = {
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
};

function confirmedOt2(): ConfirmedSafetyEnvelope {
  const draft = draftSafetyEnvelope({
    deviceClass: "liquid-handler-ot2",
    device: { deviceId: "ot2-sim-1", adapterType: "opentrons", adapterVersion: "2.1.0" },
    commandMap: OT2_MAP,
    intake: {
      limits: [
        { field: "q1", quantity: "aspirate_volume", unit: "uL", min: 1, max: 300 },
        { field: "q1b", quantity: "dispense_volume", unit: "uL", min: 1, max: 300 },
        { field: "q2", quantity: "module_temperature", unit: "degC", min: 4, max: 95 },
        { field: "q3", quantity: "run_duration", unit: "min", min: 0, max: 120 },
      ],
      eStop: { mechanism: "adapter-stop", stopCommand: "stop" },
      supervision: "attended",
      hazards: ["heat", "mechanical"],
      maxCommandsPerMinute: 60,
    },
    references: [],
  });
  return confirmSafetyEnvelope(draft, { confirmedBy: "op-1", confirmedAt: AT });
}

/** attended, not unattended: a device that moves or heats cannot run unattended in v1. */
function confirmedPlateReader(): ConfirmedSafetyEnvelope {
  const draft = draftSafetyEnvelope({
    deviceClass: "lab-plate-reader",
    device: { deviceId: "pr-sim-1", adapterType: "generic-http", adapterVersion: "1.0.0" },
    commandMap: PLATE_MAP,
    intake: {
      limits: [
        { field: "t", quantity: "incubation_temperature", unit: "degC", min: 20, max: 45 },
        { field: "d", quantity: "read_duration", unit: "s", min: 1, max: 600 },
        { field: "j", quantity: "job_duration", unit: "min", min: 1, max: 120 },
      ],
      eStop: { mechanism: "hardware" },
      supervision: "attended",
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
  it("carries every confirmed limit by quantity, the rate, the stop, the command map and the digest", () => {
    const c = confirmedOt2();
    const rt = compileOperationalEnvelope(c, c.envelopeDigest);
    expect(rt).toEqual({
      envelopeVersion: 1,
      envelopeDigest: c.envelopeDigest,
      deviceClass: "liquid-handler-ot2",
      deviceId: "ot2-sim-1",
      adapterType: "opentrons",
      adapterVersion: "2.1.0",
      strict: true,
      limits: [
        { quantity: "aspirate_volume", unit: "uL", min: 1, max: 300 },
        { quantity: "dispense_volume", unit: "uL", min: 1, max: 300 },
        { quantity: "module_temperature", unit: "degC", min: 4, max: 95 },
        { quantity: "run_duration", unit: "min", min: 0, max: 120 },
      ],
      commands: OT2_MAP.commands,
      deadlineQuantity: "run_duration",
      maxCommandsPerMinute: 60,
      eStop: { mechanism: "adapter-stop", stopCommand: "stop" },
      supervision: "attended",
      hazards: ["heat", "mechanical"],
    });
    expect(OperationalEnvelopeV1Schema.safeParse(rt).success).toBe(true);
  });

  it("drops a stop command a hardware stop does not use, and names the plate reader's own deadline", () => {
    const c = confirmedPlateReader();
    const rt = compileOperationalEnvelope(c, c.envelopeDigest);
    expect(rt.eStop).toEqual({ mechanism: "hardware" });
    expect(rt.limits.map((l) => l.quantity)).toEqual(["incubation_temperature", "read_duration", "job_duration"]);
    expect(rt.deadlineQuantity).toBe("job_duration");
  });

  it("refuses an envelope changed after confirmation", () => {
    const c = structuredClone(confirmedOt2());
    c.envelope.limits[0]!.max = 3000;
    expect(() => compileOperationalEnvelope(c, c.envelopeDigest)).toThrow(/changed after it was confirmed/);
  });

  it("refuses a re-digested body confirmedBodyProblems would refuse, before ever reaching the runtime schema (10)", () => {
    const c = confirmedOt2();
    const cases: Array<[string, (b: any) => void, RegExp]> = [
      ["a limit in another unit", (b) => (b.limits[0].unit = "mL"), /aspirate_volume must be in uL/],
      ["a required quantity missing", (b) => b.limits.splice(1, 1), /limits must hold exactly one limit per required quantity/],
      [
        "adapter stop naming an undeclared command",
        (b) => (b.eStop = { mechanism: "adapter-stop", stopCommand: "nonexistent" }),
        /not one of the adapter's declared commands/,
      ],
      [
        "a command map gap",
        (b) => (b.commandMap = { commands: b.commandMap.commands.filter((cmd: any) => cmd.name !== "runProtocol") }),
        /commandMap: no declared parameter sets run_duration/,
      ],
      ["a device with a blank id", (b) => (b.device.deviceId = " "), /device\.deviceId is required/],
    ];
    for (const [label, mutate, reason] of cases) {
      const r = redigested(c, mutate);
      expect(() => compileOperationalEnvelope(r, r.envelopeDigest), label).toThrow(reason);
    }
  });

  it("refuses a re-digested body whose hazards are duplicated, via the shared confirmedBodyProblems (not the runtime schema's own check)", () => {
    const c = redigested(confirmedPlateReader(), (b) => (b.hazards = ["heat", "heat"]));
    expect(() => compileOperationalEnvelope(c, c.envelopeDigest)).toThrow(/hazards must each appear once, in canonical order/);
  });

  it("refuses a device class that has no template", () => {
    const c = redigested(confirmedOt2(), (b) => (b.deviceClass = "unknown-robot"));
    expect(() => compileOperationalEnvelope(c, c.envelopeDigest)).toThrow(/unknown deviceClass/);
  });
});

describe("OperationalEnvelopeV1Schema: strict, no defaults", () => {
  const c0 = confirmedOt2();
  const rt = compileOperationalEnvelope(c0, c0.envelopeDigest);

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

  it("(114b-12) refuses limits out of the template's exact order and units — the old per-quantity duplicate/missing checks are now one consolidated ordering rule", () => {
    expect(messages(parseChanged(rt, (e) => e.limits.push({ ...e.limits[0], max: 10 })))).toMatch(
      /limits must be exactly aspirate_volume, dispense_volume, module_temperature, run_duration/,
    );
    expect(messages(parseChanged(rt, (e) => e.limits.splice(1, 1)))).toMatch(/limits must be exactly/);
    expect(messages(parseChanged(rt, (e) => e.limits.reverse()))).toMatch(/limit 0 must be aspirate_volume/);
    expect(messages(parseChanged(rt, (e) => (e.limits[3].unit = "h")))).toMatch(/run_duration is in min/);
    expect(parseChanged(rt, (e) => (e.limits[0].unit = "rpm")).success).toBe(false);
    expect(parseChanged(rt, (e) => (e.limits = [])).success).toBe(false);
  });

  it("(114b-12) refuses an adapter-stop command not among the declared commands", () => {
    expect(messages(parseChanged(rt, (e) => (e.eStop = { mechanism: "adapter-stop", stopCommand: "nonexistent" })))).toMatch(
      /eStop\.stopCommand the stop command must be one of the declared commands/,
    );
  });

  it("(114b-12) refuses a command map with a gap", () => {
    expect(messages(parseChanged(rt, (e) => (e.commands = e.commands.filter((c: any) => c.name !== "runProtocol"))))).toMatch(
      /commands no declared parameter sets run_duration/,
    );
  });

  it("(114b-12) refuses a deadlineQuantity that isn't the template's own deadline", () => {
    expect(messages(parseChanged(rt, (e) => (e.deadlineQuantity = "aspirate_volume")))).toMatch(
      /the deadline of a liquid-handler-ot2 is run_duration/,
    );
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

  it("(114b-5) refuses a supervision policy violation directly, too: unattended on a device that moves or heats", () => {
    expect(messages(parseChanged(rt, (e) => (e.supervision = "unattended")))).toMatch(/v1 does not allow unattended operation/);
  });

  it("refuses a stop that cannot stop the device", () => {
    expect(messages(parseChanged(rt, (e) => (e.eStop = { mechanism: "none" })))).toMatch(/needs an e-stop/);
    expect(messages(parseChanged(rt, (e) => (e.eStop.stopCommand = "  ")))).toMatch(/must not be blank/);
    expect(parseChanged(rt, (e) => (e.eStop = { mechanism: "hardware", stopCommand: "x" })).success).toBe(false);
    expect(parseChanged(rt, (e) => (e.eStop = { mechanism: "soft" })).success).toBe(false);
  });

  it("refuses a malformed digest and blank identities, including a blank or missing adapterVersion", () => {
    expect(messages(parseChanged(rt, (e) => (e.envelopeDigest = "0x" + "AB".repeat(32))))).toMatch(/lowercase hex/);
    expect(parseChanged(rt, (e) => (e.envelopeDigest = "0x1234")).success).toBe(false);
    expect(parseChanged(rt, (e) => (e.deviceId = " ")).success).toBe(false);
    expect(parseChanged(rt, (e) => (e.adapterType = "")).success).toBe(false);
    expect(parseChanged(rt, (e) => (e.adapterVersion = "")).success).toBe(false);
    expect(parseChanged(rt, (e) => delete e.adapterVersion).success).toBe(false);
  });

  it("(114b-10) the schema now refuses an unknown class outright (round 2 accepted it with generic rules only)", () => {
    const r = parseChanged(rt, (e) => {
      e.deviceClass = "unknown-robot";
      e.limits = [{ quantity: "spindle_speed", unit: "m/s", min: 0, max: 2 }];
    });
    expect(r.success).toBe(false);
    expect(messages(r)).toMatch(/unknown deviceClass "unknown-robot"/);
  });

  it("(114b-10) an unknown class short-circuits: superRefine returns right after the deviceClass issue, so not even the e-stop check runs", () => {
    const unknownNone = parseChanged(rt, (e) => {
      e.deviceClass = "unknown-robot";
      e.eStop = { mechanism: "none" };
    });
    expect(unknownNone.success).toBe(false);
    expect(messages(unknownNone)).toMatch(/unknown deviceClass/);
    // Round 2's message here was "a device that moves or heats, OR OF AN UNKNOWN CLASS, needs an e-stop" — that
    // extra fail-closed clause is gone; only the single deviceClass issue rejects this envelope now.
    expect(messages(unknownNone)).not.toMatch(/needs an e-stop/);
  });

  it("refuses an unbounded side: -Infinity min, or no limits at all", () => {
    expect(parseChanged(rt, (e) => (e.limits[0].min = -Infinity)).success).toBe(false);
    expect(parseChanged(rt, (e) => (e.limits = [])).success).toBe(false);
  });
});

describe("compileOperationalEnvelope: the projection carries only what the runtime enforces", () => {
  it("drops a stray stop command from a re-digested hardware e-stop", () => {
    const c = redigested(confirmedPlateReader(), (b) => (b.eStop = { mechanism: "hardware", stopCommand: "POST /halt" }));
    expect(compileOperationalEnvelope(c, c.envelopeDigest).eStop).toEqual({ mechanism: "hardware" });
  });
});

// ── astra 114b findings (pack 114b, cross-family review) ────────────
// 1a/1c/1d/2a-2c/3/4a-4d/5/6/7a-7d/map-gap/undeclared-stop live in
// safety-envelope.test.ts (they exercise compileSafetyEnvelope, not this file).

describe("astra 114b findings", () => {
  it("1b a forged (but self-consistently re-digested) body vs the registered digest: compileOperationalEnvelope also refuses", () => {
    const c = confirmedOt2();
    const REGISTERED = c.envelopeDigest;
    const forged = redigested(c, (b) => {
      b.limits[0].max = 3000;
    });
    expect(() => compileOperationalEnvelope(forged, REGISTERED)).toThrow(/not the envelope the registration record committed/);
  });

  it("8/9 the runtime envelope carries adapterVersion, commands and deadlineQuantity", () => {
    const c = confirmedOt2();
    const rt = compileOperationalEnvelope(c, c.envelopeDigest);
    expect(Object.keys(rt).sort()).toEqual(
      [
        "adapterType",
        "adapterVersion",
        "commands",
        "deadlineQuantity",
        "deviceClass",
        "deviceId",
        "eStop",
        "envelopeDigest",
        "envelopeVersion",
        "hazards",
        "limits",
        "maxCommandsPerMinute",
        "strict",
        "supervision",
      ].sort(),
    );
    expect(rt.deadlineQuantity).toBe("run_duration");
  });

  it("10 the schema refuses an unknown class (full behavior covered by the dedicated 114b-10 tests above)", () => {
    const c = confirmedOt2();
    const rt = compileOperationalEnvelope(c, c.envelopeDigest);
    expect(OperationalEnvelopeV1Schema.safeParse({ ...rt, deviceClass: "unknown-robot" }).success).toBe(false);
  });
});

// ── Mutation-found gaps (round-2 mutation run) ──
describe("mutation-found gaps: the runtime command surface", () => {
  it("the schema refuses an extra key on a command parameter", () => {
    const rt = compileOperationalEnvelope(confirmedPlateReader(), confirmedPlateReader().envelopeDigest);
    const changed = structuredClone(rt) as any;
    changed.commands[0].params[0].fallback = 1;
    expect(OperationalEnvelopeV1Schema.safeParse(changed).success).toBe(false);
  });

  it("an unbounded parameter keeps its reason in the runtime envelope", () => {
    const c = confirmedPlateReader();
    const rt = compileOperationalEnvelope(c, c.envelopeDigest);
    const unbounded = rt.commands.flatMap((cmd) => cmd.params).filter((p) => p.unbounded !== undefined);
    expect(unbounded.length).toBeGreaterThan(0);
    for (const p of unbounded) {
      expect(p.unbounded!.trim().length).toBeGreaterThan(0);
      expect(p.quantity).toBeUndefined();
    }
  });
});
