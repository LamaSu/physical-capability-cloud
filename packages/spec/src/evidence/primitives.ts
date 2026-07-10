/**
 * Evidence-Primitive Vocabulary v1 — the bounded settlement vocabulary.
 *
 * Layer-2 of the three-layer model (see ai/research/pcc-evidence-vocabulary-v1.md
 * §2): RFC-001 OPENS Layer-1 event schemas and Layer-3 compositions; this file is
 * the BOUNDED middle — what the oracle can authenticate and check. Tier
 * eligibility flows ONLY through this layer: generic schema-relative rules
 * authenticate nothing; a primitive is exactly what adds authentication.
 *
 * This ships the v1 cut (16 primitives, §7.1) PLUS the additive v1.5-industrial
 * cut (#52-#55, Family L `record` + Family C telemetry — the sensor/machine-log
 * primitives that bind already-built verifiers; see
 * ai/research/pcc-evidence-vocab-sensor-machinelog.md). All `status:"active"`.
 * The full space is 51+ primitives; further v1.5 / v2 primitives are appended to
 * EVIDENCE_PRIMITIVES as their verifiers land (§7.2 / §7.3), each an independent
 * commitment. The vocabulary grows in DATA (registry entries), never in code
 * shape — this is deliberately data, not per-vertical code.
 *
 * Every primitive is an INPUT the oracle authenticates before minting the single
 * fee-carrying attestation. Nothing here adds a release rail (durable constraint
 * D1: everything settles through the oracle).
 *
 * VOCAB_MANIFEST_HASH is sha256 over the canonical JSON of the sorted active
 * defs' CONTRACT fields — everything EXCEPT `proves` (human prose) and
 * `verifierStatus` (impl-tracking), which are not the contract. A golden-hash
 * test locks it, so any contract change is caught. This mirrors the RFC-001 hash
 * discipline in verification-program.ts (which likewise excludes non-contract
 * fields such as publishedAt from its programHash).
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "../util/canonical.js";

// ── Field enums (spec §5.1 axes) ────────────────────────────────────

/** The families — each a unit of shared oracle machinery (spec §3).
 *  `record` is Family L (PROCESS & MACHINE RECORDS: machine.* + process.*), added
 *  in the v1.5-industrial cut — records the executing system keeps about its own
 *  execution, verified by chain/sequence machinery (see
 *  ai/research/pcc-evidence-vocab-sensor-machinelog.md §4). Like `meta`, the family
 *  value names the category, not any single id-prefix. */
export const EVIDENCE_FAMILIES = [
  "artifact",
  "capture",
  "telemetry",
  "custody",
  "confirm",
  "receipt",
  "attest",
  "doc",
  "measure",
  "pay",
  "meta",
  "record",
] as const;
export type EvidenceFamily = (typeof EVIDENCE_FAMILIES)[number];

/** The authentication ladder (spec §2.5). */
export const AUTH_REQUIREMENTS = [
  "none",
  "platform",
  "actor-signed",
  "device-signed",
  "multi-party",
  "crypto-proof",
  "inherited",
] as const;
export type AuthRequirement = (typeof AUTH_REQUIREMENTS)[number];

/** Objectivity band per the verification-philosophy scale (spec §2.5). */
export const OBJECTIVITY_BANDS = ["B1", "B2", "B3", "B4", "B5"] as const;
export type ObjectivityBand = (typeof OBJECTIVITY_BANDS)[number];

/** Vocabulary status of a primitive. `reserved`/`deprecated` fail closed. */
export type PrimitiveStatus = "active" | "reserved" | "deprecated";

/**
 * verifierStatus — implementation-tracking axis BEYOND the §5.1 normative
 * fields. It is deliberately NOT part of VOCAB_MANIFEST_HASH: it changes as the
 * oracle lane ships verifiers, which is not a vocabulary-contract change.
 *   - "live"    — machinery exists and runs today (no new verifier needed).
 *   - "stub"    — the vocabulary defines it first-class; the oracle verifier is
 *                 stubbed/planned and fails CLOSED at verification time (spec §8)
 *                 until built (the "separate oracle lane").
 *   - "planned" — future/reserved; no verifier intended in this cut.
 */
export type VerifierStatus = "live" | "stub" | "planned";

/** Minimal JSON-Schema-shaped params descriptor (avoids a json-schema dep). */
export type PrimitiveParamsSchema = Record<string, unknown>;

/** One tier this primitive can contribute to, with the why. */
export interface TierSupport {
  tier: 0 | 1 | 2 | 3;
  /** Why this tier is reachable / any rung condition. Envelopes: computed. */
  conditions?: string;
}

/**
 * EvidencePrimitiveDef — one bounded primitive.
 *
 * Fields per spec §5.1: id, wire, family, status, proves, paramsSchema,
 * authRequirement, tierSupport, objectivityBand, dependsOn, upgrades, gates —
 * plus verifierStatus (implementation tracking, see above). Composition is
 * carried by dependsOn (hard) / upgrades (soft) / gates (negative gate).
 */
export interface EvidencePrimitiveDef {
  /** Short form `<family>.<name>`, used in CSD `primitives[]` and rule refs. */
  id: string;
  /** Wire/schema form `pcc.ev.<family>.<name>.vN`. */
  wire: string;
  family: EvidenceFamily;
  status: PrimitiveStatus;
  /** The claim, stated as a sentence a payer can read. */
  proves: string;
  /** Per-primitive params contract (minClass, integrityGrade, channel, …). */
  paramsSchema: PrimitiveParamsSchema;
  authRequirement: AuthRequirement;
  /** Which of 0-3 this can contribute to. Envelopes inherit (full range). */
  tierSupport: TierSupport[];
  objectivityBand: ObjectivityBand;
  verifierStatus: VerifierStatus;
  /** Hard: an unmet dependency ⇒ primitive not-met / not tier-eligible. */
  dependsOn?: string[];
  /** Soft: presence raises the target's effective tier/class. */
  upgrades?: string[];
  /** Negative gate (e.g. confirm.execution_mode caps at tier 0 when mock). */
  gates?: boolean;
}

// ── Runtime validation schema ───────────────────────────────────────

const TierSupportSchema = z.object({
  tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  conditions: z.string().optional(),
});

/**
 * Zod schema validating one primitive def is structurally well-formed. The
 * TypeScript type is the hand-written interface above; this schema is the
 * runtime guard (the golden "registry validates" invariant).
 */
export const EvidencePrimitiveDefSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z]+\.[a-z0-9_]+$/, "id is <family>.<name> snake_case"),
  wire: z
    .string()
    .min(1)
    .regex(/^pcc\.ev\.[a-z]+\.[a-z0-9_]+\.v\d+$/, "wire is pcc.ev.<family>.<name>.vN"),
  family: z.enum([...EVIDENCE_FAMILIES] as [string, ...string[]]),
  status: z.enum(["active", "reserved", "deprecated"]),
  proves: z.string().min(1),
  paramsSchema: z.record(z.unknown()),
  authRequirement: z.enum([...AUTH_REQUIREMENTS] as [string, ...string[]]),
  tierSupport: z.array(TierSupportSchema).min(1),
  objectivityBand: z.enum([...OBJECTIVITY_BANDS] as [string, ...string[]]),
  verifierStatus: z.enum(["live", "stub", "planned"]),
  dependsOn: z.array(z.string()).optional(),
  upgrades: z.array(z.string()).optional(),
  gates: z.boolean().optional(),
});

// ── The v1 cut — 16 primitives (spec §7.1) ──────────────────────────
//
// verifierStatus "live" = the four with machinery already built/wired that need
// NO new verifier (spec §7.1 + task): approval.payer, receipt.kernel_signed,
// confirm.execution_mode, decl.self_attested. All others are "stub": defined
// first-class here, oracle verifier built in the separate oracle lane.
//
// Encoding conventions for the special primitives (documented so the golden hash
// and the eligibility lint are reproducible):
//   - decl.self_attested: tierSupport [0] only (grants only the typed tier-0 floor).
//   - gate (confirm.execution_mode): tierSupport [0..3], gates:true.
//   - modifier (fresh.challenge_bound): tierSupport [1..3], each conditions:"modifier".
//   - enabler (ident.registered_key): tierSupport [1..3], conditions:"enabler".
//   - envelope ⬖ (pay.escrow_receipt): tierSupport [0..3], conditions:"inherited".

export const EVIDENCE_PRIMITIVES: readonly EvidencePrimitiveDef[] = [
  // #28 — Family G (attest). BUILT + WIRED + TESTED. The tier≥2 human floor (D8).
  {
    id: "approval.payer",
    wire: "pcc.ev.approval.payer.v1",
    family: "attest",
    status: "active",
    proves:
      "The payer, with a key pre-registered at job creation, approved (or reasoned-rejected) the committed evidence.",
    paramsSchema: {
      type: "object",
      properties: {
        approverRole: { type: "string", enum: ["payer"] },
        claimIds: { type: "array", items: { type: "string" } },
      },
      additionalProperties: true,
    },
    authRequirement: "actor-signed",
    tierSupport: [{ tier: 2 }, { tier: 3 }],
    objectivityBand: "B5",
    verifierStatus: "live",
  },

  // #29 — Family G (attest). Rubric sign-off; same machinery as #28, wiring pending.
  {
    id: "approval.expert",
    wire: "pcc.ev.approval.expert.v1",
    family: "attest",
    status: "active",
    proves:
      "A pre-registered domain expert attested the evidence satisfies specific rubric claims agreed pre-job.",
    paramsSchema: {
      type: "object",
      properties: {
        approverRole: { type: "string", enum: ["expert"] },
        claimIds: { type: "array", items: { type: "string" } },
        rubricRef: { type: "string" },
      },
      additionalProperties: true,
    },
    authRequirement: "actor-signed",
    tierSupport: [{ tier: 2 }, { tier: 3 }],
    objectivityBand: "B4",
    verifierStatus: "stub",
  },

  // #21 — Family E (confirm). Kills the mock-success class (the pizza incident).
  {
    id: "confirm.execution_mode",
    wire: "pcc.ev.confirm.execution_mode.v1",
    family: "confirm",
    status: "active",
    proves:
      "The execution ran against the real upstream (not a mock/stub/dry-run); mock or dry_run hard-caps the bundle at tier 0.",
    paramsSchema: {
      type: "object",
      properties: { expected: { type: "string", enum: ["real"] } },
      additionalProperties: false,
    },
    authRequirement: "inherited",
    tierSupport: [
      { tier: 0, conditions: "mock/dry_run caps here (negative gate)" },
      { tier: 1 },
      { tier: 2 },
      { tier: 3 },
    ],
    objectivityBand: "B1",
    verifierStatus: "live",
    dependsOn: ["receipt.kernel_signed"],
    gates: true,
  },

  // #46 — Family K (meta). Typed tier-0 floor; the eligibility rule's teeth.
  {
    id: "decl.self_attested",
    wire: "pcc.ev.decl.self_attested.v1",
    family: "meta",
    status: "active",
    proves:
      "The operator formally declared a value/claim (schema-valid, operator-signed, in-window) — the typed tier-0 floor.",
    paramsSchema: {
      type: "object",
      properties: { schemaRef: { type: "string" } },
      additionalProperties: true,
    },
    authRequirement: "actor-signed",
    tierSupport: [
      { tier: 0, conditions: "grants only tier 0; contributes context at any tier" },
    ],
    objectivityBand: "B1",
    verifierStatus: "live",
  },

  // #1 — Family A (artifact). Integrity floor on BOTH evidence paths. LIVE-partial
  // in the oracle (IPFS path); gateway-fallback hole is the step-0 fix, so "stub".
  {
    id: "artifact.hash",
    wire: "pcc.ev.artifact.hash.v1",
    family: "artifact",
    status: "active",
    proves:
      "This exact content existed at commitment time and is what the job's on-chain submitEvidence hash refers to.",
    paramsSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["plain", "redacted-commit"], default: "plain" },
      },
      additionalProperties: false,
    },
    authRequirement: "none",
    tierSupport: [
      { tier: 1, conditions: "integrity floor; grants none alone above 1" },
      { tier: 2 },
      { tier: 3 },
    ],
    objectivityBand: "B1",
    verifierStatus: "stub",
  },

  // #48 — Family K (meta). Anti-prefabrication modifier; fully typed today.
  {
    id: "fresh.challenge_bound",
    wire: "pcc.ev.fresh.challenge_bound.v1",
    family: "meta",
    status: "active",
    proves:
      "The evidence was produced after a chain-anchored challenge (cannot be pre-fabricated) — the generic freshness modifier.",
    paramsSchema: {
      type: "object",
      properties: {
        form: { type: "string", enum: ["execution", "capture"] },
        maxAgeSeconds: { type: "number" },
      },
      additionalProperties: false,
    },
    authRequirement: "crypto-proof",
    tierSupport: [
      { tier: 1, conditions: "modifier — upgrades whatever it binds; grants no tier alone" },
      { tier: 2, conditions: "modifier" },
      { tier: 3, conditions: "modifier" },
    ],
    objectivityBand: "B1",
    verifierStatus: "stub",
  },

  // #45 — Family J (pay), envelope ⬖. Composed-job settlement (the compose rail).
  {
    id: "pay.escrow_receipt",
    wire: "pcc.ev.pay.escrow_receipt.v1",
    family: "pay",
    status: "active",
    proves:
      "A child job settled through the oracle (Mode-B attestation exists and released) — the composed-job settlement input.",
    paramsSchema: {
      type: "object",
      properties: {
        childJobId: { type: "string" },
        childEscrow: { type: "string" },
      },
      additionalProperties: true,
    },
    authRequirement: "crypto-proof",
    tierSupport: [
      { tier: 0, conditions: "inherited from child (min over children)" },
      { tier: 1, conditions: "inherited" },
      { tier: 2, conditions: "inherited" },
      { tier: 3, conditions: "inherited" },
    ],
    objectivityBand: "B1",
    verifierStatus: "stub",
  },

  // #47 — Family K (meta). Dependency of everything signed; replaces the HTTP-ok
  // kernel-identity check (step 0).
  {
    id: "ident.registered_key",
    wire: "pcc.ev.ident.registered_key.v1",
    family: "meta",
    status: "active",
    proves:
      "The signing subject (kernel, device, approver, witness, model, credential holder) resolves live in the relevant pinned registry snapshot.",
    paramsSchema: {
      type: "object",
      properties: {
        registryId: { type: "string" },
        snapshotHash: { type: "string" },
      },
      additionalProperties: true,
    },
    authRequirement: "actor-signed",
    tierSupport: [
      { tier: 1, conditions: "enabler/dependency — grants no tier alone" },
      { tier: 2, conditions: "enabler" },
      { tier: 3, conditions: "enabler" },
    ],
    objectivityBand: "B1",
    verifierStatus: "stub",
  },

  // #22 — Family F (receipt). Digital connectors' tier 1-2 EARNED. LIVE emit-side ×7.
  {
    id: "receipt.kernel_signed",
    wire: "pcc.ev.receipt.kernel_signed.v1",
    family: "receipt",
    status: "active",
    proves:
      "A registered kernel executed a capability and commits to its inputs/outputs (Ed25519-signed toKernelOutput).",
    paramsSchema: {
      type: "object",
      properties: { capability: { type: "string" } },
      additionalProperties: true,
    },
    authRequirement: "actor-signed",
    tierSupport: [
      { tier: 1 },
      {
        tier: 2,
        conditions:
          "with confirm.execution_mode=real + registered-key freshness (+ target-system where claimed)",
      },
    ],
    objectivityBand: "B1",
    verifierStatus: "live",
    dependsOn: ["ident.registered_key"],
  },

  // #8 — Family C (telemetry). Delivery/on-site instantly. LIVE kernel-side (courier).
  {
    id: "telemetry.geofence_event",
    wire: "pcc.ev.telemetry.geofence_event.v1",
    family: "telemetry",
    status: "active",
    proves:
      "A point-in-time position fix was inside radius R of an expected location at time T.",
    paramsSchema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lng: { type: "number" },
        radiusM: { type: "number" },
      },
      required: ["lat", "lng", "radiusM"],
      additionalProperties: true,
    },
    authRequirement: "platform",
    tierSupport: [
      { tier: 1, conditions: "platform app fix" },
      { tier: 2, conditions: "device-signed fix or corroborated by a second party's fix" },
    ],
    objectivityBand: "B1",
    verifierStatus: "stub",
  },

  // #18 — Family E (confirm). POD's strongest cheap artifact. Nonce infra LIVE.
  {
    id: "confirm.recipient_nonce",
    wire: "pcc.ev.confirm.recipient_nonce.v1",
    family: "confirm",
    status: "active",
    proves:
      "A human at the destination took a deliberate action bound to this job (OTP/PIN/QR presented by the recipient at handoff).",
    paramsSchema: {
      type: "object",
      properties: { validityWindowSeconds: { type: "number" } },
      additionalProperties: true,
    },
    authRequirement: "platform",
    tierSupport: [
      { tier: 2, conditions: "a human at the destination acted — real independence" },
    ],
    objectivityBand: "B1",
    verifierStatus: "stub",
  },

  // #19 — Family E (confirm). Courier tier-3 row becomes checkable. Field exists in CSD.
  {
    id: "confirm.recipient_signature",
    wire: "pcc.ev.confirm.recipient_signature.v1",
    family: "confirm",
    status: "active",
    proves:
      "Someone at the destination signed on-glass / acknowledged receipt (platform-attested image blob; no biometric claim is made).",
    paramsSchema: { type: "object", additionalProperties: true },
    authRequirement: "platform",
    tierSupport: [
      { tier: 1 },
      { tier: 2, conditions: "combined with geostamp + platform webhook authenticity" },
    ],
    objectivityBand: "B1",
    verifierStatus: "stub",
  },

  // #43 — Family I (measure). Digital capability verification + in-silico. touchstone LIVE.
  {
    id: "measure.io_test_pair",
    wire: "pcc.ev.measure.io_test_pair.v1",
    family: "measure",
    status: "active",
    proves:
      "The capability transforms declared inputs into expected outputs (run a test vector or verify a signed transcript).",
    paramsSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["deterministic", "seeded-stochastic", "statistical-tolerance"],
        },
      },
      required: ["mode"],
      additionalProperties: true,
    },
    authRequirement: "actor-signed",
    tierSupport: [
      { tier: 1 },
      { tier: 2, conditions: "oracle-executed or third-party-executed" },
    ],
    objectivityBand: "B1",
    verifierStatus: "stub",
  },

  // #6 — Family B (capture). The flagship physical primitive; 4 CSDs. v1 scopes CC0-2.
  {
    id: "capture.photo_nonced",
    wire: "pcc.ev.capture.photo_nonced.v1",
    family: "capture",
    status: "active",
    proves:
      "A live capture of the physical scene was taken for this job, at capture-time freshness, at the declared authenticity class (CC0-2 in v1).",
    paramsSchema: {
      type: "object",
      properties: {
        media: { type: "string", enum: ["photo", "video"] },
        minClass: {
          type: "string",
          enum: ["CC0", "CC1", "CC2", "CC3", "CC4", "CC5"],
        },
        nonceType: { type: "string", enum: ["qr", "color", "gesture"] },
      },
      required: ["media", "minClass"],
      additionalProperties: false,
    },
    authRequirement: "device-signed",
    tierSupport: [
      { tier: 1, conditions: "CC0-1" },
      { tier: 2, conditions: "CC2, or CC1 + independent GPS consistency (v1 scopes CC0-2)" },
    ],
    objectivityBand: "B2",
    verifierStatus: "stub",
    dependsOn: ["artifact.hash"],
  },

  // #7 — Family C (telemetry). Mobility categories. rules typed; gpsTrackCid in CSD.
  {
    id: "telemetry.gps_trail",
    wire: "pcc.ev.telemetry.gps_trail.v1",
    family: "telemetry",
    status: "active",
    proves:
      "An asset followed a route or remained in an area over a window, at a declared integrity grade.",
    paramsSchema: {
      type: "object",
      properties: {
        integrityGrade: {
          type: "string",
          enum: ["raw", "checked", "fused", "certified"],
        },
        maxGapSeconds: { type: "number" },
        plausibility: {
          type: "object",
          properties: { maxSpeedKph: { type: "number" } },
          additionalProperties: true,
        },
      },
      required: ["integrityGrade"],
      additionalProperties: false,
    },
    authRequirement: "platform",
    tierSupport: [
      { tier: 1, conditions: "raw" },
      { tier: 2, conditions: "checked/fused or device-signed" },
      { tier: 3, conditions: "certified + tamper log" },
    ],
    objectivityBand: "B2",
    verifierStatus: "stub",
  },

  // #20 — Family E (confirm). Brokerage/food verification model. data sources LIVE.
  {
    id: "confirm.target_system",
    wire: "pcc.ev.confirm.target_system.v1",
    family: "confirm",
    status: "active",
    proves:
      "The system the work touched confirms the expected post-state via its own channel (tracker shows delivered, PR merged, booking exists, DNS resolves).",
    paramsSchema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["api", "webhook", "zktls"] },
        matcher: { type: "string" },
      },
      required: ["channel"],
      additionalProperties: true,
    },
    authRequirement: "platform",
    tierSupport: [
      { tier: 1, conditions: "api (trusts the oracle's own fetch)" },
      { tier: 2, conditions: "authenticated webhook, or zktls" },
    ],
    objectivityBand: "B1",
    verifierStatus: "stub",
  },

  // ── v1.5-industrial cut — #52-#55 (Family L + Family C) ─────────────
  // Design: ai/research/pcc-evidence-vocab-sensor-machinelog.md §4/§6. These bind
  // ALREADY-BUILT machinery (drift-detector + LogCaptureService.verifyChain,
  // extracted to evidence/verifiers/). verifierStatus is "stub" for ALL FOUR: the
  // predicate machinery is live/extracted, but the ORACLE-side PrimitiveVerifier
  // binding is the settlement lane's work (§8), so each fails CLOSED under
  // requireImplementedVerifier until that binding ships (see oracle-binding.ts).
  // "stub" is what keeps the fail-closed invariant honest — marking them "live"
  // would let a CSD settle a machine log the oracle cannot yet authenticate.

  // #52 — Family L (record). THE core C.4/C.5 machine-log proof object; emit-side
  // + predicate LIVE (LogCaptureService.verifyChain). Core claim is B1 (chain
  // mechanics); coverage/cadence adds a B2 aspect.
  //
  // MODELING NOTE (deep-dive fix, task step 3): machine execution logs bind HERE
  // (#52), NOT to #38 doc.audit_trail. #38's ALCOA predicate is who-changed-what
  // with {actor, action, old/new value, reason}; a controller's execution trace
  // has no old/new values or reasons — routing machine logs through #38
  // mis-specifies the predicate and silently drops the chain/signature/
  // program-binding checks verifyLogChain already implements. #38 is a v1.5 doc
  // primitive (not in this cut); its EMITTERS must NOT claim C.4 machine logs.
  {
    id: "machine.execution_log",
    wire: "pcc.ev.machine.execution_log.v1",
    family: "record",
    status: "active",
    proves:
      "The machine's own execution record for this job — the command/event/alarm sequence the controller reported, captured contemporaneously by the kernel, hash-chained, kernel-signed, with program identity bound to the committed program/method hash.",
    paramsSchema: {
      type: "object",
      properties: {
        logKind: {
          type: "string",
          enum: ["job_log", "command_trace", "alarm_log", "program_transcript"],
        },
        disclosure: {
          type: "string",
          enum: ["full", "redacted-commit"],
          default: "redacted-commit",
        },
        minCadenceMs: { type: "number" },
        alarmPolicy: { type: "string", enum: ["none-critical", "declared"] },
      },
      required: ["logKind"],
      additionalProperties: true,
    },
    authRequirement: "actor-signed",
    tierSupport: [
      { tier: 1, conditions: "kernel-signed chain = attributable + integrity, no independence" },
      {
        tier: 2,
        conditions:
          "ONE OF: authenticated-session capture provenance; #53 cross-consistency; independent witness",
      },
      { tier: 3, conditions: "inside chains with TEE co-sign / committee re-run" },
    ],
    objectivityBand: "B1",
    verifierStatus: "stub",
    dependsOn: ["artifact.hash", "ident.registered_key"],
    upgrades: ["process.batch_record"],
  },

  // #53 — Family C (telemetry). The drift-detector's expected-profile checks as a
  // primitive (power envelope / temp band / duration ratio). Predicate LIVE
  // (detectDrifts, extracted). Distinct from #10 metric_window (SLA threshold);
  // this is match-to-expected-profile. D8-native (envelope is a pre-agreed param).
  {
    id: "telemetry.envelope_conformance",
    wire: "pcc.ev.telemetry.envelope_conformance.v1",
    family: "telemetry",
    status: "active",
    proves:
      "The job's physical signals stayed within the pre-agreed operating envelope — power within the capability's band, temperature within the material's band, duration within the expected ratio — i.e. a machine doing this class of work ran for this long on this material.",
    paramsSchema: {
      type: "object",
      properties: {
        envelope: {
          oneOf: [
            { type: "string", enum: ["builtin-defaults"] },
            {
              type: "array",
              items: {
                type: "object",
                properties: {
                  metric: { type: "string" },
                  min: { type: "number" },
                  max: { type: "number" },
                  ratioBands: { type: "array", items: { type: "number" } },
                },
                required: ["metric"],
              },
            },
          ],
        },
        source: { type: "string", enum: ["summary", "stream"], default: "summary" },
        severityFloor: { type: "string", enum: ["high", "critical"], default: "high" },
        materialParam: { type: "string" },
        includePipelineAnomalies: { type: "boolean" },
      },
      additionalProperties: true,
    },
    authRequirement: "inherited",
    tierSupport: [
      { tier: 1, conditions: "kernel-signed summaries" },
      {
        tier: 2,
        conditions:
          "device-signed readings, independent-collector cross-check, or mutual corroboration with #52",
      },
      { tier: 3, conditions: "+ tamper log or TEE" },
    ],
    objectivityBand: "B2",
    // BOUND: the oracle PrimitiveVerifier shipped (pcc-oracle feat/oracle-primitive-verifiers,
    // src/verifiers/envelope-conformance.ts — detectDrifts over the hash-verified bundle,
    // envelope from policyHash-pinned params). Flip merges only AFTER the oracle deploys.
    verifierStatus: "live",
    // No dependsOn: its input is Layer-1 sensor summary/stream events (+ #10 when
    // that v2 primitive lands), not a v1 vocabulary primitive.
    upgrades: ["machine.execution_log", "process.batch_record"],
  },

  // #54 — Family C (telemetry). checkSensorGaps promoted to a first-class NEGATIVE
  // gate (the anti-cherry-picking device; ALCOA +Complete already consumes it).
  // Gate, not grant — mirrors confirm.execution_mode's shape. Predicate LIVE.
  {
    id: "telemetry.coverage_gate",
    wire: "pcc.ev.telemetry.coverage_gate.v1",
    family: "telemetry",
    status: "active",
    proves:
      "The evidence stream is complete for the claimed tier — no missing required signal groups, no dead air on evidence-grade channels, no flatlined sensors. The anti-cherry-picking gate.",
    paramsSchema: {
      type: "object",
      properties: {
        requiredGroups: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
        },
        maxGapSeconds: { type: "number" },
        evidenceGradeChannels: { type: "boolean" },
      },
      additionalProperties: true,
    },
    authRequirement: "none",
    tierSupport: [
      { tier: 0, conditions: "missing/gapped coverage caps here (negative gate)" },
      { tier: 1 },
      { tier: 2 },
      { tier: 3 },
    ],
    objectivityBand: "B1",
    // BOUND: the oracle PrimitiveVerifier shipped (pcc-oracle feat/oracle-primitive-verifiers,
    // src/verifiers/coverage-gate.ts — checkSensorGaps negative gate over the hash-verified
    // bundle). Flip merges only AFTER the oracle deploys.
    verifierStatus: "live",
    gates: true,
  },

  // #55 — Family L (record). ISA-88 electronic-batch-record shape. Verifier is
  // mostly composition glue over existing rules (#52/#53/#54 + event-sequence).
  // Core is B1 (phase sequence + method-hash match); per-phase envelope adds B2.
  {
    id: "process.batch_record",
    wire: "pcc.ev.process.batch_record.v1",
    family: "record",
    status: "active",
    proves:
      "A batch/process run followed its pre-agreed recipe — phases executed in declared order, per-phase parameters in-range, all manifest samples processed with results attached. The ISA-88 electronic-batch-record shape.",
    paramsSchema: {
      type: "object",
      properties: {
        recipeRef: { type: "string" },
        phaseGraph: { type: "object", additionalProperties: true },
        sampleManifestRef: { type: "string" },
      },
      required: ["recipeRef"],
      additionalProperties: true,
    },
    authRequirement: "actor-signed",
    tierSupport: [
      { tier: 1 },
      {
        tier: 2,
        conditions: "with #52 instrument log + #35 calibration, or #38 hash-chained",
      },
      { tier: 3, conditions: "+ committee quorum re-run or signed acquisition" },
    ],
    objectivityBand: "B1",
    verifierStatus: "stub",
    dependsOn: ["artifact.hash"],
  },
];

// ── Version + manifest hash ─────────────────────────────────────────

/** Vocabulary version. Bumps when the contract (§5.1 fields) changes.
 *  v2 = the additive v1.5-industrial cut (#52-#55 + Family L `record`); no v1
 *  primitive changed, so the bump is purely additive. */
export const VOCAB_VERSION = 2 as const;

/**
 * Contract projection of a primitive def — the fields that constitute the
 * vocabulary CONTRACT and therefore feed VOCAB_MANIFEST_HASH. Excludes `proves`
 * (human prose) and `verifierStatus` (impl tracking). Arrays are sorted so the
 * hash depends on set content, not authoring order.
 */
function contractProjection(d: EvidencePrimitiveDef) {
  return {
    id: d.id,
    wire: d.wire,
    family: d.family,
    status: d.status,
    paramsSchema: d.paramsSchema,
    authRequirement: d.authRequirement,
    tierSupport: [...d.tierSupport].sort((a, b) => a.tier - b.tier),
    objectivityBand: d.objectivityBand,
    dependsOn: [...(d.dependsOn ?? [])].sort(),
    upgrades: [...(d.upgrades ?? [])].sort(),
    gates: d.gates ?? false,
  };
}

/**
 * Canonical manifest hash of the vocabulary: sha256 of the canonical JSON of the
 * sorted (by id) active defs' contract projections. Deterministic and
 * order-independent (defs are sorted internally). Same discipline as
 * computeVerificationProgramHash.
 */
export function computeVocabManifestHash(
  defs: readonly EvidencePrimitiveDef[],
): `0x${string}` {
  const active = defs
    .filter((d) => d.status === "active")
    .map(contractProjection)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const canonical = canonicalize(active);
  const hex = createHash("sha256").update(canonical).digest("hex");
  return `0x${hex}` as `0x${string}`;
}

/** The locked manifest hash of the shipped v1 vocabulary. */
export const VOCAB_MANIFEST_HASH: `0x${string}` =
  computeVocabManifestHash(EVIDENCE_PRIMITIVES);

// ── Lookup helpers ──────────────────────────────────────────────────

const PRIMITIVE_INDEX: ReadonlyMap<string, EvidencePrimitiveDef> = new Map(
  EVIDENCE_PRIMITIVES.map((d) => [d.id, d]),
);

/** Resolve a primitive def by id. Undefined for unknown ids. */
export function getPrimitive(id: string): EvidencePrimitiveDef | undefined {
  return PRIMITIVE_INDEX.get(id);
}

/** All primitives, optionally filtered by family. */
export function listPrimitives(
  family?: EvidenceFamily,
): readonly EvidencePrimitiveDef[] {
  return family
    ? EVIDENCE_PRIMITIVES.filter((d) => d.family === family)
    : EVIDENCE_PRIMITIVES;
}

/** Does this primitive contribute to the given tier? */
export function primitiveSupportsTier(
  def: EvidencePrimitiveDef,
  tier: 0 | 1 | 2 | 3,
): boolean {
  return def.tierSupport.some((t) => t.tier === tier);
}

/** The family that carries human-attestation primitives (the tier≥2 floor). */
export const HUMAN_ATTESTATION_FAMILY: EvidenceFamily = "attest";

/** True when the primitive is a human-attestation (Family-G) primitive. */
export function isHumanAttestation(def: EvidencePrimitiveDef): boolean {
  return def.family === HUMAN_ATTESTATION_FAMILY;
}
