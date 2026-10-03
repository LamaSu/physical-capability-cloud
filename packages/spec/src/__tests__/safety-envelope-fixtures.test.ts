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

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileOperationalEnvelope, OperationalEnvelopeV1Schema } from "../onboarding/operational-envelope.js";
import {
  computeSafetyEnvelopeDigest,
  confirmSafetyEnvelope,
  draftSafetyEnvelope,
  SAFETY_ENVELOPE_DOMAIN,
  type SafetyEnvelopeInput,
} from "../onboarding/safety-envelope.js";
import { canonicalize } from "../util/canonical.js";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/onboarding/safety-envelope-v1.json");
const AT = "2026-09-29T20:00:00Z";

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

const PLATE_MAP = {
  commands: [
    { name: "setIncubation", params: [{ name: "celsius", quantity: "incubation_temperature", unit: "degC" }] },
    { name: "read", params: [{ name: "seconds", quantity: "read_duration", unit: "s" }] },
    { name: "runProtocol", params: [{ name: "minutes", quantity: "job_duration", unit: "min" }] },
    { name: "stop", params: [] },
  ],
};

const INPUTS: Record<string, SafetyEnvelopeInput> = {
  "ot2-operator-answers": {
    deviceClass: "liquid-handler-ot2",
    device: { deviceId: "ot2-sim-1", adapterType: "opentrons", adapterVersion: "2.1.0", vendor: "Opentrons", model: "OT-2" },
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
    device: { deviceId: "pr-sim-1", adapterType: "generic-http", adapterVersion: "1.0.0" },
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
};

type Change = (e: Record<string, any>) => void;

/** Each is refused by OperationalEnvelopeV1Schema; `paths` are the issue paths a validator should report. */
const INVALID: Array<[string, Change]> = [
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
];

function issuePaths(value: unknown): string[] {
  const r = OperationalEnvelopeV1Schema.safeParse(value);
  return r.success ? [] : [...new Set(r.error.issues.map((i) => i.path.join(".")))].sort();
}

function buildFixtures() {
  const confirmed = Object.entries(INPUTS).map(([name, input]) => {
    const draft = draftSafetyEnvelope(input);
    const c = confirmSafetyEnvelope(draft, { confirmedBy: "operator:fixture", confirmedAt: AT });
    return { name, confirmed: c, runtime: compileOperationalEnvelope(c, c.envelopeDigest) };
  });
  const ot2 = confirmed[0]!.runtime;
  return {
    _comment: [
      "GENERATED by packages/spec/src/__tests__/safety-envelope-fixtures.test.ts from the TS reference; do not edit by hand.",
      "Regenerate: PCC_UPDATE_FIXTURES=1 npx vitest run src/__tests__/safety-envelope-fixtures.test.ts (in packages/spec).",
      "digest: envelopeDigest = '0x' + lowercase hex(sha256(UTF-8(preimage))), preimage = canonicalize({domain, envelope}) with the confirmed SafetyEnvelopeBody as envelope and packages/spec/src/util/canonical.ts as canonicalize (keys sorted, no whitespace, strings as JSON.stringify, numbers as JS Number#toString).",
      "operationalEnvelopeV1: a validator must accept every 'valid' envelope and refuse every 'invalid' one; 'paths' are the issue paths the TS schema reports. NaN and Infinity cannot appear in JSON, so they are not here; a JSON consumer never sees them.",
      "114b: the schema now refuses an unknown deviceClass outright (see 'unknown-class-generic-rules-only', moved here from 'valid'), limits must be in the template's exact order and units, an adapter-stop's command must be one of the declared commands, and deadlineQuantity must be the template's own deadline.",
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
    operationalEnvelopeV1: {
      valid: confirmed.map(({ name, runtime }) => ({ name, envelope: runtime })),
      invalid: INVALID.map(([name, change]) => {
        const envelope = structuredClone(ot2) as unknown as Record<string, any>;
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
