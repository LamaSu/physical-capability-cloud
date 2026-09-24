/**
 * Emit the LO-SE-3 consumer-run vector: a kernel-signed EvidenceBundle whose
 * events carry machine.execution_log, in the shape oracle asked for (bus #2125).
 *
 * Oracle does not host @pcc/spec PrimitiveVerifiers — it authenticates a bundle
 * (Ed25519 over the bundle digest) and runs its committed program. So the
 * consumer run is driven by handing it THIS artifact:
 *   - execution_completed        success receipt
 *   - printer_job_verified       tier>=1 supporting log-chain
 *   - execution_failed           ABSENT (its presence must flip the outcome)
 *
 * Every signature covers `signingPreimage(digest)` — the LO-EV-1 byte contract
 * (`pcc.evidence.signing-preimage.v1`): the UTF-8 bytes of the tagged digest
 * string `sha256:<64 lowercase hex>`, 71 bytes. The 2026-09-09 vector signed
 * the bundle over the raw 32 digest bytes instead; that form is emitted below
 * only as a labelled negative so the test can prove it is rejected.
 *
 * Hashes come from the PRODUCTION canonicalizer (util/canonical.ts hashEvent /
 * hashBundle). The signing key is a FIXED test key so the vector is
 * reproducible; it is a golden fixture, never an operator key.
 *
 * Run:  ../../node_modules/.bin/tsx scripts/emit-execution-log-bundle.mts [outfile]
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
} from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { hashEvent, hashBundle } from "../src/util/canonical.js";
import { SIGNING_PREIMAGE_CONTRACT, signingPreimage } from "../src/evidence/signing-preimage.js";
import { computeLogEntryHash, GENESIS_HASH } from "../src/evidence/verifiers/log-chain.js";

const DEFAULT_OUT = fileURLToPath(
  new URL("../src/__tests__/fixtures/lose3-execution-log-bundle.json", import.meta.url),
);

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
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { privateKey, rawPub };
}

async function main() {
  const out = process.argv[2] ?? DEFAULT_OUT;
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
    const sig = edSign(null, signingPreimage(entryHash), privateKey).toString("hex");
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
  const kernelSignature = edSign(null, signingPreimage(bundleHash), privateKey).toString("hex");

  // The superseded 2026-09-09 form, kept only as a negative for the test.
  const raw32 = Buffer.from(bundleHash.slice("sha256:".length), "hex");
  const raw32KernelSignature = edSign(null, raw32, privateKey).toString("hex");

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
    signingPreimageContract: SIGNING_PREIMAGE_CONTRACT,
    signatureScheme: "ed25519 over signingPreimage(bundleHash) = UTF-8 of the tagged digest string (71 bytes)",
    bundle,
    negatives: {
      raw32KernelSignature,
      raw32Note:
        "ed25519 over the raw 32 digest bytes — the superseded 2026-09-09 form; must NOT verify under signingPreimage",
    },
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
  console.log("wrote", out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
