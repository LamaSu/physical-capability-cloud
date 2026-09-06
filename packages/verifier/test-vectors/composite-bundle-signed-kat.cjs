#!/usr/bin/env node
/**
 * composite-bundle-signed-kat.cjs
 * Evidence lane c25c8f97 — a signed EvidenceBundle KAT (conformance fixture) for the print-and-mail composite.
 *
 * HONEST SCOPE (do not overstate — this is a FIXTURE, not evidence):
 *   - The events are hand-authored with invented data; the carrier scan is a synthetic providerRawBody.
 *   - The kernel key is a FIXED TEST seed chosen here — the architecture requires a real DEVICE to sign;
 *     no real kernel signer exists yet (kernel/src/evidence-emitter.ts:53-62 is a TEST placeholder that
 *     returns a fake string `test_sig_<...>`, never a real Ed25519 sig; kernel-hp-printer is unbuilt).
 *   So this proves the bundle hash + signature MECHANICS and gives oracle a concrete artifact to run its
 *   verifyEvidenceBundle against. It is NOT evidence that any print/mail job happened.
 *
 * SIGNING PREIMAGE — a PINNED CONVENTION, not a discovered production fact (there is no real signFn to
 * discover). The emitter's signFn is pluggable ((data:string)=>Signature, evidence-emitter.ts:135 passes
 * the "sha256:hex" string), so the emitter does NOT fix the byte preimage — the SIGNER does, and it is
 * unbuilt. So evidence + oracle PIN it deliberately:
 *   kernelSignature = Ed25519_sign(kernelSeed, RAW32(bundleHash))   where RAW32 = the 32 bytes of the digest.
 * raw32 = sign the digest BYTES (the cryptographic standard), matches oracle's verifyEvidenceBundle after
 * its #1766 flip. (#1240's "utf8-string=production" was a placeholder awaiting a real vector — there is none.)
 * When a real kernel signer is built it MUST sign RAW32(bundleHash) to honour this pin.
 *
 * SCOPE BOUNDARY (2026-09-02) — READ BEFORE COMPARING ROOTS WITH THE GOLDEN.
 * This KAT pins ONE thing: the SIGNING CONVENTION (preimage = RAW32(bundleHash), ed25519).
 * Its events are hand-authored fixture data carrying the PRE-#297 mail-leg payload shape, so its
 * bundleHash (sha256:6af75929..) is DELIBERATELY NOT the same value as the re-bound composite golden's
 * kernelSignedEventsRoot (sha256:99df718a.., re-bound to the on-master carrier.ts emitter after PR #297
 * merged as f0fc9792). Those two roots are over different event bytes and are SUPPOSED to differ.
 * Use the GOLDEN as the byte-target for a real producer; use THIS KAT only for the signature convention.
 * These signature values are cross-confirmed and pinned by oracle (#1750/#1761) — do not move them
 * without telling oracle, which is why this file was NOT re-bound along with the golden.
 *
 * Deterministic: fixed test seed + fixed fixture. node:crypto only.
 */
"use strict";
const { createHash, createPrivateKey, createPublicKey, sign, verify } = require("node:crypto");

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
const bundleHash = hashBundle([printEvent, mailEvent]);

// deterministic Ed25519 TEST key from a fixed seed (NOT a real device key)
const KERNEL_SEED = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex");
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), KERNEL_SEED]);
const kernelPriv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const kernelPub = createPublicKey(kernelPriv);
const kernelPubRaw = kernelPub.export({ format: "der", type: "spki" }).subarray(-32);

// PINNED preimage = RAW32(bundleHash)
const preimage = Buffer.from(bundleHash.slice("sha256:".length), "hex");
const kernelSignature = sign(null, preimage, kernelPriv);

const signedBundle = {
  id: "bundle-pm-0001", jobId: JOB, stepId: "step-mail-0001", kernelId: KERNEL, assuranceTier: 0,
  events: [printEvent, mailEvent], bundleHash,
  kernelSignature: "ed25519:" + kernelSignature.toString("hex"),
  createdAt: "2026-08-27T13:31:00.000Z",
};

let fail = 0;
const check = (n, ok) => { if (!ok) fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); };
const good = verify(null, preimage, kernelPub, kernelSignature);
const tamperedRoot = Buffer.from(sha256Hex("different-bundle"), "hex");
const badMsg = verify(null, tamperedRoot, kernelPub, kernelSignature);
const flip = Buffer.from(kernelSignature); flip[10] ^= 0x01;
const badSig = verify(null, preimage, kernelPub, flip);
// cross-check: the utf8("sha256:"+hex) STRING form must NOT verify against this raw32-pinned sig
const utf8Form = Buffer.from(bundleHash, "utf8");
const utf8Verifies = verify(null, utf8Form, kernelPub, kernelSignature);

console.log("== composite print-and-mail SIGNED bundle KAT (fixture, evidence c25c8f97) ==");
console.log("  bundleHash / kernelSignedEventsRoot =", bundleHash);
console.log("  kernelPubkey (raw ed25519, hex)     =", kernelPubRaw.toString("hex"), "(TEST key)");
console.log("  kernelSignature (ed25519, hex)      =", kernelSignature.toString("hex"));
console.log("  preimage                            = RAW32(bundleHash) =", preimage.toString("hex"), "(PINNED convention)");
console.log("VERIFY:");
check("valid signature verifies TRUE (raw32 preimage = pinned)", good === true);
check("wrong message verifies FALSE", badMsg === false);
check("tampered signature verifies FALSE", badSig === false);
check("utf8(sha256:+hex) string form does NOT verify vs this raw32-pinned sig", utf8Verifies === false);
console.log(fail === 0 ? "\nALL GREEN (4/4) - sig over RAW32(bundleHash), matches oracle verifyEvidenceBundle after #1766. FIXTURE, not real evidence." : `\n${fail} FAILURE(S)`);
require("node:fs").writeFileSync(__dirname + "/composite-bundle-signed-kat.json", JSON.stringify({ signedBundle, kernelPubkeyRawHex: kernelPubRaw.toString("hex"), preimage: "RAW32(bundleHash) [PINNED]", note: "FIXTURE: test key + fabricated events; not evidence" }, null, 2));
console.log("wrote composite-bundle-signed-kat.json");
process.exit(fail === 0 ? 0 : 1);
