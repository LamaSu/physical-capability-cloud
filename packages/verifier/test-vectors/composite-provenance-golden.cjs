#!/usr/bin/env node
/**
 * composite-provenance-golden.cjs
 * Evidence lane c25c8f97 — R5 carrier-scan PROVENANCE + print-leg SUCCESS conformance vector for
 * `document.print-and-mail`. The committed-program byte/behaviour target oracle's evaluator maps + hashes.
 *
 * v4 (2026-09-06): print-leg success fix (atlas #1670 / oracle #1673/#1905, corrected my #1914 via #1915).
 *   printer_job_verified is a LOG-CAPTURE SUMMARY (printer-log-adapter.ts stopRecording, emitted
 *   unconditionally, NO success field) — NOT a success signal. Bare event-present printer_job_verified
 *   released a REAL failed print. FIX (existing types, no new field): the committed print leg is
 *   and(event-present execution_completed, event-ABSENT execution_failed); printer_job_verified is
 *   re-scoped to tier-supporting log-chain evidence, OUT of the committed program.
 *   Oracle built the event-absent predicate (f8e43b9); this golden pins the committed shape + new hashes.
 *
 * v3 carried: R5 courier well-formedness as a GLOBAL settlement precondition (oracle option b, #1873);
 *   dual is-fabricated not-simulated (source.simulated OR payload.mock); post-adapter AuthenticatedEvent parity.
 *
 * Standalone (node:crypto). canonicalize/sha256/hashEvent verbatim from packages/spec/src/util/canonical.ts.
 * CONSEQUENCE: the print-leg change moves BOTH programHashes (independence 0xe1cac435 -> 0x9c.., honest-asym
 * 0x2acdff54 -> ..). ONE coordinated re-golden: evidence new program+hash -> composition/escrow re-pin the
 * production committedProgramHash/acceptedPolicyDigest -> oracle cross-confirms. (The acceptedPolicyDigest
 * GOLDEN uses a fixture committedProgramHash, so it is unaffected; the production binding is the wiring item.)
 */
"use strict";
const { createHash } = require("node:crypto");

function canonicalize(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.filter((k) => value[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
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

function pairWellFormed(p) { return VALID_PAIRS.some(([prov, ind]) => p.provenance === prov && p.independentCarrierScan === ind); }
function isCourier(e) { return typeof e.type === "string" && e.type.startsWith("courier_"); }
function wellFormednessPrecondition(events) { return events.filter(isCourier).every((e) => pairWellFormed(e.payload)); }
// dual fabrication tag, both in the signed payload (@pcc/spec is-fabricated.ts)
function isFabricated(e) { return (e.source && e.source.simulated === true) || (e.payload && e.payload.mock === true); }

const src = (deviceId) => ({ deviceId, deviceType: "printer_log", kernelId: KERNEL, simulated: false });
const mk = (type, payload, source) => { const e = { id: "evt-" + type, type, timestamp: "2026-08-27T12:00:00.000Z", source: source || src("printer:hp-0001"), payload }; e.hash = hashEvent(e); return e; };

// PRINT leg events — execution lifecycle is the SUCCESS signal (evidence.ts:29-32), NOT printer_job_verified.
const executionCompleted = mk("execution_completed", { jobId: JOB, documentHash: sha256Hex("doc::" + JOB), printerId: "hp-0001" });
const executionFailed = mk("execution_failed", { jobId: JOB, error: "printer_out_of_media", printerId: "hp-0001" });
// printer_job_verified = LOG-CAPTURE SUMMARY (supporting, tier>=1); NOT in the committed program. Present in
// a bundle it is IGNORED by the program — proving it is no longer the success signal.
const printerLogSummary = mk("printer_job_verified", { jobId: JOB, chainLength: 42, headHash: "0xhead", tailHash: "0xtail", summary: "Printer job completed with 42 hash-chained log entries" });

const mailEvent = (provenanceFields) => mk("courier_pickup_confirmed",
  { jobId: JOB, trackingCode, trackerId: "trk_pm0001", carrier: "USPS", occurredAt: "2026-08-27T13:30:00.000Z", ...provenanceFields },
  { deviceId: "easypost:" + trackingCode, deviceType: "courier_api", kernelId: KERNEL, simulated: false });
const V = {
  independent:  mailEvent({ provenance: "independent_carrier_scan", independentCarrierScan: true }),
  self_report:  mailEvent({ provenance: "operator_self_report",     independentCarrierScan: false }),
  contra_selfTrue: mailEvent({ provenance: "operator_self_report",  independentCarrierScan: true }),
  absent: mailEvent({}),
};

// ---- committed programs (v4): print leg = event-present execution_completed AND event-absent execution_failed
const printLeg = [{ id: "print-ok", predicate: "event-present", eventType: "execution_completed" },
                  { id: "print-not-failed", predicate: "event-absent", eventType: "execution_failed" }];
const independenceProgram = { version: 1, schemaHash: "verification-program/v1", stages: [
  ...printLeg,
  { id: "mail", predicate: "event-present-independent", eventType: "courier_pickup_confirmed", allowedProvenance: ALLOWED_INDEPENDENT },
  { id: "auth", predicate: "not-simulated" } ] };
const honestAsymmetryProgram = { version: 1, schemaHash: "verification-program/v1", stages: [
  ...printLeg,
  { id: "mail", predicate: "event-present", eventType: "courier_pickup_confirmed" },
  { id: "auth", predicate: "not-simulated" } ] };
const v1PrintLegProgram = { version: 1, schemaHash: "verification-program/v1", stages: [
  { id: "print", predicate: "event-present", eventType: "printer_job_verified" }, // the OLD bare log-summary leg
  { id: "mail", predicate: "event-present", eventType: "courier_pickup_confirmed" }, { id: "auth", predicate: "not-simulated" } ] };

// ---- evaluator (well-formedness precondition + committed stages) ----------------------------------
function stagePass(stage, events) {
  switch (stage.predicate) {
    case "event-present": return events.some((e) => e.type === stage.eventType);
    case "event-absent": return !events.some((e) => e.type === stage.eventType); // sound: set is kernel-signed, cannot strip
    case "not-simulated": return !events.some(isFabricated);
    case "event-present-independent": return events.some((e) => e.type === stage.eventType && pairWellFormed(e.payload)
      && stage.allowedProvenance.includes(e.payload.provenance) && e.payload.independentCarrierScan === true);
    default: return false;
  }
}
const evaluate = (events, program) => (wellFormednessPrecondition(events) && program.stages.every((s) => stagePass(s, events))) ? "release-eligible" : "dispute";

// ---- post-adapter (oracle AuthenticatedEvent {eventRef,payload,fabricated}) -----------------------
const adapt = (e) => ({ eventRef: e.type, payload: e.payload, fabricated: isFabricated(e) });
function stagePassAdapted(stage, aes) {
  switch (stage.predicate) {
    case "event-present": return aes.some((e) => e.eventRef === stage.eventType);
    case "event-absent": return !aes.some((e) => e.eventRef === stage.eventType);
    case "not-simulated": return !aes.some((e) => e.fabricated === true);
    case "event-present-independent": return aes.some((e) => e.eventRef === stage.eventType && pairWellFormed(e.payload)
      && stage.allowedProvenance.includes(e.payload.provenance) && e.payload.independentCarrierScan === true);
    default: return false;
  }
}
const evalAdapted = (aes, program) => (aes.filter((e) => typeof e.eventRef === "string" && e.eventRef.startsWith("courier_")).every((e) => pairWellFormed(e.payload)) && program.stages.every((s) => stagePassAdapted(s, aes))) ? "release-eligible" : "dispute";

// ---- assert + emit -------------------------------------------------------------------------------
let failures = 0, n = 0;
const check = (name, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) failures++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); };
console.log("== R5 + print-leg-success golden v4 (evidence c25c8f97) ==");

console.log("PRINT LEG (execution_completed present AND execution_failed absent):");
check("success (execution_completed, independent scan) -> release", evaluate([executionCompleted, V.independent], independenceProgram), "release-eligible");
check("FAILED print (execution_failed present) -> dispute", evaluate([executionCompleted, executionFailed, V.independent], independenceProgram), "dispute");
check("no execution_completed -> dispute (print-ok leg fails)", evaluate([executionFailed, V.independent], independenceProgram), "dispute");
check("printer_job_verified present but NO execution_completed -> dispute (log summary is NOT the success signal)", evaluate([printerLogSummary, V.independent], independenceProgram), "dispute");
check("success + supporting printer_job_verified -> release (log summary is ignored by the program)", evaluate([executionCompleted, printerLogSummary, V.independent], independenceProgram), "release-eligible");

console.log("REGRESSION — the OLD bare printer_job_verified print leg released a failed print:");
check("v1 program: printer_job_verified + failed print + independent scan -> release (THE BUG)", evaluate([printerLogSummary, executionFailed, V.independent], v1PrintLegProgram), "release-eligible");
check("v4 program: same bundle -> dispute (execution_failed present, no execution_completed)", evaluate([printerLogSummary, executionFailed, V.independent], independenceProgram), "dispute");

console.log("R5 courier provenance (unchanged, now over the execution_completed print leg):");
check("self_report @ independence -> dispute", evaluate([executionCompleted, V.self_report], independenceProgram), "dispute");
check("self_report @ honest-asym -> release", evaluate([executionCompleted, V.self_report], honestAsymmetryProgram), "release-eligible");
check("contradiction self+true @ honest-asym -> dispute", evaluate([executionCompleted, V.contra_selfTrue], honestAsymmetryProgram), "dispute");
check("mixed independent+contradiction @ independence -> dispute", evaluate([executionCompleted, V.independent, V.contra_selfTrue], independenceProgram), "dispute");

console.log("NOT-SIMULATED (dual fabrication tag) + POST-ADAPTER PARITY:");
const simExec = (() => { const e = mk("execution_completed", executionCompleted.payload); e.source = { ...e.source, simulated: true }; e.hash = hashEvent(e); return e; })();
check("source.simulated execution_completed -> dispute", evaluate([simExec, V.independent], independenceProgram), "dispute");
const par = (events, program, label) => check(`parity ${label}`, evalAdapted(events.map(adapt), program), evaluate(events, program));
par([executionCompleted, V.independent], independenceProgram, "success@indep");
par([executionCompleted, executionFailed, V.independent], independenceProgram, "failed@indep (event-absent survives adapter)");
par([simExec, V.independent], independenceProgram, "simulated@indep (fabricated flag carried)");

console.log("COMMITTED PROGRAM HASHES (v4) — NEW values, supersede 0xe1cac435 / 0x2acdff54:");
const phI = programHash(independenceProgram), phH = programHash(honestAsymmetryProgram);
console.log("  independence  =", phI);
console.log("    canonical   =", canonicalize(independenceProgram));
console.log("  honest-asym   =", phH);
console.log("    canonical   =", canonicalize(honestAsymmetryProgram));
check("the two tiers remain distinct programs", phI !== phH, true);
check("both differ from the v3 (printer_job_verified) hashes", phI !== "0xe1cac43536cae93c76510c76fa99ca234ad0113e4464a1bd0cd4c9f7d16ff100" && phH !== "0x2acdff542bc554770bb333b2683f053f3334617f84798efd05ecce2c1e2df545", true);

console.log(failures === 0 ? `\nALL GREEN (${n}/${n})` : `\n${failures} FAILURE(S) of ${n}`);
process.exit(failures === 0 ? 0 : 1);
