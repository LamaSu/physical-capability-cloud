/**
 * Tests for onboarding/envelope-runtime-check.ts: the reference runtime check
 * of OperationalEnvelopeV1 (N86 part 2; the runtime half of R8 HIGH 8/9).
 * Envelopes are built the way operational-envelope.test.ts builds them:
 * confirm, register with an ephemeral registry key, compile.
 *
 * Special characters are built with String.fromCharCode, never written as
 * escape sequences, so no editor or tool can turn them into literal bytes.
 */

import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as specPackage from "../index.js";
import * as runtimeCheckModule from "../onboarding/envelope-runtime-check.js";
import { checkRuntimeCommand, type RuntimeDecision, type RuntimeState } from "../onboarding/envelope-runtime-check.js";
import * as onboardingModule from "../onboarding/index.js";
import * as primordialsModule from "../onboarding/primordials.js";
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

  it("refuses every envelope the schema refuses in safety-envelope-fixtures.test.ts, and accepts every compiled fixture", () => {
    // safety-envelope-v1.json is generated from that test's INVALID list and compiled inputs, and its drift test keeps it so.
    for (const v of R8_FIXTURE.operationalEnvelopeV1.invalid) {
      expect(OperationalEnvelopeV1Schema.safeParse(v.envelope).success, v.name).toBe(false);
      expect(envelopeInvalid(v.envelope), v.name).toBe(true);
    }
    for (const v of R8_FIXTURE.operationalEnvelopeV1.valid) {
      expect(OperationalEnvelopeV1Schema.safeParse(v.envelope).success, v.name).toBe(true);
      expect(envelopeInvalid(v.envelope), v.name).toBe(false);
    }
    expect(R8_FIXTURE.operationalEnvelopeV1.invalid.length).toBeGreaterThan(40);
    expect(R8_FIXTURE.operationalEnvelopeV1.valid.length).toBeGreaterThan(1);
    // And the envelopes compiled here.
    for (const env of [OT2, OT2_COLD, PLATE]) expect(envelopeInvalid(env)).toBe(false);
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

const ASPIRATE = { name: "aspirate", params: { volumeUl: 150 } };

describe("rule 2, state-invalid: the runtime's state is one plain copy, well formed", () => {
  const hex = "21".repeat(32);
  const newline = String.fromCharCode(10);

  it("refuses a state that is not an object, or lacks a field", () => {
    for (const bad of [null, undefined, [], "x", 1, true]) {
      expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, bad)), String(bad)).toBe("state-invalid");
    }
    for (const field of ["adapterManifestDigest", "jobStartedAtMs", "nowMs", "recentCommandsAtMs"]) {
      const state: Record<string, unknown> = { ...stateFor(OT2) };
      delete state[field];
      expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, state)), field).toBe("state-invalid");
    }
  });

  it("refuses an adapterManifestDigest that is not sha256: + 64 lowercase hex, checked by structure", () => {
    // Uppercase needs hex letters: "21".repeat(32) has none, so its uppercase is the same valid digest.
    for (const digest of [`sha256:${"AB".repeat(32)}`, `sha256:${"Ab".repeat(32)}`, `sha256:${hex.slice(1)}`, `sha256:${hex}0`, `sha256:${hex}${newline}`, `0x${hex}`, `SHA256:${hex}`, hex, 7, null]) {
      expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, stateFor(OT2, { adapterManifestDigest: digest as string }))), String(digest)).toBe("state-invalid");
    }
  });

  it("refuses times that are not finite numbers, and a job that starts after now", () => {
    for (const t of ["1790985600000", null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, [T0], {}]) {
      expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, stateFor(OT2, { nowMs: t as number }))), `nowMs ${String(t)}`).toBe("state-invalid");
      expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, stateFor(OT2, { jobStartedAtMs: t as number }))), `start ${String(t)}`).toBe("state-invalid");
    }
    expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, stateFor(OT2, { jobStartedAtMs: T0 + 1, nowMs: T0 })))).toBe("state-invalid");
    expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, stateFor(OT2, { jobStartedAtMs: T0, nowMs: T0 })))).toBe("allowed");
  });

  it("refuses recentCommandsAtMs unless it is a dense list of finite numbers", () => {
    const cases: unknown[] = [null, "x", { 0: T0 }, [T0, "1790985600000"], [T0, null], [Number.NaN], [Number.POSITIVE_INFINITY], [{}], [[T0]], [, T0], [undefined]]; // eslint-disable-line no-sparse-arrays
    for (const recent of cases) {
      expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, stateFor(OT2, { recentCommandsAtMs: recent as number[] }))), JSON.stringify(recent)).toBe("state-invalid");
    }
    expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, stateFor(OT2, { recentCommandsAtMs: [] })))).toBe("allowed");
    expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, stateFor(OT2, { recentCommandsAtMs: [T0 - 1e9, T0 + 1, -5] })))).toBe("allowed");
  });

  it("refuses a getter or a proxy in the state without running it, and ignores plain extra keys", () => {
    let reads = 0;
    const getter = { ...stateFor(OT2) };
    Object.defineProperty(getter, "nowMs", { enumerable: true, configurable: true, get: () => (reads++, T0) });
    expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, getter))).toBe("state-invalid");
    let traps = 0;
    const counting: ProxyHandler<object> = new Proxy({}, { get: () => (traps++, undefined) });
    expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, new Proxy(stateFor(OT2), counting)))).toBe("state-invalid");
    expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, { ...stateFor(OT2), recentCommandsAtMs: new Proxy([T0], counting) }))).toBe("state-invalid");
    expect(reads).toBe(0);
    expect(traps).toBe(0);
    // The spec lists the fields a state must have; other plain keys carry nothing and are ignored.
    expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, { ...stateFor(OT2), deviceId: "ot2-sim-1" }))).toBe("allowed");
  });

  it("comes after the envelope: an invalid envelope with a malformed state is envelope-invalid", () => {
    expect(codeOf(checkRuntimeCommand(changed(OT2, (e) => (e.strict = false)), ASPIRATE, null))).toBe("envelope-invalid");
  });
});

describe("rule 3, adapter-mismatch: the running adapter is the one the envelope commits", () => {
  it("refuses another adapter's manifest digest, for the stop too", () => {
    expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, stateFor(OT2, { adapterManifestDigest: OTHER_MANIFEST })))).toBe("adapter-mismatch");
    expect(codeOf(checkRuntimeCommand(OT2, STOP, stateFor(OT2, { adapterManifestDigest: OTHER_MANIFEST })))).toBe("adapter-mismatch");
    // The plate reader's adapter is not the OT-2's.
    expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, stateFor(PLATE)))).toBe("adapter-mismatch");
  });

  it("comes after the state and before the command", () => {
    // A malformed digest is a malformed state, not a mismatch.
    expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, stateFor(OT2, { adapterManifestDigest: OT2_MANIFEST.toUpperCase() })))).toBe("state-invalid");
    expect(codeOf(checkRuntimeCommand(OT2, { name: "", params: [] }, stateFor(OT2, { adapterManifestDigest: OTHER_MANIFEST })))).toBe("adapter-mismatch");
  });
});

describe("rule 4, command-malformed: plain data, exactly {name, params}", () => {
  const malformed = (command: unknown) => codeOf(checkRuntimeCommand(OT2, command, stateFor(OT2)));

  it("refuses a command that is not an object, or not exactly {name, params}", () => {
    for (const bad of [null, undefined, "aspirate", 1, [], [ASPIRATE]]) expect(malformed(bad), String(bad)).toBe("command-malformed");
    expect(malformed({ name: "aspirate" })).toBe("command-malformed");
    expect(malformed({ params: { volumeUl: 150 } })).toBe("command-malformed");
    expect(malformed({ ...ASPIRATE, id: "c-1" })).toBe("command-malformed");
    expect(malformed({ ...ASPIRATE, volumeUl: 150 })).toBe("command-malformed");
    // An undefined member is dropped, as JSON drops it.
    expect(malformed({ ...ASPIRATE, id: undefined })).toBe("allowed");
  });

  it("refuses a name that is not a non-blank string (JavaScript's trim decides blank)", () => {
    const blanks = ["", " ", String.fromCharCode(9), String.fromCharCode(10, 32), String.fromCharCode(0xfeff), String.fromCharCode(0x3000), String.fromCharCode(0x2028)];
    for (const name of blanks) expect(malformed({ name, params: {} }), JSON.stringify(name)).toBe("command-malformed");
    for (const name of [7, null, true, ["aspirate"], { name: "aspirate" }]) expect(malformed({ name, params: {} }), JSON.stringify(name)).toBe("command-malformed");
  });

  it("refuses params that are not a plain object", () => {
    for (const params of [[], [150], null, "volumeUl=150", 150, new Date(0), new Map([["volumeUl", 150]]), new (class { volumeUl = 150; })()]) {
      expect(malformed({ name: "aspirate", params }), String(params)).toBe("command-malformed");
    }
    // A null-prototype params object is plain data.
    expect(malformed({ name: "aspirate", params: Object.assign(Object.create(null), { volumeUl: 150 }) })).toBe("allowed");
  });

  it("refuses a proxy or a getter anywhere in the command, without running it", () => {
    let reads = 0;
    let traps = 0;
    const counting: ProxyHandler<object> = new Proxy({}, { get: () => (traps++, undefined) });
    const getterOn = (target: object, key: string, value: unknown) =>
      Object.defineProperty(target, key, { enumerable: true, configurable: true, get: () => (reads++, value) });
    expect(malformed(new Proxy({ ...ASPIRATE }, counting))).toBe("command-malformed");
    expect(malformed({ name: "aspirate", params: new Proxy({ volumeUl: 150 }, counting) })).toBe("command-malformed");
    expect(malformed({ name: "read", params: { seconds: 1, wavelengthNm: 405, wells: new Proxy(["A1"], counting) } })).toBe("command-malformed");
    expect(malformed(getterOn({ params: { volumeUl: 150 } }, "name", "aspirate"))).toBe("command-malformed");
    expect(malformed(getterOn({ name: "aspirate" }, "params", { volumeUl: 150 }))).toBe("command-malformed");
    expect(malformed({ name: "aspirate", params: getterOn({}, "volumeUl", 150) })).toBe("command-malformed");
    expect(reads).toBe(0);
    expect(traps).toBe(0);
  });

  it("refuses values that are not JSON data: NaN, Infinity, a hole, undefined in a list, a cycle, a key named __proto__", () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, () => 150, Symbol("v"), 150n]) {
      expect(malformed({ name: "aspirate", params: { volumeUl: v } }), String(v)).toBe("command-malformed");
    }
    const run = (labwareSlot: unknown) => malformed({ name: "runProtocol", params: { minutes: 10, labwareSlot } });
    expect(run([, 1])).toBe("command-malformed"); // eslint-disable-line no-sparse-arrays
    expect(run([undefined])).toBe("command-malformed");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(run(cycle)).toBe("command-malformed");
    expect(malformed({ name: "aspirate", params: JSON.parse('{"volumeUl": 150, "__proto__": {"volumeUl": 1}}') })).toBe("command-malformed");
  });

  it("comes before unknown-command", () => {
    expect(malformed({ name: " ", params: {} })).toBe("command-malformed");
    expect(malformed({ name: "blowout", params: [] })).toBe("command-malformed");
  });
});

describe("rule 5, unknown-command: only a declared command, matched exactly", () => {
  it("refuses a name not in envelope.commands, including near misses and inherited names", () => {
    const names = [
      "blowout", "Aspirate", " aspirate", "aspirate ", "read", "toString", "constructor", "__proto__", "hasOwnProperty",
      // Not whitespace to JavaScript's trim, so not blank: a runtime that strips them (Python's str.strip does) would say command-malformed.
      String.fromCharCode(0x1c), String.fromCharCode(0x85),
    ];
    for (const name of names) expect(codeOf(checkRuntimeCommand(OT2, { name, params: {} }, stateFor(OT2))), JSON.stringify(name)).toBe("unknown-command");
    expect(codeOf(checkRuntimeCommand(PLATE, { name: "aspirate", params: { volumeUl: 150 } }, stateFor(PLATE)))).toBe("unknown-command");
  });

  it("allows each declared command with valid params", () => {
    const ot2: Array<[string, Record<string, unknown>]> = [
      ["aspirate", { volumeUl: 150 }],
      ["dispense", { volumeUl: 150 }],
      ["setModuleTemp", { celsius: 37 }],
      ["runProtocol", { minutes: 60, labwareSlot: 3 }],
      ["transfer", { aspirateUl: 100, dispenseUl: 100, slot: 2 }],
      ["stop", {}],
    ];
    for (const [name, params] of ot2) expect(checkRuntimeCommand(OT2, { name, params }, stateFor(OT2)), name).toEqual({ allowed: true });
    const plate: Array<[string, Record<string, unknown>]> = [
      ["setIncubation", { celsius: 37 }],
      ["read", { seconds: 30, wavelengthNm: 450, wells: ["A1", "H12"] }],
      ["stop", {}],
    ];
    for (const [name, params] of plate) expect(checkRuntimeCommand(PLATE, { name, params }, stateFor(PLATE)), name).toEqual({ allowed: true });
  });
});

/** n copies of one send time. */
function sends(n: number, at: number): number[] {
  return Array.from({ length: n }, () => at);
}

/** run_duration and job_duration are both [.., 120] min: a 7,200,000 ms deadline. */
const DEADLINE_MS = 120 * MIN;
const NOW = T0 + 10 * MIN;

describe("rule 7, past-deadline: elapsed time against the deadline limit's max", () => {
  const at = (env: OperationalEnvelopeV1, elapsedMs: number, command: unknown = ASPIRATE) =>
    codeOf(checkRuntimeCommand(env, command, stateFor(env, { jobStartedAtMs: T0, nowMs: T0 + elapsedMs })));

  it("allows a command at exactly the deadline and refuses one 1 ms past it (strictly greater)", () => {
    expect(at(OT2, DEADLINE_MS)).toBe("allowed");
    expect(at(OT2, DEADLINE_MS + 1)).toBe("past-deadline");
    expect(at(OT2, DEADLINE_MS - 1)).toBe("allowed");
    expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, stateFor(OT2, { jobStartedAtMs: 0, nowMs: DEADLINE_MS + 0.5 })))).toBe("past-deadline");
    expect(at(OT2, 0)).toBe("allowed");
    expect(at(OT2, 1e12)).toBe("past-deadline");
  });

  it("uses the limit's max in minutes (x 60000), never its min, and the plate reader's own deadline", () => {
    // run_duration is [0, 120] min: an hour in is inside it, though past the min of 0.
    expect(at(OT2, 60 * MIN)).toBe("allowed");
    // job_duration is [1, 120] min: 30 s in is allowed although it is below the min.
    const read = { name: "read", params: { seconds: 30, wavelengthNm: 450, wells: "all" } };
    expect(at(PLATE, 30_000, read)).toBe("allowed");
    expect(at(PLATE, DEADLINE_MS, read)).toBe("allowed");
    expect(at(PLATE, DEADLINE_MS + 1, read)).toBe("past-deadline");
    // A shorter confirmed max moves the deadline with it.
    const short = changed(OT2, (e) => (e.limits[3].max = 1.5));
    expect(at(short, 90_000)).toBe("allowed");
    expect(at(short, 90_001)).toBe("past-deadline");
    // 0 is a real bound: a 0-minute deadline allows only elapsed 0.
    const none = changed(OT2, (e) => (e.limits[3].max = 0));
    expect(at(none, 0)).toBe("allowed");
    expect(at(none, 1)).toBe("past-deadline");
  });

  it("comes before the rate and the params", () => {
    const state = stateFor(OT2, { jobStartedAtMs: T0, nowMs: T0 + DEADLINE_MS + 1, recentCommandsAtMs: sends(60, T0 + DEADLINE_MS) });
    expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, state))).toBe("past-deadline");
    expect(codeOf(checkRuntimeCommand(OT2, { name: "aspirate", params: { volumeUl: "x", extra: 1 } }, state))).toBe("past-deadline");
  });
});

describe("rule 8, rate-limited: commands sent in (now - 60 s, now]", () => {
  const with_ = (env: OperationalEnvelopeV1, recentCommandsAtMs: number[], command: unknown = ASPIRATE) =>
    codeOf(checkRuntimeCommand(env, command, stateFor(env, { nowMs: NOW, recentCommandsAtMs })));

  it("refuses when this command would exceed maxCommandsPerMinute: 59 sent is fine, 60 is the limit", () => {
    expect(with_(OT2, sends(59, NOW - 1000))).toBe("allowed");
    expect(with_(OT2, sends(60, NOW - 1000))).toBe("rate-limited");
    const read = { name: "read", params: { seconds: 30, wavelengthNm: 450, wells: "all" } };
    expect(with_(PLATE, sends(29, NOW - 1000), read)).toBe("allowed");
    expect(with_(PLATE, sends(30, NOW - 1000), read)).toBe("rate-limited");
  });

  it("the window is (now - 60000, now]: an entry at exactly now - 60000 is outside, now - 59999 and now are inside", () => {
    expect(with_(OT2, sends(60, NOW - 60_000))).toBe("allowed");
    expect(with_(OT2, sends(60, NOW - 59_999))).toBe("rate-limited");
    expect(with_(OT2, sends(60, NOW))).toBe("rate-limited");
    expect(with_(OT2, sends(60, NOW - 60_000.5))).toBe("allowed");
    expect(with_(OT2, sends(60, NOW - 59_999.5))).toBe("rate-limited");
    // A send time after now (a clock step) is outside the window.
    expect(with_(OT2, sends(60, NOW + 1))).toBe("allowed");
  });

  it("counts only the window, in any order and at any length", () => {
    const mixed = [...sends(1000, NOW - 3_600_000), ...sends(59, NOW - 30_000), ...sends(5, NOW + 5), NOW - 60_000];
    expect(with_(OT2, mixed.reverse())).toBe("allowed");
    expect(with_(OT2, [...mixed, NOW - 1])).toBe("rate-limited");
  });

  it("comes before the params", () => {
    expect(with_(OT2, sends(60, NOW), { name: "aspirate", params: { volumeUl: 150, extra: 1 } })).toBe("rate-limited");
  });
});

describe("rule 6, the stop: always sendable, past the deadline and at the rate limit; its params are still checked", () => {
  const late = (env: OperationalEnvelopeV1, sent: number) =>
    stateFor(env, { jobStartedAtMs: T0, nowMs: T0 + DEADLINE_MS + 1, recentCommandsAtMs: sends(sent, T0 + DEADLINE_MS) });
  const onTime = (env: OperationalEnvelopeV1, sent: number) => stateFor(env, { nowMs: NOW, recentCommandsAtMs: sends(sent, NOW) });

  it("allows the adapter stop past the deadline, at the rate limit, and at both", () => {
    expect(codeOf(checkRuntimeCommand(OT2, STOP, late(OT2, 0)))).toBe("allowed");
    expect(codeOf(checkRuntimeCommand(OT2, STOP, onTime(OT2, 60)))).toBe("allowed");
    expect(codeOf(checkRuntimeCommand(OT2, STOP, late(OT2, 60)))).toBe("allowed");
    expect(codeOf(checkRuntimeCommand(OT2, STOP, late(OT2, 10_000)))).toBe("allowed");
  });

  it("refuses a non-stop command at each", () => {
    expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, late(OT2, 0)))).toBe("past-deadline");
    expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, onTime(OT2, 60)))).toBe("rate-limited");
    expect(codeOf(checkRuntimeCommand(OT2, ASPIRATE, late(OT2, 60)))).toBe("past-deadline");
  });

  it("checks the stop's params: one it does not declare is refused even when the stop is late", () => {
    expect(codeOf(checkRuntimeCommand(OT2, { name: "stop", params: { force: true } }, late(OT2, 60)))).toBe("undeclared-param");
  });

  it("exempts the command eStop.stopCommand names, not a command called stop", () => {
    const halt = changed(OT2, (e) => {
      e.commands[5].name = "halt";
      e.eStop.stopCommand = "halt";
    });
    expect(codeOf(checkRuntimeCommand(halt, { name: "halt", params: {} }, late(halt, 60)))).toBe("allowed");
    const aspirateStops = changed(OT2, (e) => (e.eStop.stopCommand = "aspirate"));
    expect(codeOf(checkRuntimeCommand(aspirateStops, STOP, late(aspirateStops, 0)))).toBe("past-deadline");
    expect(codeOf(checkRuntimeCommand(aspirateStops, ASPIRATE, late(aspirateStops, 60)))).toBe("allowed");
  });

  it("exempts nothing under a hardware stop: the plate reader's stop command is an ordinary command", () => {
    expect(codeOf(checkRuntimeCommand(PLATE, STOP, late(PLATE, 0)))).toBe("past-deadline");
    expect(codeOf(checkRuntimeCommand(PLATE, STOP, onTime(PLATE, 30)))).toBe("rate-limited");
    expect(codeOf(checkRuntimeCommand(PLATE, STOP, onTime(PLATE, 29)))).toBe("allowed");
  });

  it("is not exempt from rules 1 to 5", () => {
    expect(codeOf(checkRuntimeCommand(changed(OT2, (e) => (e.strict = false)), STOP, late(OT2, 0)))).toBe("envelope-invalid");
    expect(codeOf(checkRuntimeCommand(OT2, STOP, { ...late(OT2, 0), nowMs: "now" }))).toBe("state-invalid");
    expect(codeOf(checkRuntimeCommand(OT2, STOP, { ...late(OT2, 0), adapterManifestDigest: OTHER_MANIFEST }))).toBe("adapter-mismatch");
    expect(codeOf(checkRuntimeCommand(OT2, { name: "stop" }, late(OT2, 0)))).toBe("command-malformed");
    expect(codeOf(checkRuntimeCommand(OT2, { name: "Stop", params: {} }, late(OT2, 0)))).toBe("unknown-command");
  });
});

/** The adjacent doubles: the tightest possible epsilon on each side of a bound. */
function nextUp(x: number): number {
  if (x === 0) return Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, x > 0 ? bits + 1n : bits - 1n);
  return view.getFloat64(0);
}
function nextDown(x: number): number {
  return -nextUp(-x);
}

describe("rules 9 and 10, undeclared-param and missing-param: the params are exactly the declared ones", () => {
  const code = (env: OperationalEnvelopeV1, name: string, params: Record<string, unknown>) =>
    codeOf(checkRuntimeCommand(env, { name, params }, stateFor(env)));

  it("refuses a parameter the command does not declare, inherited names and another command's params included", () => {
    expect(code(OT2, "aspirate", { volumeUl: 150, speed: 2 })).toBe("undeclared-param");
    expect(code(OT2, "stop", { force: true })).toBe("undeclared-param");
    for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf", "0"]) {
      expect(code(OT2, "aspirate", { volumeUl: 150, [key]: 1 }), key).toBe("undeclared-param");
    }
    expect(code(OT2, "setModuleTemp", { celsius: 37, volumeUl: 150 })).toBe("undeclared-param");
  });

  it("refuses a declared parameter that is absent: every one is required, and undefined is absent", () => {
    expect(code(OT2, "aspirate", {})).toBe("missing-param");
    expect(code(OT2, "aspirate", { volumeUl: undefined })).toBe("missing-param");
    expect(code(OT2, "runProtocol", { minutes: 10 })).toBe("missing-param");
    expect(code(PLATE, "read", { seconds: 30, wavelengthNm: 450 })).toBe("missing-param");
  });

  it("checks undeclared before missing, and missing before any value", () => {
    expect(code(OT2, "aspirate", { celsius: 37 })).toBe("undeclared-param");
    expect(code(OT2, "transfer", { aspirateUl: "x" })).toBe("missing-param");
    expect(code(PLATE, "read", { seconds: 1e9, wells: ["Z9"] })).toBe("missing-param");
  });
});

describe("rule 11, bounded params: a finite JSON number inside [min, max], 0 a real bound, no conversion", () => {
  const value = (env: OperationalEnvelopeV1, name: string, key: string, v: unknown, rest: Record<string, unknown> = {}) =>
    codeOf(checkRuntimeCommand(env, { name, params: { ...rest, [key]: v } }, stateFor(env)));
  const aspirate = (v: unknown) => value(OT2, "aspirate", "volumeUl", v);

  it("allows exactly min and exactly max, and refuses the adjacent doubles outside them", () => {
    expect(aspirate(1)).toBe("allowed");
    expect(aspirate(300)).toBe("allowed");
    expect(aspirate(nextDown(1))).toBe("out-of-range");
    expect(aspirate(nextUp(300))).toBe("out-of-range");
    expect(nextDown(1)).toBe(0.9999999999999999);
    expect(nextUp(300)).toBe(300.00000000000006);
    expect(aspirate(nextUp(1))).toBe("allowed");
    expect(aspirate(nextDown(300))).toBe("allowed");
  });

  it("takes 0 as a bound like any other, on either side", () => {
    const minutes = (v: unknown) => value(OT2, "runProtocol", "minutes", v, { labwareSlot: 1 });
    expect(minutes(0)).toBe("allowed");
    expect(minutes(nextDown(0))).toBe("out-of-range");
    expect(minutes(-1)).toBe("out-of-range");
    const cold = (v: unknown) => value(OT2_COLD, "setModuleTemp", "celsius", v);
    expect(cold(0)).toBe("allowed");
    expect(cold(nextUp(0))).toBe("out-of-range");
    expect(cold(-20)).toBe("allowed");
    expect(cold(nextDown(-20))).toBe("out-of-range");
  });

  it("counts -0 as 0, in a value and in a bound", () => {
    expect(value(OT2, "runProtocol", "minutes", -0, { labwareSlot: 1 })).toBe("allowed");
    expect(value(OT2_COLD, "setModuleTemp", "celsius", -0)).toBe("allowed");
    const negativeZeroMin = changed(OT2, (e) => (e.limits[3].min = -0));
    expect(value(negativeZeroMin, "runProtocol", "minutes", 0, { labwareSlot: 1 })).toBe("allowed");
    expect(value(negativeZeroMin, "runProtocol", "minutes", nextDown(0), { labwareSlot: 1 })).toBe("out-of-range");
  });

  it("refuses a numeric string and every other non-number as not-a-number (NaN and Infinity are not JSON: command-malformed)", () => {
    for (const v of ["150", " 150", "1.5e2", "0x96", "", "NaN", "Infinity", null, true, false, [150], { value: 150, unit: "uL" }]) {
      expect(aspirate(v), JSON.stringify(v)).toBe("not-a-number");
    }
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(aspirate(v), String(v)).toBe("command-malformed");
  });

  it("refuses values far outside, and converts no unit: 0.3 is 0.3 uL, below the 1 uL min", () => {
    for (const v of [1e308, -1e308, Number.MAX_VALUE, -Number.MAX_VALUE, -150]) expect(aspirate(v), String(v)).toBe("out-of-range");
    expect(aspirate(0.3)).toBe("out-of-range");
  });

  it("checks each quantity against its own limit", () => {
    const temp = (v: number) => value(OT2, "setModuleTemp", "celsius", v);
    expect([temp(4), temp(95), temp(nextDown(4)), temp(nextUp(95))]).toEqual(["allowed", "allowed", "out-of-range", "out-of-range"]);
    const dispense = (v: number) => value(OT2, "dispense", "volumeUl", v);
    expect([dispense(1), dispense(300), dispense(nextUp(300))]).toEqual(["allowed", "allowed", "out-of-range"]);
    const incubate = (v: number) => value(PLATE, "setIncubation", "celsius", v);
    expect([incubate(20), incubate(45), incubate(19.99), incubate(45.01)]).toEqual(["allowed", "allowed", "out-of-range", "out-of-range"]);
    const read = (v: number) => value(PLATE, "read", "seconds", v, { wavelengthNm: 405, wells: "all" });
    expect([read(1), read(600), read(0), read(601)]).toEqual(["allowed", "allowed", "out-of-range", "out-of-range"]);
    // run_duration is also a command parameter here: checked against the same limit as the deadline.
    expect(value(OT2, "runProtocol", "minutes", 120, { labwareSlot: 1 })).toBe("allowed");
    expect(value(OT2, "runProtocol", "minutes", nextUp(120), { labwareSlot: 1 })).toBe("out-of-range");
  });

  it("checks bounded params one by one in declaration order, type then range, and all of them before any unbounded param", () => {
    const transfer = (params: Record<string, unknown>) => codeOf(checkRuntimeCommand(OT2, { name: "transfer", params }, stateFor(OT2)));
    expect(transfer({ aspirateUl: "5", dispenseUl: 1e9, slot: 1 })).toBe("not-a-number");
    expect(transfer({ aspirateUl: 1e9, dispenseUl: "5", slot: 1 })).toBe("out-of-range");
    expect(transfer({ aspirateUl: 100, dispenseUl: "5", slot: 99 })).toBe("not-a-number");
    expect(transfer({ aspirateUl: 100, dispenseUl: 1e9, slot: 99 })).toBe("out-of-range");
    expect(transfer({ aspirateUl: 100, dispenseUl: 100, slot: 99 })).toBe("value-not-allowed");
    expect(transfer({ aspirateUl: 100, dispenseUl: 100, slot: 11 })).toBe("allowed");
  });
});

describe("rule 12, unbounded params: one allowed value, or a non-empty list of distinct allowed items", () => {
  const slot = (v: unknown) => codeOf(checkRuntimeCommand(OT2, { name: "runProtocol", params: { minutes: 10, labwareSlot: v } }, stateFor(OT2)));
  const read = (env: OperationalEnvelopeV1, params: Record<string, unknown>) =>
    codeOf(checkRuntimeCommand(env, { name: "read", params: { seconds: 30, wavelengthNm: 450, wells: "all", ...params } }, stateFor(env)));

  it("passes a value === one of allowed (same type and value) and refuses anything else", () => {
    for (const v of SLOTS) expect(slot(v), String(v)).toBe("allowed");
    expect(slot(1.0)).toBe("allowed");
    for (const v of [0, 12, 1.5, "1", "one", true, null, [1], [1, 2], {}, { slot: 1 }]) expect(slot(v), JSON.stringify(v)).toBe("value-not-allowed");
    expect(read(PLATE, { wavelengthNm: 405 })).toBe("allowed");
    for (const v of ["405", 405.5, 404]) expect(read(PLATE, { wavelengthNm: v }), JSON.stringify(v)).toBe("value-not-allowed");
  });

  it("passes a non-empty list of distinct allowedItems, in any order", () => {
    for (const wells of [["A1"], ["A1", "H12"], ["H12", "A1"], ["A1", "A2", "A3", "H12"]]) {
      expect(read(PLATE, { wells }), JSON.stringify(wells)).toBe("allowed");
    }
  });

  it("refuses an allowedItems list that is empty, duplicated, holds a non-member, an object or a list, and a single item or the single value as a list", () => {
    const refused: unknown[] = [[], ["A1", "A1"], ["A1", "B7"], ["a1"], [{}], [{ A1: true }], [["A1"]], [null], [1], "A1", ["all"], ["A1", "A2", "A3", "H12", "A1"]];
    for (const wells of refused) expect(read(PLATE, { wells }), JSON.stringify(wells)).toBe("value-not-allowed");
  });

  it("with allowedItems alone, a single value never passes; with allowed alone, a list never passes", () => {
    const itemsOnly = changed(PLATE, (e) => delete e.commands[1].params[2].unbounded.allowed);
    expect(read(itemsOnly, { wells: "all" })).toBe("value-not-allowed");
    expect(read(itemsOnly, { wells: ["A1"] })).toBe("allowed");
    expect(slot([1])).toBe("value-not-allowed");
  });

  it("compares list items by type and value, and distinctness by their JSON (so -0 and 0 are the same item)", () => {
    const mixed = changed(PLATE, (e) => (e.commands[1].params[2].unbounded.allowedItems = [0, 1, "1"]));
    expect(read(mixed, { wells: [1, "1"] })).toBe("allowed");
    expect(read(mixed, { wells: [1, 1] })).toBe("value-not-allowed");
    expect(read(mixed, { wells: ["1", "1"] })).toBe("value-not-allowed");
    expect(read(mixed, { wells: [-0] })).toBe("allowed");
    expect(read(mixed, { wells: [0, -0] })).toBe("value-not-allowed");
    expect(read(mixed, { wells: [true] })).toBe("value-not-allowed");
  });
});

describe("rule 13 and the decision itself", () => {
  it("allows a command that passes every rule, as a frozen { allowed: true }", () => {
    const d = checkRuntimeCommand(OT2, ASPIRATE, stateFor(OT2));
    expect(d).toEqual({ allowed: true });
    expect(Object.keys(d)).toEqual(["allowed"]);
    expect(Object.isFrozen(d)).toBe(true);
  });

  it("refuses with a frozen { allowed: false, code, reason }, the reason a non-empty human message", () => {
    const d = checkRuntimeCommand(OT2, { name: "aspirate", params: { volumeUl: 301 } }, stateFor(OT2));
    expect(d.allowed).toBe(false);
    expect(Object.keys(d)).toEqual(["allowed", "code", "reason"]);
    expect(Object.isFrozen(d)).toBe(true);
    if (!d.allowed) {
      expect(d.code).toBe("out-of-range");
      expect(d.reason).toMatch(/volumeUl.*301.*\[1, 300\] uL/);
    }
  });

  it("is pure: it changes none of its inputs, and the same inputs give the same decision", () => {
    const envelope = structuredClone(OT2);
    const command = { name: "transfer", params: { aspirateUl: 100, dispenseUl: 100, slot: 2 } };
    const state = stateFor(OT2, { recentCommandsAtMs: [NOW - 1, NOW - 2] });
    const before = JSON.stringify([envelope, command, state]);
    const first = checkRuntimeCommand(envelope, command, state);
    expect(checkRuntimeCommand(envelope, command, state)).toEqual(first);
    expect(JSON.stringify([envelope, command, state])).toBe(before);
    expect(Object.isFrozen(envelope) || Object.isFrozen(command) || Object.isFrozen(state)).toBe(false);
  });
});

// ── Intrinsics replaced after load, prototype pollution, recompiled RegExps (astra packs 164 and 167) ──

type Vector = { name: string; envelope: unknown; command: unknown; state: unknown };

const FIXTURE_VECTORS = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../../fixtures/onboarding/envelope-runtime-check-v1.json", import.meta.url)), "utf8")) as {
    vectors: Vector[];
  }
).vectors;

/** Counts every operation on the proxies below and every call of the getters below: none may ever run. */
let touched = 0;
const COUNTING: ProxyHandler<object> = new Proxy({}, { get: () => (touched++, undefined) });
function withGetter<T extends object>(target: T, key: string, value: unknown): T {
  Object.defineProperty(target, key, { enumerable: true, configurable: true, get: () => (touched++, value) });
  return target;
}

/** Vectors JSON cannot carry, built once, before any patch. */
const JS_ONLY: Vector[] = [
  { name: "a proxy envelope", envelope: new Proxy(structuredClone(OT2), COUNTING), command: ASPIRATE, state: stateFor(OT2) },
  { name: "a proxy state", envelope: OT2, command: ASPIRATE, state: new Proxy(stateFor(OT2), COUNTING) },
  { name: "a proxy command", envelope: OT2, command: new Proxy({ ...ASPIRATE }, COUNTING), state: stateFor(OT2) },
  { name: "a proxy list in params", envelope: PLATE, command: { name: "read", params: { seconds: 30, wavelengthNm: 450, wells: new Proxy(["A1"], COUNTING) } }, state: stateFor(PLATE) },
  { name: "a getter in params", envelope: OT2, command: { name: "aspirate", params: withGetter({}, "volumeUl", 150) }, state: stateFor(OT2) },
  { name: "a getter in a limit", envelope: changed(OT2, (e) => withGetter(e.limits[0], "max", 300)), command: ASPIRATE, state: stateFor(OT2) },
  { name: "a getter in the state", envelope: OT2, command: ASPIRATE, state: withGetter({ ...stateFor(OT2) }, "nowMs", NOW) },
  // An accessor on a list element: read through an inherited `value`, it would look like data.
  { name: "a getter on a list element", envelope: PLATE, command: { name: "read", params: { seconds: 30, wavelengthNm: 450, wells: withGetter(["A1"], "0", "A1") } }, state: stateFor(PLATE) },
  { name: "NaN in params", envelope: OT2, command: { name: "aspirate", params: { volumeUl: Number.NaN } }, state: stateFor(OT2) },
  { name: "Infinity in params", envelope: OT2, command: { name: "aspirate", params: { volumeUl: Number.POSITIVE_INFINITY } }, state: stateFor(OT2) },
  { name: "-0 at a 0 min", envelope: OT2, command: { name: "runProtocol", params: { minutes: -0, labwareSlot: 1 } }, state: stateFor(OT2) },
  { name: "-0 just above a 0 max", envelope: OT2_COLD, command: { name: "setModuleTemp", params: { celsius: -0 } }, state: stateFor(OT2_COLD) },
  { name: "a hole in a list", envelope: PLATE, command: { name: "read", params: { seconds: 30, wavelengthNm: 450, wells: [, "A1"] } }, state: stateFor(PLATE) }, // eslint-disable-line no-sparse-arrays
  { name: "a Date as params", envelope: OT2, command: { name: "aspirate", params: new Date(0) }, state: stateFor(OT2) },
  { name: "null-prototype params", envelope: OT2, command: { name: "aspirate", params: Object.assign(Object.create(null), { volumeUl: 150 }) }, state: stateFor(OT2) },
  { name: "an undefined member", envelope: OT2, command: { ...ASPIRATE, id: undefined }, state: stateFor(OT2) },
  { name: "a hole in the sends", envelope: OT2, command: ASPIRATE, state: stateFor(OT2, { recentCommandsAtMs: [, NOW] as number[] }) }, // eslint-disable-line no-sparse-arrays
  { name: "the frozen compiled envelope", envelope: OT2, command: { name: "transfer", params: { aspirateUl: 1, dispenseUl: 300, slot: 11 } }, state: stateFor(OT2) },
];

const ALL: Vector[] = [...FIXTURE_VECTORS, ...JS_ONLY];

/** Every decision, by an indexed loop and assignment: it runs under a patch, so it calls no intrinsic itself. */
function decideAll(): RuntimeDecision[] {
  const out: RuntimeDecision[] = new Array(ALL.length);
  for (let i = 0; i < ALL.length; i++) {
    const v = ALL[i]!;
    out[i] = checkRuntimeCommand(v.envelope, v.command, v.state);
  }
  return out;
}

/** The untouched decisions, reasons included: every patched run must reproduce them byte for byte. */
const CLEAN_DECISIONS = JSON.stringify(decideAll());

const ownKeysAtLoad = Reflect.ownKeys;
const descriptorAtLoad = Reflect.getOwnPropertyDescriptor;

/**
 * A value with every writable limit widened, as an attacker's replacement would
 * return it: a check that used the replacement would let out-of-range values
 * through. Indexed loops and load-time Reflect only.
 */
function raise<T>(value: T, depth = 0): T {
  if (value !== null && typeof value === "object" && depth < 32) {
    const keys = ownKeysAtLoad(value);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const d = descriptorAtLoad(value, key);
      if (!d || d.get || d.set) continue;
      if (d.writable && typeof d.value === "number" && (key === "max" || key === "maxCommandsPerMinute")) (value as Record<PropertyKey, unknown>)[key] = 1e12;
      else if (d.writable && typeof d.value === "number" && key === "min") (value as Record<PropertyKey, unknown>)[key] = -1e12;
      else raise(d.value, depth + 1);
    }
  }
  return value;
}

type Patch = [label: string, target: object, key: PropertyKey, replacement: (original: any) => unknown];

const ArrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]());
const HashPrototype = Object.getPrototypeOf(createHash("sha256"));

/** R8's rows (safety-envelope-intrinsics.test.ts), then rows that return a wrong answer outright. */
const PATCHES: Patch[] = [
  ["Array.prototype.map", Array.prototype, "map", (o) => function (this: unknown[], ...a: unknown[]) { return raise(o.apply(this, a)); }],
  ["Array.prototype.filter", Array.prototype, "filter", (o) => function (this: unknown[], ...a: unknown[]) { return raise(o.apply(this, a)); }],
  ["Array.prototype.flatMap", Array.prototype, "flatMap", (o) => function (this: unknown[], ...a: unknown[]) { return raise(o.apply(this, a)); }],
  ["Array.prototype.forEach", Array.prototype, "forEach", (o) => function (this: unknown[], ...a: unknown[]) { raise(this); return o.apply(this, a); }],
  ["Array.prototype.some", Array.prototype, "some", () => () => false],
  ["Array.prototype.every", Array.prototype, "every", () => () => true],
  ["Array.prototype.includes", Array.prototype, "includes", () => () => true],
  ["Array.prototype.find", Array.prototype, "find", () => () => undefined],
  ["Array.prototype.join", Array.prototype, "join", () => () => ""],
  ["Array.prototype.push", Array.prototype, "push", (o) => function (this: unknown[], ...a: unknown[]) { return o.apply(this, raise(a)); }],
  ["Array.prototype.sort", Array.prototype, "sort", (o) => function (this: unknown[]) { return o.call(this).reverse(); }],
  ["Array.prototype.slice", Array.prototype, "slice", (o) => function (this: unknown[], ...a: unknown[]) { return raise(o.apply(this, a)); }],
  ["Array.prototype.concat", Array.prototype, "concat", (o) => function (this: unknown[], ...a: unknown[]) { return raise(o.apply(this, a)); }],
  ["Array.prototype[Symbol.iterator]", Array.prototype, Symbol.iterator, (o) => function (this: unknown[]) { raise(this); return o.call(this); }],
  ["%ArrayIteratorPrototype%.next", ArrayIteratorPrototype, "next", (o) => function (this: unknown) { return raise(o.call(this)); }],
  ["Object.keys", Object, "keys", (o) => (v: object) => (o(v) as string[]).reverse()],
  ["Object.assign", Object, "assign", (o) => (...a: unknown[]) => raise(o(...a))],
  ["Object.freeze", Object, "freeze", () => (v: unknown) => v],
  ["Object.isFrozen", Object, "isFrozen", () => () => true],
  ["Object.getOwnPropertyDescriptor", Object, "getOwnPropertyDescriptor", (o) => (v: object, k: PropertyKey) => raise(o(v, k))],
  ["Object.getPrototypeOf", Object, "getPrototypeOf", () => () => null],
  ["Object.defineProperty", Object, "defineProperty", (o) => (v: object, k: PropertyKey, d: PropertyDescriptor) => o(v, k, raise({ ...d }))],
  ["Object.create", Object, "create", (o) => (p: object | null) => o(p)],
  ["Object.is", Object, "is", () => () => false],
  ["Object.prototype.hasOwnProperty", Object.prototype, "hasOwnProperty", () => () => true],
  ["JSON.parse", JSON, "parse", (o) => (...a: unknown[]) => raise(o(...a))],
  ["JSON.stringify", JSON, "stringify", () => () => '"x"'],
  ["String.prototype.trim", String.prototype, "trim", () => () => "x"],
  ["String.prototype.toLowerCase", String.prototype, "toLowerCase", () => () => "x"],
  ["String.prototype.charCodeAt", String.prototype, "charCodeAt", () => () => 0x30],
  ["RegExp.prototype.exec", RegExp.prototype, "exec", () => () => null],
  ["RegExp.prototype.test", RegExp.prototype, "test", () => () => true],
  ["Number.isFinite", Number, "isFinite", () => () => true],
  ["Number.isInteger", Number, "isInteger", () => () => true],
  ["Date.parse", Date, "parse", () => () => Number.NaN],
  ["Math.max", Math, "max", () => () => 1e9],
  ["Math.min", Math, "min", () => () => -1e9],
  ["Set.prototype.has", Set.prototype, "has", () => () => true],
  ["Map.prototype.get", Map.prototype, "get", () => () => undefined],
  ["Function.prototype.call", Function.prototype, "call", (o) => function (this: Function, ...a: unknown[]) { return raise(o.apply(this, [a[0], ...a.slice(1)])); }],
  ["Function.prototype.apply", Function.prototype, "apply", (o) => function (this: Function, self: unknown, args: unknown[]) { return raise(o.call(this, self, args)); }],
  ["Hash.prototype.digest", HashPrototype, "digest", () => () => "0".repeat(64)],
  ["Hash.prototype.update", HashPrototype, "update", (o) => function (this: unknown) { return o.call(this, "tampered"); }],
  ["TextEncoder.prototype.encode", TextEncoder.prototype, "encode", () => () => new Uint8Array(71)],
  // Wrong answers outright: a check that consulted any of these would decide differently.
  ["Array.isArray (false)", Array, "isArray", () => () => false],
  ["Array.isArray (true)", Array, "isArray", () => () => true],
  ["Array.prototype.map (empty)", Array.prototype, "map", () => () => []],
  ["Array.prototype.filter (empty)", Array.prototype, "filter", () => () => []],
  ["Array.prototype.indexOf", Array.prototype, "indexOf", () => () => 0],
  ["Object.keys (empty)", Object, "keys", () => () => []],
  ["Object.getOwnPropertyDescriptor (a data 0)", Object, "getOwnPropertyDescriptor", () => () => ({ value: 0, writable: true, enumerable: true, configurable: true })],
  ["Object.prototype.hasOwnProperty (false)", Object.prototype, "hasOwnProperty", () => () => false],
  ["Number.isFinite (false)", Number, "isFinite", () => () => false],
  ["Number.isInteger (false)", Number, "isInteger", () => () => false],
  ["String.prototype.trim (empty)", String.prototype, "trim", () => () => ""],
  ["String.prototype.charCodeAt (a)", String.prototype, "charCodeAt", () => () => 0x61],
  ["Number.prototype.toString", Number.prototype, "toString", () => () => "1"],
  ["Object.prototype.toString", Object.prototype, "toString", () => () => "[object Object]"],
];

function withPatch<T>(target: object, key: PropertyKey, replacement: unknown, run: () => T): T {
  const original = Reflect.getOwnPropertyDescriptor(target, key)!;
  Reflect.defineProperty(target, key, { ...original, value: replacement });
  try {
    return run();
  } finally {
    Reflect.defineProperty(target, key, original);
  }
}

describe("intrinsics replaced after load cannot change a decision (astra pack 164)", () => {
  it("the harness covers every fixture vector and the vectors JSON cannot carry, none of which runs code", () => {
    expect(FIXTURE_VECTORS.length).toBeGreaterThan(100);
    expect(JS_ONLY.length).toBeGreaterThan(16);
    const decisions = JSON.parse(CLEAN_DECISIONS) as Array<{ allowed: boolean; code?: string }>;
    expect(new Set(decisions.map((d) => (d.allowed ? "allowed" : d.code))).size).toBe(13);
    expect(touched).toBe(0);
  });

  for (const [label, target, key, make] of PATCHES) {
    it(`with ${label} replaced, every decision, reason included, is exactly the untouched one`, () => {
      const original = Reflect.getOwnPropertyDescriptor(target, key)!.value;
      const decisions = withPatch(target, key, make(original), decideAll);
      expect(JSON.stringify(decisions)).toBe(CLEAN_DECISIONS);
      expect(touched).toBe(0);
    });
  }

  it("data written onto Object.prototype and Array.prototype changes no decision", () => {
    // Data-only prototype pollution, the kind a JSON merge bug causes: values appear through inheritance.
    // Every read is of an own property of a null-prototype copy, so none of them is ever seen.
    const keys = [
      "min", "max", "value", "get", "set", "name", "params", "allowed", "allowedItems", "unbounded", "quantity", "unit", "mechanism",
      "stopCommand", "nowMs", "jobStartedAtMs", "recentCommandsAtMs", "adapterManifestDigest", "adapterVersion", "volumeUl", "labwareSlot",
      "wells", "code", "reason", "strict", "limits", "commands", "deadlineQuantity", "maxCommandsPerMinute", "eStop", "hazards", "supervision",
      "deviceClass", "envelopeVersion", "envelopeDigest", "0",
    ];
    const pollution: Array<[object, PropertyKey, unknown]> = [
      ...keys.map((k): [object, PropertyKey, unknown] => [Object.prototype, k, 1e12]),
      [Object.prototype, "toJSON", () => "polluted"],
      [Array.prototype, 0, { max: 1e12 }],
      [Array.prototype, 1, "A1"],
      [Array.prototype, "toJSON", () => "polluted"],
    ];
    let decisions: RuntimeDecision[] = [];
    try {
      for (const [target, key, value] of pollution) {
        Reflect.defineProperty(target, key, { __proto__: null, value, writable: true, enumerable: false, configurable: true } as PropertyDescriptor);
      }
      decisions = decideAll();
    } finally {
      for (const [target, key] of pollution) Reflect.deleteProperty(target, key);
    }
    expect(JSON.stringify(decisions)).toBe(CLEAN_DECISIONS);
    expect(touched).toBe(0);
  });
});

/**
 * Every RegExp reachable from the exports of `modules`: own properties (a getter
 * is walked as a function, never called), prototypes, Map and Set entries, and
 * zod's shape thunks. A module's exports are read through its namespace, whose
 * live bindings vitest serves as getters.
 */
function regexpsReachableFrom(modules: object[]): { regexps: RegExp[]; objects: number } {
  const seen = new Set<unknown>();
  const regexps: RegExp[] = [];
  const stack: unknown[] = [];
  for (const namespace of modules) {
    for (const key of Reflect.ownKeys(namespace)) stack.push((namespace as Record<PropertyKey, unknown>)[key]);
  }
  while (stack.length > 0) {
    const value = stack.pop();
    if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) continue;
    seen.add(value);
    if (value instanceof RegExp) regexps.push(value);
    if (value instanceof Map) for (const [k, v] of value) stack.push(k, v);
    if (value instanceof Set) for (const v of value) stack.push(v);
    // zod keeps an object schema's shape, and a lazy schema, behind a pure thunk: call it to reach the schemas inside.
    const def = (value as { _def?: { shape?: unknown; getter?: unknown } })._def;
    if (def !== null && typeof def === "object") {
      for (const thunk of [def.shape, def.getter]) {
        if (typeof thunk !== "function") continue;
        try {
          stack.push(thunk.call(def));
        } catch {
          // Not a thunk after all; nothing to reach.
        }
      }
    }
    stack.push(Object.getPrototypeOf(value));
    for (const key of Reflect.ownKeys(value)) {
      const d = Reflect.getOwnPropertyDescriptor(value, key);
      if (!d) continue;
      if ("value" in d) stack.push(d.value);
      else stack.push(d.get, d.set);
    }
  }
  return { regexps, objects: seen.size };
}

/** RegExp.prototype.compile (Annex B) replaces the matcher in place; on a frozen RegExp it throws only afterwards. */
function recompile(re: RegExp, source: string, flags: string): void {
  try {
    re.compile(source, flags);
  } catch {
    // Frozen: the matcher was replaced before setting lastIndex failed.
  }
}

describe("RegExps reachable after load cannot change a decision (astra pack 167)", () => {
  it("the walk finds a RegExp behind arrays, maps, sets, accessors and prototypes, and recompile replaces even a frozen one", () => {
    const hidden = [/a/, /b/, /c/, /d/];
    const holder = Object.create({ proto: hidden[3] });
    Object.defineProperty(holder, "getter", { get: () => hidden[2] });
    const root = { list: [{ map: new Map([["k", hidden[0]]]) }], set: new Set([hidden[1]]), getterHolder: holder };
    const found = regexpsReachableFrom([{ root }]).regexps;
    // The getter is reached as a function, never called, so its RegExp is not found: nothing is run to walk.
    expect(found).toEqual(expect.arrayContaining([hidden[0], hidden[1], hidden[3]]));
    const frozen = Object.freeze(/^x$/);
    recompile(frozen, ".*", "");
    expect(frozen.test("anything")).toBe(true);
    recompile(frozen, "^x$", "");
    expect(frozen.test("anything")).toBe(false);
  });

  it("with every RegExp reachable from this module, the onboarding module, primordials and the whole package recompiled to .*, every decision is unchanged", () => {
    const { regexps, objects } = regexpsReachableFrom([runtimeCheckModule, onboardingModule, primordialsModule, specPackage]);
    const saved = regexps.map((re) => [re, re.source, re.flags] as const);
    let decisions: RuntimeDecision[] = [];
    let allMatchAnything = true;
    try {
      for (const re of regexps) recompile(re, ".*", "");
      for (const re of regexps) allMatchAnything = allMatchAnything && re.test("sha256:NOT-A-DIGEST");
      decisions = decideAll();
    } finally {
      for (const [re, source, flags] of saved) recompile(re, source, flags);
    }
    for (const [re, source, flags] of saved) expect(`${re.source}/${re.flags}`).toBe(`${source}/${flags}`);
    expect(allMatchAnything).toBe(true);
    // The walk reaches into the package's zod schemas, and finds RegExps there to recompile.
    expect(objects).toBeGreaterThan(1000);
    expect(regexps.length).toBeGreaterThan(0);
    expect(JSON.stringify(decisions)).toBe(CLEAN_DECISIONS);
  });

  it("the module exports exactly the check, and holds no RegExp itself", () => {
    expect(Object.keys(runtimeCheckModule)).toEqual(["checkRuntimeCommand"]);
    expect(regexpsReachableFrom([runtimeCheckModule]).regexps).toEqual([]);
  });
});

describe("envelope-runtime-check.ts source: no RegExp, no zod, no ambient call, template interpolations included", () => {
  const SOURCE = readFileSync(fileURLToPath(new URL("../onboarding/envelope-runtime-check.ts", import.meta.url)), "utf8");

  /**
   * The code with comments and string text blanked, keeping every template
   * interpolation as code. R8's codeOnly blanks a template literal whole, so a
   * call inside `${...}` would be invisible to it.
   */
  function codeWithInterpolations(source: string): string {
    let i = 0;
    let out = "";
    const template = (): void => {
      out += '""';
      while (i < source.length) {
        const c = source[i]!;
        if (c === "\\") i += 2;
        else if (c === "`") {
          i++;
          return;
        } else if (c === "$" && source[i + 1] === "{") {
          i += 2;
          out += "(";
          code(true);
          out += ")";
        } else {
          if (c === "\n") out += "\n";
          i++;
        }
      }
    };
    const code = (inInterpolation: boolean): void => {
      let depth = 0;
      while (i < source.length) {
        const c = source[i]!;
        const next = source[i + 1];
        if (c === "/" && next === "*") {
          const end = source.indexOf("*/", i + 2);
          i = end < 0 ? source.length : end + 2;
          out += " ";
        } else if (c === "/" && next === "/") {
          const end = source.indexOf("\n", i);
          i = end < 0 ? source.length : end;
        } else if (c === '"' || c === "'") {
          let j = i + 1;
          while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
          i = j + 1;
          out += '""';
        } else if (c === "`") {
          i++;
          template();
        } else if (c === "}" && inInterpolation && depth === 0) {
          i++;
          return;
        } else {
          if (c === "{") depth++;
          if (c === "}") depth--;
          out += c;
          i++;
        }
      }
    };
    code(false);
    return out;
  }

  it("the extractor keeps interpolations, nested ones too, and blanks only text", () => {
    expect(codeWithInterpolations("const a = `x ${f(/re/)} y`; // c")).toContain("f(/re/)");
    expect(codeWithInterpolations("const b = `${`${g.map(h)}`} ${ {k: 1}.k }`;")).toContain("g.map(h)");
    expect(codeWithInterpolations('const c = "/text/"; /* /block/ */')).not.toContain("/");
  });

  it("imports R8's captured-intrinsic modules only, zod and operational-envelope.ts (its schema) only as types", () => {
    const imports = [...SOURCE.matchAll(/^import\s+(type\s+)?\{[^}]*\}\s+from\s+"([^"]+)";/gm)].map((m) => `${m[1] ? "type " : ""}${m[2]}`);
    expect(imports).toEqual(["type ./operational-envelope.js", "./safety-envelope.js", "./primordials.js"]);
    expect(SOURCE.match(/^import\b/gm)).toHaveLength(3);
  });

  it("bans, interpolations included: RegExp and regex literals, zod, Function.prototype calls, the in operator, destructuring and spread, and every ambient call R8 bans", () => {
    const code = codeWithInterpolations(SOURCE);
    const banned: Array<[RegExp, string]> = [
      [/\bRegExp\b/, "a RegExp"],
      [/\.(regex|test|exec|match|matchAll|search|compile|replace|split)\(/, "a regex method"],
      [/\//, "a slash: the module does no division, so it can only start a regex literal"],
      [/\bz\.|\.safeParse\(|\.parse\(|\bimport\(|\brequire\(/, "zod, or a dynamic import"],
      [/\.(call|apply|bind)\(/, "a call through Function.prototype"],
      [/\sin\s/, "the in operator, or for...in (both read the prototype chain)"],
      [/\b(const|let|var)\s*\[/, "array destructuring (the iterator protocol)"],
      [/\.\.\./, "spread or rest"],
      [/\.(map|filter|flatMap|forEach|some|every|includes|find|findIndex|indexOf|join|push|pop|shift|unshift|splice|sort|reverse|concat|entries|values|trim|toLowerCase|toUpperCase|slice|startsWith|endsWith|padStart|toString|update|digest|has|add|delete|get|set)\(/, "a method looked up at call time"],
      [/\bfor\s*\([^)]*\bof\b/, "for...of (the iterator protocol)"],
      [/\bnew\s+(Set|Map|WeakSet|WeakMap|Array|Uint8Array|TextEncoder)\b/, "an ambient constructor"],
      [/\b(JSON|Object|Array|Number|Math|Date|Reflect|Symbol|Promise|String)\s*\./, "a member of an ambient global"],
      [/\b(String|Number|Boolean)\s*\(/, "an ambient conversion function"],
      [/\binstanceof\b/, "instanceof"],
    ];
    const found: string[] = [];
    code.split("\n").forEach((line, n) => {
      for (const [pattern, what] of banned) if (pattern.test(line)) found.push(`${n + 1} ${what}: ${line.trim()}`);
    });
    expect(found).toEqual([]);
  });
});

describe("plain data, exactly R8's rules (gaps a mutation run found)", () => {
  const command = (labwareSlot: unknown) => checkRuntimeCommand(OT2, { name: "runProtocol", params: { minutes: 10, labwareSlot } }, stateFor(OT2));

  /** An object nested `levels` deep: {a: {a: ... {} }}. */
  function nest(levels: number): Record<string, unknown> {
    let value: Record<string, unknown> = {};
    for (let i = 1; i < levels; i++) value = { a: value };
    return value;
  }

  it("refuses a list whose prototype is not Array.prototype, in the command and in the envelope", () => {
    const odd = Object.setPrototypeOf([1], Object.create(Array.prototype)) as number[];
    expect(codeOf(command(odd))).toBe("command-malformed");
    expect(codeOf(command(Object.setPrototypeOf([1], null)))).toBe("command-malformed");
    expect(envelopeInvalid(changed(OT2, (e) => (e.hazards = Object.setPrototypeOf(["heat", "mechanical"], Object.create(Array.prototype)))))).toBe(true);
  });

  it("copies objects nested up to depth 64 and refuses one at depth 65", () => {
    // The command is depth 0, params 1, the value 2: nest(63) puts its innermost object at depth 64.
    expect(codeOf(command(nest(63)))).toBe("value-not-allowed");
    const deep = command(nest(64));
    expect(codeOf(deep)).toBe("command-malformed");
    if (!deep.allowed) expect(deep.reason).toMatch(/nested deeper than 64/);
  });

  it("names a cycle a cycle (the depth limit would refuse it too, with a less useful reason)", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const d = command(cycle);
    expect(codeOf(d)).toBe("command-malformed");
    if (!d.allowed) expect(d.reason).toMatch(/a cycle/);
  });

  it("with allowedItems alone, even an item never passes as a single value", () => {
    const itemsOnly = changed(PLATE, (e) => delete e.commands[1].params[2].unbounded.allowed);
    const read = (wells: unknown) => codeOf(checkRuntimeCommand(itemsOnly, { name: "read", params: { seconds: 30, wavelengthNm: 450, wells } }, stateFor(itemsOnly)));
    expect(read("A1")).toBe("value-not-allowed");
    expect(read(["A1"])).toBe("allowed");
  });
});

describe("astra pack 169: the scope of rule 1, one test per item, each refused as envelope-invalid", () => {
  /** Each change is refused by the structural check and by the schema; each control is accepted by both. */
  function refusesAll(base: OperationalEnvelopeV1, cases: Array<[string, (e: any) => void]>, controls: Array<[string, (e: any) => void]> = []) {
    for (const [label, mutate] of cases) {
      const bad = changed(base, mutate);
      expect(codeOf(checkRuntimeCommand(bad, STOP, stateFor(base))), label).toBe("envelope-invalid");
      expect(OperationalEnvelopeV1Schema.safeParse(bad).success, `schema: ${label}`).toBe(false);
    }
    for (const [label, mutate] of controls) {
      const ok = changed(base, mutate);
      expect(codeOf(checkRuntimeCommand(ok, STOP, stateFor(ok))), label).not.toBe("envelope-invalid");
      expect(OperationalEnvelopeV1Schema.safeParse(ok).success, `schema: ${label}`).toBe(true);
    }
  }

  it("a closed shape, envelopeVersion 1, strict true, non-blank deviceClass, deviceId and adapterType, and both digest forms", () => {
    const cases: Array<[string, (e: any) => void]> = [
      ["an extra key", (e) => (e.fallbackLimits = [])],
      ...["envelopeVersion", "envelopeDigest", "deviceClass", "deviceId", "adapterType", "adapterVersion", "strict", "limits", "commands", "deadlineQuantity", "maxCommandsPerMinute", "eStop", "supervision", "hazards"].map(
        (key): [string, (e: any) => void] => [`no ${key}`, (e) => delete e[key]],
      ),
      ["envelopeVersion 2", (e) => (e.envelopeVersion = 2)],
      ["envelopeVersion as a string", (e) => (e.envelopeVersion = "1")],
      ["strict false", (e) => (e.strict = false)],
      ["strict as a string", (e) => (e.strict = "true")],
      ["a blank deviceClass", (e) => (e.deviceClass = " ")],
      ["a blank deviceId", (e) => (e.deviceId = "")],
      ["a blank adapterType", (e) => (e.adapterType = String.fromCharCode(9))],
      ["envelopeDigest in uppercase", (e) => (e.envelopeDigest = `0x${"AB".repeat(32)}`)],
      ["envelopeDigest in the adapter's form", (e) => (e.envelopeDigest = OT2_MANIFEST)],
      ["adapterVersion in the envelope digest's form", (e) => (e.adapterVersion = `0x${"21".repeat(32)}`)],
      ["adapterVersion as a version string", (e) => (e.adapterVersion = "2.1.0")],
    ];
    refusesAll(OT2, cases);
  });

  it("a known device class: an own property of DEVICE_CLASS_TEMPLATES", () => {
    refusesAll(
      OT2,
      ["unknown-robot", "toString", "constructor", "__proto__", "hasOwnProperty", "valueOf", "LIQUID-HANDLER-OT2", "liquid-handler-ot2 "].map(
        (deviceClass): [string, (e: any) => void] => [deviceClass, (e) => (e.deviceClass = deviceClass)],
      ),
    );
  });

  it("exactly the template's limits, in order and unit, each a finite min <= max", () => {
    refusesAll(
      OT2,
      [
        ["reversed", (e) => e.limits.reverse()],
        ["two swapped", (e) => ([e.limits[0], e.limits[1]] = [e.limits[1], e.limits[0]])],
        ["one missing", (e) => e.limits.pop()],
        ["one extra", (e) => e.limits.push({ ...e.limits[3] })],
        ["another unit", (e) => (e.limits[2].unit = "degF")],
        ["another quantity's unit", (e) => (e.limits[0].unit = "min")],
        ["min above max", (e) => (e.limits[1].min = 301)],
        ["a numeric-string min", (e) => (e.limits[1].min = "1")],
        ["no max", (e) => delete e.limits[1].max],
        ["an extra key", (e) => (e.limits[1].default = 50)],
      ],
      [["min equal to max", (e) => (e.limits[1].min = 300)]],
    );
  });

  it("closed, unique commands and params: no duplicate command, no duplicate param in a command, no extra keys", () => {
    refusesAll(OT2, [
      ["a duplicate command", (e) => e.commands.push({ name: "aspirate", params: [] })],
      ["a duplicate param", (e) => e.commands[4].params.push({ name: "slot", unbounded: { reason: "again", allowed: [1] } })],
      ["an extra key on a command", (e) => (e.commands[0].description = "aspirate")],
      ["an extra key on a param", (e) => (e.commands[0].params[0].max = 300)],
      ["an extra key on an unbounded param", (e) => (e.commands[3].params[1].unbounded.pattern = ".*")],
      ["a command without params", (e) => delete e.commands[5].params],
      ["a command without a name", (e) => delete e.commands[0].name],
      ["a param without a name", (e) => delete e.commands[0].params[0].name],
    ]);
  });

  it("each param either sets a quantity or is unbounded with a finite typed allowlist", () => {
    const unbounded = (u: unknown) => (e: any) => (e.commands[3].params[1].unbounded = u);
    refusesAll(
      OT2,
      [
        ["both", (e) => (e.commands[0].params[0].unbounded = { reason: "r", allowed: [1] })],
        ["neither", (e) => (e.commands[0].params[0] = { name: "volumeUl" })],
        ["a quantity without its unit", (e) => delete e.commands[0].params[0].unit],
        ["a unit without its quantity", (e) => delete e.commands[0].params[0].quantity],
        ["no allowed and no allowedItems", unbounded({ reason: "a deck position" })],
        ["an empty allowed", unbounded({ reason: "r", allowed: [] })],
        ["a duplicated allowed value", unbounded({ reason: "r", allowed: [1, 2, 1] })],
        ["a blank allowed value", unbounded({ reason: "r", allowed: ["  "] })],
        ["a boolean allowed value", unbounded({ reason: "r", allowed: [true] })],
        ["an object allowed value", unbounded({ reason: "r", allowed: [{ slot: 1 }] })],
        ["a null allowed value", unbounded({ reason: "r", allowed: [null] })],
        ["an empty allowedItems", unbounded({ reason: "r", allowedItems: [] })],
        ["a duplicated allowedItems value", unbounded({ reason: "r", allowedItems: ["A1", "A1"] })],
        ["a blank reason", unbounded({ reason: " ", allowed: [1] })],
        ["a free-form string", unbounded("any slot")],
      ],
      [
        ["allowed and allowedItems", unbounded({ reason: "r", allowed: [1], allowedItems: [2, 3] })],
        ["allowedItems alone", unbounded({ reason: "r", allowedItems: ["A1"] })],
        ["mixed strings and numbers", unbounded({ reason: "r", allowed: [1, "1"] })],
      ],
    );
  });

  it("the e-stop: an adapter stop naming a declared command, or hardware, or none only for a template that neither moves nor heats", () => {
    const cases: Array<[string, (e: any) => void]> = [
      ["an adapter stop naming an undeclared command", (e) => (e.eStop.stopCommand = "halt")],
      ["an adapter stop without its command", (e) => delete e.eStop.stopCommand],
      ["an adapter stop with a blank command", (e) => (e.eStop.stopCommand = " ")],
      ["hardware with a command", (e) => (e.eStop = { mechanism: "hardware", stopCommand: "stop" })],
      ["none, on a device that moves or heats", (e) => (e.eStop = { mechanism: "none" })],
      ["an unknown mechanism", (e) => (e.eStop = { mechanism: "software" })],
      ["no mechanism", (e) => (e.eStop = { stopCommand: "stop" })],
    ];
    refusesAll(OT2, cases, [["hardware", (e) => (e.eStop = { mechanism: "hardware" })]]);
    refusesAll(PLATE, [["none, on the plate reader (it heats)", (e) => (e.eStop = { mechanism: "none" })]], [["an adapter stop naming its stop command", (e) => (e.eStop = { mechanism: "adapter-stop", stopCommand: "stop" })]]);
  });

  it("a positive integer command rate", () => {
    refusesAll(
      OT2,
      [0, -1, 1.5, 0.5, "60", true, null, [60]].map((rate): [string, (e: any) => void] => [JSON.stringify(rate), (e) => (e.maxCommandsPerMinute = rate)]),
      [["1", (e) => (e.maxCommandsPerMinute = 1)]],
    );
  });

  it("canonical hazards (known, distinct, in HAZARDS order) and the supervision policy", () => {
    refusesAll(
      OT2,
      [
        ["an unknown hazard", (e) => (e.hazards = ["heat", "radiation"])],
        ["a duplicated hazard", (e) => (e.hazards = ["heat", "heat", "mechanical"])],
        ["hazards out of order", (e) => (e.hazards = ["mechanical", "heat"])],
        ["hazards not a list", (e) => (e.hazards = null)],
        ["an unknown supervision", (e) => (e.supervision = "occasional")],
        ["unattended, on a device that moves or heats", (e) => (e.supervision = "unattended")],
        ["remote supervision with a hardware stop", (e) => {
          e.supervision = "remote-supervised";
          e.eStop = { mechanism: "hardware" };
        }],
      ],
      [
        ["no hazards (the operator's none)", (e) => (e.hazards = [])],
        ["remote supervision with an adapter stop", (e) => (e.supervision = "remote-supervised")],
      ],
    );
  });

  it("the template's deadline: deadlineQuantity is the template's, naming an included limit in a time unit", () => {
    refusesAll(OT2, [
      ["another quantity", (e) => (e.deadlineQuantity = "aspirate_volume")],
      ["the plate reader's deadline", (e) => (e.deadlineQuantity = "job_duration")],
      ["blank", (e) => (e.deadlineQuantity = " ")],
      // The deadline limit's unit is the template's own (min); another time unit is refused by the limits rule first.
      ["the deadline limit in hours", (e) => (e.limits[3].unit = "h")],
      ["the deadline limit dropped", (e) => e.limits.pop()],
    ]);
  });
});

describe("a setter on Array.prototype indices never runs (copies define own properties; they never assign)", () => {
  it("with setters on Array.prototype[0] and [1] that would substitute a wide limit, every decision is unchanged and no setter runs", () => {
    // R8's operational-envelope test: an assignment to a fresh array's index runs a setter Array.prototype serves for it.
    // The result array is dense before the setters go in, so this test's own writes never reach them.
    const out: RuntimeDecision[] = ALL.map(() => ({ allowed: true }));
    let ran = 0;
    const substitute = (index: string) => ({
      configurable: true,
      set(this: unknown[], _value: unknown) {
        ran++;
        Object.defineProperty(this, index, { value: { quantity: "aspirate_volume", unit: "uL", min: -1e12, max: 1e12 }, writable: true, enumerable: true, configurable: true });
      },
    });
    try {
      Object.defineProperty(Array.prototype, "0", substitute("0"));
      Object.defineProperty(Array.prototype, "1", substitute("1"));
      for (let i = 0; i < ALL.length; i++) out[i] = checkRuntimeCommand(ALL[i]!.envelope, ALL[i]!.command, ALL[i]!.state);
    } finally {
      delete (Array.prototype as unknown as Record<string, unknown>)["0"];
      delete (Array.prototype as unknown as Record<string, unknown>)["1"];
    }
    expect(ran).toBe(0);
    expect(JSON.stringify(out)).toBe(CLEAN_DECISIONS);
  });
});

describe("the plain copy names what it refused (each refusal is its own check, not a later accident)", () => {
  it("refuses each kind of non-plain data in a command with its own reason, running no code supplied with it", () => {
    let ran = 0;
    const getter = (target: object, key: string) => Object.defineProperty(target, key, { enumerable: true, configurable: true, get: () => (ran++, "A1") });
    const counting: ProxyHandler<object> = new Proxy({}, { get: () => (ran++, undefined) });
    const wells = (value: unknown) => ({ name: "read", params: { seconds: 30, wavelengthNm: 450, wells: value } });
    const cases: Array<[string, unknown, RegExp]> = [
      ["a proxy", wells(new Proxy(["A1"], counting)), /wells: a proxy/],
      ["an accessor on an object member", { name: "read", params: getter({ seconds: 30, wavelengthNm: 450 }, "wells") }, /params\.wells: an accessor/],
      ["an accessor on a list element", wells(getter(["A1"], "0")), /wells\[0\]: an accessor/],
      ["a hole", wells([, "A1"]), /wells\[0\]: a hole in an array/], // eslint-disable-line no-sparse-arrays
      ["undefined in a list", wells([undefined]), /wells\[0\]: undefined in an array/],
      ["NaN", wells(Number.NaN), /wells: NaN is not a finite number/],
      ["a function", wells(() => "A1"), /wells: a function is not JSON data/],
      ["a list with another prototype", wells(Object.setPrototypeOf(["A1"], Object.create(Array.prototype))), /wells: an array with a nonstandard prototype/],
      ["a class instance", wells(new Date(0)), /wells: not a plain object/],
      ["a key named __proto__", wells(JSON.parse('{"__proto__": ["A1"]}')), /wells: a key named __proto__/],
    ];
    for (const [label, command, reason] of cases) {
      const d = checkRuntimeCommand(PLATE, command, stateFor(PLATE));
      expect(codeOf(d), label).toBe("command-malformed");
      if (!d.allowed) expect(d.reason, label).toMatch(reason);
    }
    expect(ran).toBe(0);
  });
});
