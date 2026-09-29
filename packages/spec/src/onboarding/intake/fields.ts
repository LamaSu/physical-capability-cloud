/**
 * Device intake — field registry (single source of truth).
 *
 * Source spec: returns/pcc-kits-work/intake-spec-item6-20260929.md (R2 rules +
 * the per-field table), INCLUDING the "Addendum, 16:40 PDT" (adk #4099, evidence
 * #4105, sensors #4066), which supersedes the base table's evidence/calibration
 * rows. Every field id here is intended to be PERMANENT (spec: "never reuse one,
 * only deprecate it").
 *
 * R2 rule 1 (classification): every fact is classified before it is ever asked.
 *   - "A" (probe/identify): the agent determines it directly (device photo,
 *     network probe, firmware query).
 *   - "B" (research): the agent looks it up (manuals, datasheets, I/O ranges,
 *     manufacturer safety limits, calibration procedures).
 *   - "C" (only the human knows or decides): authority, location, supervision
 *     and e-stop, consumables, evidence placement, price, payout, availability.
 *   Only C facts are ever *asked* — A/B facts are filled by the agent and, where
 *   the row below says so, confirmed by a human afterward. Where the spec table
 *   lists a composite mechanism (e.g. "A (identify-device), C fallback"), the
 *   `class` recorded here is the PRIMARY mechanism (the first-listed one),
 *   except where R2 rule 1's own worked examples name a more specific class for
 *   that exact fact (e.g. "the manufacturer's safety limits" and "calibration
 *   procedures" are both named as B examples in rule 1's prose, so
 *   `safety.limits` and `calibration.procedureRef` are classed "B" here even
 *   though their table row leads with the confirming party).
 *
 * R2 rule 4 (never-defaulted): `neverDefault: true` is set on every field the
 * base table's own "Default" column marks "never" — pricing.* (3), payout.destination,
 * safety.supervision, safety.estop, safety.hazards, safety.limits, and
 * operator.authority. This is a superset of the addendum's own shorthand list
 * ("price, payout, ... every safety limit, e-stop and supervision"): hazards and
 * authority are included too because the base table independently flags them
 * "never" and both are facts with no safe silent default (an unstated hazard
 * list or an unstated authority attestation must never be assumed empty/true).
 *
 * `evidencePrimitive.status` records the primitive's **verifierStatus**
 * (live | stub | planned) from evidence/primitives.ts — NOT its `status` field
 * (vocabulary status, always "active" for anything referenced here). This is
 * the axis the intake form needs to render "stub = proves nothing yet" (spec
 * addendum). See onboarding-intake.test.ts for the cross-check against the
 * live EVIDENCE_PRIMITIVES registry.
 */

import { z } from "zod";
import type { AdapterType } from "../../types/kernel.js";

// ── Shared enums ──────────────────────────────────────────────────────

/** Groups, in R2 rule 2's mandated ask-order. Rule 2's prose does not name
 *  "capability" explicitly, but the field table places it between evidence and
 *  pricing; that placement is preserved here. */
export const INTAKE_GROUPS = [
  "identity",
  "device",
  "location",
  "network",
  "safety",
  "consumables",
  "calibration",
  "evidence",
  "capability",
  "pricing",
  "payout",
  "availability",
  "sla",
] as const;
export type IntakeGroup = (typeof INTAKE_GROUPS)[number];

/** R2 rule 1's three-way fact classification. */
export const INTAKE_FIELD_CLASSES = ["A", "B", "C"] as const;
export type IntakeFieldClass = (typeof INTAKE_FIELD_CLASSES)[number];

/** Milestones a field can gate. "optional" fields never block a milestone. */
export const INTAKE_MILESTONES = [
  "register",
  "identify",
  "register-device",
  "publish",
  "accept-jobs",
  "tier1",
  "tier2",
  "get-paid",
  "optional",
] as const;
export type IntakeMilestone = (typeof INTAKE_MILESTONES)[number];

/** R2 rule 6: every answer records its provenance. `research`/`confirmed`
 *  require a `source` (enforced by IntakeAnswerSchema in index.ts). */
export const INTAKE_PROVENANCE_VALUES = ["human", "probe", "research", "confirmed"] as const;
export type IntakeProvenance = (typeof INTAKE_PROVENANCE_VALUES)[number];

/** Mirrors kernel.ts's AdapterType union, minus "mock". `satisfies` fails the
 *  build if kernel.ts adds/removes a member this list doesn't account for.
 *  "mock" is deliberately excluded — the spec is explicit that
 *  `device.adapterType` names a real AdapterType, never "mock". */
export const DEVICE_ADAPTER_TYPE_VALUES = [
  "octoprint",
  "modbus",
  "opcua",
  "sila",
  "generic-http",
  "opentrons",
] as const satisfies readonly AdapterType[];

/** One (artifact, path) an answer feeds. Both are free-form strings: `artifact`
 *  names the downstream document/store, `path` is a dotted/bracketed pointer
 *  into it (e.g. {artifact:"capability", path:"pricing.basePrice"}). */
export interface IntakeFieldFill {
  readonly artifact: string;
  readonly path: string;
}

/** A field's pointer into the evidence-primitive vocabulary (evidence/primitives.ts). */
export interface IntakeEvidencePrimitiveRef {
  readonly id: string;
  /** The primitive's verifierStatus at authoring time — see file header. */
  readonly status: "live" | "stub" | "planned";
}

/** One row of the intake field registry — the contract for one permanent field id. */
export interface IntakeFieldDef {
  /** Permanent. Never reused — only deprecated (spec, adk addendum). */
  readonly id: string;
  readonly group: IntakeGroup;
  readonly class: IntakeFieldClass;
  /** The question as shown on the form. */
  readonly question: string;
  /** The one line the agent says when it asks (spec addendum). */
  readonly why: string;
  readonly fills: readonly IntakeFieldFill[];
  readonly requiredFor: IntakeMilestone;
  /** R2 rule 4: an empty/guessed answer never satisfies this field's milestone. */
  readonly neverDefault?: boolean;
  /** R2 rule 5: the intake record may only ever hold {set: true} for this field —
   *  never the real value. `valueSchema` below already encodes that shape. */
  readonly sensitive?: boolean;
  readonly evidencePrimitive?: IntakeEvidencePrimitiveRef;
  /** Addendum: calibration.* map to decl.self_attested ONLY — the form must say
   *  "self-declared", and the answer is never elevated by research alone. */
  readonly selfDeclaredOnly?: boolean;
  /** Runtime shape of `IntakeAnswer.value` for this field. */
  readonly valueSchema: z.ZodTypeAny;
}

const SENSITIVE_SET_SCHEMA = z.object({ set: z.literal(true) }).strict();

// ── The registry ────────────────────────────────────────────────────────

export const INTAKE_FIELDS: readonly IntakeFieldDef[] = [
  // ── identity ──────────────────────────────────────────────────────
  {
    id: "operator.displayName",
    group: "identity",
    class: "C",
    question: "What name should buyers and the network see for you or your shop?",
    why: "This is the name that appears on every listing and job you accept.",
    fills: [
      { artifact: "kernel", path: "name" },
      { artifact: "operatorProfile", path: "displayName" },
    ],
    requiredFor: "register",
    valueSchema: z.string().min(1).max(200),
  },
  {
    id: "operator.contactEmail",
    group: "identity",
    class: "C",
    question: "What email should we use for job notifications and key provisioning?",
    why: "We need a channel to reach you about jobs, approvals, and account security.",
    fills: [
      { artifact: "operatorProfile", path: "contactEmail" },
      { artifact: "notificationChannel", path: "email" },
    ],
    requiredFor: "register",
    valueSchema: z.string().email(),
  },
  {
    id: "operator.authority",
    group: "identity",
    class: "C",
    question: "Do you have the authority to offer this machine's time on PCC?",
    why: "Only someone authorized to commit the machine's time may register it — this is never assumed.",
    fills: [{ artifact: "registration", path: "attestation.authority" }],
    requiredFor: "register",
    neverDefault: true,
    valueSchema: z.boolean(),
  },

  // ── device ────────────────────────────────────────────────────────
  {
    id: "device.description",
    group: "device",
    class: "C",
    question:
      "In your own words, what is this device and what should buyers expect to get from it?",
    why: "This seeds device identification and the search for a matching capability contract.",
    fills: [
      { artifact: "identifyDeviceInput", path: "description" },
      { artifact: "csdSearch", path: "query" },
    ],
    requiredFor: "identify",
    valueSchema: z.string().min(1).max(2000),
  },
  {
    id: "device.vendor",
    group: "device",
    class: "A",
    question: "Confirm the device's manufacturer/vendor.",
    why: "The vendor name drives the adapter config and which kits can match this device.",
    fills: [
      { artifact: "adapterConfig", path: "vendor" },
      { artifact: "kit", path: "compatibility.models[].vendor" },
    ],
    requiredFor: "register-device",
    valueSchema: z.string().min(1).max(200),
  },
  {
    id: "device.model",
    group: "device",
    class: "A",
    question: "Confirm the device's exact model.",
    why: "The exact model is how we find the right manual, safety limits, and remote-control protocol.",
    fills: [
      { artifact: "adapterConfig", path: "model" },
      { artifact: "kit", path: "compatibility.models[].model" },
    ],
    requiredFor: "register-device",
    valueSchema: z.string().min(1).max(200),
  },
  {
    id: "device.serialNumber",
    group: "device",
    class: "C",
    question: "What is the device's serial number (from its label)?",
    why: "The serial number ties this specific unit to its device record.",
    fills: [{ artifact: "deviceRecord", path: "serialNumber" }],
    requiredFor: "register-device",
    valueSchema: z.string().min(1).max(200),
  },
  {
    id: "device.firmware",
    group: "device",
    class: "A",
    question: "Confirm the device's firmware version.",
    why: "Firmware version affects which commands and safety behaviors are available (N83 G8).",
    fills: [{ artifact: "deviceRecord", path: "firmware" }],
    requiredFor: "register-device",
    valueSchema: z.string().min(1).max(200),
  },
  {
    id: "device.adapterType",
    group: "device",
    class: "A",
    question: "Confirm the adapter type PCC should use to talk to this device.",
    why: "This selects the real adapter that will run jobs — it is never \"mock\" for a live device.",
    fills: [{ artifact: "registerDevice", path: "adapterType" }],
    requiredFor: "register-device",
    valueSchema: z.enum(DEVICE_ADAPTER_TYPE_VALUES),
  },

  // ── location ──────────────────────────────────────────────────────
  {
    id: "location.cityCountry",
    group: "location",
    class: "C",
    question: "What city and country is this device located in?",
    why: "Buyers need a coarse location to judge shipping time and jurisdiction.",
    fills: [{ artifact: "capability", path: "location" }],
    requiredFor: "publish",
    valueSchema: z.object({ city: z.string().min(1), country: z.string().min(1) }).strict(),
  },
  {
    id: "location.streetAddress",
    group: "location",
    class: "C",
    question:
      "What is the device's street address? (Private — never shown publicly; used for logistics only.)",
    why: "We need this for couriers and installers, but it is never published — public listings only ever show city and country.",
    fills: [{ artifact: "kernel", path: "physicalAddress" }],
    requiredFor: "optional",
    sensitive: true,
    valueSchema: SENSITIVE_SET_SCHEMA,
  },

  // ── network ───────────────────────────────────────────────────────
  {
    id: "network.reachability",
    group: "network",
    class: "C",
    question:
      "Is this device on the same local network as the agent host, and does it have a static IP?",
    why: "This decides whether we can reach it directly or need pcc-node as a relay.",
    fills: [
      { artifact: "adapterConfig", path: "baseUrl" },
      { artifact: "deploymentChoice", path: "topology" },
    ],
    requiredFor: "register-device",
    valueSchema: z.object({ sameLan: z.boolean(), staticIp: z.boolean() }).strict(),
  },
  {
    id: "network.outboundHttps",
    group: "network",
    class: "C",
    question: "Can this device (or its host) make outbound HTTPS calls?",
    why: "Outbound-only connectivity lets us use pcc-node without opening any inbound ports.",
    fills: [{ artifact: "deploymentChoice", path: "outboundHttps" }],
    requiredFor: "register-device",
    valueSchema: z.boolean(),
  },
  {
    id: "network.inboundBlocked",
    group: "network",
    class: "C",
    question: "Is inbound access to this device blocked by a firewall or NAT?",
    why: "This confirms whether pcc-node's outbound-only design is required.",
    fills: [{ artifact: "deploymentChoice", path: "inboundBlocked" }],
    requiredFor: "register-device",
    valueSchema: z.boolean(),
  },

  // ── safety ────────────────────────────────────────────────────────
  {
    id: "safety.supervision",
    group: "safety",
    class: "C",
    question: "Will this device run attended, unattended, or remote-supervised?",
    why: "Supervision level is never assumed — it directly bounds which jobs are safe to accept.",
    fills: [{ artifact: "safetyEnvelope", path: "supervision" }],
    requiredFor: "accept-jobs",
    neverDefault: true,
    valueSchema: z.enum(["attended", "unattended", "remote-supervised"]),
  },
  {
    id: "safety.estop",
    group: "safety",
    class: "C",
    question: "Is there a physical e-stop? What type, and who can reach it?",
    why: "An e-stop's presence and reachability is safety-critical and is never defaulted.",
    fills: [{ artifact: "safetyEnvelope", path: "estop" }],
    requiredFor: "accept-jobs",
    neverDefault: true,
    valueSchema: z
      .object({
        present: z.boolean(),
        type: z.string().optional(),
        whoCanPress: z.string().optional(),
      })
      .strict(),
  },
  {
    id: "safety.hazards",
    group: "safety",
    class: "C",
    question:
      "What hazards does this device present (chemical, laser, heat, mechanical, biological)?",
    why: "Hazard classes shape the safety envelope — an empty answer blocks job acceptance rather than assuming \"none\".",
    fills: [{ artifact: "safetyEnvelope", path: "hazards" }],
    requiredFor: "accept-jobs",
    neverDefault: true,
    valueSchema: z.array(z.enum(["chemical", "laser", "heat", "mechanical", "biological"])),
  },
  {
    id: "safety.limits",
    group: "safety",
    class: "B",
    question:
      "Confirm the safety limits we found for this device (e.g. max temperature, max volume, allowed materials) — or tell us if any are wrong.",
    why: "Safety limits come from the manual, but only a human confirmation makes them binding — never a guess.",
    fills: [
      { artifact: "safetyEnvelope", path: "limits" },
      { artifact: "csd", path: "typedIO.bounds" },
    ],
    requiredFor: "accept-jobs",
    neverDefault: true,
    valueSchema: z
      .array(
        z
          .object({
            parameter: z.string().min(1),
            min: z.number().optional(),
            max: z.number().optional(),
            unit: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
  },

  // ── consumables ───────────────────────────────────────────────────
  {
    id: "consumables.items",
    group: "consumables",
    class: "C",
    question: "What consumables does this device use (materials, tips, filters, etc.)?",
    why: "This lets buyers and the scheduler know what's needed to run a job.",
    fills: [{ artifact: "capabilityAvailability", path: "consumables.items" }],
    requiredFor: "accept-jobs",
    valueSchema: z.array(z.string().min(1)),
  },
  {
    id: "consumables.restockedBy",
    group: "consumables",
    class: "C",
    question: "Who restocks these consumables, and how often?",
    why: "This sets expectations for availability and avoids mid-job surprises.",
    fills: [{ artifact: "capabilityAvailability", path: "consumables.restockedBy" }],
    requiredFor: "accept-jobs",
    valueSchema: z.string().min(1),
  },
  {
    id: "consumables.loadedMaterial",
    group: "consumables",
    class: "C",
    question: "What material or consumable is currently loaded?",
    why: "The loaded material determines which operating bands from the manual actually apply right now.",
    fills: [{ artifact: "safetyEnvelope", path: "loadedMaterial" }],
    requiredFor: "accept-jobs",
    valueSchema: z.string().min(1),
  },

  // ── calibration (addendum: decl.self_attested ONLY, "self-declared") ─
  {
    id: "calibration.lastDate",
    group: "calibration",
    class: "C",
    question: "When did you last calibrate this device? (self-declared)",
    why: "This is self-declared only — we never infer or default a calibration date.",
    fills: [{ artifact: "evidencePlan", path: "calibration.lastDate" }],
    requiredFor: "tier1",
    selfDeclaredOnly: true,
    evidencePrimitive: { id: "decl.self_attested", status: "live" },
    valueSchema: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
  },
  {
    id: "calibration.procedureRef",
    group: "calibration",
    class: "B",
    question: "Which calibration procedure did you follow? (self-declared)",
    why: "Research can suggest a procedure, but only your confirmation makes it the record — self-declared only.",
    fills: [{ artifact: "evidencePlan", path: "calibration.procedureRef" }],
    requiredFor: "tier1",
    selfDeclaredOnly: true,
    evidencePrimitive: { id: "decl.self_attested", status: "live" },
    valueSchema: z.string().min(1),
  },

  // ── evidence (addendum #4105 — replaces the old evidence.* rows) ─────
  // "The agent probes and the human confirms" — every field in this group is
  // class C. See file header for why executor/observer never derive a stored
  // "independence" flag: that concept is a FORBIDDEN key (INTAKE_FORBIDDEN_KEYS).
  {
    id: "evidence.executorDeviceId",
    group: "evidence",
    class: "C",
    question: "Which device id actually executes the job?",
    why: "This is the raw fact the evidence plan is built from — independence is derived from it, never asked directly.",
    fills: [{ artifact: "provenanceRecipe", path: "executorDeviceId" }],
    requiredFor: "tier1",
    valueSchema: z.string().min(1),
  },
  {
    id: "evidence.observerDeviceIds",
    group: "evidence",
    class: "C",
    question: "Which device ids (if any) only observe the job, without executing it?",
    why: "An observer that isn't also the executor is what makes an inspection independent — we derive that, we don't ask you to assert it.",
    fills: [{ artifact: "provenanceRecipe", path: "observerDeviceIds" }],
    requiredFor: "tier1",
    valueSchema: z.array(z.string().min(1)),
  },
  {
    id: "evidence.executionMode",
    group: "evidence",
    class: "A",
    question: "Is this run against the real device, or a mock/dry-run adapter?",
    why: "A mock or dry-run answer caps the job's evidence at tier 0 — it can lower the tier, never raise it.",
    fills: [{ artifact: "evidencePlan", path: "confirm.execution_mode" }],
    requiredFor: "tier1",
    evidencePrimitive: { id: "confirm.execution_mode", status: "live" },
    valueSchema: z.enum(["real", "mock", "dry_run"]),
  },
  {
    id: "evidence.camera",
    group: "evidence",
    class: "C",
    question:
      "Is there a camera? Does it see the work area, does it see the output, is it fixed or handheld, and which device id captures it?",
    why: "The camera must be a separate device from the machine — this is what lets us capture believable photo evidence.",
    fills: [{ artifact: "evidencePlan", path: "capture.photo_nonced.placement" }],
    requiredFor: "tier2",
    evidencePrimitive: { id: "capture.photo_nonced", status: "stub" },
    valueSchema: z
      .object({
        seesWorkArea: z.boolean(),
        seesOutput: z.boolean(),
        mount: z.enum(["fixed", "mounted"]),
        captureDeviceId: z.string().min(1),
      })
      .strict(),
  },
  {
    id: "evidence.operatorPresence",
    group: "evidence",
    class: "C",
    question: "Is an operator present always, sometimes, or never during a job?",
    why: "Operator presence shapes what kind of evidence and approval is realistic to collect.",
    fills: [{ artifact: "evidencePlan", path: "operatorPresence" }],
    requiredFor: "tier1",
    valueSchema: z.enum(["always", "sometimes", "never"]),
  },
  {
    id: "evidence.approver",
    group: "evidence",
    class: "C",
    question:
      "Who is the person who will approve evidence for this device? (identity only — their signing key is registered separately later.)",
    why: "We need to know who will attest to job quality before we register how they sign.",
    fills: [{ artifact: "evidencePlan", path: "approval.expert.approver" }],
    requiredFor: "tier2",
    evidencePrimitive: { id: "approval.expert", status: "stub" },
    valueSchema: z.object({ name: z.string().min(1), contact: z.string().min(1).optional() }).strict(),
  },
  {
    id: "evidence.controllerRunLog",
    group: "evidence",
    class: "C",
    question: "Can the controller export its own execution log per job? If so, via API or file?",
    why: "A per-job exportable log is what lets us build a trustworthy machine execution record.",
    fills: [{ artifact: "evidencePlan", path: "machine.execution_log" }],
    requiredFor: "tier1",
    evidencePrimitive: { id: "machine.execution_log", status: "stub" },
    valueSchema: z
      .object({ exportsOwnLogPerJob: z.boolean(), access: z.enum(["api", "file"]) })
      .strict(),
  },
  {
    id: "evidence.instrumentSignsOutput",
    group: "evidence",
    class: "C",
    question: "Does the instrument cryptographically sign its own output?",
    why: "A self-signing instrument raises the evidence ceiling — but only once its signing key is registered (companion primitive: receipt.kernel_signed).",
    fills: [
      { artifact: "evidencePlan", path: "receipt.kernel_signed" },
      { artifact: "evidencePlan", path: "ident.registered_key" },
    ],
    requiredFor: "tier1",
    // "maps to receipt.kernel_signed plus ident.registered_key (stub under the
    // lockstep rule)" — recorded against ident.registered_key (verifierStatus
    // "stub"), the weaker/gating half of the pair, so the field's declared
    // status matches the registry exactly with no special-case exception.
    evidencePrimitive: { id: "ident.registered_key", status: "stub" },
    valueSchema: z.boolean(),
  },
  {
    id: "evidence.referenceSample",
    group: "evidence",
    class: "C",
    question: "Do you have a reference sample with a known expected result?",
    why: "A known-good test pair is the strongest cheap proof that the capability actually works.",
    fills: [{ artifact: "evidencePlan", path: "measure.io_test_pair" }],
    requiredFor: "tier1",
    evidencePrimitive: { id: "measure.io_test_pair", status: "stub" },
    valueSchema: z
      .object({ available: z.boolean(), expectedResultRef: z.string().optional() })
      .strict(),
  },

  // ── capability ────────────────────────────────────────────────────
  {
    id: "capability.type",
    group: "capability",
    class: "A",
    question: "Confirm the capability contract (CSD) this device implements.",
    why: "We search the registry before authoring anything new — reuse comes first.",
    fills: [
      { artifact: "capability", path: "type" },
      { artifact: "kit", path: "capabilities[]" },
    ],
    requiredFor: "publish",
    valueSchema: z.string().min(1),
  },
  {
    id: "capability.parameters",
    group: "capability",
    class: "B",
    question: "Confirm the typed parameters and ranges we found for this capability.",
    why: "Buyers configure jobs against these typed ranges — they must be confirmed, not guessed.",
    fills: [{ artifact: "csd", path: "typedIO" }],
    requiredFor: "publish",
    valueSchema: z.array(
      z
        .object({
          key: z.string().min(1),
          min: z.number().optional(),
          max: z.number().optional(),
          unit: z.string().optional(),
        })
        .strict(),
    ),
  },

  // ── pricing ───────────────────────────────────────────────────────
  {
    id: "pricing.unitPrice",
    group: "pricing",
    class: "C",
    question: "What is your price per unit for this capability?",
    why: "Price is never defaulted or guessed — only you set it.",
    fills: [{ artifact: "capability", path: "pricing.basePrice" }],
    requiredFor: "publish",
    neverDefault: true,
    valueSchema: z.string().regex(/^\d+(\.\d+)?$/, "decimal amount as a string"),
  },
  {
    id: "pricing.minimum",
    group: "pricing",
    class: "C",
    question: "Is there a minimum charge per job?",
    why: "A minimum protects you from unprofitable small jobs — never assumed.",
    fills: [{ artifact: "capability", path: "pricing.minimumCharge" }],
    requiredFor: "publish",
    neverDefault: true,
    valueSchema: z.string().regex(/^\d+(\.\d+)?$/, "decimal amount as a string"),
  },
  {
    id: "pricing.currency",
    group: "pricing",
    class: "C",
    question: "What currency is your price in?",
    why: "This is never assumed — it changes what buyers actually pay.",
    fills: [{ artifact: "capability", path: "pricing.currency" }],
    requiredFor: "publish",
    neverDefault: true,
    valueSchema: z.string().min(1).max(10),
  },

  // ── payout ────────────────────────────────────────────────────────
  {
    id: "payout.destination",
    group: "payout",
    class: "C",
    question:
      "Where should payouts be sent? (Stored securely in the payout system — never written into this record.)",
    why: "Payout details are sensitive: they go straight to the payout store (N21), and this record only ever keeps a \"set\" flag.",
    fills: [{ artifact: "gatewayPayoutStore", path: "destination" }],
    requiredFor: "get-paid",
    neverDefault: true,
    sensitive: true,
    valueSchema: SENSITIVE_SET_SCHEMA,
  },

  // ── availability ──────────────────────────────────────────────────
  {
    id: "availability.schedule",
    group: "availability",
    class: "C",
    question:
      "When can this device take jobs — always, specific windows, a cron schedule, or manual claim? What timezone?",
    why: "This is what the scheduler uses to decide when to offer you jobs.",
    fills: [{ artifact: "capability", path: "availability" }],
    requiredFor: "accept-jobs",
    valueSchema: z
      .object({
        mode: z.enum(["always", "windows", "cron", "manual-claim"]),
        timezone: z.string().min(1),
        windows: z.array(z.object({ start: z.string(), end: z.string() }).strict()).optional(),
        cron: z.string().optional(),
      })
      .strict(),
  },

  // ── sla ───────────────────────────────────────────────────────────
  {
    id: "sla.acceptanceWindowSec",
    group: "sla",
    class: "C",
    question: "How many seconds do you have to accept an offered job before it expires?",
    why: "This sets buyer expectations for how quickly you respond.",
    fills: [{ artifact: "capability", path: "sla.acceptanceWindowSec" }],
    requiredFor: "optional",
    valueSchema: z.number().int().positive(),
  },
  {
    id: "sla.completionDeadlineSec",
    group: "sla",
    class: "C",
    question: "How many seconds should a job take at most before it's considered late?",
    why: "This sets the SLA buyers see and what counts as a late job.",
    fills: [{ artifact: "capability", path: "sla.completionDeadlineSec" }],
    requiredFor: "optional",
    valueSchema: z.number().int().positive(),
  },
] as const;

// ── Forbidden keys (addendum: "NEVER asked or accepted") ───────────────

/**
 * Concepts the intake schema and `validateIntake` refuse anywhere in a record:
 * a verification result, the assurance tier, a hash/digest, a device key
 * binding or private key, event times/freshness, inspection independence, or
 * job completion/success. These are all *derived or attested downstream* —
 * never something intake collects or stores, even under a different field id.
 */
export const INTAKE_FORBIDDEN_KEYS = [
  "verificationResult",
  "verified",
  "assuranceTier",
  "hash",
  "digest",
  "deviceKeyBinding",
  "privateKey",
  "eventTime",
  "freshness",
  "inspectionIndependence",
  "jobCompletion",
  "jobSuccess",
] as const;
export type IntakeForbiddenKey = (typeof INTAKE_FORBIDDEN_KEYS)[number];

// ── Derived index ───────────────────────────────────────────────────────

/** Frozen, sorted list of every field id. A rename/add/remove changes this
 *  list — pin it in a test so the change is never silent. */
export const INTAKE_FIELD_IDS: readonly string[] = Object.freeze(
  [...INTAKE_FIELDS.map((f) => f.id)].sort(),
);
