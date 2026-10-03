/**
 * astra pack 174 (gpt-5.6-sol, #510 @a2105427): reproductions, each written as
 * the behavior the fix requires.
 */

import { generateKeyPairSync, sign, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { checkRuntimeCommand, emergencyStopOf } from "../onboarding/envelope-runtime-check.js";
import { compileOperationalEnvelope } from "../onboarding/operational-envelope.js";
import {
  confirmSafetyEnvelope,
  registrationSigningPreimage,
  type ConfirmedSafetyEnvelope,
  type RegistrationVerifier,
  type SafetyEnvelopeInput,
  type SafetyEnvelopeRegistration,
} from "../onboarding/safety-envelope.js";

const MANIFEST = `sha256:${"21".repeat(32)}`;
const OTHER = `sha256:${"77".repeat(32)}`;
const REGISTRY = generateKeyPairSync("ed25519");
const verifyRegistry: RegistrationVerifier = (preimage, signature) => verify(null, preimage, REGISTRY.publicKey, signature);
function register(c: ConfirmedSafetyEnvelope): SafetyEnvelopeRegistration {
  const statement = { deviceId: c.envelope.device.deviceId, envelopeDigest: c.envelopeDigest, registeredAt: "2026-10-03T09:00:00Z" };
  return { ...statement, signature: Buffer.from(sign(null, registrationSigningPreimage(statement), REGISTRY.privateKey)).toString("hex") };
}
function ot2(runMax = 120): unknown {
  const input: SafetyEnvelopeInput = {
    deviceClass: "liquid-handler-ot2",
    device: { deviceId: "ot2-174", adapterType: "opentrons", adapterVersion: MANIFEST },
    commandMap: {
      commands: [
        { name: "aspirate", params: [{ name: "volumeUl", quantity: "aspirate_volume", unit: "uL" }] },
        { name: "dispense", params: [{ name: "volumeUl", quantity: "dispense_volume", unit: "uL" }] },
        { name: "setModuleTemp", params: [{ name: "celsius", quantity: "module_temperature", unit: "degC" }] },
        { name: "stop", params: [] },
      ],
    },
    intake: {
      limits: [
        { field: "safety.limits", quantity: "aspirate_volume", unit: "uL", min: 1, max: 300 },
        { field: "safety.limits", quantity: "dispense_volume", unit: "uL", min: 1, max: 300 },
        { field: "safety.limits", quantity: "module_temperature", unit: "degC", min: 4, max: 95 },
        { field: "safety.limits", quantity: "run_duration", unit: "min", min: 1, max: runMax },
      ],
      eStop: { mechanism: "adapter-stop", stopCommand: "stop" },
      supervision: "attended",
      hazards: ["mechanical", "heat"],
      maxCommandsPerMinute: 60,
    },
    references: [],
  };
  const c = confirmSafetyEnvelope(input, { confirmedBy: "op-174", confirmedAt: "2026-10-03T08:55:00Z" });
  return compileOperationalEnvelope(c, register(c), verifyRegistry);
}
const NOW = 1_800_000_000_000;

describe("astra 174", () => {
  it("CRITICAL 1: 60 send times one millisecond in the future (a clock rollback) do not let a 61st command through", () => {
    const d = checkRuntimeCommand(ot2(), { name: "aspirate", params: { volumeUl: 10 } }, { adapterManifestDigest: MANIFEST, jobStartedAtMs: NOW - 1000, nowMs: NOW, recentCommandsAtMs: new Array(60).fill(NOW + 1) });
    expect(d.allowed).toBe(false);
  });

  it("MEDIUM 3: finite inputs whose arithmetic overflows to Infinity do not pass a late command", () => {
    const d = checkRuntimeCommand(ot2((Number.MAX_VALUE / 60000) * 1.5), { name: "aspirate", params: { volumeUl: 10 } }, { adapterManifestDigest: MANIFEST, jobStartedAtMs: -Number.MAX_VALUE, nowMs: Number.MAX_VALUE, recentCommandsAtMs: [] });
    expect(d.allowed).toBe(false);
  });

  it("CRITICAL 2 (the claim): the module no longer promises that a stop is always sendable through this check", async () => {
    const bad = checkRuntimeCommand(ot2(), { name: "stop", params: {} }, { adapterManifestDigest: OTHER, jobStartedAtMs: NOW - 1000, nowMs: NOW, recentCommandsAtMs: [] });
    // Through the ordinary dispatch check a stop to an unknown adapter is refused, as astra wants; what changed is the promise.
    expect(bad.allowed).toBe(false);
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../onboarding/envelope-runtime-check.ts", import.meta.url), "utf8");
    // Across comment line breaks too ("a stop\n *      is always sendable" was the old wording).
    expect(source.replace(/\s*\n\s*\*\s*/g, " ")).not.toMatch(/a stop is always (sendable|sent)/);
  });

  it("CRITICAL 2 (the path): emergencyStopOf returns the pre-wired stop from the envelope alone, or null", () => {
    expect(emergencyStopOf(ot2())).toEqual({ mechanism: "adapter-stop", stopCommand: "stop" });
    expect(Object.isFrozen(emergencyStopOf(ot2()))).toBe(true);
    // No state is involved at all: a broken clock or another adapter cannot reach it.
    expect(emergencyStopOf({ ...(ot2() as object), strict: false })).toBeNull();
    expect(emergencyStopOf(null)).toBeNull();
    let trapped = false;
    const proxy = new Proxy(ot2() as object, { get(t, k, r) { trapped = true; return Reflect.get(t, k, r); }, ownKeys(t) { trapped = true; return Reflect.ownKeys(t); } });
    expect(emergencyStopOf(proxy)).toBeNull();
    expect(trapped).toBe(false);
  });
});
