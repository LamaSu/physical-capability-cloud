/**
 * astra pack 178 (gpt-5.6-sol, #508 @82065de7), HIGH: telemetry used one
 * continuous two-sided range rule for quantities with different temporal
 * semantics. Reproduced at 731bd27d (#510, which merges 82065de7) as astra's
 * trace (/mnt/sparkbulk/tmp/sensors/repro/repro-508-178-at-82065de7.txt):
 *   - read_duration [1, 60] s bound to the elapsed counter run.elapsed_s: the
 *     first reading, 0, was refused, so no read could ever start;
 *   - the documented workaround, [0, 60]: a trace ending at 0.2 s passed every
 *     check, and the evidence attested [0, 60] "for the whole job", so the
 *     real 1 s minimum was erased.
 * Round 4 (Addendum 8): every channel reports a STATE, a value that must lie
 * inside the limit at every check. A counter is not accepted. A duration no
 * command sets binds to the duration the device is configured to run for, and
 * keeps its real minimum. The evidence claims what was sampled, never
 * continuous conformance.
 */

import { generateKeyPairSync, sign, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { compileOperationalEnvelope, OperationalEnvelopeV1Schema } from "../onboarding/operational-envelope.js";
import {
  compileSafetyEnvelope,
  confirmedBodyProblems,
  confirmSafetyEnvelope,
  draftSafetyEnvelope,
  registrationSigningPreimage,
  TELEMETRY_SEMANTICS,
  type ConfirmedSafetyEnvelope,
  type RegistrationVerifier,
  type SafetyEnvelopeBody,
  type SafetyEnvelopeInput,
  type SafetyEnvelopeRegistration,
} from "../onboarding/safety-envelope.js";

const REGISTRY = generateKeyPairSync("ed25519");
const verifyRegistry: RegistrationVerifier = (preimage, signature) => verify(null, preimage, REGISTRY.publicKey, signature);
function register(c: ConfirmedSafetyEnvelope): SafetyEnvelopeRegistration {
  const statement = { deviceId: c.envelope.device.deviceId, envelopeDigest: c.envelopeDigest, registeredAt: "2026-10-03T11:45:00Z" };
  return { ...statement, signature: Buffer.from(sign(null, registrationSigningPreimage(statement), REGISTRY.privateKey)).toString("hex") };
}

/** SIM-PR1's two readings: the run duration it is configured for, and its chamber temperature. */
const RUN_SECONDS = { id: "config.run_seconds", quantity: "read_duration", unit: "s" as const, semantics: "state" as const, maxAgeMs: 5000 };
const TEMPERATURE = { id: "status.temperature_c", quantity: "incubation_temperature", unit: "degC" as const, semantics: "state" as const, maxAgeMs: 5000 };

function simPr1(channels: unknown[] = [RUN_SECONDS, TEMPERATURE], readMin = 1): SafetyEnvelopeInput {
  return {
    deviceClass: "lab-plate-reader",
    device: { deviceId: "sim-pr1", adapterType: "generic-http", adapterVersion: `sha256:${"31".repeat(32)}` },
    commandMap: { commands: [{ name: "runPlate", params: [] }, { name: "stop", params: [] }] },
    telemetryMap: { channels: channels as never },
    intake: {
      limits: [
        { field: "safety.limits", quantity: "incubation_temperature", unit: "degC", min: 15, max: 40 },
        { field: "safety.limits", quantity: "read_duration", unit: "s", min: readMin, max: 60 },
        { field: "safety.limits", quantity: "job_duration", unit: "min", min: 1, max: 30 },
      ],
      eStop: { mechanism: "adapter-stop", stopCommand: "stop" },
      supervision: "attended",
      hazards: [],
      maxCommandsPerMinute: 20,
    },
    references: [],
  };
}
const DECISION = {
  confirmedBy: "op-178",
  confirmedAt: "2026-10-03T11:40:00Z",
  deviceControlled: [
    { quantity: "incubation_temperature", enforcement: "telemetry" as const, channel: "status.temperature_c" },
    { quantity: "read_duration", enforcement: "telemetry" as const, channel: "config.run_seconds" },
  ],
};

describe("astra 178 HIGH: a channel reports a state, so a duration keeps its real minimum", () => {
  it("v1 knows one reading kind, and it is a state", () => {
    expect(TELEMETRY_SEMANTICS).toEqual(["state"]);
    expect(Object.isFrozen(TELEMETRY_SEMANTICS)).toBe(true);
  });

  it("astra's trace no longer has a way in: an elapsed counter is refused at draft, whatever its limit", () => {
    const counter = { id: "run.elapsed_s", quantity: "read_duration", unit: "s", semantics: "elapsed", maxAgeMs: 1000 };
    for (const readMin of [1, 0]) {
      expect(() => draftSafetyEnvelope(simPr1([counter, TEMPERATURE], readMin))).toThrow(/semantics must be "state"/);
    }
    const unlabelled = { id: "run.elapsed_s", quantity: "read_duration", unit: "s", maxAgeMs: 1000 };
    expect(() => draftSafetyEnvelope(simPr1([unlabelled, TEMPERATURE]))).toThrow(/exactly \{id, quantity, unit, semantics, maxAgeMs\}|semantics must be "state"/);
  });

  it("a duration no command sets binds to the duration the device is configured for, and its 1 s minimum reaches the runtime and the evidence", () => {
    const c = confirmSafetyEnvelope(simPr1(), DECISION);
    const limit = c.envelope.limits.find((l) => l.quantity === "read_duration")!;
    expect([limit.min, limit.max]).toEqual([1, 60]);
    const runtime = compileOperationalEnvelope(c, register(c), verifyRegistry);
    expect(runtime.limits.find((l) => l.quantity === "read_duration")).toMatchObject({ min: 1, max: 60 });
    expect(runtime.telemetryChannels).toEqual([RUN_SECONDS, TEMPERATURE]);
    const tier = compileSafetyEnvelope(c, register(c), verifyRegistry).evidence["envelope-conformance"]!;
    const entry = (tier.primitives[0]!.params as { envelope: Array<Record<string, unknown>> }).envelope.find((e) => e.metric === "read_duration");
    expect(entry).toEqual({
      metric: "read_duration",
      unit: "s",
      min: 1,
      max: 60,
      enforcedBy: [{ kind: "telemetry", channel: "config.run_seconds", semantics: "state", maxAgeMs: 5000 }],
    });
  });

  it("the evidence claims sampled checks, never conformance for the whole job", () => {
    const c = confirmSafetyEnvelope(simPr1(), DECISION);
    const tier = compileSafetyEnvelope(c, register(c), verifyRegistry).evidence["envelope-conformance"]!;
    expect(tier.required).toContain("at each enforcement check, every telemetry channel had a reading no older than its maxAgeMs, inside its quantity's limit");
    expect(tier.required.join(" ")).not.toMatch(/whole job/);
  });

  it("a hand-built body and the runtime schema refuse a channel that is not a state", () => {
    const c = confirmSafetyEnvelope(simPr1(), DECISION);
    for (const semantics of ["elapsed", "counter", "", undefined]) {
      const body = structuredClone(c.envelope) as unknown as Record<string, any>;
      if (semantics === undefined) delete body.telemetryMap.channels[0].semantics;
      else body.telemetryMap.channels[0].semantics = semantics;
      expect(confirmedBodyProblems(body as unknown as SafetyEnvelopeBody).join("; "), String(semantics)).toMatch(/telemetryMap: /);
      const runtime = structuredClone(compileOperationalEnvelope(c, register(c), verifyRegistry)) as unknown as Record<string, any>;
      if (semantics === undefined) delete runtime.telemetryChannels[0].semantics;
      else runtime.telemetryChannels[0].semantics = semantics;
      expect(OperationalEnvelopeV1Schema.safeParse(runtime).success, String(semantics)).toBe(false);
    }
  });
});
