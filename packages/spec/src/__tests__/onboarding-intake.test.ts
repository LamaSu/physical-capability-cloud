import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INTAKE_FIELDS,
  INTAKE_FIELD_IDS,
  INTAKE_GROUPS,
  INTAKE_FIELD_CLASSES,
  INTAKE_MILESTONES,
  INTAKE_FORBIDDEN_KEYS,
  MILESTONE_IMPLIES,
  buildIntakeJsonSchema,
  zodToJsonSchemaFragment,
  INTAKE_JSON_SCHEMA_COMMENT,
  buildFormHtml,
  IntakeAnswerSchema,
  IntakeRecordSchema,
  validateIntake,
  executionModeTierCap,
  NO_EXECUTION_MODE_CAP,
  intakeFieldArtifactMap,
  scanIntakeStrings,
  redactIntakeSecrets,
  INTAKE_SECRET_KINDS,
  CONFIRMATION_REQUIRED_FIELDS,
  ESTOP_NONE_APPROVED_CAPABILITIES,
  intakeValueHash,
  type IntakeAnswer,
  type IntakeAuthority,
  type IntakeConfirmationEvent,
  type IntakeRecord,
  type IntakeSecretKind,
} from "../onboarding/intake/index.js";
import { BIP39_ENGLISH_WORDLIST } from "../onboarding/intake/bip39-english.js";
import { TIER_SUBSTANCE_RULE_FIELDS } from "../onboarding/intake/tier-readiness.js";
import { getPrimitive } from "../evidence/primitives.js";
import { canonicalize } from "../util/canonical.js";
import { CsdRegistry, loadBuiltinCsds } from "../csd/registry.js";
import { CsdSchema, type CSD } from "../csd/schema.js";
import printAndMailCsd from "../csds/document-print-and-mail.csd.json" with { type: "json" };
import {
  RESEARCH_LIBRARY,
  ResearchFindingSchema,
  entryInstructsExecution,
} from "../onboarding/research/index.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SPEC_ROOT = join(TEST_DIR, "..", "..");
const REPO_ROOT = join(SPEC_ROOT, "..", "..");

// ── 1. Registry integrity ────────────────────────────────────────────────

describe("INTAKE_FIELDS — registry integrity", () => {
  it("has 42 fields, all with unique ids", () => {
    expect(INTAKE_FIELDS).toHaveLength(42);
    const ids = INTAKE_FIELDS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Golden/pinned snapshot: a field-id rename, add, or remove changes this
  // list, and this test fails LOUDLY rather than silently.
  it("INTAKE_FIELD_IDS matches the pinned golden list", () => {
    const GOLDEN_FIELD_IDS = [
      "availability.schedule",
      "calibration.lastDate",
      "calibration.procedureRef",
      "capability.parameters",
      "capability.type",
      "consumables.items",
      "consumables.loadedMaterial",
      "consumables.restockedBy",
      "device.adapterType",
      "device.description",
      "device.firmware",
      "device.model",
      "device.serialNumber",
      "device.vendor",
      "evidence.approver",
      "evidence.camera",
      "evidence.controllerRunLog",
      "evidence.executionMode",
      "evidence.executorDeviceId",
      "evidence.instrumentSignsOutput",
      "evidence.observerDeviceIds",
      "evidence.operatorPresence",
      "evidence.referenceSample",
      "location.cityCountry",
      "location.streetAddress",
      "network.inboundBlocked",
      "network.outboundHttps",
      "network.reachability",
      "operator.authority",
      "operator.contactEmail",
      "operator.displayName",
      "payout.destination",
      "pricing.currency",
      "pricing.minimum",
      "pricing.unitPrice",
      "safety.commandRate",
      "safety.estop",
      "safety.hazards",
      "safety.limits",
      "safety.supervision",
      "sla.acceptanceWindowSec",
      "sla.completionDeadlineSec",
    ];
    expect([...INTAKE_FIELD_IDS]).toEqual(GOLDEN_FIELD_IDS);
    expect(Object.isFrozen(INTAKE_FIELD_IDS)).toBe(true);
  });

  it("every field has a well-formed class/group/requiredFor, fills, question, and why", () => {
    for (const field of INTAKE_FIELDS) {
      expect(INTAKE_FIELD_CLASSES).toContain(field.class);
      expect(INTAKE_GROUPS).toContain(field.group);
      expect(field.requiredFor.length).toBeGreaterThan(0);
      for (const milestone of field.requiredFor) {
        expect(INTAKE_MILESTONES).toContain(milestone);
      }
      expect(field.fills.length).toBeGreaterThan(0);
      expect(field.question.length).toBeGreaterThan(0);
      expect(field.why.length).toBeGreaterThan(0);
    }
  });

  it("every field id's dotted prefix names its own domain (identity's fields use \"operator.\", per the spec table)", () => {
    for (const field of INTAKE_FIELDS) {
      const prefix = field.id.split(".")[0];
      const expectedPrefix = field.group === "identity" ? "operator" : field.group;
      expect(prefix).toBe(expectedPrefix);
    }
  });

  it("every money/safety field — and only those — is neverDefault", () => {
    // R2 rule 4 + the base table's own "Default: never" column (a superset of
    // the addendum's shorthand list; see fields.ts header for why hazards and
    // operator.authority are included).
    const GOLDEN_NEVER_DEFAULT = new Set([
      "operator.authority",
      "safety.supervision",
      "safety.estop",
      "safety.hazards",
      "safety.limits",
      "safety.commandRate",
      "pricing.unitPrice",
      "pricing.minimum",
      "pricing.currency",
      "payout.destination",
    ]);
    const actual = new Set(INTAKE_FIELDS.filter((f) => f.neverDefault).map((f) => f.id));
    expect(actual).toEqual(GOLDEN_NEVER_DEFAULT);
    // Descriptive form of the same rule: every field in the safety/pricing/payout
    // groups is neverDefault (hazards/limits/estop/supervision, all 3 pricing
    // fields, and payout.destination all land here structurally).
    for (const field of INTAKE_FIELDS) {
      if (field.group === "pricing" || field.group === "payout") {
        expect(field.neverDefault).toBe(true);
      }
    }
  });

  it("exactly the two sensitive fields are payout.destination and location.streetAddress", () => {
    const sensitiveIds = INTAKE_FIELDS.filter((f) => f.sensitive).map((f) => f.id).sort();
    expect(sensitiveIds).toEqual(["location.streetAddress", "payout.destination"]);
    for (const field of INTAKE_FIELDS.filter((f) => f.sensitive)) {
      expect(field.valueSchema.safeParse({ set: true }).success).toBe(true);
      expect(field.valueSchema.safeParse({ set: false }).success).toBe(false);
      expect(field.valueSchema.safeParse({ set: true, extra: "x" }).success).toBe(false);
      expect(field.valueSchema.safeParse("the-real-secret-value").success).toBe(false);
    }
  });

  it("exactly the two calibration fields are selfDeclaredOnly and map to decl.self_attested", () => {
    const selfDeclaredIds = INTAKE_FIELDS.filter((f) => f.selfDeclaredOnly).map((f) => f.id).sort();
    expect(selfDeclaredIds).toEqual(["calibration.lastDate", "calibration.procedureRef"]);
    for (const field of INTAKE_FIELDS.filter((f) => f.selfDeclaredOnly)) {
      expect(field.evidencePrimitive?.id).toBe("decl.self_attested");
    }
  });

  it("R8's permanent safety-relevant field ids all exist (sensors addendum, final and permanent)", () => {
    const R8_IDS = [
      "safety.supervision",
      "safety.estop",
      "safety.hazards",
      "safety.limits",
      "safety.commandRate",
      "consumables.items",
      "consumables.restockedBy",
      "consumables.loadedMaterial",
      "calibration.lastDate",
      "calibration.procedureRef",
      "evidence.referenceSample",
    ];
    for (const id of R8_IDS) {
      expect(INTAKE_FIELD_IDS).toContain(id);
    }
  });

  it("every evidencePrimitive id exists in EVIDENCE_PRIMITIVES with the stated (verifier) status", () => {
    const fieldsWithPrimitive = INTAKE_FIELDS.filter((f) => f.evidencePrimitive);
    expect(fieldsWithPrimitive.length).toBeGreaterThan(0);
    for (const field of fieldsWithPrimitive) {
      const ref = field.evidencePrimitive!;
      const def = getPrimitive(ref.id);
      expect(def, `${field.id} references unknown primitive "${ref.id}"`).toBeDefined();
      expect(def!.status).toBe("active");
      expect(def!.verifierStatus).toBe(ref.status);
    }
  });

  it("INTAKE_FORBIDDEN_KEYS covers every named forbidden concept from the addendum", () => {
    expect([...INTAKE_FORBIDDEN_KEYS].sort()).toEqual(
      [
        "assuranceTier",
        "deviceKeyBinding",
        "digest",
        "eventTime",
        "freshness",
        "hash",
        "inspectionIndependence",
        "jobCompletion",
        "jobSuccess",
        "privateKey",
        "verificationResult",
        "verified",
      ].sort(),
    );
    // None of these are ever themselves a real intake field id.
    for (const key of INTAKE_FORBIDDEN_KEYS) {
      expect(INTAKE_FIELD_IDS.includes(key)).toBe(false);
    }
  });

  it("location.cityCountry's question says plainly that the answer may be shown publicly", () => {
    const field = INTAKE_FIELDS.find((f) => f.id === "location.cityCountry")!;
    expect(field.question.toLowerCase()).toContain("public");
  });

  it("safety.supervision and safety.estop are required at both publish and accept-jobs (review fix), and stay neverDefault", () => {
    const supervision = INTAKE_FIELDS.find((f) => f.id === "safety.supervision")!;
    const estop = INTAKE_FIELDS.find((f) => f.id === "safety.estop")!;
    for (const field of [supervision, estop]) {
      expect([...field.requiredFor].sort()).toEqual(["accept-jobs", "publish"]);
      expect(field.neverDefault).toBe(true);
      // Never "register": that comes before any device is even described.
      expect(field.requiredFor).not.toContain("register");
    }
  });
});

// ── 1b. MILESTONE_IMPLIES — the cumulative-readiness closure (review fix) ─

describe("MILESTONE_IMPLIES — milestone implication closure", () => {
  it("chains the onboarding ladder, the evidence ladder, and the two named cross-links", () => {
    expect([...MILESTONE_IMPLIES.register].sort()).toEqual(["register"]);
    expect([...MILESTONE_IMPLIES.identify].sort()).toEqual(["identify", "register"]);
    expect([...MILESTONE_IMPLIES["register-device"]].sort()).toEqual(["identify", "register", "register-device"]);
    expect([...MILESTONE_IMPLIES.publish].sort()).toEqual(["identify", "publish", "register", "register-device"]);
    expect([...MILESTONE_IMPLIES["accept-jobs"]].sort()).toEqual(
      ["accept-jobs", "identify", "publish", "register", "register-device"].sort(),
    );
    expect([...MILESTONE_IMPLIES.tier1].sort()).toEqual(["identify", "register", "register-device", "tier1"].sort());
    expect([...MILESTONE_IMPLIES.tier2].sort()).toEqual(
      ["identify", "register", "register-device", "tier1", "tier2"].sort(),
    );
    expect([...MILESTONE_IMPLIES["get-paid"]].sort()).toEqual(
      ["get-paid", "identify", "publish", "register", "register-device"].sort(),
    );
    // "optional" implies nothing, and nothing implies it.
    expect([...MILESTONE_IMPLIES.optional]).toEqual(["optional"]);
    for (const milestone of INTAKE_MILESTONES) {
      if (milestone === "optional") continue;
      expect(MILESTONE_IMPLIES[milestone]).not.toContain("optional");
    }
  });
});

// ── 2. IntakeAnswerSchema — provenance + source (R2 rule 6) ─────────────

describe("IntakeAnswerSchema — rule 6 (provenance + source)", () => {
  it("accepts human/probe provenance without a source", () => {
    expect(IntakeAnswerSchema.safeParse({ value: "x", provenance: "human" }).success).toBe(true);
    expect(IntakeAnswerSchema.safeParse({ value: "x", provenance: "probe" }).success).toBe(true);
  });

  it("requires a source for research/confirmed provenance", () => {
    expect(IntakeAnswerSchema.safeParse({ value: "x", provenance: "research" }).success).toBe(false);
    expect(IntakeAnswerSchema.safeParse({ value: "x", provenance: "confirmed" }).success).toBe(false);
    expect(
      IntakeAnswerSchema.safeParse({
        value: "x",
        provenance: "research",
        source: { doc: "manual" },
      }).success,
    ).toBe(true);
    expect(
      IntakeAnswerSchema.safeParse({
        value: "x",
        provenance: "confirmed",
        source: { doc: "manual", url: "https://example.com/manual.pdf" },
      }).success,
    ).toBe(true);
  });
});

describe("IntakeSourceSchema — the same source rules as a research citation", () => {
  const accepts = (source: unknown) =>
    IntakeAnswerSchema.safeParse({ value: "x", provenance: "confirmed", source }).success;

  it("refuses a blank doc or section and an http, credentialed or non-URL url", () => {
    expect(accepts({ doc: "manual", section: "5.2", url: "https://example.com/m.pdf" })).toBe(true);
    expect(accepts({ doc: "  manual  " })).toBe(true); // not trimmed, not refused
    for (const bad of [
      { doc: " " },
      { doc: "" },
      { doc: "manual", section: "\t" },
      { doc: "manual", url: "http://example.com/m.pdf" },
      { doc: "manual", url: "javascript:alert(1)" },
      { doc: "manual", url: "https://u:p@example.com/m.pdf" },
      { doc: "manual", url: "not a url" },
    ]) {
      expect(accepts(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("does not change the source it accepts", () => {
    const parsed = IntakeAnswerSchema.parse({
      value: "x",
      provenance: "research",
      source: { doc: "  manual  ", section: " 5.2 " },
    });
    expect(parsed.source).toEqual({ doc: "  manual  ", section: " 5.2 " });
  });
});

// ── 3. validateIntake — a fully-answered baseline record ─────────────────

function human(value: unknown): IntakeAnswer {
  return { value, provenance: "human" };
}
function probed(value: unknown): IntakeAnswer {
  return { value, provenance: "probe" };
}
function confirmed(value: unknown): IntakeAnswer {
  return { value, provenance: "confirmed", source: { doc: "manual", section: "specs" } };
}

/** One legitimately-answered value per field, matching its valueSchema exactly. */
function buildFullValidRecord(): IntakeRecord {
  const answers: Record<string, IntakeAnswer> = {
    "operator.displayName": human("Acme Print Shop"),
    "operator.contactEmail": human("ops@example.com"),
    "operator.authority": human(true),
    "device.description": human("A desktop FDM 3D printer for PLA/PETG prototypes."),
    "device.vendor": probed("Prusa"),
    "device.model": probed("MK4S"),
    "device.serialNumber": human("SN-001"),
    "device.firmware": probed("6.0.0"),
    "device.adapterType": probed("octoprint"),
    "location.cityCountry": human({ city: "Austin", country: "US" }),
    "location.streetAddress": human({ set: true }),
    "network.reachability": human({ sameLan: true, staticIp: false }),
    "network.outboundHttps": human(true),
    "network.inboundBlocked": human(true),
    "safety.supervision": human("attended"),
    "safety.estop": human({ mechanism: "hardware" }),
    "safety.hazards": human(["heat"]),
    "safety.commandRate": human(60),
    // Bound to capability.type's CSD (fdm/v2): infill is its number parameter with a unit (%, 5-100).
    "safety.limits": confirmed([{ quantity: "infill", unit: "%", min: 10, max: 90 }]),
    "consumables.items": human(["PLA filament"]),
    "consumables.restockedBy": human("operator, monthly"),
    "consumables.loadedMaterial": human("PLA"),
    "calibration.lastDate": human("2026-01-15"),
    "calibration.procedureRef": confirmed("Prusa bed-leveling procedure v2"),
    "evidence.executorDeviceId": human("dev-1"),
    "evidence.observerDeviceIds": human(["cam-1"]),
    "evidence.executionMode": probed("real"),
    "evidence.camera": human({ seesWorkArea: true, seesOutput: true, mount: "fixed", captureDeviceId: "cam-1" }),
    "evidence.operatorPresence": human("sometimes"),
    "evidence.approver": human({ name: "A. Approver" }),
    "evidence.controllerRunLog": human({ exportsOwnLogPerJob: true, access: "api" }),
    "evidence.instrumentSignsOutput": human(true),
    "evidence.referenceSample": human({ available: true, expectedResultRef: "cube-20mm" }),
    "capability.type": probed("pcc://capabilities/fdm/v2"),
    "capability.parameters": confirmed([{ key: "infill", min: 0, max: 100, unit: "%" }]),
    "pricing.unitPrice": human("5.00"),
    "pricing.minimum": human("2.00"),
    "pricing.currency": human("USD"),
    "payout.destination": human({ set: true }),
    "availability.schedule": human({ mode: "always", timezone: "America/Chicago" }),
    "sla.acceptanceWindowSec": human(3600),
    "sla.completionDeadlineSec": human(86400),
  };
  // Every confirmation-required answer carries a pointer to its confirmation event.
  for (const fieldId of CONFIRMATION_REQUIRED_FIELDS) {
    answers[fieldId] = { ...answers[fieldId]!, confirmation: { eventId: `evt-${fieldId}` } };
  }
  return { schema: "pcc.device-intake.v1", answers };
}

function cloneRecord(record: IntakeRecord): IntakeRecord {
  return { schema: record.schema, answers: { ...record.answers } };
}

/** The authenticated confirmation event a store would hold for `answer`. */
function confirmationEvent(
  fieldId: string,
  answer: IntakeAnswer,
  overrides: Partial<IntakeConfirmationEvent> = {},
): IntakeConfirmationEvent {
  return {
    schema: "pcc.intake-confirmation.v1",
    eventId: answer.confirmation!.eventId,
    fieldId,
    valueHash: intakeValueHash(answer.value),
    ...(answer.source ? { sourceHash: intakeValueHash(answer.source) } : {}),
    confirmedBy: { principal: "operator:acme", authMethod: "siwe" },
    subject: { deviceRef: "dev-1", projectRef: "proj-1" },
    sequence: 1,
    confirmedAt: "2026-09-30T12:00:00Z",
    challenge: "challenge-1",
    supersededBy: null,
    revoked: false,
    ...overrides,
  };
}

interface StubAuthorityOptions {
  /** What the payout store says (default: a destination exists). */
  payout?: boolean;
  /** Edit the events after they are derived from the record. */
  events?: (events: Map<string, IntakeConfirmationEvent>) => void;
}

/** A Map-backed authority holding exactly the events the record's confirmation refs name. */
function makeAuthority(record: IntakeRecord, options: StubAuthorityOptions = {}): IntakeAuthority {
  const events = new Map<string, IntakeConfirmationEvent>();
  for (const [fieldId, answer] of Object.entries(record.answers)) {
    if (answer.confirmation) events.set(answer.confirmation.eventId, confirmationEvent(fieldId, answer));
  }
  options.events?.(events);
  return {
    resolveConfirmation: (eventId) => events.get(eventId) ?? null,
    payoutDestinationExists: () => options.payout ?? true,
  };
}

/** validateIntake with a stub authority built from the record itself. */
function ready(record: IntakeRecord, milestone: (typeof INTAKE_MILESTONES)[number], options?: StubAuthorityOptions) {
  return validateIntake(record, milestone, makeAuthority(record, options));
}

describe("validateIntake — a fully and correctly answered record", () => {
  const full = buildFullValidRecord();

  it("answers every field with a value matching its own schema", () => {
    for (const field of INTAKE_FIELDS) {
      const answer = full.answers[field.id];
      expect(answer, `missing baseline answer for ${field.id}`).toBeDefined();
      expect(field.valueSchema.safeParse(answer.value).success, `${field.id} value fails its schema`).toBe(true);
    }
  });

  it("parses as a valid IntakeRecord", () => {
    expect(IntakeRecordSchema.safeParse(full).success).toBe(true);
  });

  it("is `ok` for every milestone except the tiers when its confirmation events resolve and a payout destination exists", () => {
    // The tiers are checked in "validateIntake — tier readiness fails closed": with the shipped
    // evidence registry their primitives are stubs, so they are NOT ready.
    for (const milestone of INTAKE_MILESTONES) {
      if (milestone === "tier1" || milestone === "tier2") continue;
      const report = ready(full, milestone);
      expect(report, `${milestone}: ${JSON.stringify(report)}`).toMatchObject({
        ok: true,
        missing: [],
        neverDefaultViolations: [],
        forbiddenKeys: [],
        sensitiveViolations: [],
        unknownFields: [],
        secretsInText: [],
        structuralErrors: [],
        invalidFields: [],
        unconfirmed: [],
        unverified: [],
        limitErrors: [],
        safetyBlocks: [],
        stubPrimitives: [],
        insubstantial: [],
      });
    }
  });

  it("publish directly requires exactly the expected 8 fields (review fix: safety.estop/supervision now gate publish too)", () => {
    const publishFields = INTAKE_FIELDS.filter((f) => f.requiredFor.includes("publish")).map((f) => f.id).sort();
    expect(publishFields).toEqual(
      [
        "capability.parameters",
        "capability.type",
        "location.cityCountry",
        "pricing.currency",
        "pricing.minimum",
        "pricing.unitPrice",
        "safety.estop",
        "safety.supervision",
      ].sort(),
    );
  });
});

// ── 3b. validateIntake — cumulative milestone readiness (review fix) ─────
// Readiness for a later milestone in a chain also requires every field of
// the milestones it implies (MILESTONE_IMPLIES) — a record can never be
// "ready" for a later milestone while missing an earlier one's fields.

describe("validateIntake — cumulative milestone readiness (review fix)", () => {
  it("a record missing a publish-level field (pricing) is NOT ok for accept-jobs", () => {
    const record = cloneRecord(buildFullValidRecord());
    delete record.answers["pricing.unitPrice"];

    const publishReport = validateIntake(record, "publish");
    expect(publishReport.ok).toBe(false);
    expect(publishReport.missing).toContain("pricing.unitPrice");

    const acceptJobsReport = validateIntake(record, "accept-jobs");
    expect(acceptJobsReport.ok).toBe(false);
    expect(acceptJobsReport.missing).toContain("pricing.unitPrice");
  });

  it("register-device readiness also requires identify and register fields", () => {
    const record = cloneRecord(buildFullValidRecord());
    delete record.answers["device.description"]; // required for "identify"
    delete record.answers["operator.displayName"]; // required for "register"

    const report = validateIntake(record, "register-device");
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(expect.arrayContaining(["device.description", "operator.displayName"]));
  });

  it("get-paid readiness also requires publish fields", () => {
    const record = cloneRecord(buildFullValidRecord());
    delete record.answers["capability.type"]; // required for "publish"

    const report = validateIntake(record, "get-paid");
    expect(report.ok).toBe(false);
    expect(report.missing).toContain("capability.type");
  });

  it("a tier2 check also requires tier1 fields (and, transitively, register-device)", () => {
    const record = cloneRecord(buildFullValidRecord());
    delete record.answers["evidence.executorDeviceId"]; // required for "tier1"
    delete record.answers["device.vendor"]; // required for "register-device"

    const tier1Report = validateIntake(record, "tier1");
    expect(tier1Report.ok).toBe(false);
    expect(tier1Report.missing).toEqual(expect.arrayContaining(["evidence.executorDeviceId", "device.vendor"]));

    const tier2Report = validateIntake(record, "tier2");
    expect(tier2Report.ok).toBe(false);
    expect(tier2Report.missing).toEqual(expect.arrayContaining(["evidence.executorDeviceId", "device.vendor"]));
  });

  it("an optional field is never missing for any other milestone, only for 'optional' itself", () => {
    const record = cloneRecord(buildFullValidRecord());
    delete record.answers["sla.acceptanceWindowSec"]; // requiredFor: ["optional"]

    for (const milestone of INTAKE_MILESTONES) {
      if (milestone === "optional") continue;
      const report = validateIntake(record, milestone);
      expect(report.missing).not.toContain("sla.acceptanceWindowSec");
    }
    expect(validateIntake(record, "optional").missing).toContain("sla.acceptanceWindowSec");
  });

  it("a device cannot be ready for publish without safety.supervision and safety.estop answered (review fix)", () => {
    const record = cloneRecord(buildFullValidRecord());
    delete record.answers["safety.supervision"];
    delete record.answers["safety.estop"];

    const report = validateIntake(record, "publish");
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(expect.arrayContaining(["safety.supervision", "safety.estop"]));
  });
});

// ── 4. R2 rule 4 — never-defaulted fields ────────────────────────────────

describe("validateIntake — rule 4 (never-defaulted)", () => {
  it("blocks the milestone when a neverDefault field's answer is entirely absent", () => {
    const record = cloneRecord(buildFullValidRecord());
    delete record.answers["safety.supervision"];
    const report = validateIntake(record, "accept-jobs");
    expect(report.ok).toBe(false);
    expect(report.missing).toContain("safety.supervision");
  });

  it("blocks the milestone when a neverDefault field's provenance is an unconfirmed probe", () => {
    const record = cloneRecord(buildFullValidRecord());
    record.answers["safety.supervision"] = probed("attended");
    const report = validateIntake(record, "accept-jobs");
    expect(report.ok).toBe(false);
    expect(report.missing).toContain("safety.supervision");
    expect(report.neverDefaultViolations).toContain("safety.supervision");
  });

  it("blocks the milestone when a neverDefault field's provenance is unconfirmed research", () => {
    const record = cloneRecord(buildFullValidRecord());
    record.answers["safety.estop"] = {
      value: { present: true },
      provenance: "research",
      source: { doc: "manual" },
    };
    const report = validateIntake(record, "accept-jobs");
    expect(report.ok).toBe(false);
    expect(report.missing).toContain("safety.estop");
    expect(report.neverDefaultViolations).toContain("safety.estop");
  });

  it("is satisfied when a neverDefault field's provenance is confirmed (research the human confirmed)", () => {
    const record = cloneRecord(buildFullValidRecord());
    record.answers["operator.authority"] = confirmed(true);
    const report = validateIntake(record, "register");
    expect(report.missing).not.toContain("operator.authority");
    expect(report.neverDefaultViolations).not.toContain("operator.authority");
  });

  it("flags neverDefaultViolations globally, independent of the milestone being checked", () => {
    const record = cloneRecord(buildFullValidRecord());
    record.answers["pricing.unitPrice"] = probed("5.00"); // never asked for THIS milestone
    const report = validateIntake(record, "register"); // pricing isn't required for register
    expect(report.neverDefaultViolations).toContain("pricing.unitPrice");
  });
});

// ── 5. R2 rule 5 — sensitive fields ──────────────────────────────────────

describe("validateIntake — rule 5 (sensitive: {set:true} only)", () => {
  it("is satisfied when the sensitive value is exactly {set:true}", () => {
    const record = cloneRecord(buildFullValidRecord());
    const report = validateIntake(record, "get-paid");
    expect(report.sensitiveViolations).not.toContain("payout.destination");
    expect(report.missing).not.toContain("payout.destination");
  });

  it("flags a sensitive field that holds the real value instead of {set:true}", () => {
    const record = cloneRecord(buildFullValidRecord());
    record.answers["payout.destination"] = human({ destination: "acct-1234567890" });
    const report = validateIntake(record, "get-paid");
    expect(report.sensitiveViolations).toContain("payout.destination");
    expect(report.missing).toContain("payout.destination");
  });

  it("flags {set:false} and {set:true, ...extra} as violations too", () => {
    const record = cloneRecord(buildFullValidRecord());
    record.answers["payout.destination"] = human({ set: false });
    expect(validateIntake(record, "get-paid").sensitiveViolations).toContain("payout.destination");

    const record2 = cloneRecord(buildFullValidRecord());
    record2.answers["payout.destination"] = human({ set: true, accountNumber: "1234" });
    expect(validateIntake(record2, "get-paid").sensitiveViolations).toContain("payout.destination");
  });
});

// ── 6. Forbidden keys — refused everywhere, individually ─────────────────

describe("validateIntake — forbidden keys are always refused", () => {
  it.each(INTAKE_FORBIDDEN_KEYS)("refuses forbidden key %s inside an answer's value", (key) => {
    const record = cloneRecord(buildFullValidRecord());
    record.answers["evidence.referenceSample"] = human({
      available: true,
      expectedResultRef: "cube-20mm",
      [key]: "smuggled",
    });
    const report = validateIntake(record, "tier1");
    expect(report.ok).toBe(false);
    expect(report.forbiddenKeys).toContain(`evidence.referenceSample.${key}`);
  });

  it("refuses a forbidden key used as a source annotation", () => {
    const record = cloneRecord(buildFullValidRecord());
    record.answers["calibration.procedureRef"] = {
      value: "Prusa bed-leveling procedure v2",
      provenance: "confirmed",
      source: { doc: "manual", section: "specs" } as Record<string, unknown> as never,
    };
    // Inject a forbidden key directly onto the source object (bypassing the
    // strict zod shape, as a hostile/malformed caller might).
    (record.answers["calibration.procedureRef"].source as unknown as Record<string, unknown>).freshness = "now";
    const report = validateIntake(record, "tier1");
    expect(report.forbiddenKeys).toContain("calibration.procedureRef.freshness");
  });

  it("refuses a forbidden key used directly as a field id", () => {
    const record = cloneRecord(buildFullValidRecord());
    (record.answers as Record<string, IntakeAnswer>).verificationResult = human(true);
    const report = validateIntake(record, "register");
    expect(report.forbiddenKeys).toContain("verificationResult");
    expect(report.unknownFields).toContain("verificationResult");
  });
});

// ── 6b. Forbidden keys match loosely: case/underscore/hyphen-insensitive ──
// (review fix — was exact-match only).

describe("validateIntake — forbidden keys match loosely (case/underscore/hyphen-insensitive)", () => {
  it.each([
    "assurance_tier",
    "AssuranceTier",
    "ASSURANCE_TIER",
    "private-key",
    "PrivateKey",
    "HASH",
    "device_key_binding",
  ])("treats %s as a variant of its canonical forbidden key inside an answer's value", (variant) => {
    const record = cloneRecord(buildFullValidRecord());
    record.answers["evidence.referenceSample"] = human({
      available: true,
      expectedResultRef: "cube-20mm",
      [variant]: "smuggled",
    });
    const report = validateIntake(record, "tier1");
    expect(report.ok).toBe(false);
    expect(report.forbiddenKeys).toContain(`evidence.referenceSample.${variant}`);
  });

  it("treats a loose-variant field id as forbidden too", () => {
    const record = cloneRecord(buildFullValidRecord());
    (record.answers as Record<string, IntakeAnswer>)["Assurance-Tier"] = human(true);
    const report = validateIntake(record, "register");
    expect(report.ok).toBe(false);
    expect(report.forbiddenKeys).toContain("Assurance-Tier");
  });

  it("still refuses the exact canonical spelling (loose matching doesn't regress exact matches)", () => {
    const record = cloneRecord(buildFullValidRecord());
    record.answers["evidence.referenceSample"] = human({
      available: true,
      freshness: "now",
    });
    const report = validateIntake(record, "tier1");
    expect(report.forbiddenKeys).toContain("evidence.referenceSample.freshness");
  });

  it("does not flag unrelated keys that merely share a substring with a forbidden key", () => {
    const record = cloneRecord(buildFullValidRecord());
    // "restockedBy" shares no normalized form with any forbidden key; sanity
    // check that ordinary field values are never swept up by loose matching.
    const report = validateIntake(record, "accept-jobs");
    expect(report.forbiddenKeys).toEqual([]);
  });
});

// ── 7. Unknown fields ─────────────────────────────────────────────────────

describe("validateIntake — unknown fields", () => {
  it("reports a field id that isn't in the registry", () => {
    const record = cloneRecord(buildFullValidRecord());
    (record.answers as Record<string, IntakeAnswer>)["bogus.field"] = human("x");
    const report = validateIntake(record, "register");
    expect(report.ok).toBe(false);
    expect(report.unknownFields).toContain("bogus.field");
  });
});

// ── 8. Execution-mode tier cap — "may only LOWER the tier" ───────────────

describe("executionModeTierCap — caps, never raises, fails closed", () => {
  function recordWithExecutionMode(mode: string | undefined): IntakeRecord {
    const record = cloneRecord(buildFullValidRecord());
    if (mode === undefined) delete record.answers["evidence.executionMode"];
    else record.answers["evidence.executionMode"] = probed(mode);
    return record;
  }

  it("caps at tier 0 for mock or dry_run", () => {
    expect(executionModeTierCap(recordWithExecutionMode("mock"))).toBe(0);
    expect(executionModeTierCap(recordWithExecutionMode("dry_run"))).toBe(0);
  });

  it("imposes no cap only for an answer whose value is exactly real", () => {
    expect(executionModeTierCap(recordWithExecutionMode("real"))).toBe(NO_EXECUTION_MODE_CAP);
    expect(NO_EXECUTION_MODE_CAP).toBe(3);
  });

  it("caps at 0 when the answer is missing, malformed, or any other value or casing", () => {
    expect(executionModeTierCap(recordWithExecutionMode(undefined))).toBe(0);
    for (const odd of ["MOCK", "Real", "REAL", " real", "real ", "live", "", "dry-run"]) {
      expect(executionModeTierCap(recordWithExecutionMode(odd)), JSON.stringify(odd)).toBe(0);
    }
    const malformed = cloneRecord(buildFullValidRecord());
    (malformed.answers as Record<string, unknown>)["evidence.executionMode"] = { value: "real", provenance: "garbage" };
    expect(executionModeTierCap(malformed)).toBe(0);
    const researchNoSource = cloneRecord(buildFullValidRecord());
    (researchNoSource.answers as Record<string, unknown>)["evidence.executionMode"] = {
      value: "real",
      provenance: "research",
    };
    expect(executionModeTierCap(researchNoSource)).toBe(0);
  });

  it("caps at 0 for input that is not an intake record at all, and never throws", () => {
    for (const bad of [null, undefined, 42, "real", [], {}, { schema: "pcc.device-intake.v1" }, { answers: {} }]) {
      expect(executionModeTierCap(bad), JSON.stringify(bad)).toBe(0);
    }
    const hostile = {
      schema: "pcc.device-intake.v1",
      get answers(): never {
        throw new Error("boom");
      },
    };
    expect(executionModeTierCap(hostile)).toBe(0);
  });

  it("only ever LOWERS a computed tier via Math.min — never raises it", () => {
    // A "real" cap (3, the ceiling) never raises an otherwise-lower computed tier.
    const realCap = executionModeTierCap(recordWithExecutionMode("real"));
    expect(Math.min(0, realCap)).toBe(0);
    expect(Math.min(1, realCap)).toBe(1);
    // A "mock" cap (0) forces even a high computed tier down to 0.
    const mockCap = executionModeTierCap(recordWithExecutionMode("mock"));
    expect(Math.min(2, mockCap)).toBe(0);
    expect(Math.min(3, mockCap)).toBe(0);
  });
});

// ── 9. intakeFieldArtifactMap ─────────────────────────────────────────────

describe("intakeFieldArtifactMap", () => {
  const map = intakeFieldArtifactMap();

  it("groups field ids by the artifact they fill, sorted and de-duplicated", () => {
    expect(map.kernel?.sort()).toEqual(["location.streetAddress", "operator.displayName"].sort());
    expect(map.gatewayPayoutStore).toEqual(["payout.destination"]);
    expect(map.safetyEnvelope).toEqual(
      ["consumables.loadedMaterial", "safety.commandRate", "safety.estop", "safety.hazards", "safety.limits", "safety.supervision"].sort(),
    );
  });

  it("every field's fills appear under their artifact", () => {
    for (const field of INTAKE_FIELDS) {
      for (const fill of field.fills) {
        expect(map[fill.artifact]).toContain(field.id);
      }
    }
  });
});

// ── 9b. IntakeFieldDef.ifUnknown — R2 rule 3 ("I don't know" routing) ────

describe("IntakeFieldDef.ifUnknown", () => {
  it("every ifUnknown.research id exists in RESEARCH_LIBRARY", () => {
    const researchIds = new Set(RESEARCH_LIBRARY.map((e) => e.id));
    for (const field of INTAKE_FIELDS) {
      if (field.ifUnknown && "research" in field.ifUnknown) {
        expect(
          researchIds.has(field.ifUnknown.research),
          `${field.id} -> unknown research id "${field.ifUnknown.research}"`,
        ).toBe(true);
      }
    }
  });

  it("every neverDefault field has an ifUnknown", () => {
    for (const field of INTAKE_FIELDS) {
      if (field.neverDefault) {
        expect(field.ifUnknown, `${field.id} is neverDefault but has no ifUnknown`).toBeDefined();
      }
    }
  });

  it("money fields (pricing.*, payout.destination) always get a check, never a research-only shortcut", () => {
    const moneyIds = ["pricing.unitPrice", "pricing.minimum", "pricing.currency", "payout.destination"];
    for (const id of moneyIds) {
      const field = INTAKE_FIELDS.find((f) => f.id === id)!;
      expect(field.ifUnknown && "check" in field.ifUnknown, `${id} should have a check-type ifUnknown`).toBe(true);
    }
  });

  it("the generated schema includes x-pcc-ifUnknown exactly where a field declares it", () => {
    const schema = buildIntakeJsonSchema() as {
      properties: { answers: { properties: Record<string, Record<string, unknown>> } };
    };
    const answerProps = schema.properties.answers.properties;
    for (const field of INTAKE_FIELDS) {
      if (field.ifUnknown) {
        expect(answerProps[field.id]["x-pcc-ifUnknown"]).toEqual(field.ifUnknown);
      } else {
        expect(answerProps[field.id]["x-pcc-ifUnknown"]).toBeUndefined();
      }
    }
  });
});

// ── 10. Generated docs stay in sync with the committed files ─────────────

describe("generated docs are in sync with the committed files", () => {
  it("device-intake.schema.json matches buildIntakeJsonSchema()", () => {
    const committedPath = join(SPEC_ROOT, "src/onboarding/intake/device-intake.schema.json");
    const committed = readFileSync(committedPath, "utf8");
    const regenerated = `${JSON.stringify(buildIntakeJsonSchema(), null, 2)}\n`;
    expect(committed).toBe(regenerated);
  });

  it("docs/onboarding/intake/form.html matches buildFormHtml(INTAKE_FIELDS)", () => {
    const committedPath = join(REPO_ROOT, "docs/onboarding/intake/form.html");
    const committed = readFileSync(committedPath, "utf8");
    const regenerated = buildFormHtml(INTAKE_FIELDS);
    expect(committed).toBe(regenerated);
  });

  it("the generated schema documents every field with x-pcc-* annotations", () => {
    const schema = buildIntakeJsonSchema() as {
      properties: { answers: { properties: Record<string, Record<string, unknown>> } };
    };
    const answerProps = schema.properties.answers.properties;
    expect(Object.keys(answerProps).sort()).toEqual([...INTAKE_FIELD_IDS]);
    for (const field of INTAKE_FIELDS) {
      const prop = answerProps[field.id];
      expect(prop["x-pcc-class"]).toBe(field.class);
      expect(prop["x-pcc-requiredFor"]).toBe(field.requiredFor);
      expect(prop["x-pcc-neverDefault"]).toBe(field.neverDefault ?? false);
      expect(prop["x-pcc-sensitive"]).toBe(field.sensitive ?? false);
    }
  });
});

describe("safety field shapes match sensors' R8 (#4200)", () => {
  const field = (id: string) => INTAKE_FIELDS.find((f) => f.id === id)!;

  it("safety.estop is {mechanism, stopCommand?}", () => {
    const schema = field("safety.estop").valueSchema;
    expect(schema.safeParse({ mechanism: "hardware" }).success).toBe(true);
    expect(schema.safeParse({ mechanism: "adapter-stop", stopCommand: "M112" }).success).toBe(true);
    expect(schema.safeParse({ mechanism: "none" }).success).toBe(true);
    expect(schema.safeParse({ mechanism: "big red button" }).success).toBe(false);
    expect(schema.safeParse({ present: true }).success).toBe(false);
  });

  it("safety.limits needs quantity, unit and BOTH bounds, with min <= max", () => {
    const schema = field("safety.limits").valueSchema;
    expect(schema.safeParse([{ quantity: "volume", unit: "uL", min: 1, max: 1000 }]).success).toBe(true);
    expect(schema.safeParse([{ quantity: "volume", unit: "uL", max: 1000 }]).success).toBe(false);
    expect(schema.safeParse([{ quantity: "volume", unit: "uL", min: 10, max: 1 }]).success).toBe(false);
    expect(schema.safeParse([{ parameter: "volume", unit: "uL", min: 1, max: 2 }]).success).toBe(false);
    expect(schema.safeParse([]).success).toBe(false);
  });

  it("safety.hazards accepts an explicit empty list (none), and supervision is the R8 enum", () => {
    expect(field("safety.hazards").valueSchema.safeParse([]).success).toBe(true);
    const sup = field("safety.supervision").valueSchema;
    for (const v of ["attended", "unattended", "remote-supervised"]) expect(sup.safeParse(v).success, v).toBe(true);
    expect(sup.safeParse("sometimes").success).toBe(false);
  });
});

describe("safety.commandRate (sensors #4254)", () => {
  it("is a never-defaulted positive integer of commands per minute, required before accept-jobs", () => {
    const f = INTAKE_FIELDS.find((x) => x.id === "safety.commandRate")!;
    expect(f.neverDefault).toBe(true);
    expect(f.requiredFor).toContain("accept-jobs");
    expect(f.valueSchema.safeParse(60).success).toBe(true);
    for (const bad of [0, -1, 2.5, "60", null]) expect(f.valueSchema.safeParse(bad).success, String(bad)).toBe(false);
  });
});

// ── 11. Secret and sensitive-value scan (astra 120b, finding 1) ──────────
// Fake secrets are assembled at runtime from pieces, so no literal in this file
// is itself a secret-shaped string.

const FAKE = {
  pem: "-----BEGIN " + "PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END " + "PRIVATE KEY-----",
  stripeLive: "sk_" + "live_" + "A1b2C3d4E5f6G7h8I9",
  stripeRestricted: "rk_" + "live_" + "A1b2C3d4E5f6G7h8I9",
  anthropic: "sk-" + "ant-" + "api03-" + "x".repeat(24),
  openaiStyle: "sk" + "-" + "Ab12".repeat(10),
  awsAccessKeyId: "AK" + "IA" + "ABCDEFGHIJKLMNOP",
  googleApiKey: "AI" + "za" + "x".repeat(35),
  slack: "xo" + "xb-" + "1234567890-abcdefghij",
  githubClassic: "gh" + "p_" + "a".repeat(36),
  githubFineGrained: "github" + "_pat_" + "A1".repeat(20),
  pccLive: "pcc_" + "live_" + "A1b2C3d4E5f6G7h8I9",
  pccOracle: "pcc_" + "oracle_" + "A1b2C3d4E5f6G7h8I9",
  pccTest: "pcc_" + "test_" + "A1b2C3d4E5f6G7h8I9",
  jwt: ["ey" + "JhbGciOiJIUzI1NiJ9", "ey" + "JzdWIiOiJ4eHh4eHgifQ", "sig" + "nature12345"].join("."),
  hex64: "ab".repeat(32),
  hex64Prefixed: "0x" + "AB".repeat(32),
  address: "0x" + "282Fa9C122b433864f8C8a8F2EfE411b52067539",
  mnemonic12: BIP39_ENGLISH_WORDLIST.slice(100, 112).join(" "),
  street: "1600 Pennsylvania Avenue",
};

function withAnswer(id: string, answer: unknown): IntakeRecord {
  const record = buildFullValidRecord();
  return { schema: record.schema, answers: { ...record.answers, [id]: answer as IntakeAnswer } };
}

/** `scanIntakeStrings` over one description answer, reduced to its kinds. */
function kindsIn(text: string): IntakeSecretKind[] {
  return scanIntakeStrings({ answers: { "device.description": { value: text } } }).map((h) => h.kind);
}

describe("BIP-39 English wordlist data", () => {
  it("has 2048 words and matches the published english.txt sha256", () => {
    expect(BIP39_ENGLISH_WORDLIST).toHaveLength(2048);
    expect(Object.isFrozen(BIP39_ENGLISH_WORDLIST)).toBe(true);
    const digest = createHash("sha256")
      .update(BIP39_ENGLISH_WORDLIST.join("\n") + "\n")
      .digest("hex");
    expect(digest).toBe("2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda");
  });
});

describe("scanIntakeStrings — one detector per kind", () => {
  it.each([
    ["pem", FAKE.pem],
    ["vendor-key", FAKE.stripeLive],
    ["vendor-key", FAKE.stripeRestricted],
    ["vendor-key", FAKE.anthropic],
    ["vendor-key", FAKE.openaiStyle],
    ["vendor-key", FAKE.awsAccessKeyId],
    ["vendor-key", FAKE.googleApiKey],
    ["vendor-key", FAKE.slack],
    ["vendor-key", FAKE.githubClassic],
    ["vendor-key", FAKE.githubFineGrained],
    ["vendor-key", FAKE.pccLive],
    ["vendor-key", FAKE.pccOracle],
    ["vendor-key", FAKE.pccTest],
    ["vendor-key", FAKE.jwt],
    ["hex-secret", FAKE.hex64],
    ["hex-secret", FAKE.hex64Prefixed],
    ["payout-address", FAKE.address],
    ["mnemonic", FAKE.mnemonic12],
    ["street-address", FAKE.street],
  ] as const)("flags %s", (kind, secret) => {
    expect(kindsIn(`note: ${secret} end`)).toEqual([kind]);
  });

  it("covers exactly the six kinds, each exercised above", () => {
    expect([...INTAKE_SECRET_KINDS]).toEqual([
      "pem",
      "vendor-key",
      "hex-secret",
      "payout-address",
      "mnemonic",
      "street-address",
    ]);
  });

  it("near misses are not flagged (boundaries are real)", () => {
    const nearMisses = [
      "-----BEGIN-----", // no label
      "sk_" + "live_" + "short", // below the minimum length
      "AK" + "IA" + "ABCDEFGHIJKLMNO", // 15 chars after the prefix
      "ab".repeat(31) + "a", // 63 hex
      "ab".repeat(33), // 66 hex: not a whole 64-hex token
      "0x" + "ab".repeat(19) + "a", // 39 hex digits
      "0x" + "ab".repeat(21), // 42 hex digits
      BIP39_ENGLISH_WORDLIST.slice(100, 111).join(" "), // 11 words
      "3 drive bays",
      "4 way valve",
      "A desktop FDM 3D printer for PLA/PETG prototypes.",
      "Prusa bed-leveling procedure v2",
    ];
    for (const text of nearMisses) expect(kindsIn(text), text).toEqual([]);
  });

  it("a 64-hex token does not also report its first 40 digits as a payout address", () => {
    expect(kindsIn(`0x${"ab".repeat(32)}`)).toEqual(["hex-secret"]);
  });

  it("one string can carry several kinds, reported once each", () => {
    expect(kindsIn(`${FAKE.pem} ${FAKE.hex64} ${FAKE.address} ${FAKE.hex64}`)).toEqual([
      "pem",
      "hex-secret",
      "payout-address",
    ]);
  });
});

describe("scanIntakeStrings — mnemonic runs", () => {
  const words = (from: number, count: number): string[] => BIP39_ENGLISH_WORDLIST.slice(from, from + count);

  it("is deliberately broader than checksum-valid: any 12 listed words are flagged", () => {
    // The first twelve words of the list in order are not a valid BIP-39 phrase.
    expect(kindsIn(words(0, 12).join(" "))).toEqual(["mnemonic"]);
  });

  it("is case-insensitive and ignores digits, punctuation and line breaks between words", () => {
    expect(kindsIn(words(200, 12).join(" ").toUpperCase())).toEqual(["mnemonic"]);
    expect(kindsIn(words(200, 12).join(", "))).toEqual(["mnemonic"]);
    expect(kindsIn(words(200, 12).map((w, i) => `${i + 1}. ${w}`).join("\n"))).toEqual(["mnemonic"]);
  });

  it("needs 12 CONSECUTIVE listed words: a non-listed word splits the run", () => {
    const split = [...words(300, 6), "printer", ...words(306, 6)].join(" ");
    expect(kindsIn(split)).toEqual([]);
    expect(kindsIn([...words(300, 12), "printer", ...words(312, 11)].join(" "))).toEqual(["mnemonic"]);
  });

  it("flags a longer run once", () => {
    expect(kindsIn(words(400, 24).join(" "))).toEqual(["mnemonic"]);
  });
});

describe("scanIntakeStrings — street-address heuristic", () => {
  it.each([
    "1600 Pennsylvania Avenue",
    "221B Baker Street",
    "350 5th Avenue",
    "12-14 Main St.",
    "123 N. Main St",
    "123 MAIN STREET",
    "10 Downing Street",
    "9 Old Mill Road",
  ])("flags %s", (address) => {
    expect(kindsIn(`ships to ${address}, thanks`)).toEqual(["street-address"]);
  });

  it("is case-sensitive on the capitals and needs a street type", () => {
    for (const text of ["3 drive bays", "4 way valve", "12 steps to the Court", "100 Mile House", "2 Print Shops"]) {
      expect(kindsIn(text), text).toEqual([]);
    }
  });

  it("cannot trip on a city and country (location.cityCountry is applied the same way)", () => {
    const places = [
      ["Austin", "US"],
      ["Sao Paulo", "BR"],
      ["St. Louis", "US"],
      ["Port St Lucie", "US"],
      ["100 Mile House", "CA"],
      ["Winston-Salem", "US"],
      ["Ho Chi Minh City", "VN"],
      ["29 Palms", "US"],
      ["Washington, D.C.", "US"],
      ["Kuala Lumpur", "MY"],
    ] as const;
    for (const [city, country] of places) {
      const hits = scanIntakeStrings({ answers: { "location.cityCountry": { value: { city, country } } } });
      expect(hits, `${city}, ${country}`).toEqual([]);
    }
  });

  it("does catch a street address written into the public city field", () => {
    expect(
      scanIntakeStrings({ answers: { "location.cityCountry": { value: { city: FAKE.street, country: "US" } } } }),
    ).toEqual([{ path: "answers/location.cityCountry/value/city", kind: "street-address" }]);
  });
});

describe("scanIntakeStrings — walking and paths", () => {
  it("walks nested objects, arrays and sources and reports JSON-pointer-like paths", () => {
    const hits = scanIntakeStrings({
      schema: "pcc.device-intake.v1",
      answers: {
        "evidence.referenceSample": { value: { available: true, expectedResultRef: FAKE.hex64 }, provenance: "human" },
        "consumables.items": { value: ["PLA filament", FAKE.address], provenance: "human" },
        "calibration.procedureRef": {
          value: "ok",
          provenance: "confirmed",
          source: { doc: FAKE.pccLive, section: "specs" },
        },
      },
    });
    expect(hits).toEqual([
      { path: "answers/evidence.referenceSample/value/expectedResultRef", kind: "hex-secret" },
      { path: "answers/consumables.items/value/1", kind: "payout-address" },
      { path: "answers/calibration.procedureRef/source/doc", kind: "vendor-key" },
    ]);
  });

  it("returns nothing for clean input, non-string leaves and non-objects", () => {
    expect(scanIntakeStrings(buildFullValidRecord())).toEqual([]);
    expect(scanIntakeStrings(null)).toEqual([]);
    expect(scanIntakeStrings(undefined)).toEqual([]);
    expect(scanIntakeStrings(42)).toEqual([]);
    expect(scanIntakeStrings({ n: 1, b: true, z: null, u: undefined })).toEqual([]);
  });

  it("scans a bare string at the root, with an empty path", () => {
    expect(scanIntakeStrings(FAKE.hex64)).toEqual([{ path: "", kind: "hex-secret" }]);
  });

  it("does not scan object KEYS", () => {
    expect(scanIntakeStrings({ [FAKE.stripeLive]: "harmless" })).toEqual([]);
  });

  it("never returns the matched text, not even through a key in the path", () => {
    const tree = { answers: { [FAKE.stripeLive]: { value: FAKE.pem, other: FAKE.address } } };
    const hits = scanIntakeStrings(tree);
    expect(hits.map((h) => h.kind)).toEqual(["pem", "payout-address"]);
    const out = JSON.stringify(hits);
    for (const secret of Object.values(FAKE)) expect(out).not.toContain(secret);
    expect(hits[0]!.path).toBe("answers/[redacted:vendor-key]/value");
  });

  it("escapes pointer characters and writes non-ASCII key characters as \\u{hex}", () => {
    const lookalike = "priv" + String.fromCodePoint(0x430) + "te";
    const hits = scanIntakeStrings({ "a/b~c": { [lookalike]: FAKE.hex64 } });
    expect(hits).toEqual([{ path: "a~1b~0c/priv\\u{430}te", kind: "hex-secret" }]);
  });

  it("walks the own properties of a class instance too, not only plain objects", () => {
    class Approver {
      name = FAKE.hex64;
    }
    expect(scanIntakeStrings({ answers: { "evidence.approver": { value: new Approver() } } })).toEqual([
      { path: "answers/evidence.approver/value/name", kind: "hex-secret" },
    ]);
    const redacted = redactIntakeSecrets({ approver: new Approver() });
    expect(redacted.approver).toEqual({ name: "[redacted:hex-secret]" });
    expect(Object.getPrototypeOf(redacted.approver)).toBe(Object.prototype);
  });

  it("terminates on a cyclic structure and on very deep nesting", () => {
    const cyclic: Record<string, unknown> = { text: FAKE.hex64 };
    cyclic.self = cyclic;
    expect(scanIntakeStrings(cyclic)).toEqual([{ path: "text", kind: "hex-secret" }]);

    let deep: unknown = FAKE.address;
    for (let i = 0; i < 100000; i++) deep = [deep];
    expect(scanIntakeStrings(deep)).toHaveLength(1);
  });
});

describe("redactIntakeSecrets — for logs only", () => {
  const record = (): IntakeRecord =>
    withAnswer("device.description", human(`key ${FAKE.pem} and ${FAKE.hex64} at ${FAKE.street}`));

  it("replaces every hit with [redacted:<kind>] in a deep copy and leaves the input alone", () => {
    const input = record();
    const before = JSON.stringify(input);
    const out = redactIntakeSecrets(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(out).not.toBe(input);
    expect(out.answers["device.description"]!.value).toBe(
      "key [redacted:pem] and [redacted:hex-secret] at [redacted:street-address]",
    );
    expect(scanIntakeStrings(out)).toEqual([]);
    for (const secret of Object.values(FAKE)) expect(JSON.stringify(out)).not.toContain(secret);
  });

  it("keeps the shape, copies clean fields unchanged, and is idempotent", () => {
    const out = redactIntakeSecrets(record());
    expect(Object.keys(out.answers).sort()).toEqual([...INTAKE_FIELD_IDS]);
    expect(out.answers["operator.displayName"]).toEqual(buildFullValidRecord().answers["operator.displayName"]);
    expect(redactIntakeSecrets(out)).toEqual(out);
  });

  it("removes a whole PEM block through its footer, not only the header", () => {
    const out = redactIntakeSecrets({ v: `before ${FAKE.pem} after` });
    expect(out.v).toBe("before [redacted:pem] after");
  });

  it("redacts a PEM block with no footer through the end of the string", () => {
    const header = "-----BEGIN " + "PRIVATE KEY-----";
    expect(redactIntakeSecrets({ v: `${header}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC` }).v).toBe("[redacted:pem]");
  });

  it("renames a key that is itself a secret, keeping keys distinct, and keeps __proto__ as data", () => {
    const hostile = JSON.parse(`{"__proto__": {"polluted": "yes"}, "ok": "fine"}`) as Record<string, unknown>;
    const out = redactIntakeSecrets({ [FAKE.stripeLive]: 1, [FAKE.stripeRestricted]: 2, hostile }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["[redacted:vendor-key]", "[redacted:vendor-key]-2", "hostile"]);
    const copy = out.hostile as Record<string, unknown>;
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.keys(copy)).toEqual(["__proto__", "ok"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("a renamed secret key never collides with a literal key of the same text", () => {
    const literal = "[redacted:vendor-key]";
    const out = redactIntakeSecrets({ [FAKE.stripeLive]: 1, [literal]: 2 }) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual([literal, `${literal}-2`].sort());
    expect(out[literal]).toBe(2);
    expect(out[`${literal}-2`]).toBe(1);
  });

  it("copies primitives, null and shared/cyclic references without looping", () => {
    expect(redactIntakeSecrets(5)).toBe(5);
    expect(redactIntakeSecrets(null)).toBeNull();
    const cyclic: Record<string, unknown> = { text: FAKE.hex64 };
    cyclic.self = cyclic;
    const out = redactIntakeSecrets(cyclic);
    expect(out.text).toBe("[redacted:hex-secret]");
    expect(out.self).toBe(out);
  });
});

describe("validateIntake — secrets in any string (astra 120b, finding 1)", () => {
  it("a clean record has no secretsInText", () => {
    expect(validateIntake(buildFullValidRecord(), "identify").secretsInText).toEqual([]);
  });

  it.each([
    ["pem", FAKE.pem],
    ["vendor-key", FAKE.anthropic],
    ["hex-secret", FAKE.hex64Prefixed],
    ["payout-address", FAKE.address],
    ["mnemonic", FAKE.mnemonic12],
    ["street-address", FAKE.street],
  ] as const)("a %s in device.description makes the report not ok and is listed by path and kind only", (kind, secret) => {
    const report = validateIntake(withAnswer("device.description", human(`A printer. ${secret}`)), "identify");
    expect(report.ok).toBe(false);
    expect(report.secretsInText).toEqual([{ path: "answers/device.description/value", kind }]);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("also catches a secret in a nested value, in a source, and in a field with no free-text schema", () => {
    const nested = withAnswer(
      "evidence.referenceSample",
      human({ available: true, expectedResultRef: FAKE.hex64 }),
    );
    expect(validateIntake(nested, "register").secretsInText).toEqual([
      { path: "answers/evidence.referenceSample/value/expectedResultRef", kind: "hex-secret" },
    ]);

    const sourced = withAnswer("calibration.procedureRef", {
      value: "Prusa bed-leveling procedure v2",
      provenance: "confirmed",
      source: { doc: "manual", section: FAKE.pccLive },
    });
    expect(validateIntake(sourced, "register").secretsInText).toEqual([
      { path: "answers/calibration.procedureRef/source/section", kind: "vendor-key" },
    ]);

    const city = withAnswer("location.cityCountry", human({ city: FAKE.street, country: "US" }));
    const report = validateIntake(city, "register");
    expect(report.ok).toBe(false);
    expect(report.secretsInText).toEqual([{ path: "answers/location.cityCountry/value/city", kind: "street-address" }]);
  });
});

describe("validateIntake — the runtime boundary (astra 120b, finding 2)", () => {
  it("returns structuralErrors, never throws, for input that is not an intake record", () => {
    for (const bad of [null, undefined, 42, "text", true, [], {}, { schema: "nope", answers: {} }, { schema: "pcc.device-intake.v1" }]) {
      const report = validateIntake(bad, "register");
      expect(report.ok, JSON.stringify(bad)).toBe(false);
      expect(report.structuralErrors.length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });

  it("refuses an answers map that holds a non-object answer or an array", () => {
    const base = { schema: "pcc.device-intake.v1" };
    for (const answers of [[], { "device.model": "Prusa" }, { "device.model": null }]) {
      const report = validateIntake({ ...base, answers }, "register");
      expect(report.ok).toBe(false);
      expect(report.structuralErrors, JSON.stringify(answers)).not.toEqual([]);
    }
  });

  it("refuses unknown top-level and answer-level keys (strict)", () => {
    const record = buildFullValidRecord();
    const topLevel = ready({ ...record, extra: 1 } as unknown as IntakeRecord, "register");
    expect(topLevel.ok).toBe(false);
    expect(topLevel.structuralErrors).toEqual(["(root): unrecognized_keys"]);

    const answers = { ...record.answers, "device.model": { ...probed("MK4S"), extra: 1 } };
    const nested = ready({ ...record, answers } as unknown as IntakeRecord, "register");
    expect(nested.ok).toBe(false);
    expect(nested.structuralErrors).toEqual(["answers/device.model: unrecognized_keys"]);
  });

  it("structuralErrors carry paths and messages, never the offending values", () => {
    const sentinel = "SENTINEL-not-an-enum-value";
    const report = validateIntake(
      withAnswer("device.description", { value: "A printer.", provenance: sentinel }),
      "identify",
    );
    expect(report.ok).toBe(false);
    expect(report.structuralErrors).toEqual(["answers/device.description/provenance: invalid_enum_value"]);
    expect(JSON.stringify(report)).not.toContain(sentinel);
  });

  it("describes issue kinds without quoting values", () => {
    const report = validateIntake(
      {
        schema: "pcc.device-intake.v1",
        answers: {
          "device.model": { value: "x", provenance: "research" },
          "device.vendor": { value: "x", provenance: "human", source: { doc: "", url: "not a url" } },
        },
      },
      "register",
    );
    expect(report.structuralErrors).toEqual(
      expect.arrayContaining([
        'answers/device.model/source: provenance "research" requires a source',
        "answers/device.vendor/source/doc: must not be blank",
        "answers/device.vendor/source/url: must be an https URL without credentials",
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("not a url");
  });

  it("an unknown milestone is a structural error, not a free pass", () => {
    const report = validateIntake(buildFullValidRecord(), "launch-party" as never);
    expect(report.ok).toBe(false);
    expect(report.structuralErrors).toContain("milestone: not a known intake milestone");
  });

  it("an unreadable input (throwing getter) fails closed instead of throwing", () => {
    const hostile = {
      schema: "pcc.device-intake.v1",
      get answers(): never {
        throw new Error("boom");
      },
    };
    const report = validateIntake(hostile, "register");
    expect(report.ok).toBe(false);
    expect(report.structuralErrors).toContain("(root): input could not be read");
  });

  it("still reports forbidden keys, unknown fields and secrets from the raw input when the parse fails", () => {
    const record = cloneRecord(buildFullValidRecord());
    const raw = JSON.parse(JSON.stringify({ ...record, answers: { ...record.answers } })) as {
      answers: Record<string, unknown>;
    };
    raw.answers["calibration.procedureRef"] = {
      value: "Prusa bed-leveling procedure v2",
      provenance: "confirmed",
      source: { doc: "manual", freshness: "now" },
    };
    raw.answers["device.description"] = { value: FAKE.hex64, provenance: "garbage" };
    raw.answers["bogus.field"] = { value: "x", provenance: "human" };
    const report = validateIntake(raw, "register");
    expect(report.ok).toBe(false);
    expect(report.structuralErrors.length).toBeGreaterThan(0);
    expect(report.forbiddenKeys).toContain("calibration.procedureRef.freshness");
    expect(report.unknownFields).toContain("bogus.field");
    expect(report.secretsInText).toEqual([{ path: "answers/device.description/value", kind: "hex-secret" }]);
    // The milestone checks are not run on a record that did not parse.
    expect(report.missing).toEqual([]);
    expect(report.invalidFields).toEqual([]);
  });

  it("sees an answers entry named __proto__ that a parse would silently drop", () => {
    const raw = JSON.parse(
      JSON.stringify({ ...buildFullValidRecord(), answers: {} }).replace(
        '"answers":{}',
        '"answers":{"__proto__":{"value":"x","provenance":"human"}}',
      ),
    ) as unknown;
    const report = validateIntake(raw, "register");
    expect(report.ok).toBe(false);
    expect(report.unknownFields).toContain("__proto__");
  });

  it("never echoes a secret-looking field id or key text into the report", () => {
    const record = cloneRecord(buildFullValidRecord());
    (record.answers as Record<string, unknown>)[FAKE.stripeLive] = human("x");
    (record.answers as Record<string, unknown>)["evidence.camera"] = human({
      seesWorkArea: true,
      seesOutput: true,
      mount: "fixed",
      captureDeviceId: "cam-1",
      [FAKE.githubClassic]: "v",
    });
    const report = validateIntake(record, "register");
    expect(report.unknownFields).toEqual(["[redacted:vendor-key]"]);
    expect(report.invalidFields).toContain("evidence.camera");
    expect(JSON.stringify(report)).not.toContain(FAKE.stripeLive);
    expect(JSON.stringify(report)).not.toContain(FAKE.githubClassic);
  });

  describe("every present known field is validated against its own schema, whatever the milestone", () => {
    it("lists a malformed value in invalidFields and is not ok, even when the milestone does not require it", () => {
      const bad = withAnswer("safety.limits", confirmed([{ quantity: "bed temperature", unit: "C", min: 10, max: 1 }]));
      const report = validateIntake(bad, "register"); // safety.limits is not required for register
      expect(report.ok).toBe(false);
      expect(report.invalidFields).toEqual(["safety.limits"]);
      expect(report.missing).not.toContain("safety.limits");
    });

    it("lists a malformed value of a required field in both missing and invalidFields", () => {
      const report = validateIntake(withAnswer("device.description", human(42)), "identify");
      expect(report.ok).toBe(false);
      expect(report.missing).toContain("device.description");
      expect(report.invalidFields).toContain("device.description");
    });

    it("a sensitive field holding anything but {set:true} is in sensitiveViolations and invalidFields", () => {
      const report = validateIntake(withAnswer("payout.destination", human({ destination: "acct-1" })), "register");
      expect(report.sensitiveViolations).toEqual(["payout.destination"]);
      expect(report.invalidFields).toEqual(["payout.destination"]);
      expect(report.ok).toBe(false);
    });

    it("an answer with no value key at all is invalid for every field", () => {
      const raw = { schema: "pcc.device-intake.v1", answers: { "device.model": { provenance: "human" } } };
      const report = validateIntake(raw, "register");
      expect(report.invalidFields).toEqual(["device.model"]);
      expect(report.ok).toBe(false);
    });

    it("a clean record has no invalidFields and no structuralErrors", () => {
      const report = validateIntake(buildFullValidRecord(), "identify");
      expect(report.invalidFields).toEqual([]);
      expect(report.structuralErrors).toEqual([]);
    });
  });
});

describe("validateIntake — confirmation and payout resolve from authority (astra 120b, finding 3)", () => {
  const full = buildFullValidRecord();

  it("CONFIRMATION_REQUIRED_FIELDS is derived from neverDefault + humanConfirmRequired fills, and pinned", () => {
    const fromNeverDefault = INTAKE_FIELDS.filter((f) => f.neverDefault).map((f) => f.id);
    const fromResearch = RESEARCH_LIBRARY.filter((e) => e.humanConfirmRequired).flatMap((e) => e.fills);
    expect(new Set(CONFIRMATION_REQUIRED_FIELDS)).toEqual(new Set([...fromNeverDefault, ...fromResearch]));
    expect([...CONFIRMATION_REQUIRED_FIELDS]).toEqual([
      "capability.parameters",
      "operator.authority",
      "payout.destination",
      "pricing.currency",
      "pricing.minimum",
      "pricing.unitPrice",
      "safety.commandRate",
      "safety.estop",
      "safety.hazards",
      "safety.limits",
      "safety.supervision",
    ]);
    expect(CONFIRMATION_REQUIRED_FIELDS).toContain("capability.parameters");
    expect(Object.isFrozen(CONFIRMATION_REQUIRED_FIELDS)).toBe(true);
    expect(() => (CONFIRMATION_REQUIRED_FIELDS as string[]).push("device.model")).toThrow();
    // every id is a real field
    for (const id of CONFIRMATION_REQUIRED_FIELDS) expect(INTAKE_FIELD_IDS).toContain(id);
  });

  it("IntakeAnswerSchema accepts an optional strict confirmation {eventId}", () => {
    const answer = { value: "x", provenance: "human" as const };
    expect(IntakeAnswerSchema.safeParse({ ...answer, confirmation: { eventId: "evt-1" } }).success).toBe(true);
    expect(IntakeAnswerSchema.safeParse(answer).success).toBe(true);
    for (const bad of [{}, { eventId: "" }, { eventId: "x".repeat(257) }, { eventId: "e", extra: 1 }, { eventId: 7 }]) {
      expect(IntakeAnswerSchema.safeParse({ ...answer, confirmation: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("without an authority, publish, accept-jobs and get-paid are not ready", () => {
    for (const milestone of ["publish", "accept-jobs", "get-paid"] as const) {
      const report = validateIntake(full, milestone);
      expect(report.ok, milestone).toBe(false);
      expect(report.unconfirmed.length, milestone).toBeGreaterThan(0);
    }
  });

  it("without an authority every milestone that needs a confirmation-required field lists it in unconfirmed", () => {
    const expectedFor = (milestone: (typeof INTAKE_MILESTONES)[number]): string[] =>
      INTAKE_FIELDS.filter(
        (f) => f.requiredFor.some((rf) => MILESTONE_IMPLIES[milestone].includes(rf)) && CONFIRMATION_REQUIRED_FIELDS.includes(f.id),
      ).map((f) => f.id);
    expect(expectedFor("publish")).toEqual([
      "operator.authority",
      "safety.supervision",
      "safety.estop",
      "capability.parameters",
      "pricing.unitPrice",
      "pricing.minimum",
      "pricing.currency",
    ]);
    for (const milestone of INTAKE_MILESTONES) {
      expect(validateIntake(full, milestone).unconfirmed, milestone).toEqual(expectedFor(milestone));
    }
    // accept-jobs adds the rest of the safety envelope; get-paid adds the payout destination.
    expect(validateIntake(full, "accept-jobs").unconfirmed).toEqual(
      expect.arrayContaining(["safety.hazards", "safety.limits", "safety.commandRate"]),
    );
    expect(validateIntake(full, "get-paid").unconfirmed).toContain("payout.destination");
    expect(validateIntake(full, "get-paid").unverified).toEqual(["payout.destination"]);
  });

  it("with a full authority nothing is unconfirmed or unverified", () => {
    for (const milestone of INTAKE_MILESTONES) {
      const report = ready(full, milestone);
      expect(report.unconfirmed, milestone).toEqual([]);
      expect(report.unverified, milestone).toEqual([]);
    }
  });

  describe("an event that does not match the answer confirms nothing", () => {
    const field = "safety.supervision"; // human provenance, no source; required for publish
    const sourcedField = "safety.limits"; // confirmed provenance, with a source; required for accept-jobs

    const cases: [string, string, (events: Map<string, IntakeConfirmationEvent>) => void][] = [
      ["a revoked event", field, (e) => e.set(`evt-${field}`, { ...e.get(`evt-${field}`)!, revoked: true })],
      ["a superseded event", field, (e) => e.set(`evt-${field}`, { ...e.get(`evt-${field}`)!, supersededBy: "evt-newer" })],
      ["a value-hash mismatch", field, (e) => e.set(`evt-${field}`, { ...e.get(`evt-${field}`)!, valueHash: intakeValueHash("unattended") })],
      ["a fieldId mismatch", field, (e) => e.set(`evt-${field}`, { ...e.get(`evt-${field}`)!, fieldId: "safety.hazards" })],
      ["an unknown event id (the store returns null)", field, (e) => e.delete(`evt-${field}`)],
      [
        "an event whose own eventId differs from the one asked for",
        field,
        (e) => e.set(`evt-${field}`, { ...e.get(`evt-${field}`)!, eventId: "evt-other" }),
      ],
      [
        "a source-hash mismatch on a sourced answer",
        sourcedField,
        (e) => e.set(`evt-${sourcedField}`, { ...e.get(`evt-${sourcedField}`)!, sourceHash: intakeValueHash({ doc: "other" }) }),
      ],
      [
        "a missing source hash on a sourced answer",
        sourcedField,
        (e) => {
          const { sourceHash: _dropped, ...rest } = e.get(`evt-${sourcedField}`)!;
          e.set(`evt-${sourcedField}`, rest);
        },
      ],
      [
        "a source hash on an answer that has no source",
        field,
        (e) => e.set(`evt-${field}`, { ...e.get(`evt-${field}`)!, sourceHash: intakeValueHash({ doc: "manual" }) }),
      ],
      [
        "a malformed event (no challenge)",
        field,
        (e) => {
          const { challenge: _dropped, ...rest } = e.get(`evt-${field}`)!;
          e.set(`evt-${field}`, rest as IntakeConfirmationEvent);
        },
      ],
      [
        "a malformed event (revoked is not a boolean)",
        field,
        (e) => e.set(`evt-${field}`, { ...e.get(`evt-${field}`)!, revoked: undefined as unknown as boolean }),
      ],
      [
        "a malformed event (superseded state missing)",
        field,
        (e) => e.set(`evt-${field}`, { ...e.get(`evt-${field}`)!, supersededBy: undefined as unknown as null }),
      ],
      [
        "an event of another schema version",
        field,
        (e) => e.set(`evt-${field}`, { ...e.get(`evt-${field}`)!, schema: "pcc.intake-confirmation.v2" as never }),
      ],
      [
        "an event with an unrecognized auth method",
        field,
        (e) =>
          e.set(`evt-${field}`, {
            ...e.get(`evt-${field}`)!,
            confirmedBy: { principal: "operator:acme", authMethod: "trust-me" as never },
          }),
      ],
    ];

    it.each(cases)("%s", (_name, target, edit) => {
      const milestone = target === sourcedField ? "accept-jobs" : "publish";
      const report = ready(full, milestone, { events: edit });
      expect(report.ok).toBe(false);
      expect(report.unconfirmed).toEqual([target]);
      expect(report.missing).toEqual([]);
    });

    it("a missing confirmation reference", () => {
      const record = cloneRecord(full);
      const { confirmation: _dropped, ...withoutRef } = record.answers[field]!;
      record.answers[field] = withoutRef;
      const report = ready(record, "publish");
      expect(report.ok).toBe(false);
      expect(report.unconfirmed).toEqual([field]);
    });

    it("an authority whose resolver throws is treated as not confirmed, never as an exception", () => {
      const throwing: IntakeAuthority = {
        resolveConfirmation: () => {
          throw new Error("store offline");
        },
        payoutDestinationExists: () => true,
      };
      const report = validateIntake(full, "publish", throwing);
      expect(report.ok).toBe(false);
      expect(report.unconfirmed).toEqual(validateIntake(full, "publish").unconfirmed);
    });

    it("an async resolver (a Promise instead of an event) confirms nothing", () => {
      const asyncAuthority: IntakeAuthority = {
        resolveConfirmation: () => Promise.resolve(null) as never,
        payoutDestinationExists: () => true,
      };
      expect(validateIntake(full, "publish", asyncAuthority).unconfirmed.length).toBeGreaterThan(0);
    });

    it("tampering with the answer after confirmation breaks the value hash", () => {
      const record = cloneRecord(full);
      const authority = makeAuthority(record); // events hold the ORIGINAL value
      record.answers[field] = { ...record.answers[field]!, value: "unattended" };
      const report = validateIntake(record, "publish", authority);
      expect(report.ok).toBe(false);
      expect(report.unconfirmed).toEqual([field]);
    });

    it("tampering with the source after confirmation breaks the source hash", () => {
      const record = cloneRecord(full);
      const authority = makeAuthority(record);
      record.answers[sourcedField] = {
        ...record.answers[sourcedField]!,
        source: { doc: "a different manual", section: "specs" },
      };
      const report = validateIntake(record, "accept-jobs", authority);
      expect(report.unconfirmed).toEqual([sourcedField]);
    });

    it("an event cannot be replayed for another field, even when the value hash is equal", () => {
      const record = cloneRecord(full);
      record.answers["pricing.unitPrice"] = {
        ...record.answers["pricing.unitPrice"]!,
        value: "2.00", // same value as pricing.minimum
        confirmation: { eventId: "evt-pricing.minimum" },
      };
      const authority = makeAuthority(record);
      expect(authority.resolveConfirmation("evt-pricing.minimum")!.valueHash).toBe(intakeValueHash("2.00"));
      const report = validateIntake(record, "publish", authority);
      expect(report.unconfirmed).toEqual(["pricing.unitPrice"]);
    });

    it("an event for the same value in another record is not enough without the right field id", () => {
      // two fields, same value, two events: each answer only matches its own.
      const record = cloneRecord(full);
      record.answers["pricing.unitPrice"] = { ...record.answers["pricing.unitPrice"]!, value: "2.00" };
      const report = ready(record, "publish");
      expect(report.ok).toBe(true); // its own event was derived from the new value
      const stale = makeAuthority(full); // events for the ORIGINAL 5.00
      expect(validateIntake(record, "publish", stale).unconfirmed).toEqual(["pricing.unitPrice"]);
    });
  });

  describe("provenance without confirmation is never authority", () => {
    it("research provenance on capability.parameters (humanConfirmRequired) does not make publish ready", () => {
      const record = withAnswer("capability.parameters", {
        value: [{ key: "infill", min: 0, max: 100, unit: "%" }],
        provenance: "research",
        source: { doc: "manual", section: "specs" },
        confirmation: { eventId: "evt-capability.parameters" },
      });
      const report = ready(record, "publish");
      expect(report.ok).toBe(false);
      expect(report.missing).toEqual(["capability.parameters"]);
      expect(report.unconfirmed).toEqual(["capability.parameters"]);
      expect(report.neverDefaultViolations).toEqual(["capability.parameters"]);
    });

    it("probe provenance on a confirmation-required field is flagged even when the milestone does not need it", () => {
      const record = withAnswer("capability.parameters", probed([{ key: "infill", min: 0, max: 100, unit: "%" }]));
      const report = ready(record, "register");
      expect(report.neverDefaultViolations).toEqual(["capability.parameters"]);
      expect(report.ok).toBe(false);
    });

    it("a human-provenance answer with a valid event is the only thing that satisfies it", () => {
      const record = withAnswer("capability.parameters", {
        value: [{ key: "infill", min: 0, max: 100, unit: "%" }],
        provenance: "human",
        confirmation: { eventId: "evt-capability.parameters" },
      });
      expect(ready(record, "publish").ok).toBe(true);
    });

    it("a confirmation reference on a field that does not need one is ignored", () => {
      const record = withAnswer("device.model", {
        ...probed("MK4S"),
        confirmation: { eventId: "evt-nonexistent" },
      });
      expect(ready(record, "register-device").ok).toBe(true);
    });

    it("a confirmation-required answer whose value is invalid is missing, not merely unconfirmed", () => {
      const record = withAnswer("safety.supervision", {
        value: "sometimes",
        provenance: "human",
        confirmation: { eventId: "evt-safety.supervision" },
      });
      const report = ready(record, "publish");
      expect(report.missing).toEqual(["safety.supervision"]);
      expect(report.unconfirmed).toEqual([]);
      expect(report.invalidFields).toEqual(["safety.supervision"]);
    });
  });

  describe("get-paid re-reads the payout store, never the record's {set:true}", () => {
    it("is ready when the payout store has a destination", () => {
      expect(ready(full, "get-paid", { payout: true }).ok).toBe(true);
    });

    it("is not ready when the payout store says there is none", () => {
      const report = ready(full, "get-paid", { payout: false });
      expect(report.ok).toBe(false);
      expect(report.unverified).toEqual(["payout.destination"]);
      expect(report.missing).toEqual([]);
      expect(report.unconfirmed).toEqual([]);
    });

    it("is not ready with no authority, and an authority that throws or answers loosely counts as no", () => {
      expect(validateIntake(full, "get-paid").unverified).toEqual(["payout.destination"]);
      const events = makeAuthority(full);
      const throwing: IntakeAuthority = {
        ...events,
        payoutDestinationExists: () => {
          throw new Error("payout store offline");
        },
      };
      expect(validateIntake(full, "get-paid", throwing).unverified).toEqual(["payout.destination"]);
      const loose: IntakeAuthority = { ...events, payoutDestinationExists: () => "yes" as never };
      expect(validateIntake(full, "get-paid", loose).unverified).toEqual(["payout.destination"]);
    });

    it("only get-paid asks the payout store", () => {
      let calls = 0;
      const base = makeAuthority(full);
      const counting: IntakeAuthority = {
        ...base,
        payoutDestinationExists: () => {
          calls += 1;
          return true;
        },
      };
      for (const milestone of INTAKE_MILESTONES) {
        if (milestone !== "get-paid") expect(validateIntake(full, milestone, counting).unverified, milestone).toEqual([]);
      }
      expect(calls).toBe(0);
      validateIntake(full, "get-paid", counting);
      expect(calls).toBe(1);
    });
  });
});

describe("intakeValueHash", () => {
  it("is sha256: + hex of sha256 over the canonical JSON, independent of key order", () => {
    const value = { b: [1, { d: 4, c: 3 }], a: "x" };
    const expected = `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
    expect(intakeValueHash(value)).toBe(expected);
    expect(intakeValueHash(value)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(intakeValueHash({ a: "x", b: [1, { c: 3, d: 4 }] })).toBe(expected);
  });

  it("distinguishes values, including types that print alike", () => {
    const hashes = [1, "1", true, null, [1], { a: 1 }, "", [], {}].map(intakeValueHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("matches a published sha256 vector for a plain string value", () => {
    // canonicalize("abc") is the JSON text "abc" including the quotes (5 bytes).
    expect(intakeValueHash("abc")).toBe(`sha256:${createHash("sha256").update('"abc"').digest("hex")}`);
  });
});

// ── 12. Safety limits bind to the selected CSD; estop "none" (astra 120b, finding 4) ─

/** A confirmed safety.limits answer whose confirmation reference the stub authority will resolve. */
function limitsAnswer(limits: unknown): IntakeAnswer {
  return { ...confirmed(limits), confirmation: { eventId: "evt-safety.limits" } };
}

/** A lab-rig CSD with one number parameter per unit dimension in the table, plus awkward ones. */
function labCsd(): CSD {
  const numberParam = (key: string, unit: string | undefined, min: number, max: number) => ({
    type: "number" as const,
    key,
    label: key,
    required: false,
    min,
    max,
    step: 1,
    ...(unit === undefined ? {} : { unit }),
  });
  return CsdSchema.parse({
    url: "pcc://capabilities/test-lab/v1",
    version: "1.0.0",
    status: "active",
    name: "Test lab rig",
    description: "fixture CSD for limit binding",
    kind: "base",
    baseDefinition: null,
    parameters: [
      numberParam("bedTemp", "C", 20, 120),
      numberParam("travel", "mm", 0, 500),
      numberParam("volume", "mL", 0.5, 5),
      numberParam("duration", "s", 1, 3600),
      numberParam("fill", "%", 5, 100),
      numberParam("spindle", "rpm", 0, 100), // a unit outside the closed table
      numberParam("plain", undefined, 1, 10), // declares no unit
      { type: "enum", key: "material", label: "Material", required: true, options: [{ value: "pla", label: "PLA" }] },
    ],
    constraints: [],
    pricing: { basePrice: "1", currency: "USD" },
  });
}

function labRegistry(): CsdRegistry {
  const registry = new CsdRegistry();
  registry.register(labCsd());
  return registry;
}

interface LabOptions {
  milestone?: (typeof INTAKE_MILESTONES)[number];
  /** capability.type; null leaves the answer out. */
  type?: string | null;
  /** The CSD registry the authority offers; null offers none (the built-ins apply). */
  registry?: CsdRegistry | null;
}

/** The full fixture, retargeted at the lab CSD with the given limits, validated with that registry. */
function labReport(limits: unknown, options: LabOptions = {}) {
  const { milestone = "accept-jobs", type = "pcc://capabilities/test-lab/v1", registry = labRegistry() } = options;
  const record = cloneRecord(buildFullValidRecord());
  record.answers["safety.limits"] = limitsAnswer(limits);
  if (type === null) delete record.answers["capability.type"];
  else record.answers["capability.type"] = probed(type);
  const authority = { ...makeAuthority(record), ...(registry ? { csdRegistry: registry } : {}) };
  return validateIntake(record, milestone, authority);
}

const limit = (quantity: string, unit: string, min: number, max: number) => ({ quantity, unit, min, max });

describe("validateIntake — safety limits bind to the selected CSD (astra 120b, finding 4)", () => {
  it("the fixture's limit uses fdm/v2's infill (%, 5-100), a number parameter that declares a unit", () => {
    const infill = loadBuiltinCsds().resolve("pcc://capabilities/fdm/v2").parameters.find((p) => p.key === "infill");
    expect(infill).toMatchObject({ type: "number", unit: "%", min: 5, max: 100 });
    expect(ready(buildFullValidRecord(), "accept-jobs").limitErrors).toEqual([]);
  });

  it("accepts a limit that narrows the CSD range, or equals it, or is a single point", () => {
    expect(labReport([limit("bedTemp", "C", 30, 100)]).limitErrors).toEqual([]);
    expect(labReport([limit("bedTemp", "C", 20, 120)]).limitErrors).toEqual([]);
    expect(labReport([limit("bedTemp", "C", 60, 60)]).limitErrors).toEqual([]);
    expect(labReport([limit("bedTemp", "C", 30, 100)]).ok).toBe(true);
  });

  it("refuses a limit that widens the CSD range on either side", () => {
    for (const bad of [limit("bedTemp", "C", 20, 121), limit("bedTemp", "C", 19, 100), limit("bedTemp", "C", 0, 500)]) {
      const report = labReport([bad]);
      expect(report.ok).toBe(false);
      expect(report.limitErrors).toEqual(["safety.limits[0]: limit lies outside the CSD parameter's range"]);
    }
  });

  it("requires the quantity to be a NUMBER parameter key of the CSD, exactly", () => {
    for (const quantity of ["bed temperature", "Bedtemp", "BedTemp", "bedTemp ", "material", "infill", "volume2"]) {
      const report = labReport([limit(quantity, "C", 30, 100)]);
      expect(report.ok, quantity).toBe(false);
      expect(report.limitErrors, quantity).toEqual(["safety.limits[0]: quantity is not a number parameter of the selected CSD"]);
    }
  });

  it("converts units within a dimension before comparing to the parameter's range", () => {
    // volume: parameter is mL 0.5-5
    expect(labReport([limit("volume", "uL", 1000, 2000)]).limitErrors).toEqual([]);
    expect(labReport([limit("volume", "L", 0.001, 0.004)]).limitErrors).toEqual([]);
    expect(labReport([limit("volume", "uL", 400, 2000)]).limitErrors).toEqual([
      "safety.limits[0]: limit lies outside the CSD parameter's range",
    ]);
    // temperature: parameter is C 20-120 (K is offset, not just scaled)
    expect(labReport([limit("bedTemp", "K", 303.15, 373.15)]).limitErrors).toEqual([]);
    expect(labReport([limit("bedTemp", "K", 20, 120)]).limitErrors).toEqual([
      "safety.limits[0]: limit lies outside the CSD parameter's range",
    ]);
    // length: parameter is mm 0-500
    expect(labReport([limit("travel", "cm", 1, 50)]).limitErrors).toEqual([]);
    expect(labReport([limit("travel", "m", 0, 0.5)]).limitErrors).toEqual([]);
    expect(labReport([limit("travel", "m", 0, 0.6)]).limitErrors).toHaveLength(1);
    // time: parameter is s 1-3600
    expect(labReport([limit("duration", "min", 1, 60)]).limitErrors).toEqual([]);
    expect(labReport([limit("duration", "h", 0.5, 1)]).limitErrors).toEqual([]);
    expect(labReport([limit("duration", "h", 0.5, 1.5)]).limitErrors).toHaveLength(1);
    // percent: the same unit, compared exactly
    expect(labReport([limit("fill", "%", 5, 100)]).limitErrors).toEqual([]);
    expect(labReport([limit("fill", "%", 4.9999999999, 100)]).limitErrors).toHaveLength(1);
  });

  it("accepts the unit spellings that fold to a table unit", () => {
    const micro = String.fromCharCode(0xb5);
    const greekMu = String.fromCharCode(0x3bc);
    const degree = String.fromCharCode(0xb0);
    for (const unit of [`${micro}L`, `${greekMu}L`, "ul", " uL "]) {
      expect(labReport([limit("volume", unit, 1000, 2000)]).limitErrors, unit).toEqual([]);
    }
    expect(labReport([limit("volume", "ml", 1, 2)]).limitErrors).toEqual([]);
    for (const unit of [`${degree}C`, "degC"]) {
      expect(labReport([limit("bedTemp", unit, 30, 100)]).limitErrors, unit).toEqual([]);
    }
    expect(labReport([limit("duration", "sec", 1, 60)]).limitErrors).toEqual([]);
  });

  it("refuses a unit outside the closed table, a unit of another dimension, and a CSD unit it cannot convert", () => {
    expect(labReport([limit("bedTemp", "F", 90, 200)]).limitErrors).toEqual([
      "safety.limits[0]: unit is not in the closed unit table",
    ]);
    expect(labReport([limit("volume", "ML", 1, 2)]).limitErrors).toEqual([
      "safety.limits[0]: unit is not in the closed unit table",
    ]);
    expect(labReport([limit("bedTemp", "mm", 30, 100)]).limitErrors).toEqual([
      "safety.limits[0]: unit does not match the CSD parameter's unit",
    ]);
    expect(labReport([limit("volume", "mm", 1, 2)]).limitErrors).toHaveLength(1);
    // the parameter's own unit ("rpm") is outside the table, so it cannot carry a limit even in its own unit
    expect(labReport([limit("spindle", "rpm", 1, 50)]).limitErrors).toEqual([
      "safety.limits[0]: unit is not in the closed unit table",
    ]);
  });

  it("refuses a limit on a parameter that declares no unit", () => {
    const report = labReport([limit("plain", "count", 1, 5)]);
    expect(report.ok).toBe(false);
    expect(report.limitErrors).toEqual(["safety.limits[0]: unit is not in the closed unit table"]);
    // even with a table unit there is nothing for it to equal
    expect(labReport([limit("plain", "%", 1, 5)]).limitErrors).toEqual([
      "safety.limits[0]: the CSD parameter declares no unit",
    ]);
  });

  it("every number parameter with a unit in a built-in CSD accepts its own full range, and the table covers those units", () => {
    const registry = loadBuiltinCsds();
    registry.register(CsdSchema.parse(printAndMailCsd));
    let checked = 0;
    for (const csd of registry.list()) {
      for (const p of csd.parameters) {
        if (p.type !== "number") continue;
        const full = limit(p.key, p.unit ?? "?", p.min, p.max);
        const record = cloneRecord(buildFullValidRecord());
        record.answers["safety.limits"] = limitsAnswer([full]);
        record.answers["capability.type"] = probed(csd.url);
        const report = validateIntake(record, "accept-jobs", { ...makeAuthority(record), csdRegistry: registry });
        if (p.unit === undefined) {
          expect(report.limitErrors, `${csd.url}#${p.key}`).toEqual(["safety.limits[0]: unit is not in the closed unit table"]);
        } else {
          expect(report.limitErrors, `${csd.url}#${p.key} (${p.unit})`).toEqual([]);
          checked += 1;
        }
      }
    }
    // %, degrees, km, min, kg, pages: infill, 4 lat/lng, distanceKm, deadlineMinutes, weightKg, pageCount, prepTimeMinutes
    expect(checked).toBe(10);
  });

  it("refuses duplicate quantities and never intersects them", () => {
    const wide = limit("volume", "mL", 1, 4);
    for (const duplicates of [
      [wide, wide],
      [wide, limit("volume", "uL", 1000, 4000)],
      [wide, limit(" Volume", "mL", 2, 3)],
    ]) {
      const report = labReport(duplicates);
      expect(report.ok).toBe(false);
      expect(report.limitErrors).toContain("safety.limits[1]: duplicate quantity (first at safety.limits[0])");
    }
  });

  it("reports every bad entry by index, in order, and never echoes a quantity or bound", () => {
    const report = labReport([
      limit("SENTINEL-quantity", "C", 1, 2),
      limit("bedTemp", "C", 30, 100),
      limit("travel", "kg", 1, 2),
      limit("bedTemp", "C", 40, 90),
    ]);
    expect(report.limitErrors).toEqual([
      "safety.limits[0]: quantity is not a number parameter of the selected CSD",
      "safety.limits[2]: unit does not match the CSD parameter's unit",
      "safety.limits[3]: duplicate quantity (first at safety.limits[1])",
    ]);
    expect(JSON.stringify(report)).not.toContain("SENTINEL-quantity");
  });

  it("limit bounds that are NaN or infinite, or min > max, are invalid values (not limit errors)", () => {
    for (const bad of [
      limit("bedTemp", "C", Number.NaN, 100),
      limit("bedTemp", "C", 30, Number.POSITIVE_INFINITY),
      limit("bedTemp", "C", Number.NEGATIVE_INFINITY, 100),
      limit("bedTemp", "C", 100, 30),
    ]) {
      const report = labReport([bad]);
      expect(report.ok).toBe(false);
      expect(report.invalidFields).toEqual(["safety.limits"]);
      expect(report.limitErrors).toEqual([]);
    }
  });

  it("resolves inherited parameters: a profile CSD can carry a limit on its base's number parameter", () => {
    const registry = labRegistry();
    registry.register(
      CsdSchema.parse({
        url: "pcc://capabilities/test-lab-profile/v1",
        version: "1.0.0",
        status: "active",
        name: "Lab rig profile",
        description: "inherits the lab rig's parameters",
        kind: "profile",
        baseDefinition: "pcc://capabilities/test-lab/v1",
        parameters: [],
        constraints: [],
        pricing: { basePrice: "1", currency: "USD" },
      }),
    );
    const report = labReport([limit("bedTemp", "C", 30, 100)], { type: "pcc://capabilities/test-lab-profile/v1", registry });
    expect(report.limitErrors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  describe("an unbound CSD cannot validate limits", () => {
    it("capability.type absent: a milestone requiring safety.limits is not ready", () => {
      const report = labReport([limit("bedTemp", "C", 30, 100)], { type: null });
      expect(report.ok).toBe(false);
      expect(report.limitErrors).toEqual(["unbound: no CSD"]);
      expect(report.missing).toContain("capability.type");
    });

    it("capability.type that names no registered CSD: not ready either", () => {
      const report = labReport([limit("bedTemp", "C", 30, 100)], { type: "pcc://capabilities/nonexistent/v9" });
      expect(report.ok).toBe(false);
      expect(report.limitErrors).toEqual(["unbound: no CSD"]);
    });

    it("a milestone that does not require safety.limits is not blocked by it, but duplicates are still refused", () => {
      const unbound = labReport([limit("bedTemp", "C", 30, 100)], { milestone: "register", type: null });
      expect(unbound.limitErrors).toEqual([]);
      expect(unbound.ok).toBe(true);
      const duplicated = labReport([limit("x", "C", 1, 2), limit("x", "C", 1, 2)], { milestone: "register", type: null });
      expect(duplicated.ok).toBe(false);
      expect(duplicated.limitErrors).toEqual(["safety.limits[1]: duplicate quantity (first at safety.limits[0])"]);
    });

    it("no safety.limits answer at all adds no limit error (the missing answer is reported as missing)", () => {
      const record = cloneRecord(buildFullValidRecord());
      delete record.answers["safety.limits"];
      delete record.answers["capability.type"];
      const report = ready(record, "accept-jobs");
      expect(report.limitErrors).toEqual([]);
      expect(report.missing).toEqual(expect.arrayContaining(["safety.limits", "capability.type"]));
    });

    it("authority.csdRegistry replaces the built-in lookup: a built-in url is unbound in a registry that lacks it", () => {
      const report = labReport([limit("infill", "%", 10, 90)], { type: "pcc://capabilities/fdm/v2" });
      expect(report.limitErrors).toEqual(["unbound: no CSD"]);
      // and without a custom registry the built-ins resolve
      const builtin = labReport([limit("infill", "%", 10, 90)], { type: "pcc://capabilities/fdm/v2", registry: null });
      expect(builtin.limitErrors).toEqual([]);
    });

    it("an unusable csdRegistry fails closed instead of throwing", () => {
      const record = buildFullValidRecord();
      const authority = { ...makeAuthority(record), csdRegistry: {} as unknown as CsdRegistry };
      const report = validateIntake(record, "accept-jobs", authority);
      expect(report.ok).toBe(false);
      expect(report.limitErrors).toEqual(["unbound: no CSD"]);
    });
  });
});

describe("validateIntake — estop none is not runnable by default (astra 120b, finding 4)", () => {
  const withEstop = (value: unknown, type: string | null = "pcc://capabilities/fdm/v2"): IntakeRecord => {
    const record = cloneRecord(buildFullValidRecord());
    record.answers["safety.estop"] = {
      ...human(value),
      confirmation: { eventId: "evt-safety.estop" },
    };
    if (type === null) delete record.answers["capability.type"];
    else record.answers["capability.type"] = probed(type);
    // The fixture's limit is fdm/v2's infill; limits are checked against whatever CSD is selected,
    // so a record retargeted at another capability drops them (publish does not require them).
    if (type !== "pcc://capabilities/fdm/v2") delete record.answers["safety.limits"];
    return record;
  };
  const none = { mechanism: "none" };

  it("the approved list is exactly the two office-printing capabilities, and frozen", () => {
    expect([...ESTOP_NONE_APPROVED_CAPABILITIES]).toEqual([
      "pcc://capabilities/2d-print/v1",
      "pcc://capabilities/document-print-and-mail/v1",
    ]);
    expect(Object.isFrozen(ESTOP_NONE_APPROVED_CAPABILITIES)).toBe(true);
  });

  it("blocks publish, accept-jobs and get-paid (which imply publish) on an unapproved capability", () => {
    for (const milestone of ["publish", "accept-jobs", "get-paid"] as const) {
      const report = ready(withEstop(none), milestone);
      expect(report.ok, milestone).toBe(false);
      expect(report.safetyBlocks, milestone).toEqual(['safety.estop: mechanism "none" is not approved for this capability']);
      expect(report.missing, milestone).toEqual([]);
    }
  });

  it("does not block milestones that do not imply publish: it stays an honest observation", () => {
    for (const milestone of ["register", "identify", "register-device", "tier1", "tier2", "optional"] as const) {
      expect(ready(withEstop(none), milestone).safetyBlocks, milestone).toEqual([]);
    }
  });

  it("never blocks hardware or adapter-stop, on any capability", () => {
    for (const value of [{ mechanism: "hardware" }, { mechanism: "adapter-stop", stopCommand: "M112" }]) {
      expect(ready(withEstop(value), "accept-jobs").safetyBlocks).toEqual([]);
    }
  });

  it("allows none on an approved capability (publish; the other checks still apply)", () => {
    for (const type of ESTOP_NONE_APPROVED_CAPABILITIES) {
      const report = ready(withEstop(none, type), "publish");
      expect(report.safetyBlocks, type).toEqual([]);
      expect(report.ok, type).toBe(true);
    }
  });

  it("blocks none when capability.type is absent, and for a lookalike of an approved url", () => {
    expect(ready(withEstop(none, null), "publish").safetyBlocks).toHaveLength(1);
    expect(ready(withEstop(none, "pcc://capabilities/2d-print/v1/"), "publish").safetyBlocks).toHaveLength(1);
    expect(ready(withEstop(none, "PCC://capabilities/2d-print/v1"), "publish").safetyBlocks).toHaveLength(1);
  });

  it("an approved capability can reach accept-jobs when its CSD is in the registry and limits bind (document-print-and-mail)", () => {
    const registry = new CsdRegistry();
    registry.register(CsdSchema.parse(printAndMailCsd));
    const record = withEstop(none, "pcc://capabilities/document-print-and-mail/v1");
    record.answers["safety.limits"] = limitsAnswer([limit("pageCount", "pages", 1, 100)]);
    const report = validateIntake(record, "accept-jobs", { ...makeAuthority(record), csdRegistry: registry });
    expect(report.limitErrors).toEqual([]);
    expect(report.safetyBlocks).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

// ── 13. Tier readiness fails closed (astra 120b, finding 5) ──────────────

const TIER_PRIMITIVE_IDS = [
  "approval.expert",
  "capture.photo_nonced",
  "ident.registered_key",
  "machine.execution_log",
  "measure.io_test_pair",
] as const;

/** Run `fn` with registry fields temporarily overridden, restoring them even if `fn` throws. */
function withPrimitiveFields<T>(
  overrides: Record<string, { status?: string; verifierStatus?: string }>,
  fn: () => T,
): T {
  const saved: [Record<string, unknown>, string, unknown][] = [];
  try {
    for (const [id, fields] of Object.entries(overrides)) {
      const def = getPrimitive(id) as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(fields)) {
        saved.push([def, key, def[key]]);
        def[key] = value;
      }
    }
    return fn();
  } finally {
    for (const [def, key, value] of saved.reverse()) def[key] = value;
  }
}

const everyTierPrimitiveLive = (): Record<string, { verifierStatus: string }> =>
  Object.fromEntries(TIER_PRIMITIVE_IDS.map((id) => [id, { verifierStatus: "live" }]));

describe("validateIntake — tier readiness fails closed (astra 120b, finding 5)", () => {
  const full = buildFullValidRecord();

  it("injects nothing: with the shipped registry tier1 and tier2 are NOT ready, and stubPrimitives is exact", () => {
    const tier1 = ready(full, "tier1");
    expect(tier1.ok).toBe(false);
    expect(tier1.stubPrimitives).toEqual(["ident.registered_key", "machine.execution_log", "measure.io_test_pair"]);
    expect(tier1.insubstantial).toEqual([]);
    expect(tier1.missing).toEqual([]);

    const tier2 = ready(full, "tier2");
    expect(tier2.ok).toBe(false);
    expect(tier2.stubPrimitives).toEqual([
      "approval.expert",
      "capture.photo_nonced",
      "ident.registered_key",
      "machine.execution_log",
      "measure.io_test_pair",
    ]);
    expect(tier2.insubstantial).toEqual([]);
  });

  it("only the tier milestones look at primitives", () => {
    for (const milestone of INTAKE_MILESTONES) {
      if (milestone === "tier1" || milestone === "tier2") continue;
      const report = ready(full, milestone);
      expect(report.stubPrimitives, milestone).toEqual([]);
      expect(report.insubstantial, milestone).toEqual([]);
    }
  });

  it("takes the status from the evidence registry, not from what the field declared", () => {
    // fields.ts declares every one of these as "stub"; flipping only the registry changes the result.
    withPrimitiveFields({ "machine.execution_log": { verifierStatus: "live" } }, () => {
      expect(ready(full, "tier1").stubPrimitives).toEqual(["ident.registered_key", "measure.io_test_pair"]);
    });
    expect(ready(full, "tier1").stubPrimitives).toContain("machine.execution_log"); // restored
  });

  it("is ready when every mapped primitive is live and the answers are substantive", () => {
    withPrimitiveFields(everyTierPrimitiveLive(), () => {
      for (const milestone of ["tier1", "tier2"] as const) {
        const report = ready(full, milestone);
        expect(report, `${milestone}: ${JSON.stringify(report)}`).toMatchObject({
          ok: true,
          stubPrimitives: [],
          insubstantial: [],
        });
      }
    });
  });

  it("a primitive that is live but not active, or active but planned, is still a stub", () => {
    for (const fields of [
      { status: "reserved", verifierStatus: "live" },
      { status: "deprecated", verifierStatus: "live" },
      { status: "active", verifierStatus: "planned" },
      { status: "active", verifierStatus: "stub" },
    ]) {
      withPrimitiveFields({ ...everyTierPrimitiveLive(), "machine.execution_log": fields }, () => {
        const report = ready(full, "tier1");
        expect(report.ok, JSON.stringify(fields)).toBe(false);
        expect(report.stubPrimitives, JSON.stringify(fields)).toEqual(["machine.execution_log"]);
      });
    }
  });

  it("a field that maps to a primitive the registry does not know is a stub too", () => {
    const field = INTAKE_FIELDS.find((f) => f.id === "evidence.controllerRunLog")!;
    const ref = field.evidencePrimitive as { id: string };
    const original = ref.id;
    ref.id = "no.such.primitive";
    try {
      withPrimitiveFields(everyTierPrimitiveLive(), () => {
        const report = ready(full, "tier1");
        expect(report.ok).toBe(false);
        expect(report.stubPrimitives).toEqual(["no.such.primitive"]);
      });
    } finally {
      ref.id = original;
    }
    expect(field.evidencePrimitive!.id).toBe("machine.execution_log");
  });

  it("every tier field that maps to an evidence primitive has a substance rule, and nothing else is ruled", () => {
    const mapped = INTAKE_FIELDS.filter(
      (f) => f.evidencePrimitive && f.requiredFor.some((m) => m === "tier1" || m === "tier2"),
    ).map((f) => f.id);
    expect(mapped.length).toBeGreaterThan(0);
    for (const id of mapped) expect(TIER_SUBSTANCE_RULE_FIELDS, id).toContain(id);
    for (const id of TIER_SUBSTANCE_RULE_FIELDS) {
      const field = INTAKE_FIELDS.find((f) => f.id === id)!;
      expect(field.requiredFor.some((m) => m === "tier1" || m === "tier2"), id).toBe(true);
    }
    // operatorPresence is the one tier field with no rule: always, sometimes and never are all honest.
    expect(TIER_SUBSTANCE_RULE_FIELDS).not.toContain("evidence.operatorPresence");
  });

  describe("an answer that satisfies its schema but proves nothing is insubstantial", () => {
    const camera = { seesWorkArea: true, seesOutput: true, mount: "fixed", captureDeviceId: "cam-1" };
    const rows: [string, string, "tier1" | "tier2", unknown][] = [
      ["calibration.lastDate", "an impossible day", "tier1", "2026-02-30"],
      ["calibration.lastDate", "month 13", "tier1", "2026-13-01"],
      ["calibration.lastDate", "month 00", "tier1", "2026-00-10"],
      ["calibration.lastDate", "Feb 29 in a common year", "tier1", "2023-02-29"],
      ["calibration.lastDate", "year 0000", "tier1", "0000-01-01"],
      ["calibration.procedureRef", "blank", "tier1", "   "],
      ["evidence.executorDeviceId", "blank", "tier1", "  "],
      ["evidence.observerDeviceIds", "a blank entry", "tier1", ["cam-1", "  "]],
      ["evidence.executionMode", "mock", "tier1", "mock"],
      ["evidence.executionMode", "dry_run", "tier1", "dry_run"],
      ["evidence.controllerRunLog", "controller does not export its own log", "tier1", { exportsOwnLogPerJob: false, access: "api" }],
      ["evidence.instrumentSignsOutput", "instrument does not sign", "tier1", false],
      ["evidence.referenceSample", "none available", "tier1", { available: false }],
      ["evidence.referenceSample", "available but no expected result", "tier1", { available: true }],
      ["evidence.referenceSample", "blank expected result", "tier1", { available: true, expectedResultRef: "  " }],
      ["evidence.camera", "sees neither", "tier2", { ...camera, seesWorkArea: false, seesOutput: false }],
      ["evidence.camera", "sees the work area but not the output", "tier2", { ...camera, seesOutput: false }],
      ["evidence.camera", "sees the output but not the work area", "tier2", { ...camera, seesWorkArea: false }],
      ["evidence.camera", "blank capture device", "tier2", { ...camera, captureDeviceId: "  " }],
      ["evidence.approver", "blank name", "tier2", { name: "   " }],
    ];

    it.each(rows)("%s: %s (%s)", (fieldId, _why, milestone, bad) => {
      const record = cloneRecord(full);
      record.answers[fieldId] = human(bad);
      const report = withPrimitiveFields(everyTierPrimitiveLive(), () => ready(record, milestone));
      expect(report.ok).toBe(false);
      expect(report.insubstantial).toEqual([fieldId]);
      expect(report.stubPrimitives).toEqual([]);
      expect(report.missing).toEqual([]);
      expect(report.invalidFields).toEqual([]);
    });

    it("the matching substantive values are accepted (leap day, empty observer list, never-present operator)", () => {
      const record = cloneRecord(full);
      record.answers["calibration.lastDate"] = human("2024-02-29");
      record.answers["evidence.observerDeviceIds"] = human([]);
      record.answers["evidence.operatorPresence"] = human("never");
      const report = withPrimitiveFields(everyTierPrimitiveLive(), () => ready(record, "tier2"));
      expect(report.ok).toBe(true);
    });

    it("a tier2-only answer does not matter for tier1, and tier fields do not matter for other milestones", () => {
      const weak = cloneRecord(full);
      weak.answers["evidence.camera"] = human({ ...camera, seesWorkArea: false, seesOutput: false });
      weak.answers["evidence.controllerRunLog"] = human({ exportsOwnLogPerJob: false, access: "api" });
      withPrimitiveFields(everyTierPrimitiveLive(), () => {
        expect(ready(weak, "tier1").insubstantial).toEqual(["evidence.controllerRunLog"]);
        expect(ready(weak, "tier2").insubstantial).toEqual(["evidence.camera", "evidence.controllerRunLog"]);
      });
      for (const milestone of ["publish", "accept-jobs", "get-paid"] as const) {
        const report = ready(weak, milestone);
        expect(report.insubstantial, milestone).toEqual([]);
        expect(report.ok, milestone).toBe(true);
      }
    });

    it("an absent or malformed tier answer is missing / invalid, not insubstantial", () => {
      const record = cloneRecord(full);
      delete record.answers["evidence.camera"];
      record.answers["evidence.approver"] = human("A. Approver"); // a string, not {name}
      const report = withPrimitiveFields(everyTierPrimitiveLive(), () => ready(record, "tier2"));
      expect(report.missing).toEqual(["evidence.camera", "evidence.approver"]);
      expect(report.invalidFields).toEqual(["evidence.approver"]);
      expect(report.insubstantial).toEqual([]);
    });
  });

  it("stub primitives and insubstantial answers are reported together, each on its own list", () => {
    const record = cloneRecord(full);
    record.answers["evidence.instrumentSignsOutput"] = human(false);
    const report = ready(record, "tier1");
    expect(report.ok).toBe(false);
    expect(report.stubPrimitives).toEqual(["ident.registered_key", "machine.execution_log", "measure.io_test_pair"]);
    expect(report.insubstantial).toEqual(["evidence.instrumentSignsOutput"]);
  });
});

// ── 14. The JSON Schema is documentation, and it fails rather than guesses (astra 120b, finding 6) ─

type JsonNode = Record<string, unknown>;

/** Every object node in a JSON-like tree, with its path. */
function walkJson(node: unknown, path: string, visit: (node: JsonNode, path: string) => void): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkJson(item, `${path}/${i}`, visit));
  } else if (node !== null && typeof node === "object") {
    visit(node as JsonNode, path);
    for (const [key, value] of Object.entries(node)) walkJson(value, `${path}/${key}`, visit);
  }
}

describe("buildIntakeJsonSchema — documentation only (astra 120b, finding 6)", () => {
  const schema = buildIntakeJsonSchema() as JsonNode & {
    properties: { answers: { properties: Record<string, JsonNode> } };
  };

  it("carries the operative warning as a top-level $comment and a machine-readable annotation", () => {
    expect(schema.$comment).toBe(
      "Documentation/projection only. Passing this schema is not PCC intake acceptance. Consumers must use the authoritative Zod record parser, per-field validation, milestone validation, and confirmation/secret-policy checks.",
    );
    expect(INTAKE_JSON_SCHEMA_COMMENT).toBe(schema.$comment);
    expect(schema["x-pcc-authority"]).toBe("documentation-only");
    // prominent: the first keys after the schema identity
    expect(Object.keys(schema).slice(0, 4)).toEqual(["$schema", "$id", "$comment", "x-pcc-authority"]);
  });

  it("contains no bare {} node and no accept-anything items anywhere", () => {
    expect(JSON.stringify(schema)).not.toContain('"items":{}');
    const empties: string[] = [];
    walkJson(schema, "", (node, path) => {
      if (Object.keys(node).length === 0) empties.push(path);
    });
    expect(empties).toEqual([]);
  });

  it("projects safety.limits items through their refinement, with a $comment on that node", () => {
    const limits = schema.properties.answers.properties["safety.limits"] as JsonNode & {
      properties: { value: { items: JsonNode; minItems: number } };
    };
    const items = limits.properties.value.items;
    expect(items).toMatchObject({
      type: "object",
      required: ["quantity", "unit", "min", "max"],
      additionalProperties: false,
      $comment: "refinements not represented",
    });
    expect(limits.properties.value.minItems).toBe(1);
  });

  it("encodes source-required-when-provenance-is-research-or-confirmed with if/then on every answer", () => {
    for (const field of INTAKE_FIELDS) {
      const answer = schema.properties.answers.properties[field.id]!;
      expect(answer.if, field.id).toEqual({
        properties: { provenance: { enum: ["research", "confirmed"] } },
        required: ["provenance"],
      });
      expect(answer.then, field.id).toEqual({ required: ["source"] });
    }
  });

  it("documents the optional strict confirmation reference and which fields need one", () => {
    for (const field of INTAKE_FIELDS) {
      const answer = schema.properties.answers.properties[field.id] as JsonNode & { properties: JsonNode };
      expect(answer.properties.confirmation, field.id).toEqual({
        type: "object",
        properties: { eventId: { type: "string", minLength: 1, maxLength: 256 } },
        required: ["eventId"],
        additionalProperties: false,
      });
      expect(answer["x-pcc-confirmationRequired"], field.id).toBe(CONFIRMATION_REQUIRED_FIELDS.includes(field.id));
    }
  });
});

describe("zodToJsonSchemaFragment — refuses to guess", () => {
  it("converts a refinement through its inner schema and flags the node", () => {
    const refined = z.number().int().refine((n) => n % 2 === 0, "even");
    expect(zodToJsonSchemaFragment(refined)).toEqual({ type: "integer", $comment: "refinements not represented" });
    const nested = z.array(z.object({ a: z.string() }).strict().refine(() => true));
    expect(zodToJsonSchemaFragment(nested)).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        additionalProperties: false,
        $comment: "refinements not represented",
      },
    });
  });

  it("still converts everything the field registry uses (so generation does not throw)", () => {
    for (const field of INTAKE_FIELDS) {
      expect(() => zodToJsonSchemaFragment(field.valueSchema), field.id).not.toThrow();
    }
  });

  it.each([
    ["unknown", z.unknown()],
    ["any", z.any()],
    ["record", z.record(z.string())],
    ["date", z.date()],
    ["nullable", z.string().nullable()],
    ["default", z.string().default("x")],
    ["tuple", z.tuple([z.string(), z.number()])],
    ["lazy", z.lazy(() => z.string())],
    ["intersection", z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() }))],
    ["a transform", z.string().transform((v) => v.length)],
    ["a preprocess", z.preprocess((v) => v, z.string())],
    ["an object catchall", z.object({ a: z.string() }).catchall(z.string())],
    ["an array of unknown", z.array(z.unknown())],
    ["an object holding an unsupported member", z.object({ a: z.unknown() })],
    ["a union holding an unsupported member", z.union([z.string(), z.unknown()])],
    ["a string check it does not project", z.string().uuid()],
    ["a string trim", z.string().trim()],
    ["a string startsWith", z.string().startsWith("x")],
  ])("throws on %s instead of emitting {}", (_name, schema) => {
    expect(() => zodToJsonSchemaFragment(schema as z.ZodTypeAny)).toThrow(/unsupported/);
  });

  it("throws on a number check kind it does not project (a kind a future zod might add)", () => {
    const schema = z.number();
    (schema._def.checks as unknown[]).push({ kind: "somethingNew" });
    expect(() => zodToJsonSchemaFragment(schema)).toThrow(/unsupported number check "somethingNew"/);
  });
});

// ── 15. Object keys: non-ASCII keys and NFKC (astra 120b, finding 7) ────────

describe("validateIntake — object keys come from a closed ASCII vocabulary (astra 120b, finding 7)", () => {
  const cyrillicA = String.fromCodePoint(0x430);
  const cameraWith = (extra: Record<string, unknown>) =>
    human({ seesWorkArea: true, seesOutput: true, mount: "fixed", captureDeviceId: "cam-1", ...extra });

  it("a Cyrillic-a look-alike of privateKey nested in a value makes the report not ok, by path only", () => {
    const key = `priv${cyrillicA}teKey`;
    const report = ready(withAnswer("evidence.camera", cameraWith({ [key]: "x" })), "register");
    expect(report.ok).toBe(false);
    expect(report.nonAsciiKeys).toEqual(["answers/evidence.camera/value/priv\\u{430}teKey"]);
    expect(report.invalidFields).toEqual(["evidence.camera"]); // the strict field schema refuses it too
    expect(JSON.stringify(report)).not.toContain(key);
  });

  it("a non-ASCII key anywhere in a value or a source is reported with its full path", () => {
    const deep = human({ available: true, expectedResultRef: "x", nested: { list: [{ [`k${cyrillicA}`]: 1 }] } });
    const report = ready(withAnswer("evidence.referenceSample", deep), "register");
    expect(report.nonAsciiKeys).toEqual(["answers/evidence.referenceSample/value/nested/list/0/k\\u{430}"]);

    const sourced = withAnswer("calibration.procedureRef", {
      value: "Prusa bed-leveling procedure v2",
      provenance: "confirmed",
      source: { doc: "manual", [`s${String.fromCodePoint(0xe9)}ction`]: "x" },
    });
    const sourcedReport = ready(sourced, "register");
    expect(sourcedReport.ok).toBe(false);
    expect(sourcedReport.nonAsciiKeys).toEqual(["answers/calibration.procedureRef/source/s\\u{e9}ction"]);
    // the strict source schema fails the parse, and the key is still reported from the raw input
    expect(sourcedReport.structuralErrors).toEqual(["answers/calibration.procedureRef/source: unrecognized_keys"]);
  });

  it("a non-ASCII field id is reported too (as unknown and as a non-ASCII key)", () => {
    const record = cloneRecord(buildFullValidRecord());
    (record.answers as Record<string, IntakeAnswer>)[`caf${String.fromCodePoint(0xe9)}.menu`] = human("x");
    const report = ready(record, "register");
    expect(report.ok).toBe(false);
    expect(report.nonAsciiKeys).toEqual(["answers/caf\\u{e9}.menu"]);
    expect(report.unknownFields).toEqual(["caf\\u{e9}.menu"]);
  });

  it("an all-ASCII record, and non-ASCII text in VALUES, are not affected", () => {
    expect(ready(buildFullValidRecord(), "accept-jobs").nonAsciiKeys).toEqual([]);
    const accented = withAnswer("device.description", human("Imprimante de bureau, modèle résistant"));
    const report = ready(accented, "identify");
    expect(report.nonAsciiKeys).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("ASCII is up to and including DEL (0x7f); the first non-ASCII character is 0x80", () => {
    const camera = (key: string) => cameraWith({ [key]: "x" });
    expect(ready(withAnswer("evidence.camera", camera(`a${String.fromCharCode(0x7f)}`)), "register").nonAsciiKeys).toEqual([]);
    expect(ready(withAnswer("evidence.camera", camera(`a${String.fromCharCode(0x80)}`)), "register").nonAsciiKeys).toEqual([
      "answers/evidence.camera/value/a\\u{80}",
    ]);
  });

  it("never echoes a secret-looking non-ASCII key", () => {
    const key = `${FAKE.pem}${cyrillicA}`;
    const report = ready(withAnswer("evidence.camera", cameraWith({ [key]: "x" })), "register");
    expect(report.nonAsciiKeys).toEqual(["answers/evidence.camera/value/[redacted:pem]"]);
    expect(JSON.stringify(report)).not.toContain("PRIVATE KEY");
  });

  it("finds a non-ASCII key at any depth without overflowing the stack", () => {
    let nested: unknown = { [`z${cyrillicA}`]: 1 };
    for (let i = 0; i < 50000; i++) nested = { a: nested };
    const report = ready(withAnswer("evidence.camera", cameraWith({ extra: nested })), "register");
    expect(report.ok).toBe(false);
    expect(report.nonAsciiKeys).toHaveLength(1);
    expect(report.nonAsciiKeys[0]!.endsWith("/z\\u{430}")).toBe(true);
  });

  describe("forbidden keys are compared after NFKC normalization", () => {
    const fullWidth = (text: string): string =>
      [...text].map((ch) => String.fromCodePoint(ch.codePointAt(0)! + 0xfee0)).join("");
    const sampleWith = (key: string) => withAnswer("evidence.referenceSample", human({ available: true, [key]: "smuggled" }));

    it("a full-width spelling of privateKey is a forbidden key (and, being non-ASCII, a non-ASCII key)", () => {
      const key = fullWidth("privateKey");
      const report = ready(sampleWith(key), "register");
      expect(report.ok).toBe(false);
      expect(report.forbiddenKeys).toHaveLength(1);
      expect(report.forbiddenKeys[0]!.startsWith("evidence.referenceSample.")).toBe(true);
      expect(report.forbiddenKeys[0]).not.toContain(key); // written as \u{hex}, not echoed raw
      expect(report.nonAsciiKeys).toHaveLength(1);
    });

    it("a ligature spelling (the fi in verified) is a forbidden key too", () => {
      const key = `veri${String.fromCodePoint(0xfb01)}ed`;
      const report = ready(sampleWith(key), "register");
      expect(report.forbiddenKeys).toEqual([`evidence.referenceSample.veri\\u{fb01}ed`]);
    });

    it("a look-alike from another script is not folded by NFKC — it is refused as a non-ASCII key instead", () => {
      const key = `priv${cyrillicA}teKey`;
      const report = ready(sampleWith(key), "register");
      expect(report.forbiddenKeys).toEqual([]);
      expect(report.nonAsciiKeys).toHaveLength(1);
      expect(report.ok).toBe(false);
    });

    it("the ASCII variants keep matching", () => {
      const report = ready(sampleWith("Private_Key"), "register");
      expect(report.forbiddenKeys).toEqual(["evidence.referenceSample.Private_Key"]);
    });
  });
});

describe("astra pack 120b", () => {
  it("baseline: the full fixture is ok for identify (else the cases below prove nothing)", () => {
    expect(ready(buildFullValidRecord(), "identify").ok).toBe(true);
  });

  it("CRITICAL 1a: a PEM private key in device.description is refused", () => {
    const report = ready(withAnswer("device.description", human(FAKE.pem)), "identify");
    expect(report.ok).toBe(false);
    expect(report.secretsInText).toEqual([{ path: "answers/device.description/value", kind: "pem" }]);
  });

  it("CRITICAL 1b: a 64-hex secret candidate in device.description is refused", () => {
    const report = ready(withAnswer("device.description", human("key 0x" + "ab".repeat(32))), "identify");
    expect(report.ok).toBe(false);
    expect(report.secretsInText).toEqual([{ path: "answers/device.description/value", kind: "hex-secret" }]);
  });

  it("CRITICAL 1c: a payout address in device.description is refused", () => {
    const report = ready(withAnswer("device.description", human("pay " + FAKE.address)), "identify");
    expect(report.ok).toBe(false);
    expect(report.secretsInText).toEqual([{ path: "answers/device.description/value", kind: "payout-address" }]);
  });

  it("CRITICAL 1d: a street address in device.description is refused", () => {
    const report = ready(withAnswer("device.description", human("Printer lives at 1600 Pennsylvania Avenue")), "identify");
    expect(report.ok).toBe(false);
    expect(report.secretsInText).toEqual([{ path: "answers/device.description/value", kind: "street-address" }]);
  });

  it("HIGH 2a: a confirmed safety.limits answer with no source fails through validateIntake", () => {
    const answer = {
      value: [{ quantity: "bed temperature", unit: "C", min: 0, max: 120 }],
      provenance: "confirmed",
      confirmation: { eventId: "evt-safety.limits" },
    };
    const report = ready(withAnswer("safety.limits", answer), "accept-jobs");
    expect(report.ok).toBe(false);
    expect(report.structuralErrors).toEqual(['answers/safety.limits/source: provenance "confirmed" requires a source']);
  });

  it("HIGH 2b: an invalid provenance on a required field fails", () => {
    const report = ready(withAnswer("device.description", { value: "A printer.", provenance: "garbage" }), "identify");
    expect(report.ok).toBe(false);
    expect(report.structuralErrors).toEqual(["answers/device.description/provenance: invalid_enum_value"]);
  });

  it("HIGH 2c: a malformed answered field outside the milestone still fails", () => {
    const answer = {
      value: [{ quantity: "bed temperature", unit: "C", min: 10, max: 1 }],
      provenance: "confirmed",
      source: { doc: "m", section: "s" },
      confirmation: { eventId: "evt-safety.limits" },
    };
    const report = ready(withAnswer("safety.limits", answer), "register");
    expect(report.ok).toBe(false);
    expect(report.invalidFields).toEqual(["safety.limits"]);
  });

  it("HIGH 3a: research-provenance capability.parameters (humanConfirmRequired) does not make publish ready", () => {
    const answer = {
      value: [{ key: "infill", min: 0, max: 100, unit: "%" }],
      provenance: "research",
      source: { doc: "manual", section: "specs" },
    };
    const report = ready(withAnswer("capability.parameters", answer), "publish");
    expect(report.ok).toBe(false);
    expect(report.neverDefaultViolations).toEqual(["capability.parameters"]);
    expect(report.unconfirmed).toEqual(["capability.parameters"]);
  });

  it("HIGH 3b: a caller-written 'confirmed' label alone (no authenticated confirmation) does not make publish ready", () => {
    const report = validateIntake(buildFullValidRecord(), "publish");
    expect(report.ok).toBe(false);
    expect(report.unconfirmed).toContain("capability.parameters");
    // ... and stripping the references leaves nothing for a full authority to resolve either
    const stripped = cloneRecord(buildFullValidRecord());
    for (const id of CONFIRMATION_REQUIRED_FIELDS) {
      const { confirmation: _dropped, ...rest } = stripped.answers[id]!;
      stripped.answers[id] = rest;
    }
    expect(validateIntake(stripped, "publish", makeAuthority(buildFullValidRecord())).ok).toBe(false);
  });

  it("HIGH 3c: payout.destination {set:true} alone (no payout-store read) does not make get-paid ready", () => {
    expect(validateIntake(buildFullValidRecord(), "get-paid").ok).toBe(false);
    const report = ready(buildFullValidRecord(), "get-paid", { payout: false });
    expect(report.ok).toBe(false);
    expect(report.unverified).toEqual(["payout.destination"]);
  });

  it("HIGH 4a: conflicting duplicate limits for one quantity are refused", () => {
    const answer = limitsAnswer([
      { quantity: "volume", unit: "uL", min: 1, max: 1000 },
      { quantity: "volume", unit: "mL", min: 10, max: 20 },
    ]);
    const report = ready(withAnswer("safety.limits", answer), "register");
    expect(report.ok).toBe(false);
    expect(report.limitErrors).toContain("safety.limits[1]: duplicate quantity (first at safety.limits[0])");
  });

  it("HIGH 4b: estop mechanism none does not make accept-jobs ready", () => {
    const answer = { ...human({ mechanism: "none" }), confirmation: { eventId: "evt-safety.estop" } };
    const report = ready(withAnswer("safety.estop", answer), "accept-jobs");
    expect(report.ok).toBe(false);
    expect(report.safetyBlocks).toEqual(['safety.estop: mechanism "none" is not approved for this capability']);
  });

  it("HIGH 5a: tier2 is not ready while its required primitives are stub", () => {
    const report = ready(buildFullValidRecord(), "tier2");
    expect(report.ok).toBe(false);
    expect(report.stubPrimitives).toEqual([
      "approval.expert",
      "capture.photo_nonced",
      "ident.registered_key",
      "machine.execution_log",
      "measure.io_test_pair",
    ]);
  });

  it("HIGH 5b: a camera that sees neither work area nor output does not count for tier2", () => {
    const answer = human({ seesWorkArea: false, seesOutput: false, mount: "fixed", captureDeviceId: "cam-1" });
    const record = withAnswer("evidence.camera", answer);
    expect(ready(record, "tier2").ok).toBe(false);
    // ... and it is the camera, not just the stubs, that fails once the primitives are live
    const live = withPrimitiveFields(everyTierPrimitiveLive(), () => ready(record, "tier2"));
    expect(live.ok).toBe(false);
    expect(live.insubstantial).toEqual(["evidence.camera"]);
  });

  it("HIGH 5c: a malformed execution mode caps at 0, not the no-cap 3", () => {
    expect(executionModeTierCap(withAnswer("evidence.executionMode", probed("MOCK")))).toBe(0);
  });

  it("MEDIUM 6a: the generated JSON Schema says it is documentation only", () => {
    expect(JSON.stringify(buildIntakeJsonSchema())).toMatch(/Documentation\/projection only/);
  });

  it("MEDIUM 6b: the generated safety.limits items schema is not the accept-anything {}", () => {
    const text = JSON.stringify(buildIntakeJsonSchema());
    expect(text.includes('"items":{}')).toBe(false);
  });

  it("MEDIUM 7: a Cyrillic-a 'privateKey' key nested in a value is caught", () => {
    const key = "priv" + String.fromCodePoint(0x430) + "teKey";
    const answer = human({ seesWorkArea: true, seesOutput: true, mount: "fixed", captureDeviceId: "cam-1", [key]: "x" });
    const report = ready(withAnswer("evidence.camera", answer), "register");
    expect(report.ok).toBe(false);
    expect(report.nonAsciiKeys).toHaveLength(1);
  });

  it("MEDIUM 8a: a whitespace-only citation is refused", () => {
    const finding = {
      claim: "max bed temp",
      value: 120,
      unit: "C",
      citation: { doc: " ", section: " " },
      retrievedAt: "2026-09-01T00:00:00Z",
    };
    expect(ResearchFindingSchema.safeParse(finding).success).toBe(false);
  });

  it("MEDIUM 8b: 'Run the downloaded driver.' instructs execution", () => {
    expect(entryInstructsExecution({ ...RESEARCH_LIBRARY[0]!, prompt: "Run the downloaded driver." })).toBe(true);
  });

  it("MEDIUM 8c: a negation elsewhere does not excuse a later instruction", () => {
    expect(entryInstructsExecution({ ...RESEARCH_LIBRARY[0]!, prompt: "Do not install A. Execute B." })).toBe(true);
  });

  it("MEDIUM 8d: an instruction in searches is caught too", () => {
    const entry = RESEARCH_LIBRARY[0]!;
    expect(entryInstructsExecution({ ...entry, searches: [...entry.searches, "then flash firmware to the device"] })).toBe(true);
  });
});
