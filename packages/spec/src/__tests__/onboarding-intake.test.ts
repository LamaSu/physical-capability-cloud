import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
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
  buildFormHtml,
  IntakeAnswerSchema,
  IntakeRecordSchema,
  validateIntake,
  executionModeTierCap,
  intakeFieldArtifactMap,
  scanIntakeStrings,
  redactIntakeSecrets,
  INTAKE_SECRET_KINDS,
  type IntakeAnswer,
  type IntakeRecord,
  type IntakeSecretKind,
} from "../onboarding/intake/index.js";
import { BIP39_ENGLISH_WORDLIST } from "../onboarding/intake/bip39-english.js";
import { getPrimitive } from "../evidence/primitives.js";
import { RESEARCH_LIBRARY } from "../onboarding/research/index.js";

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
    "safety.limits": confirmed([{ quantity: "bed temperature", unit: "C", min: 0, max: 120 }]),
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
    "evidence.instrumentSignsOutput": human(false),
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
  return { schema: "pcc.device-intake.v1", answers };
}

function cloneRecord(record: IntakeRecord): IntakeRecord {
  return { schema: record.schema, answers: { ...record.answers } };
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

  it("is `ok` for every milestone", () => {
    for (const milestone of INTAKE_MILESTONES) {
      const report = validateIntake(full, milestone);
      expect(report, `${milestone}: ${JSON.stringify(report)}`).toMatchObject({
        ok: true,
        missing: [],
        neverDefaultViolations: [],
        forbiddenKeys: [],
        sensitiveViolations: [],
        unknownFields: [],
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

describe("executionModeTierCap — caps, never raises", () => {
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

  it("imposes no cap for real, or when unanswered", () => {
    expect(executionModeTierCap(recordWithExecutionMode("real"))).toBe(3);
    expect(executionModeTierCap(recordWithExecutionMode(undefined))).toBe(3);
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

describe("astra pack 120b", () => {
  it("baseline: the full fixture is ok for identify (else the cases below prove nothing)", () => {
    expect(validateIntake(buildFullValidRecord(), "identify").ok).toBe(true);
  });

  it("CRITICAL 1a: a PEM private key in device.description is refused", () => {
    expect(validateIntake(withAnswer("device.description", human(FAKE.pem)), "identify").ok).toBe(false);
  });
  it("CRITICAL 1b: a 64-hex secret candidate in device.description is refused", () => {
    expect(validateIntake(withAnswer("device.description", human("key 0x" + "ab".repeat(32))), "identify").ok).toBe(false);
  });
  it("CRITICAL 1c: a payout address in device.description is refused", () => {
    expect(validateIntake(withAnswer("device.description", human("pay " + FAKE.address)), "identify").ok).toBe(false);
  });
  it("CRITICAL 1d: a street address in device.description is refused", () => {
    expect(
      validateIntake(withAnswer("device.description", human("Printer lives at 1600 Pennsylvania Avenue")), "identify").ok,
    ).toBe(false);
  });
});
