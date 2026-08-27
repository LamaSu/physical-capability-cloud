#!/usr/bin/env node
/**
 * composite-bundle-signed-kat.cjs
 * Evidence lane c25c8f97 — a REAL signed EvidenceBundle KAT for the print-and-mail composite.
 *
 * Purpose (oracle #1727: "runnable the moment a real signed bundle exists"): hand oracle a concrete
 * EvidenceBundle carrying both legs, signed by a real (fixed, deterministic) Ed25519 kernel key, so its
 * end-to-end verifyEvidenceBundle -> event-present -> release runs against a REAL kernel signature, not
 * just presence. Reuses the exact fixture + roots from composite-print-mail-bundle-golden-mirror.cjs.
 *
 * SIGNING PREIMAGE — PRODUCTION, grounded in source (NOT the raw32 I first guessed; oracle #1523 caught it):
 *   kernelSignature = Ed25519_sign(kernelSeed, utf8(bundleHash))   where bundleHash = "sha256:"+hex
 * The real kernel emitter signs the STRING: evidence-emitter.ts:132-135 does `bundleHashValue = hashBundle(events)`
 * (a "sha256:hex" string) then `signFn(bundleHashValue)`; oracle's verifyEvidenceBundle (bundle-auth.ts:122) checks
 * utf8(sha256:+hex). Emitter and verifier MUST agree, and they agree at the utf8-string form — this is oracle's #1240
 * production convention. (raw32(bundleHash) was the MIRROR artifact, per #1240 — my v1 KAT wrongly used it.)
 *
 * Deterministic: fixed 32-byte kernel seed, fixed fixture. node:crypto only.
 */
"use strict";
const { createHash, createPrivateKey, createPublicKey, sign, verify } = require("node:crypto");

// ---- @pcc/spec canonical.ts (verbatim, same as the golden mirror) --------------------------------
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
const hashBundle = (events) => sha256Prefixed(canonicalize(events.map((e) => e.hash).sort()));

// ---- fixed fixture (identical to the golden mirror) ----------------------------------------------
const JOB = "job-pm-0001", KERNEL = "kernel-pm-0001";
const documentHash = sha256Hex("the-letter-body::Dear resident, ...::v1");
const labelHash = sha256Hex("EASYPOST-LABEL-PNG-BYTES::v1");
const labelCid = "bafkreib" + labelHash.slice(0, 52);
const destinationHash = sha256Hex(canonicalize({ street1: "1 Market St", city: "San Francisco", state: "CA", zip: "94105", country: "US" }));
const trackingCode = "9400111899223817200001";
const commitmentBody = { v: 1, jobId: JOB, kernelId: KERNEL, documentHash, destinationHash, trackingCode, shipmentId: "shp_pm0001", trackerId: "trk_pm0001", carrier: "USPS", service: "First", labelHash, labelCid, mock: false, committedAt: "2026-08-27T11:00:00.000Z" };
const commitment = { ...commitmentBody, hash: sha256Hex(canonicalize(commitmentBody)), signature: null };
const printEvent = { id: "evt-print-0001", type: "printer_job_verified", timestamp: "2026-08-27T12:00:00.000Z", source: { deviceId: "printer:hp-0001", deviceType: "printer_log", kernelId: KERNEL, simulated: false }, payload: { jobId: JOB, documentHash, labelHash, pages: 2, printerId: "hp-0001" } };
const mailEvent = { id: "evt-mail-0001", type: "courier_pickup_confirmed", timestamp: "2026-08-27T13:30:00.000Z", source: { deviceId: "easypost:" + trackingCode, deviceType: "courier_api", kernelId: KERNEL, simulated: false }, payload: { jobId: JOB, trackingCode, trackerId: "trk_pm0001", carrier: "USPS", commitment, commitmentVerified: true, statusDetail: "accepted", carrierMessage: "Accepted at USPS Origin Facility", trackingLocation: { city: "San Francisco", state: "CA", country: "US", zip: "94103" }, providerEventId: "evt_ezp_pm0001", occurredAt: "2026-08-27T13:30:00.000Z", providerRawBody: '{"result":{"tracking_code":"' + trackingCode + '","status":"in_transit"}}' } };
printEvent.hash = hashEvent(printEvent);
mailEvent.hash = hashEvent(mailEvent);
const bundleHash = hashBundle([printEvent, mailEvent]); // = kernelSignedEventsRoot, "sha256:HEX"

// ---- deterministic Ed25519 kernel key from a fixed 32-byte seed (node:crypto, PKCS8/SPKI DER wrap) -
const KERNEL_SEED = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex"); // FIXED test seed — NOT a real key
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), KERNEL_SEED]);
const kernelPriv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const kernelPub = createPublicKey(kernelPriv);
const kernelPubRaw = kernelPub.export({ format: "der", type: "spki" }).subarray(-32); // last 32 bytes = raw ed25519 pubkey

// preimage = utf8(bundleHash) — the "sha256:"+hex STRING, what the real emitter signFn signs (evidence-emitter.ts:135)
const preimage = Buffer.from(bundleHash, "utf8");
const kernelSignature = sign(null, preimage, kernelPriv); // Ed25519 (algorithm implied by the key)

// ---- the signed EvidenceBundle (master EvidenceBundle shape) --------------------------------------
const signedBundle = {
  id: "bundle-pm-0001",
  jobId: JOB,
  stepId: "step-mail-0001",
  kernelId: KERNEL,
  assuranceTier: 0,
  events: [printEvent, mailEvent],
  bundleHash,
  kernelSignature: "ed25519:" + kernelSignature.toString("hex"),
  createdAt: "2026-08-27T13:31:00.000Z",
};

// ---- verify (watched-it-work) --------------------------------------------------------------------
let fail = 0;
const check = (n, ok) => { if (!ok) fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); };
const good = verify(null, preimage, kernelPub, kernelSignature);
const tamperedMsg = Buffer.from("sha256:" + sha256Hex("different-bundle").slice(7), "utf8");
const badMsg = verify(null, tamperedMsg, kernelPub, kernelSignature);
const flip = Buffer.from(kernelSignature); flip[10] ^= 0x01;
const badSig = verify(null, preimage, kernelPub, flip);
// cross-check: the raw32 form (the #1240 MIRROR artifact) must NOT verify against this production sig
const raw32 = Buffer.from(bundleHash.slice("sha256:".length), "hex");
const raw32Verifies = verify(null, raw32, kernelPub, kernelSignature);

console.log("== composite print-and-mail SIGNED bundle KAT (evidence c25c8f97) ==");
console.log("  bundleHash / kernelSignedEventsRoot =", bundleHash);
console.log("  kernelPubkey (raw ed25519, hex)     =", kernelPubRaw.toString("hex"));
console.log("  kernelSignature (ed25519, hex)      =", kernelSignature.toString("hex"));
console.log("  preimage                            = utf8(bundleHash) =", JSON.stringify(bundleHash));
console.log("VERIFY:");
check("valid signature verifies TRUE (utf8-string preimage = production)", good === true);
check("wrong message verifies FALSE", badMsg === false);
check("tampered signature verifies FALSE", badSig === false);
check("raw32 (the #1240 mirror form) does NOT verify vs this production sig", raw32Verifies === false);
console.log(fail === 0 ? "\nALL GREEN (4/4) - sig over utf8(bundleHash) matches oracle verifyEvidenceBundle bundle-auth.ts:122 (production form)" : `\n${fail} FAILURE(S)`);
// emit the signed bundle so oracle can run its end-to-end against it
require("node:fs").writeFileSync(__dirname + "/composite-bundle-signed-kat.json", JSON.stringify({ signedBundle, kernelPubkeyRawHex: kernelPubRaw.toString("hex"), preimage: "utf8(bundleHash) = utf8(sha256:+hex)" }, null, 2));
console.log("wrote composite-bundle-signed-kat.json");
process.exit(fail === 0 ? 0 : 1);
