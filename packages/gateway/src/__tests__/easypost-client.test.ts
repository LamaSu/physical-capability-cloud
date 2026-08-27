/**
 * EasyPost client tests — mock-mode label buy, real-mode buy against an
 * injected fetchImpl (no network) including label-BYTES download + hashing,
 * response validation, spend ceilings, webhook signature verification against
 * a hand-computed HMAC (real algorithm, both directions), commitment
 * hash/signature verification, and tracker-event parsing.
 */

import { describe, it, expect, vi } from "vitest";
import { createHmac, createHash } from "node:crypto";
import { generateKeyPair, compactVerify } from "jose";
import { canonicalize } from "@pcc/spec";
import {
  EasyPostClient,
  EasyPostError,
  computeCommitmentHash,
  verifyCommitmentHash,
  type ShipmentCommitmentBody,
} from "../services/easypost-client.js";
import { createCommitmentSigner, COMMITMENT_JWS_TYP } from "../services/commitment-signer.js";
import { computeCid, isValidCid, type ICidBlobStorage } from "../services/cid-blob-storage.js";

/** Hermetic content-addressed store: no disk, same CID math as the gateway's. */
function memBlobStore(): ICidBlobStorage & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    async put(bytes, opts) {
      const cid = computeCid(bytes);
      blobs.set(cid, bytes);
      return { cid, sizeBytes: bytes.length, mediaType: opts?.mediaType ?? "application/octet-stream", backend: "local", storedAt: new Date().toISOString() };
    },
    async get(cid) {
      const b = blobs.get(cid);
      if (!b) throw new Error("not found");
      return b;
    },
    async getRange(cid, start, end) {
      return (await this.get(cid)).slice(start, end);
    },
    async exists(cid) {
      return blobs.has(cid);
    },
  };
}

const toAddress = { name: "Recipient Name", street1: "100 Court St", city: "Brooklyn", state: "NY", zip: "11201" };
const fromAddress = { name: "PCC Operator", street1: "1 Shop Way", city: "San Francisco", state: "CA", zip: "94103" };
const parcel = { weightOz: 1.5 };
const documentHash = createHash("sha256").update("the letter").digest("hex");
const base = { jobId: "job-1", kernelId: "kernel-1", documentHash, toAddress, fromAddress, parcel };

const LABEL_BYTES = Buffer.from("PNG-LABEL-BYTES-0123456789");

/** fetch stub that plays a full happy-path EasyPost conversation. */
function happyFetch(calls: { url: string; init?: RequestInit }[] = []) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith("/shipments")) {
      return new Response(
        JSON.stringify({
          id: "shp_real_123",
          rates: [
            { id: "rate_expensive", carrier: "UPS", service: "Ground", rate: "12.40", currency: "USD" },
            { id: "rate_cheap", carrier: "USPS", service: "First", rate: "4.13", currency: "USD" },
            { id: "rate_eur", carrier: "DHL", service: "X", rate: "1.00", currency: "EUR" }, // non-USD: must be ignored, not "cheapest"
          ],
        }),
        { status: 200 },
      );
    }
    if (u.endsWith("/shipments/shp_real_123/buy")) {
      return new Response(
        JSON.stringify({
          id: "shp_real_123",
          tracking_code: "9400111899223197428490",
          postage_label: { label_url: "https://easypost-cdn.example/label.png" },
          tracker: { id: "trk_real_456" },
          selected_rate: { carrier: "USPS", service: "First", rate: "4.13", currency: "USD" },
        }),
        { status: 200 },
      );
    }
    if (u === "https://easypost-cdn.example/label.png") {
      return new Response(LABEL_BYTES, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

describe("EasyPostClient — mock mode", () => {
  it("fabricates a label with no network calls, marked mock, with a self-consistent commitment", async () => {
    const blobs = memBlobStore();
    const client = new EasyPostClient({ blobStore: blobs });
    expect(client.isMock).toBe(true);

    const result = await client.buyCheapestLabel(base);

    expect(result.mock).toBe(true);
    expect(result.trackingCode).toMatch(/^EZMOCK\d{10}$/);
    expect(result.labelHash).toMatch(/^[0-9a-f]{64}$/);
    expect(isValidCid(result.labelCid)).toBe(true);
    expect(blobs.blobs.has(result.labelCid)).toBe(true); // mock label bytes are stored too, so the print leg can fetch them
    expect(result.commitment.mock).toBe(true);
    expect(result.commitment.documentHash).toBe(documentHash);
    expect(result.commitment.kernelId).toBe("kernel-1");
    expect(result.commitment.labelHash).toBe(result.labelHash);
    expect(result.commitment.labelCid).toBe(result.labelCid);
    expect(result.commitment.signature).toBeNull(); // no signer configured -> visibly unsigned
    expect(verifyCommitmentHash(result.commitment)).toBe(true);
  });

  it("produces distinct tracking codes per shipment", async () => {
    const client = new EasyPostClient({ blobStore: memBlobStore() });
    const a = await client.buyCheapestLabel({ ...base, jobId: "job-a" });
    const b = await client.buyCheapestLabel({ ...base, jobId: "job-b" });
    expect(a.trackingCode).not.toBe(b.trackingCode);
  });

  it("rejects a malformed documentHash before doing anything", async () => {
    const client = new EasyPostClient({ blobStore: memBlobStore() });
    await expect(client.buyCheapestLabel({ ...base, documentHash: "nope" })).rejects.toMatchObject({ code: "invalid_document_hash" });
  });

  it("enforces the weight ceiling before purchase", async () => {
    const client = new EasyPostClient({ maxWeightOz: 10, blobStore: memBlobStore() });
    await expect(client.buyCheapestLabel({ ...base, parcel: { weightOz: 11 } })).rejects.toMatchObject({ code: "weight_exceeds_ceiling" });
  });
});

describe("EasyPostClient — real mode (injected fetchImpl, no network)", () => {
  it("creates, buys the cheapest USD rate, downloads the label BYTES, hashes AND content-addresses them", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const blobs = memBlobStore();
    const client = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl: happyFetch(calls), blobStore: blobs });
    expect(client.isMock).toBe(false);

    const result = await client.buyCheapestLabel(base);

    expect(result.mock).toBe(false);
    expect(result.shipmentId).toBe("shp_real_123");
    expect(result.trackerId).toBe("trk_real_456");
    expect(result.trackingCode).toBe("9400111899223197428490");
    expect(result.carrier).toBe("USPS"); // cheapest USD — not the UPS listed first, not the EUR rate
    expect(result.rate).toBe("4.13");
    expect(result.labelHash).toBe(createHash("sha256").update(LABEL_BYTES).digest("hex"));
    expect(result.labelCid).toBe(computeCid(new Uint8Array(LABEL_BYTES)));
    expect(Buffer.from(await blobs.get(result.labelCid))).toEqual(LABEL_BYTES); // the print leg gets the EXACT bytes back
    expect(result.commitment.labelHash).toBe(result.labelHash);
    expect(result.commitment.labelCid).toBe(result.labelCid);
    expect(result.commitment.trackerId).toBe("trk_real_456");
    expect(verifyCommitmentHash(result.commitment)).toBe(true);

    const buyCall = calls.find((c) => c.url.endsWith("/buy"))!;
    expect(JSON.parse(buyCall.init!.body as string).rate.id).toBe("rate_cheap");
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("EZAKtest:").toString("base64")}`,
    );
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.easypost.com/v2/shipments",
      "https://api.easypost.com/v2/shipments/shp_real_123/buy",
      "https://easypost-cdn.example/label.png",
    ]);
  });

  it("refuses to buy when the cheapest rate exceeds the USD ceiling (no /buy call made)", async () => {
    const calls: { url: string }[] = [];
    const client = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl: happyFetch(calls), maxRateUsd: 4.0, blobStore: memBlobStore() });
    await expect(client.buyCheapestLabel(base)).rejects.toMatchObject({ code: "rate_exceeds_ceiling" });
    expect(calls.some((c) => c.url.endsWith("/buy"))).toBe(false);
  });

  it("rejects a bought shipment missing tracking_code/label_url instead of indexing an empty code", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/shipments")) {
        return new Response(JSON.stringify({ id: "shp_1", rates: [{ id: "r", carrier: "USPS", service: "First", rate: "1.00", currency: "USD" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "shp_1", tracking_code: "", postage_label: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl });
    await expect(client.buyCheapestLabel(base)).rejects.toMatchObject({ code: "easypost_invalid_response" });
  });

  it("keeps provider error bodies in EasyPostError.detail (server-side), with a stable code", async () => {
    const fetchImpl = vi.fn(async () => new Response("address invalid: 100 Court St", { status: 422 })) as unknown as typeof fetch;
    const client = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl });
    const err = await client.buyCheapestLabel(base).catch((e) => e);
    expect(err).toBeInstanceOf(EasyPostError);
    expect(err.code).toBe("easypost_create_shipment_failed");
    expect(err.status).toBe(422);
    expect(err.detail).toContain("address invalid");
    expect(err.message).not.toContain("address invalid"); // message is the stable code only
  });
});

describe("ShipmentCommitment — hash + gateway signature", () => {
  it("hash is sha256 over canonical JSON of the body and detects tampering", async () => {
    const client = new EasyPostClient({ blobStore: memBlobStore() });
    const { commitment } = await client.buyCheapestLabel(base);
    const { hash, signature: _s, ...body } = commitment;
    expect(hash).toBe(createHash("sha256").update(canonicalize(body)).digest("hex"));
    expect(verifyCommitmentHash({ ...commitment, destinationHash: "0".repeat(64) })).toBe(false);
    expect(verifyCommitmentHash({ ...commitment, hash: "0".repeat(64) })).toBe(false);
  });

  it("signs the commitment with an ES256 key and the signature verifies against the public key", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const signer = createCommitmentSigner({ privateKey, kid: "test-kid", alg: "ES256" });
    const client = new EasyPostClient({ signer, blobStore: memBlobStore() });
    const { commitment } = await client.buyCheapestLabel(base);

    expect(commitment.signature).not.toBeNull();
    expect(commitment.signature!.kid).toBe("test-kid");
    const { payload, protectedHeader } = await compactVerify(commitment.signature!.jws, publicKey);
    expect(protectedHeader.typ).toBe(COMMITMENT_JWS_TYP);
    const { hash, signature: _s, ...body } = commitment;
    expect(new TextDecoder().decode(payload)).toBe(canonicalize(body));
    expect(computeCommitmentHash(body as ShipmentCommitmentBody)).toBe(hash);
  });

  it("a signature over one commitment does not verify for a different body", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const signer = createCommitmentSigner({ privateKey, kid: "k", alg: "ES256" });
    const client = new EasyPostClient({ signer, blobStore: memBlobStore() });
    const { commitment } = await client.buyCheapestLabel(base);
    const { payload } = await compactVerify(commitment.signature!.jws, publicKey);
    const tampered = { ...commitment, jobId: "job-other" };
    const { hash: _h, signature: _s, ...tamperedBody } = tampered;
    expect(new TextDecoder().decode(payload)).not.toBe(canonicalize(tamperedBody));
  });
});

describe("EasyPostClient — webhook signature verification", () => {
  const secret = "whsec_test_abc123";
  const sign = (body: Buffer | string, withSecret = secret) =>
    "hmac-sha256-hex=" + createHmac("sha256", withSecret).update(body).digest("hex");

  it("fails closed when no webhook secret is configured", () => {
    const client = new EasyPostClient({});
    expect(client.hasWebhookSecret).toBe(false);
    expect(client.verifyWebhookSignature('{"a":1}', sign('{"a":1}'))).toBe(false);
  });

  it("accepts a correctly-signed body (Buffer and string forms)", () => {
    const client = new EasyPostClient({ webhookSecret: secret });
    const body = Buffer.from(JSON.stringify({ id: "evt_1", description: "tracker.updated" }));
    expect(client.verifyWebhookSignature(body, sign(body))).toBe(true);
    expect(client.verifyWebhookSignature(body.toString("utf8"), sign(body))).toBe(true);
  });

  it("rejects wrong secret, tampered body, and missing header", () => {
    const client = new EasyPostClient({ webhookSecret: secret });
    const original = JSON.stringify({ id: "evt_1", amount: 100 });
    expect(client.verifyWebhookSignature(original, sign(original, "wrong"))).toBe(false);
    expect(client.verifyWebhookSignature(JSON.stringify({ id: "evt_1", amount: 999 }), sign(original))).toBe(false);
    expect(client.verifyWebhookSignature(original, undefined)).toBe(false);
  });
});

describe("EasyPostClient — parseTrackerEvent", () => {
  const client = new EasyPostClient({});

  it("extracts fields (incl. tracker + shipment identity) from a tracker.updated event", () => {
    expect(
      client.parseTrackerEvent({
        id: "evt_abc",
        description: "tracker.updated",
        result: {
          id: "trk_1",
          shipment_id: "shp_1",
          tracking_code: "9400111899223197428490",
          status: "in_transit",
          status_detail: "arrived_at_destination_facility",
          carrier: "USPS",
          updated_at: "2026-08-27T12:00:00Z",
        },
      }),
    ).toEqual({
      easypostEventId: "evt_abc",
      trackerId: "trk_1",
      shipmentId: "shp_1",
      trackingCode: "9400111899223197428490",
      status: "in_transit",
      carrier: "USPS",
      statusDetail: "arrived_at_destination_facility",
      occurredAt: "2026-08-27T12:00:00.000Z",
      carrierMessage: null,
      trackingLocation: null,
    });
  });

  it("surfaces the LATEST scan's location + message from tracking_details (by carrier datetime, not array order)", () => {
    const parsed = client.parseTrackerEvent({
      id: "evt_loc",
      description: "tracker.updated",
      result: {
        tracking_code: "X",
        status: "in_transit",
        updated_at: "2026-08-27T14:22:00Z",
        tracking_details: [
          { message: "Arrived at USPS Facility", status: "in_transit", datetime: "2026-08-27T14:22:00Z", tracking_location: { city: "SAN FRANCISCO", state: "CA", zip: "94103", country: "US" } },
          { message: "Pre-Shipment Info Sent to USPS", status: "pre_transit", datetime: "2026-08-27T09:00:00Z", tracking_location: { city: null, state: null, zip: null, country: null } },
        ],
      },
    });
    expect(parsed?.carrierMessage).toBe("Arrived at USPS Facility");
    expect(parsed?.trackingLocation).toEqual({ city: "SAN FRANCISCO", state: "CA", zip: "94103", country: "US" });
  });

  it("returns null without an event id (no replay key), a carrier timestamp, a tracking code, or for non-tracker events", () => {
    const ok = { id: "trk", tracking_code: "X", status: "in_transit", updated_at: "2026-08-27T12:00:00Z" };
    expect(client.parseTrackerEvent({ description: "tracker.updated", result: ok })).toBeNull();
    expect(client.parseTrackerEvent({ id: "e", description: "tracker.updated", result: { ...ok, updated_at: undefined } })).toBeNull();
    expect(client.parseTrackerEvent({ id: "e", description: "tracker.updated", result: { ...ok, tracking_code: "" } })).toBeNull();
    expect(client.parseTrackerEvent({ id: "e", description: "batch.created", result: ok })).toBeNull();
    expect(client.parseTrackerEvent(null)).toBeNull();
  });
});
