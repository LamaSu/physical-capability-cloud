import { describe, it, expect } from "vitest";
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
  type IntakeAnswer,
  type IntakeRecord,
} from "../onboarding/intake/index.js";
import { getPrimitive } from "../evidence/primitives.js";
import { RESEARCH_LIBRARY } from "../onboarding/research/index.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SPEC_ROOT = join(TEST_DIR, "..", "..");
const REPO_ROOT = join(SPEC_ROOT, "..", "..");

// ── 1. Registry integrity ────────────────────────────────────────────────

describe("INTAKE_FIELDS — registry integrity", () => {
  it("has 41 fields, all with unique ids", () => {
    expect(INTAKE_FIELDS).toHaveLength(41);
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
    "operator.displayName": human("Ryan's Print Shop"),
    "operator.contactEmail": human("ryan@example.com"),
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
    "evidence.approver": human({ name: "Ryan George" }),
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
      ["consumables.loadedMaterial", "safety.estop", "safety.hazards", "safety.limits", "safety.supervision"].sort(),
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
