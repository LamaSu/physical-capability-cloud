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
 *
 * Review-fix additions (2026-09-29):
 *   - `requiredFor` is now `readonly IntakeMilestone[]` (was a single
 *     milestone). `MILESTONE_IMPLIES` below makes milestone readiness
 *     CUMULATIVE: being ready for a later milestone in a chain also requires
 *     every field of the milestones it implies (`validateIntake` in index.ts
 *     is the sole consumer). A record can never be "ready" for a later
 *     milestone while missing an earlier one's fields.
 *   - `safety.supervision` / `safety.estop` now also gate "publish" (a
 *     listing can't go live without them), not just "accept-jobs" — they
 *     stay `neverDefault`.
 *   - `ifUnknown` records what "I don't know" triggers per R2 rule 3: either
 *     a RESEARCH_LIBRARY entry id, or a plain-language physical/decision
 *     check. Every `neverDefault` field carries one; money fields always
 *     carry a `check` (never a default, never research alone).
 *   - Forbidden-key matching (index.ts) is now case/underscore/hyphen-loose.
 *   - `location.cityCountry`'s question now says plainly that the answer may
 *     be shown publicly (the public kernel list shows exact coordinates).
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

/** Milestones a field can gate. "optional" fields never block a milestone.
 *  "tier1" / "tier2" readiness means only that the intake can feed a LIVE
 *  verifier (validateIntake fails closed on stub primitives and on answers
 *  that prove nothing); it never means the device is assured. */
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

/**
 * Direct milestone implications: "being ready for X also requires every field
 * needed for Y" (and, transitively, whatever Y itself implies). The
 * onboarding chain (register < identify < register-device < publish <
 * accept-jobs) and the evidence chain (tier1 < tier2) are both encoded as
 * direct edges here, plus the two named cross-links (tier1 implies
 * register-device; get-paid implies publish). "optional" implies nothing, and
 * nothing implies it — an optional field never blocks any other milestone.
 */
const MILESTONE_DIRECT_IMPLICATIONS: Readonly<Record<IntakeMilestone, readonly IntakeMilestone[]>> = {
  register: [],
  identify: ["register"],
  "register-device": ["identify"],
  publish: ["register-device"],
  "accept-jobs": ["publish"],
  tier1: ["register-device"],
  tier2: ["tier1"],
  "get-paid": ["publish"],
  optional: [],
};

function closeMilestoneImplications(
  direct: Readonly<Record<IntakeMilestone, readonly IntakeMilestone[]>>,
): Record<IntakeMilestone, readonly IntakeMilestone[]> {
  const result = {} as Record<IntakeMilestone, readonly IntakeMilestone[]>;
  for (const milestone of INTAKE_MILESTONES) {
    const seen = new Set<IntakeMilestone>([milestone]);
    const stack: IntakeMilestone[] = [...direct[milestone]];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...direct[next]);
    }
    result[milestone] = Object.freeze([...seen]);
  }
  return result;
}

/**
 * For milestone M, the full closure of milestones (including M itself) whose
 * `requiredFor` fields must be satisfied for a record to be "ready for M".
 * `validateIntake` (index.ts) is the sole consumer; exported so tests and
 * callers can inspect the chain directly rather than re-deriving it.
 */
export const MILESTONE_IMPLIES: Readonly<Record<IntakeMilestone, readonly IntakeMilestone[]>> = Object.freeze(
  closeMilestoneImplications(MILESTONE_DIRECT_IMPLICATIONS),
);

/** R2 rule 6: every answer records its provenance. `research`/`confirmed`
 *  require a `source` (enforced by IntakeAnswerSchema in index.ts). The value
 *  is descriptive metadata written by whoever builds the record, not authority:
 *  what authenticates a human is the confirmation store behind IntakeAuthority
 *  (index.ts). */
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

/** What "I don't know" triggers for a field (R2 rule 3): either a
 *  RESEARCH_LIBRARY entry id the agent runs, or a plain-language physical
 *  check / decision the human makes themselves (never a default). */
export type IntakeIfUnknown = { readonly research: string } | { readonly check: string };

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
  /** Every milestone this field directly gates. `validateIntake` also treats
   *  a milestone as requiring this field whenever the milestone it's checking
   *  IMPLIES one of these (see MILESTONE_IMPLIES) — readiness is cumulative. */
  readonly requiredFor: readonly IntakeMilestone[];
  /** R2 rule 4: an empty/guessed answer never satisfies this field's milestone. */
  readonly neverDefault?: boolean;
  /** R2 rule 5: the intake record may only ever hold {set: true} for this field —
   *  never the real value. `valueSchema` below already encodes that shape. */
  readonly sensitive?: boolean;
  readonly evidencePrimitive?: IntakeEvidencePrimitiveRef;
  /** Addendum: calibration.* map to decl.self_attested ONLY — the form must say
   *  "self-declared", and the answer is never elevated by research alone. */
  readonly selfDeclaredOnly?: boolean;
  /** R2 rule 3: what "I don't know" triggers for this field. Omitted only for
   *  fields no human is ever realistically asked to answer from memory. */
  readonly ifUnknown?: IntakeIfUnknown;
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
    question: "What name should buyers see as the operator of this device?",
    why: "This is the name that appears on every listing and job you accept.",
    fills: [
      { artifact: "kernel", path: "name" },
      { artifact: "operatorProfile", path: "displayName" },
    ],
    requiredFor: ["register"],
    valueSchema: z.string().min(1).max(200),
  },
  {
    id: "operator.contactEmail",
    group: "identity",
    class: "C",
    question: "What email should account and job notices go to?",
    why: "We need a channel to reach you about jobs, approvals, and account security.",
    fills: [
      { artifact: "operatorProfile", path: "contactEmail" },
      { artifact: "notificationChannel", path: "email" },
    ],
    requiredFor: ["register"],
    valueSchema: z.string().email(),
  },
  {
    id: "operator.authority",
    group: "identity",
    class: "C",
    question: "Is this device yours to offer, or are you setting it up for someone who decides about it?",
    why: "Only the person who controls a device can offer it for work — this is never assumed.",
    fills: [{ artifact: "registration", path: "attestation.authority" }],
    requiredFor: ["register"],
    neverDefault: true,
    ifUnknown: {
      check:
        "Pause here and check with whoever owns or controls this device before continuing — don't guess or decide on someone else's behalf.",
    },
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
    requiredFor: ["identify"],
    ifUnknown: {
      check:
        "Take a photo of the label and describe whatever you see — a rough guess of what it does is enough for the agent to search from.",
    },
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
    requiredFor: ["register-device"],
    ifUnknown: { research: "identify-make-model" },
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
    requiredFor: ["register-device"],
    ifUnknown: { research: "identify-make-model" },
    valueSchema: z.string().min(1).max(200),
  },
  {
    id: "device.serialNumber",
    group: "device",
    class: "C",
    question: "What is the device's serial number (from its label)?",
    why: "The serial number ties this specific unit to its device record.",
    fills: [{ artifact: "deviceRecord", path: "serialNumber" }],
    requiredFor: ["register-device"],
    ifUnknown: {
      check:
        "Look for a printed serial number on the device's data plate or a sticker near the power input. If it truly has none, say so.",
    },
    valueSchema: z.string().min(1).max(200),
  },
  {
    id: "device.firmware",
    group: "device",
    class: "A",
    question: "Confirm the device's firmware version.",
    why: "Firmware version affects which commands and safety behaviors are available (N83 G8).",
    fills: [{ artifact: "deviceRecord", path: "firmware" }],
    requiredFor: ["register-device"],
    ifUnknown: {
      check:
        "Check the device's display, status page, or companion app's \"About\" or \"System Info\" screen for a firmware or software version.",
    },
    valueSchema: z.string().min(1).max(200),
  },
  {
    id: "device.adapterType",
    group: "device",
    class: "A",
    question: "Confirm the adapter type PCC should use to talk to this device.",
    why: "This selects the real adapter that will run jobs — it is never \"mock\" for a live device.",
    fills: [{ artifact: "registerDevice", path: "adapterType" }],
    requiredFor: ["register-device"],
    ifUnknown: { research: "find-remote-interface" },
    valueSchema: z.enum(DEVICE_ADAPTER_TYPE_VALUES),
  },

  // ── location ──────────────────────────────────────────────────────
  {
    id: "location.cityCountry",
    group: "location",
    class: "C",
    question: "What city and country is this device located in? (Shown publicly on your listing.)",
    why: "Buyers need this to judge shipping time and jurisdiction — it's shown publicly, so keep it to city and country, never a street address.",
    fills: [{ artifact: "capability", path: "location" }],
    requiredFor: ["publish"],
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
    requiredFor: ["optional"],
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
    requiredFor: ["register-device"],
    ifUnknown: {
      check:
        "Ask whoever manages your network whether this device has a fixed IP, and whether it's on the same network segment as the machine running the agent.",
    },
    valueSchema: z.object({ sameLan: z.boolean(), staticIp: z.boolean() }).strict(),
  },
  {
    id: "network.outboundHttps",
    group: "network",
    class: "C",
    question: "Can this device (or its host) make outbound HTTPS calls?",
    why: "Outbound-only connectivity lets us use pcc-node without opening any inbound ports.",
    fills: [{ artifact: "deploymentChoice", path: "outboundHttps" }],
    requiredFor: ["register-device"],
    ifUnknown: {
      check:
        "Try loading any https:// page from a browser on the same network as the device — if that works, outbound HTTPS is very likely allowed.",
    },
    valueSchema: z.boolean(),
  },
  {
    id: "network.inboundBlocked",
    group: "network",
    class: "C",
    question: "Is inbound access to this device blocked by a firewall or NAT?",
    why: "This confirms whether pcc-node's outbound-only design is required.",
    fills: [{ artifact: "deploymentChoice", path: "inboundBlocked" }],
    requiredFor: ["register-device"],
    ifUnknown: {
      check:
        "Ask whoever manages your router or firewall whether inbound connections to this device are blocked — most home and office routers block inbound by default.",
    },
    valueSchema: z.boolean(),
  },

  // ── safety ────────────────────────────────────────────────────────
  {
    id: "safety.supervision",
    group: "safety",
    class: "C",
    question: "When it runs a job, will someone be nearby, or will it run unattended? If someone's nearby, who?",
    why: "Supervision level is never assumed — it directly bounds which jobs are safe to accept.",
    fills: [{ artifact: "safetyEnvelope", path: "supervision" }],
    // Review fix: a device can't be published (listed) without this either —
    // not just gated at accept-jobs. Never "register": that comes before any
    // device is even described.
    requiredFor: ["publish", "accept-jobs"],
    neverDefault: true,
    ifUnknown: {
      check:
        "Decide whether someone will be physically present, watching remotely, or nobody at all while a job runs — this is a decision only you can make.",
    },
    valueSchema: z.enum(["attended", "unattended", "remote-supervised"]),
  },
  {
    id: "safety.estop",
    group: "safety",
    class: "C",
    question: "How do you stop this device in an emergency — for example a stop button, a power switch, or a lid switch — and where is it?",
    why: "Before anything runs, we need a way to stop it that doesn't depend on software — this is never assumed.",
    fills: [{ artifact: "safetyEnvelope", path: "estop" }],
    // Review fix: also gates publish — see safety.supervision above.
    requiredFor: ["publish", "accept-jobs"],
    neverDefault: true,
    ifUnknown: { research: "find-safety-limits" },
    // Sensors' R8 shape (#4200, draft #465): the safety envelope reads it as is.
    valueSchema: z
      .object({
        mechanism: z.enum(["hardware", "adapter-stop", "none"]),
        stopCommand: z.string().min(1).max(200).optional(),
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
    requiredFor: ["accept-jobs"],
    neverDefault: true,
    ifUnknown: { research: "find-safety-limits" },
    valueSchema: z.array(z.enum(["chemical", "laser", "heat", "mechanical", "biological"])),
  },
  {
    id: "safety.limits",
    group: "safety",
    class: "B",
    question:
      "Here are the safety limits we found for this device, with where each came from — confirm each one, or correct it.",
    why: "The device refuses any operation outside these limits, so they must be right for your unit — never a guess.",
    fills: [
      { artifact: "safetyEnvelope", path: "limits" },
      { artifact: "csd", path: "typedIO.bounds" },
    ],
    requiredFor: ["accept-jobs"],
    neverDefault: true,
    ifUnknown: { research: "find-safety-limits" },
    valueSchema: z
      // Sensors' R8 shape (#4200): one confirmed limit per template quantity. A
      // limit needs BOTH sides; a one-sided research bound stays a question in R8.
      .array(
        z
          .object({
            quantity: z.string().min(1).max(120),
            unit: z.string().min(1).max(40),
            min: z.number().finite(),
            max: z.number().finite(),
          })
          .strict()
          .refine((l) => l.min <= l.max, { message: "a limit's min must not exceed its max" }),
      )
      .min(1),
  },

  {
    // Sensors' R8 (#4254): the operator's own ceiling on how fast PCC may command the device.
    id: "safety.commandRate",
    group: "safety",
    class: "C",
    question: "At most how many commands per minute may PCC send to this device?",
    why: "The safety envelope refuses commands faster than this, so a runaway job can't overload the device.",
    fills: [{ artifact: "safetyEnvelope", path: "commandRate.maxPerMinute" }],
    requiredFor: ["accept-jobs"],
    neverDefault: true,
    ifUnknown: { research: "find-safety-limits" },
    valueSchema: z.number().int().positive().max(100000),
  },

  // ── consumables ───────────────────────────────────────────────────
  {
    id: "consumables.items",
    group: "consumables",
    class: "C",
    question: "What does each job use up — for example tips, reagents, filament, or paper?",
    why: "This lets buyers and the scheduler know what's needed to run a job.",
    fills: [{ artifact: "capabilityAvailability", path: "consumables.items" }],
    requiredFor: ["accept-jobs"],
    ifUnknown: { research: "find-consumables" },
    valueSchema: z.array(z.string().min(1)),
  },
  {
    id: "consumables.restockedBy",
    group: "consumables",
    class: "C",
    question: "Who refills these consumables, and how often?",
    why: "This sets expectations for availability and avoids mid-job surprises.",
    fills: [{ artifact: "capabilityAvailability", path: "consumables.restockedBy" }],
    requiredFor: ["accept-jobs"],
    ifUnknown: { research: "find-consumables" },
    valueSchema: z.string().min(1),
  },
  {
    id: "consumables.loadedMaterial",
    group: "consumables",
    class: "C",
    question: "What material or consumable is currently loaded?",
    why: "The loaded material determines which operating bands from the manual actually apply right now.",
    fills: [{ artifact: "safetyEnvelope", path: "loadedMaterial" }],
    requiredFor: ["accept-jobs"],
    ifUnknown: {
      check:
        "Look at what's physically loaded right now and name it as specifically as you can (brand and material, not just \"filament\").",
    },
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
    requiredFor: ["tier1"],
    selfDeclaredOnly: true,
    evidencePrimitive: { id: "decl.self_attested", status: "live" },
    ifUnknown: {
      check:
        "Check your maintenance log or the device's calibration sticker. If you're still not sure, calibrate it now and record today's date.",
    },
    valueSchema: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
  },
  {
    id: "calibration.procedureRef",
    group: "calibration",
    class: "B",
    question: "Which calibration procedure did you follow? (self-declared)",
    why: "Research can suggest a procedure, but only your confirmation makes it the record — self-declared only.",
    fills: [{ artifact: "evidencePlan", path: "calibration.procedureRef" }],
    requiredFor: ["tier1"],
    selfDeclaredOnly: true,
    evidencePrimitive: { id: "decl.self_attested", status: "live" },
    ifUnknown: { research: "find-calibration" },
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
    requiredFor: ["tier1"],
    ifUnknown: {
      check:
        "Name the device id of the machine that actually performs the job — not a camera or sensor only watching it.",
    },
    valueSchema: z.string().min(1),
  },
  {
    id: "evidence.observerDeviceIds",
    group: "evidence",
    class: "C",
    question: "Which device ids (if any) only observe the job, without executing it?",
    why: "An observer that isn't also the executor is what makes an inspection independent — we derive that, we don't ask you to assert it.",
    fills: [{ artifact: "provenanceRecipe", path: "observerDeviceIds" }],
    requiredFor: ["tier1"],
    ifUnknown: {
      check:
        "List the device ids of any camera or sensor that watches the job without controlling it. Leave it empty if nothing else observes.",
    },
    valueSchema: z.array(z.string().min(1)),
  },
  {
    id: "evidence.executionMode",
    group: "evidence",
    class: "A",
    question: "Is this run against the real device, or a mock/dry-run adapter?",
    why: "A mock or dry-run answer caps the job's evidence at tier 0 — it can lower the tier, never raise it.",
    fills: [{ artifact: "evidencePlan", path: "confirm.execution_mode" }],
    requiredFor: ["tier1"],
    evidencePrimitive: { id: "confirm.execution_mode", status: "live" },
    valueSchema: z.enum(["real", "mock", "dry_run"]),
  },
  {
    id: "evidence.camera",
    group: "evidence",
    class: "C",
    question:
      "Where could a camera see this job's result — does it see the work area, does it see the output, is it fixed or handheld, and which device id captures it?",
    why: "Buyers pay against evidence that the work happened, and what the camera can see decides how strong that evidence is.",
    fills: [{ artifact: "evidencePlan", path: "capture.photo_nonced.placement" }],
    requiredFor: ["tier2"],
    evidencePrimitive: { id: "capture.photo_nonced", status: "stub" },
    ifUnknown: {
      check:
        "Look for a camera already pointed at the work area or output — a webcam, a phone on a stand, a security camera. If there isn't one yet, say so; the agent can suggest a placement.",
    },
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
    requiredFor: ["tier1"],
    ifUnknown: {
      check: "Think about your usual routine: are you standing at the device while it runs, checking in occasionally, or away entirely?",
    },
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
    requiredFor: ["tier2"],
    evidencePrimitive: { id: "approval.expert", status: "stub" },
    ifUnknown: {
      check: "Name the specific person who will review job evidence for this device — a name and contact, not a role or team.",
    },
    valueSchema: z.object({ name: z.string().min(1), contact: z.string().min(1).optional() }).strict(),
  },
  {
    id: "evidence.controllerRunLog",
    group: "evidence",
    class: "C",
    question: "Can the controller export its own execution log per job? If so, via API or file?",
    why: "A per-job exportable log is what lets us build a trustworthy machine execution record.",
    fills: [{ artifact: "evidencePlan", path: "machine.execution_log" }],
    requiredFor: ["tier1"],
    evidencePrimitive: { id: "machine.execution_log", status: "stub" },
    ifUnknown: { research: "find-evidence-signals" },
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
    requiredFor: ["tier1"],
    // "maps to receipt.kernel_signed plus ident.registered_key (stub under the
    // lockstep rule)" — recorded against ident.registered_key (verifierStatus
    // "stub"), the weaker/gating half of the pair, so the field's declared
    // status matches the registry exactly with no special-case exception.
    evidencePrimitive: { id: "ident.registered_key", status: "stub" },
    ifUnknown: { research: "find-evidence-signals" },
    valueSchema: z.boolean(),
  },
  {
    id: "evidence.referenceSample",
    group: "evidence",
    class: "C",
    question: "Do you have a reference sample with a known expected result?",
    why: "A known-good test pair is the strongest cheap proof that the capability actually works.",
    fills: [{ artifact: "evidencePlan", path: "measure.io_test_pair" }],
    requiredFor: ["tier1"],
    evidencePrimitive: { id: "measure.io_test_pair", status: "stub" },
    ifUnknown: {
      check:
        "Check whether you have a past output with a known-good result to compare a new job against. If not, say so — this proof method just isn't available yet.",
    },
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
    requiredFor: ["publish"],
    ifUnknown: { research: "search-existing-csd" },
    valueSchema: z.string().min(1),
  },
  {
    id: "capability.parameters",
    group: "capability",
    class: "B",
    question: "Confirm the typed parameters and ranges we found for this capability.",
    why: "Buyers configure jobs against these typed ranges — they must be confirmed, not guessed.",
    fills: [{ artifact: "csd", path: "typedIO" }],
    requiredFor: ["publish"],
    ifUnknown: { research: "find-io-ranges" },
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
    question: "What should one job cost? During the public beta, payments settle on a test network, so no real money moves yet.",
    why: "Only you decide what your work costs — this is never assumed or guessed.",
    fills: [{ artifact: "capability", path: "pricing.basePrice" }],
    requiredFor: ["publish"],
    neverDefault: true,
    ifUnknown: {
      check:
        "Look at what comparable services charge as a reference point, then decide your own price — a reference is never the answer itself.",
    },
    valueSchema: z.string().regex(/^\d+(\.\d+)?$/, "decimal amount as a string"),
  },
  {
    id: "pricing.minimum",
    group: "pricing",
    class: "C",
    question: "Is there a minimum charge per job?",
    why: "A minimum protects you from unprofitable small jobs — never assumed.",
    fills: [{ artifact: "capability", path: "pricing.minimumCharge" }],
    requiredFor: ["publish"],
    neverDefault: true,
    ifUnknown: {
      check: "Decide whether a small job would be unprofitable at your per-unit price. If so, set a minimum; if not, say there isn't one.",
    },
    valueSchema: z.string().regex(/^\d+(\.\d+)?$/, "decimal amount as a string"),
  },
  {
    id: "pricing.currency",
    group: "pricing",
    class: "C",
    question: "What currency is your price in?",
    why: "This is never assumed — it changes what buyers actually pay.",
    fills: [{ artifact: "capability", path: "pricing.currency" }],
    requiredFor: ["publish"],
    neverDefault: true,
    ifUnknown: {
      check: "Decide which currency you want to be paid in — this is never assumed on your behalf.",
    },
    valueSchema: z.string().min(1).max(10),
  },

  // ── payout ────────────────────────────────────────────────────────
  {
    id: "payout.destination",
    group: "payout",
    class: "C",
    question:
      "Which wallet address should your payments go to? (During the beta this is a test-network address. Never a private key or recovery phrase.)",
    why: "Your earnings go only where you say — this is never assumed, and the address itself is never written into this record; it goes straight to the payout store.",
    fills: [{ artifact: "gatewayPayoutStore", path: "destination" }],
    requiredFor: ["get-paid"],
    neverDefault: true,
    sensitive: true,
    ifUnknown: {
      check: "Have your wallet address ready (a test-network address during the beta). Never type a private key or recovery phrase here.",
    },
    valueSchema: SENSITIVE_SET_SCHEMA,
  },

  // ── availability ──────────────────────────────────────────────────
  {
    id: "availability.schedule",
    group: "availability",
    class: "C",
    question:
      "When can this device take jobs — for example \"weekdays 9 to 5\" or \"any time\"? Tell us the mode (always, specific windows, a cron schedule, or manual claim) and the timezone.",
    why: "Buyers plan around it, and jobs shouldn't arrive when nobody can refill or supervise it.",
    fills: [{ artifact: "capability", path: "availability" }],
    requiredFor: ["accept-jobs"],
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
    requiredFor: ["optional"],
    valueSchema: z.number().int().positive(),
  },
  {
    id: "sla.completionDeadlineSec",
    group: "sla",
    class: "C",
    question: "How many seconds should a job take at most before it's considered late?",
    why: "This sets the SLA buyers see and what counts as a late job.",
    fills: [{ artifact: "capability", path: "sla.completionDeadlineSec" }],
    requiredFor: ["optional"],
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
 * Matching is case/underscore/hyphen-loose (index.ts) — a variant spelling
 * like `assurance_tier` or `PrivateKey` is refused exactly like the canonical
 * spelling below.
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
