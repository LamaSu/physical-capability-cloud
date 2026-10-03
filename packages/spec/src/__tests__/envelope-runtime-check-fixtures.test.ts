/**
 * Cross-language parity fixtures for the runtime check of OperationalEnvelopeV1
 * (N86 part 2), for pcc-node: each vector is an envelope, a command, a state
 * and the decision checkRuntimeCommand returns, with its code and never its
 * reason. The committed JSON is generated from the TS reference by this test:
 *
 *   PCC_UPDATE_FIXTURES=1 npx --no-install vitest run src/__tests__/envelope-runtime-check-fixtures.test.ts
 *
 * Without the variable, the test fails when the committed file differs from
 * what the reference produces now, so the file cannot drift from the code.
 * Each vector's expected code is also written here by hand, so a change in the
 * code shows as a failed expectation, not only as a regenerated file.
 *
 * Special characters are built with String.fromCharCode, never written as
 * escape sequences.
 */

import { generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkRuntimeCommand, type RuntimeRefusalCode } from "../onboarding/envelope-runtime-check.js";
import { compileOperationalEnvelope, type OperationalEnvelopeV1 } from "../onboarding/operational-envelope.js";
import {
  confirmSafetyEnvelope,
  registrationSigningPreimage,
  type CommandMapV1,
  type ConfirmedSafetyEnvelope,
  type EnvelopeDecision,
  type RegistrationVerifier,
  type SafetyEnvelopeInput,
  type SafetyEnvelopeRegistration,
} from "../onboarding/safety-envelope.js";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/onboarding/envelope-runtime-check-v1.json");
const AT = "2026-10-03T08:00:00Z";

/** An ephemeral registry key, per run: no key material or signature reaches the fixture. */
const REGISTRY = generateKeyPairSync("ed25519");
const verifyRegistry: RegistrationVerifier = (preimage, signature) => verify(null, preimage, REGISTRY.publicKey, signature);

function register(c: ConfirmedSafetyEnvelope): SafetyEnvelopeRegistration {
  const statement = { deviceId: c.envelope.device.deviceId, envelopeDigest: c.envelopeDigest, registeredAt: "2026-10-03T08:05:00Z" };
  return { ...statement, signature: Buffer.from(sign(null, registrationSigningPreimage(statement), REGISTRY.privateKey)).toString("hex") };
}

function compile(input: SafetyEnvelopeInput, decision: Partial<EnvelopeDecision> = {}): OperationalEnvelopeV1 {
  const confirmed = confirmSafetyEnvelope(input, { confirmedBy: "operator:fixture", confirmedAt: AT, ...decision });
  return compileOperationalEnvelope(confirmed, register(confirmed), verifyRegistry);
}

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** The OT-2: an adapter stop, so "stop" is exempt from the deadline and the rate. */
const OT2_MAP: CommandMapV1 = {
  commands: [
    { name: "aspirate", params: [{ name: "volumeUl", quantity: "aspirate_volume", unit: "uL" }] },
    { name: "dispense", params: [{ name: "volumeUl", quantity: "dispense_volume", unit: "uL" }] },
    { name: "setModuleTemp", params: [{ name: "celsius", quantity: "module_temperature", unit: "degC" }] },
    {
      name: "runProtocol",
      params: [
        { name: "minutes", quantity: "run_duration", unit: "min" },
        { name: "labwareSlot", unbounded: { reason: "a deck position, not a safety quantity", allowed: SLOTS } },
      ],
    },
    {
      name: "transfer",
      params: [
        { name: "aspirateUl", quantity: "aspirate_volume", unit: "uL" },
        { name: "dispenseUl", quantity: "dispense_volume", unit: "uL" },
        { name: "slot", unbounded: { reason: "a deck position, not a safety quantity", allowed: SLOTS } },
      ],
    },
    { name: "stop", params: [] },
  ],
};

/**
 * The same OT-2 with no command parameter for its deadline quantity (run_duration):
 * its deadline is enforced as elapsed time alone, the seam both runtimes must
 * get right (astra pack 169).
 */
const OT2_ELAPSED_ONLY_MAP: CommandMapV1 = {
  commands: OT2_MAP.commands.map((c) => (c.name === "runProtocol" ? { ...c, params: c.params.filter((p) => p.quantity !== "run_duration") } : c)),
};

function ot2Input(moduleTemperature: { min: number; max: number }, commandMap: CommandMapV1 = OT2_MAP): SafetyEnvelopeInput {
  return {
    deviceClass: "liquid-handler-ot2",
    device: { deviceId: "ot2-sim-1", adapterType: "opentrons", adapterVersion: `sha256:${"21".repeat(32)}` },
    commandMap,
    intake: {
      limits: [
        { field: "safety.limits", quantity: "aspirate_volume", unit: "uL", min: 1, max: 300 },
        { field: "safety.limits", quantity: "dispense_volume", unit: "uL", min: 1, max: 300 },
        { field: "safety.limits", quantity: "module_temperature", unit: "degC", ...moduleTemperature },
        { field: "safety.limits", quantity: "run_duration", unit: "min", min: 0, max: 120 },
      ],
      eStop: { mechanism: "adapter-stop", stopCommand: "stop" },
      supervision: "attended",
      hazards: ["heat", "mechanical"],
      maxCommandsPerMinute: 60,
    },
    references: [],
  };
}

/** The plate reader: a hardware stop, so its "stop" command is an ordinary command. */
const PLATE_MAP: CommandMapV1 = {
  commands: [
    { name: "setIncubation", params: [{ name: "celsius", quantity: "incubation_temperature", unit: "degC" }] },
    {
      name: "read",
      params: [
        { name: "seconds", quantity: "read_duration", unit: "s" },
        { name: "wavelengthNm", unbounded: { reason: "an optical setting, not a safety quantity", allowed: [405, 450, 600] } },
        { name: "wells", unbounded: { reason: "which wells to read; a well sets no physical quantity", allowed: ["all"], allowedItems: ["A1", "A2", "A3", "H12"] } },
      ],
    },
    { name: "stop", params: [] },
  ],
};

function plateInput(): SafetyEnvelopeInput {
  return {
    deviceClass: "lab-plate-reader",
    device: { deviceId: "pr-sim-1", adapterType: "generic-http", adapterVersion: `sha256:${"10".repeat(32)}` },
    commandMap: PLATE_MAP,
    intake: {
      limits: [
        { field: "safety.limits", quantity: "incubation_temperature", unit: "degC", min: 20, max: 45 },
        { field: "safety.limits", quantity: "read_duration", unit: "s", min: 1, max: 600 },
        { field: "safety.limits", quantity: "job_duration", unit: "min", min: 1, max: 120 },
      ],
      eStop: { mechanism: "hardware" },
      supervision: "attended",
      hazards: ["heat"],
      maxCommandsPerMinute: 30,
    },
    references: [],
  };
}

const OT2 = compile(ot2Input({ min: 4, max: 95 }));
/** A cold block: 0 is the upper bound of module_temperature. */
const OT2_COLD = compile(ot2Input({ min: -20, max: 0 }));
const PLATE = compile(plateInput());
/**
 * R8 template fit rounds 3 and 4 (Addenda 7 and 8, astra packs 176 and 178): a
 * heated reader whose firmware runs the incubator and times its reads. No
 * command sets either, so both are device-controlled, each enforced through a
 * channel its adapter declares. Each channel reports a state: the chamber
 * temperature, and the read duration the reader is configured for. Both keep
 * their real limits, including the read's 1 s minimum.
 */
const HEATED = compile(
  {
    ...plateInput(),
    commandMap: { commands: [{ name: "run", params: [] }, { name: "stop", params: [] }] },
    telemetryMap: {
      channels: [
        { id: "chamber.temperature_c", quantity: "incubation_temperature", unit: "degC", semantics: "state", maxAgeMs: 5000 },
        { id: "config.read_seconds", quantity: "read_duration", unit: "s", semantics: "state", maxAgeMs: 1000 },
      ],
    },
    intake: {
      ...plateInput().intake,
      limits: [
        { field: "safety.limits", quantity: "incubation_temperature", unit: "degC", min: 20, max: 45 },
        { field: "safety.limits", quantity: "read_duration", unit: "s", min: 1, max: 600 },
        { field: "safety.limits", quantity: "job_duration", unit: "min", min: 1, max: 120 },
      ],
      eStop: { mechanism: "adapter-stop", stopCommand: "stop" },
    },
  },
  {
    deviceControlled: [
      { quantity: "incubation_temperature", enforcement: "telemetry", channel: "chamber.temperature_c" },
      { quantity: "read_duration", enforcement: "telemetry", channel: "config.read_seconds" },
    ],
  },
);
const RUN = { name: "run", params: {} };
/** An enumerated physical parameter: a module-temperature preset whose every value is inside the 4..95 limit. */
const OT2_PRESET = compile(
  ot2Input(
    { min: 4, max: 95 },
    { commands: OT2_MAP.commands.map((c) => (c.name === "setModuleTemp" ? { ...c, params: [{ name: "celsius", quantity: "module_temperature", unit: "degC", allowed: [4, 37, 95] }] } : c)) },
  ),
);
const presetIndex = OT2_MAP.commands.findIndex((c) => c.name === "setModuleTemp");
/** No command parameter sets run_duration: the deadline is elapsed time only. */
const OT2_ELAPSED_ONLY = compile(ot2Input({ min: 4, max: 95 }, OT2_ELAPSED_ONLY_MAP));
/**
 * astra pack 179 MEDIUM: a bound of 0 is a bound. Two OT-2s also monitor their
 * module temperature through a state channel (a channel on a settable quantity
 * is enforced too), one with a 0 minimum and one, a cold block, with a 0
 * maximum. Their vectors read exactly 0 and the nearest double past it, so a
 * port that tests a bound for truthiness ("if minimum and value < minimum")
 * fails them.
 */
const MODULE_CHANNEL = { channels: [{ id: "module.temperature_c", quantity: "module_temperature", unit: "degC" as const, semantics: "state" as const, maxAgeMs: 5000 }] };
const OT2_MONITORED_FROM_ZERO = compile({ ...ot2Input({ min: 0, max: 95 }), telemetryMap: MODULE_CHANNEL });
const OT2_MONITORED_COLD = compile({ ...ot2Input({ min: -20, max: 0 }), telemetryMap: MODULE_CHANNEL });

const T0 = 1_790_985_600_000;
const MIN = 60_000;
const NOW = T0 + 10 * MIN;
/** run_duration and job_duration are [.., 120] min: a 7,200,000 ms deadline. */
const DEADLINE_MS = 120 * MIN;
const OTHER_MANIFEST = `sha256:${"ab".repeat(32)}`;

function stateOf(env: OperationalEnvelopeV1, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { adapterManifestDigest: env.adapterVersion, jobStartedAtMs: T0, nowMs: NOW, recentCommandsAtMs: [], telemetry: [], ...over };
}
/** The latest reading of the heated reader's chamber temperature, or of the read duration it is configured for. */
const chamber = (value: unknown, atMs: number) => ({ channel: "chamber.temperature_c", value, atMs });
const readSeconds = (value: unknown, atMs: number) => ({ channel: "config.read_seconds", value, atMs });
const moduleTemp = (value: unknown, atMs: number) => ({ channel: "module.temperature_c", value, atMs });
/** Both readings current and inside their limits (20..45 degC, 1..600 s). */
const READINGS = [chamber(37, NOW - 100), readSeconds(30, NOW - 100)];
const heatedState = (over: Record<string, unknown> = {}) => stateOf(HEATED, { telemetry: READINGS, ...over });
const late = (env: OperationalEnvelopeV1, over: Record<string, unknown> = {}) => stateOf(env, { nowMs: T0 + DEADLINE_MS + 1, ...over });
const sends = (n: number, at: number) => Array.from({ length: n }, () => at);

function changed(value: OperationalEnvelopeV1, mutate: (e: any) => void): unknown {
  const copy = structuredClone(value) as any;
  mutate(copy);
  return copy;
}

const ch = (code: number) => String.fromCharCode(code);
const ASPIRATE = { name: "aspirate", params: { volumeUl: 150 } };
const STOP = { name: "stop", params: {} };
const read = (params: Record<string, unknown>) => ({ name: "read", params: { seconds: 30, wavelengthNm: 450, wells: "all", ...params } });
const slot = (labwareSlot: unknown) => ({ name: "runProtocol", params: { minutes: 10, labwareSlot } });
const transfer = (aspirateUl: unknown, dispenseUl: unknown, slotValue: unknown) => ({ name: "transfer", params: { aspirateUl, dispenseUl, slot: slotValue } });

type Expected = "allowed" | RuntimeRefusalCode;
type Vector = [name: string, envelope: unknown, command: unknown, state: unknown, expected: Expected];

/** Every code, every boundary, and the cross-language hazards a port must get right. */
const VECTORS: Vector[] = [
  // ── allowed ──
  ["allowed/ot2-aspirate", OT2, ASPIRATE, stateOf(OT2), "allowed"],
  ["allowed/ot2-aspirate-at-exactly-min", OT2, { name: "aspirate", params: { volumeUl: 1 } }, stateOf(OT2), "allowed"],
  ["allowed/ot2-aspirate-at-exactly-max", OT2, { name: "aspirate", params: { volumeUl: 300 } }, stateOf(OT2), "allowed"],
  ["allowed/ot2-zero-is-a-real-min", OT2, { name: "runProtocol", params: { minutes: 0, labwareSlot: 1 } }, stateOf(OT2), "allowed"],
  ["allowed/ot2-cold-zero-is-a-real-max", OT2_COLD, { name: "setModuleTemp", params: { celsius: 0 } }, stateOf(OT2_COLD), "allowed"],
  ["allowed/ot2-transfer", OT2, transfer(100, 100, 2), stateOf(OT2), "allowed"],
  ["allowed/ot2-stop", OT2, STOP, stateOf(OT2), "allowed"],
  ["allowed/ot2-stop-past-deadline", OT2, STOP, late(OT2), "allowed"],
  ["allowed/ot2-stop-at-rate-limit", OT2, STOP, stateOf(OT2, { recentCommandsAtMs: sends(60, NOW) }), "allowed"],
  ["allowed/ot2-stop-past-deadline-and-at-rate-limit", OT2, STOP, late(OT2, { recentCommandsAtMs: sends(60, T0 + DEADLINE_MS) }), "allowed"],
  ["allowed/ot2-at-exactly-the-deadline", OT2, ASPIRATE, stateOf(OT2, { nowMs: T0 + DEADLINE_MS }), "allowed"],
  ["allowed/ot2-elapsed-zero", OT2, ASPIRATE, stateOf(OT2, { nowMs: T0 }), "allowed"],
  ["allowed/ot2-59-sent-in-window", OT2, ASPIRATE, stateOf(OT2, { recentCommandsAtMs: sends(59, NOW - 1000) }), "allowed"],
  ["allowed/ot2-send-at-window-start-is-outside", OT2, ASPIRATE, stateOf(OT2, { recentCommandsAtMs: sends(60, NOW - 60_000) }), "allowed"],
  // astra pack 174 CRITICAL 1: a send time after now (a clock stepped back) is invalid state, never ignored.
  ["state-invalid/send-after-now", OT2, ASPIRATE, stateOf(OT2, { recentCommandsAtMs: sends(60, NOW + 1) }), "state-invalid"],
  // astra pack 174 MEDIUM 3: times are epoch milliseconds, safe integers, so no difference overflows.
  ["state-invalid/fractional-now", OT2, ASPIRATE, stateOf(OT2, { nowMs: NOW + 0.5 }), "state-invalid"],
  ["state-invalid/fractional-send", OT2, ASPIRATE, stateOf(OT2, { recentCommandsAtMs: [NOW - 0.5] }), "state-invalid"],
  ["state-invalid/unsafe-start-would-overflow", OT2, ASPIRATE, stateOf(OT2, { jobStartedAtMs: -Number.MAX_VALUE }), "state-invalid"],
  ["state-invalid/unsafe-now-past-the-safe-range", OT2, ASPIRATE, stateOf(OT2, { nowMs: 2 ** 60 }), "state-invalid"],
  // R8 template fit round 2: device-controlled quantities keep their limits; enumerated physical parameters.
  ["allowed/heated-run-device-controlled", HEATED, RUN, heatedState(), "allowed"],
  ["envelope-invalid/device-controlled-limit-removed", changed(HEATED, (e) => e.limits.shift()), RUN, heatedState(), "envelope-invalid"],
  ["envelope-invalid/device-controlled-dropped", changed(HEATED, (e) => (e.deviceControlled = [])), RUN, heatedState(), "envelope-invalid"],
  ["envelope-invalid/device-controlled-missing", changed(OT2, (e) => delete e.deviceControlled), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/device-controlled-the-deadline", changed(OT2, (e) => (e.deviceControlled = [{ quantity: "run_duration", enforcement: "telemetry", channel: "run.elapsed_min" }])), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/device-controlled-settable", changed(OT2, (e) => (e.deviceControlled = [{ quantity: "module_temperature", enforcement: "telemetry", channel: "module.temperature_c" }])), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/device-controlled-unknown-enforcement", changed(HEATED, (e) => (e.deviceControlled[0].enforcement = "trust")), RUN, heatedState(), "envelope-invalid"],
  // R8 template fit round 3 (astra pack 176): enforcement is a declared channel the runtime reads, never prose.
  ["envelope-invalid/device-controlled-cutoff", changed(HEATED, (e) => (e.deviceControlled[0].enforcement = "cutoff")), RUN, heatedState(), "envelope-invalid"],
  ["envelope-invalid/device-controlled-prose-detail", changed(HEATED, (e) => (e.deviceControlled[0] = { quantity: "incubation_temperature", enforcement: "cutoff", detail: "x" })), RUN, heatedState(), "envelope-invalid"],
  ["envelope-invalid/device-controlled-channel-unresolved", changed(HEATED, (e) => (e.deviceControlled[0].channel = "chamber.other")), RUN, heatedState(), "envelope-invalid"],
  ["envelope-invalid/device-controlled-channel-of-another-quantity", changed(HEATED, (e) => (e.deviceControlled[0].channel = "config.read_seconds")), RUN, heatedState(), "envelope-invalid"],
  ["envelope-invalid/telemetry-channels-missing", changed(OT2, (e) => delete e.telemetryChannels), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/telemetry-channels-emptied-while-named", changed(HEATED, (e) => (e.telemetryChannels = [])), RUN, heatedState(), "envelope-invalid"],
  ["envelope-invalid/telemetry-channels-out-of-order", changed(HEATED, (e) => e.telemetryChannels.reverse()), RUN, heatedState(), "envelope-invalid"],
  ["envelope-invalid/telemetry-channel-the-deadline", changed(HEATED, (e) => e.telemetryChannels.splice(1, 0, { id: "job.elapsed_min", quantity: "job_duration", unit: "min", semantics: "state", maxAgeMs: 1000 })), RUN, heatedState(), "envelope-invalid"],
  ["envelope-invalid/telemetry-channel-other-unit", changed(HEATED, (e) => (e.telemetryChannels[0].unit = "degF")), RUN, heatedState(), "envelope-invalid"],
  ["envelope-invalid/telemetry-channel-max-age-over-a-minute", changed(HEATED, (e) => (e.telemetryChannels[0].maxAgeMs = 60001)), RUN, heatedState(), "envelope-invalid"],
  ["envelope-invalid/telemetry-channel-max-age-fraction", changed(HEATED, (e) => (e.telemetryChannels[0].maxAgeMs = 1.5)), RUN, heatedState(), "envelope-invalid"],
  ["envelope-invalid/telemetry-channel-id-uppercase", changed(HEATED, (e) => (e.telemetryChannels[0].id = "Chamber.temperature_c")), RUN, heatedState(), "envelope-invalid"],
  ["envelope-invalid/telemetry-channel-extra-key", changed(HEATED, (e) => (e.telemetryChannels[0].detail = "thermistor")), RUN, heatedState(), "envelope-invalid"],
  // astra pack 178: every channel reports a state.
  ["envelope-invalid/telemetry-channel-semantics-elapsed", changed(HEATED, (e) => (e.telemetryChannels[1].semantics = "elapsed")), RUN, heatedState(), "envelope-invalid"],
  ["envelope-invalid/telemetry-channel-semantics-missing", changed(HEATED, (e) => delete e.telemetryChannels[1].semantics), RUN, heatedState(), "envelope-invalid"],
  // One set, one committed form (astra pack 176 MEDIUM).
  ["envelope-invalid/unbounded-allowed-out-of-order", changed(PLATE, (e) => (e.commands[1].params[1].unbounded.allowed = [450, 405, 600])), read({}), stateOf(PLATE), "envelope-invalid"],
  ["envelope-invalid/allowed-items-out-of-order", changed(PLATE, (e) => (e.commands[1].params[2].unbounded.allowedItems = ["A2", "A1", "A3", "H12"])), read({}), stateOf(PLATE), "envelope-invalid"],
  ["envelope-invalid/preset-out-of-order", changed(OT2_PRESET, (e) => (e.commands[presetIndex].params[0].allowed = [37, 4, 95])), ASPIRATE, stateOf(OT2_PRESET), "envelope-invalid"],
  // Rule 9: every committed channel has a current reading inside its quantity's limit.
  ["allowed/telemetry-readings-at-exactly-max-age", HEATED, RUN, heatedState({ telemetry: [chamber(37, NOW - 5000), readSeconds(30, NOW - 1000)] }), "allowed"],
  ["allowed/telemetry-readings-at-exactly-the-limits", HEATED, RUN, heatedState({ telemetry: [chamber(45, NOW), readSeconds(600, NOW)] }), "allowed"],
  ["allowed/telemetry-reading-at-exactly-the-min", HEATED, RUN, heatedState({ telemetry: [chamber(20, NOW), readSeconds(1, NOW)] }), "allowed"],
  ["allowed/telemetry-reading-of-an-uncommitted-channel-is-ignored", HEATED, RUN, heatedState({ telemetry: [...READINGS, { channel: "door.open", value: 1, atMs: NOW }] }), "allowed"],
  ["allowed/telemetry-readings-in-any-order", HEATED, RUN, heatedState({ telemetry: [readSeconds(30, NOW), chamber(37, NOW)] }), "allowed"],
  ["telemetry-stale/temperature-1-ms-past-max-age", HEATED, RUN, heatedState({ telemetry: [chamber(37, NOW - 5001), readSeconds(30, NOW)] }), "telemetry-stale"],
  ["telemetry-stale/read-seconds-1-ms-past-max-age", HEATED, RUN, heatedState({ telemetry: [chamber(37, NOW), readSeconds(30, NOW - 1001)] }), "telemetry-stale"],
  ["telemetry-missing/no-reading-of-one-channel", HEATED, RUN, heatedState({ telemetry: [readSeconds(30, NOW)] }), "telemetry-missing"],
  ["telemetry-missing/no-readings", HEATED, RUN, heatedState({ telemetry: [] }), "telemetry-missing"],
  ["telemetry-missing/only-an-uncommitted-channel", HEATED, RUN, heatedState({ telemetry: [{ channel: "door.open", value: 0, atMs: NOW }] }), "telemetry-missing"],
  ["telemetry-missing/before-the-params", HEATED, { name: "run", params: { extra: 1 } }, heatedState({ telemetry: [] }), "telemetry-missing"],
  ["telemetry-out-of-limit/temperature-above-the-max", HEATED, RUN, heatedState({ telemetry: [chamber(45.5, NOW), readSeconds(30, NOW)] }), "telemetry-out-of-limit"],
  ["telemetry-out-of-limit/temperature-below-the-min", HEATED, RUN, heatedState({ telemetry: [chamber(19.9, NOW), readSeconds(30, NOW)] }), "telemetry-out-of-limit"],
  ["telemetry-out-of-limit/read-seconds-above-the-max", HEATED, RUN, heatedState({ telemetry: [chamber(37, NOW), readSeconds(600.001, NOW)] }), "telemetry-out-of-limit"],
  // A configured duration below its real minimum (astra pack 178: the minimum is no longer erased).
  ["telemetry-out-of-limit/read-seconds-below-the-min", HEATED, RUN, heatedState({ telemetry: [chamber(37, NOW), readSeconds(0.999, NOW)] }), "telemetry-out-of-limit"],
  ["telemetry-out-of-limit/read-seconds-zero", HEATED, RUN, heatedState({ telemetry: [chamber(37, NOW), readSeconds(0, NOW)] }), "telemetry-out-of-limit"],
  // astra pack 179 MEDIUM: a bound of 0 is a bound (a truthiness test would skip it).
  ["allowed/zero-min-reading-exactly-zero", OT2_MONITORED_FROM_ZERO, ASPIRATE, stateOf(OT2_MONITORED_FROM_ZERO, { telemetry: [moduleTemp(0, NOW)] }), "allowed"],
  ["telemetry-out-of-limit/zero-min-reading-just-below", OT2_MONITORED_FROM_ZERO, ASPIRATE, stateOf(OT2_MONITORED_FROM_ZERO, { telemetry: [moduleTemp(-5e-324, NOW)] }), "telemetry-out-of-limit"],
  ["telemetry-out-of-limit/zero-min-reading-minus-one", OT2_MONITORED_FROM_ZERO, ASPIRATE, stateOf(OT2_MONITORED_FROM_ZERO, { telemetry: [moduleTemp(-1, NOW)] }), "telemetry-out-of-limit"],
  ["allowed/zero-max-reading-exactly-zero", OT2_MONITORED_COLD, ASPIRATE, stateOf(OT2_MONITORED_COLD, { telemetry: [moduleTemp(0, NOW)] }), "allowed"],
  ["telemetry-out-of-limit/zero-max-reading-just-above", OT2_MONITORED_COLD, ASPIRATE, stateOf(OT2_MONITORED_COLD, { telemetry: [moduleTemp(5e-324, NOW)] }), "telemetry-out-of-limit"],
  ["allowed/zero-max-reading-at-the-min", OT2_MONITORED_COLD, ASPIRATE, stateOf(OT2_MONITORED_COLD, { telemetry: [moduleTemp(-20, NOW)] }), "allowed"],
  ["telemetry-missing/monitored-settable-quantity-unread", OT2_MONITORED_COLD, ASPIRATE, stateOf(OT2_MONITORED_COLD), "telemetry-missing"],
  ["telemetry-out-of-limit/reading-a-numeric-string", HEATED, RUN, heatedState({ telemetry: [chamber("37", NOW), readSeconds(30, NOW)] }), "telemetry-out-of-limit"],
  ["telemetry-out-of-limit/reading-null", HEATED, RUN, heatedState({ telemetry: [chamber(null, NOW), readSeconds(30, NOW)] }), "telemetry-out-of-limit"],
  ["telemetry-out-of-limit/reading-true", HEATED, RUN, heatedState({ telemetry: [chamber(true, NOW), readSeconds(30, NOW)] }), "telemetry-out-of-limit"],
  ["telemetry-out-of-limit/reading-a-list", HEATED, RUN, heatedState({ telemetry: [chamber([37], NOW), readSeconds(30, NOW)] }), "telemetry-out-of-limit"],
  ["allowed/stop-with-stale-readings", HEATED, STOP, heatedState({ telemetry: [chamber(37, NOW - 60_000), readSeconds(30, NOW - 60_000)] }), "allowed"],
  ["allowed/stop-with-no-readings", HEATED, STOP, heatedState({ telemetry: [] }), "allowed"],
  ["allowed/stop-with-an-out-of-limit-reading", HEATED, STOP, heatedState({ telemetry: [chamber(200, NOW), readSeconds(30, NOW)] }), "allowed"],
  ["past-deadline/before-the-readings", HEATED, RUN, heatedState({ nowMs: T0 + DEADLINE_MS + 1, telemetry: [] }), "past-deadline"],
  ["rate-limited/before-the-readings", HEATED, RUN, heatedState({ recentCommandsAtMs: sends(30, NOW), telemetry: [] }), "rate-limited"],
  ["state-invalid/reading-taken-after-now", HEATED, RUN, heatedState({ telemetry: [chamber(37, NOW + 1), readSeconds(30, NOW)] }), "state-invalid"],
  ["state-invalid/two-readings-of-one-channel", HEATED, RUN, heatedState({ telemetry: [chamber(37, NOW), chamber(38, NOW - 1), readSeconds(30, NOW)] }), "state-invalid"],
  ["state-invalid/telemetry-absent", HEATED, RUN, { adapterManifestDigest: HEATED.adapterVersion, jobStartedAtMs: T0, nowMs: NOW, recentCommandsAtMs: [] }, "state-invalid"],
  ["state-invalid/telemetry-not-a-list", HEATED, RUN, heatedState({ telemetry: { "chamber.temperature_c": 37 } }), "state-invalid"],
  ["state-invalid/reading-extra-key", HEATED, RUN, heatedState({ telemetry: [{ ...chamber(37, NOW), unit: "degC" }, readSeconds(30, NOW)] }), "state-invalid"],
  ["state-invalid/reading-without-a-value", HEATED, RUN, heatedState({ telemetry: [{ channel: "chamber.temperature_c", atMs: NOW }, readSeconds(30, NOW)] }), "state-invalid"],
  ["state-invalid/reading-fractional-time", HEATED, RUN, heatedState({ telemetry: [chamber(37, NOW - 0.5), readSeconds(30, NOW)] }), "state-invalid"],
  ["state-invalid/reading-channel-not-an-id", HEATED, RUN, heatedState({ telemetry: [{ channel: "Chamber", value: 37, atMs: NOW }, readSeconds(30, NOW)] }), "state-invalid"],
  ["state-invalid/stop-with-a-reading-from-the-future", HEATED, STOP, heatedState({ telemetry: [chamber(37, NOW + 1)] }), "state-invalid"],
  ["allowed/preset-listed-value", OT2_PRESET, { name: "setModuleTemp", params: { celsius: 37 } }, stateOf(OT2_PRESET), "allowed"],
  ["value-not-allowed/preset-unlisted-value-in-range", OT2_PRESET, { name: "setModuleTemp", params: { celsius: 50 } }, stateOf(OT2_PRESET), "value-not-allowed"],
  ["out-of-range/preset-value-outside-the-limit", OT2_PRESET, { name: "setModuleTemp", params: { celsius: 120 } }, stateOf(OT2_PRESET), "out-of-range"],
  ["envelope-invalid/preset-allows-a-value-outside-the-limit", changed(OT2_PRESET, (e) => (e.commands[presetIndex].params[0].allowed = [4, 120])), ASPIRATE, stateOf(OT2_PRESET), "envelope-invalid"],
  ["allowed/ot2-old-sends-not-counted", OT2, ASPIRATE, stateOf(OT2, { recentCommandsAtMs: [...sends(300, NOW - 3_600_000), ...sends(59, NOW)] }), "allowed"],
  ["allowed/state-extra-key-ignored", OT2, ASPIRATE, stateOf(OT2, { deviceId: "ot2-sim-1" }), "allowed"],
  ["allowed/plate-read-the-single-value", PLATE, read({}), stateOf(PLATE), "allowed"],
  ["allowed/plate-read-a-list-of-items-any-order", PLATE, read({ wells: ["H12", "A1"] }), stateOf(PLATE), "allowed"],
  ["allowed/plate-hardware-stop-on-time", PLATE, STOP, stateOf(PLATE, { recentCommandsAtMs: sends(29, NOW) }), "allowed"],

  // ── 1. envelope-invalid ──
  ["envelope-invalid/null", null, ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/a-list", [OT2], ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/strict-false", changed(OT2, (e) => (e.strict = false)), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/extra-key", changed(OT2, (e) => (e.defaults = { maxTemperature: 300 })), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/version-2", changed(OT2, (e) => (e.envelopeVersion = 2)), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/unknown-device-class", changed(OT2, (e) => (e.deviceClass = "unknown-robot")), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/blank-device-id", changed(OT2, (e) => (e.deviceId = " ")), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  // U+FEFF is whitespace to JavaScript's trim (not to Python's str.strip).
  ["envelope-invalid/device-id-only-u+feff", changed(OT2, (e) => (e.deviceId = ch(0xfeff))), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/limit-max-numeric-string", changed(OT2, (e) => (e.limits[0].max = "300")), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/limit-min-above-max", changed(OT2, (e) => (e.limits[0].min = 500)), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/limits-out-of-order", changed(OT2, (e) => e.limits.reverse()), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/limit-in-another-unit", changed(OT2, (e) => (e.limits[0].unit = "mL")), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/digest-uppercase", changed(OT2, (e) => (e.envelopeDigest = `0x${"AB".repeat(32)}`)), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/adapter-version-not-a-digest", changed(OT2, (e) => (e.adapterVersion = "2.1.0")), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  // A regex `$` that matches before a final newline (Python's re) would accept this.
  ["envelope-invalid/adapter-version-trailing-newline", changed(OT2, (e) => (e.adapterVersion = `${e.adapterVersion}${ch(10)}`)), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/rate-fraction", changed(OT2, (e) => (e.maxCommandsPerMinute = 1.5)), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/rate-zero", changed(OT2, (e) => (e.maxCommandsPerMinute = 0)), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/rate-numeric-string", changed(OT2, (e) => (e.maxCommandsPerMinute = "60")), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/rate-true", changed(OT2, (e) => (e.maxCommandsPerMinute = true)), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/estop-none-on-a-device-that-moves-or-heats", changed(OT2, (e) => (e.eStop = { mechanism: "none" })), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/hardware-stop-with-a-command", changed(OT2, (e) => (e.eStop = { mechanism: "hardware", stopCommand: "stop" })), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/adapter-stop-undeclared-command", changed(OT2, (e) => (e.eStop.stopCommand = "halt")), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/adapter-stop-blank-command", changed(OT2, (e) => (e.eStop.stopCommand = "  ")), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/supervision-unattended", changed(OT2, (e) => (e.supervision = "unattended")), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/supervision-unknown", changed(OT2, (e) => (e.supervision = "sometimes")), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/hazards-out-of-order", changed(OT2, (e) => (e.hazards = ["mechanical", "heat"])), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/hazards-duplicated", changed(OT2, (e) => (e.hazards = ["heat", "heat"])), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/command-declared-twice", changed(OT2, (e) => e.commands.push(e.commands[0])), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/param-extra-key", changed(OT2, (e) => (e.commands[0].params[0].fallback = 1)), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/unbounded-free-form", changed(OT2, (e) => e.commands[0].params.push({ name: "payload", unbounded: "device-specific" })), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/unbounded-allowed-empty", changed(OT2, (e) => e.commands[0].params.push({ name: "slot", unbounded: { reason: "a slot", allowed: [] } })), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/unbounded-allowed-true", changed(OT2, (e) => e.commands[0].params.push({ name: "slot", unbounded: { reason: "a slot", allowed: [true] } })), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/a-bounded-quantity-no-param-sets", changed(OT2, (e) => (e.commands = e.commands.filter((c: any) => c.name !== "setModuleTemp"))), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/wrong-deadline-quantity", changed(OT2, (e) => (e.deadlineQuantity = "aspirate_volume")), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/missing-commands", changed(OT2, (e) => delete e.commands), ASPIRATE, stateOf(OT2), "envelope-invalid"],
  ["envelope-invalid/before-everything-else", changed(OT2, (e) => (e.strict = false)), null, null, "envelope-invalid"],

  // ── 2. state-invalid ──
  ["state-invalid/null", OT2, ASPIRATE, null, "state-invalid"],
  ["state-invalid/a-list", OT2, ASPIRATE, [stateOf(OT2)], "state-invalid"],
  ["state-invalid/missing-now", OT2, ASPIRATE, { adapterManifestDigest: OT2.adapterVersion, jobStartedAtMs: T0, recentCommandsAtMs: [] }, "state-invalid"],
  ["state-invalid/digest-uppercase", OT2, ASPIRATE, stateOf(OT2, { adapterManifestDigest: `sha256:${"AB".repeat(32)}` }), "state-invalid"],
  ["state-invalid/digest-short", OT2, ASPIRATE, stateOf(OT2, { adapterManifestDigest: `sha256:${"21".repeat(31)}` }), "state-invalid"],
  ["state-invalid/digest-trailing-newline", OT2, ASPIRATE, stateOf(OT2, { adapterManifestDigest: `${OT2.adapterVersion}${ch(10)}` }), "state-invalid"],
  ["state-invalid/digest-0x-prefixed", OT2, ASPIRATE, stateOf(OT2, { adapterManifestDigest: `0x${"21".repeat(32)}` }), "state-invalid"],
  ["state-invalid/now-numeric-string", OT2, ASPIRATE, stateOf(OT2, { nowMs: String(NOW) }), "state-invalid"],
  // A boolean is never a number (Python's bool is an int).
  ["state-invalid/job-start-true", OT2, ASPIRATE, stateOf(OT2, { jobStartedAtMs: true }), "state-invalid"],
  ["state-invalid/job-starts-after-now", OT2, ASPIRATE, stateOf(OT2, { jobStartedAtMs: NOW + 1 }), "state-invalid"],
  ["state-invalid/recent-not-a-list", OT2, ASPIRATE, stateOf(OT2, { recentCommandsAtMs: NOW }), "state-invalid"],
  ["state-invalid/recent-holds-a-string", OT2, ASPIRATE, stateOf(OT2, { recentCommandsAtMs: [NOW, String(NOW)] }), "state-invalid"],
  ["state-invalid/recent-holds-null", OT2, ASPIRATE, stateOf(OT2, { recentCommandsAtMs: [null] }), "state-invalid"],
  ["state-invalid/recent-holds-true", OT2, ASPIRATE, stateOf(OT2, { recentCommandsAtMs: [true] }), "state-invalid"],
  ["state-invalid/before-the-adapter", OT2, ASPIRATE, stateOf(OT2, { adapterManifestDigest: OTHER_MANIFEST, nowMs: "now" }), "state-invalid"],

  // ── 3. adapter-mismatch ──
  ["adapter-mismatch/another-adapter", OT2, ASPIRATE, stateOf(OT2, { adapterManifestDigest: OTHER_MANIFEST }), "adapter-mismatch"],
  ["adapter-mismatch/the-stop-too", OT2, STOP, late(OT2, { adapterManifestDigest: OTHER_MANIFEST }), "adapter-mismatch"],
  ["adapter-mismatch/before-the-command", OT2, { name: " ", params: [] }, stateOf(PLATE), "adapter-mismatch"],

  // ── 4. command-malformed ──
  ["command-malformed/null", OT2, null, stateOf(OT2), "command-malformed"],
  ["command-malformed/a-list", OT2, [ASPIRATE], stateOf(OT2), "command-malformed"],
  ["command-malformed/a-string", OT2, "aspirate", stateOf(OT2), "command-malformed"],
  ["command-malformed/missing-params", OT2, { name: "aspirate" }, stateOf(OT2), "command-malformed"],
  ["command-malformed/extra-key", OT2, { ...ASPIRATE, id: "c-1" }, stateOf(OT2), "command-malformed"],
  ["command-malformed/params-a-list", OT2, { name: "aspirate", params: [150] }, stateOf(OT2), "command-malformed"],
  ["command-malformed/params-null", OT2, { name: "aspirate", params: null }, stateOf(OT2), "command-malformed"],
  ["command-malformed/name-blank", OT2, { name: "  ", params: {} }, stateOf(OT2), "command-malformed"],
  ["command-malformed/name-a-number", OT2, { name: 7, params: {} }, stateOf(OT2), "command-malformed"],
  ["command-malformed/name-only-u+feff", OT2, { name: ch(0xfeff), params: {} }, stateOf(OT2), "command-malformed"],
  ["command-malformed/a-key-named-__proto__", OT2, { name: "aspirate", params: JSON.parse('{"volumeUl": 150, "__proto__": {"volumeUl": 1}}') }, stateOf(OT2), "command-malformed"],
  ["command-malformed/before-unknown-command", OT2, { name: "blowout", params: "x" }, stateOf(OT2), "command-malformed"],

  // ── 5. unknown-command ──
  ["unknown-command/undeclared", OT2, { name: "blowout", params: {} }, stateOf(OT2), "unknown-command"],
  ["unknown-command/wrong-case", OT2, { name: "Aspirate", params: { volumeUl: 150 } }, stateOf(OT2), "unknown-command"],
  ["unknown-command/padded", OT2, { name: " aspirate", params: { volumeUl: 150 } }, stateOf(OT2), "unknown-command"],
  ["unknown-command/inherited-name", OT2, { name: "toString", params: {} }, stateOf(OT2), "unknown-command"],
  ["unknown-command/another-devices-command", OT2, read({}), stateOf(OT2), "unknown-command"],
  // Not whitespace to JavaScript's trim, so not blank (Python's str.strip removes both).
  ["unknown-command/name-only-u+001c", OT2, { name: ch(0x1c), params: {} }, stateOf(OT2), "unknown-command"],
  ["unknown-command/name-only-u+0085", OT2, { name: ch(0x85), params: {} }, stateOf(OT2), "unknown-command"],

  // ── 7. past-deadline ──
  ["past-deadline/1-ms-past", OT2, ASPIRATE, late(OT2), "past-deadline"],
  ["state-invalid/half-a-ms-is-not-an-epoch-ms", OT2, ASPIRATE, stateOf(OT2, { jobStartedAtMs: 0, nowMs: DEADLINE_MS + 0.5 }), "state-invalid"],
  ["past-deadline/plate-1-ms-past", PLATE, read({}), late(PLATE), "past-deadline"],
  ["past-deadline/hardware-stop-not-exempt", PLATE, STOP, late(PLATE), "past-deadline"],
  ["past-deadline/a-fractional-max", changed(OT2, (e) => (e.limits[3].max = 1.5)), ASPIRATE, stateOf(OT2, { nowMs: T0 + 90_001 }), "past-deadline"],
  ["past-deadline/a-zero-max", changed(OT2, (e) => (e.limits[3].max = 0)), ASPIRATE, stateOf(OT2, { nowMs: T0 + 1 }), "past-deadline"],
  ["past-deadline/before-the-rate", OT2, ASPIRATE, late(OT2, { recentCommandsAtMs: sends(60, T0 + DEADLINE_MS) }), "past-deadline"],
  ["past-deadline/before-the-params", OT2, { name: "aspirate", params: { volumeUl: "x", extra: 1 } }, late(OT2), "past-deadline"],
  // The elapsed-time seam: no command parameter carries the deadline, and the job is stopped on elapsed time alone.
  ["allowed/elapsed-only-at-exactly-the-deadline", OT2_ELAPSED_ONLY, ASPIRATE, stateOf(OT2_ELAPSED_ONLY, { nowMs: T0 + DEADLINE_MS }), "allowed"],
  ["past-deadline/elapsed-only-1-ms-past", OT2_ELAPSED_ONLY, ASPIRATE, late(OT2_ELAPSED_ONLY), "past-deadline"],
  ["past-deadline/elapsed-only-run-protocol-1-ms-past", OT2_ELAPSED_ONLY, { name: "runProtocol", params: { labwareSlot: 1 } }, late(OT2_ELAPSED_ONLY), "past-deadline"],
  ["allowed/elapsed-only-stop-past-deadline", OT2_ELAPSED_ONLY, STOP, late(OT2_ELAPSED_ONLY), "allowed"],
  ["undeclared-param/elapsed-only-a-deadline-param-it-does-not-declare", OT2_ELAPSED_ONLY, { name: "runProtocol", params: { minutes: 10, labwareSlot: 1 } }, stateOf(OT2_ELAPSED_ONLY), "undeclared-param"],

  // ── 8. rate-limited ──
  ["rate-limited/60-sent", OT2, ASPIRATE, stateOf(OT2, { recentCommandsAtMs: sends(60, NOW - 1000) }), "rate-limited"],
  ["rate-limited/send-at-now-minus-59999-is-inside", OT2, ASPIRATE, stateOf(OT2, { recentCommandsAtMs: sends(60, NOW - 59_999) }), "rate-limited"],
  ["rate-limited/send-at-now-is-inside", OT2, ASPIRATE, stateOf(OT2, { recentCommandsAtMs: sends(60, NOW) }), "rate-limited"],
  ["state-invalid/fractional-send-at-the-edge", OT2, ASPIRATE, stateOf(OT2, { recentCommandsAtMs: sends(60, NOW - 59_999.5) }), "state-invalid"],
  ["rate-limited/plate-30-sent", PLATE, read({}), stateOf(PLATE, { recentCommandsAtMs: sends(30, NOW) }), "rate-limited"],
  ["rate-limited/hardware-stop-not-exempt", PLATE, STOP, stateOf(PLATE, { recentCommandsAtMs: sends(30, NOW) }), "rate-limited"],
  ["rate-limited/before-the-params", OT2, { name: "aspirate", params: { volumeUl: 150, extra: 1 } }, stateOf(OT2, { recentCommandsAtMs: sends(60, NOW) }), "rate-limited"],

  // ── 9. undeclared-param ──
  ["undeclared-param/extra", OT2, { name: "aspirate", params: { volumeUl: 150, speed: 2 } }, stateOf(OT2), "undeclared-param"],
  ["undeclared-param/on-the-stop", OT2, { name: "stop", params: { force: true } }, stateOf(OT2), "undeclared-param"],
  ["undeclared-param/on-a-late-stop", OT2, { name: "stop", params: { force: true } }, late(OT2, { recentCommandsAtMs: sends(60, T0 + DEADLINE_MS) }), "undeclared-param"],
  ["undeclared-param/inherited-name", OT2, { name: "aspirate", params: { volumeUl: 150, constructor: 1 } }, stateOf(OT2), "undeclared-param"],
  ["undeclared-param/before-missing", OT2, { name: "aspirate", params: { celsius: 37 } }, stateOf(OT2), "undeclared-param"],

  // ── 10. missing-param ──
  ["missing-param/absent", OT2, { name: "aspirate", params: {} }, stateOf(OT2), "missing-param"],
  ["missing-param/one-of-three", PLATE, { name: "read", params: { seconds: 30, wavelengthNm: 450 } }, stateOf(PLATE), "missing-param"],
  ["missing-param/before-any-value", OT2, { name: "transfer", params: { aspirateUl: "x" } }, stateOf(OT2), "missing-param"],

  // ── 11. not-a-number ──
  ["not-a-number/numeric-string", OT2, { name: "aspirate", params: { volumeUl: "150" } }, stateOf(OT2), "not-a-number"],
  ["not-a-number/empty-string", OT2, { name: "aspirate", params: { volumeUl: "" } }, stateOf(OT2), "not-a-number"],
  ["not-a-number/null", OT2, { name: "aspirate", params: { volumeUl: null } }, stateOf(OT2), "not-a-number"],
  ["not-a-number/true", OT2, { name: "aspirate", params: { volumeUl: true } }, stateOf(OT2), "not-a-number"],
  ["not-a-number/a-list", OT2, { name: "aspirate", params: { volumeUl: [150] } }, stateOf(OT2), "not-a-number"],
  ["not-a-number/a-value-with-a-unit", OT2, { name: "aspirate", params: { volumeUl: { value: 0.15, unit: "mL" } } }, stateOf(OT2), "not-a-number"],
  ["not-a-number/first-declared-decides", OT2, transfer("5", 1e9, 1), stateOf(OT2), "not-a-number"],

  // ── 11. out-of-range ──
  ["out-of-range/max-plus-one-ulp", OT2, { name: "aspirate", params: { volumeUl: 300.00000000000006 } }, stateOf(OT2), "out-of-range"],
  ["out-of-range/min-minus-one-ulp", OT2, { name: "aspirate", params: { volumeUl: 0.9999999999999999 } }, stateOf(OT2), "out-of-range"],
  ["out-of-range/below-a-zero-min", OT2, { name: "runProtocol", params: { minutes: -5e-324, labwareSlot: 1 } }, stateOf(OT2), "out-of-range"],
  ["out-of-range/above-a-zero-max", OT2_COLD, { name: "setModuleTemp", params: { celsius: 5e-324 } }, stateOf(OT2_COLD), "out-of-range"],
  ["out-of-range/huge", OT2, { name: "aspirate", params: { volumeUl: 1e308 } }, stateOf(OT2), "out-of-range"],
  ["out-of-range/no-unit-conversion", OT2, { name: "aspirate", params: { volumeUl: 0.3 } }, stateOf(OT2), "out-of-range"],
  ["out-of-range/the-deadline-quantity-as-a-param", OT2, { name: "runProtocol", params: { minutes: 120.00000000000001, labwareSlot: 1 } }, stateOf(OT2), "out-of-range"],
  ["out-of-range/first-declared-decides", OT2, transfer(1e9, "5", 1), stateOf(OT2), "out-of-range"],
  ["out-of-range/before-unbounded", OT2, transfer(100, 1e9, 99), stateOf(OT2), "out-of-range"],

  // ── 12. value-not-allowed ──
  ["value-not-allowed/not-listed", OT2, slot(12), stateOf(OT2), "value-not-allowed"],
  ["value-not-allowed/numeric-string-for-a-number", OT2, slot("1"), stateOf(OT2), "value-not-allowed"],
  // true is not 1 (in Python, True == 1).
  ["value-not-allowed/true-for-1", OT2, slot(true), stateOf(OT2), "value-not-allowed"],
  ["value-not-allowed/a-list-without-allowedItems", OT2, slot([1]), stateOf(OT2), "value-not-allowed"],
  ["value-not-allowed/string-for-a-number", PLATE, read({ wavelengthNm: "405" }), stateOf(PLATE), "value-not-allowed"],
  ["value-not-allowed/items-empty", PLATE, read({ wells: [] }), stateOf(PLATE), "value-not-allowed"],
  ["value-not-allowed/items-duplicated", PLATE, read({ wells: ["A1", "A1"] }), stateOf(PLATE), "value-not-allowed"],
  ["value-not-allowed/items-non-member", PLATE, read({ wells: ["A1", "B7"] }), stateOf(PLATE), "value-not-allowed"],
  ["value-not-allowed/items-wrong-case", PLATE, read({ wells: ["a1"] }), stateOf(PLATE), "value-not-allowed"],
  ["value-not-allowed/items-an-object", PLATE, read({ wells: [{ A1: true }] }), stateOf(PLATE), "value-not-allowed"],
  ["value-not-allowed/items-a-nested-list", PLATE, read({ wells: [["A1"]] }), stateOf(PLATE), "value-not-allowed"],
  ["value-not-allowed/a-single-item-is-not-a-value", PLATE, read({ wells: "A1" }), stateOf(PLATE), "value-not-allowed"],
  ["value-not-allowed/the-value-is-not-an-item", PLATE, read({ wells: ["all"] }), stateOf(PLATE), "value-not-allowed"],
];

const CODES: RuntimeRefusalCode[] = [
  "envelope-invalid", "state-invalid", "adapter-mismatch", "command-malformed", "unknown-command", "past-deadline", "rate-limited",
  "telemetry-missing", "telemetry-stale", "telemetry-out-of-limit",
  "undeclared-param", "missing-param", "not-a-number", "out-of-range", "value-not-allowed",
];

type Decision = { allowed: true } | { allowed: false; code: string };

/** The vectors as JSON data (what a consumer reads), each with the decision the reference returns for it. */
function buildFixtures() {
  const vectors = VECTORS.map(([name, envelope, command, state]) => {
    const json = JSON.parse(JSON.stringify({ envelope, command, state })) as { envelope: unknown; command: unknown; state: unknown };
    const d = checkRuntimeCommand(json.envelope, json.command, json.state);
    const decision: Decision = d.allowed ? { allowed: true } : { allowed: false, code: d.code };
    return { name, envelope: json.envelope, command: json.command, state: json.state, decision };
  });
  return {
    _comment: [
      "GENERATED by packages/spec/src/__tests__/envelope-runtime-check-fixtures.test.ts from the TS reference (onboarding/envelope-runtime-check.ts); do not edit by hand.",
      "Regenerate: PCC_UPDATE_FIXTURES=1 npx --no-install vitest run src/__tests__/envelope-runtime-check-fixtures.test.ts (in packages/spec).",
      "Each vector: checkRuntimeCommand(envelope, command, state) must return decision, {allowed: true} or {allowed: false, code}. Reasons are human messages and are not part of the contract.",
      "Rules, in order; the first failure decides: 1 envelope-invalid, 2 state-invalid, 3 adapter-mismatch, 4 command-malformed, 5 unknown-command, 6 the adapter stop (eStop.stopCommand) skips 7, 8 and 9, 7 past-deadline, 8 rate-limited, 9 telemetry-missing then telemetry-stale then telemetry-out-of-limit per committed channel in envelope order, 10 undeclared-param, 11 missing-param, 12 not-a-number then out-of-range per bounded param in declaration order, 13 value-not-allowed, 14 allowed.",
      "Format: one line per field of each vector; every value is plain JSON data. The envelopes are compiled OT-2 (adapter stop) and plate-reader (hardware stop) envelopes, or invalid copies of the OT-2's. The plate reader and the elapsed-only OT-2 have no command parameter for their deadline quantity: the deadline is elapsed time alone (the elapsed-only vectors and plate-1-ms-past).",
      "Parity notes for a non-JavaScript runtime. Numbers: read every JSON number as an IEEE-754 double; a boolean is never a number (Python's bool is an int, and True == 1); a numeric string is never a number. Blank: JavaScript's String.prototype.trim, which strips U+FEFF but not U+001C..U+001F or U+0085 (Python's str.strip differs on all of these). Digests: exact length and characters, no trailing newline (a regex $ in Python matches before one).",
      "Plain data: NaN and Infinity (which Python's json.loads accepts by default) are not JSON data and make the input they appear in invalid (envelope-invalid, state-invalid or command-malformed); so does a key named __proto__ anywhere. An undefined member is absent. List items are distinct by their JSON text as JavaScript writes it (1 and 1.0 are one item).",
      "Time: elapsed = nowMs - jobStartedAtMs, refused when strictly greater than the deadline limit's max times 1000 (s), 60000 (min) or 3600000 (h). The rate window is (nowMs - 60000, nowMs]: a send time equal to nowMs - 60000, or after nowMs, is outside it; refused when the count is >= maxCommandsPerMinute.",
      "astra pack 174: every time in the state is an epoch millisecond, a safe integer (|t| <= 9007199254740991), so no difference overflows; a fractional or unsafe time is state-invalid. A send time after nowMs means the clock stepped back: state-invalid, never ignored.",
      "astra pack 174: a stop sent through this ordinary check is still held to rules 1-5 and 10-13. A genuine EMERGENCY stop never comes through it: the governor calls the adapter's pre-wired stop directly (emergencyStopOf returns it from the envelope alone), and escalates to the hardware stop when the adapter's identity cannot be trusted.",
      "R8 template fit round 2 (astra pack 173): every template quantity keeps a limit. deviceControlled lists the ones no command sets, in template order, never the deadline; the envelope's limits still hold all of them. A parameter that sets a quantity may list its only values (allowed): a value must be one of them (value-not-allowed), and every listed value lies inside the limit (else envelope-invalid).",
      "R8 template fit round 3 (astra pack 176): telemetryChannels lists the readings the adapter takes, each {id, quantity, unit, maxAgeMs}, ids strictly ascending, a non-deadline template quantity in its unit, maxAgeMs a whole number 1..60000; each deviceControlled entry is {quantity, enforcement: 'telemetry', channel} and its channel must be one of them reporting that quantity. Every value set (allowed, unbounded.allowed, unbounded.allowedItems) lists each value once: numbers ascending, then strings ascending by UTF-16 code unit (else envelope-invalid).",
      "Rule 9 (round 4, astra packs 178 and 179): every channel reports a state, so both bounds apply at every check. A bound of 0 is a bound: never test a bound for truthiness (Python's 'if minimum and value < minimum' accepts -5e-324 under a 0 minimum); the zero-min and zero-max vectors read exactly 0 and the nearest double past it.",
      "Rule 9 (readings): state.telemetry is a list of the latest readings, {channel, value, atMs} each, one per channel (a second reading of a channel is state-invalid), atMs an epoch millisecond never after nowMs (else state-invalid); a reading of a channel the envelope does not commit is ignored. For each committed channel in envelope order: no reading is telemetry-missing; nowMs - atMs > maxAgeMs is telemetry-stale (exactly maxAgeMs is current); a value that is not a finite number (a boolean, a numeric string, null) or lies outside the channel quantity's [min, max] is telemetry-out-of-limit. The adapter stop skips rule 9, as it skips 7 and 8.",
    ],
    codes: CODES,
    vectors,
  };
}

/** One line per field of each vector, so a change shows as the lines of the vectors it touches. */
function render(fixtures: ReturnType<typeof buildFixtures>): string {
  const indent = (text: string, spaces: string) => text.split("\n").join(`\n${spaces}`);
  const vector = (v: (typeof fixtures.vectors)[number]) =>
    [
      "    {",
      `      "name": ${JSON.stringify(v.name)},`,
      `      "envelope": ${JSON.stringify(v.envelope)},`,
      `      "command": ${JSON.stringify(v.command)},`,
      `      "state": ${JSON.stringify(v.state)},`,
      `      "decision": ${JSON.stringify(v.decision)}`,
      "    }",
    ].join("\n");
  return [
    "{",
    `  "_comment": ${indent(JSON.stringify(fixtures._comment, null, 2), "  ")},`,
    `  "codes": ${JSON.stringify(fixtures.codes)},`,
    '  "vectors": [',
    fixtures.vectors.map(vector).join(",\n"),
    "  ]",
    "}",
    "",
  ].join("\n");
}

describe("runtime check parity fixtures (for pcc-node)", () => {
  const fixtures = buildFixtures();
  const text = render(fixtures);

  if (process.env.PCC_UPDATE_FIXTURES === "1") {
    mkdirSync(dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, text);
  }

  it("the committed fixture file is exactly what the reference produces now", () => {
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });

  it("the rendering is faithful: the file parses back to exactly the fixtures", () => {
    expect(JSON.parse(text)).toEqual(fixtures);
  });

  it("every vector's decision is the code written for it here", () => {
    const wrong: string[] = [];
    for (let i = 0; i < VECTORS.length; i++) {
      const [name, , , , expected] = VECTORS[i]!;
      const d = fixtures.vectors[i]!.decision;
      const got = d.allowed ? "allowed" : d.code;
      if (got !== expected) wrong.push(`${name}: expected ${expected}, got ${got}`);
    }
    expect(wrong).toEqual([]);
  });

  it("every vector is JSON data, checked as a JSON consumer reads it, and names are unique", () => {
    for (const [name, envelope, command, state] of VECTORS) {
      const json = JSON.parse(JSON.stringify({ envelope, command, state }));
      expect(json, name).toEqual({ envelope, command, state });
    }
    expect(new Set(VECTORS.map((v) => v[0])).size).toBe(VECTORS.length);
  });

  it("covers every code and allowed, and carries codes only, never reasons", () => {
    const seen = new Set(fixtures.vectors.map((v) => (v.decision.allowed ? "allowed" : v.decision.code)));
    expect([...seen].sort()).toEqual(["allowed", ...CODES].sort());
    for (const v of fixtures.vectors) expect(Object.keys(v.decision).sort(), v.name).toEqual(v.decision.allowed ? ["allowed"] : ["allowed", "code"]);
    // An envelope's unbounded params carry their own `reason`; a decision line never does.
    const decisionLines = text.split("\n").filter((line) => line.trimStart().startsWith('"decision"'));
    expect(decisionLines).toHaveLength(VECTORS.length);
    for (const line of decisionLines) expect(line).not.toMatch(/reason/);
  });

  it("covers the elapsed-time seam: past-deadline vectors whose envelope has no command parameter for its deadline (astra pack 169)", () => {
    type Env = { deadlineQuantity: string; commands: Array<{ params: Array<{ quantity?: string }> }> };
    const carriesDeadline = (env: Env) => env.commands.some((c) => c.params.some((p) => p.quantity === env.deadlineQuantity));
    expect(carriesDeadline(OT2 as unknown as Env)).toBe(true);
    expect(carriesDeadline(OT2_ELAPSED_ONLY as unknown as Env)).toBe(false);
    expect(carriesDeadline(PLATE as unknown as Env)).toBe(false);
    const seam = fixtures.vectors.filter((v) => !v.decision.allowed && v.decision.code === "past-deadline" && !carriesDeadline(v.envelope as Env));
    expect(seam.map((v) => v.name)).toEqual(
      expect.arrayContaining(["past-deadline/elapsed-only-1-ms-past", "past-deadline/elapsed-only-run-protocol-1-ms-past", "past-deadline/plate-1-ms-past"]),
    );
  });

  it("replaying the committed file reproduces every recorded decision", () => {
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8")) as ReturnType<typeof buildFixtures>;
    for (const v of committed.vectors) {
      const d = checkRuntimeCommand(v.envelope, v.command, v.state);
      expect(d.allowed ? { allowed: true } : { allowed: false, code: d.code }, v.name).toEqual(v.decision);
    }
  });
});
