/**
 * Tests for onboarding/envelope-runtime-check.ts: the reference runtime check
 * of OperationalEnvelopeV1 (N86 part 2; the runtime half of R8 HIGH 8/9).
 * Envelopes are built the way operational-envelope.test.ts builds them:
 * confirm, register with an ephemeral registry key, compile.
 *
 * Special characters are built with String.fromCharCode, never written as
 * escape sequences, so no editor or tool can turn them into literal bytes.
 */

import { generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkRuntimeCommand, type RuntimeDecision, type RuntimeState } from "../onboarding/envelope-runtime-check.js";
import { compileOperationalEnvelope, OperationalEnvelopeV1Schema, type OperationalEnvelopeV1 } from "../onboarding/operational-envelope.js";
import {
  confirmSafetyEnvelope,
  registrationSigningPreimage,
  type CommandMapV1,
  type ConfirmedSafetyEnvelope,
  type RegistrationVerifier,
  type SafetyEnvelopeInput,
  type SafetyEnvelopeRegistration,
} from "../onboarding/safety-envelope.js";

const AT = "2026-10-03T08:00:00Z";
const OT2_MANIFEST = `sha256:${"21".repeat(32)}`;
const PLATE_MANIFEST = `sha256:${"10".repeat(32)}`;
const OTHER_MANIFEST = `sha256:${"ab".repeat(32)}`;

/** An ephemeral registry: its key signs registrations, and `verifyRegistry` is the integration's pinned check. */
const REGISTRY = generateKeyPairSync("ed25519");
const verifyRegistry: RegistrationVerifier = (preimage, signature) => verify(null, preimage, REGISTRY.publicKey, signature);

function register(c: ConfirmedSafetyEnvelope): SafetyEnvelopeRegistration {
  const statement = { deviceId: c.envelope.device.deviceId, envelopeDigest: c.envelopeDigest, registeredAt: "2026-10-03T08:05:00Z" };
  return { ...statement, signature: Buffer.from(sign(null, registrationSigningPreimage(statement), REGISTRY.privateKey)).toString("hex") };
}

function compile(input: SafetyEnvelopeInput): OperationalEnvelopeV1 {
  const confirmed = confirmSafetyEnvelope(input, { confirmedBy: "op-1", confirmedAt: AT });
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

function ot2Input(moduleTemperature: { min: number; max: number }): SafetyEnvelopeInput {
  return {
    deviceClass: "liquid-handler-ot2",
    device: { deviceId: "ot2-sim-1", adapterType: "opentrons", adapterVersion: OT2_MANIFEST },
    commandMap: OT2_MAP,
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

const WELLS = ["A1", "A2", "A3", "H12"];

/** The plate reader: a hardware stop, so its "stop" command is an ordinary command (not exempt). */
const PLATE_MAP: CommandMapV1 = {
  commands: [
    { name: "setIncubation", params: [{ name: "celsius", quantity: "incubation_temperature", unit: "degC" }] },
    {
      name: "read",
      params: [
        { name: "seconds", quantity: "read_duration", unit: "s" },
        { name: "wavelengthNm", unbounded: { reason: "an optical setting, not a safety quantity", allowed: [405, 450, 600] } },
        { name: "wells", unbounded: { reason: "which wells to read; a well sets no physical quantity", allowed: ["all"], allowedItems: WELLS } },
      ],
    },
    { name: "stop", params: [] },
  ],
};

function plateInput(): SafetyEnvelopeInput {
  return {
    deviceClass: "lab-plate-reader",
    device: { deviceId: "pr-sim-1", adapterType: "generic-http", adapterVersion: PLATE_MANIFEST },
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
/** A cold block, so 0 is the upper bound of module_temperature. */
const OT2_COLD = compile(ot2Input({ min: -20, max: 0 }));
const PLATE = compile(plateInput());

/** 2026-10-03, in epoch ms; every state below is relative to it. */
const T0 = 1_790_985_600_000;
const MIN = 60_000;

function stateFor(env: OperationalEnvelopeV1, over: Partial<RuntimeState> = {}): RuntimeState {
  return { adapterManifestDigest: env.adapterVersion, jobStartedAtMs: T0, nowMs: T0 + 10 * MIN, recentCommandsAtMs: [], ...over };
}

function codeOf(d: RuntimeDecision): string {
  return d.allowed ? "allowed" : d.code;
}

/** A plain, unfrozen copy to change. */
function changed<T>(value: T, mutate: (v: any) => void): T {
  const copy = structuredClone(value) as any;
  mutate(copy);
  return copy;
}

const STOP = { name: "stop", params: {} };

/** The rule-1 verdict alone: true when the check calls the envelope invalid. */
function envelopeInvalid(envelope: unknown): boolean {
  return codeOf(checkRuntimeCommand(envelope, STOP, stateFor(OT2))) === "envelope-invalid";
}

const R8_FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../fixtures/onboarding/safety-envelope-v1.json", import.meta.url)), "utf8"),
) as { operationalEnvelopeV1: { valid: Array<{ name: string; envelope: unknown }>; invalid: Array<{ name: string; envelope: unknown }> } };

describe("rule 1, envelope-invalid: one plain copy, valid as OperationalEnvelopeV1", () => {
  it("the compiled OT-2, cold-block OT-2 and plate-reader envelopes pass, and a valid command is allowed", () => {
    expect(checkRuntimeCommand(OT2, { name: "aspirate", params: { volumeUl: 150 } }, stateFor(OT2))).toEqual({ allowed: true });
    expect(checkRuntimeCommand(OT2_COLD, { name: "setModuleTemp", params: { celsius: -4 } }, stateFor(OT2_COLD))).toEqual({ allowed: true });
    expect(checkRuntimeCommand(PLATE, { name: "read", params: { seconds: 30, wavelengthNm: 450, wells: "all" } }, stateFor(PLATE))).toEqual({
      allowed: true,
    });
  });

  it("refuses anything that is not an envelope object", () => {
    for (const bad of [null, undefined, 0, 1, "x", true, [], [OT2], () => OT2]) {
      expect(envelopeInvalid(bad), String(bad)).toBe(true);
    }
  });

  it("refuses every break of a field, a closed shape, a type or a template rule, as the schema does", () => {
    const cases: Array<[string, (e: any) => void]> = [
      ["strict false", (e) => (e.strict = false)],
      ["strict missing", (e) => delete e.strict],
      ["an extra top-level key", (e) => (e.defaults = { maxTemperature: 300 })],
      ["envelopeVersion 2", (e) => (e.envelopeVersion = 2)],
      ["envelopeVersion as a string", (e) => (e.envelopeVersion = "1")],
      ["a blank deviceId", (e) => (e.deviceId = " ")],
      ["a numeric deviceId", (e) => (e.deviceId = 7)],
      ["a blank adapterType", (e) => (e.adapterType = "")],
      ["an unknown deviceClass", (e) => (e.deviceClass = "unknown-robot")],
      ["an inherited name as deviceClass", (e) => (e.deviceClass = "toString")],
      ["__proto__ as deviceClass", (e) => (e.deviceClass = "__proto__")],
      ["the other template's class", (e) => (e.deviceClass = "lab-plate-reader")],
      ["a limit max as a numeric string", (e) => (e.limits[0].max = "300")],
      ["a limit min above its max", (e) => (e.limits[0].min = 500)],
      ["a limit with an extra key", (e) => (e.limits[0].fallback = 1)],
      ["a limit without max", (e) => delete e.limits[0].max],
      ["a limit in another unit", (e) => (e.limits[0].unit = "mL")],
      ["a limit in an unknown unit", (e) => (e.limits[0].unit = "rpm")],
      ["limits out of order", (e) => e.limits.reverse()],
      ["a limit missing", (e) => e.limits.splice(1, 1)],
      ["a limit duplicated", (e) => e.limits.push({ ...e.limits[0] })],
      ["no limits", (e) => (e.limits = [])],
      ["limits not a list", (e) => (e.limits = { 0: e.limits[0] })],
      ["no commands", (e) => (e.commands = [])],
      ["commands missing", (e) => delete e.commands],
      ["a command declared twice", (e) => e.commands.push(e.commands[0])],
      ["a command with an extra key", (e) => (e.commands[0].timeoutMs = 10)],
      ["a param with an extra key", (e) => (e.commands[0].params[0].fallback = 1)],
      ["a param both bounded and unbounded", (e) => (e.commands[0].params[0].unbounded = { reason: "r", allowed: [1] })],
      ["a free-form unbounded param", (e) => e.commands[0].params.push({ name: "payload", unbounded: "device-specific" })],
      ["an unbounded param without allowed or allowedItems", (e) => e.commands[0].params.push({ name: "w", unbounded: { reason: "r" } })],
      ["an empty allowed list", (e) => e.commands[0].params.push({ name: "w", unbounded: { reason: "r", allowed: [] } })],
      ["a duplicated allowed value", (e) => e.commands[0].params.push({ name: "w", unbounded: { reason: "r", allowed: [1, 1] } })],
      ["an object allowed value", (e) => e.commands[0].params.push({ name: "w", unbounded: { reason: "r", allowed: [{}] } })],
      ["a blank allowed value", (e) => e.commands[0].params.push({ name: "w", unbounded: { reason: "r", allowed: [" "] } })],
      ["a duplicated allowedItems value", (e) => e.commands[0].params.push({ name: "w", unbounded: { reason: "r", allowedItems: ["A1", "A1"] } })],
      ["a param setting a quantity in another unit", (e) => (e.commands[0].params[0].unit = "mL")],
      ["a param setting a quantity the class does not bound", (e) => (e.commands[0].params[0].quantity = "spindle_speed")],
      ["a bounded quantity no param sets (a gap)", (e) => (e.commands = e.commands.filter((c: any) => c.name !== "setModuleTemp"))],
      ["the wrong deadlineQuantity", (e) => (e.deadlineQuantity = "aspirate_volume")],
      ["rate 0", (e) => (e.maxCommandsPerMinute = 0)],
      ["rate -1", (e) => (e.maxCommandsPerMinute = -1)],
      ["rate 1.5", (e) => (e.maxCommandsPerMinute = 1.5)],
      ["rate as a string", (e) => (e.maxCommandsPerMinute = "60")],
      ["no e-stop on a device that moves or heats", (e) => (e.eStop = { mechanism: "none" })],
      ["a hardware stop with a command", (e) => (e.eStop = { mechanism: "hardware", stopCommand: "stop" })],
      ["an adapter stop without its command", (e) => (e.eStop = { mechanism: "adapter-stop" })],
      ["an adapter stop with a blank command", (e) => (e.eStop.stopCommand = "  ")],
      ["an adapter stop naming an undeclared command", (e) => (e.eStop.stopCommand = "halt")],
      ["an adapter stop with an extra key", (e) => (e.eStop.timeoutMs = 5)],
      ["an unknown e-stop mechanism", (e) => (e.eStop = { mechanism: "soft" })],
      ["an e-stop that is a list", (e) => (e.eStop = [e.eStop])],
      ["an unknown supervision", (e) => (e.supervision = "sometimes")],
      ["unattended operation of a device that moves or heats", (e) => (e.supervision = "unattended")],
      ["remote supervision without an adapter stop", (e) => {
        e.supervision = "remote-supervised";
        e.eStop = { mechanism: "hardware" };
      }],
      ["an unknown hazard", (e) => (e.hazards = ["radiation"])],
      ["a duplicated hazard", (e) => (e.hazards = ["heat", "heat"])],
      ["hazards out of canonical order", (e) => (e.hazards = ["mechanical", "heat"])],
      ["hazards not a list", (e) => (e.hazards = "heat")],
    ];
    for (const [label, mutate] of cases) {
      const bad = changed(OT2, mutate);
      expect(envelopeInvalid(bad), label).toBe(true);
      // The structural check refuses exactly where the schema does.
      expect(OperationalEnvelopeV1Schema.safeParse(bad).success, label).toBe(false);
    }
  });

  it("checks digests by structure (exact length, prefix, lowercase hex by char code), never by RegExp", () => {
    const hex = "ab".repeat(32);
    const newline = String.fromCharCode(10);
    const badDigests = [`0x${hex.toUpperCase()}`, `0x${hex.slice(2)}`, `0x${hex}0`, `0X${hex}`, `${hex}00`, ` 0x${hex}`, `0x${hex}${newline}`, `0x${hex.slice(1)}g`, 1, null];
    for (const digest of badDigests) {
      expect(envelopeInvalid(changed(OT2, (e) => (e.envelopeDigest = digest))), String(digest)).toBe(true);
    }
    const badManifests = [`sha256:${hex.toUpperCase()}`, `sha256:${hex.slice(1)}`, `SHA256:${hex}`, `sha512:${hex}`, `sha256:${hex}${newline}`, `sha256 ${hex}`, "2.1.0", ""];
    for (const manifest of badManifests) {
      expect(envelopeInvalid(changed(OT2, (e) => (e.adapterVersion = manifest))), manifest).toBe(true);
    }
    // Every lowercase hex digit is accepted, and a character just outside each hex range is not.
    expect(envelopeInvalid(changed(OT2, (e) => (e.envelopeDigest = `0x${"0123456789abcdef".repeat(4)}`)))).toBe(false);
    for (const outside of ["/", ":", "`", "g", "A", "F"]) {
      expect(envelopeInvalid(changed(OT2, (e) => (e.envelopeDigest = `0x${outside}${hex.slice(1)}`))), outside).toBe(true);
    }
  });

  it("refuses a getter or a proxy anywhere in the envelope, without running it", () => {
    let reads = 0;
    const getter = changed(OT2, () => undefined);
    Object.defineProperty(getter.limits[0], "max", { enumerable: true, configurable: true, get: () => (reads++, 300) });
    expect(envelopeInvalid(getter)).toBe(true);

    // A transparent proxy that counts every operation: each one looks up its trap on this handler.
    let traps = 0;
    const handler: ProxyHandler<object> = new Proxy({}, { get: () => (traps++, undefined) });
    expect(envelopeInvalid(new Proxy(changed(OT2, () => undefined), handler))).toBe(true);
    const inner = changed(OT2, (e) => (e.eStop = new Proxy(e.eStop, handler)));
    expect(envelopeInvalid(inner)).toBe(true);
    expect(reads).toBe(0);
    expect(traps).toBe(0);
  });

  it("refuses what is not JSON data: NaN, Infinity, a function, a symbol, a bigint, a cycle, a hole, a Date, a class instance", () => {
    const cases: Array<[string, (e: any) => void]> = [
      ["NaN", (e) => (e.limits[0].max = Number.NaN)],
      ["Infinity", (e) => (e.limits[0].max = Number.POSITIVE_INFINITY)],
      ["-Infinity", (e) => (e.limits[0].min = Number.NEGATIVE_INFINITY)],
      ["a function", (e) => (e.deviceId = () => "x")],
      ["a symbol", (e) => (e.deviceId = Symbol("x"))],
      ["a bigint", (e) => (e.maxCommandsPerMinute = 60n)],
      ["a cycle", (e) => (e.eStop.self = e.eStop)],
      ["a hole", (e) => (e.hazards = [, "heat"])], // eslint-disable-line no-sparse-arrays
      ["a Date", (e) => (e.deviceId = new Date(0))],
      ["a class instance", (e) => (e.eStop = new (class { mechanism = "hardware"; })())],
      ["undefined in a list", (e) => (e.hazards = [undefined])],
    ];
    for (const [label, mutate] of cases) expect(envelopeInvalid(changed(OT2, mutate)), label).toBe(true);
  });

  it("drops an undefined member, as JSON does: the envelope is still valid", () => {
    expect(envelopeInvalid(changed(OT2, (e) => (e.notes = undefined)))).toBe(false);
  });

  it("accepts every valid and refuses every invalid runtime envelope in R8's parity fixture", () => {
    for (const v of R8_FIXTURE.operationalEnvelopeV1.valid) expect(envelopeInvalid(v.envelope), v.name).toBe(false);
    for (const v of R8_FIXTURE.operationalEnvelopeV1.invalid) expect(envelopeInvalid(v.envelope), v.name).toBe(true);
    expect(R8_FIXTURE.operationalEnvelopeV1.invalid.length).toBeGreaterThan(40);
  });

  it("decides exactly as OperationalEnvelopeV1Schema over a systematic corpus of one-change variants", () => {
    // Every node of each compiled envelope is replaced by every probe, deleted, or (for a container)
    // given an extra member; the structural check and the schema must agree on every variant.
    const probes: unknown[] = [
      null, true, false, 0, -1, 1, 1.5, 4, 61, 300, 1e9, -0.5, "", " ", "x", "1", "stop", "halt", "s", "min", "h", "uL", "mL", "degC",
      "attended", "unattended", "remote-supervised", "hardware", "adapter-stop", "none", "heat", "mechanical", "biological",
      "liquid-handler-ot2", "lab-plate-reader", "run_duration", "job_duration", "aspirate_volume", OTHER_MANIFEST, `0x${"ab".repeat(32)}`,
      [], {}, ["x"], [1], [1, 1], ["heat", "mechanical"], { mechanism: "hardware" }, { mechanism: "adapter-stop", stopCommand: "stop" },
      { mechanism: "none" }, { reason: "r", allowed: [1] }, { reason: "r", allowedItems: ["A1"] }, { name: "p", quantity: "aspirate_volume", unit: "uL" },
      { quantity: "aspirate_volume", unit: "uL", min: 0, max: 1 },
    ];
    let valid = 0;
    let invalid = 0;
    const disagreements: string[] = [];
    const check = (variant: unknown, label: string) => {
      const ours = envelopeInvalid(variant);
      const schema = !OperationalEnvelopeV1Schema.safeParse(variant).success;
      if (ours !== schema) disagreements.push(`${label}: ours ${ours ? "invalid" : "valid"}, schema ${schema ? "invalid" : "valid"}`);
      if (schema) invalid++;
      else valid++;
    };
    const visit = (root: OperationalEnvelopeV1, rootName: string, path: Array<string | number>) => {
      let node: any = root;
      for (const k of path) node = node[k];
      if (node === null || typeof node !== "object") return;
      const keys = Array.isArray(node) ? node.map((_: unknown, i: number) => i) : Object.keys(node);
      const at = (k: string | number) => `${rootName}.${[...path, k].join(".")}`;
      const set = (k: string | number, change: (parent: any) => void) =>
        changed(root, (copy) => {
          let parent = copy;
          for (const p of path) parent = parent[p];
          change(parent);
        });
      for (const k of keys) {
        for (const probe of probes) check(set(k, (parent) => (parent[k] = structuredClone(probe))), `${at(k)} = ${JSON.stringify(probe)}`);
        check(set(k, (parent) => (Array.isArray(parent) ? parent.splice(k as number, 1) : delete parent[k])), `${at(k)} removed`);
        if (Array.isArray(node)) check(set(k, (parent) => parent.push(structuredClone(parent[k]))), `${at(k)} duplicated`);
        visit(root, rootName, [...path, k]);
      }
      if (!Array.isArray(node)) check(set("extra", (parent) => (parent.extra = 1)), `${at("extra")} added`);
    };
    for (const [name, env] of [["ot2", OT2], ["ot2-cold", OT2_COLD], ["plate", PLATE]] as const) {
      check(structuredClone(env), `${name} untouched`);
      visit(env, name, []);
    }
    expect(disagreements).toEqual([]);
    // Both sides are exercised: some variants stay valid, most are refused.
    expect(valid).toBeGreaterThan(100);
    expect(invalid).toBeGreaterThan(1000);
  });
});
