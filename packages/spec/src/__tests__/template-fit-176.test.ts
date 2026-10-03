/**
 * astra pack 176 (gpt-5.6-sol, #508 @85945cae). Both findings were reproduced
 * at 85945cae with astra's recipes, the first two tests below, which failed
 * there. Here they are the behavior round 3 has instead (Addendum 7):
 *   CRITICAL: a device-controlled "cutoff" with any non-blank prose was enough
 *             to confirm, register and compile, so the registry signature
 *             authenticated an operator's words about physical enforcement.
 *             Now the only enforcement is a telemetry channel the adapter
 *             declares, named by id; confirm and both compilers refuse a name
 *             that does not resolve to a channel reporting that quantity.
 *   MEDIUM:   an enumerated allowed set had no canonical order, so [25, 37]
 *             and [37, 25] committed different digests for one set. Now every
 *             value set is listed in its one order, everywhere it is checked.
 */

import { generateKeyPairSync, sign, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { compileOperationalEnvelope, OperationalEnvelopeV1Schema } from "../onboarding/operational-envelope.js";
import {
  compileSafetyEnvelope,
  computeSafetyEnvelopeDigest,
  confirmedBodyProblems,
  confirmSafetyEnvelope,
  isCanonicalValueSet,
  isTelemetryChannelId,
  registrationSigningPreimage,
  type ConfirmedSafetyEnvelope,
  type RegistrationVerifier,
  type SafetyEnvelopeBody,
  type SafetyEnvelopeInput,
  type SafetyEnvelopeRegistration,
} from "../onboarding/safety-envelope.js";

const MANIFEST = `sha256:${"ab".repeat(32)}`;
const REGISTRY = generateKeyPairSync("ed25519");
const verifyRegistry: RegistrationVerifier = (preimage, signature) => verify(null, preimage, REGISTRY.publicKey, signature);
function register(c: ConfirmedSafetyEnvelope): SafetyEnvelopeRegistration {
  const statement = { deviceId: c.envelope.device.deviceId, envelopeDigest: c.envelopeDigest, registeredAt: "2026-10-03T09:35:00Z" };
  return { ...statement, signature: Buffer.from(sign(null, registrationSigningPreimage(statement), REGISTRY.privateKey)).toString("hex") };
}

const CHAMBER = { id: "chamber.temperature_c", quantity: "incubation_temperature", unit: "degC" as const, maxAgeMs: 5000 };

function heated(commands: SafetyEnvelopeInput["commandMap"], telemetryMap?: SafetyEnvelopeInput["telemetryMap"]): SafetyEnvelopeInput {
  return {
    deviceClass: "lab-plate-reader",
    device: { deviceId: "pr-176", adapterType: "generic-http", adapterVersion: MANIFEST },
    commandMap: commands,
    ...(telemetryMap ? { telemetryMap } : {}),
    intake: {
      limits: [
        { field: "safety.limits", quantity: "incubation_temperature", unit: "degC", min: 20, max: 40 },
        { field: "safety.limits", quantity: "read_duration", unit: "s", min: 1, max: 600 },
        { field: "safety.limits", quantity: "job_duration", unit: "min", min: 1, max: 120 },
      ],
      eStop: { mechanism: "adapter-stop", stopCommand: "stop" },
      supervision: "attended",
      hazards: ["heat"],
      maxCommandsPerMinute: 20,
    },
    references: [],
  };
}
const DECISION = { confirmedBy: "op-176", confirmedAt: "2026-10-03T09:30:00Z" };
const RUN_ONLY = {
  commands: [
    { name: "run", params: [{ name: "seconds", quantity: "read_duration", unit: "s" as const }] },
    { name: "stop", params: [] },
  ],
};

describe("astra 176", () => {
  it("CRITICAL: a device-controlled quantity cannot be confirmed on an operator's prose ('cutoff', 'x')", () => {
    const input = heated(RUN_ONLY);
    expect(() =>
      confirmSafetyEnvelope(input, { ...DECISION, deviceControlled: [{ quantity: "incubation_temperature", enforcement: "cutoff", detail: "x" } as never] }),
    ).toThrow();
  });

  it("MEDIUM: one enumerated allowed set has one committed form", () => {
    const preset = (allowed: number[]) =>
      heated({
        commands: [
          { name: "setIncubation", params: [{ name: "celsius", quantity: "incubation_temperature", unit: "degC", allowed }] },
          { name: "run", params: [{ name: "seconds", quantity: "read_duration", unit: "s" }] },
          { name: "stop", params: [] },
        ],
      });
    const outcome = (allowed: number[]) => {
      try {
        return confirmSafetyEnvelope(preset(allowed), DECISION).envelopeDigest;
      } catch {
        return "refused";
      }
    };
    const ascending = outcome([25, 37]);
    const descending = outcome([37, 25]);
    // Canonical: the unordered form is refused, or both forms commit the same digest.
    expect(descending === "refused" || descending === ascending).toBe(true);
    expect(ascending).not.toBe("refused");
  });
});

describe("astra 176 CRITICAL: enforcement is a channel the runtime reads, resolved before registration", () => {
  it("a cutoff is refused however it is described, with or without a channel", () => {
    const input = heated(RUN_ONLY, { channels: [CHAMBER] });
    for (const entry of [
      { quantity: "incubation_temperature", enforcement: "cutoff", channel: "chamber.temperature_c" },
      { quantity: "incubation_temperature", enforcement: "cutoff", detail: "an independent thermostat, rated 45 degC" },
    ]) {
      expect(() => confirmSafetyEnvelope(input, { ...DECISION, deviceControlled: [entry as never] })).toThrow(/cutoff|exactly \{quantity, enforcement, channel\}/);
    }
  });

  it("telemetry needs a channel the adapter declares, reporting that quantity: no declared channel, no confirmation", () => {
    const telemetry = { quantity: "incubation_temperature", enforcement: "telemetry" as const, channel: "chamber.temperature_c" };
    expect(() => confirmSafetyEnvelope(heated(RUN_ONLY), { ...DECISION, deviceControlled: [telemetry] })).toThrow(/is not a channel of the adapter's telemetry map/);
    const elsewhere = { channels: [{ ...CHAMBER, id: "chamber.humidity" }] };
    expect(() => confirmSafetyEnvelope(heated(RUN_ONLY, elsewhere), { ...DECISION, deviceControlled: [telemetry] })).toThrow(/is not a channel/);
  });

  it("a resolving channel confirms, registers and compiles, and every artifact names it", () => {
    const telemetry = { quantity: "incubation_temperature", enforcement: "telemetry" as const, channel: "chamber.temperature_c" };
    const c = confirmSafetyEnvelope(heated(RUN_ONLY, { channels: [CHAMBER] }), { ...DECISION, deviceControlled: [telemetry] });
    expect(c.envelope.telemetryMap).toEqual({ channels: [CHAMBER] });
    expect(c.envelope.deviceControlled).toEqual([telemetry]);
    const runtime = compileOperationalEnvelope(c, register(c), verifyRegistry);
    expect(runtime.telemetryChannels).toEqual([CHAMBER]);
    expect(runtime.deviceControlled).toEqual([telemetry]);
    const tier = compileSafetyEnvelope(c, register(c), verifyRegistry).evidence["envelope-conformance"]!;
    const entries = (tier.primitives[0]!.params as { envelope: Array<{ metric: string; enforcedBy: unknown }> }).envelope;
    expect(entries.find((e) => e.metric === "incubation_temperature")!.enforcedBy).toEqual([{ kind: "telemetry", channel: "chamber.temperature_c", maxAgeMs: 5000 }]);
    expect(tier.required).toContain("every telemetry channel had a reading no older than its maxAgeMs, inside its quantity's limit, for the whole job");
  });

  it("the channel is committed: retargeting it, or swapping the map, after confirmation is refused by both compilers", () => {
    const telemetry = { quantity: "incubation_temperature", enforcement: "telemetry" as const, channel: "chamber.temperature_c" };
    const c = confirmSafetyEnvelope(heated(RUN_ONLY, { channels: [CHAMBER] }), { ...DECISION, deviceControlled: [telemetry] });
    const variants: Array<(b: Record<string, any>) => void> = [
      (b) => delete b.telemetryMap,
      (b) => (b.telemetryMap.channels[0].quantity = "read_duration"),
      (b) => (b.deviceControlled[0].channel = "chamber.other"),
    ];
    for (const change of variants) {
      const body = structuredClone(c.envelope) as unknown as Record<string, any>;
      change(body);
      expect(confirmedBodyProblems(body as unknown as SafetyEnvelopeBody).join("; ")).toMatch(/not a channel|reports read_duration/);
      const redigested = { envelope: body as unknown as SafetyEnvelopeBody, envelopeDigest: computeSafetyEnvelopeDigest(body as unknown as SafetyEnvelopeBody) };
      expect(() => compileOperationalEnvelope(redigested, register(redigested), verifyRegistry)).toThrow();
      expect(() => compileSafetyEnvelope(redigested, register(redigested), verifyRegistry)).toThrow();
    }
  });
});

describe("astra 176 MEDIUM: a value set is committed in its one order, at confirmation, in a body and in the runtime schema", () => {
  const preset = (allowed: number[]) =>
    heated({
      commands: [
        { name: "setIncubation", params: [{ name: "celsius", quantity: "incubation_temperature", unit: "degC", allowed }] },
        { name: "run", params: [{ name: "seconds", quantity: "read_duration", unit: "s" }] },
        { name: "stop", params: [] },
      ],
    });

  it("a hand-built body with the set reversed is refused, and so is the runtime envelope", () => {
    const c = confirmSafetyEnvelope(preset([25, 37]), DECISION);
    const body = structuredClone(c.envelope) as unknown as Record<string, any>;
    body.commandMap.commands[0].params[0].allowed = [37, 25];
    expect(confirmedBodyProblems(body as unknown as SafetyEnvelopeBody).join("; ")).toMatch(/listed in ascending order/);
    const runtime = structuredClone(compileOperationalEnvelope(c, register(c), verifyRegistry)) as unknown as Record<string, any>;
    expect(OperationalEnvelopeV1Schema.safeParse(runtime).success).toBe(true);
    runtime.commands[0].params[0].allowed = [37, 25];
    expect(OperationalEnvelopeV1Schema.safeParse(runtime).success).toBe(false);
  });

  it.each([
    ["numbers out of order", { allowed: [2, 1] }],
    ["a string before a number", { allowed: ["all", 1] }],
    ["strings out of code-unit order", { allowedItems: ["A2", "A10"] }],
    ["the same number as -0 and 0", { allowed: [-0, 0] }],
  ])("an unbounded set with %s is refused", (_label, lists) => {
    const input = heated({
      commands: [
        { name: "run", params: [{ name: "seconds", quantity: "read_duration", unit: "s" }, { name: "slot", unbounded: { reason: "a deck slot", ...lists } }] },
        { name: "setIncubation", params: [{ name: "celsius", quantity: "incubation_temperature", unit: "degC" }] },
        { name: "stop", params: [] },
      ],
    });
    expect(() => confirmSafetyEnvelope(input, DECISION)).toThrow(/listed in that order|listed twice/);
  });

  it("the committed order is numbers ascending, then strings by UTF-16 code unit", () => {
    const input = heated({
      commands: [
        {
          name: "run",
          params: [
            { name: "seconds", quantity: "read_duration", unit: "s" },
            { name: "wells", unbounded: { reason: "plate wells", allowed: [1, 96, "A1", "A10", "A2", "all"], allowedItems: ["A1", "A10", "A2", "B1"] } },
          ],
        },
        { name: "setIncubation", params: [{ name: "celsius", quantity: "incubation_temperature", unit: "degC" }] },
        { name: "stop", params: [] },
      ],
    });
    const c = confirmSafetyEnvelope(input, DECISION);
    expect(c.envelope.commandMap.commands[0]!.params[1]!.unbounded).toEqual({
      reason: "plate wells",
      allowed: [1, 96, "A1", "A10", "A2", "all"],
      allowedItems: ["A1", "A10", "A2", "B1"],
    });
  });
});

describe("the two predicates the runtime check reuses, over every code unit", () => {
  // The intended languages, written out: a channel id is [a-z][a-z0-9._-]{0,63}.
  const lower = (u: number) => u >= 0x61 && u <= 0x7a;
  const inner = (u: number) => lower(u) || (u >= 0x30 && u <= 0x39) || u === 0x2e || u === 0x5f || u === 0x2d;
  const units = [...Array.from({ length: 0x80 }, (_, i) => i), 0xa0, 0xe9, 0x130, 0x212a, 0x2028, 0xd800, 0xdc00, 0xfeff, 0xff41];

  it("a channel id: a lowercase ASCII letter, then lowercase letters, digits, '.', '_' or '-', at most 64", () => {
    for (const u of units) {
      const c = String.fromCharCode(u);
      expect(isTelemetryChannelId(c), `first ${u.toString(16)}`).toBe(lower(u));
      expect(isTelemetryChannelId(`a${c}`), `inner ${u.toString(16)}`).toBe(inner(u));
      expect(isTelemetryChannelId(`a${c}z`), `middle ${u.toString(16)}`).toBe(inner(u));
    }
    expect(isTelemetryChannelId("")).toBe(false);
    expect(isTelemetryChannelId("a".repeat(64))).toBe(true);
    expect(isTelemetryChannelId("a".repeat(65))).toBe(false);
    for (const v of [null, undefined, 1, ["status.temperature_c"], { toString: () => "status.temperature_c" }]) expect(isTelemetryChannelId(v)).toBe(false);
  });

  it("a canonical value set: each value once, numbers ascending, then strings by UTF-16 code unit", () => {
    expect(isCanonicalValueSet([])).toBe(true);
    expect(isCanonicalValueSet([25, 37])).toBe(true);
    expect(isCanonicalValueSet([25, 25])).toBe(false);
    expect(isCanonicalValueSet([37, 25])).toBe(false);
    expect(isCanonicalValueSet([-0, 0])).toBe(false);
    expect(isCanonicalValueSet([-1, 0, 1.5])).toBe(true);
    expect(isCanonicalValueSet([1, "a"])).toBe(true);
    expect(isCanonicalValueSet(["a", 1])).toBe(false);
    expect(isCanonicalValueSet(["A1", "A10", "A2"])).toBe(true);
    expect(isCanonicalValueSet(["A2", "A10"])).toBe(false);
    expect(isCanonicalValueSet(["a", "a"])).toBe(false);
    expect(isCanonicalValueSet(["Z", "a", "\u00e9"])).toBe(true);
  });
});
