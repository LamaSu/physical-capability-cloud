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
  IntakeSourceSchema,
  validateIntake,
  normalizeIntakeLimits,
  executionModeTierCap,
  NO_EXECUTION_MODE_CAP,
  intakeFieldArtifactMap,
  scanIntakeStrings,
  redactIntakeSecrets,
  NOT_PLAIN_DATA_PLACEHOLDER,
  INTAKE_SECRET_KINDS,
  CONFIRMATION_REQUIRED_FIELDS,
  ESTOP_NONE_APPROVED_CAPABILITIES,
  REVIEWED_COUNT_PARAMETERS,
  UNITLESS_LIMIT_UNIT,
  intakeValueHash,
  type IntakeAnswer,
  type IntakeAuthority,
  type IntakeConfirmationEvent,
  type IntakeRecord,
  type IntakeSecretKind,
  type IntakeSubject,
} from "../onboarding/intake/index.js";
import { BIP39_ENGLISH_WORDLIST } from "../onboarding/intake/bip39-english.js";
import { TIER_SUBSTANCE_RULE_FIELDS } from "../onboarding/intake/tier-readiness.js";
import { getPrimitive, EVIDENCE_PRIMITIVES } from "../evidence/primitives.js";
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
    expect([...MILESTONE_IMPLIES["tier1-intake-complete"]].sort()).toEqual(
      ["identify", "register", "register-device", "tier1-intake-complete"].sort(),
    );
    expect([...MILESTONE_IMPLIES["tier2-intake-complete"]].sort()).toEqual(
      ["identify", "register", "register-device", "tier1-intake-complete", "tier2-intake-complete"].sort(),
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

  it("contentHash is optional and, when present, must be sha256: + 64 lowercase hex (item 7)", () => {
    const hash = `sha256:${"ab".repeat(32)}`;
    expect(accepts({ doc: "manual", contentHash: hash })).toBe(true);
    expect(accepts({ doc: "manual" })).toBe(true); // still optional
    for (const bad of [
      `sha256:${"AB".repeat(32)}`, // uppercase
      `sha256:${"ab".repeat(31)}ab1`, // 63 hex
      `sha256:${"ab".repeat(32)}0`, // 65 hex
      `sha1:${"ab".repeat(32)}`, // wrong algorithm label
      `${"ab".repeat(32)}`, // missing the sha256: prefix
      `sha256: ${"ab".repeat(32)}`, // a space after the colon
      `sha256:${"zz".repeat(32)}`, // non-hex characters
    ]) {
      expect(accepts({ doc: "manual", contentHash: bad }), bad).toBe(false);
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
    "capability.type": human("pcc://capabilities/fdm/v2"),
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

/** A human-confirmed capability.type answer, pointing at its confirmation event (it is confirmation-required). */
function typeAnswer(type: string): IntakeAnswer {
  return { ...human(type), confirmation: { eventId: "evt-capability.type" } };
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

/** The authenticated subject `makeAuthority` builds for by default — matches
 *  `confirmationEvent()`'s own defaults (principal/deviceRef/projectRef). */
const DEFAULT_SUBJECT: IntakeSubject = { operatorRef: "operator:acme", deviceRef: "dev-1", projectRef: "proj-1" };

interface StubAuthorityOptions {
  /** What the payout store says (default: a destination exists). */
  payout?: boolean;
  /** Edit the events after they are derived from the record. */
  events?: (events: Map<string, IntakeConfirmationEvent>) => void;
  /** Override the authenticated subject (default: DEFAULT_SUBJECT). */
  subject?: IntakeSubject;
}

/** A Map-backed authority holding exactly the events the record's confirmation refs name. */
function makeAuthority(record: IntakeRecord, options: StubAuthorityOptions = {}): IntakeAuthority {
  const events = new Map<string, IntakeConfirmationEvent>();
  for (const [fieldId, answer] of Object.entries(record.answers)) {
    if (answer.confirmation) events.set(answer.confirmation.eventId, confirmationEvent(fieldId, answer));
  }
  options.events?.(events);
  const payout = options.payout ?? true;
  return {
    subject: options.subject ?? DEFAULT_SUBJECT,
    resolveConfirmation: (eventId) => events.get(eventId) ?? null,
    payoutDestination: (operatorRef) => ({ operatorRef, exists: payout }),
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

  it("is `ok` for EVERY milestone, tiers included, when its confirmation events resolve and a payout destination exists (item 4: the stub-primitive gate is removed)", () => {
    for (const milestone of INTAKE_MILESTONES) {
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
        insubstantial: [],
      });
      expect(report).not.toHaveProperty("stubPrimitives");
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

  it("a tier2-intake-complete check also requires tier1-intake-complete fields (and, transitively, register-device)", () => {
    const record = cloneRecord(buildFullValidRecord());
    delete record.answers["evidence.executorDeviceId"]; // required for "tier1-intake-complete"
    delete record.answers["device.vendor"]; // required for "register-device"

    const tier1Report = validateIntake(record, "tier1-intake-complete");
    expect(tier1Report.ok).toBe(false);
    expect(tier1Report.missing).toEqual(expect.arrayContaining(["evidence.executorDeviceId", "device.vendor"]));

    const tier2Report = validateIntake(record, "tier2-intake-complete");
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

/** The INTAKE_FORBIDDEN_KEYS spelling `variant` normalizes to (case/underscore/hyphen-loose),
 *  mirroring index.ts's own normalization — used to predict the CANONICAL spelling
 *  `forbiddenKeys` now reports (item 5: never the raw key). */
function canonicalForbiddenKeyFor(variant: string): string {
  const normalized = variant.toLowerCase().replace(/[_-]/g, "");
  return INTAKE_FORBIDDEN_KEYS.find((k) => k.toLowerCase().replace(/[_-]/g, "") === normalized)!;
}

describe("validateIntake — forbidden keys are always refused", () => {
  it.each(INTAKE_FORBIDDEN_KEYS)("refuses forbidden key %s inside an answer's value", (key) => {
    const record = cloneRecord(buildFullValidRecord());
    record.answers["evidence.referenceSample"] = human({
      available: true,
      expectedResultRef: "cube-20mm",
      [key]: "smuggled",
    });
    const report = validateIntake(record, "tier1-intake-complete");
    expect(report.ok).toBe(false);
    // These are already their own canonical spelling, so raw === canonical here.
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
    const report = validateIntake(record, "tier1-intake-complete");
    expect(report.forbiddenKeys).toContain("calibration.procedureRef.freshness");
  });

  it("refuses a forbidden key used directly as a field id, and never echoes the raw unknown field id (item 5)", () => {
    const record = cloneRecord(buildFullValidRecord());
    (record.answers as Record<string, IntakeAnswer>).verificationResult = human(true);
    const report = validateIntake(record, "register");
    // "verificationResult" IS the canonical spelling, so it's shown verbatim here.
    expect(report.forbiddenKeys).toContain("verificationResult");
    // But it is also an unknown field id (not an INTAKE_FIELD_IDS entry, and not
    // in the key vocabulary either), so it is shown only as its pathSegment token.
    expect(report.unknownFields).not.toContain("verificationResult");
    expect(report.unknownFields).toHaveLength(1);
    expect(report.unknownFields[0]).toMatch(/^#[0-9a-f]{12}$/);
    expect(JSON.stringify(report.unknownFields)).not.toContain("verificationResult");
  });
});

// ── 6b. Forbidden keys match loosely: case/underscore/hyphen-insensitive ──
// (review fix — was exact-match only). Item 5: the report names the CANONICAL
// INTAKE_FORBIDDEN_KEYS spelling, never the raw variant the caller wrote.

describe("validateIntake — forbidden keys match loosely (case/underscore/hyphen-insensitive)", () => {
  it.each([
    "assurance_tier",
    "AssuranceTier",
    "ASSURANCE_TIER",
    "private-key",
    "PrivateKey",
    "HASH",
    "device_key_binding",
  ])("treats %s as a variant of its canonical forbidden key, reported as the CANONICAL spelling", (variant) => {
    const record = cloneRecord(buildFullValidRecord());
    record.answers["evidence.referenceSample"] = human({
      available: true,
      expectedResultRef: "cube-20mm",
      [variant]: "smuggled",
    });
    const report = validateIntake(record, "tier1-intake-complete");
    expect(report.ok).toBe(false);
    expect(report.forbiddenKeys).toContain(`evidence.referenceSample.${canonicalForbiddenKeyFor(variant)}`);
    expect(report.forbiddenKeys.join(" ")).not.toContain(variant);
  });

  it("treats a loose-variant field id as forbidden too, reported as the bare canonical spelling", () => {
    const record = cloneRecord(buildFullValidRecord());
    (record.answers as Record<string, IntakeAnswer>)["Assurance-Tier"] = human(true);
    const report = validateIntake(record, "register");
    expect(report.ok).toBe(false);
    expect(report.forbiddenKeys).toContain("assuranceTier");
    expect(report.forbiddenKeys).not.toContain("Assurance-Tier");
  });

  it("still refuses the exact canonical spelling (loose matching doesn't regress exact matches)", () => {
    const record = cloneRecord(buildFullValidRecord());
    record.answers["evidence.referenceSample"] = human({
      available: true,
      freshness: "now",
    });
    const report = validateIntake(record, "tier1-intake-complete");
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

/** The pathSegment token index.ts computes for a key outside the closed intake
 *  vocabulary: "#" + the first 12 hex digits of sha256(utf8(key)) (item 5). */
function unknownKeyToken(raw: string): string {
  return `#${createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12)}`;
}

describe("validateIntake — unknown fields", () => {
  it("reports a field id that isn't in the registry, as its pathSegment token, never the raw id (item 5)", () => {
    const record = cloneRecord(buildFullValidRecord());
    (record.answers as Record<string, IntakeAnswer>)["bogus.field"] = human("x");
    const report = validateIntake(record, "register");
    expect(report.ok).toBe(false);
    expect(report.unknownFields).toContain(unknownKeyToken("bogus.field"));
    expect(report.unknownFields).not.toContain("bogus.field");
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
  skProj: "sk-" + "proj-" + "A".repeat(40),
  skSvcacct: "sk-" + "svcacct-" + "A".repeat(20),
  awsAccessKeyId: "AK" + "IA" + "ABCDEFGHIJKLMNOP",
  awsSessionTokenId: "AS" + "IA" + "ABCDEFGHIJKLMNOP",
  googleApiKey: "AI" + "za" + "x".repeat(35),
  slack: "xo" + "xb-" + "1234567890-abcdefghij",
  githubClassic: "gh" + "p_" + "a".repeat(36),
  githubFineGrained: "github" + "_pat_" + "A1".repeat(20),
  gitlab: "glpat" + "-" + "A".repeat(20),
  huggingface: "hf" + "_" + "A".repeat(30),
  npmToken: "npm" + "_" + "A".repeat(36),
  sendgrid: "SG" + "." + "A".repeat(16) + "." + "B".repeat(16),
  azureAccountKey: "Account" + "Key=" + "A".repeat(40),
  pccLive: "pcc_" + "live_" + "A1b2C3d4E5f6G7h8I9",
  pccOracle: "pcc_" + "oracle_" + "A1b2C3d4E5f6G7h8I9",
  pccTest: "pcc_" + "test_" + "A1b2C3d4E5f6G7h8I9",
  jwt: ["ey" + "JhbGciOiJIUzI1NiJ9", "ey" + "JzdWIiOiJ4eHh4eHgifQ", "sig" + "nature12345"].join("."),
  labeledApiKey: "api" + "_key: " + "abcd1234efgh5678",
  labeledPassword: "password" + "=" + "Sup3rSecretValue!",
  bearerToken: "Bearer" + " " + "A".repeat(24),
  hex64: "ab".repeat(32),
  hex64Prefixed: "0x" + "AB".repeat(32),
  address: "0x" + "282Fa9C122b433864f8C8a8F2EfE411b52067539",
  mnemonic12: BIP39_ENGLISH_WORDLIST.slice(100, 112).join(" "),
  street: "1600 Pennsylvania Avenue",
  streetWay: "1 Hacker Way",
  streetLane: "12 Elm Lane",
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
    ["vendor-key", FAKE.skProj],
    ["vendor-key", FAKE.skSvcacct],
    ["vendor-key", FAKE.awsAccessKeyId],
    ["vendor-key", FAKE.awsSessionTokenId],
    ["vendor-key", FAKE.googleApiKey],
    ["vendor-key", FAKE.slack],
    ["vendor-key", FAKE.githubClassic],
    ["vendor-key", FAKE.githubFineGrained],
    ["vendor-key", FAKE.gitlab],
    ["vendor-key", FAKE.huggingface],
    ["vendor-key", FAKE.npmToken],
    ["vendor-key", FAKE.sendgrid],
    ["vendor-key", FAKE.azureAccountKey],
    ["vendor-key", FAKE.pccLive],
    ["vendor-key", FAKE.pccOracle],
    ["vendor-key", FAKE.pccTest],
    ["vendor-key", FAKE.jwt],
    ["labeled-secret", FAKE.labeledApiKey],
    ["labeled-secret", FAKE.labeledPassword],
    ["labeled-secret", FAKE.bearerToken],
    ["hex-secret", FAKE.hex64],
    ["hex-secret", FAKE.hex64Prefixed],
    ["payout-address", FAKE.address],
    ["mnemonic", FAKE.mnemonic12],
    ["street-address", FAKE.street],
    ["street-address", FAKE.streetWay],
    ["street-address", FAKE.streetLane],
  ] as const)("flags %s", (kind, secret) => {
    expect(kindsIn(`note: ${secret} end`)).toEqual([kind]);
  });

  it("covers exactly the seven kinds (labeled-secret added after vendor-key), each exercised above", () => {
    expect([...INTAKE_SECRET_KINDS]).toEqual([
      "pem",
      "vendor-key",
      "labeled-secret",
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
      "2 Lane conveyor",
      "password: see the manual", // no digit in the value
      "the token field", // no value at all (no colon/equals)
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
    "1 Hacker Way",
    "12 Elm Lane",
  ])("flags %s", (address) => {
    expect(kindsIn(`ships to ${address}, thanks`)).toEqual(["street-address"]);
  });

  it("is case-sensitive on the capitals and needs a street type", () => {
    for (const text of [
      "3 drive bays",
      "4 way valve",
      "2 Lane conveyor",
      "12 steps to the Court",
      "100 Mile House",
      "2 Print Shops",
    ]) {
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

  it("never returns the matched text, not even through a key in the path — an unknown key becomes its token (item 5)", () => {
    const tree = { answers: { [FAKE.stripeLive]: { value: FAKE.pem, other: FAKE.address } } };
    const hits = scanIntakeStrings(tree);
    expect(hits.map((h) => h.kind)).toEqual(["pem", "payout-address"]);
    const out = JSON.stringify(hits);
    for (const secret of Object.values(FAKE)) expect(out).not.toContain(secret);
    expect(hits[0]!.path).toBe(`answers/${unknownKeyToken(FAKE.stripeLive)}/value`);
  });

  it("hashes any key outside the closed vocabulary — including one with pointer-special or non-ASCII characters — never echoing it (item 5)", () => {
    const lookalike = "priv" + String.fromCodePoint(0x430) + "te";
    const hits = scanIntakeStrings({ "a/b~c": { [lookalike]: FAKE.hex64 } });
    expect(hits).toEqual([{ path: `${unknownKeyToken("a/b~c")}/${unknownKeyToken(lookalike)}`, kind: "hex-secret" }]);
  });

  it("walks the own properties of a class instance too, not only plain objects", () => {
    class Approver {
      name = FAKE.hex64;
    }
    // "evidence.approver" is a real field id and "name" a schema property name,
    // so both are in the closed vocabulary and stay verbatim.
    expect(scanIntakeStrings({ answers: { "evidence.approver": { value: new Approver() } } })).toEqual([
      { path: "answers/evidence.approver/value/name", kind: "hex-secret" },
    ]);
    // Redaction copies plain JSON data only (steward #5225): a class instance is not, so the record
    // is not logged at all and a fixed placeholder stands in.
    expect(redactIntakeSecrets({ approver: new Approver() })).toBe(NOT_PLAIN_DATA_PLACEHOLDER);
  });

  it("terminates on a cyclic structure and on very deep nesting", () => {
    const cyclic: Record<string, unknown> = { text: FAKE.hex64 };
    cyclic.self = cyclic;
    expect(scanIntakeStrings(cyclic)).toEqual([{ path: unknownKeyToken("text"), kind: "hex-secret" }]);

    let deep: unknown = FAKE.address;
    for (let i = 0; i < 100000; i++) deep = [deep];
    expect(scanIntakeStrings(deep)).toHaveLength(1);
  });
});

describe("scanIntakeStrings — the contentHash exemption (item 7)", () => {
  const digest = `sha256:${"ab".repeat(32)}`;

  it("does not flag the digest at exactly answers/<field>/source/contentHash", () => {
    const hits = scanIntakeStrings({
      answers: {
        "calibration.procedureRef": {
          value: "Prusa bed-leveling procedure v2",
          provenance: "confirmed",
          source: { doc: "manual", section: "specs", contentHash: digest },
        },
      },
    });
    expect(hits).toEqual([]);
  });

  it("still flags the identical 64-hex digest when it appears in value, or at any other path", () => {
    // In an answer's value.
    expect(kindsIn(`copied: ${digest}`)).toEqual(["hex-secret"]);

    // At a path that is NOT answers/<field>/source/contentHash — here it's doc, not contentHash.
    const notTheExemptPath = scanIntakeStrings({
      answers: {
        "calibration.procedureRef": {
          value: "v2",
          provenance: "confirmed",
          source: { doc: digest, section: "specs", contentHash: digest },
        },
      },
    });
    // The "doc" copy is flagged; the "contentHash" copy at the exact exempt path is not.
    expect(notTheExemptPath).toEqual([{ path: "answers/calibration.procedureRef/source/doc", kind: "hex-secret" }]);
  });

  it("still flags a malformed form of the digest (e.g. uppercase) even at the exempt path", () => {
    const uppercase = `sha256:${"AB".repeat(32)}`;
    const hits = scanIntakeStrings({
      answers: {
        "calibration.procedureRef": {
          value: "v2",
          provenance: "confirmed",
          // Bypasses IntakeSourceSchema's own regex (a hostile/malformed caller might).
          source: { doc: "manual", contentHash: uppercase } as Record<string, unknown> as never,
        },
      },
    });
    expect(hits).toEqual([{ path: "answers/calibration.procedureRef/source/contentHash", kind: "hex-secret" }]);
  });

  it("the 120c reproduction: a research citation's contentHash copied into an answer's source validates, with no secret hit", () => {
    expect(IntakeSourceSchema.safeParse({ doc: "manual", section: "specs", contentHash: digest }).success).toBe(true);
    const hits = scanIntakeStrings({
      answers: {
        "calibration.procedureRef": {
          value: "v2",
          provenance: "confirmed",
          source: { doc: "manual", section: "specs", contentHash: digest },
        },
      },
    });
    expect(hits).toEqual([]);
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
    // Every key here is a real INTAKE_FIELD_IDS entry, so all are in the vocabulary and kept verbatim.
    expect(Object.keys(out.answers).sort()).toEqual([...INTAKE_FIELD_IDS]);
    expect(out.answers["operator.displayName"]).toEqual(buildFullValidRecord().answers["operator.displayName"]);
    expect(redactIntakeSecrets(out)).toEqual(out);
  });

  it("removes a whole PEM block through its footer, not only the header (key 'v' is outside the vocabulary and renamed)", () => {
    const out = redactIntakeSecrets({ v: `before ${FAKE.pem} after` }) as Record<string, unknown>;
    expect(out[unknownKeyToken("v")]).toBe("before [redacted:pem] after");
    expect(out.v).toBeUndefined();
  });

  it("redacts a PEM block with no footer through the end of the string", () => {
    const header = "-----BEGIN " + "PRIVATE KEY-----";
    const out = redactIntakeSecrets({ v: `${header}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC` }) as Record<string, unknown>;
    expect(out[unknownKeyToken("v")]).toBe("[redacted:pem]");
  });

  it("renames every top-level key outside the vocabulary — including one that looks like a secret — to its distinct token", () => {
    const nested = { ok: "fine" };
    const out = redactIntakeSecrets({ [FAKE.stripeLive]: 1, [FAKE.stripeRestricted]: 2, nested }) as Record<string, unknown>;
    const expectedKeys = [unknownKeyToken(FAKE.stripeLive), unknownKeyToken(FAKE.stripeRestricted), unknownKeyToken("nested")];
    expect(Object.keys(out).sort()).toEqual([...expectedKeys].sort());
    expect(new Set(expectedKeys).size).toBe(3); // three distinct raw keys, three distinct tokens
    const copy = out[unknownKeyToken("nested")] as Record<string, unknown>;
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(copy).toEqual({ [unknownKeyToken("ok")]: "fine" });
  });

  it("a record with a key named __proto__ (JSON.parse makes it an own key) is not logged, and nothing is polluted", () => {
    const hostile = JSON.parse(`{"__proto__": {"polluted": "yes"}, "ok": "fine"}`) as Record<string, unknown>;
    expect(redactIntakeSecrets({ hostile })).toBe(NOT_PLAIN_DATA_PLACEHOLDER);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("a key already shaped like a token is not trusted as one — it is hashed again, never echoed verbatim", () => {
    const tokenShaped = "#aaaaaaaaaaaa";
    const out = redactIntakeSecrets({ [tokenShaped]: 1, [FAKE.stripeLive]: 2 }) as Record<string, unknown>;
    expect(Object.keys(out)).not.toContain(tokenShaped);
    expect(out[unknownKeyToken(tokenShaped)]).toBe(1);
    expect(out[unknownKeyToken(FAKE.stripeLive)]).toBe(2);
  });

  it("copies primitives, null and shared references; a cyclic record is not logged (it is not plain JSON data)", () => {
    expect(redactIntakeSecrets(5)).toBe(5);
    expect(redactIntakeSecrets(null)).toBeNull();
    const shared = { text: FAKE.hex64 };
    const twice = redactIntakeSecrets({ a: shared, b: shared }) as Record<string, Record<string, unknown>>;
    expect(twice[unknownKeyToken("a")]).toEqual({ [unknownKeyToken("text")]: "[redacted:hex-secret]" });
    expect(twice[unknownKeyToken("b")]).toEqual({ [unknownKeyToken("text")]: "[redacted:hex-secret]" });
    const cyclic: Record<string, unknown> = { text: FAKE.hex64 };
    cyclic.self = cyclic;
    expect(redactIntakeSecrets(cyclic)).toBe(NOT_PLAIN_DATA_PLACEHOLDER);
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

  it("an input with a getter (here a throwing one) is refused at the boundary without running it", () => {
    let calls = 0;
    const hostile = {
      schema: "pcc.device-intake.v1",
      get answers(): never {
        calls++;
        throw new Error("boom");
      },
    };
    const report = validateIntake(hostile, "register");
    expect(report.ok).toBe(false);
    expect(report.structuralErrors).toEqual([expect.stringMatching(/^\(root\): not plain JSON data/)]);
    expect(calls).toBe(0);
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
    expect(report.unknownFields).toContain(unknownKeyToken("bogus.field"));
    expect(report.secretsInText).toEqual([{ path: "answers/device.description/value", kind: "hex-secret" }]);
    // The milestone checks are not run on a record that did not parse.
    expect(report.missing).toEqual([]);
    expect(report.invalidFields).toEqual([]);
  });

  it("refuses an answers entry named __proto__ that a parse would silently drop (not plain JSON data)", () => {
    const raw = JSON.parse(
      JSON.stringify({ ...buildFullValidRecord(), answers: {} }).replace(
        '"answers":{}',
        '"answers":{"__proto__":{"value":"x","provenance":"human"}}',
      ),
    ) as unknown;
    const report = validateIntake(raw, "register");
    expect(report.ok).toBe(false);
    expect(report.structuralErrors).toEqual([expect.stringMatching(/^\(root\): not plain JSON data/)]);
    // Only the fixed boundary message (which names the category "a key named __proto__") is reported.
    expect(report.unknownFields).toEqual([]);
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
    expect(report.unknownFields).toEqual([unknownKeyToken(FAKE.stripeLive)]);
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
      "capability.type",
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
      "capability.type",
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

    describe("the event's subject must match the authenticated subject (astra pack 120c, HIGH 3)", () => {
      it("an event for deviceRef dev-2 does not confirm a dev-1 subject (unconfirmed lists the field)", () => {
        const report = ready(full, "publish", {
          events: (e) => e.set(`evt-${field}`, { ...e.get(`evt-${field}`)!, subject: { ...e.get(`evt-${field}`)!.subject, deviceRef: "dev-2" } }),
        });
        expect(report.ok).toBe(false);
        expect(report.unconfirmed).toEqual([field]);
      });

      it("an event carrying a projectRef when the authenticated subject has none does not confirm", () => {
        const report = validateIntake(
          full,
          "publish",
          makeAuthority(full, { subject: { operatorRef: "operator:acme", deviceRef: "dev-1" } }), // no projectRef
        );
        expect(report.ok).toBe(false);
        expect(report.unconfirmed.length).toBeGreaterThan(0);
      });

      it("the reverse: a subject with a projectRef is not confirmed by an event with none", () => {
        const report = ready(full, "publish", {
          events: (e) => {
            const { projectRef: _dropped, ...subjectWithoutProject } = e.get(`evt-${field}`)!.subject;
            e.set(`evt-${field}`, { ...e.get(`evt-${field}`)!, subject: subjectWithoutProject });
          },
        });
        expect(report.ok).toBe(false);
        expect(report.unconfirmed).toEqual([field]);
      });

      it("an event confirmed by another principal does not confirm", () => {
        const report = ready(full, "publish", {
          events: (e) => e.set(`evt-${field}`, { ...e.get(`evt-${field}`)!, confirmedBy: { principal: "operator:someone-else", authMethod: "siwe" } }),
        });
        expect(report.ok).toBe(false);
        expect(report.unconfirmed).toEqual([field]);
      });

      it("a missing authority subject confirms nothing", () => {
        const { subject: _dropped, ...withoutSubject } = makeAuthority(full);
        const report = validateIntake(full, "publish", withoutSubject as unknown as IntakeAuthority);
        expect(report.ok).toBe(false);
        expect(report.unconfirmed.length).toBeGreaterThan(0);
      });

      it("a malformed authority subject (missing deviceRef, or an unrecognized extra key) confirms nothing", () => {
        for (const badSubject of [
          { operatorRef: "operator:acme" }, // no deviceRef
          { operatorRef: "", deviceRef: "dev-1" }, // blank operatorRef
          { operatorRef: "operator:acme", deviceRef: "dev-1", extra: "x" }, // strict: unknown key
        ]) {
          const authority = { ...makeAuthority(full), subject: badSubject as unknown as IntakeSubject };
          const report = validateIntake(full, "publish", authority);
          expect(report.ok, JSON.stringify(badSubject)).toBe(false);
          expect(report.unconfirmed.length, JSON.stringify(badSubject)).toBeGreaterThan(0);
        }
      });
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
        subject: DEFAULT_SUBJECT,
        resolveConfirmation: () => {
          throw new Error("store offline");
        },
        payoutDestination: (operatorRef) => ({ operatorRef, exists: true }),
      };
      const report = validateIntake(full, "publish", throwing);
      expect(report.ok).toBe(false);
      expect(report.unconfirmed).toEqual(validateIntake(full, "publish").unconfirmed);
    });

    it("an async resolver (a Promise instead of an event) confirms nothing", () => {
      const asyncAuthority: IntakeAuthority = {
        subject: DEFAULT_SUBJECT,
        resolveConfirmation: () => Promise.resolve(null) as never,
        payoutDestination: (operatorRef) => ({ operatorRef, exists: true }),
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
      expect(authority.resolveConfirmation("evt-pricing.minimum", authority.subject)!.valueHash).toBe(intakeValueHash("2.00"));
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
        payoutDestination: () => {
          throw new Error("payout store offline");
        },
      };
      expect(validateIntake(full, "get-paid", throwing).unverified).toEqual(["payout.destination"]);
      const loose: IntakeAuthority = { ...events, payoutDestination: () => "yes" as never };
      expect(validateIntake(full, "get-paid", loose).unverified).toEqual(["payout.destination"]);
    });

    it("a payout answer for another operatorRef, exists:false, or null all leave payout.destination unverified (item 1)", () => {
      const events = makeAuthority(full);
      const forAnotherOperator: IntakeAuthority = {
        ...events,
        payoutDestination: () => ({ operatorRef: "operator:someone-else", exists: true }),
      };
      expect(validateIntake(full, "get-paid", forAnotherOperator).unverified).toEqual(["payout.destination"]);

      const existsFalse: IntakeAuthority = {
        ...events,
        payoutDestination: (operatorRef) => ({ operatorRef, exists: false }),
      };
      expect(validateIntake(full, "get-paid", existsFalse).unverified).toEqual(["payout.destination"]);

      const answersNull: IntakeAuthority = { ...events, payoutDestination: () => null };
      expect(validateIntake(full, "get-paid", answersNull).unverified).toEqual(["payout.destination"]);
    });

    it("only get-paid asks the payout store", () => {
      let calls = 0;
      const base = makeAuthority(full);
      const counting: IntakeAuthority = {
        ...base,
        payoutDestination: (operatorRef) => {
          calls += 1;
          return { operatorRef, exists: true };
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
  else record.answers["capability.type"] = typeAnswer(type);
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

  it("an unreviewed unitless parameter (test-lab's \"plain\") refuses every limit, whatever the unit (item 6)", () => {
    // "count" is now a table unit, but a parameter counts as a count parameter
    // ONLY when it is in REVIEWED_COUNT_PARAMETERS (or declares unit "count" itself).
    // test-lab's "plain" is neither, so it refuses a "count" limit too — not just "%".
    const refused = 'safety.limits[0]: the CSD parameter declares no unit and is not a reviewed count parameter';
    expect(labReport([limit("plain", "count", 1, 5)]).limitErrors).toEqual([refused]);
    expect(labReport([limit("plain", "%", 1, 5)]).limitErrors).toEqual([refused]);
  });

  it("every number parameter with a unit in a built-in CSD accepts its own full range, and the table covers those units", () => {
    const registry = loadBuiltinCsds();
    registry.register(CsdSchema.parse(printAndMailCsd));
    let checked = 0;
    let unitless = 0;
    for (const csd of registry.list()) {
      for (const p of csd.parameters) {
        if (p.type !== "number") continue;
        const full = limit(p.key, p.unit ?? UNITLESS_LIMIT_UNIT, p.min, p.max);
        const record = cloneRecord(buildFullValidRecord());
        record.answers["safety.limits"] = limitsAnswer([full]);
        record.answers["capability.type"] = typeAnswer(csd.url);
        const report = validateIntake(record, "accept-jobs", { ...makeAuthority(record), csdRegistry: registry });
        expect(report.limitErrors, `${csd.url}#${p.key} (${p.unit ?? "unitless"})`).toEqual([]);
        if (p.unit === undefined) unitless += 1;
        else checked += 1;
      }
    }
    // %, degrees, km, min, kg, pages: infill, 4 lat/lng, distanceKm, deadlineMinutes, weightKg, pageCount, prepTimeMinutes
    expect(checked).toBe(10);
    // copies, wallCount, quantity, portions: a dimensionless count takes the unit "count"
    expect(unitless).toBeGreaterThan(0);
  });

  it("a parameter that declares no unit takes exactly the unit \"count\", and a unit-bearing one refuses it (120b round)", () => {
    expect(UNITLESS_LIMIT_UNIT).toBe("count");
    const copies = loadBuiltinCsds().resolve("pcc://capabilities/2d-print/v1").parameters.find((p) => p.key === "copies");
    expect(copies).toMatchObject({ type: "number" });
    expect((copies as { unit?: string }).unit).toBeUndefined();
    const at2d = (lims: unknown) => {
      const record = cloneRecord(buildFullValidRecord());
      record.answers["safety.limits"] = limitsAnswer(lims);
      record.answers["capability.type"] = typeAnswer("pcc://capabilities/2d-print/v1");
      return ready(record, "accept-jobs");
    };
    const { min, max } = copies as { min: number; max: number };
    expect(at2d([limit("copies", "count", min, max)]).limitErrors).toEqual([]);
    expect(at2d([limit("copies", " count ", min, max)]).limitErrors).toEqual([]);
    // "count" IS now a closed-table unit (dimension "count"), so a wrong unit that
    // IS in the table (a different dimension) and one that ISN'T give different
    // messages (item 6) — "pages"/"%" resolve but mismatch the dimension;
    // "Count" (wrong case) and "1" do not resolve at all.
    for (const wrong of ["pages", "%"]) {
      expect(at2d([limit("copies", wrong, min, max)]).limitErrors, wrong).toEqual([
        "safety.limits[0]: unit does not match the CSD parameter's unit",
      ]);
    }
    for (const wrong of ["Count", "1"]) {
      expect(at2d([limit("copies", wrong, min, max)]).limitErrors, wrong).toEqual([
        "safety.limits[0]: unit is not in the closed unit table",
      ]);
    }
    expect(at2d([limit("copies", "count", min, max + 1)]).limitErrors).toEqual([
      "safety.limits[0]: limit lies outside the CSD parameter's range",
    ]);
    // "count" on fdm/v2's infill (unit %) is now a resolvable table unit, so this
    // is a dimension mismatch, not an unrecognized unit (item 6).
    const fdm = cloneRecord(buildFullValidRecord());
    fdm.answers["safety.limits"] = limitsAnswer([limit("infill", "count", 10, 90)]);
    expect(ready(fdm, "accept-jobs").limitErrors).toEqual(["safety.limits[0]: unit does not match the CSD parameter's unit"]);
  });

  it("every built-in unitless number parameter is listed in REVIEWED_COUNT_PARAMETERS, and every listed one exists and is unitless (item 6)", () => {
    const registry = loadBuiltinCsds();
    const builtinUnitless = new Map<string, string[]>();
    for (const csd of registry.list()) {
      const keys = csd.parameters.filter((p) => p.type === "number" && p.unit === undefined).map((p) => p.key).sort();
      if (keys.length > 0) builtinUnitless.set(csd.url, keys);
    }
    for (const [url, keys] of builtinUnitless) {
      expect([...(REVIEWED_COUNT_PARAMETERS.get(url) ?? [])].sort(), url).toEqual(keys);
    }
    for (const [url, keys] of REVIEWED_COUNT_PARAMETERS) {
      const csd = registry.resolve(url);
      for (const key of keys) {
        const param = csd.parameters.find((p) => p.key === key);
        expect(param, `${url}#${key}`).toBeDefined();
        expect(param!.type, `${url}#${key}`).toBe("number");
        expect((param as { unit?: string }).unit, `${url}#${key}`).toBeUndefined();
      }
    }
  });

  it("the 120c reproduction: a registered CSD with an unlisted unitless 'ratio' parameter refuses a 'count' limit", () => {
    const registry = loadBuiltinCsds();
    const base = registry.resolve("pcc://capabilities/fdm/v2");
    registry.register({
      ...base,
      url: "pcc://capabilities/ratio-lab/v1",
      parameters: [
        { type: "number", key: "ratio", label: "Ratio", required: false, min: 0, max: 1, step: 0.01 } as never,
      ],
    } as never);
    const record = cloneRecord(buildFullValidRecord());
    record.answers["capability.type"] = typeAnswer("pcc://capabilities/ratio-lab/v1");
    record.answers["safety.limits"] = limitsAnswer([limit("ratio", "count", 0.1, 0.9)]);
    const report = validateIntake(record, "accept-jobs", { ...makeAuthority(record), csdRegistry: registry });
    expect(report.limitErrors.length).toBeGreaterThan(0);
    expect(report.limitErrors).toEqual([
      "safety.limits[0]: the CSD parameter declares no unit and is not a reviewed count parameter",
    ]);
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

  it("limit bounds that are NaN or infinite are not JSON data (refused at the boundary); min > max is an invalid value", () => {
    for (const bad of [
      limit("bedTemp", "C", Number.NaN, 100),
      limit("bedTemp", "C", 30, Number.POSITIVE_INFINITY),
      limit("bedTemp", "C", Number.NEGATIVE_INFINITY, 100),
    ]) {
      const report = labReport([bad]);
      expect(report.ok).toBe(false);
      expect(report.structuralErrors).toEqual([expect.stringMatching(/^\(root\): not plain JSON data/)]);
    }
    const report = labReport([limit("bedTemp", "C", 100, 30)]);
    expect(report.ok).toBe(false);
    expect(report.invalidFields).toEqual(["safety.limits"]);
    expect(report.limitErrors).toEqual([]);
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
    else record.answers["capability.type"] = typeAnswer(type);
    // The fixture's limit is fdm/v2's infill; limits are checked against whatever CSD is selected,
    // so a record retargeted at another capability drops them (publish does not require them).
    if (type !== "pcc://capabilities/fdm/v2") delete record.answers["safety.limits"];
    return record;
  };
  const none = { mechanism: "none" };

  it("an agent-asserted capability.type cannot unlock estop none: capability.type is confirmation-required (120b round)", () => {
    const record = withEstop(none, "pcc://capabilities/2d-print/v1");
    record.answers["capability.type"] = probed("pcc://capabilities/2d-print/v1");
    const report = ready(record, "publish");
    expect(report.ok).toBe(false);
    expect(report.unconfirmed).toContain("capability.type");
    expect(report.neverDefaultViolations).toContain("capability.type");
    // The same type, human-confirmed, is the approved exemption.
    expect(ready(withEstop(none, "pcc://capabilities/2d-print/v1"), "publish").safetyBlocks).toEqual([]);
  });

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
    for (const milestone of ["register", "identify", "register-device", "tier1-intake-complete", "tier2-intake-complete", "optional"] as const) {
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

describe("normalizeIntakeLimits — limits converted into each CSD parameter's own unit (item 8)", () => {
  it("returns the same limit for the fixture (fdm infill %, 10-90)", () => {
    expect(normalizeIntakeLimits(buildFullValidRecord())).toEqual([{ quantity: "infill", unit: "%", min: 10, max: 90 }]);
  });

  it("converts a limit given in mL into a parameter's own uL unit, exactly (1 mL -> 1000 uL)", () => {
    const registry = labRegistry();
    registry.register(
      CsdSchema.parse({
        url: "pcc://capabilities/micro-volume-lab/v1",
        version: "1.0.0",
        status: "active",
        name: "Micro volume lab rig",
        description: "fixture CSD with a uL-declaring parameter",
        kind: "base",
        baseDefinition: null,
        parameters: [
          {
            type: "number",
            key: "reactionVolume",
            label: "Reaction volume",
            required: false,
            min: 0,
            max: 5000,
            step: 1,
            unit: "uL",
          },
        ],
        constraints: [],
        pricing: { basePrice: "1", currency: "USD" },
      }),
    );
    const record = cloneRecord(buildFullValidRecord());
    record.answers["capability.type"] = typeAnswer("pcc://capabilities/micro-volume-lab/v1");
    record.answers["safety.limits"] = limitsAnswer([limit("reactionVolume", "mL", 1, 1)]);
    const result = normalizeIntakeLimits(record, { ...makeAuthority(record), csdRegistry: registry });
    expect(result).toEqual([{ quantity: "reactionVolume", unit: "uL", min: 1000, max: 1000 }]);
  });

  it('a reviewed count parameter comes back with unit "count"', () => {
    const wallCount = loadBuiltinCsds()
      .resolve("pcc://capabilities/fdm/v2")
      .parameters.find((p) => p.key === "wallCount") as { min: number; max: number };
    const record = cloneRecord(buildFullValidRecord());
    record.answers["safety.limits"] = limitsAnswer([limit("wallCount", "count", wallCount.min, wallCount.max)]);
    expect(normalizeIntakeLimits(record)).toEqual([
      { quantity: "wallCount", unit: "count", min: wallCount.min, max: wallCount.max },
    ]);
  });

  it("returns null for a malformed record, a missing/unknown capability.type, a duplicate quantity, an out-of-range limit, or an unbound unitless parameter", () => {
    expect(normalizeIntakeLimits(null)).toBeNull();
    expect(normalizeIntakeLimits({ schema: "pcc.device-intake.v1" })).toBeNull();
    expect(normalizeIntakeLimits("not a record")).toBeNull();

    const noType = cloneRecord(buildFullValidRecord());
    delete noType.answers["capability.type"];
    expect(normalizeIntakeLimits(noType)).toBeNull();

    const unknownType = cloneRecord(buildFullValidRecord());
    unknownType.answers["capability.type"] = typeAnswer("pcc://capabilities/nonexistent/v9");
    expect(normalizeIntakeLimits(unknownType)).toBeNull();

    const duplicate = cloneRecord(buildFullValidRecord());
    duplicate.answers["safety.limits"] = limitsAnswer([
      { quantity: "infill", unit: "%", min: 10, max: 20 },
      { quantity: "infill", unit: "%", min: 30, max: 40 },
    ]);
    expect(normalizeIntakeLimits(duplicate)).toBeNull();

    const outOfRange = cloneRecord(buildFullValidRecord());
    outOfRange.answers["safety.limits"] = limitsAnswer([{ quantity: "infill", unit: "%", min: 1, max: 200 }]);
    expect(normalizeIntakeLimits(outOfRange)).toBeNull();

    // An unreviewed unitless parameter ("plain") cannot bind a limit at all (item 6).
    const unbound = cloneRecord(buildFullValidRecord());
    unbound.answers["capability.type"] = typeAnswer("pcc://capabilities/test-lab/v1");
    unbound.answers["safety.limits"] = limitsAnswer([limit("plain", "count", 1, 5)]);
    expect(normalizeIntakeLimits(unbound, { ...makeAuthority(unbound), csdRegistry: labRegistry() })).toBeNull();
  });

  it("never throws, even on a throwing getter", () => {
    const hostile = {
      schema: "pcc.device-intake.v1",
      get answers(): never {
        throw new Error("boom");
      },
    };
    expect(normalizeIntakeLimits(hostile)).toBeNull();
  });

  /** A registry holding one fixture CSD with a single number parameter. */
  function registryWithParameter(url: string, parameter: { key: string; min: number; max: number; unit: string }) {
    const registry = labRegistry();
    registry.register(
      CsdSchema.parse({
        url,
        version: "1.0.0",
        status: "active",
        name: "Fixture rig",
        description: "fixture CSD with one number parameter",
        kind: "base",
        baseDefinition: null,
        parameters: [{ type: "number", label: parameter.key, required: false, step: 1, ...parameter }],
        constraints: [],
        pricing: { basePrice: "1", currency: "USD" },
      }),
    );
    return registry;
  }

  it("a converted bound never leaves the parameter's range: the conversion slack is clamped away", () => {
    const url = "pcc://capabilities/clamp-lab/v1";
    const registry = registryWithParameter(url, { key: "reactionVolume", min: 1000, max: 2000, unit: "uL" });
    const record = cloneRecord(buildFullValidRecord());
    record.answers["capability.type"] = typeAnswer(url);
    // 0.9999999999 mL and 2.0000000001 mL lie within checkSafetyLimits' conversion slack of [1000, 2000] uL...
    record.answers["safety.limits"] = limitsAnswer([limit("reactionVolume", "mL", 0.9999999999, 2.0000000001)]);
    const authority = { ...makeAuthority(record), csdRegistry: registry };
    expect(validateIntake(record, "register", authority).limitErrors).toEqual([]);
    // ...but the normalized limit is the parameter's own range, never a hair outside it.
    expect(normalizeIntakeLimits(record, authority)).toEqual([{ quantity: "reactionVolume", unit: "uL", min: 1000, max: 2000 }]);
  });

  it("nanometres are a length unit (sensors #5048: a plate reader's wavelength), converted exactly", () => {
    const url = "pcc://capabilities/absorbance-lab/v1";
    const registry = registryWithParameter(url, { key: "wavelengthNm", min: 405, max: 600, unit: "nm" });
    const record = cloneRecord(buildFullValidRecord());
    record.answers["capability.type"] = typeAnswer(url);
    const authority = { ...makeAuthority(record), csdRegistry: registry };
    record.answers["safety.limits"] = limitsAnswer([limit("wavelengthNm", "nm", 405, 600)]);
    expect(validateIntake(record, "register", authority).limitErrors).toEqual([]);
    expect(normalizeIntakeLimits(record, authority)).toEqual([{ quantity: "wavelengthNm", unit: "nm", min: 405, max: 600 }]);
    // The same limit in micrometres comes back in the parameter's nm.
    record.answers["safety.limits"] = limitsAnswer([limit("wavelengthNm", "um", 0.405, 0.6)]);
    expect(normalizeIntakeLimits(record, authority)).toEqual([{ quantity: "wavelengthNm", unit: "nm", min: 405, max: 600 }]);
    // A different dimension is still refused.
    record.answers["safety.limits"] = limitsAnswer([limit("wavelengthNm", "s", 405, 600)]);
    expect(validateIntake(record, "register", authority).limitErrors).toEqual([
      "safety.limits[0]: unit does not match the CSD parameter's unit",
    ]);
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

describe("validateIntake — tier readiness fails closed (astra pack 120c, HIGH 5: the stub-primitive gate is REMOVED, item 4)", () => {
  const full = buildFullValidRecord();

  it("with a full authority and the shipped registry, tier1-intake-complete and tier2-intake-complete are ok", () => {
    const tier1 = ready(full, "tier1-intake-complete");
    expect(tier1, JSON.stringify(tier1)).toMatchObject({ ok: true, insubstantial: [], missing: [] });
    expect(tier1).not.toHaveProperty("stubPrimitives");

    const tier2 = ready(full, "tier2-intake-complete");
    expect(tier2, JSON.stringify(tier2)).toMatchObject({ ok: true, insubstantial: [], missing: [] });
    expect(tier2).not.toHaveProperty("stubPrimitives");
  });

  it("the 120c reproduction: flipping registry verifierStatus to live (try/finally restore) does not change any report", () => {
    const before: Record<string, unknown> = {};
    for (const milestone of INTAKE_MILESTONES) before[milestone] = ready(full, milestone);
    withPrimitiveFields(everyTierPrimitiveLive(), () => {
      for (const milestone of INTAKE_MILESTONES) {
        expect(ready(full, milestone), milestone).toEqual(before[milestone]);
      }
    });
    // ... and restoring leaves every report exactly as it was.
    for (const milestone of INTAKE_MILESTONES) {
      expect(ready(full, milestone), milestone).toEqual(before[milestone]);
    }
  });

  it("the report has no stubPrimitives key, for any milestone", () => {
    for (const milestone of INTAKE_MILESTONES) {
      expect(ready(full, milestone), milestone).not.toHaveProperty("stubPrimitives");
    }
  });

  it("every tier field that maps to an evidence primitive has a substance rule, and nothing else is ruled", () => {
    const mapped = INTAKE_FIELDS.filter(
      (f) => f.evidencePrimitive && f.requiredFor.some((m) => m === "tier1-intake-complete" || m === "tier2-intake-complete"),
    ).map((f) => f.id);
    expect(mapped.length).toBeGreaterThan(0);
    for (const id of mapped) expect(TIER_SUBSTANCE_RULE_FIELDS, id).toContain(id);
    for (const id of TIER_SUBSTANCE_RULE_FIELDS) {
      const field = INTAKE_FIELDS.find((f) => f.id === id)!;
      expect(field.requiredFor.some((m) => m === "tier1-intake-complete" || m === "tier2-intake-complete"), id).toBe(true);
    }
    // operatorPresence is the one tier field with no rule: always, sometimes and never are all honest.
    expect(TIER_SUBSTANCE_RULE_FIELDS).not.toContain("evidence.operatorPresence");
  });

  describe("an answer that satisfies its schema but proves nothing is insubstantial (unchanged by item 4)", () => {
    const camera = { seesWorkArea: true, seesOutput: true, mount: "fixed", captureDeviceId: "cam-1" };
    const rows: [string, string, "tier1-intake-complete" | "tier2-intake-complete", unknown][] = [
      ["calibration.lastDate", "an impossible day", "tier1-intake-complete", "2026-02-30"],
      ["calibration.lastDate", "month 13", "tier1-intake-complete", "2026-13-01"],
      ["calibration.lastDate", "month 00", "tier1-intake-complete", "2026-00-10"],
      ["calibration.lastDate", "Feb 29 in a common year", "tier1-intake-complete", "2023-02-29"],
      ["calibration.lastDate", "year 0000", "tier1-intake-complete", "0000-01-01"],
      ["calibration.procedureRef", "blank", "tier1-intake-complete", "   "],
      ["evidence.executorDeviceId", "blank", "tier1-intake-complete", "  "],
      ["evidence.observerDeviceIds", "a blank entry", "tier1-intake-complete", ["cam-1", "  "]],
      ["evidence.executionMode", "mock", "tier1-intake-complete", "mock"],
      ["evidence.executionMode", "dry_run", "tier1-intake-complete", "dry_run"],
      ["evidence.controllerRunLog", "controller does not export its own log", "tier1-intake-complete", { exportsOwnLogPerJob: false, access: "api" }],
      ["evidence.instrumentSignsOutput", "instrument does not sign", "tier1-intake-complete", false],
      ["evidence.referenceSample", "none available", "tier1-intake-complete", { available: false }],
      ["evidence.referenceSample", "available but no expected result", "tier1-intake-complete", { available: true }],
      ["evidence.referenceSample", "blank expected result", "tier1-intake-complete", { available: true, expectedResultRef: "  " }],
      ["evidence.camera", "sees neither", "tier2-intake-complete", { ...camera, seesWorkArea: false, seesOutput: false }],
      ["evidence.camera", "sees the work area but not the output", "tier2-intake-complete", { ...camera, seesOutput: false }],
      ["evidence.camera", "sees the output but not the work area", "tier2-intake-complete", { ...camera, seesWorkArea: false }],
      ["evidence.camera", "blank capture device", "tier2-intake-complete", { ...camera, captureDeviceId: "  " }],
      ["evidence.approver", "blank name", "tier2-intake-complete", { name: "   " }],
    ];

    it.each(rows)("%s: %s (%s)", (fieldId, _why, milestone, bad) => {
      const record = cloneRecord(full);
      record.answers[fieldId] = human(bad);
      const report = ready(record, milestone);
      expect(report.ok).toBe(false);
      expect(report.insubstantial).toEqual([fieldId]);
      expect(report.missing).toEqual([]);
      expect(report.invalidFields).toEqual([]);
    });

    it("the matching substantive values are accepted (leap day, empty observer list, never-present operator)", () => {
      const record = cloneRecord(full);
      record.answers["calibration.lastDate"] = human("2024-02-29");
      record.answers["evidence.observerDeviceIds"] = human([]);
      record.answers["evidence.operatorPresence"] = human("never");
      const report = ready(record, "tier2-intake-complete");
      expect(report.ok).toBe(true);
    });

    it("a tier2-only answer does not matter for tier1, and tier fields do not matter for other milestones", () => {
      const weak = cloneRecord(full);
      weak.answers["evidence.camera"] = human({ ...camera, seesWorkArea: false, seesOutput: false });
      weak.answers["evidence.controllerRunLog"] = human({ exportsOwnLogPerJob: false, access: "api" });
      expect(ready(weak, "tier1-intake-complete").insubstantial).toEqual(["evidence.controllerRunLog"]);
      expect(ready(weak, "tier2-intake-complete").insubstantial).toEqual(["evidence.camera", "evidence.controllerRunLog"]);
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
      const report = ready(record, "tier2-intake-complete");
      expect(report.missing).toEqual(["evidence.camera", "evidence.approver"]);
      expect(report.invalidFields).toEqual(["evidence.approver"]);
      expect(report.insubstantial).toEqual([]);
    });
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
    // "evidence.camera" and "value" are vocabulary members; the key itself is not, so it is hashed (item 5).
    expect(report.nonAsciiKeys).toEqual([`answers/evidence.camera/value/${unknownKeyToken(key)}`]);
    expect(report.invalidFields).toEqual(["evidence.camera"]); // the strict field schema refuses it too
    expect(JSON.stringify(report)).not.toContain(key);
  });

  it("a non-ASCII key anywhere in a value or a source is reported with its full path — every out-of-vocabulary segment on that path is also hashed (item 5)", () => {
    const nonAsciiKey = `k${cyrillicA}`;
    const deep = human({ available: true, expectedResultRef: "x", nested: { list: [{ [nonAsciiKey]: 1 }] } });
    const report = ready(withAnswer("evidence.referenceSample", deep), "register");
    // "nested" and "list" are not themselves in the vocabulary either, so they are ALSO hashed,
    // not just the non-ASCII leaf key; "0" is a numeric array index and stays literal.
    expect(report.nonAsciiKeys).toEqual([
      `answers/evidence.referenceSample/value/${unknownKeyToken("nested")}/${unknownKeyToken("list")}/0/${unknownKeyToken(nonAsciiKey)}`,
    ]);

    const sourceKey = `s${String.fromCodePoint(0xe9)}ction`;
    const sourced = withAnswer("calibration.procedureRef", {
      value: "Prusa bed-leveling procedure v2",
      provenance: "confirmed",
      source: { doc: "manual", [sourceKey]: "x" },
    });
    const sourcedReport = ready(sourced, "register");
    expect(sourcedReport.ok).toBe(false);
    // "source" is a structural vocabulary key, so only the leaf key is hashed here.
    expect(sourcedReport.nonAsciiKeys).toEqual([`answers/calibration.procedureRef/source/${unknownKeyToken(sourceKey)}`]);
    // the strict source schema fails the parse, and the key is still reported from the raw input
    expect(sourcedReport.structuralErrors).toEqual(["answers/calibration.procedureRef/source: unrecognized_keys"]);
  });

  it("a non-ASCII field id is reported too (as unknown and as a non-ASCII key), both as its token", () => {
    const fieldId = `caf${String.fromCodePoint(0xe9)}.menu`;
    const record = cloneRecord(buildFullValidRecord());
    (record.answers as Record<string, IntakeAnswer>)[fieldId] = human("x");
    const report = ready(record, "register");
    expect(report.ok).toBe(false);
    // The whole field id is one path segment (field ids are literal map keys, not split on "."),
    // not itself in the vocabulary, so it is hashed — both as a non-ASCII key and as an unknown field.
    expect(report.nonAsciiKeys).toEqual([`answers/${unknownKeyToken(fieldId)}`]);
    expect(report.unknownFields).toEqual([unknownKeyToken(fieldId)]);
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
    const key80 = `a${String.fromCharCode(0x80)}`;
    expect(ready(withAnswer("evidence.camera", camera(key80)), "register").nonAsciiKeys).toEqual([
      `answers/evidence.camera/value/${unknownKeyToken(key80)}`,
    ]);
  });

  it("never echoes a secret-looking non-ASCII key", () => {
    const key = `${FAKE.pem}${cyrillicA}`;
    const report = ready(withAnswer("evidence.camera", cameraWith({ [key]: "x" })), "register");
    expect(report.nonAsciiKeys).toEqual([`answers/evidence.camera/value/${unknownKeyToken(key)}`]);
    expect(JSON.stringify(report)).not.toContain("PRIVATE KEY");
  });

  it("finds a non-ASCII key deep in a value, and refuses (never throws on) input nested too deep to copy", () => {
    const nonAsciiKey = `z${cyrillicA}`;
    let nested: unknown = { [nonAsciiKey]: 1 };
    for (let i = 0; i < 200; i++) nested = { a: nested };
    const report = ready(withAnswer("evidence.camera", cameraWith({ extra: nested })), "register");
    expect(report.ok).toBe(false);
    expect(report.nonAsciiKeys).toHaveLength(1);
    // "a" and "extra" are not in the vocabulary either, so they are hashed too — only the final
    // (leaf) segment is deterministically the token of the non-ASCII key itself.
    expect(report.nonAsciiKeys[0]!.endsWith(`/${unknownKeyToken(nonAsciiKey)}`)).toBe(true);
    // 50,000 levels overflow the boundary's copy, which refuses the input rather than throw.
    let deep: unknown = { [nonAsciiKey]: 1 };
    for (let i = 0; i < 50000; i++) deep = { a: deep };
    const deepReport = ready(withAnswer("evidence.camera", cameraWith({ extra: deep })), "register");
    expect(deepReport.ok).toBe(false);
    expect(deepReport.structuralErrors).toEqual([expect.stringMatching(/^\(root\): not plain JSON data/)]);
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
      expect(report.forbiddenKeys[0]).not.toContain(key); // the CANONICAL spelling is shown, never the raw key
      expect(report.nonAsciiKeys).toHaveLength(1);
    });

    it("a ligature spelling (the fi in verified) is a forbidden key too, reported as the CANONICAL spelling (item 5)", () => {
      const key = `veri${String.fromCodePoint(0xfb01)}ed`;
      const report = ready(sampleWith(key), "register");
      // NFKC-folds the ligature to "fi", matching the canonical "verified" — forbiddenKeys shows
      // that canonical spelling, never a representation (escaped or hashed) of the raw key.
      expect(report.forbiddenKeys).toEqual(["evidence.referenceSample.verified"]);
    });

    it("a look-alike from another script is not folded by NFKC — it is refused as a non-ASCII key instead", () => {
      const key = `priv${cyrillicA}teKey`;
      const report = ready(sampleWith(key), "register");
      expect(report.forbiddenKeys).toEqual([]);
      expect(report.nonAsciiKeys).toHaveLength(1);
      expect(report.ok).toBe(false);
    });

    it("the ASCII variants keep matching, reported as the canonical spelling (item 5)", () => {
      const report = ready(sampleWith("Private_Key"), "register");
      expect(report.forbiddenKeys).toEqual(["evidence.referenceSample.privateKey"]);
    });
  });
});

// ── 16. Seeded hostile-input fuzz ─────────────────────────────────────────

describe("validateIntake — seeded hostile-input fuzz", () => {
  /** xorshift32 with a fixed seed: the same cases on every run. */
  function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 0xffffffff;
    };
  }

  const cyrillicA = String.fromCodePoint(0x430);
  const junk: unknown[] = [
    null, undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "", " ", "x", true, false, [], {}, [1], { a: 1 },
    { set: true }, { set: false }, ["a", "b"], cyrillicA, { [cyrillicA]: 1 }, { privateKey: 1 }, { hash: "x" },
    FAKE.pem, FAKE.street, FAKE.hex64Prefixed,
  ];

  /** One to three random mutations of the full fixture, as a JSON round trip (so it is plain data). */
  function mutated(next: () => number): Record<string, any> {
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
    const record = JSON.parse(JSON.stringify(buildFullValidRecord())) as { schema: unknown; answers: Record<string, any> };
    const ids = Object.keys(record.answers);
    for (let n = 1 + Math.floor(next() * 3); n > 0; n--) {
      const id = pick(ids);
      const answer = record.answers[id];
      switch (Math.floor(next() * 11)) {
        case 0: delete record.answers[id]; break;
        case 1: if (answer) answer.value = pick(junk); break;
        case 2: if (answer) answer.provenance = pick(["human", "probe", "research", "confirmed", "garbage", "", null]); break;
        case 3: if (answer) answer.source = pick([undefined, { doc: "m" }, { doc: " " }, { doc: "m", url: "http://x.y" }, { doc: "m", url: "https://x.y" }, "str"]); break;
        case 4: if (answer) answer.confirmation = pick([undefined, { eventId: "nope" }, { eventId: `evt-${id}` }, { eventId: "" }, {}]); break;
        case 5: if (answer) answer.extra = 1; break;
        case 6: record.answers[pick(["bogus.field", "__proto__", "constructor", "verificationResult", "café"])] = pick([human("x"), probed(1), "bad"]); break;
        case 7: if (answer?.value && typeof answer.value === "object" && !Array.isArray(answer.value)) answer.value[pick(["hash", "digest", "privateKey", "Private_Key", `${cyrillicA}x`, "ok"])] = pick(junk); break;
        case 8: if (typeof answer?.value === "string") answer.value = `${answer.value} ${pick([FAKE.pem, FAKE.address, FAKE.street, FAKE.hex64, "fine"])}`; break;
        case 9: record.schema = pick(["pcc.device-intake.v1", "other", 1]); break;
        default: if (Array.isArray(answer?.value)) answer.value.push(pick(junk)); break;
      }
    }
    return record;
  }

  /** An authority that holds an honest event for every well-formed confirmation reference in `record`. */
  function authorityFor(record: unknown, payout: boolean): IntakeAuthority {
    const events = new Map<string, IntakeConfirmationEvent>();
    const answers = (record as { answers?: Record<string, any> } | null)?.answers;
    for (const [fieldId, answer] of Object.entries(answers && typeof answers === "object" ? answers : {})) {
      const eventId = answer?.confirmation?.eventId;
      if (typeof eventId !== "string" || eventId === "") continue;
      events.set(eventId, {
        ...confirmationEvent(fieldId, { ...answer, confirmation: { eventId } } as IntakeAnswer),
        eventId,
      });
    }
    return {
      subject: DEFAULT_SUBJECT,
      resolveConfirmation: (id) => events.get(id) ?? null,
      payoutDestination: (operatorRef) => ({ operatorRef, exists: payout }),
    };
  }

  it("never throws, and an ok report implies every component check is clean (2000 cases)", () => {
    const next = prng(20260930);
    const violations: string[] = [];
    let okReports = 0;
    for (let i = 0; i < 2000; i++) {
      const record = next() < 0.05 ? junk[Math.floor(next() * junk.length)] : mutated(next);
      const milestone = INTAKE_MILESTONES[Math.floor(next() * INTAKE_MILESTONES.length)]!;
      const authority = next() < 0.8 ? authorityFor(record, next() < 0.9) : undefined;
      const label = `#${i} ${milestone} ${authority ? "with" : "without"} authority`;

      const report = validateIntake(record, milestone, authority); // must not throw
      executionModeTierCap(record); // must not throw either
      if (!report.ok) continue;
      okReports += 1;

      const parsed = IntakeRecordSchema.safeParse(record);
      if (!parsed.success) {
        violations.push(`${label}: ok, but the input does not parse`);
        continue;
      }
      if (scanIntakeStrings(record).length > 0) violations.push(`${label}: ok, but a string matches a detector`);
      if (scanIntakeStrings(redactIntakeSecrets(record)).length > 0) violations.push(`${label}: redaction left a hit`);
      const implied = MILESTONE_IMPLIES[milestone];
      for (const field of INTAKE_FIELDS) {
        const answer = parsed.data.answers[field.id];
        if (answer !== undefined && !field.valueSchema.safeParse(answer.value).success) {
          violations.push(`${label}: ok, but ${field.id} does not satisfy its schema`);
        }
        if (!field.requiredFor.some((m) => implied.includes(m))) continue;
        if (answer === undefined) {
          violations.push(`${label}: ok, but ${field.id} is required and absent`);
        } else if (CONFIRMATION_REQUIRED_FIELDS.includes(field.id)) {
          if (!authority) violations.push(`${label}: ok without an authority, but ${field.id} needs one`);
          if (answer.provenance !== "human" && answer.provenance !== "confirmed") {
            violations.push(`${label}: ok, but ${field.id} has provenance ${answer.provenance}`);
          }
          if (!answer.confirmation) violations.push(`${label}: ok, but ${field.id} has no confirmation reference`);
        }
      }
      // (item 4: the stub-primitive gate is removed — a tier-intake milestone being "ok" is now
      // unremarkable on its own, so there is no longer an invariant to check here.)
      if (Object.keys(parsed.data.answers).some((k) => /[^\x00-\x7f]/.test(k))) {
        violations.push(`${label}: ok with a non-ASCII field id`);
      }
    }
    expect(violations).toEqual([]);
    // the fuzz must exercise both outcomes, or it proves nothing
    expect(okReports).toBeGreaterThan(100);
    expect(okReports).toBeLessThan(1900);
  }, 30_000);
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

  it("HIGH 5a (re-framed, astra pack 120c): tier2-intake-complete is ready regardless of the evidence registry's mutable verifierStatus — the stub-primitive gate is removed (item 4)", () => {
    const report = ready(buildFullValidRecord(), "tier2-intake-complete");
    expect(report.ok).toBe(true);
    expect(report).not.toHaveProperty("stubPrimitives");
    // Flipping the registry's verifierStatus changes nothing — it is never consulted.
    const flipped = withPrimitiveFields(everyTierPrimitiveLive(), () => ready(buildFullValidRecord(), "tier2-intake-complete"));
    expect(flipped).toEqual(report);
  });

  it("HIGH 5b: a camera that sees neither work area nor output does not count for tier2-intake-complete (the substance rule itself is unchanged by item 4)", () => {
    const answer = human({ seesWorkArea: false, seesOutput: false, mount: "fixed", captureDeviceId: "cam-1" });
    const record = withAnswer("evidence.camera", answer);
    const report = ready(record, "tier2-intake-complete");
    expect(report.ok).toBe(false);
    expect(report.insubstantial).toEqual(["evidence.camera"]);
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

// ── 17. astra pack 120c — ported reproductions (commit 44e965fa) ─────────
// Each case below asserts the CORRECT (new) behaviour, adapted to the
// subject-scoped IntakeAuthority API. Ported from
// scratchpad/repro-120c.test.ts; HIGH 5 is re-framed as "flipping
// verifierStatus does not change readiness" (the stub-primitive gate is
// removed, item 4).

describe("astra pack 120g and steward #5225: one exact plain-data copy at the boundary", () => {
  const tokenKey = unknownKeyToken("bogus-id");
  const notPlain = [expect.stringMatching(/^\(root\): not plain JSON data/)];
  const recordWith = (answers: Record<string, unknown>) => ({ schema: "pcc.device-intake.v1", answers });

  it("CRITICAL 1 (astra's case): a non-enumerable key is not plain JSON data, so the record is refused and nothing reproduces it", () => {
    const hidden = {};
    Object.defineProperty(hidden, tokenKey, { value: "x", enumerable: false });
    const input = recordWith({ "bogus-id": { value: hidden, provenance: "human" } });
    const report = validateIntake(input, "register");
    expect(report.unknownFields).not.toContain(tokenKey);
    expect(report.structuralErrors).toEqual(notPlain);
    expect(redactIntakeSecrets(input)).toBe(NOT_PLAIN_DATA_PLACEHOLDER);
  });

  it("a direct scan of a raw value still reserves non-enumerable names, so a path token never reproduces one", () => {
    const value: Record<string, unknown> = { k1: "sk-" + "proj-" + "H".repeat(40) };
    Object.defineProperty(value, unknownKeyToken("k1"), { value: "x", enumerable: false });
    const hits = scanIntakeStrings({ answers: { "device.description": { value } } });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path.split("/")).not.toContain(unknownKeyToken("k1"));
  });

  it("a getter is never run: the record is refused, so a value that turns secret after validation is never validated", () => {
    let reads = 0;
    let validated = false;
    const answer = { provenance: "human", get value() { reads++; return validated ? "sk-" + "proj-" + "I".repeat(40) : "clean"; } };
    const input = recordWith({ "device.description": answer });
    const report = validateIntake(input, "register");
    validated = true;
    expect(report.ok).toBe(false);
    expect(report.structuralErrors).toEqual(notPlain);
    expect(reads).toBe(0);
  });

  it("a proxy is refused without running its traps", () => {
    let traps = 0;
    const input = new Proxy(recordWith({}), { get(target, key, receiver) { traps++; return Reflect.get(target, key, receiver); } });
    expect(validateIntake(input, "register").structuralErrors).toEqual(notPlain);
    expect(redactIntakeSecrets(input)).toBe(NOT_PLAIN_DATA_PLACEHOLDER);
    expect(normalizeIntakeLimits(input)).toBeNull();
    expect(executionModeTierCap(input)).toBe(0);
    expect(traps).toBe(0);
  });

  it.each([
    ["a symbol key", () => ({ ...recordWith({}), [Symbol("s")]: 1 })],
    ["a Date", () => recordWith({ "device.description": { value: new Date(0), provenance: "human" } })],
    ["a class instance", () => recordWith({ "device.description": { value: new (class Approver { name = "x"; })(), provenance: "human" } })],
    ["an undefined value", () => recordWith({ "device.description": { value: "x", provenance: "human", source: undefined } })],
    ["undefined in an array", () => recordWith({ "safety.hazards": { value: ["chemical", undefined], provenance: "human" } })],
    ["a sparse array", () => recordWith({ "safety.hazards": { value: [, "chemical"], provenance: "human" } })],
    ["a function", () => recordWith({ "device.description": { value: () => "x", provenance: "human" } })],
    ["a bigint", () => recordWith({ "device.description": { value: BigInt(1), provenance: "human" } })],
  ])("%s is not plain JSON data: refused by every entry point", (_label, build) => {
    const input = build();
    expect(validateIntake(input, "register").structuralErrors).toEqual(notPlain);
    expect(redactIntakeSecrets(input)).toBe(NOT_PLAIN_DATA_PLACEHOLDER);
    expect(normalizeIntakeLimits(input)).toBeNull();
    expect(executionModeTierCap(input)).toBe(0);
  });

  it("plain JSON data passes the boundary unchanged: the full valid record is still ok, also after a JSON round trip", () => {
    expect(ready(buildFullValidRecord(), "publish").ok).toBe(true);
    const roundTripped = JSON.parse(JSON.stringify(buildFullValidRecord())) as unknown;
    expect(validateIntake(roundTripped, "publish", makeAuthority(buildFullValidRecord())).ok).toBe(true);
  });
});

describe("astra pack 120f", () => {
  const tokenKey = unknownKeyToken("bogus-id");
  /** An array carrying a named own enumerable property (JSON has none; a JavaScript caller can attach one). */
  const arrayWith = (items: unknown[], key: string, value: unknown): unknown[] => {
    const arr = [...items];
    (arr as unknown as Record<string, unknown>)[key] = value;
    return arr;
  };

  it("CRITICAL 1 (astra's case): a named property on an array is reserved, so no token reproduces it in the report", () => {
    const input = { schema: "pcc.device-intake.v1", answers: { "bogus-id": { value: arrayWith([], tokenKey, "x"), provenance: "human" } } };
    expect(validateIntake(input, "register").unknownFields).not.toContain(tokenKey);
  });

  it("CRITICAL 1 (astra's case): ... and redaction does not log such a record at all", () => {
    const input = { schema: "pcc.device-intake.v1", answers: { "bogus-id": { value: arrayWith([], tokenKey, "x") } } };
    expect(redactIntakeSecrets(input)).toBe(NOT_PLAIN_DATA_PLACEHOLDER);
  });

  it("an array's named property is walked: a secret in it is found, and its key is shown as a token", () => {
    const hits = scanIntakeStrings({ answers: { "device.description": { value: arrayWith(["ok"], "extra", "sk-" + "proj-" + "D".repeat(40)) } } });
    expect(hits.map((h) => h.path)).toEqual([`answers/device.description/value/${unknownKeyToken("extra")}`]);
  });

  it("at the boundary, an array with a named property is not plain JSON data: refused, and nothing in it is echoed", () => {
    const report = validateIntake(
      { schema: "pcc.device-intake.v1", answers: { "safety.hazards": { value: arrayWith(["chemical"], "privateKey", "x"), provenance: "human" } } },
      "register",
    );
    expect(report.ok).toBe(false);
    expect(report.structuralErrors).toEqual([expect.stringMatching(/^\(root\): not plain JSON data/)]);
    expect(JSON.stringify(report)).not.toContain("privateKey");
  });

  it("array indices are still walked by number, before the named properties", () => {
    const secret = "sk-" + "proj-" + "E".repeat(40);
    const hits = scanIntakeStrings({ answers: { "safety.hazards": { value: arrayWith([secret], "note", secret) } } });
    expect(hits.map((h) => h.path)).toEqual([
      "answers/safety.hazards/value/0",
      `answers/safety.hazards/value/${unknownKeyToken("note")}`,
    ]);
  });

  it("redaction keeps a plain array's elements, and does not log a record whose array has a named property", () => {
    const out = redactIntakeSecrets({ answers: { "safety.hazards": { value: ["chemical"] } } }) as {
      answers: Record<string, { value: unknown[] }>;
    };
    expect([...out.answers["safety.hazards"]!.value]).toEqual(["chemical"]);
    expect(redactIntakeSecrets({ answers: { "safety.hazards": { value: arrayWith(["chemical"], "note", "x") } } })).toBe(NOT_PLAIN_DATA_PLACEHOLDER);
  });
});

describe("astra pack 120e", () => {
  const digest = "sha256:" + "ab".repeat(32);
  const fakeKey = () => "sk-" + "proj-" + "A".repeat(40);
  const answer = { value: "x", provenance: "human" };
  /** Every "/"-separated segment of every path-like string in a report. */
  const segmentsOf = (strings: readonly string[]) => strings.flatMap((s) => s.split(/[/.: ]/));

  it("CRITICAL 1 (astra's case): a raw key equal to another key's token never appears in unknownFields", () => {
    const tokenKey = unknownKeyToken("bogus-id");
    expect(tokenKey).toBe("#7949dd6d3f1d");
    const report = validateIntake({ schema: "pcc.device-intake.v1", answers: { "bogus-id": answer, [tokenKey]: answer } }, "register");
    expect(report.unknownFields).not.toContain(tokenKey);
    expect(report.unknownFields).toHaveLength(2);
  });

  it("CRITICAL 1 (astra's case): ... nor among redactIntakeSecrets' output keys", () => {
    const tokenKey = unknownKeyToken("bogus-id");
    const out = redactIntakeSecrets({ schema: "pcc.device-intake.v1", answers: { "bogus-id": { value: "x" }, [tokenKey]: { value: "x" } } }) as {
      answers: Record<string, unknown>;
    };
    expect(Object.keys(out.answers)).not.toContain(tokenKey);
    expect(Object.keys(out.answers)).toHaveLength(2);
  });

  it("the reserved set is the WHOLE input: a token-shaped key placed deep in a value still cannot be reproduced", () => {
    const deepToken = unknownKeyToken("k1");
    const record = {
      schema: "pcc.device-intake.v1",
      answers: {
        "safety.estop": { value: { mechanism: "button", k1: fakeKey() }, provenance: "human" },
        "device.description": { value: "x", provenance: "human", source: { doc: "m", [deepToken]: "y" } },
      },
    };
    const hits = scanIntakeStrings(record);
    expect(hits.length).toBeGreaterThan(0);
    expect(segmentsOf(hits.map((h) => h.path))).not.toContain(deepToken);
    const report = validateIntake(record, "register");
    expect(segmentsOf([...report.secretsInText.map((h) => h.path), ...report.structuralErrors, ...report.nonAsciiKeys])).not.toContain(deepToken);
  });

  it("structural error paths never reproduce a raw key either", () => {
    const tokenKey = unknownKeyToken("bogus-id");
    const report = validateIntake(
      { schema: "pcc.device-intake.v1", answers: { "bogus-id": { value: "x", provenance: "garbage" }, [tokenKey]: answer } },
      "register",
    );
    expect(report.structuralErrors.length).toBeGreaterThan(0);
    expect(segmentsOf(report.structuralErrors)).not.toContain(tokenKey);
  });

  it("without a collision, a key keeps the same token in the report and in redaction", () => {
    const record = { schema: "pcc.device-intake.v1", answers: { "bogus-id": answer } };
    const report = validateIntake(record, "register");
    const out = redactIntakeSecrets(record) as { answers: Record<string, unknown> };
    expect(report.unknownFields).toEqual([unknownKeyToken("bogus-id")]);
    expect(Object.keys(out.answers)).toEqual([unknownKeyToken("bogus-id")]);
  });

  it("contentHash: JavaScript's $ matches only at the end, so the runtime, the scan and redaction all refuse a trailing newline", () => {
    for (const bad of [digest + "\n", digest + "\r\n", digest + "\u2028"]) {
      expect(IntakeSourceSchema.safeParse({ doc: "manual", contentHash: bad }).success, JSON.stringify(bad)).toBe(false);
      const record = { schema: "pcc.device-intake.v1", answers: { "device.description": { value: "x", provenance: "research", source: { doc: "manual", contentHash: bad } } } };
      expect(scanIntakeStrings(record).length, JSON.stringify(bad)).toBeGreaterThan(0);
      expect((redactIntakeSecrets(record) as typeof record).answers["device.description"].source.contentHash).not.toBe(bad);
    }
  });

  it("contentHash: the generated schema bounds the length, so a dialect whose $ matches before a newline still refuses it", () => {
    const schema = buildIntakeJsonSchema() as {
      properties: { answers: { properties: Record<string, { properties: { source: { properties: Record<string, { minLength?: number; maxLength?: number }> } } }> } };
    };
    const prop = schema.properties.answers.properties["device.description"]!.properties.source.properties.contentHash!;
    expect(prop.minLength).toBe(digest.length);
    expect(prop.maxLength).toBe(digest.length);
    expect((digest + "\n").length).toBeGreaterThan(prop.maxLength!);
  });
});

describe("astra pack 120d", () => {
  const numericKey = "123456";
  const fakeKey = () => "sk-" + "proj-" + "A".repeat(40);
  const digest = "sha256:" + "ab".repeat(32);

  it("control: a non-numeric unknown answer id is hashed in unknownFields", () => {
    const report = validateIntake({ schema: "pcc.device-intake.v1", answers: { "bogus-id": { value: "x", provenance: "human" } } }, "register");
    expect(report.unknownFields).toEqual([unknownKeyToken("bogus-id")]);
  });

  it("CRITICAL 1: a numeric unknown answer id is a KEY, not an array index: hashed, never echoed", () => {
    const report = validateIntake(
      { schema: "pcc.device-intake.v1", answers: { [numericKey]: { value: "x", provenance: "human" } } },
      "register",
    );
    expect(report.unknownFields).toEqual([unknownKeyToken(numericKey)]);
    expect(JSON.stringify(report)).not.toContain(numericKey);
  });

  it("CRITICAL 1: redactIntakeSecrets renames a numeric object key to its token", () => {
    const out = redactIntakeSecrets({ schema: "pcc.device-intake.v1", answers: { [numericKey]: { value: "x" } } }) as {
      answers: Record<string, unknown>;
    };
    expect(Object.keys(out.answers)).toEqual([unknownKeyToken(numericKey)]);
    expect(JSON.stringify(out)).not.toContain(numericKey);
  });

  it("CRITICAL 1: a secret under a numeric key inside a value has a path with the key hashed", () => {
    const hits = scanIntakeStrings({ answers: { "safety.estop": { value: { mechanism: "button", [numericKey]: fakeKey() } } } });
    expect(hits.map((h) => h.path)).toEqual([`answers/safety.estop/value/${unknownKeyToken(numericKey)}`]);
  });

  it("a real array index stays verbatim, and a numeric key inside an array element is still hashed", () => {
    const hits = scanIntakeStrings({ answers: { "safety.hazards": { value: ["ok", fakeKey(), { "7": fakeKey() }] } } });
    expect(hits.map((h) => h.path)).toEqual([
      "answers/safety.hazards/value/1",
      `answers/safety.hazards/value/2/${unknownKeyToken("7")}`,
    ]);
  });

  it("MEDIUM contentHash: the generated JSON Schema documents source.contentHash with the runtime's own pattern", () => {
    const schema = buildIntakeJsonSchema() as {
      properties: { answers: { properties: Record<string, { properties: { source: { properties: Record<string, { pattern?: string }> } } }> } };
    };
    for (const [fieldId, field] of Object.entries(schema.properties.answers.properties)) {
      expect(field.properties.source.properties.contentHash, fieldId).toEqual({
        type: "string",
        pattern: "^sha256:[0-9a-f]{64}$",
        minLength: 71,
        maxLength: 71,
      });
    }
    // The pattern the JSON Schema documents accepts exactly what IntakeSourceSchema accepts.
    const pattern = new RegExp(schema.properties.answers.properties["device.description"]!.properties.source.properties.contentHash!.pattern!);
    for (const candidate of [digest, digest.toUpperCase(), "sha256:" + "ab".repeat(31), digest + "0", "SHA256:" + "ab".repeat(32), digest + "\n", digest + "\r\n"]) {
      expect(pattern.test(candidate), candidate).toBe(IntakeSourceSchema.safeParse({ doc: "manual", contentHash: candidate }).success);
    }
  });

  it("MEDIUM contentHash: log redaction keeps the legitimate digest at exactly answers/<field>/source/contentHash", () => {
    const record = {
      schema: "pcc.device-intake.v1",
      answers: { "device.description": { value: "x", provenance: "research", source: { doc: "manual", contentHash: digest } } },
    };
    expect(scanIntakeStrings(record)).toEqual([]);
    const out = redactIntakeSecrets(record) as typeof record;
    expect(out.answers["device.description"].source.contentHash).toBe(digest);
  });

  it("MEDIUM contentHash: redaction still masks the same digest anywhere else, and a malformed one at the exempt path", () => {
    const record = {
      schema: "pcc.device-intake.v1",
      answers: {
        "device.description": { value: digest, provenance: "research", source: { doc: "manual", contentHash: digest.toUpperCase() } },
      },
    };
    const out = redactIntakeSecrets(record) as typeof record;
    expect(out.answers["device.description"].value).toBe("sha256:[redacted:hex-secret]");
    expect(out.answers["device.description"].source.contentHash).not.toBe(digest.toUpperCase());
    expect(JSON.stringify(out)).not.toContain("ab".repeat(32));
  });
});

describe("astra pack 120c", () => {
  /** buildFullValidRecord() with evidence.executorDeviceId overridden to `device`. */
  function fullFor(device = "dev-1"): IntakeRecord {
    const record = cloneRecord(buildFullValidRecord());
    record.answers["evidence.executorDeviceId"] = human(device);
    return record;
  }

  /** An authority authenticated for `device`, holding an honest event for every
   *  confirmation-required answer in `record` (events are also scoped to `device`). */
  function authorityFor(record: IntakeRecord, device: string, extra: Partial<IntakeAuthority> = {}): IntakeAuthority {
    const events = new Map<string, IntakeConfirmationEvent>();
    for (const [fieldId, a] of Object.entries(record.answers)) {
      if (!a.confirmation) continue;
      events.set(a.confirmation.eventId, {
        schema: "pcc.intake-confirmation.v1",
        eventId: a.confirmation.eventId,
        fieldId,
        valueHash: intakeValueHash(a.value),
        ...(a.source ? { sourceHash: intakeValueHash(a.source) } : {}),
        confirmedBy: { principal: "operator:acme", authMethod: "siwe" },
        subject: { deviceRef: device, projectRef: "proj-1" },
        sequence: 1,
        confirmedAt: "2026-09-30T12:00:00Z",
        challenge: "challenge-1",
        supersededBy: null,
        revoked: false,
      });
    }
    return {
      subject: { operatorRef: "operator:acme", deviceRef: device, projectRef: "proj-1" },
      resolveConfirmation: (id) => events.get(id) ?? null,
      payoutDestination: (operatorRef) => ({ operatorRef, exists: true }),
      ...extra,
    };
  }

  it("control: the full record, confirmed on its own device, is publish-ready", () => {
    expect(validateIntake(fullFor("dev-1"), "publish", authorityFor(fullFor("dev-1"), "dev-1")).ok).toBe(true);
  });

  it("CRITICAL 1a: an sk-proj- credential in device.description is detected", () => {
    const secret = "sk-" + "proj-" + "A".repeat(40);
    expect(
      scanIntakeStrings({ answers: { "device.description": { value: `key ${secret}`, provenance: "human" } } }).length,
    ).toBeGreaterThan(0);
  });

  it("CRITICAL 1b: '1 Hacker Way' is detected as a street address", () => {
    expect(
      scanIntakeStrings({ answers: { "device.description": { value: "It sits at 1 Hacker Way", provenance: "human" } } })
        .length,
    ).toBeGreaterThan(0);
  });

  it("CRITICAL 1c: an unrecognized credential used as an answer key is never echoed in the report or in redactIntakeSecrets output (item 5)", () => {
    const secret = "sk-" + "proj-" + "B".repeat(40);
    const r = fullFor();
    const input = { schema: r.schema, answers: { ...r.answers, [secret]: human("x") } };
    expect(JSON.stringify(validateIntake(input, "register"))).not.toContain(secret);
    expect(JSON.stringify(redactIntakeSecrets(input))).not.toContain(secret);
  });

  it("HIGH 3: the subject is what matters, NOT the record — B validated under subject dev-1 passes; the same events under a dev-2 subject fail", () => {
    const recordB = fullFor("dev-2"); // claims dev-2 via evidence.executorDeviceId only
    const eventsForDev1 = authorityFor(fullFor("dev-1"), "dev-1");
    // The record cannot pick its own subject: B's dev-2 claim is just a data field, irrelevant to confirmation.
    expect(validateIntake(recordB, "publish", eventsForDev1).ok).toBe(true);
    // The SAME events, scoped to a dev-2 subject instead, no longer confirm (they were made for dev-1).
    const asDev2 = authorityFor(fullFor("dev-1"), "dev-1", {
      subject: { operatorRef: "operator:acme", deviceRef: "dev-2", projectRef: "proj-1" },
    });
    expect(validateIntake(recordB, "publish", asDev2).ok).toBe(false);
  });

  it("MEDIUM (was HIGH 4): a unitless CSD parameter that is not a count does not accept a 'count' limit", () => {
    const registry = loadBuiltinCsds();
    const base = registry.resolve("pcc://capabilities/fdm/v2");
    registry.register({
      ...base,
      url: "pcc://capabilities/ratio-lab/v1",
      parameters: [
        { type: "number", key: "ratio", label: "Ratio", required: false, min: 0, max: 1, step: 0.01 } as never,
      ],
    } as never);
    const r = fullFor();
    r.answers["capability.type"] = {
      ...human("pcc://capabilities/ratio-lab/v1"),
      confirmation: { eventId: "evt-capability.type" },
    };
    r.answers["safety.limits"] = {
      ...confirmed([{ quantity: "ratio", unit: "count", min: 0.1, max: 0.9 }]),
      confirmation: { eventId: "evt-safety.limits" },
    };
    const report = validateIntake(r, "accept-jobs", { ...authorityFor(r, "dev-1"), csdRegistry: registry });
    expect(report.limitErrors.length).toBeGreaterThan(0);
  });

  it("HIGH 5 (re-framed, item 4): flipping mutable verifierStatus metadata does not change tier readiness", () => {
    const ids = [
      "ident.registered_key",
      "machine.execution_log",
      "measure.io_test_pair",
      "approval.expert",
      "capture.photo_nonced",
    ];
    const touched = EVIDENCE_PRIMITIVES.filter((p) => ids.includes(p.id));
    const before = touched.map((p) => p.verifierStatus);
    const record = fullFor();
    const authority = authorityFor(record, "dev-1");
    const reportBefore = validateIntake(record, "tier2-intake-complete", authority);
    expect(reportBefore.ok).toBe(true); // substantive answers, no gate left to fail
    try {
      for (const p of touched) (p as { verifierStatus: string }).verifierStatus = "live";
      expect(validateIntake(record, "tier2-intake-complete", authority)).toEqual(reportBefore);
    } finally {
      touched.forEach((p, i) => ((p as { verifierStatus: string }).verifierStatus = before[i]!));
    }
  });

  it("MEDIUM 8: 'Do not install A and execute B.' instructs execution", () => {
    expect(entryInstructsExecution({ ...RESEARCH_LIBRARY[0]!, prompt: "Do not install A and execute B." })).toBe(true);
  });

  it("MEDIUM (new): a research citation's contentHash can flow into an answer's source, and is not a secret", () => {
    const contentHash = "sha256:" + "ab".repeat(32);
    expect(IntakeSourceSchema.safeParse({ doc: "manual", section: "specs", contentHash }).success).toBe(true);
    const hits = scanIntakeStrings({
      answers: {
        "calibration.procedureRef": {
          value: "v2",
          provenance: "confirmed",
          source: { doc: "manual", section: "specs", contentHash },
        },
      },
    });
    expect(hits).toEqual([]);
  });

  it("registry sanity for the unitless case (CsdRegistry is a class)", () => {
    expect(typeof CsdRegistry).toBe("function");
  });
});
