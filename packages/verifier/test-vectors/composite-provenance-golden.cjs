#!/usr/bin/env node
/**
 * composite-provenance-golden.cjs
 * Evidence lane c25c8f97 — R5 carrier-scan PROVENANCE conformance vector for `document.print-and-mail`.
 *
 * v3 (2026-09-06). Folds the GPT-6 Astra cross-family review (CHANGES-REQUESTED) AND oracle's #1873 mechanism
 * decision. History:
 *  - v1 was unsound (Astra): the committed false-tier program was plain event-present, so a validly-signed
 *    {operator_self_report, independentCarrierScan:true} RELEASED; "contradiction=>dispute" lived only in a
 *    helper the evaluator never runs; @pcc/spec has no provenance refinement (the evidence-plane invariant was
 *    vapor). My #1868 "evidence-plane" answer was wrong; retracted #1870.
 *  - v2 fixed it with a COMMITTED well-formedness STAGE (moved the program hashes).
 *  - v3 (THIS) adopts oracle #1873's decision: enforce well-formedness as a MANDATORY GLOBAL SETTLEMENT-BOUNDARY
 *    PRECONDITION the evaluator ALWAYS runs, NOT a per-program stage. Rationale (evidence concurs, #1874): the
 *    valid-provenance set is a GLOBAL property of courier_* events (an evidence CHANNEL, not capability-specific;
 *    a future channel is a global contract-versioned addition), the TIER stays per-program via
 *    event-present-independent, and a precondition is UN-OMITTABLE (astra's own root cause = the sol #316
 *    omission class; a committed stage is omittable at authoring, a precondition is not). Consequence: the
 *    programHashes REVERT to oracle's already-cross-confirmed values (no re-pin): independence 0xe1cac435..,
 *    honest-asym 0x2acdff54.. . Oracle owns building the precondition; this golden is its conformance target.
 *
 * Standalone (node:crypto only). canonicalize/sha256/hashEvent verbatim from packages/spec/src/util/canonical.ts.
 * Cross-lane findings routed on coord #1872 (tier-downgrade pinning; independence<-authenticated HMAC fact;
 * delivery-vs-pickup + replay/freshness) — owned by escrow/composition/carrier/oracle, not this golden.
 */
"use strict";
const { createHash } = require("node:crypto");

// ---- @pcc/spec canonical.ts (verbatim) ----------------------------------------------------------
function canonicalize(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const pairs = keys.filter((k) => value[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonicalize(value[k]));
    return "{" + pairs.join(",") + "}";
  }
  return String(value);
}
const sha256Prefixed = (s) => "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");
const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const hashEvent = (e) => sha256Prefixed(canonicalize({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload }));
const programHash = (p) => "0x" + createHash("sha256").update(canonicalize(p), "utf8").digest("hex");

const JOB = "job-pm-0001", KERNEL = "kernel-pm-0001", trackingCode = "9400111899223817200001";
const COURIER_TYPES = ["courier_pickup_confirmed", "courier_delivery_confirmed"];
const ALLOWED_INDEPENDENT = ["independent_carrier_scan"];
const VALID_PAIRS = [["independent_carrier_scan", true], ["operator_self_report", false]];
// Oracle #1867 cross-confirmed program hashes (unchanged under (b) — well-formedness is a precondition, not a stage).
const PIN_INDEPENDENCE = "0xe1cac43536cae93c76510c76fa99ca234ad0113e4464a1bd0cd4c9f7d16ff100";
const PIN_HONEST_ASYM = "0x2acdff542bc554770bb333b2683f053f3334617f84798efd05ecce2c1e2df545";

// ---- GLOBAL WELL-FORMEDNESS PRECONDITION (oracle #1873 option b): the settlement boundary ALWAYS runs this,
//      independent of the program. A courier_* event MUST be EXACTLY one of the two valid {enum,boolean} pairs;
//      strict === on both fields. Invalid enum / missing / non-strict-boolean / absent / astra's
//      {operator_self_report,true} ALL fail -> dispute. UNIVERSAL over courier events (mixed independent +
//      contradiction bundle => dispute; an existential good-witness does not rescue a contradiction elsewhere).
function pairWellFormed(p) { return VALID_PAIRS.some(([prov, ind]) => p.provenance === prov && p.independentCarrierScan === ind); }
function wellFormednessPrecondition(events) {
  return events.filter((e) => COURIER_TYPES.includes(e.type)).every((e) => pairWellFormed(e.payload));
}

// ---- carrier mail event; only the provenance fields vary across cases -----------------------------
const baseMailPayload = {
  jobId: JOB, trackingCode, trackerId: "trk_pm0001", shipmentId: "shp_pm0001", carrier: "USPS",
  trackerStatus: "in_transit", statusDetail: "accepted", carrierMessage: "Accepted at USPS Origin Facility",
  trackingLocation: { city: "San Francisco", state: "CA", country: "US", zip: "94103" },
  providerEventId: "evt_ezp_pm0001", occurredAt: "2026-08-27T13:30:00.000Z", provider: "easypost",
  providerMode: "production", providerSignatureHeader: "hmac-sha256=pm0001",
  providerRawBodyB64: Buffer.from('{"result":{"tracking_code":"' + trackingCode + '","status":"in_transit"}}', "utf8").toString("base64"),
  commitment: { hash: sha256Hex("commitment::" + JOB), jobId: JOB, trackingCode }, commitmentHashValid: true, commitmentSignatureVerified: true,
};
const mailEvent = (provenanceFields) => {
  const e = { id: "evt-mail", type: "courier_pickup_confirmed", timestamp: "2026-08-27T13:30:00.000Z",
    source: { deviceId: "easypost:" + trackingCode, deviceType: "courier_api", kernelId: KERNEL, simulated: false },
    payload: { ...baseMailPayload, ...provenanceFields } };
  e.hash = hashEvent(e);
  return e;
};
const printEvent = (() => {
  const e = { id: "evt-print", type: "printer_job_verified", timestamp: "2026-08-27T12:00:00.000Z",
    source: { deviceId: "printer:hp-0001", deviceType: "printer_log", kernelId: KERNEL, simulated: false },
    payload: { jobId: JOB, documentHash: sha256Hex("doc::" + JOB), pages: 2, printerId: "hp-0001" } };
  e.hash = hashEvent(e);
  return e;
})();
const V = {
  independent:  mailEvent({ provenance: "independent_carrier_scan", independentCarrierScan: true }),
  self_report:  mailEvent({ provenance: "operator_self_report",     independentCarrierScan: false }),
  contra_selfTrue:  mailEvent({ provenance: "operator_self_report",     independentCarrierScan: true }),  // Astra's counterexample
  contra_indFalse:  mailEvent({ provenance: "independent_carrier_scan", independentCarrierScan: false }),
  bareTrue:     mailEvent({ independentCarrierScan: true }),
  absent:       mailEvent({}),
  unknownEnum:  mailEvent({ provenance: "unknown",                  independentCarrierScan: false }),
  stringBool:   mailEvent({ provenance: "operator_self_report",     independentCarrierScan: "true" }),
  missingBool:  mailEvent({ provenance: "operator_self_report" }),
};

// ---- committed programs (NO well-formed stage — hashes REVERT to oracle's pinned values) ----------
const independenceProgram = { version: 1, schemaHash: "verification-program/v1", stages: [
  { id: "print", predicate: "event-present", eventType: "printer_job_verified" },
  { id: "mail", predicate: "event-present-independent", eventType: "courier_pickup_confirmed", allowedProvenance: ALLOWED_INDEPENDENT },
  { id: "auth", predicate: "not-simulated" },
] };
const honestAsymmetryProgram = { version: 1, schemaHash: "verification-program/v1", stages: [
  { id: "print", predicate: "event-present", eventType: "printer_job_verified" },
  { id: "mail", predicate: "event-present", eventType: "courier_pickup_confirmed" },
  { id: "auth", predicate: "not-simulated" },
] };

// ---- the EVALUATOR: MANDATORY precondition, THEN the committed program stages (AND-composed) ------
function stagePass(stage, events) {
  switch (stage.predicate) {
    case "event-present": return events.some((e) => e.type === stage.eventType);
    case "not-simulated": return !events.some((e) => e.source && e.source.simulated === true);
    case "event-present-independent":
      return events.some((e) => e.type === stage.eventType && pairWellFormed(e.payload)
        && stage.allowedProvenance.includes(e.payload.provenance) && e.payload.independentCarrierScan === true);
    default: return false; // unknown predicate = fail closed
  }
}
// (b): the precondition is NOT a program stage — the settlement boundary runs it unconditionally first.
const evaluate = (events, program) =>
  (wellFormednessPrecondition(events) && program.stages.every((s) => stagePass(s, events))) ? "release-eligible" : "dispute";
// v1 settlement path WITHOUT the precondition — kept ONLY to demonstrate the bug Astra found.
const evaluateNoPrecondition = (events, program) => program.stages.every((s) => stagePass(s, events)) ? "release-eligible" : "dispute";

// ---- assert + emit -------------------------------------------------------------------------------
let failures = 0, n = 0;
const check = (name, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) failures++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); };

console.log("== R5 carrier-scan provenance golden v3 (evidence c25c8f97; folds Astra + oracle #1873 option b) ==");

console.log("BINDING (provenance in the hashed preimage => distinct hashes => tamper-evident):");
check("five provenance variants hash distinctly", new Set(["independent","self_report","contra_selfTrue","contra_indFalse","absent"].map((k)=>V[k].hash)).size, 5);

console.log("INDEPENDENCE tier (precondition + committed program 0xe1cac435..):");
check("independent -> release-eligible", evaluate([printEvent, V.independent], independenceProgram), "release-eligible");
check("self_report -> dispute", evaluate([printEvent, V.self_report], independenceProgram), "dispute");
check("contradiction self+true -> dispute", evaluate([printEvent, V.contra_selfTrue], independenceProgram), "dispute");
check("MIXED bundle (independent + contradiction) -> dispute (universal precondition)", evaluate([printEvent, V.independent, V.contra_selfTrue], independenceProgram), "dispute");

console.log("HONEST-ASYMMETRY tier (precondition + committed program 0x2acdff54..):");
check("self_report -> release-eligible", evaluate([printEvent, V.self_report], honestAsymmetryProgram), "release-eligible");
check("independent -> release-eligible", evaluate([printEvent, V.independent], honestAsymmetryProgram), "release-eligible");
check("contradiction self+true -> dispute (THE FIX)", evaluate([printEvent, V.contra_selfTrue], honestAsymmetryProgram), "dispute");
for (const k of ["contra_indFalse", "bareTrue", "absent", "unknownEnum", "stringBool", "missingBool"])
  check(`malformed ${k} -> dispute`, evaluate([printEvent, V[k]], honestAsymmetryProgram), "dispute");

console.log("REGRESSION DEMO — without the precondition (the v1 settlement path) the contradiction RELEASED:");
check("no-precondition: contradiction self+true -> release-eligible (the BUG Astra found)", evaluateNoPrecondition([printEvent, V.contra_selfTrue], honestAsymmetryProgram), "release-eligible");
check("with-precondition: same event -> dispute (fixed, un-omittably)", evaluate([printEvent, V.contra_selfTrue], honestAsymmetryProgram), "dispute");

console.log("COMMITTED PROGRAM HASHES — REVERT to oracle's #1867 cross-confirmed values (no re-pin under b):");
const phI = programHash(independenceProgram), phH = programHash(honestAsymmetryProgram);
console.log("  independence =", phI);
console.log("  honest-asym  =", phH);
check("independence programHash == oracle pin 0xe1cac435", phI, PIN_INDEPENDENCE);
check("honest-asymmetry programHash == oracle pin 0x2acdff54", phH, PIN_HONEST_ASYM);

console.log(failures === 0 ? `\nALL GREEN (${n}/${n})` : `\n${failures} FAILURE(S) of ${n}`);
process.exit(failures === 0 ? 0 : 1);
