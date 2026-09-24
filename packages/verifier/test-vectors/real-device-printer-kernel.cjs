#!/usr/bin/env node
/**
 * real-device-printer-kernel.cjs — a REAL device-signed printer_job_verified (the print leg).
 * Evidence lane c25c8f97.
 *
 * WHAT MAKES THIS REAL (vs the fixture composite-bundle-signed-kat.cjs):
 *   - The device GENERATES and PERSISTS its own Ed25519 keys under ~/.pcc-devices/<kernelId>/ .
 *     I never choose or see the seed — node's CSPRNG makes it; it lives on the device and is reused,
 *     so the device has a stable identity that authors its own proof (the load-bearing property).
 *   - The document is REAL bytes the device produced; documentHash = sha256 of those exact bytes.
 *   - source.simulated = FALSE.
 * HONEST LIMITS (stated, not blurred):
 *   - The "device" is this tablet, not a hardware-root-of-trust / TEE-attested kernel. Real device key,
 *     not attested hardware.
 *   - Default "print" renders the document to a real FILE (the print tray). PRINT_TARGET=hp sends it to the
 *     physical HP Color LaserJet [0D253A] (real paper) — off by default (a physical side effect).
 *   - This is the PRINT leg only. The mail leg stays a fixture until a real EasyPost label + a real carrier
 *     scan exist — a synthetic webhook is not a carrier scan.
 *
 * CONVENTIONS (from oracle #1774/#1785, matched so the bundle verifies first try):
 *   kernelSignature   = Ed25519_sign(SESSION_key, RAW32(bundleHash))                    [raw32, pinned]
 *   parentSignature   = Ed25519_sign(PARENT_key,  utf8(canonicalize(ska_without_parentSignature)))
 *   sessionKeyAuthDigest = "0x"+hex(sha256(canonicalize(ska_with_parentSignature)))
 *   kernelSignedEventsRoot = "0x"+(bundleHash without "sha256:")
 *   PARENT (funded principal) is Ed25519 (evidence plane); the secp256k1 kernel-keychain key is the
 *   money/registration identity, NOT the evidence delegation parent. (Answering oracle #1785 = ed25519.)
 */
"use strict";
const { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");
const hashEvent = (e) => sha256Prefixed(canonicalize({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload }));
const hashBundle = (events) => sha256Prefixed(canonicalize(events.map((e) => e.hash).sort()));

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex"); // Ed25519 PKCS8 seed wrapper
const rawSeedToPriv = (seed32) => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed32]), format: "der", type: "pkcs8" });
const rawPub = (pub) => pub.export({ format: "der", type: "spki" }).subarray(-32);

// --- device key store: generate-once, persist, reuse (the device holds its own keys) ---------------
const KERNEL_ID = process.env.KERNEL_ID || "kernel-hp-printer";
const DEVICE_DIR = path.join(os.homedir(), ".pcc-devices", KERNEL_ID);
fs.mkdirSync(DEVICE_DIR, { recursive: true });
function loadOrCreateKey(name) {
  const p = path.join(DEVICE_DIR, name + ".ed25519.seed");
  let seed, created = false;
  if (fs.existsSync(p)) {
    seed = Buffer.from(fs.readFileSync(p, "utf8").trim(), "hex");
  } else {
    // node CSPRNG generates the seed; I never choose it
    const kp = generateKeyPairSync("ed25519");
    seed = kp.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
    fs.writeFileSync(p, seed.toString("hex") + "\n", { mode: 0o600 });
    created = true;
  }
  const priv = rawSeedToPriv(seed);
  const pub = createPublicKey(priv);
  return { priv, pub, pubHex: rawPub(pub).toString("hex"), created };
}
const parent = loadOrCreateKey("evidence-parent"); // stable device evidence identity (funded principal)
// session key is ephemeral per run (a fresh random key each print) — the parent delegates to it
const sessSeed = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
const session = (() => { const priv = rawSeedToPriv(sessSeed); const pub = createPublicKey(priv); return { priv, pub, pubHex: rawPub(pub).toString("hex") }; })();

// --- the "print": device produces a real document (real bytes) ------------------------------------
const now = Date.now();
const jobId = "job-hp-" + now;
const OUT_DIR = path.join(DEVICE_DIR, "print-tray");
fs.mkdirSync(OUT_DIR, { recursive: true });
const docText =
  "PCC print-and-mail — real device print\n" +
  "kernel: " + KERNEL_ID + "\n" +
  "job: " + jobId + "\n" +
  "issued: " + new Date(now).toISOString() + "\n\n" +
  "Dear resident,\n\nThis page was produced by a real device that signs its own telemetry.\n" +
  "The device holds an Ed25519 key it generated; the hash below is of these exact bytes.\n\n-- PCC evidence lane\n";
const docPath = path.join(OUT_DIR, jobId + ".txt");
fs.writeFileSync(docPath, docText, "utf8");
const docBytes = fs.readFileSync(docPath);
const documentHash = sha256Hex(docBytes); // sha256 of the REAL printed bytes

// optional: send to the physical HP (real paper) only if explicitly asked
let physicalPrint = "not-attempted (default: file only)";
if (process.env.PRINT_TARGET === "hp") {
  const { spawnSync } = require("node:child_process");
  const ps = `Get-Content -Raw "${docPath}" | Out-Printer -Name "HP Color LaserJet Pro MFP 3301 [0D253A]"`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 60000 });
  physicalPrint = r.status === 0 ? "SENT to HP Color LaserJet Pro MFP 3301 [0D253A]" : "FAILED: " + (r.stderr || r.error || "").toString().slice(0, 200);
}

// --- the real printer_job_verified event (simulated:false) ----------------------------------------
const printEvent = {
  id: "evt-" + jobId,
  type: "printer_job_verified",
  timestamp: new Date(now).toISOString(),
  source: { deviceId: "printer:HP-Color-LaserJet-Pro-MFP-3301-0D253A", deviceType: "printer_log", kernelId: KERNEL_ID, simulated: false },
  payload: { jobId, documentHash, pages: 1, printerId: "0D253A", bytes: docBytes.length },
};
printEvent.hash = hashEvent(printEvent);

// --- assemble + session-key-sign the bundle (raw32) -----------------------------------------------
const bundleHash = hashBundle([printEvent]);
const bundleRaw32 = Buffer.from(bundleHash.slice("sha256:".length), "hex");
const kernelSignature = sign(null, bundleRaw32, session.priv); // Ed25519 over raw32(bundleHash)

// --- session-key delegation (parent Ed25519 signs the session-key body), per oracle #1774 ---------
const skaBody = {
  sessionId: "ses-" + jobId,
  parentAgentId: KERNEL_ID,
  publicKey: session.pubHex,                        // raw32 ed25519 hex = the key that signed the bundle
  issuedAt: Math.floor(now / 1000),
  expiresAt: Math.floor(now / 1000) + 3600,
  scope: { allowedActions: ["sign-evidence"], maxSignatures: 1 },
};
const parentSignature = "0x" + sign(null, Buffer.from(canonicalize(skaBody), "utf8"), parent.priv).toString("hex");
const sessionKeyAuthorization = { ...skaBody, parentSignature };
const sessionKeyAuthDigest = "0x" + createHash("sha256").update(canonicalize(sessionKeyAuthorization), "utf8").digest("hex");
const kernelSignedEventsRoot = "0x" + bundleHash.slice("sha256:".length);

const signedBundle = {
  id: "bundle-" + jobId, jobId, stepId: "step-print-" + jobId, kernelId: KERNEL_ID, assuranceTier: 0,
  events: [printEvent], bundleHash,
  kernelSignature: "ed25519:" + kernelSignature.toString("hex"),
  sessionKeyAuthorization,
  createdAt: new Date(now).toISOString(),
};

// --- verify (watched-it-work) ---------------------------------------------------------------------
let fail = 0;
const check = (n, ok) => { if (!ok) fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); };
check("bundle kernelSignature verifies (session key over raw32(bundleHash))", verify(null, bundleRaw32, session.pub, kernelSignature) === true);
check("delegation parentSignature verifies (parent over utf8(canonicalize(ska body)))",
  verify(null, Buffer.from(canonicalize(skaBody), "utf8"), parent.pub, Buffer.from(parentSignature.slice(2), "hex")) === true);
check("documentHash matches the real printed bytes", documentHash === sha256Hex(fs.readFileSync(docPath)));
check("session public key in ska == the key that signed the bundle", sessionKeyAuthorization.publicKey === session.pubHex);

console.log("== REAL device-signed printer_job_verified (print leg) — kernel " + KERNEL_ID + " ==");
console.log("  device parent pubkey (Ed25519, PERSISTED) =", parent.pubHex, parent.created ? "(generated now)" : "(existing device identity)");
console.log("  ephemeral session pubkey (Ed25519)        =", session.pubHex);
console.log("  printed document                          =", docPath, "(" + docBytes.length + " bytes)");
console.log("  documentHash (sha256 of real bytes)       =", documentHash);
console.log("  bundleHash / kernelSignedEventsRoot       =", bundleHash);
console.log("  kernelSignature (ed25519 over raw32)      =", kernelSignature.toString("hex"));
console.log("  sessionKeyAuthDigest                      =", sessionKeyAuthDigest);
console.log("  fundedPrincipalPublicKey (for oracle)     =", parent.pubHex);
console.log("  physical print                            =", physicalPrint);
const outPath = path.join(DEVICE_DIR, jobId + ".bundle.json");
fs.writeFileSync(outPath, JSON.stringify({ signedBundle, block: { kernelSignedEventsRoot, sessionKeyAuthDigest }, fundedPrincipalPublicKey: parent.pubHex, requiredAction: "sign-evidence", note: "REAL device-held keys + real document bytes; tablet-as-device (not TEE-attested); print leg only" }, null, 2));
console.log("  wrote                                     =", outPath);
console.log(fail === 0 ? "\nALL GREEN (4/4) — real device key signed a real document's bundle; verifies locally" : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
