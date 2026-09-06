#!/usr/bin/env node
/**
 * composite-print-mail-bundle-golden-mirror.cjs
 * Evidence lane c25c8f97 — the ONE-bundle / ONE-kernelSignedEventsRoot golden for `document.print-and-mail`.
 *
 * This is the shared BYTE-TARGET named in ~/.claude/shared/vnext-composite-evidence-print-and-mail-v2.md (v2.1):
 * the public-side composite EvidenceBundle producer (hackathon Spark job) AND the oracle evaluator both byte-match
 * the roots emitted here. sol ranks this composite (print+carrier -> one authenticated bundle) as the #1 gap.
 *
 * Standalone (only node:crypto). canonicalize + sha256 re-implement packages/spec/src/util/canonical.ts:20-56
 * VERBATIM (verified byte-identical): sorted keys at all depths, no whitespace, numbers unquoted, undefined omitted,
 * event hashes are "sha256:"-prefixed. Carrier's commitment.hash is PLAIN hex (its own convention) — honored below.
 *
 * Deterministic: all inputs are fixed constants (no Date.now / Math.random), so the roots are reproducible.
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
    const pairs = keys
      .filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonicalize(value[k]));
    return "{" + pairs.join(",") + "}";
  }
  return String(value);
}
const sha256Prefixed = (s) => "sha256:" + createHash("sha256").update(s, "utf8").digest("hex"); // @pcc/spec sha256()
const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");                   // carrier commitment.hash form
// hashEvent(e) = sha256(canonicalize({type,timestamp,source,payload}))  — id & hash NOT in preimage
const hashEvent = (e) => sha256Prefixed(canonicalize({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload }));
// hashBundle(E) = sha256(canonicalize( E.map(e=>e.hash).sort() ))       — the kernelSignedEventsRoot
const hashBundle = (events) => sha256Prefixed(canonicalize(events.map((e) => e.hash).sort()));

// ---- fixed sample material (a single job flows through both legs) --------------------------------
const JOB = "job-pm-0001";
const KERNEL = "kernel-pm-0001";
const documentHash = sha256Hex("the-letter-body::Dear resident, ...::v1");       // sha256 of the printed doc bytes
const labelHash = sha256Hex("EASYPOST-LABEL-PNG-BYTES::v1");                      // sha256 of the label BYTES (v2)
const labelCid = "bafkreib" + labelHash.slice(0, 52);                            // CIDv1(raw,sha256) placeholder over same bytes
const destinationHash = sha256Hex(canonicalize({ street1: "1 Market St", city: "San Francisco", state: "CA", zip: "94105", country: "US" }));
const trackingCode = "9400111899223817200001";

// carrier ShipmentCommitmentBody (v:1) — the 14 fields carrier v2 @82a30caf binds; commitment.hash = sha256HEX(canonicalize(body))
const commitmentBody = {
  v: 1, jobId: JOB, kernelId: KERNEL, documentHash, destinationHash, trackingCode,
  shipmentId: "shp_pm0001", trackerId: "trk_pm0001", carrier: "USPS", service: "First",
  labelHash, labelCid, mock: false, committedAt: "2026-08-27T11:00:00.000Z",
};
const commitmentHash = sha256Hex(canonicalize(commitmentBody));                   // carrier convention: plain hex
const commitment = { ...commitmentBody, hash: commitmentHash, signature: null };  // signature null = no gateway key in the fixture

// PRINT leg — printer_job_verified (kernel-signed device event)
const printEvent = {
  id: "evt-print-0001",
  type: "printer_job_verified",
  timestamp: "2026-08-27T12:00:00.000Z",
  source: { deviceId: "printer:hp-0001", deviceType: "printer_log", kernelId: KERNEL, simulated: false },
  payload: { jobId: JOB, documentHash, labelHash, pages: 2, printerId: "hp-0001" },
};
// MAIL leg — courier_pickup_confirmed (carrier scan).
// RE-BOUND 2026-09-02 to the ON-MASTER emitter, field-for-field: packages/gateway/src/routes/carrier.ts
// :200-231 as merged by PR #297 (merge commit f0fc9792). The pre-merge draft shape this golden used to
// carry diverged in ways that mattered — see the predicate note on commitmentHashValid below.
const providerRawBody = '{"result":{"tracking_code":"' + trackingCode + '","status":"in_transit"}}';
const mailPayload = {
  jobId: JOB,
  trackingCode,
  trackerId: "trk_pm0001",
  shipmentId: "shp_pm0001",
  carrier: "USPS",
  trackerStatus: "in_transit",
  statusDetail: "accepted",
  carrierMessage: "Accepted at USPS Origin Facility",
  trackingLocation: { city: "San Francisco", state: "CA", country: "US", zip: "94103" },
  providerEventId: "evt_ezp_pm0001",
  occurredAt: "2026-08-27T13:30:00.000Z",
  provider: "easypost",
  providerMode: "production",
  providerSignatureHeader: "hmac-sha256=pm0001",
  /** Exact signed bytes, base64 — decode and re-run HMAC to re-verify (carrier.ts:227). */
  providerRawBodyB64: Buffer.from(providerRawBody, "utf8").toString("base64"),
  commitment,
  commitmentHashValid: true,
  commitmentSignatureVerified: true,
  // R5 RE-BIND (carrier PR #323, master merge 7a864910 ⊇ commit 18d97b52): the EasyPost leg now
  // asserts independent-carrier-scan provenance INSIDE the hashed payload (carrier.ts buildCarrierEvidenceEvent).
  // These two fields move mailEvent.hash + kernelSignedEventsRoot; commitment.hash + printEvent.hash are untouched.
  provenance: "independent_carrier_scan",
  independentCarrierScan: true,
};
const mailEvent = {
  id: "evt-mail-0001",
  type: "courier_pickup_confirmed",
  timestamp: "2026-08-27T13:30:00.000Z",
  source: { deviceId: "easypost:" + trackingCode, deviceType: "courier_api", kernelId: KERNEL, simulated: false },
  payload: mailPayload,
};

// ---- compute the goldens -------------------------------------------------------------------------
printEvent.hash = hashEvent(printEvent);
mailEvent.hash = hashEvent(mailEvent);
const kernelSignedEventsRoot = hashBundle([printEvent, mailEvent]);

// ---- the release predicate (a)AND(b)AND(c)AND(d), fail-closed — the SHAPE the oracle evaluator enforces --------
const MAIL_PICKUP = "courier_pickup_confirmed";
const PRINT = "printer_job_verified";
function eventPresentAuthenticated(bundleEvents, type) {                    // oracle's event-present primitive
  return bundleEvents.some((e) => e.type === type && e.source && e.source.simulated === false);
}
function evaluate(bundleEvents, fundedJobId) {
  const print = bundleEvents.find((e) => e.type === PRINT);
  const mail = bundleEvents.find((e) => e.type === MAIL_PICKUP);
  const a = eventPresentAuthenticated(bundleEvents, PRINT);                 // (a) authenticated print leg
  const b = !!mail && mail.source.simulated === false                      // (b) authenticated mail leg,
    && mail.payload.jobId === fundedJobId                                   //     anti-swap: scan.jobId == funded
    && mail.payload.commitment && mail.payload.commitment.jobId === fundedJobId
    // ON-MASTER there is NO `commitmentVerified` — carrier.ts emits TWO booleans. Checking the old
    // single field against a real event read `undefined` and would have DISPUTED genuine production
    // evidence (fail-closed, but wrong). Both are required: the commitment must recompute AND the
    // gateway must actually have signed it — an unsigned commitment is unauthenticated, and this is
    // the money path. NOTE: carrier.ts only enforces the signature when a signing key is configured
    // (`getActiveSigningKey()`), so this predicate is deliberately STRICTER than the emitter.
    && mail.payload.commitmentHashValid === true
    && mail.payload.commitmentSignatureVerified === true
    && ["in_transit", "accepted", "out_for_delivery"].includes(mail.payload.statusDetail)
    && !!mail.payload.trackingLocation;                                     //     accepted-into-mail-stream proof
  const c = !!mail && !!print                                              // (c) commitment predates handoff/scan
    && mail.payload.commitment.committedAt < mail.payload.occurredAt;
  const d = !!print && print.payload.documentHash === (mail && mail.payload.commitment.documentHash); // (d) doc<->envelope
  return a && b && c && d ? "release" : "dispute";
}

// ---- negative controls (each MUST be `dispute`) --------------------------------------------------
const neg = {};
// 1. absent mail leg -> fail-closed
neg.absent_mail = evaluate([printEvent], JOB);
// 2. jobId anti-swap: a well-formed pickup for a DIFFERENT job must not satisfy this unit
const swapCommitment = { ...commitment, jobId: "job-OTHER-9999", hash: sha256Hex(canonicalize({ ...commitmentBody, jobId: "job-OTHER-9999" })) };
const swapMail = { ...mailEvent, payload: { ...mailPayload, jobId: "job-OTHER-9999", commitment: swapCommitment } };
swapMail.hash = hashEvent(swapMail);
neg.jobid_swap = evaluate([printEvent, swapMail], JOB);
// 3. photo can never close the mail leg
const photoEvent = {
  id: "evt-photo-0001", type: "photo_captured", timestamp: "2026-08-27T12:30:00.000Z",
  source: { deviceId: "phone:exec-01", deviceType: "human", kernelId: KERNEL, simulated: false },
  payload: { jobId: JOB, note: "envelope in mailbox" },
};
photoEvent.hash = hashEvent(photoEvent);
neg.photo_cannot_close = evaluate([printEvent, photoEvent], JOB);
// 4. simulated (mock) mail event -> dispute
const simMail = { ...mailEvent, source: { ...mailEvent.source, simulated: true } };
simMail.hash = hashEvent(simMail);
neg.simulated = evaluate([printEvent, simMail], JOB);
// 5. commitment present and recomputing, but NOT gateway-signed -> dispute.
//    An unsigned commitment is unauthenticated: nothing binds it to the gateway that issued the label.
const unsignedMail = { ...mailEvent, payload: { ...mailPayload, commitmentSignatureVerified: false } };
unsignedMail.hash = hashEvent(unsignedMail);
neg.unsigned_commitment = evaluate([printEvent, unsignedMail], JOB);

// ---- positive control ----------------------------------------------------------------------------
const positive = evaluate([printEvent, mailEvent], JOB);

// ---- assert + emit -------------------------------------------------------------------------------
let failures = 0;
let checksRun = 0;
const check = (name, got, want) => { checksRun++; const ok = got === want; if (!ok) failures++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: got=${got} want=${want}`); };
console.log("== document.print-and-mail composite bundle golden (evidence c25c8f97) ==");
console.log("GOLDENS:");
console.log("  documentHash            =", documentHash);
console.log("  labelHash               =", labelHash);
console.log("  destinationHash         =", destinationHash);
console.log("  commitment.hash (hex)   =", commitmentHash);
console.log("  printEvent.hash         =", printEvent.hash);
console.log("  mailEvent.hash          =", mailEvent.hash);
console.log("  kernelSignedEventsRoot  =", kernelSignedEventsRoot);
console.log("PREDICATE:");
check("positive (both legs, committed, doc-match)", positive, "release");
check("negative absent_mail (fail-closed)", neg.absent_mail, "dispute");
check("negative jobid_swap (anti-swap)", neg.jobid_swap, "dispute");
check("negative photo_cannot_close_mail", neg.photo_cannot_close, "dispute");
check("negative simulated_evidence", neg.simulated, "dispute");
check("negative unsigned_commitment", neg.unsigned_commitment, "dispute");
console.log(failures === 0 ? `\nALL GREEN (${checksRun}/${checksRun})` : `\n${failures} FAILURE(S) of ${checksRun}`);
process.exit(failures === 0 ? 0 : 1);
