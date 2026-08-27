/**
 * Tests for the composite print-and-mail EvidenceBundle producer.
 *
 * Built to the posted contract (~/.claude/shared/vnext-composite-evidence-print-and-mail-v2.md):
 *   - ONE bundle, BOTH legs, ONE bundleHash (the kernel-signed events root),
 *     ONE kernelSignature (contract §1.2).
 *   - Fail-closed: no mail leg ⇒ not assemblable AND not valid ("no scan, no release").
 *   - Anti-swap: a carrier scan for a different job is rejected (§0(b)).
 *   - A photo (or any non-courier_pickup_confirmed) can never close the mail leg (§0, §2).
 *
 * Fixtures mirror the REAL emitters, verbatim in shape:
 *   - print leg  → printer-log-adapter.stopRecording() (feat/print-kernel-ipp,
 *     packages/kernel/src/adapters/printer-log-adapter.ts): type printer_job_verified,
 *     payload { jobId, chainLength, headHash, tailHash, logSource, summary }.
 *   - mail leg   → buildCarrierEvidenceEvent (feat/carrier-integration @82a30caf,
 *     packages/gateway/src/routes/carrier.ts): type courier_pickup_confirmed with
 *     the full §1.3 recompute payload (jobId, trackingCode, commitment, providerRawBody…).
 * Events are hashed with @pcc/spec `hashEvent` exactly as those emitters do, so
 * they arrive at the producer "already hashed by @pcc/spec" (the PULL model).
 *
 * The kernel signer is byte-identical to makeKernelEd25519Signer
 * (packages/kernel/src/printer-job.ts) — reconstructed here from tweetnacl
 * because that symbol is not yet on master. Proves the composite is "ready for
 * the existing kernel signer": the produced kernelSignature verifies under
 * nacl.sign.detached.verify over bundleHash.
 */

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import {
  hashEvent,
  hashBundle,
  verifyBundleHash,
  type EvidenceEvent,
  type EvidenceSource,
  type Signature,
  type Address,
} from "@pcc/spec";
import {
  assembleCompositePrintMailBundle,
  signCompositePrintMailBundle,
  verifyCompositePrintMailBundle,
  CompositeBundleError,
  COMPOSITE_PRINT_EVENT_TYPE,
  COMPOSITE_MAIL_EVENT_TYPE,
  DEFAULT_COMPOSITE_TIER,
  type CompositeRejectionCode,
} from "../services/composite-print-mail-bundle.js";

// ─── fixtures ──────────────────────────────────────────────────────────────

const JOB = "job-print-and-mail-001";
const KERNEL = "kernel-shop-42";
const TRACKING = "9400111899560000000001";
const DOC_HASH = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const OCCURRED_AT = "2026-08-27T10:07:30.000Z";

/** Attach an id + a real @pcc/spec hashEvent hash — the shape every emitter produces. */
async function hashed(ev: Omit<EvidenceEvent, "id" | "hash">): Promise<EvidenceEvent> {
  return { id: randomUUID(), ...ev, hash: await hashEvent(ev) };
}

/** A printer_job_verified event, shaped like printer-log-adapter.stopRecording(). */
function makePrintEvent(opts: { jobId?: string; simulated?: boolean } = {}): Promise<EvidenceEvent> {
  const jobId = opts.jobId ?? JOB;
  const source: EvidenceSource = {
    deviceId: "printer-001",
    deviceType: "controller",
    kernelId: KERNEL,
    simulated: opts.simulated ?? false,
  };
  return hashed({
    type: "printer_job_verified",
    timestamp: "2026-08-27T10:05:00.000Z",
    source,
    payload: {
      jobId,
      chainLength: 3,
      headHash: "sha256:aaaa000000000000000000000000000000000000000000000000000000000000",
      tailHash: `sha256:${"0".repeat(64)}`,
      logSource: "cups://printer-001",
      summary: `Printer job ${jobId} completed with 3 hash-chained log entries`,
      // Contract clause (d) [ORACLE] binds commitment.documentHash ==
      // printer_job_verified.payload.documentHash. The print lane must stamp it;
      // this producer does NOT check clause (d) (that is the oracle's verdict).
      documentHash: DOC_HASH,
      ...(opts.simulated ? { mock: true } : {}),
    },
  });
}

/** The full carrier v2 commitment (flat body + hash + signature), @82a30caf §5. */
function makeCommitment(jobId: string) {
  return {
    v: 1 as const,
    jobId,
    kernelId: KERNEL,
    documentHash: DOC_HASH,
    destinationHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    trackingCode: TRACKING,
    shipmentId: "shp_test_0001",
    trackerId: "trk_test_0001",
    carrier: "USPS",
    service: "First",
    labelHash: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    labelCid: "bafkreib0000000000000000000000000000000000000000000000000000000",
    mock: false,
    committedAt: "2026-08-27T09:55:00.000Z",
    hash: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    signature: null,
  };
}

/** A courier_pickup_confirmed event, shaped like buildCarrierEvidenceEvent @82a30caf. */
function makeMailEvent(opts: { jobId?: string; simulated?: boolean } = {}): Promise<EvidenceEvent> {
  const jobId = opts.jobId ?? JOB;
  const source: EvidenceSource = {
    deviceId: `easypost:${TRACKING}`,
    deviceType: "courier_api",
    kernelId: KERNEL,
    simulated: opts.simulated ?? false,
  };
  return hashed({
    type: "courier_pickup_confirmed",
    timestamp: OCCURRED_AT,
    source,
    payload: {
      jobId,
      trackingCode: TRACKING,
      trackerId: "trk_test_0001",
      shipmentId: "shp_test_0001",
      carrier: "USPS",
      trackerStatus: "in_transit",
      statusDetail: "accepted",
      carrierMessage: "Arrived at USPS facility",
      trackingLocation: { city: "San Francisco", state: "CA", country: "US", zip: "94103" },
      providerEventId: "evt_test_0001",
      occurredAt: OCCURRED_AT,
      provider: "easypost",
      providerSignatureHeader: "hmac-sha256-hex=deadbeef",
      providerRawBody: JSON.stringify({ result: { tracking_code: TRACKING, status: "in_transit" } }),
      commitment: makeCommitment(jobId),
      commitmentVerified: true,
    },
  });
}

/** A photo_captured event — the classic wrong closer for the mail leg (§2). */
function makePhotoEvent(opts: { jobId?: string } = {}): Promise<EvidenceEvent> {
  const jobId = opts.jobId ?? JOB;
  const source: EvidenceSource = {
    deviceId: "cam-handoff-1",
    deviceType: "photo-camera",
    kernelId: KERNEL,
    simulated: false,
  };
  return hashed({
    type: "photo_captured",
    timestamp: "2026-08-27T10:06:00.000Z",
    source,
    payload: { jobId, imageHash: "sha256:9999999999999999999999999999999999999999999999999999999999999999" },
  });
}

/** A printer_log_captured event — a legitimate tier-1 corroborating extra (§3). */
function makeLogEvent(opts: { jobId?: string } = {}): Promise<EvidenceEvent> {
  const jobId = opts.jobId ?? JOB;
  const source: EvidenceSource = { deviceId: "printer-001", deviceType: "controller", kernelId: KERNEL };
  return hashed({
    type: "printer_log_captured",
    timestamp: "2026-08-27T10:04:30.000Z",
    source,
    payload: { jobId, entryHash: "sha256:5555555555555555555555555555555555555555555555555555555555555555" },
  });
}

const hexToBytes = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array): string =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

/** Byte-identical reconstruction of makeKernelEd25519Signer (printer-job.ts). */
function makeTestKernelSigner(seed?: Uint8Array) {
  const keyPair = seed && seed.length === 32 ? nacl.sign.keyPair.fromSeed(seed) : nacl.sign.keyPair();
  const publicKeyHex = toHex(keyPair.publicKey);
  const signer = `0x${publicKeyHex.slice(0, 40)}` as Address;
  const signFn = async (bundleHash: string): Promise<Signature> => ({
    signer,
    algorithm: "ed25519",
    value: toHex(nacl.sign.detached(new TextEncoder().encode(bundleHash), keyPair.secretKey)),
  });
  return { signFn, publicKey: keyPair.publicKey };
}

/** Await a function and return the thrown error, or fail if none was thrown. */
async function rejection(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to reject, but it resolved");
}

async function expectRejectCode(fn: () => Promise<unknown>, code: CompositeRejectionCode): Promise<void> {
  const err = await rejection(fn);
  expect(err).toBeInstanceOf(CompositeBundleError);
  expect((err as CompositeBundleError).code).toBe(code);
}

// ─── positive: one bundle, both legs, one root, one signature ────────────────

describe("assembleCompositePrintMailBundle — the happy path (ONE bundle, ONE root)", () => {
  it("carries BOTH legs under ONE bundleHash = hashBundle(events)", async () => {
    const printEvent = await makePrintEvent();
    const mailEvent = await makeMailEvent();

    const bundle = await assembleCompositePrintMailBundle({ jobId: JOB, kernelId: KERNEL, printEvent, mailEvent });

    expect(bundle.events).toHaveLength(2);
    expect(bundle.events.map((e) => e.type).sort()).toEqual(
      [COMPOSITE_MAIL_EVENT_TYPE, COMPOSITE_PRINT_EVENT_TYPE].sort(),
    );
    // ONE root over BOTH events (option (a): NOT a separately-signed mail leg).
    expect(bundle.bundleHash).toBe(await hashBundle([printEvent, mailEvent]));
    expect(bundle.jobId).toBe(JOB);
    expect(bundle.kernelId).toBe(KERNEL);
    // Print-and-mail defaults to tier 0 (the G-code ladder does not apply, §3).
    expect(bundle.assuranceTier).toBe(DEFAULT_COMPOSITE_TIER);
    expect(bundle.stepId).toBe(JOB);
    // A ready-to-sign bundle has NO signature yet.
    expect((bundle as Record<string, unknown>).kernelSignature).toBeUndefined();
  });

  it("preserves the pulled events verbatim (id + hash intact — never re-emits)", async () => {
    const printEvent = await makePrintEvent();
    const mailEvent = await makeMailEvent();

    const bundle = await assembleCompositePrintMailBundle({ jobId: JOB, kernelId: KERNEL, printEvent, mailEvent });

    const outPrint = bundle.events.find((e) => e.type === COMPOSITE_PRINT_EVENT_TYPE)!;
    const outMail = bundle.events.find((e) => e.type === COMPOSITE_MAIL_EVENT_TYPE)!;
    expect(outPrint.id).toBe(printEvent.id);
    expect(outPrint.hash).toBe(printEvent.hash);
    expect(outMail.id).toBe(mailEvent.id);
    expect(outMail.hash).toBe(mailEvent.hash);
  });

  it("bundleHash is order-independent (hashBundle sorts the event hashes)", async () => {
    const printEvent = await makePrintEvent();
    const mailEvent = await makeMailEvent();

    const a = await assembleCompositePrintMailBundle({ jobId: JOB, kernelId: KERNEL, printEvent, mailEvent });
    const b = await assembleCompositePrintMailBundle({
      jobId: JOB,
      kernelId: KERNEL,
      printEvent: mailEvent as unknown as EvidenceEvent, // deliberately swapped slots…
      mailEvent: printEvent as unknown as EvidenceEvent,
    }).catch(() => null); // …which is REJECTED by type (proving slots are typed, not positional)
    expect(b).toBeNull();
    // Same legs, correct slots → same root regardless of internal array order.
    expect(a.bundleHash).toBe(await hashBundle([mailEvent, printEvent]));
  });

  it("folds tier≥1 corroborating events into the SAME one root (§3)", async () => {
    const printEvent = await makePrintEvent();
    const mailEvent = await makeMailEvent();
    const logEvent = await makeLogEvent();

    const bundle = await assembleCompositePrintMailBundle({
      jobId: JOB,
      kernelId: KERNEL,
      printEvent,
      mailEvent,
      extraEvents: [logEvent],
      assuranceTier: 1,
    });

    expect(bundle.events).toHaveLength(3);
    expect(bundle.assuranceTier).toBe(1);
    expect(bundle.bundleHash).toBe(await hashBundle([printEvent, mailEvent, logEvent]));
    // The extra never substitutes for a required leg — both legs still present.
    expect(bundle.events.some((e) => e.type === COMPOSITE_MAIL_EVENT_TYPE)).toBe(true);
  });

  it("honours injected bundleId / createdAt / stepId (deterministic assembly)", async () => {
    const bundle = await assembleCompositePrintMailBundle({
      jobId: JOB,
      kernelId: KERNEL,
      printEvent: await makePrintEvent(),
      mailEvent: await makeMailEvent(),
      bundleId: "bun_fixed_1",
      createdAt: "2026-08-27T11:00:00.000Z",
      stepId: "step-7",
    });
    expect(bundle.id).toBe("bun_fixed_1");
    expect(bundle.createdAt).toBe("2026-08-27T11:00:00.000Z");
    expect(bundle.stepId).toBe("step-7");
  });
});

describe("signCompositePrintMailBundle — ONE kernelSignature over the ONE root", () => {
  it("produces a standard EvidenceBundle whose signature verifies (ready for the kernel signer)", async () => {
    const printEvent = await makePrintEvent();
    const mailEvent = await makeMailEvent();
    const kernel = makeTestKernelSigner(new Uint8Array(32).fill(7));
    const signFn = vi.fn(kernel.signFn);

    const bundle = await signCompositePrintMailBundle({ jobId: JOB, kernelId: KERNEL, printEvent, mailEvent }, signFn);

    // Signed exactly once, over bundleHash.
    expect(signFn).toHaveBeenCalledTimes(1);
    expect(signFn).toHaveBeenCalledWith(bundle.bundleHash);
    // bundleHash still covers the events…
    expect(await verifyBundleHash(bundle)).toBe(true);
    // …and the Ed25519 signature verifies over bundleHash under the kernel key.
    expect(bundle.kernelSignature.algorithm).toBe("ed25519");
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(bundle.bundleHash),
      hexToBytes(bundle.kernelSignature.value),
      kernel.publicKey,
    );
    expect(ok).toBe(true);
    // A signed composite passes structural verification.
    expect(await verifyCompositePrintMailBundle(bundle)).toEqual({ ok: true });
  });
});

// ─── NEGATIVE CONTROL 1: no mail leg ⇒ not assemblable AND not valid ─────────

describe("NEGATIVE CONTROL 1 — a bundle missing the carrier leg is neither assemblable nor valid", () => {
  it("assemble with no mail leg fails closed (missing_mail_leg) — no scan, no release", async () => {
    await expectRejectCode(
      async () =>
        assembleCompositePrintMailBundle({
          jobId: JOB,
          kernelId: KERNEL,
          printEvent: await makePrintEvent(),
          mailEvent: null,
        }),
      "missing_mail_leg",
    );
  });

  it("a print-only bundle does NOT verify as a valid composite", async () => {
    const printEvent = await makePrintEvent();
    const bogusBundle = {
      jobId: JOB,
      events: [printEvent],
      bundleHash: await hashBundle([printEvent]),
    };
    const v = await verifyCompositePrintMailBundle(bogusBundle);
    expect(v).toEqual({ ok: false, code: "missing_mail_leg", message: expect.any(String) });
  });

  it("assemble with no print leg fails closed (missing_print_leg)", async () => {
    await expectRejectCode(
      async () =>
        assembleCompositePrintMailBundle({
          jobId: JOB,
          kernelId: KERNEL,
          printEvent: undefined,
          mailEvent: await makeMailEvent(),
        }),
      "missing_print_leg",
    );
  });
});

// ─── NEGATIVE CONTROL 2: anti-swap (mail jobId != print jobId) ───────────────

describe("NEGATIVE CONTROL 2 — a carrier scan for a different job is rejected (anti-swap)", () => {
  it("rejects when the mail leg's jobId differs from the print leg's (jobid_swap)", async () => {
    const printEvent = await makePrintEvent({ jobId: JOB });
    const mailEvent = await makeMailEvent({ jobId: "job-SOMEONE-ELSE" });
    await expectRejectCode(
      () => assembleCompositePrintMailBundle({ jobId: JOB, kernelId: KERNEL, printEvent, mailEvent }),
      "jobid_swap",
    );
  });

  it("rejects when both legs agree but do NOT bind the funded jobId (print_jobid_mismatch)", async () => {
    const printEvent = await makePrintEvent({ jobId: "job-X" });
    const mailEvent = await makeMailEvent({ jobId: "job-X" });
    await expectRejectCode(
      () => assembleCompositePrintMailBundle({ jobId: "job-FUNDED-Y", kernelId: KERNEL, printEvent, mailEvent }),
      "print_jobid_mismatch",
    );
  });

  it("rejects a carrier leg with no jobId in its payload (mail_jobid_missing)", async () => {
    const printEvent = await makePrintEvent();
    const mailEventNoJob = await hashed({
      type: "courier_pickup_confirmed",
      timestamp: OCCURRED_AT,
      source: { deviceId: `easypost:${TRACKING}`, deviceType: "courier_api", kernelId: KERNEL },
      payload: { trackingCode: TRACKING, commitment: makeCommitment(JOB) }, // jobId omitted
    });
    await expectRejectCode(
      () => assembleCompositePrintMailBundle({ jobId: JOB, kernelId: KERNEL, printEvent, mailEvent: mailEventNoJob }),
      "mail_jobid_missing",
    );
  });
});

// ─── NEGATIVE CONTROL 3: a photo can never close the mail leg ────────────────

describe("NEGATIVE CONTROL 3 — a photo can never substitute for courier_pickup_confirmed", () => {
  it("rejects a photo_captured in the mail slot (wrong_mail_event_type) even with the right jobId", async () => {
    const printEvent = await makePrintEvent();
    const photoAsMail = await makePhotoEvent({ jobId: JOB });
    await expectRejectCode(
      () =>
        assembleCompositePrintMailBundle({
          jobId: JOB,
          kernelId: KERNEL,
          printEvent,
          mailEvent: photoAsMail,
        }),
      "wrong_mail_event_type",
    );
  });

  it("a bundle whose only 'mail-ish' event is a photo does NOT verify (missing_mail_leg)", async () => {
    const printEvent = await makePrintEvent();
    const photo = await makePhotoEvent({ jobId: JOB });
    const bundle = {
      jobId: JOB,
      events: [printEvent, photo],
      bundleHash: await hashBundle([printEvent, photo]),
    };
    const v = await verifyCompositePrintMailBundle(bundle);
    expect(v).toEqual({ ok: false, code: "missing_mail_leg", message: expect.any(String) });
  });

  it("rejects courier_delivery_confirmed in the mail slot — delivery does not close pickup (§0(b))", async () => {
    const printEvent = await makePrintEvent();
    const delivery = await hashed({
      type: "courier_delivery_confirmed",
      timestamp: "2026-08-28T14:00:00.000Z",
      source: { deviceId: `easypost:${TRACKING}`, deviceType: "courier_api", kernelId: KERNEL },
      payload: { jobId: JOB, trackingCode: TRACKING, commitment: makeCommitment(JOB) },
    });
    await expectRejectCode(
      () => assembleCompositePrintMailBundle({ jobId: JOB, kernelId: KERNEL, printEvent, mailEvent: delivery }),
      "wrong_mail_event_type",
    );
  });
});

// ─── other fail-closed guards ───────────────────────────────────────────────

describe("integrity + type guards", () => {
  it("rejects a print leg that is not printer_job_verified (e.g. execution_completed)", async () => {
    const notPrintVerified = await hashed({
      type: "execution_completed",
      timestamp: "2026-08-27T10:05:00.000Z",
      source: { deviceId: "printer-001", deviceType: "controller", kernelId: KERNEL },
      payload: { jobId: JOB, totalPages: 2 },
    });
    await expectRejectCode(
      async () =>
        assembleCompositePrintMailBundle({
          jobId: JOB,
          kernelId: KERNEL,
          printEvent: notPrintVerified,
          mailEvent: await makeMailEvent(),
        }),
      "wrong_print_event_type",
    );
  });

  it("rejects a tampered mail leg whose hash no longer covers its payload", async () => {
    const mailEvent = await makeMailEvent();
    // Mutate the payload AFTER hashing — the self-declared hash is now stale.
    const tampered: EvidenceEvent = {
      ...mailEvent,
      payload: { ...mailEvent.payload, trackingCode: "TAMPERED-CODE" },
    };
    await expectRejectCode(
      async () =>
        assembleCompositePrintMailBundle({
          jobId: JOB,
          kernelId: KERNEL,
          printEvent: await makePrintEvent(),
          mailEvent: tampered,
        }),
      "mail_event_hash_invalid",
    );
  });

  it("rejects a corroborating extra event that binds a different jobId", async () => {
    await expectRejectCode(
      async () =>
        assembleCompositePrintMailBundle({
          jobId: JOB,
          kernelId: KERNEL,
          printEvent: await makePrintEvent(),
          mailEvent: await makeMailEvent(),
          extraEvents: [await makeLogEvent({ jobId: "job-OTHER" })],
        }),
      "extra_event_jobid_mismatch",
    );
  });

  it("detects a bundle whose bundleHash does not cover its events (bundle_hash_mismatch)", async () => {
    const printEvent = await makePrintEvent();
    const mailEvent = await makeMailEvent();
    const v = await verifyCompositePrintMailBundle({
      jobId: JOB,
      events: [printEvent, mailEvent],
      bundleHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("bundle_hash_mismatch");
  });
});

// ─── simulated evidence is carried, NOT judged (scope boundary) ──────────────

describe("scope boundary — simulated evidence is assembled, the oracle disputes it (not this producer)", () => {
  it("assembles a fully-simulated composite (source.simulated=true) — verdict is the oracle's (§4)", async () => {
    const printEvent = await makePrintEvent({ simulated: true });
    const mailEvent = await makeMailEvent({ simulated: true });
    const bundle = await assembleCompositePrintMailBundle({ jobId: JOB, kernelId: KERNEL, printEvent, mailEvent });
    // The producer does NOT gate on simulated — it faithfully bundles both legs
    // so the oracle can apply the `simulated==true → dispute` rule downstream.
    expect(bundle.events).toHaveLength(2);
    expect(await verifyCompositePrintMailBundle(bundle)).toEqual({ ok: true });
  });
});
