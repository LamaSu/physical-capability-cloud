/**
 * N80 (rehearsal R0 G3): what the operator relay commits for a pushed evidence body. The stored
 * hash is a hash the stored content reproduces, or a digest a device signed; never `sha256-<id>`,
 * and never a hash of content the gateway does not keep (cross-family review E4, round 2).
 */
import { describe, it, expect } from "vitest";
import { canonicalize, hashBundle, hashEvent, sha256, type EvidenceEvent } from "@pcc/spec";
import { commitRelayEvidence } from "../services/relay-evidence-commitment.js";
import type { CapturedDeviceBundle } from "../services/device-evidence-settlement.js";

const TAGGED = /^sha256:[0-9a-f]{64}$/;
/** The job the evidence is filed under (from the job row). */
const J = { jobId: "job-1", kernelId: "kernel-1" };
const source = { deviceId: "reader-1", deviceType: "plate_reader", kernelId: "kernel-1" };
const loEv = (type: string, n: number) => ({ type, timestamp: `2026-09-29T22:35:0${n}.000Z`, source, payload: { n, jobId: "job-1" } });

/** The body the rehearsal's operator daemon pushed: a device document, no LO-EV events. */
const rehearsalBody = {
  jobId: "job-af6d5056-0af",
  kernelId: "kernel-1",
  deviceId: "SIM-0001",
  run: { runId: "run-000003", state: "completed", result: { wavelengthNm: 450, readings: { A1: 0.412 } } },
  log: { runId: "run-000003", entries: [{ seq: 1, at: "2026-09-29T22:35:40Z", event: "read", detail: {} }] },
};

/** pcc-node's build_evidence_bundle on master: events with no source and no hash. */
const pccNodeBody = {
  jobId: "job-1",
  deviceId: "dev-1",
  result: { ok: true },
  events: [{ type: "job_started", timestamp: "2026-09-29T22:35:01Z", payload: {} }, { type: "execution_completed", timestamp: "2026-09-29T22:35:02Z", payload: {} }],
};

function captured(bundleHash: string): CapturedDeviceBundle {
  return { bundleHash, kernelSignature: { signer: "0xabc", algorithm: "ed25519", value: "sig" }, assuranceTier: 0 } as CapturedDeviceBundle;
}

describe("commitRelayEvidence (N80: never a made-up hash)", () => {
  it("LO-EV events: every hash is recomputed, the bundle hash is hashBundle over them, and the events are kept", async () => {
    const events = [loEv("execution_completed", 1), loEv("cv_inspection_result", 2)];
    const r = await commitRelayEvidence({ events }, null, J);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hashes = await Promise.all(events.map((e) => hashEvent(e as Omit<EvidenceEvent, "hash" | "id">)));
    expect(r.commitment.hashModel).toBe("event_bundle_hash");
    expect(r.commitment.events.map((e) => e.hash)).toEqual(hashes);
    expect(r.commitment.bundleHash).toBe(await hashBundle(r.commitment.events as unknown as EvidenceEvent[]));
  });

  it("accepts supplied hashes and a supplied bundleHash that reproduce, also under a { bundle } wrapper", async () => {
    const raw = [loEv("execution_completed", 1)];
    const events = await Promise.all(raw.map(async (e) => ({ ...e, hash: await hashEvent(e as Omit<EvidenceEvent, "hash" | "id">) })));
    const bundleHash = await hashBundle(events as unknown as EvidenceEvent[]);
    const r = await commitRelayEvidence({ bundle: { events, bundleHash } }, null, J);
    expect(r.ok && r.commitment.bundleHash).toBe(bundleHash);
  });

  it("NEGATIVE: a supplied event hash that does not reproduce is refused, with its index", async () => {
    const events = [loEv("execution_completed", 1), { ...loEv("cv_inspection_result", 2), hash: `sha256:${"ab".repeat(32)}` }];
    expect(await commitRelayEvidence({ events }, null, J)).toEqual({ ok: false, refusal: { error: "event_hash_mismatch", eventIndex: 1 } });
  });

  it("NEGATIVE: a supplied bundleHash that the events do not reproduce is refused", async () => {
    const r = await commitRelayEvidence({ events: [loEv("execution_completed", 1)], bundleHash: `sha256:${"cd".repeat(32)}` }, null, J);
    expect(r).toEqual({ ok: false, refusal: { error: "bundle_hash_mismatch" } });
  });

  it("a device-signed document naming this job and kernel is committed by its recomputed hash (adk #4322)", async () => {
    const doc = { jobId: J.jobId, kernelId: J.kernelId, operation: "plate_read", record: { A1: 0.412 }, logChain: [] };
    const digest = await sha256(canonicalize(doc));
    const r = await commitRelayEvidence({ bundle: { ...doc, bundleHash: digest } }, captured(digest), J);
    expect(r).toEqual({ ok: true, commitment: { bundleHash: digest, hashModel: "device_signed_document", events: [] } });
  });

  it("NEGATIVE (adk #4322): a bare device digest names no job, so it is refused", async () => {
    const digest = `sha256:${"ef".repeat(32)}`;
    for (const body of [{ bundleHash: digest }, { bundle: { bundleHash: digest, assuranceTier: 2, signerPublicKey: "0xabc" } }]) {
      expect(await commitRelayEvidence(body, captured(digest), J)).toEqual({ ok: false, refusal: { error: "evidence_not_bound" } });
    }
  });

  it("NEGATIVE (adk #4322): a signed document for another job, another kernel, or none is refused", async () => {
    const make = async (doc: Record<string, unknown>) => ({ body: { bundle: { ...doc, bundleHash: await sha256(canonicalize(doc)) } }, digest: await sha256(canonicalize(doc)) });
    const cases: Array<[Record<string, unknown>, string, typeof J | { jobId: string; kernelId: string | null }]> = [
      [{ jobId: "job-2", kernelId: J.kernelId, record: {} }, "job_mismatch", J],
      [{ kernelId: J.kernelId, record: {} }, "job_mismatch", J],
      [{ jobId: J.jobId, kernelId: "kernel-2", record: {} }, "kernel_mismatch", J],
      [{ jobId: J.jobId, record: {} }, "kernel_mismatch", J],
      [{ jobId: J.jobId, kernelId: J.kernelId, record: {} }, "kernel_mismatch", { jobId: J.jobId, kernelId: null }],
    ];
    for (const [doc, error, job] of cases) {
      const { body, digest } = await make(doc);
      expect(await commitRelayEvidence(body, captured(digest), job), JSON.stringify(doc)).toEqual({ ok: false, refusal: { error } });
    }
  });

  it("NEGATIVE (adk #4322): a document edited after signing, or signed under the `signature` alias, does not reproduce its digest", async () => {
    const doc = { jobId: J.jobId, kernelId: J.kernelId, record: { A1: 0.412 } };
    const digest = await sha256(canonicalize(doc));
    const edited = { bundle: { ...doc, record: { A1: 0.999 }, bundleHash: digest } };
    expect(await commitRelayEvidence(edited, captured(digest), J)).toEqual({ ok: false, refusal: { error: "bundle_hash_mismatch" } });
    const alias = { bundle: { ...doc, bundleHash: digest, signature: { signer: "0xabc", algorithm: "ed25519", value: "sig" } } };
    expect(await commitRelayEvidence(alias, captured(digest), J)).toEqual({ ok: false, refusal: { error: "bundle_hash_mismatch" } });
  });

  it("NEGATIVE: a signed document whose digest is not a canonical tagged digest is refused", async () => {
    const doc = { jobId: J.jobId, kernelId: J.kernelId, record: {} };
    for (const bad of [`sha256-ev-1234`, `0x${"ef".repeat(32)}`, `sha256:${"EF".repeat(32)}`]) {
      expect(await commitRelayEvidence({ bundle: { ...doc, bundleHash: bad } }, captured(bad), J), bad).toEqual({ ok: false, refusal: { error: "bundle_hash_malformed" } });
    }
  });

  it("NEGATIVE: a device-signed digest that its own LO-EV events do not reproduce is refused", async () => {
    const digest = `sha256:${"ef".repeat(32)}`;
    const r = await commitRelayEvidence({ events: [loEv("execution_completed", 1)], bundleHash: digest }, captured(digest), J);
    expect(r).toEqual({ ok: false, refusal: { error: "bundle_hash_mismatch" } });
  });

  it("every accepted body is committed by a canonical tagged digest", async () => {
    const digest = `sha256:${"ef".repeat(32)}`;
    const doc = { jobId: J.jobId, kernelId: J.kernelId, record: { ok: true } };
    const docDigest = await sha256(canonicalize(doc));
    const accepted = [await commitRelayEvidence({ events: [loEv("execution_completed", 1)] }, null, J), await commitRelayEvidence({ bundle: { ...doc, bundleHash: docDigest } }, captured(docDigest), J)];
    for (const r of accepted) expect(r.ok && r.commitment.bundleHash).toMatch(TAGGED);
  });
});

describe("commitRelayEvidence refuses what it cannot store reproducibly (cross-family review E4, round 2)", () => {
  it("NEGATIVE (E4 finding 1): a document with no LO-EV events and no device signature is refused, never hashed and dropped", async () => {
    for (const body of [rehearsalBody, { printed: true, returncode: 0 }]) {
      expect(await commitRelayEvidence(body, null, J)).toEqual({ ok: false, refusal: { error: "evidence_not_lo_ev" } });
    }
  });

  it("NEGATIVE (E4 finding 3): events that are present but not all LO-EV are malformed, never a quieter model", async () => {
    expect(await commitRelayEvidence(pccNodeBody, null, J)).toEqual({ ok: false, refusal: { error: "events_malformed", eventIndex: 0 } });
    const mixed = { events: [loEv("execution_completed", 1), { type: "execution_completed", timestamp: "2026-09-29T22:35:02Z" }] };
    expect(await commitRelayEvidence(mixed, null, J)).toEqual({ ok: false, refusal: { error: "events_malformed", eventIndex: 1 } });
    expect(await commitRelayEvidence({ events: [] }, null, J)).toEqual({ ok: false, refusal: { error: "events_malformed", eventIndex: null } });
    expect(await commitRelayEvidence({ events: "not-a-list" }, null, J)).toEqual({ ok: false, refusal: { error: "events_malformed", eventIndex: null } });
  });

  it("NEGATIVE (E4 finding 3): a device signature over events without a source is malformed, not a device-signed digest", async () => {
    const digest = `sha256:${"ef".repeat(32)}`;
    const body = { events: [{ type: "execution_completed", timestamp: "2026-09-29T22:35:01Z" }], bundleHash: digest };
    expect(await commitRelayEvidence(body, captured(digest), J)).toEqual({ ok: false, refusal: { error: "events_malformed", eventIndex: 0 } });
  });

  it("NEGATIVE (E4 finding 3): commitment fields both at the root and under `bundle` are ambiguous", async () => {
    for (const field of ["events", "bundleHash", "kernelSignature", "signature"]) {
      const body = { bundle: { events: [loEv("execution_completed", 1)] }, [field]: field === "events" ? [] : `sha256:${"ab".repeat(32)}` };
      expect(await commitRelayEvidence(body, null, J), field).toEqual({ ok: false, refusal: { error: "ambiguous_envelope" } });
    }
  });

  it("NEGATIVE (E4 finding 3): a `bundle` that is present but not an object is malformed", async () => {
    for (const bundle of ["x", 1, null, [loEv("execution_completed", 1)]]) {
      const r = await commitRelayEvidence({ bundle, events: [loEv("execution_completed", 1)] }, null, J);
      expect(r, JSON.stringify(bundle)).toEqual({ ok: false, refusal: { error: "malformed_envelope" } });
    }
  });
});

describe("an event bundle is bound to the job and kernel in its hashed content (cross-family review E4b)", () => {
  /** LO-EV events naming `jobId` in their payload and `kernelId` in their source (LO-EV-9 rules 5 and 6). */
  const bound = (jobId: string, kernelId: string) => [
    { type: "execution_started", timestamp: "2026-09-29T22:35:01.000Z", source: { deviceId: "reader-1", deviceType: "plate_reader", kernelId }, payload: { jobId, kernelId } },
    { type: "execution_completed", timestamp: "2026-09-29T22:35:02.000Z", source: { deviceId: "reader-1", deviceType: "plate_reader", kernelId }, payload: { jobId } },
  ];

  it("NEGATIVE (the reviewer's repro): job A's signed event bundle cannot be filed under job B", async () => {
    const eventsForJobA = bound("job-A", "kernel-1");
    const hash = await hashBundle(await Promise.all(eventsForJobA.map(async (e) => ({ ...e, hash: await hashEvent(e as Omit<EvidenceEvent, "hash" | "id">) }))) as unknown as EvidenceEvent[]);
    const result = await commitRelayEvidence({ jobId: "job-A", events: eventsForJobA, bundleHash: hash }, captured(hash), { jobId: "job-B", kernelId: "kernel-1" });
    expect(result).toMatchObject({ ok: false, refusal: { error: "job_mismatch" } });
  });

  it("NEGATIVE: an event naming another kernel, or none, is refused", async () => {
    const J1 = { jobId: "job-1", kernelId: "kernel-1" };
    expect(await commitRelayEvidence({ events: bound("job-1", "kernel-2") }, null, J1)).toMatchObject({ ok: false, refusal: { error: "kernel_mismatch" } });
    const noSourceKernel = bound("job-1", "kernel-1").map((e) => ({ ...e, source: { deviceId: "reader-1", deviceType: "plate_reader" } }));
    expect(await commitRelayEvidence({ events: noSourceKernel }, null, J1)).toMatchObject({ ok: false, refusal: { error: "kernel_mismatch" } });
    const otherPayloadKernel = bound("job-1", "kernel-1").map((e, i) => (i === 0 ? { ...e, payload: { jobId: "job-1", kernelId: "kernel-2" } } : e));
    expect(await commitRelayEvidence({ events: otherPayloadKernel }, null, J1)).toMatchObject({ ok: false, refusal: { error: "kernel_mismatch" } });
    expect(await commitRelayEvidence({ events: bound("job-1", "kernel-1") }, null, { jobId: "job-1", kernelId: null })).toMatchObject({ ok: false, refusal: { error: "kernel_mismatch" } });
    // A job without a kernel binds nothing, even when the events' kernel is null too.
    const nullKernel = bound("job-1", "kernel-1").map((e) => ({ ...e, source: { deviceId: "reader-1", deviceType: "plate_reader", kernelId: null }, payload: { jobId: "job-1" } }));
    expect(await commitRelayEvidence({ events: nullKernel }, null, { jobId: "job-1", kernelId: null })).toMatchObject({ ok: false, refusal: { error: "kernel_mismatch" } });
  });

  it("NEGATIVE: an event that commits no job, or another job, is refused", async () => {
    const J1 = { jobId: "job-1", kernelId: "kernel-1" };
    const noJob = bound("job-1", "kernel-1").map((e) => ({ ...e, payload: {} }));
    expect(await commitRelayEvidence({ events: noJob }, null, J1)).toMatchObject({ ok: false, refusal: { error: "job_mismatch" } });
    expect(await commitRelayEvidence({ events: bound("job-2", "kernel-1") }, null, J1)).toMatchObject({ ok: false, refusal: { error: "job_mismatch" } });
  });

  it("an event bundle whose every event names this job and kernel is committed", async () => {
    const r = await commitRelayEvidence({ events: bound("job-1", "kernel-1") }, null, { jobId: "job-1", kernelId: "kernel-1" });
    expect(r).toMatchObject({ ok: true, commitment: { hashModel: "event_bundle_hash" } });
  });
});
