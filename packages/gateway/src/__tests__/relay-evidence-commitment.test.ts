/**
 * N80 (rehearsal R0 G3): what the operator relay commits for a pushed evidence body. The stored
 * hash is a hash the stored content reproduces, or a digest a device signed; never `sha256-<id>`.
 */
import { describe, it, expect } from "vitest";
import { canonicalize, hashBundle, hashEvent, sha256, type EvidenceEvent } from "@pcc/spec";
import { commitRelayEvidence } from "../services/relay-evidence-commitment.js";
import type { CapturedDeviceBundle } from "../services/device-evidence-settlement.js";

const TAGGED = /^sha256:[0-9a-f]{64}$/;
const source = { deviceId: "reader-1", deviceType: "plate_reader", kernelId: "kernel-1" };
const loEv = (type: string, n: number) => ({ type, timestamp: `2026-09-29T22:35:0${n}.000Z`, source, payload: { n } });

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
  it("a device document is committed by the sha256 of its canonical JSON, with no events", async () => {
    const r = await commitRelayEvidence(rehearsalBody, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.commitment).toEqual({ bundleHash: await sha256(canonicalize(rehearsalBody)), hashModel: "document_sha256", events: [] });
    expect(r.commitment.bundleHash).toMatch(TAGGED);
  });

  it("pcc-node's events without a source are not LO-EV events: the document model, nothing stored as events", async () => {
    const r = await commitRelayEvidence(pccNodeBody, null);
    expect(r.ok && r.commitment.hashModel).toBe("document_sha256");
    expect(r.ok && r.commitment.events).toEqual([]);
  });

  it("LO-EV events: every hash is recomputed, the bundle hash is hashBundle over them, and the events are kept", async () => {
    const events = [loEv("execution_completed", 1), loEv("cv_inspection_result", 2)];
    const r = await commitRelayEvidence({ events }, null);
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
    const r = await commitRelayEvidence({ bundle: { events, bundleHash } }, null);
    expect(r.ok && r.commitment.bundleHash).toBe(bundleHash);
  });

  it("NEGATIVE: a supplied event hash that does not reproduce is refused, with its index", async () => {
    const events = [loEv("execution_completed", 1), { ...loEv("cv_inspection_result", 2), hash: `sha256:${"ab".repeat(32)}` }];
    expect(await commitRelayEvidence({ events }, null)).toEqual({ ok: false, refusal: { error: "event_hash_mismatch", eventIndex: 1 } });
  });

  it("NEGATIVE: a supplied bundleHash that the events do not reproduce is refused", async () => {
    const r = await commitRelayEvidence({ events: [loEv("execution_completed", 1)], bundleHash: `sha256:${"cd".repeat(32)}` }, null);
    expect(r).toEqual({ ok: false, refusal: { error: "bundle_hash_mismatch" } });
  });

  it("a device-signed bundle without LO-EV events keeps the digest the device signed", async () => {
    const digest = `sha256:${"ef".repeat(32)}`;
    const r = await commitRelayEvidence({ bundleHash: digest }, captured(digest));
    expect(r).toEqual({ ok: true, commitment: { bundleHash: digest, hashModel: "device_signed_digest", events: [] } });
  });

  it("NEGATIVE: a device-signed digest that is not a canonical tagged digest is refused", async () => {
    for (const bad of [`sha256-ev-1234`, `0x${"ef".repeat(32)}`, `sha256:${"EF".repeat(32)}`]) {
      expect(await commitRelayEvidence({ bundleHash: bad }, captured(bad)), bad).toEqual({ ok: false, refusal: { error: "bundle_hash_malformed" } });
    }
  });

  it("NEGATIVE: a device-signed digest that its own LO-EV events do not reproduce is refused", async () => {
    const digest = `sha256:${"ef".repeat(32)}`;
    const r = await commitRelayEvidence({ events: [loEv("execution_completed", 1)], bundleHash: digest }, captured(digest));
    expect(r).toEqual({ ok: false, refusal: { error: "bundle_hash_mismatch" } });
  });

  it("no accepted body is ever committed by a hash made from an id", async () => {
    for (const body of [rehearsalBody, pccNodeBody, { printed: true, returncode: 0 }, { events: [loEv("execution_completed", 1)] }]) {
      const r = await commitRelayEvidence(body, null);
      expect(r.ok && r.commitment.bundleHash).toMatch(TAGGED);
    }
  });
});
