/**
 * EasyPost client tests — mock-mode label buy, real-mode THREE-step purchase
 * (createShipment / buyRate / finalizeLabel) against an injected fetchImpl
 * (no network) including ambiguity classification, getShipment recovery,
 * streamed label download with an incremental cap, exact media types,
 * provider-mode enforcement pre-charge AND post-buy equality, webhook
 * signature verification with a hand-computed HMAC, commitment
 * hash/signature verification, and tracker-event parsing.
 */

import { describe, it, expect, vi } from "vitest";
import { createHmac, createHash } from "node:crypto";
import { generateKeyPair, compactVerify } from "jose";
import { canonicalize } from "@pcc/spec";
import {
  EasyPostClient,
  EasyPostError,
  POST_CHARGE_ERROR_CODES,
  computeCommitmentHash,
  verifyCommitmentHash,
  type ShipmentCommitmentBody,
} from "../services/easypost-client.js";
import {
  createCommitmentSigner,
  verifyCommitmentSignature,
  COMMITMENT_JWS_TYP,
} from "../services/commitment-signer.js";
import { computeCid, isValidCid, type ICidBlobStorage } from "../services/cid-blob-storage.js";

const toAddress = { name: "Recipient Name", street1: "100 Court St", city: "Brooklyn", state: "NY", zip: "11201" };
const fromAddress = { name: "PCC Operator", street1: "1 Shop Way", city: "San Francisco", state: "CA", zip: "94103" };
const parcel = { weightOz: 1.5 };
const documentHash = createHash("sha256").update("the letter").digest("hex");
const base = { jobId: "job-1", kernelId: "kernel-1", documentHash, toAddress, fromAddress, parcel };

const LABEL_BYTES = Buffer.from("PNG-LABEL-BYTES-0123456789");

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

interface HappyOpts {
  mode?: string;
  buyMode?: string;
  labelHeaders?: Record<string, string>;
  labelBody?: Buffer;
}

/** fetch stub that plays a full happy-path EasyPost conversation. */
function happyFetch(calls: { url: string; init?: RequestInit }[] = [], opts: HappyOpts = {}) {
  const mode = opts.mode ?? "production";
  const buyMode = opts.buyMode ?? mode;
  const labelHeaders = opts.labelHeaders ?? { "content-type": "image/png" };
  const labelBody = opts.labelBody ?? LABEL_BYTES;
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith("/shipments") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          id: "shp_real_123",
          mode,
          rates: [
            { id: "rate_expensive", carrier: "UPS", service: "Ground", rate: "12.40", currency: "USD" },
            { id: "rate_cheap", carrier: "USPS", service: "First", rate: "4.13", currency: "USD" },
            { id: "rate_eur", carrier: "DHL", service: "X", rate: "1.00", currency: "EUR" }, // non-USD: ignored, never "cheapest"
          ],
        }),
        { status: 200 },
      );
    }
    if (u.endsWith("/shipments/shp_real_123/buy")) {
      return new Response(
        JSON.stringify({
          id: "shp_real_123",
          mode: buyMode,
          tracking_code: "9400111899223197428490",
          postage_label: { label_url: "https://easypost-cdn.example/label.png" },
          tracker: { id: "trk_real_456" },
          selected_rate: { carrier: "USPS", service: "First", rate: "4.13", currency: "USD" },
        }),
        { status: 200 },
      );
    }
    if (u.endsWith("/shipments/shp_real_123") && (!init?.method || init.method === "GET")) {
      // Recovery lookup: an unbought shipment (no tracking_code yet).
      return new Response(JSON.stringify({ id: "shp_real_123", mode }), { status: 200 });
    }
    if (u === "https://easypost-cdn.example/label.png") {
      return new Response(labelBody, { status: 200, headers: labelHeaders });
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

describe("EasyPostClient — mock mode", () => {
  it("fabricates a label with no network calls, marked mock + providerMode mock, with a self-consistent commitment", async () => {
    const blobs = memBlobStore();
    const client = new EasyPostClient({ blobStore: blobs });
    expect(client.isMock).toBe(true);

    const result = await client.buyCheapestLabel(base);

    expect(result.mock).toBe(true);
    expect(result.providerMode).toBe("mock");
    expect(result.trackingCode).toMatch(/^EZMOCK\d{10}$/);
    expect(result.labelHash).toMatch(/^[0-9a-f]{64}$/);
    expect(isValidCid(result.labelCid)).toBe(true);
    expect(blobs.blobs.has(result.labelCid)).toBe(true); // mock label bytes are stored too, so the print leg can fetch them
    expect(result.commitment.mock).toBe(true);
    expect(result.commitment.providerMode).toBe("mock");
    expect(result.commitment.documentHash).toBe(documentHash);
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
    await expect(client.createShipment({ ...base, documentHash: "nope" })).rejects.toMatchObject({ code: "invalid_document_hash" });
  });

  it("enforces the weight ceiling before purchase", async () => {
    const client = new EasyPostClient({ maxWeightOz: 10, blobStore: memBlobStore() });
    await expect(client.createShipment({ ...base, parcel: { weightOz: 11 } })).rejects.toMatchObject({ code: "weight_exceeds_ceiling" });
  });

  it("refuses to construct in requireProductionMode with no API key (mock forbidden in production)", () => {
    expect(() => new EasyPostClient({ requireProductionMode: true })).toThrowError(/mock_forbidden_in_production/);
  });
});

describe("EasyPostClient — real mode, three steps (injected fetchImpl, no network)", () => {
  it("createShipment prices without charging; buyRate charges; finalizeLabel hashes AND content-addresses the bytes", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const blobs = memBlobStore();
    const client = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl: happyFetch(calls), blobStore: blobs });
    expect(client.isMock).toBe(false);

    const created = await client.createShipment(base);
    expect(created).toMatchObject({ shipmentId: "shp_real_123", providerMode: "production", rateId: "rate_cheap", carrier: "USPS", rate: "4.13", mock: false });
    // Step 1 made exactly ONE call — nothing charged:
    expect(calls.map((c) => c.url)).toEqual(["https://api.easypost.com/v2/shipments"]);

    const bought = await client.buyRate(created);
    expect(bought).toMatchObject({ shipmentId: "shp_real_123", trackerId: "trk_real_456", trackingCode: "9400111899223197428490", providerMode: "production", mock: false });
    expect(calls[1]!.url).toBe("https://api.easypost.com/v2/shipments/shp_real_123/buy");
    expect(JSON.parse(calls[1]!.init!.body as string).rate.id).toBe("rate_cheap");

    const finalized = await client.finalizeLabel(base, bought);
    expect(finalized.labelHash).toBe(createHash("sha256").update(LABEL_BYTES).digest("hex"));
    expect(finalized.labelCid).toBe(computeCid(new Uint8Array(LABEL_BYTES)));
    expect(Buffer.from(await blobs.get(finalized.labelCid))).toEqual(LABEL_BYTES); // the print leg gets the EXACT bytes back
    expect(finalized.commitment.providerMode).toBe("production");
    expect(verifyCommitmentHash(finalized.commitment)).toBe(true);

    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("EZAKtest:").toString("base64")}`);
    for (const c of calls) expect((c.init as { redirect?: string }).redirect).toBe("error"); // no redirect-following anywhere
  });

  it("refuses a non-production shipment under requireProductionMode BEFORE any charge", async () => {
    const calls: { url: string }[] = [];
    const client = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl: happyFetch(calls, { mode: "test" }), requireProductionMode: true, blobStore: memBlobStore() });
    await expect(client.createShipment(base)).rejects.toMatchObject({ code: "provider_mode_not_production" });
    expect(calls.some((c) => c.url.endsWith("/buy"))).toBe(false);
  });

  it("refuses to buy when the cheapest rate exceeds the USD ceiling (no /buy call made)", async () => {
    const calls: { url: string }[] = [];
    const client = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl: happyFetch(calls), maxRateUsd: 4.0, blobStore: memBlobStore() });
    await expect(client.createShipment(base)).rejects.toMatchObject({ code: "rate_exceeds_ceiling" });
    expect(calls.some((c) => c.url.endsWith("/buy"))).toBe(false);
  });

  it("classifies a network failure DURING /buy as easypost_buy_ambiguous (possibly charged) — a post-charge code", async () => {
    const client = new EasyPostClient({
      apiKey: "EZAKtest",
      fetchImpl: vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith("/shipments") && init?.method === "POST") {
          return new Response(JSON.stringify({ id: "shp_1", mode: "production", rates: [{ id: "r", carrier: "USPS", service: "First", rate: "1.00", currency: "USD" }] }), { status: 200 });
        }
        throw new Error("socket hang up");
      }) as unknown as typeof fetch,
      blobStore: memBlobStore(),
    });
    const created = await client.createShipment(base);
    const err = await client.buyRate(created).catch((e) => e);
    expect(err).toBeInstanceOf(EasyPostError);
    expect(err.code).toBe("easypost_buy_ambiguous");
    expect(POST_CHARGE_ERROR_CODES.has(err.code)).toBe(true);
  });

  it("refuses a /buy response for a DIFFERENT shipment id — identity can never be switched post-charge (R5-3)", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/shipments") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "shp_real_123", mode: "production", rates: [{ id: "r", carrier: "USPS", service: "First", rate: "1.00", currency: "USD" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "shp_SWAPPED", mode: "production", tracking_code: "X", postage_label: { label_url: "https://x.example/l.png" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl, blobStore: memBlobStore() });
    const created = await client.createShipment(base);
    const err = await client.buyRate(created).catch((e) => e);
    expect(err.code).toBe("easypost_bought_shipment_mismatch");
    expect(POST_CHARGE_ERROR_CODES.has(err.code)).toBe(true);
  });

  it("flags a bought object whose mode disagrees with the created mode (R3-10) — a post-charge reconciliation code", async () => {
    const client = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl: happyFetch([], { mode: "production", buyMode: "test" }), blobStore: memBlobStore() });
    const created = await client.createShipment(base);
    const err = await client.buyRate(created).catch((e) => e);
    expect(err.code).toBe("easypost_bought_mode_mismatch");
    expect(POST_CHARGE_ERROR_CODES.has(err.code)).toBe(true);
  });

  it("flags a bought shipment missing tracking_code/label_url with the LOUD bought-but-unusable code", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/shipments") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "shp_1", mode: "production", rates: [{ id: "r", carrier: "USPS", service: "First", rate: "1.00", currency: "USD" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "shp_1", mode: "production", tracking_code: "", postage_label: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl, blobStore: memBlobStore() });
    const created = await client.createShipment(base);
    await expect(client.buyRate(created)).rejects.toMatchObject({ code: "easypost_bought_but_unusable" });
  });

  it("getShipment recovery: reports no purchase for an unbought shipment, and the full purchase once bought", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl: happyFetch(calls), blobStore: memBlobStore() });
    const created = await client.createShipment(base);
    const before = await client.getShipment(created);
    expect(before.bought).toBeNull(); // no tracking_code -> not charged -> safe to buy

    // Now simulate the bought state on the recovery endpoint:
    const boughtFetch = vi.fn(async (url: string | URL) => {
      return new Response(
        JSON.stringify({
          id: "shp_real_123",
          mode: "production",
          tracking_code: "9400111899223197428490",
          postage_label: { label_url: "https://easypost-cdn.example/label.png" },
          tracker: { id: "trk_real_456" },
          selected_rate: { carrier: "USPS", service: "First", rate: "4.13", currency: "USD" },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client2 = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl: boughtFetch, blobStore: memBlobStore() });
    const after = await client2.getShipment(created);
    expect(after.bought).toMatchObject({ trackingCode: "9400111899223197428490", trackerId: "trk_real_456" });
  });

  it("getShipment recovery REFUSES a response for a different shipment id or a disagreeing mode (R4-4)", async () => {
    const wrongId = vi.fn(async () =>
      new Response(JSON.stringify({ id: "shp_SOMEONE_ELSES", mode: "production", tracking_code: "X", postage_label: { label_url: "https://x.example/l.png" } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const clientA = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl: wrongId, blobStore: memBlobStore() });
    const created = { shipmentId: "shp_real_123", providerMode: "production" as const, rateId: "r", carrier: "USPS", service: "First", rate: "1", currency: "USD", mock: false };
    await expect(clientA.getShipment(created)).rejects.toMatchObject({ code: "easypost_recovered_shipment_mismatch" });

    const wrongMode = vi.fn(async () =>
      new Response(JSON.stringify({ id: "shp_real_123", mode: "test", tracking_code: "X", postage_label: { label_url: "https://x.example/l.png" } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const clientB = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl: wrongMode, blobStore: memBlobStore() });
    await expect(clientB.getShipment(created)).rejects.toMatchObject({ code: "easypost_bought_mode_mismatch" });
    expect(POST_CHARGE_ERROR_CODES.has("easypost_recovered_shipment_mismatch")).toBe(true);
  });

  it("rejects a shipment with no provider mode (cannot classify the environment)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ id: "shp_1", rates: [{ id: "r", carrier: "USPS", service: "First", rate: "1.00", currency: "USD" }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl, blobStore: memBlobStore() });
    await expect(client.createShipment(base)).rejects.toMatchObject({ code: "easypost_invalid_response" });
  });

  it("rejects an SVG label — image/* is NOT acceptable, exact types only (R3-6)", async () => {
    const client = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl: happyFetch([], { labelHeaders: { "content-type": "image/svg+xml" } }), blobStore: memBlobStore() });
    const bought = await client.buyRate(await client.createShipment(base));
    await expect(client.finalizeLabel(base, bought)).rejects.toMatchObject({ code: "easypost_label_unexpected_type" });
  });

  it("aborts a label download that exceeds the cap DURING streaming, not after buffering (R3-6)", async () => {
    const big = Buffer.alloc(256 * 1024, 7); // no content-length lie needed: stream cap must catch it
    const client = new EasyPostClient({
      apiKey: "EZAKtest",
      fetchImpl: happyFetch([], { labelBody: big, labelHeaders: { "content-type": "image/png" } }),
      maxLabelBytes: 64 * 1024,
      blobStore: memBlobStore(),
    });
    const bought = await client.buyRate(await client.createShipment(base));
    await expect(client.finalizeLabel(base, bought)).rejects.toMatchObject({ code: "easypost_label_too_large" });
  });

  it("keeps provider error bodies in EasyPostError.detail (server-side), with a stable code", async () => {
    const fetchImpl = vi.fn(async () => new Response("address invalid: 100 Court St", { status: 422 })) as unknown as typeof fetch;
    const client = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl, blobStore: memBlobStore() });
    const err = await client.createShipment(base).catch((e) => e);
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

  it("signs with ES256; verifyCommitmentSignature accepts it and rejects tampering / wrong keys / no signature", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const { publicKey: otherPublicKey } = await generateKeyPair("ES256");
    const signer = createCommitmentSigner({ privateKey, kid: "test-kid", alg: "ES256" });
    const client = new EasyPostClient({ signer, blobStore: memBlobStore() });
    const { commitment } = await client.buyCheapestLabel(base);

    expect(commitment.signature).not.toBeNull();
    const { payload, protectedHeader } = await compactVerify(commitment.signature!.jws, publicKey);
    expect(protectedHeader.typ).toBe(COMMITMENT_JWS_TYP);
    const { hash, signature: _s, ...body } = commitment;
    expect(new TextDecoder().decode(payload)).toBe(canonicalize(body));
    expect(computeCommitmentHash(body as ShipmentCommitmentBody)).toBe(hash);

    await expect(verifyCommitmentSignature(commitment, () => publicKey)).resolves.toBe(true);
    // A tampered body whose attacker recomputed the hash: hash "valid", signature NOT.
    const tamperedBody = { ...body, jobId: "job-attacker" } as ShipmentCommitmentBody;
    const tampered = { ...tamperedBody, hash: computeCommitmentHash(tamperedBody), signature: commitment.signature };
    expect(verifyCommitmentHash(tampered)).toBe(true);
    await expect(verifyCommitmentSignature(tampered, () => publicKey)).resolves.toBe(false);
    await expect(verifyCommitmentSignature(commitment, () => otherPublicKey)).resolves.toBe(false);
    await expect(verifyCommitmentSignature(commitment, () => null)).resolves.toBe(false);
    await expect(verifyCommitmentSignature({ ...commitment, signature: null }, () => publicKey)).resolves.toBe(false);
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

  it("extracts fields (incl. tracker + shipment identity + provider mode) from a tracker.updated event", () => {
    expect(
      client.parseTrackerEvent({
        id: "evt_abc",
        description: "tracker.updated",
        result: {
          id: "trk_1",
          mode: "production",
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
      providerMode: "production",
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
        mode: "test",
        updated_at: "2026-08-27T14:22:00Z",
        tracking_details: [
          { message: "Arrived at USPS Facility", status: "in_transit", datetime: "2026-08-27T14:22:00Z", tracking_location: { city: "SAN FRANCISCO", state: "CA", zip: "94103", country: "US" } },
          { message: "Pre-Shipment Info Sent to USPS", status: "pre_transit", datetime: "2026-08-27T09:00:00Z", tracking_location: { city: null, state: null, zip: null, country: null } },
        ],
      },
    });
    expect(parsed?.providerMode).toBe("test");
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
