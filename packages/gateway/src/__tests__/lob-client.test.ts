/**
 * Lob client tests — the second operator behind the identical print-and-mail
 * contract. What matters here beyond ordinary coverage: the commitment this
 * client emits is verified with the SAME shared functions the EasyPost leg
 * uses (verifyCommitmentHash / verifyCommitmentSignature imported from the
 * carrier modules) — the two-operator claim is a code-level identity, not a
 * convention.
 */

import { describe, it, expect, vi } from "vitest";
import { createHmac, createHash } from "node:crypto";
import { generateKeyPair, compactVerify } from "jose";
import { canonicalize } from "@pcc/spec";
import {
  LobClient,
  LOB_EVENT_STATUS_MAP,
  providerModeFromLobKey,
  _setLobClientForTests,
} from "../services/lob-client.js";
import {
  verifyCommitmentHash,
  computeCommitmentHash,
  type ShipmentCommitmentBody,
} from "../services/easypost-client.js";
import { createCommitmentSigner, verifyCommitmentSignature, COMMITMENT_JWS_TYP } from "../services/commitment-signer.js";
import { computeCid, isValidCid, type ICidBlobStorage } from "../services/cid-blob-storage.js";

const toAddress = { name: "Court Clerk", street1: "60 Centre St", city: "New York", state: "NY", zip: "10007" };
const fromAddress = { name: "PCC Operator", street1: "1 Shop Way", city: "San Francisco", state: "CA", zip: "94103" };
const PDF = Buffer.from("%PDF-1.4 fake court filing bytes");
const documentHash = createHash("sha256").update(PDF).digest("hex");
const base = {
  jobId: "job-lob-1",
  kernelId: "kernel-lob",
  documentHash,
  toAddress,
  fromAddress,
  documentPdfB64: PDF.toString("base64"),
};

const RENDERED = Buffer.from("%PDF-1.4 lob-rendered artifact bytes");

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
    async getRange(cid, s, e) {
      return (await this.get(cid)).slice(s, e);
    },
    async exists(cid) {
      return blobs.has(cid);
    },
  };
}

function happyFetch(calls: { url: string; init?: RequestInit }[] = []) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith("/letters") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          id: "ltr_real_123",
          tracking_number: null, // plain First Class: scans key on the letter id
          carrier: "USPS",
          mail_type: "usps_first_class",
          url: "https://lob-render.example/ltr_real_123.pdf",
          expected_delivery_date: "2026-09-04",
        }),
        { status: 200 },
      );
    }
    if (u === "https://lob-render.example/ltr_real_123.pdf") {
      return new Response(RENDERED, { status: 200, headers: { "content-type": "application/pdf" } });
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

describe("providerModeFromLobKey — Lob-documented prefixes, fail closed", () => {
  it("maps no key -> mock, test_ -> test, live_ -> production, anything else -> refused", () => {
    expect(providerModeFromLobKey(undefined)).toBe("mock");
    expect(providerModeFromLobKey("test_abc")).toBe("test");
    expect(providerModeFromLobKey("live_abc")).toBe("production");
    expect(() => providerModeFromLobKey("sk_mystery")).toThrowError(/lob_key_unrecognized/);
  });

  it("requireProductionMode refuses mock AND test_ environments at construction (tracking events do not exist in Lob test)", () => {
    expect(() => new LobClient({ requireProductionMode: true })).toThrowError(/provider_mode_not_production/);
    expect(() => new LobClient({ apiKey: "test_abc", requireProductionMode: true })).toThrowError(/provider_mode_not_production/);
    expect(new LobClient({ apiKey: "live_abc", requireProductionMode: true }).providerMode).toBe("production");
  });
});

describe("LobClient — create + finalize", () => {
  it("refuses a document whose bytes do not hash to documentHash — pre-charge, fail closed", async () => {
    const client = new LobClient({ blobStore: memBlobStore() });
    await expect(
      client.createLetter({ ...base, documentPdfB64: Buffer.from("different bytes").toString("base64") }),
    ).rejects.toMatchObject({ code: "document_hash_mismatch" });
  });

  it("mock mode fabricates a letter and a commitment the SHARED verifier accepts", async () => {
    const blobs = memBlobStore();
    const client = new LobClient({ blobStore: blobs });
    const created = await client.createLetter(base);
    expect(created.mock).toBe(true);
    expect(created.providerMode).toBe("mock");
    expect(created.trackingCode).toBe(created.letterId); // no tracking number -> letter id IS the tracking identity

    const finalized = await client.finalizeLetter(base, created);
    expect(isValidCid(finalized.labelCid)).toBe(true);
    expect(blobs.blobs.has(finalized.labelCid)).toBe(true);
    expect(finalized.commitment).toMatchObject({
      jobId: base.jobId,
      kernelId: base.kernelId,
      documentHash,
      shipmentId: created.letterId,
      trackingCode: created.letterId,
      providerMode: "mock",
      mock: true,
      signature: null,
    });
    expect(verifyCommitmentHash(finalized.commitment)).toBe(true); // the EasyPost leg's own verifier
  });

  it("real mode: single-phase create with Idempotency-Key = jobId, rendered artifact hashed + content-addressed", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const blobs = memBlobStore();
    const client = new LobClient({ apiKey: "test_abc", fetchImpl: happyFetch(calls), blobStore: blobs });

    const created = await client.createLetter(base);
    expect(created).toMatchObject({ letterId: "ltr_real_123", trackingCode: "ltr_real_123", carrier: "USPS", service: "usps_first_class", providerMode: "test", mock: false });

    const createCall = calls[0]!;
    const headers = createCall.init!.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(base.jobId); // provider-side idempotency: retries can never double-charge
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("test_abc:").toString("base64")}`);
    const sent = JSON.parse(createCall.init!.body as string);
    expect(sent.file).toBe(`data:application/pdf;base64,${PDF.toString("base64")}`);
    expect(sent.use_type).toBe("operational");
    expect(sent.to.address_line1).toBe("60 Centre St");

    const finalized = await client.finalizeLetter(base, created);
    expect(finalized.labelHash).toBe(createHash("sha256").update(RENDERED).digest("hex"));
    expect(finalized.labelCid).toBe(computeCid(new Uint8Array(RENDERED)));
    expect(Buffer.from(await blobs.get(finalized.labelCid))).toEqual(RENDERED);
    expect(finalized.commitment.providerMode).toBe("test");
    expect(verifyCommitmentHash(finalized.commitment)).toBe(true);
    for (const c of calls) expect((c.init as { redirect?: string }).redirect).toBe("error");
  });

  it("rejects a rendered artifact that is not exactly application/pdf", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/letters")) {
        return new Response(JSON.stringify({ id: "ltr_1", url: "https://lob-render.example/x.pdf", carrier: "USPS" }), { status: 200 });
      }
      return new Response(RENDERED, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const client = new LobClient({ apiKey: "test_abc", fetchImpl, blobStore: memBlobStore() });
    const created = await client.createLetter(base);
    await expect(client.finalizeLetter(base, created)).rejects.toMatchObject({ code: "lob_render_unexpected_type" });
  });

  it("the gateway ES256 signature over a Lob commitment verifies with the SHARED verifier — two operators, one attestation scheme", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const signer = createCommitmentSigner({ privateKey, kid: "kid-lob", alg: "ES256" });
    const client = new LobClient({ signer, blobStore: memBlobStore() });
    const created = await client.createLetter(base);
    const { commitment } = await client.finalizeLetter(base, created);
    expect(commitment.signature).not.toBeNull();
    const { payload, protectedHeader } = await compactVerify(commitment.signature!.jws, publicKey);
    expect(protectedHeader.typ).toBe(COMMITMENT_JWS_TYP);
    const { hash, signature: _s, ...body } = commitment;
    expect(new TextDecoder().decode(payload)).toBe(canonicalize(body));
    expect(computeCommitmentHash(body as ShipmentCommitmentBody)).toBe(hash);
    await expect(verifyCommitmentSignature(commitment, () => publicKey)).resolves.toBe(true);
  });
});

describe("LobClient — webhook signature (timestamp-bound HMAC)", () => {
  const secret = "lob_whsec_test";
  const sign = (ts: string, body: string, withSecret = secret) =>
    createHmac("sha256", withSecret).update(`${ts}.`).update(Buffer.from(body, "utf8")).digest("hex");

  it("accepts a fresh, correctly signed body and rejects wrong-secret / tampered / missing pieces", () => {
    const now = new Date("2026-08-28T12:00:00Z");
    const client = new LobClient({ webhookSecret: secret, now: () => now });
    const ts = String(now.getTime());
    const body = JSON.stringify({ id: "evt_1", event_type: { id: "letter.in_transit" } });
    expect(client.verifyWebhookSignature(body, sign(ts, body), ts)).toBe(true);
    expect(client.verifyWebhookSignature(body, sign(ts, body, "wrong"), ts)).toBe(false);
    expect(client.verifyWebhookSignature(JSON.stringify({ id: "evt_2" }), sign(ts, body), ts)).toBe(false);
    expect(client.verifyWebhookSignature(body, undefined, ts)).toBe(false);
    expect(client.verifyWebhookSignature(body, sign(ts, body), undefined)).toBe(false);
  });

  it("rejects a STALE timestamp even with a valid signature — transport-layer replay is bounded (stronger than EasyPost v1)", () => {
    const now = new Date("2026-08-28T12:00:00Z");
    const client = new LobClient({ webhookSecret: secret, now: () => now, webhookToleranceMs: 5 * 60_000 });
    const staleTs = String(now.getTime() - 6 * 60_000);
    const body = JSON.stringify({ id: "evt_1" });
    expect(client.verifyWebhookSignature(body, sign(staleTs, body), staleTs)).toBe(false);
    const freshTs = String(now.getTime() - 4 * 60_000);
    expect(client.verifyWebhookSignature(body, sign(freshTs, body), freshTs)).toBe(true);
  });

  it("fails closed with no secret configured", () => {
    const client = new LobClient({});
    const ts = String(Date.now());
    expect(client.verifyWebhookSignature("{}", sign(ts, "{}"), ts)).toBe(false);
  });
});

describe("LobClient — parseLetterEvent maps onto the SHARED tracker vocabulary", () => {
  const client = new LobClient({ apiKey: "test_abc", fetchImpl: happyFetch() });

  it("maps every documented letter.* event; USPS-scan events move the lattice, Lob-attested ones are no-ops", () => {
    for (const [lobType, expected] of Object.entries(LOB_EVENT_STATUS_MAP)) {
      const parsed = client.parseLetterEvent({
        id: `evt_${lobType}`,
        event_type: { id: lobType },
        body: { id: "ltr_1" },
        date_created: "2026-08-28T12:00:00Z",
      });
      expect(parsed, lobType).not.toBeNull();
      expect(parsed!.status, lobType).toBe(expected);
      expect(parsed!.trackingCode).toBe("ltr_1"); // letter id is the tracking identity
      expect(parsed!.shipmentId).toBe("ltr_1");
      expect(parsed!.providerMode).toBe("test"); // the verifying env IS the attestation
    }
  });

  it("carries a ZIP-shaped location into trackingLocation when the event has one", () => {
    const parsed = client.parseLetterEvent({
      id: "evt_loc",
      event_type: { id: "letter.in_local_area" },
      body: { id: "ltr_1", location: "94103" },
      date_created: "2026-08-28T12:00:00Z",
    });
    expect(parsed!.trackingLocation).toEqual({ city: null, state: null, country: null, zip: "94103" });
    expect(parsed!.carrierMessage).toContain("94103");
  });

  it("returns null for unknown letter.* types, missing event id, missing letter id, or missing timestamp — never guessed", () => {
    const ok = { id: "e", event_type: { id: "letter.in_transit" }, body: { id: "ltr_1" }, date_created: "2026-08-28T12:00:00Z" };
    expect(client.parseLetterEvent({ ...ok, event_type: { id: "letter.some_future_thing" } })).toBeNull();
    expect(client.parseLetterEvent({ ...ok, id: undefined })).toBeNull();
    expect(client.parseLetterEvent({ ...ok, body: {} })).toBeNull();
    expect(client.parseLetterEvent({ ...ok, date_created: undefined })).toBeNull();
    expect(client.parseLetterEvent({ id: "e", event_type: { id: "postcard.created" }, body: { id: "psc_1" }, date_created: "2026-08-28T12:00:00Z" })).toBeNull();
    expect(client.parseLetterEvent(null)).toBeNull();
  });
});

describe("singleton override", () => {
  it("_setLobClientForTests forces the returned instance", async () => {
    const { getLobClient } = await import("../services/lob-client.js");
    const mine = new LobClient({});
    _setLobClientForTests(mine);
    expect(getLobClient()).toBe(mine);
    _setLobClientForTests(undefined);
  });
});
