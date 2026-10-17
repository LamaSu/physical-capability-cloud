import { randomBytes } from "node:crypto";
import { hashBundle, hashEvent, type EvidenceEvent } from "@pcc/spec";
import { describe, expect, it, vi } from "vitest";
import { createGatewayClient, type RelayEvidenceBundle } from "../src/gateway-client.js";

const jobId = "job:gateway-parity";
const kernelId = "kernel:gateway-parity";
const baseUrl = "https://gateway.example.test";
const apiKey = ["pcc", "test", randomBytes(24).toString("hex")].join("_");
const timestamp = "2026-10-12T12:00:00.000Z";

type GatewayCommitmentResult = {
  ok: true;
  commitment: { bundleHash: string; hashModel: "event_bundle_hash" | "device_signed_document"; events: unknown[] };
} | { ok: false; refusal: { error: string; eventIndex?: number | null } };
interface GatewayEvidenceCommitter {
  commitRelayEvidence(evidence: unknown, captured: null, job: { jobId: string; kernelId: string | null }): Promise<GatewayCommitmentResult>;
}
// Like operator-signing.test.ts, keep the gateway dependency runtime-only so
// print-host's test tsc does not pull gateway source beyond its rootDir.
async function gatewayEvidenceCommitter(): Promise<GatewayEvidenceCommitter> {
  const modulePath = "../../gateway/src/services/relay-evidence-commitment.ts";
  return await import(modulePath) as GatewayEvidenceCommitter;
}

async function realBundle(): Promise<RelayEvidenceBundle> {
  const raw: Omit<EvidenceEvent, "id" | "hash">[] = [
    {
      type: "execution_started", timestamp,
      source: { deviceId: "printer:parity", deviceType: "controller", kernelId },
      payload: { jobId, kernelId, progress: 0 },
    },
    {
      type: "execution_completed", timestamp: "2026-10-12T12:01:00.000Z",
      source: { deviceId: "printer:parity", deviceType: "controller", kernelId },
      payload: { jobId, kernelId, progress: 100 },
    },
  ];
  const events = await Promise.all(raw.map(async (event, index) => ({
    ...event, id: `event:parity:${index}`, hash: await hashEvent(event),
  })));
  return { events, bundleHash: await hashBundle(events) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("gateway evidence commitment parity", () => {
  it("sends the tagged bundleHash unchanged and accepts the gateway's exact stored receipt", async () => {
    const { commitRelayEvidence } = await gatewayEvidenceCommitter();
    const bundle = await realBundle();
    let captured: { jobId: string; kernelId: string; evidence: RelayEvidenceBundle } | undefined;
    let committed: GatewayCommitmentResult | undefined;
    let replyBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body));
      committed = await commitRelayEvidence(captured!.evidence, null, { jobId, kernelId });
      if (!committed.ok) return json({ ...committed.refusal, stored: false, jobId }, 422);
      const { bundleHash, hashModel, events } = committed.commitment;
      // packages/gateway/src/routes/operator-relay.ts returns these fields directly
      // from the stored commitment; the tagged bundleHash needs no added prefix.
      replyBody = {
        stored: true, jobId, bundleId: "bundle:gateway-parity",
        contentHash: bundleHash, hashModel, eventsStored: events.length,
        deviceSigned: false, signatureVerified: false, timestamp,
      };
      return json(replyBody);
    });
    const client = createGatewayClient({ baseUrl, apiKey, kernelId, fetchImpl });
    const result = await client.postRelayEvidence(jobId, bundle);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(captured).toEqual({ jobId, kernelId, evidence: bundle });
    expect(captured!.evidence.bundleHash).toBe(bundle.bundleHash);
    expect(bundle.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(committed).toMatchObject({ ok: true, commitment: {
      bundleHash: bundle.bundleHash, hashModel: "event_bundle_hash",
    } });
    if (!committed?.ok) throw new Error("gateway refused the canonical bundle");
    expect(committed.commitment.events).toHaveLength(bundle.events.length);
    expect(replyBody!.contentHash).toBe(committed.commitment.bundleHash);
    expect(replyBody!.hashModel).toBe(committed.commitment.hashModel);
    expect(result).toEqual({ ok: true, value: {
      jobId, contentHash: bundle.bundleHash, hashModel: "event_bundle_hash",
    } });
  });

  it("the client sends a payload changed after hashing and the gateway refuses event_hash_mismatch", async () => {
    const { commitRelayEvidence } = await gatewayEvidenceCommitter();
    const bundle = await realBundle();
    bundle.events[0]!.payload.progress = 50;
    let capturedEvidence: RelayEvidenceBundle | undefined;
    let committed: GatewayCommitmentResult | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const captured = JSON.parse(String(init?.body)) as { evidence: RelayEvidenceBundle };
      capturedEvidence = captured.evidence;
      committed = await commitRelayEvidence(captured.evidence, null, { jobId, kernelId });
      if (!committed.ok) return json({ ...committed.refusal, stored: false, jobId }, 422);
      return json({ stored: true, jobId, contentHash: committed.commitment.bundleHash, hashModel: committed.commitment.hashModel });
    });
    const client = createGatewayClient({ baseUrl, apiKey, kernelId, fetchImpl });
    const result = await client.postRelayEvidence(jobId, bundle);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(capturedEvidence).toEqual(bundle);
    expect(committed).toEqual({ ok: false, refusal: { error: "event_hash_mismatch", eventIndex: 0 } });
    expect(result).toEqual({ ok: false, code: "evidence_refused", status: 422, sub: "event_hash_mismatch" });
  });
});
