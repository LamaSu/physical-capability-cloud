/**
 * Cross-language parity fixtures for the safety envelope (ADK R8), for
 * pcc-node's device-side checks (adk, bus #4229). The committed JSON is
 * generated from the TS reference by this test:
 *
 *   PCC_UPDATE_FIXTURES=1 npx vitest run src/__tests__/safety-envelope-fixtures.test.ts
 *
 * Without the variable, the test fails when the committed file differs from
 * what the reference produces now, so the file cannot drift from the code.
 */

import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileOperationalEnvelope, OperationalEnvelopeV1Schema } from "../onboarding/operational-envelope.js";
import {
  computeSafetyEnvelopeDigest,
  confirmSafetyEnvelope,
  registrationSigningPreimage,
  registrationStatementDigest,
  SAFETY_ENVELOPE_DOMAIN,
  SAFETY_ENVELOPE_REGISTRATION_DOMAIN,
  type ConfirmedSafetyEnvelope,
  type EnvelopeDecision,
  type RegistrationVerifier,
  type SafetyEnvelopeInput,
  type SafetyEnvelopeRegistration,
} from "../onboarding/safety-envelope.js";
import { canonicalize } from "../util/canonical.js";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/onboarding/safety-envelope-v1.json");
const AT = "2026-09-29T20:00:00Z";
const REGISTERED_AT = "2026-09-29T20:05:00Z";

/**
 * An ephemeral registry key, generated per run: no key material is ever
 * written to the fixture, which holds the registration statements and their
 * signing preimages, never signatures.
 */
const REGISTRY = generateKeyPairSync("ed25519");
const verifyRegistry: RegistrationVerifier = (preimage, signature) => verify(null, preimage, REGISTRY.publicKey, signature);

function statementOf(c: ConfirmedSafetyEnvelope) {
  return { deviceId: c.envelope.device.deviceId, envelopeDigest: c.envelopeDigest, registeredAt: REGISTERED_AT };
}

function register(c: ConfirmedSafetyEnvelope): SafetyEnvelopeRegistration {
  const statement = statementOf(c);
  return { ...statement, signature: Buffer.from(sign(null, registrationSigningPreimage(statement), REGISTRY.privateKey)).toString("hex") };
}

/** Full command maps: every required quantity of each template, mapped, plus a declared "stop". */
const OT2_MAP = {
  commands: [
    { name: "aspirate", params: [{ name: "volumeUl", quantity: "aspirate_volume", unit: "uL" }] },
    { name: "dispense", params: [{ name: "volumeUl", quantity: "dispense_volume", unit: "uL" }] },
    { name: "setModuleTemp", params: [{ name: "celsius", quantity: "module_temperature", unit: "degC" }] },
    { name: "runProtocol", params: [{ name: "minutes", quantity: "run_duration", unit: "min" }] },
    { name: "stop", params: [] },
  ],
};

/**
 * All 96 wells of a 96-well plate, in a value set's one committed order:
 * ascending by UTF-16 code unit, so A1, A10, A11, A12, A2 ... H9 (astra pack 176).
 */
const WELLS_96 = [..."ABCDEFGH"].flatMap((row) => Array.from({ length: 12 }, (_, i) => `${row}${i + 1}`)).sort();

/**
 * The plate reader's map, shaped like the rehearsal simulator's run request
 * (refvertical's SIM-PR1): wavelength, plate format and wells are finite sets,
 * and wells is list-valued. No parameter sets job_duration: the deadline is
 * the runtime's elapsed-time check (round 4).
 */
const PLATE_MAP = {
  commands: [
    { name: "setIncubation", params: [{ name: "celsius", quantity: "incubation_temperature", unit: "degC" }] },
    {
      name: "read",
      params: [
        { name: "seconds", quantity: "read_duration", unit: "s" },
        { name: "wavelengthNm", unbounded: { reason: "an optical setting, not a safety quantity", allowed: [405, 450, 600] } },
        { name: "plateFormat", unbounded: { reason: "the plate format; this reader takes 96-well plates only", allowed: ["96-well"] } },
        { name: "wells", unbounded: { reason: "which wells to read; a well name sets no physical quantity", allowed: ["all"], allowedItems: WELLS_96 } },
      ],
    },
    { name: "stop", params: [] },
  ],
};

/**
 * SIM-PR1 as refvertical's rehearsal simulator declares it: one run command with
 * three finite-set parameters, and a stop. No command sets its plate temperature
 * or its read duration (the instrument fixes a run's duration at start-up,
 * manual 5.1), so both are device-controlled. Each is enforced through a
 * channel its adapter declares (round 3, astra pack 176), and each channel
 * reports a state (round 4, astra pack 178): GET /status reports temperatureC,
 * and config.run_seconds is the run duration the instrument is configured with
 * at start-up. The read keeps its real 1 s minimum; an elapsed-time counter
 * would have forced it down to 0.
 * There is no reduced class: a reader without an incubator still bounds, and
 * reports, its plate temperature.
 */
const SIM_PR1_MAP = {
  commands: [
    {
      name: "runPlate",
      params: [
        { name: "plateFormat", unbounded: { reason: "the plate format; this reader takes 96-well plates only", allowed: ["96-well"] } },
        { name: "wavelengthNm", unbounded: { reason: "an optical setting, not a safety quantity", allowed: [405, 450, 600] } },
        { name: "wells", unbounded: { reason: "which wells to read; a well name sets no physical quantity", allowed: ["all"], allowedItems: WELLS_96 } },
      ],
    },
    { name: "stop", params: [] },
  ],
};

/** A heated reader whose incubator the firmware runs: no command sets the temperature, but the device causes it and reports it. */
const HEATED_RUN_ONLY_MAP = {
  commands: [
    { name: "run", params: [] },
    { name: "stop", params: [] },
  ],
};

/** What each fixture's operator decides beyond who and when. */
const DECISIONS: Record<string, Partial<EnvelopeDecision>> = {
  "plate-reader-sim-pr1": {
    deviceControlled: [
      { quantity: "incubation_temperature", enforcement: "telemetry", channel: "status.temperature_c" },
      { quantity: "read_duration", enforcement: "telemetry", channel: "config.run_seconds" },
    ],
  },
  // Given out of template order on purpose: the body commits template order.
  "plate-reader-heated-device-controlled": {
    deviceControlled: [
      { quantity: "read_duration", enforcement: "telemetry", channel: "config.read_seconds" },
      { quantity: "incubation_temperature", enforcement: "telemetry", channel: "chamber.temperature_c" },
    ],
  },
};

const INPUTS: Record<string, SafetyEnvelopeInput> = {
  "ot2-operator-answers": {
    deviceClass: "liquid-handler-ot2",
    device: { deviceId: "ot2-sim-1", adapterType: "opentrons", adapterVersion: `sha256:${"21".repeat(32)}`, vendor: "Opentrons", model: "OT-2" },
    commandMap: OT2_MAP,
    intake: {
      limits: [
        { field: "safety.limits", quantity: "aspirate_volume", unit: "uL", min: 0.5, max: 300 },
        { field: "safety.limits", quantity: "dispense_volume", unit: "uL", min: 0.5, max: 300 },
        { field: "safety.limits", quantity: "module_temperature", unit: "degC", min: 4, max: 95 },
        { field: "safety.limits", quantity: "run_duration", unit: "min", min: 1, max: 120 },
      ],
      eStop: { mechanism: "adapter-stop", stopCommand: "stop" },
      supervision: "attended",
      hazards: ["mechanical", "heat"],
      maxCommandsPerMinute: 60,
    },
    references: [],
  },
  // attended, not unattended: a device that moves or heats (both templates) cannot run unattended in v1.
  "plate-reader-reference-proposed": {
    deviceClass: "lab-plate-reader",
    device: { deviceId: "pr-sim-1", adapterType: "generic-http", adapterVersion: `sha256:${"10".repeat(32)}` },
    commandMap: PLATE_MAP,
    intake: {
      limits: [
        { field: "safety.limits", quantity: "read_duration", unit: "s", min: 1, max: 600 },
        { field: "safety.limits", quantity: "job_duration", unit: "min", min: 1, max: 120 },
      ],
      eStop: { mechanism: "hardware" },
      supervision: "attended",
      hazards: [],
      maxCommandsPerMinute: 30,
    },
    references: [
      {
        quantity: "incubation_temperature",
        claim: "Inkubation ab 25 °C",
        value: { min: 25 },
        unit: "degC",
        citation: { doc: "Betriebshandbuch", section: "§4.2 – Betriebstemperatur", url: "https://example.org/manual.pdf" },
        retrievedAt: "2026-09-29",
      },
      {
        quantity: "incubation_temperature",
        claim: "incubator rated to 42.5 °C",
        value: { max: 42.5 },
        unit: "degC",
        citation: { doc: "Datasheet Rev C", section: "Table 3" },
        retrievedAt: "2026-09-28T09:15:00Z",
      },
    ],
  },
  "plate-reader-sim-pr1": {
    deviceClass: "lab-plate-reader",
    device: { deviceId: "sim-pr1", adapterType: "generic-http", adapterVersion: `sha256:${"31".repeat(32)}`, vendor: "Veriswell Instruments", model: "SIM-PR1" },
    commandMap: SIM_PR1_MAP,
    telemetryMap: {
      channels: [
        { id: "config.run_seconds", quantity: "read_duration", unit: "s", semantics: "state" as const, maxAgeMs: 5000 },
        { id: "status.temperature_c", quantity: "incubation_temperature", unit: "degC", semantics: "state" as const, maxAgeMs: 5000 },
      ],
    },
    intake: {
      limits: [
        { field: "safety.limits", quantity: "incubation_temperature", unit: "degC", min: 15, max: 40 },
        { field: "safety.limits", quantity: "read_duration", unit: "s", min: 1, max: 60 },
        { field: "safety.limits", quantity: "job_duration", unit: "min", min: 1, max: 30 },
      ],
      eStop: { mechanism: "adapter-stop", stopCommand: "stop" },
      supervision: "attended",
      hazards: [],
      maxCommandsPerMinute: 20,
    },
    references: [],
  },
  "plate-reader-heated-device-controlled": {
    deviceClass: "lab-plate-reader",
    device: { deviceId: "pr-heated", adapterType: "generic-http", adapterVersion: `sha256:${"41".repeat(32)}` },
    commandMap: HEATED_RUN_ONLY_MAP,
    telemetryMap: {
      channels: [
        { id: "chamber.temperature_c", quantity: "incubation_temperature", unit: "degC", semantics: "state" as const, maxAgeMs: 5000 },
        { id: "config.read_seconds", quantity: "read_duration", unit: "s", semantics: "state" as const, maxAgeMs: 5000 },
      ],
    },
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
  },
};

type Change = (e: Record<string, any>) => void;

/**
 * Each is refused by OperationalEnvelopeV1Schema; `paths` are the issue paths a
 * validator should report. The third entry, when given, names the valid envelope
 * it changes (default: the OT-2's).
 */
const INVALID: Array<[string, Change] | [string, Change, string]> = [
  ["numeric-string-max", (e) => (e.limits[0].max = "300")],
  ["min-above-max", (e) => (e.limits[0].min = 500)],
  ["duplicate-quantity", (e) => e.limits.push({ ...e.limits[0], max: 10 })],
  ["missing-required-quantity", (e) => e.limits.splice(1, 1)],
  ["wrong-unit-for-class", (e) => (e.limits[0].unit = "mL")],
  ["unit-not-in-table", (e) => (e.limits[0].unit = "rpm")],
  ["limits-empty", (e) => (e.limits = [])],
  ["estop-none-on-a-device-that-moves-or-heats", (e) => (e.eStop = { mechanism: "none" })],
  ["estop-none-unknown-class", (e) => {
    e.deviceClass = "unknown-robot";
    e.limits = [{ quantity: "spindle_speed", unit: "m/s", min: 0, max: 2 }];
    e.eStop = { mechanism: "none" };
  }],
  ["adapter-stop-blank-command", (e) => (e.eStop.stopCommand = "  ")],
  ["hardware-stop-with-a-command", (e) => (e.eStop = { mechanism: "hardware", stopCommand: "x" })],
  ["estop-unknown-mechanism", (e) => (e.eStop = { mechanism: "soft" })],
  ["strict-false", (e) => (e.strict = false)],
  ["extra-key-defaults", (e) => (e.defaults = { maxTemperature: 300 })],
  ["extra-key-in-a-limit", (e) => (e.limits[0].fallback = 1)],
  ["rate-zero", (e) => (e.maxCommandsPerMinute = 0)],
  ["rate-fraction", (e) => (e.maxCommandsPerMinute = 1.5)],
  ["rate-string", (e) => (e.maxCommandsPerMinute = "60")],
  ["digest-uppercase", (e) => (e.envelopeDigest = "0x" + "AB".repeat(32))],
  ["digest-short", (e) => (e.envelopeDigest = "0x1234")],
  ["device-id-blank", (e) => (e.deviceId = " ")],
  ["supervision-invalid", (e) => (e.supervision = "sometimes")],
  ["supervision-missing", (e) => delete e.supervision],
  ["hazards-unknown", (e) => (e.hazards = ["radiation"])],
  ["hazards-duplicate", (e) => (e.hazards = ["heat", "heat"])],
  ["hazards-out-of-order", (e) => (e.hazards = ["mechanical", "heat"])],
  ["hazards-missing", (e) => delete e.hazards],
  ["missing-commands", (e) => delete e.commands],
  ["adapter-stop-undeclared-command", (e) => (e.eStop = { mechanism: "adapter-stop", stopCommand: "nonexistent" })],
  ["supervision-unattended-policy", (e) => (e.supervision = "unattended")],
  [
    "remote-supervised-with-hardware-stop",
    (e) => {
      e.supervision = "remote-supervised";
      e.eStop = { mechanism: "hardware" };
    },
  ],
  ["wrong-deadline-quantity", (e) => (e.deadlineQuantity = "aspirate_volume")],
  ["limits-out-of-order", (e) => (e.limits = [...e.limits].reverse())],
  // Round 3 (astra pack 153): the adapter is named by its manifest digest, and no parameter is free-form.
  ["adapter-version-not-a-manifest-digest", (e) => (e.adapterVersion = "2.1.0")],
  ["unbounded-free-form-reason-only", (e) => e.commands[0].params.push({ name: "payload", unbounded: "device-specific" })],
  ["unbounded-allowed-empty", (e) => e.commands[0].params.push({ name: "slot", unbounded: { reason: "a deck slot", allowed: [] } })],
  ["unbounded-allowed-duplicate", (e) => e.commands[0].params.push({ name: "slot", unbounded: { reason: "a deck slot", allowed: [1, 1] } })],
  ["unbounded-allowed-blank-string", (e) => e.commands[0].params.push({ name: "slot", unbounded: { reason: "a deck slot", allowed: [" "] } })],
  ["unbounded-extra-key", (e) => e.commands[0].params.push({ name: "slot", unbounded: { reason: "a deck slot", allowed: [1], any: true } })],
  // Round 4: a list-valued parameter declares allowedItems; an unbounded parameter needs allowed or allowedItems.
  ["unbounded-neither-allowed-nor-items", (e) => e.commands[0].params.push({ name: "wells", unbounded: { reason: "plate wells" } })],
  ["unbounded-allowedItems-empty", (e) => e.commands[0].params.push({ name: "wells", unbounded: { reason: "plate wells", allowedItems: [] } })],
  ["unbounded-allowedItems-duplicate", (e) => e.commands[0].params.push({ name: "wells", unbounded: { reason: "plate wells", allowedItems: ["A1", "A1"] } })],
  // Moved from `valid` (114b-10): the schema now refuses an unknown deviceClass outright, so this is
  // no longer "generic rules only" — it is refused before any per-class rule (even e-stop) is checked.
  [
    "unknown-class-generic-rules-only",
    (e) => {
      e.deviceClass = "unknown-robot";
      e.limits = [{ quantity: "spindle_speed", unit: "m/s", min: 0, max: 2 }];
      e.eStop = { mechanism: "hardware" };
      e.hazards = ["mechanical"];
    },
  ],
  // Addendum 6: deviceControlled (astra pack 173).
  ["device-controlled-missing", (e) => delete e.deviceControlled],
  ["device-controlled-the-deadline", (e) => e.deviceControlled.push({ quantity: "run_duration", enforcement: "telemetry", channel: "run.elapsed_min" })],
  ["device-controlled-unknown-quantity", (e) => e.deviceControlled.push({ quantity: "spindle_speed", enforcement: "telemetry", channel: "spindle.rpm" })],
  ["device-controlled-a-settable-quantity", (e) => e.deviceControlled.push({ quantity: "module_temperature", enforcement: "telemetry", channel: "module.temperature_c" })],
  ["device-controlled-unknown-enforcement", (e) => (e.deviceControlled[0].enforcement = "trust"), "plate-reader-heated-device-controlled"],
  // Round 3 (astra pack 176): enforcement is a channel the runtime reads, never an operator's words.
  ["device-controlled-cutoff", (e) => (e.deviceControlled[0].enforcement = "cutoff"), "plate-reader-heated-device-controlled"],
  ["device-controlled-prose-detail", (e) => (e.deviceControlled[0] = { quantity: "incubation_temperature", enforcement: "cutoff", detail: "x" }), "plate-reader-heated-device-controlled"],
  ["device-controlled-channel-unresolved", (e) => (e.deviceControlled[0].channel = "chamber.other"), "plate-reader-heated-device-controlled"],
  ["device-controlled-channel-of-another-quantity", (e) => (e.deviceControlled[0].channel = "config.read_seconds"), "plate-reader-heated-device-controlled"],
  ["device-controlled-channel-not-an-id", (e) => (e.deviceControlled[0].channel = "Chamber Thermistor"), "plate-reader-heated-device-controlled"],
  ["device-controlled-extra-key", (e) => (e.deviceControlled[0].limit = "none"), "plate-reader-heated-device-controlled"],
  ["device-controlled-out-of-order", (e) => e.deviceControlled.reverse(), "plate-reader-heated-device-controlled"],
  ["device-controlled-twice", (e) => (e.deviceControlled[1] = e.deviceControlled[0]), "plate-reader-heated-device-controlled"],
  ["device-controlled-omits-an-unset-quantity", (e) => e.deviceControlled.pop(), "plate-reader-heated-device-controlled"],
  ["device-controlled-limit-removed", (e) => e.limits.shift(), "plate-reader-heated-device-controlled"],
  ["telemetry-channels-missing", (e) => delete e.telemetryChannels],
  ["telemetry-channels-emptied-while-named", (e) => (e.telemetryChannels = []), "plate-reader-heated-device-controlled"],
  ["telemetry-channels-out-of-order", (e) => e.telemetryChannels.reverse(), "plate-reader-heated-device-controlled"],
  ["telemetry-channel-twice", (e) => (e.telemetryChannels[1] = e.telemetryChannels[0]), "plate-reader-heated-device-controlled"],
  ["telemetry-channel-retargeted", (e) => (e.telemetryChannels[0].quantity = "read_duration"), "plate-reader-heated-device-controlled"],
  ["telemetry-channel-the-deadline", (e) => e.telemetryChannels.push({ id: "job.elapsed_min", quantity: "job_duration", unit: "min", semantics: "state" as const, maxAgeMs: 1000 }), "plate-reader-heated-device-controlled"],
  ["telemetry-channel-unknown-quantity", (e) => e.telemetryChannels.push({ id: "spindle.rpm", quantity: "spindle_speed", unit: "m/s", semantics: "state" as const, maxAgeMs: 1000 }), "plate-reader-heated-device-controlled"],
  ["telemetry-channel-other-unit", (e) => (e.telemetryChannels[0].unit = "degF"), "plate-reader-heated-device-controlled"],
  ["telemetry-channel-max-age-zero", (e) => (e.telemetryChannels[0].maxAgeMs = 0), "plate-reader-heated-device-controlled"],
  ["telemetry-channel-max-age-over-a-minute", (e) => (e.telemetryChannels[0].maxAgeMs = 60001), "plate-reader-heated-device-controlled"],
  ["telemetry-channel-max-age-fraction", (e) => (e.telemetryChannels[0].maxAgeMs = 1.5), "plate-reader-heated-device-controlled"],
  ["telemetry-channel-id-uppercase", (e) => (e.telemetryChannels[0].id = "Chamber.temperature_c"), "plate-reader-heated-device-controlled"],
  ["telemetry-channel-extra-key", (e) => (e.telemetryChannels[0].detail = "thermistor"), "plate-reader-heated-device-controlled"],
  // astra pack 178: every channel reports a state.
  ["telemetry-channel-semantics-elapsed", (e) => (e.telemetryChannels[0].semantics = "elapsed"), "plate-reader-heated-device-controlled"],
  ["telemetry-channel-semantics-missing", (e) => delete e.telemetryChannels[0].semantics, "plate-reader-heated-device-controlled"],
  // One set, one committed form (astra pack 176 MEDIUM).
  ["enumerated-out-of-order", (e) => (e.commands[2].params[0].allowed = [37, 4])],
  ["unbounded-allowed-out-of-order", (e) => e.commands[0].params.push({ name: "slot", unbounded: { reason: "a deck slot", allowed: [2, 1] } })],
  ["unbounded-strings-before-numbers", (e) => e.commands[0].params.push({ name: "slot", unbounded: { reason: "a deck slot", allowed: ["all", 1] } })],
  ["unbounded-allowedItems-out-of-order", (e) => e.commands[0].params.push({ name: "wells", unbounded: { reason: "plate wells", allowedItems: ["A2", "A10"] } })],
  // Enumerated physical parameters.
  ["enumerated-value-outside-the-limit", (e) => (e.commands[2].params[0].allowed = [4, 120])],
  ["enumerated-value-not-a-number", (e) => (e.commands[2].params[0].allowed = ["hot"])],
  ["enumerated-empty", (e) => (e.commands[2].params[0].allowed = [])],
];

function issuePaths(value: unknown): string[] {
  const r = OperationalEnvelopeV1Schema.safeParse(value);
  return r.success ? [] : [...new Set(r.error.issues.map((i) => i.path.join(".")))].sort();
}

function buildFixtures() {
  const confirmed = Object.entries(INPUTS).map(([name, input]) => {
    const c = confirmSafetyEnvelope(input, { confirmedBy: "operator:fixture", confirmedAt: AT, ...DECISIONS[name] });
    return { name, confirmed: c, runtime: compileOperationalEnvelope(c, register(c), verifyRegistry) };
  });
  const runtimeOf = (name: string) => confirmed.find((c) => c.name === name)!.runtime;
  return {
    _comment: [
      "GENERATED by packages/spec/src/__tests__/safety-envelope-fixtures.test.ts from the TS reference; do not edit by hand.",
      "Regenerate: PCC_UPDATE_FIXTURES=1 npx vitest run src/__tests__/safety-envelope-fixtures.test.ts (in packages/spec).",
      "digest: envelopeDigest = '0x' + lowercase hex(sha256(UTF-8(preimage))), preimage = canonicalize({domain, envelope}) with the confirmed SafetyEnvelopeBody as envelope and packages/spec/src/util/canonical.ts as canonicalize (keys sorted, no whitespace, strings as JSON.stringify, numbers as JS Number#toString).",
      "operationalEnvelopeV1: a validator must accept every 'valid' envelope and refuse every 'invalid' one; 'paths' are the issue paths the TS schema reports. NaN and Infinity cannot appear in JSON, so they are not here; a JSON consumer never sees them.",
      "114b: the schema now refuses an unknown deviceClass outright (see 'unknown-class-generic-rules-only', moved here from 'valid'), limits must be in the template's exact order and units, an adapter-stop's command must be one of the declared commands, and deadlineQuantity must be the template's own deadline.",
      "153 (round 3): adapterVersion is the adapter's release manifest digest (sha256: + 64 lowercase hex); an unbounded parameter is {reason, allowed}, and a runtime passes only a value in allowed (same type and value); a reference source carries the bound it cites (value) and its unit.",
      "round 4: the template's deadline (deadlineQuantity) needs no command parameter: the runtime enforces it as elapsed time, and a parameter that does set it is checked against the same limit. A list-valued parameter declares unbounded.allowedItems: a runtime passes a non-empty list of distinct items, each in allowedItems (compared by type and value); a single value must be in allowed.",
      "Addendum 6 (dispositions, astra pack 173): every template quantity keeps a limit. A required quantity that no declared command parameter sets is device-controlled, and its limit stays in the body, the runtime limits and the conformance evidence. The confirmed body commits deviceControlled in template order only when non-empty, so every other envelope's digest is unchanged; the runtime envelope always carries it (possibly empty). A parameter that sets a quantity may list its only values (allowed), each inside the limit.",
      "Addendum 7 (round 3, astra pack 176): a device-controlled entry is {quantity, enforcement: 'telemetry', channel}. channel must be the id of one of the adapter's declared telemetry channels (body telemetryMap.channels, runtime telemetryChannels) that reports that quantity. Each channel is {id, quantity, unit, maxAgeMs}: a lowercase token id (a letter, then [a-z0-9._-], at most 64), ids strictly ascending; a non-deadline template quantity in that quantity's unit; and maxAgeMs a whole number from 1 to 60000. Every committed channel is enforced: a runtime dispatches a command other than the stop only when each channel's latest reading is a finite number, at most maxAgeMs old, inside its quantity's limit, and it stops a running job when one is not. There is no 'cutoff' and no prose detail. A body omits telemetryMap when the adapter declares no channel; the runtime always carries telemetryChannels (possibly empty). Every value set (allowed, unbounded.allowed, unbounded.allowedItems) lists each value once, in one order: numbers ascending, then strings ascending by UTF-16 code unit. There is no reduced device class: lab-plate-reader-absorbance is gone. The envelope-conformance evidence lists, per limit, enforcedBy: dispatch, telemetry {channel, maxAgeMs} and/or deadline.",
      "Addendum 8 (round 4, astra pack 178): every telemetry channel is {id, quantity, unit, semantics: 'state', maxAgeMs}. A state is the quantity's current value and must lie inside the limit's [min, max] at every enforcement check; an elapsed counter or a terminal quantity is refused. A duration no command sets binds to the duration the device is configured to run for, so it keeps its real minimum. The evidence's telemetry mechanism carries semantics, and its claim is per enforcement check, never 'for the whole job'.",
      "registration: the registry signs statementDigest = 'sha256:' + lowercase hex(sha256(UTF-8(canonicalize({domain, deviceId, envelopeDigest, registeredAt})))) with Ed25519; the signed message is the UTF-8 of statementDigest itself (LO-EV-1 signingPreimage, 71 bytes). Signatures are not in this file: verify with the registry's key.",
    ],
    digest: {
      domain: SAFETY_ENVELOPE_DOMAIN,
      cases: confirmed.map(({ name, confirmed: c }) => ({
        name,
        envelope: c.envelope,
        preimage: canonicalize({ domain: SAFETY_ENVELOPE_DOMAIN, envelope: c.envelope }),
        envelopeDigest: c.envelopeDigest,
      })),
    },
    registration: {
      domain: SAFETY_ENVELOPE_REGISTRATION_DOMAIN,
      cases: confirmed.map(({ name, confirmed: c }) => {
        const statement = statementOf(c);
        return {
          name,
          statement,
          preimage: canonicalize({ domain: SAFETY_ENVELOPE_REGISTRATION_DOMAIN, ...statement }),
          statementDigest: registrationStatementDigest(statement),
        };
      }),
    },
    operationalEnvelopeV1: {
      valid: confirmed.map(({ name, runtime }) => ({ name, envelope: runtime })),
      invalid: INVALID.map(([name, change, base]) => {
        const envelope = structuredClone(runtimeOf(base ?? "ot2-operator-answers")) as unknown as Record<string, any>;
        change(envelope);
        return { name, envelope, paths: issuePaths(envelope) };
      }),
    },
  };
}

describe("safety envelope parity fixtures (for pcc-node)", () => {
  const fixtures = buildFixtures();
  const text = `${JSON.stringify(fixtures, null, 2)}\n`;

  if (process.env.PCC_UPDATE_FIXTURES === "1") {
    mkdirSync(dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, text);
  }

  it("the committed fixture file is exactly what the reference produces now", () => {
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });

  it("each digest case recomputes from its preimage, and the preimage from its envelope", () => {
    for (const c of fixtures.digest.cases) {
      expect(canonicalize({ domain: fixtures.digest.domain, envelope: c.envelope }), c.name).toBe(c.preimage);
      expect(`0x${createHash("sha256").update(c.preimage, "utf8").digest("hex")}`, c.name).toBe(c.envelopeDigest);
      expect(computeSafetyEnvelopeDigest(c.envelope), c.name).toBe(c.envelopeDigest);
    }
  });

  it("each registration case recomputes: preimage from the statement, digest from the preimage, and the signed bytes are the digest's UTF-8", () => {
    for (const c of fixtures.registration.cases) {
      expect(canonicalize({ domain: fixtures.registration.domain, ...c.statement }), c.name).toBe(c.preimage);
      expect(`sha256:${createHash("sha256").update(c.preimage, "utf8").digest("hex")}`, c.name).toBe(c.statementDigest);
      expect(Buffer.from(registrationSigningPreimage(c.statement)).toString("utf8"), c.name).toBe(c.statementDigest);
    }
  });

  it("every valid envelope is accepted and every invalid one is refused, at a recorded path", () => {
    for (const v of fixtures.operationalEnvelopeV1.valid) {
      expect(OperationalEnvelopeV1Schema.safeParse(v.envelope).success, v.name).toBe(true);
    }
    for (const v of fixtures.operationalEnvelopeV1.invalid) {
      expect(OperationalEnvelopeV1Schema.safeParse(v.envelope).success, v.name).toBe(false);
      expect(v.paths.length, v.name).toBeGreaterThan(0);
    }
    expect(fixtures.operationalEnvelopeV1.invalid).toHaveLength(INVALID.length);
  });
});
