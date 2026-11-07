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
 * `negatives.failureBearingBundle` is the same bundle with an `execution_failed`
 * appended, correctly hashed and signed. Its integrity verifies, so a consumer
 * that refuses it does so by outcome policy (a contradiction), not by a broken
 * hash.
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
 * `buildLose3Envelope()` is the whole construction, with no I/O; a test rebuilds
 * the fixture with it and compares byte-for-byte.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
} from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/** The vector, built deterministically; `text` is exactly the fixture file's content. */
export async function buildLose3Envelope(): Promise<{ envelope: Record<string, unknown>; text: string }> {
  const { privateKey, rawPub } = kernelKeypair();

  // The Signature object every incumbent producer emits, for bundles (kernel-sdk
  // job-handler, the digital kernels) and for log entries (the kernel's
  // LogCaptureService, pcc-node log_capture.py): signer = "0x" + the first 40
  // hex chars of the public key. The gateway relay captures only this object;
  // a bare hex string is stored as UNSIGNED.
  const ed25519Signature = (message: Uint8Array) => ({
    signer: `0x${rawPub.toString("hex").slice(0, 40)}`,
    algorithm: "ed25519" as const,
    value: edSign(null, message, privateKey).toString("hex"),
  });

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
    const sig = ed25519Signature(signingPreimage(entryHash));
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

  const kernelSignature = ed25519Signature(signingPreimage(bundleHash));

  // The failure-bearing negative: the same events plus the device's own
  // execution_failed, hashed and signed exactly like the positive bundle.
  const failed = {
    type: "execution_failed",
    timestamp: iso(3200),
    source,
    payload: { jobId: JOB_ID, stepId: STEP_ID, reason: "IPP job 1042 state=aborted after completion was reported" },
  };
  const failureEvents = [...events, { ...failed, id: `${JOB_ID}-${failed.type}`, hash: await hashEvent(failed as never) }];
  const failureBundleHash = await hashBundle(failureEvents as never);
  const failureBearingBundle = {
    id: `bundle-${JOB_ID}-with-failure`,
    jobId: JOB_ID,
    stepId: STEP_ID,
    kernelId: KERNEL_ID,
    assuranceTier: 1,
    events: failureEvents,
    bundleHash: failureBundleHash,
    kernelSignature: ed25519Signature(signingPreimage(failureBundleHash)),
    createdAt: iso(4000),
  };

  // The superseded 2026-09-09 form, kept only as a negative for the test.
  const raw32 = Buffer.from(bundleHash.slice("sha256:".length), "hex");
  const raw32KernelSignature = ed25519Signature(raw32);

  // Exactly the public EvidenceBundle fields (types/evidence.ts).
  const bundle = {
    id: `bundle-${JOB_ID}`,
    jobId: JOB_ID,
    stepId: STEP_ID,
    kernelId: KERNEL_ID,
    assuranceTier: 1,
    events,
    bundleHash,
    kernelSignature,
    createdAt: iso(4000),
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
      failureBearingBundle,
      failureNote:
        "the positive bundle plus execution_failed, correctly hashed and signed: integrity verifies, so a consumer must refuse it by outcome policy (completion and failure contradict), not by integrity",
    },
    expectations: {
      executionFailedAbsent: true,
      supportingLogChainEntries: chain.length,
      negativeControl:
        "negatives.failureBearingBundle (execution_failed appended) must not settle; nor may a bundle with one rawContent byte altered",
    },
  };

  return { envelope, text: JSON.stringify(envelope, null, 2) + "\n" };
}

async function main() {
  const out = process.argv[2] ?? DEFAULT_OUT;
  const { envelope, text } = await buildLose3Envelope();
  writeFileSync(out, text);
  const bundle = envelope.bundle as { bundleHash: string; kernelSignature: { value: string } };
  console.log("bundleHash      =", bundle.bundleHash);
  console.log("kernelPublicKey =", envelope.kernelPublicKeyHex);
  console.log("kernelSignature =", bundle.kernelSignature.value.slice(0, 32) + "...");
  console.log("wrote", out);
}

// Only when run as a script, never on import (a test imports buildLose3Envelope).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
