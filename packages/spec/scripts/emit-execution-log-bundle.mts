/**
 * Emit the LO-SE-3 consumer-run vector: a kernel-signed EvidenceBundle whose
 * events carry machine.execution_log, in the shape oracle asked for (bus #2125).
 *
 * Oracle does not host @pcc/spec PrimitiveVerifiers — it authenticates a bundle
 * (Ed25519 over bundleHash, bundleHash == kernelSignedEventsRoot) and runs its
 * committed program. So the consumer run is driven by handing it THIS artifact:
 *   - execution_completed        success receipt
 *   - printer_job_verified       tier>=1 supporting log-chain
 *   - execution_failed           ABSENT (its presence must flip the outcome)
 *
 * Hashes come from the PRODUCTION canonicalizer (util/canonical.ts hashEvent /
 * hashBundle). The signing key is a FIXED test key so the vector is
 * reproducible; it is a golden fixture, never an operator key.
 *
 * Run:  npx vite-node scripts/emit-execution-log-bundle.mts -- <outfile>
 */
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { writeFileSync } from "node:fs";

import { canonicalize, hashEvent, hashBundle } from "../src/util/canonical.js";
import { computeLogEntryHash, GENESIS_HASH } from "../src/evidence/verifiers/log-chain.js";

const JOB_ID = "job-lose3-consumer-run-001";
const STEP_ID = "step-print-1";
const KERNEL_ID = "kernel-hp-3301-golden";
const DEVICE_ID = "dev-hp-3301-0D253A";
const T0 = Date.parse("2026-09-09T20:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

/** Deterministic Ed25519 key from a fixed seed — reproducible, test-only. */
function kernelKeypair() {
  const seed = createHash("sha256").update("pcc:sensors:lose3-golden-kernel:v1").digest();
  // Ed25519 PKCS#8 prefix + 32-byte seed.
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]);
  const { createPrivateKey, createPublicKey } = require("node:crypto");
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { privateKey, rawPub };
}

async function main() {
  const out = process.argv[process.argv.length - 1];
  const { privateKey, rawPub } = kernelKeypair();

  // ── the machine's own execution record: a kernel-signed hash chain ──
  const rawLines = [
    "IPP job 1042 accepted: document=lose3-golden.pdf pages=1",
    "IPP job 1042 state=processing",
    "IPP job 1042 state=completed impressions=1",
  ];
  const chain: Record<string, unknown>[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const capturedAt = iso(1000 + i * 500);
    const entryHash = await computeLogEntryHash(rawLines[i]!, DEVICE_ID, capturedAt);
    const sig = edSign(null, Buffer.from(entryHash), privateKey).toString("hex");
    chain.push({
      entryId: `log-${i}`,
      entryHash,
      previousHash: i === 0 ? GENESIS_HASH : (chain[i - 1]!.entryHash as string),
      rawContent: rawLines[i],
      source: DEVICE_ID,
      capturedAt,
      kernelSignature: sig,
    });
  }

  const source = { deviceId: DEVICE_ID, kernelId: KERNEL_ID };

  const rawEvents = [
    {
      type: "execution_completed",
      timestamp: iso(3000),
      source,
      payload: { jobId: JOB_ID, stepId: STEP_ID, success: true, impressions: 1 },
    },
    {
      type: "printer_job_verified",
      timestamp: iso(3500),
      source,
      payload: {
        jobId: JOB_ID,
        primitive: "machine.execution_log",
        params: { logKind: "job_log" },
        entries: chain,
      },
    },
  ];

  const events = [];
  for (const e of rawEvents) events.push({ ...e, id: `${JOB_ID}-${e.type}`, hash: await hashEvent(e as never) });

  const bundleHash = await hashBundle(events as never);
  // Signature is over the RAW 32 bytes of the digest (strip the "sha256:" tag).
  const raw32 = Buffer.from(bundleHash.replace(/^sha256:/, ""), "hex");
  const kernelSignature = edSign(null, raw32, privateKey).toString("hex");

  const bundle = {
    id: `bundle-${JOB_ID}`,
    jobId: JOB_ID,
    stepId: STEP_ID,
    kernelId: KERNEL_ID,
    assuranceTier: 1,
    events,
    bundleHash,
    kernelSignature,
    finalizedAt: iso(4000),
  };

  const envelope = {
    vector: "lose3-execution-log-consumer-run",
    producedBy: "sensors 7a438686",
    note: "machine.execution_log carried as authenticated events; execution_failed deliberately ABSENT",
    kernelPublicKeyHex: rawPub.toString("hex"),
    signatureScheme: "ed25519 over raw32(bundleHash)",
    bundle,
    expectations: {
      executionFailedAbsent: true,
      supportingLogChainEntries: chain.length,
      negativeControl:
        "re-run with an execution_failed event appended, or one rawContent byte altered, must not settle",
    },
  };

  writeFileSync(out, JSON.stringify(envelope, null, 2) + "\n");
  console.log("bundleHash      =", bundleHash);
  console.log("kernelPublicKey =", rawPub.toString("hex"));
  console.log("kernelSignature =", kernelSignature.slice(0, 32) + "...");
  console.log("canonical check =", canonicalize({ ok: true }));
  console.log("wrote", out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
