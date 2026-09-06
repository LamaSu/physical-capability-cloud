#!/usr/bin/env node
/**
 * composite-provenance-golden.cjs
 * Evidence lane c25c8f97 — R5 carrier-scan PROVENANCE conformance vector for `document.print-and-mail`.
 *
 * Closes the R5 escalation from sol's #316 review (carrier #1578/#1817, evidence claim #1591/#1830):
 * an event-present mail leg must not `release` on an OPERATOR SELF-REPORT (Lob) as if it were an
 * INDEPENDENT third-party carrier scan (EasyPost). Spec = §7 v1.1 addendum of
 * ~/.claude/shared/vnext-composite-evidence-print-and-mail-v1.md.
 *
 * Byte contract read from source (NOT the review prose):
 *   - carrier.ts @ #323 (fix/carrier-evidence-provenance 18d97b52) payload gains fixed literals
 *     provenance:"independent_carrier_scan", independentCarrierScan:true INSIDE hashEvent's payload.
 *   - lob.ts   @ master 73877834 payload carries provenance:"operator_self_report", independentCarrierScan:false.
 *   - oracle predicate (verification-program-eval.ts 18ba514, #1604): PASSES iff >=1 AUTHENTICATED event has
 *     payload.provenance in the committed allowedProvenance set AND payload.independentCarrierScan STRICT true.
 *   - sol axis: provenance describes the CHANNEL; simulated describes the ENVIRONMENT. Independence NEVER
 *     implies authenticity — this predicate composes via AND with not-simulated + verifyEvidenceBundle.
 *
 * What this vector proves (each merge-INDEPENDENT except the noted hash byte-targets):
 *   1. BINDING: provenance/independentCarrierScan are inside canonicalize({type,timestamp,source,payload}),
 *      so the five variants yield five DISTINCT mailEvent.hash — a stripped/swapped provenance breaks the
 *      kernelSignedEventsRoot and thus the kernel signature. Provenance cannot be forged post-signature.
 *   2. VERDICT: the R5 rule (§7.2/§7.3) matches oracle's KAT for every {provenance × requiresIndependentCarrierScan}.
 *   3. PROGRAM: the committed program hash for the independence-tier composite (PROPOSED stage encoding; oracle
 *      confirms the field names for the byte-exact value, same as the mailEvent.hash re-bind on #323 merge).
 *
 * Standalone (node:crypto only). canonicalize + sha256 are VERBATIM from the Spark-verified
 * composite-print-mail-bundle-golden-mirror.cjs (byte-identical to packages/spec/src/util/canonical.ts).
 */
"use strict";
const { createHash } = require("node:crypto");

// ---- @pcc/spec canonical.ts (verbatim, Spark-verified byte-identical) ----------------------------
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
// computeVerificationProgramHash(p) = "0x"+hex(SHA256(canonicalize(p)))  — verification-program.ts (#1523)
const programHash = (p) => "0x" + createHash("sha256").update(canonicalize(p), "utf8").digest("hex");

const JOB = "job-pm-0001", KERNEL = "kernel-pm-0001", trackingCode = "9400111899223817200001";
const ALLOWED_INDEPENDENT = ["independent_carrier_scan"]; // oracle #1604 committed allowedProvenance set

// ---- a representative carrier mail event; only the two provenance fields vary across cases -------
// (Full #323 payload shape carried so the hash is the real byte-target; commitment kept minimal — the
//  provenance AXIS is what varies. The full-bundle mailEvent.hash re-binds in the composite-bundle golden
//  on the #323 MERGE SHA per carrier #1595; oracle's key-based predicate needs no re-bind.)
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
  const payload = { ...baseMailPayload, ...provenanceFields };
  const e = { id: "evt-mail", type: "courier_pickup_confirmed", timestamp: "2026-08-27T13:30:00.000Z",
    source: { deviceId: "easypost:" + trackingCode, deviceType: "courier_api", kernelId: KERNEL, simulated: false }, payload };
  e.hash = hashEvent(e);
  return e;
};

// the five provenance variants (undefined fields are OMITTED by canonicalize = the "absent" case)
const V = {
  independent:  mailEvent({ provenance: "independent_carrier_scan", independentCarrierScan: true }),   // EasyPost (#323)
  self_report:  mailEvent({ provenance: "operator_self_report",     independentCarrierScan: false }),  // Lob (#321)
  contra_boolFalse: mailEvent({ provenance: "independent_carrier_scan", independentCarrierScan: false }), // claims channel, boolean disagrees
  contra_bareTrue:  mailEvent({ independentCarrierScan: true }),                                        // bare true, no provenance
  absent:       mailEvent({}),                                                                          // neither field
};

// ---- R5 verdict (§7.1 consistency + §7.2/§7.3), the RULE oracle's predicate must match -----------
function provenanceConsistent(p) {                                   // §7.1: independentCarrierScan===true IFF provenance==='independent_carrier_scan'
  const declaredIndependent = p.provenance === "independent_carrier_scan";
  return (p.independentCarrierScan === true) === declaredIndependent; // absent+absent => false===false => consistent (non-independent)
}
function mailLeg(event, requiresIndependentCarrierScan) {
  const p = event.payload;
  if (event.source.simulated !== false) return "dispute";           // sol axis: still require not-simulated (+ authenticity upstream)
  if (!provenanceConsistent(p)) return "dispute";                   // contradiction => dispute at EVERY tier (forgery signal)
  const independent = p.provenance === "independent_carrier_scan" && p.independentCarrierScan === true
    && ALLOWED_INDEPENDENT.includes(p.provenance);
  if (requiresIndependentCarrierScan) return independent ? "release-eligible" : "dispute";
  return "release-eligible";                                        // honest-asymmetry tier: satisfied, mailProvenance recorded on the verdict
}

// ---- committed program (oracle #1604 shape) — PROPOSED encoding; oracle confirms field names -----
const independenceProgram = {
  version: 1, schemaHash: "verification-program/v1",
  stages: [
    { id: "print", predicate: "event-present", eventType: "printer_job_verified" },
    { id: "mail",  predicate: "event-present-independent", eventType: "courier_pickup_confirmed", allowedProvenance: ALLOWED_INDEPENDENT },
    { id: "auth",  predicate: "not-simulated" },
  ],
};

// ---- assert + emit -------------------------------------------------------------------------------
let failures = 0, n = 0;
const check = (name, got, want) => { n++; const ok = got === want; if (!ok) failures++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); };

console.log("== R5 carrier-scan provenance golden (evidence c25c8f97) ==");
console.log("BINDING (provenance is in the hashed preimage => distinct hashes => tamper-evident):");
const hashes = Object.fromEntries(Object.entries(V).map(([k, e]) => [k, e.hash]));
for (const [k, h] of Object.entries(hashes)) console.log(`  mailEvent.hash[${k}] = ${h}`);
const distinct = new Set(Object.values(hashes));
check("all five provenance variants hash distinctly", distinct.size, 5);
check("independent != self_report", hashes.independent !== hashes.self_report, true);

console.log("VERDICT @ requiresIndependentCarrierScan=TRUE (independence-claiming tier):");
check("independent -> release-eligible", mailLeg(V.independent, true), "release-eligible");
check("self_report -> dispute (oracle KAT)", mailLeg(V.self_report, true), "dispute");
check("contradiction bool-false -> dispute (oracle KAT)", mailLeg(V.contra_boolFalse, true), "dispute");
check("contradiction bare-true -> dispute", mailLeg(V.contra_bareTrue, true), "dispute");
check("absent -> dispute (independence must be asserted, never assumed)", mailLeg(V.absent, true), "dispute");

console.log("VERDICT @ requiresIndependentCarrierScan=FALSE (honest-asymmetry tier):");
check("self_report -> release-eligible (record mailProvenance)", mailLeg(V.self_report, false), "release-eligible");
check("independent -> release-eligible", mailLeg(V.independent, false), "release-eligible");
check("absent -> release-eligible (non-independent, not forgery)", mailLeg(V.absent, false), "release-eligible");
check("contradiction -> dispute EVEN at the lob tier (forgery signal)", mailLeg(V.contra_boolFalse, false), "dispute");

console.log("COMMITTED PROGRAM (independence tier), PROPOSED — oracle confirms stage field names:");
const ph = programHash(independenceProgram);
console.log("  programHash =", ph);
console.log("  program     =", JSON.stringify(independenceProgram));

console.log("\nBYTE-TARGETS for oracle cross-confirm (against #323 branch 18d97b52; re-confirm on merge SHA):");
console.log("  mailEvent.hash[independent] =", hashes.independent);
console.log("  mailEvent.hash[self_report] =", hashes.self_report);

console.log(failures === 0 ? `\nALL GREEN (${n}/${n})` : `\n${failures} FAILURE(S) of ${n}`);
process.exit(failures === 0 ? 0 : 1);
