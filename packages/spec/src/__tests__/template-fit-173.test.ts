/**
 * astra pack 173 (gpt-5.6-sol, #508 @52064a8a), two CRITICALs. Both reproduced
 * at 52064a8a with exactly these recipes; here they are the safe behavior each
 * now has (Addendum 6: dispositions):
 *   1. A physically effective parameter declared `unbounded` hides the quantity
 *      it moves. That quantity can only be confirmed device-controlled, and its
 *      limit stays.
 *   2. "No command sets it" is not "the device cannot cause it": a quantity the
 *      firmware controls keeps its runtime limit and its conformance evidence.
 */

import { generateKeyPairSync, sign, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { compileOperationalEnvelope } from "../onboarding/operational-envelope.js";
import {
  compileSafetyEnvelope,
  confirmSafetyEnvelope,
  registrationSigningPreimage,
  type ConfirmedSafetyEnvelope,
  type RegistrationVerifier,
  type SafetyEnvelopeInput,
  type SafetyEnvelopeRegistration,
} from "../onboarding/safety-envelope.js";

const MANIFEST = `sha256:${"ab".repeat(32)}`;
const REGISTRY = generateKeyPairSync("ed25519");
const verifyRegistry: RegistrationVerifier = (preimage, signature) => verify(null, preimage, REGISTRY.publicKey, signature);
function register(c: ConfirmedSafetyEnvelope): SafetyEnvelopeRegistration {
  const statement = { deviceId: c.envelope.device.deviceId, envelopeDigest: c.envelopeDigest, registeredAt: "2026-10-03T09:00:00Z" };
  return { ...statement, signature: Buffer.from(sign(null, registrationSigningPreimage(statement), REGISTRY.privateKey)).toString("hex") };
}

/** Round 3 (astra pack 176): a device-controlled limit is enforced through a channel the adapter declares. */
const CHAMBER = { id: "chamber.temperature_c", quantity: "incubation_temperature", unit: "degC" as const, semantics: "state" as const, maxAgeMs: 5000 };

function plateReader(commands: SafetyEnvelopeInput["commandMap"]): SafetyEnvelopeInput {
  return {
    deviceClass: "lab-plate-reader",
    device: { deviceId: "pr-173", adapterType: "generic-http", adapterVersion: MANIFEST },
    commandMap: commands,
    telemetryMap: { channels: [CHAMBER] },
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
const DECISION = { confirmedBy: "op-173", confirmedAt: "2026-10-03T08:55:00Z" };
const TELEMETRY = { quantity: "incubation_temperature", enforcement: "telemetry" as const, channel: "chamber.temperature_c" };

describe("astra 173 CRITICAL 1: a quantity a mislabeled `unbounded` parameter moves never loses its limit", () => {
  it("astra's recipe: celsius declared unbounded {20, 200}; the temperature limit survives, enforced by telemetry", () => {
    const input = plateReader({
      commands: [
        {
          name: "runPlate",
          params: [
            { name: "celsius", unbounded: { reason: "temperature preset", allowed: [20, 200] } },
            { name: "seconds", quantity: "read_duration", unit: "s" },
          ],
        },
        { name: "stop", params: [] },
      ],
    });
    // The old way out is gone: a decision that names no disposition is refused.
    expect(() => confirmSafetyEnvelope(input, DECISION)).toThrow(/incubation_temperature/);
    const c = confirmSafetyEnvelope(input, { ...DECISION, deviceControlled: [TELEMETRY] });
    const rt = compileOperationalEnvelope(c, register(c), verifyRegistry);
    const limit = rt.limits.find((l) => l.quantity === "incubation_temperature");
    expect(limit && [limit.min, limit.max]).toEqual([20, 40]);
    expect(rt.deviceControlled).toEqual([TELEMETRY]);
    expect(rt.telemetryChannels).toEqual([CHAMBER]);
  });
});

describe("astra 173 CRITICAL 2: a quantity the device controls itself keeps its limit and its conformance evidence", () => {
  it("astra's recipe: a run command with no temperature parameter on a heated reader", () => {
    const input = plateReader({
      commands: [
        { name: "run", params: [{ name: "seconds", quantity: "read_duration", unit: "s" }] },
        { name: "stop", params: [] },
      ],
    });
    const c = confirmSafetyEnvelope(input, { ...DECISION, deviceControlled: [TELEMETRY] });
    const rt = compileOperationalEnvelope(c, register(c), verifyRegistry);
    const csd = compileSafetyEnvelope(c, register(c), verifyRegistry);
    const conformance = (csd.evidence["envelope-conformance"]!.primitives[0]!.params as { envelope: Array<{ metric: string }> }).envelope.map((e) => e.metric);
    expect(rt.limits.map((l) => l.quantity)).toContain("incubation_temperature");
    expect(conformance).toContain("incubation_temperature");
  });
});
