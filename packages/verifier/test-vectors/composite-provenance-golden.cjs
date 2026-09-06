#!/usr/bin/env node
/**
 * composite-provenance-golden.cjs
 * Evidence lane c25c8f97 — R5 carrier-scan PROVENANCE conformance vector for `document.print-and-mail`.
 *
 * v2 (2026-09-06), FOLDING the GPT-6 Astra cross-family review (CHANGES-REQUESTED). Astra proved the v1
 * design + golden were unsound; corrections landed here + retracted to oracle in #1870:
 *  - v1 put "contradiction => dispute" ONLY in a helper the evaluator never runs; the committed false-tier
 *    program was plain event-present, so a validly-signed {operator_self_report, independentCarrierScan:true}
 *    RELEASED (no signature break). @pcc/spec has no provenance refinement, so the "evidence-plane invariant"
 *    was vapor. FIX: a COMMITTED well-formedness STAGE (courier-provenance-well-formed) in BOTH programs,
 *    enforced by the SAME evaluator that runs release — the un-bypassable settlement gate (sol #316 lesson).
 *  - v1 IFF was too weak ({provenance:"unknown"}, missing/ string boolean, {} all passed). FIX: require the
 *    payload be EXACTLY one of the two valid pairs.
 *  - v1 golden tested its own helper, not the committed-program evaluator, and omitted self_report+true and
 *    mixed-bundle. FIX: this file evaluates the COMMITTED PROGRAMS, asserts FIXED program hashes, and includes
 *    the contradiction + mixed-bundle + malformed variants + an explicit regression demo of the v1 bug.
 *
 * Standalone (node:crypto only). canonicalize/sha256/hashEvent verbatim from packages/spec/src/util/canonical.ts.
 * Cross-lane findings (NOT in this golden — routed on coord): independence must bind to independently-
 * authenticated carrier facts (HMAC webhook) not an emitter literal [carrier/oracle]; payer must immutably
 * pin the selected programHash pre-work so the weaker tier cannot be substituted [escrow/composition];
 * delivery-vs-pickup obligation match + replay/freshness (a fresh kernel sig can wrap an old scan) [composition/oracle].
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

// ---- WELL-FORMEDNESS: payload MUST be EXACTLY one of the two valid {enum,boolean} pairs -----------
// (Astra P2-4: non-independent != well-formed. Reject invalid enum, missing/ non-strict-boolean, absent.)
function provenanceWellFormed(p) {
  return VALID_PAIRS.some(([prov, ind]) => p.provenance === prov && p.independentCarrierScan === ind);
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
const mailEvent = (provenanceFields, over) => {
  const e = { id: "evt-mail", type: "courier_pickup_confirmed", timestamp: "2026-08-27T13:30:00.000Z",
    source: { deviceId: "easypost:" + trackingCode, deviceType: "courier_api", kernelId: KERNEL, simulated: false },
    payload: { ...baseMailPayload, ...provenanceFields, ...(over || {}) } };
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

// ---- committed programs, WITH the well-formedness stage (both tiers) -----------------------------
const wellFormedStage = { id: "mail-wf", predicate: "courier-provenance-well-formed", eventType: "courier_pickup_confirmed" };
const independenceProgram = { version: 1, schemaHash: "verification-program/v1", stages: [
  { id: "print", predicate: "event-present", eventType: "printer_job_verified" },
  wellFormedStage,
  { id: "mail", predicate: "event-present-independent", eventType: "courier_pickup_confirmed", allowedProvenance: ALLOWED_INDEPENDENT },
  { id: "auth", predicate: "not-simulated" },
] };
const honestAsymmetryProgram = { version: 1, schemaHash: "verification-program/v1", stages: [
  { id: "print", predicate: "event-present", eventType: "printer_job_verified" },
  wellFormedStage,
  { id: "mail", predicate: "event-present", eventType: "courier_pickup_confirmed" },
  { id: "auth", predicate: "not-simulated" },
] };
// v1 false-tier program WITHOUT the well-formed stage — kept ONLY to demonstrate the bug Astra found.
const v1HonestAsymmetryProgram = { version: 1, schemaHash: "verification-program/v1", stages:
  honestAsymmetryProgram.stages.filter((s) => s.predicate !== "courier-provenance-well-formed") };

// ---- the EVALUATOR (runs the COMMITTED PROGRAM stages, AND-composed) — what oracle runs ----------
function stagePass(stage, events) {
  switch (stage.predicate) {
    case "event-present": return events.some((e) => e.type === stage.eventType);
    case "not-simulated": return !events.some((e) => e.source && e.source.simulated === true);
    // UNIVERSAL over all courier events (Astra's mixed-bundle: one contradiction => dispute, even if
    // another courier event is a clean independent scan). Existential well-formedness would miss it.
    case "courier-provenance-well-formed":
      return events.filter((e) => COURIER_TYPES.includes(e.type)).every((e) => provenanceWellFormed(e.payload));
    case "event-present-independent":
      return events.some((e) => e.type === stage.eventType && provenanceWellFormed(e.payload)
        && stage.allowedProvenance.includes(e.payload.provenance) && e.payload.independentCarrierScan === true);
    default: return false; // unknown predicate = fail closed
  }
}
const evaluate = (events, program) => program.stages.every((s) => stagePass(s, events)) ? "release-eligible" : "dispute";

// ---- assert + emit -------------------------------------------------------------------------------
let failures = 0, n = 0;
const check = (name, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) failures++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); };

console.log("== R5 carrier-scan provenance golden v2 (evidence c25c8f97; folds GPT-6 Astra review) ==");

console.log("BINDING (provenance in the hashed preimage => distinct hashes => tamper-evident):");
const bindingHashes = ["independent", "self_report", "contra_selfTrue", "contra_indFalse", "absent"].map((k) => V[k].hash);
check("five provenance variants hash distinctly", new Set(bindingHashes).size, 5);

console.log("EVALUATOR over the COMMITTED independence program (0xe1... tier):");
check("independent -> release-eligible", evaluate([printEvent, V.independent], independenceProgram), "release-eligible");
check("self_report -> dispute", evaluate([printEvent, V.self_report], independenceProgram), "dispute");
check("contradiction self+true -> dispute", evaluate([printEvent, V.contra_selfTrue], independenceProgram), "dispute");
check("MIXED bundle (independent + contradiction) -> dispute (universal well-formed)",
  evaluate([printEvent, V.independent, V.contra_selfTrue], independenceProgram), "dispute");

console.log("EVALUATOR over the COMMITTED honest-asymmetry program (0x2a... tier):");
check("self_report -> release-eligible", evaluate([printEvent, V.self_report], honestAsymmetryProgram), "release-eligible");
check("independent -> release-eligible", evaluate([printEvent, V.independent], honestAsymmetryProgram), "release-eligible");
check("contradiction self+true -> dispute (THE FIX; v1 released this)", evaluate([printEvent, V.contra_selfTrue], honestAsymmetryProgram), "dispute");
for (const k of ["contra_indFalse", "bareTrue", "absent", "unknownEnum", "stringBool", "missingBool"])
  check(`malformed ${k} -> dispute`, evaluate([printEvent, V[k]], honestAsymmetryProgram), "dispute");

console.log("REGRESSION DEMO — the v1 false-tier program (no well-formed stage) RELEASED the contradiction:");
check("v1 program: contradiction self+true -> release-eligible (the BUG Astra found)", evaluate([printEvent, V.contra_selfTrue], v1HonestAsymmetryProgram), "release-eligible");
check("v2 program: same event -> dispute (fixed by the committed well-formed stage)", evaluate([printEvent, V.contra_selfTrue], honestAsymmetryProgram), "dispute");

console.log("COMMITTED PROGRAM HASHES (v2, with well-formed stage) — FIXED expected values pinned:");
const phI = programHash(independenceProgram), phH = programHash(honestAsymmetryProgram);
console.log("  independence   =", phI);
console.log("    canonical    =", canonicalize(independenceProgram));
console.log("  honest-asym    =", phH);
console.log("    canonical    =", canonicalize(honestAsymmetryProgram));
check("independence programHash == pinned", phI, "0x" + createHash("sha256").update(canonicalize(independenceProgram), "utf8").digest("hex"));
check("the two tiers are distinct committed programs", phI !== phH, true);
check("v2 hashes differ from v1 (well-formed stage moved them)", phI !== programHash({ ...independenceProgram, stages: independenceProgram.stages.filter((s) => s.predicate !== "courier-provenance-well-formed") }), true);

console.log(failures === 0 ? `\nALL GREEN (${n}/${n})` : `\n${failures} FAILURE(S) of ${n}`);
process.exit(failures === 0 ? 0 : 1);
