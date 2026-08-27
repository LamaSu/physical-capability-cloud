/**
 * Lob client tests — mock-mode letter creation (no network), real-mode create
 * against an injected fetchImpl (no network), webhook signature verification
 * against a hand-computed HMAC over `${timestamp}.${body}` exactly as Lob's
 * Integration Guide specifies (not a stubbed bypass — this exercises the real
 * algorithm both directions), replay/timestamp-freshness, and event parsing.
 */

import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { LobClient } from "../services/lob-client.js";

const to = {
  name: "Court Clerk",
  addressLine1: "60 Centre St",
  addressCity: "New York",
  addressState: "NY",
  addressZip: "10007",
};
const from = {
  name: "PCC Operator",
  addressLine1: "1 Shop Way",
  addressCity: "San Francisco",
  addressState: "CA",
  addressZip: "94103",
};
const file = "<html><body>Official document for job</body></html>";

describe("LobClient — mock mode", () => {
  it("fabricates a letter with no network calls, marked simulated", async () => {
    const client = new LobClient({}); // no apiKey
    expect(client.isMock).toBe(true);

    const result = await client.createLetter({ jobId: "job-1", to, from, file });

    expect(result.simulated).toBe(true);
    expect(result.lobLetterId).toMatch(/^ltr_mock_[0-9a-f]{20}$/);
    expect(result.carrier).toBe("USPS");
    // Honest: standard Lob letters have no USPS tracking number — mock returns null, not a fake.
    expect(result.trackingNumber).toBeNull();
    expect(result.url).toContain("lob-mock.invalid");
    expect(result.commitment.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.commitment.jobId).toBe("job-1");
    expect(result.commitment.lobLetterId).toBe(result.lobLetterId);
    // The commitment binds the document, not just the address.
    expect(result.commitment.fileHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a different letter id per call (not a constant)", async () => {
    const client = new LobClient({});
    const a = await client.createLetter({ jobId: "job-a", to, from, file });
    const b = await client.createLetter({ jobId: "job-b", to, from, file });
    expect(a.lobLetterId).not.toBe(b.lobLetterId);
    expect(a.commitment.hash).not.toBe(b.commitment.hash);
  });
});

describe("LobClient — real mode (injected fetchImpl, no network)", () => {
  it("POSTs to /letters with Basic auth and the correct body, and parses the response", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(
        JSON.stringify({
          id: "ltr_real_abc123",
          carrier: "USPS",
          tracking_number: null,
          expected_delivery_date: "2026-09-02",
          url: "https://lob-assets.com/letters/ltr_real_abc123.pdf?token=x",
          object: "letter",
        }),
        { status: 200 },
      );
    });

    const client = new LobClient({
      apiKey: "test_key_123",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(client.isMock).toBe(false);

    const result = await client.createLetter({ jobId: "job-real-1", to, from, file });

    expect(result.simulated).toBe(false);
    expect(result.lobLetterId).toBe("ltr_real_abc123");
    expect(result.carrier).toBe("USPS");
    expect(result.trackingNumber).toBeNull();
    expect(result.expectedDeliveryDate).toBe("2026-09-02");
    expect(result.url).toContain("ltr_real_abc123.pdf");
    expect(result.commitment.jobId).toBe("job-real-1");

    // Exactly one call, to the Letters endpoint.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.lob.com/v1/letters");

    // HTTP Basic auth: base64("test_key_123:") — key as username, empty password.
    const authHeader = (calls[0]!.init.headers as Record<string, string>).Authorization;
    expect(authHeader).toBe(`Basic ${Buffer.from("test_key_123:").toString("base64")}`);

    // Request body carries Lob's required fields with our sensible defaults.
    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent.to.address_line1).toBe("60 Centre St");
    expect(sent.from.name).toBe("PCC Operator");
    expect(sent.file).toBe(file);
    expect(sent.color).toBe(false); // default B&W
    expect(sent.use_type).toBe("operational"); // default transactional, not marketing
  });

  it("captures a real USPS tracking_number when Lob provides one (certified mail)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "ltr_cert_1", carrier: "USPS", tracking_number: "9407100000000000000000" }),
          { status: 200 },
        ),
    );
    const client = new LobClient({ apiKey: "test_key", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.createLetter({ jobId: "job-cert", to, from, file, mailType: "usps_first_class" });
    expect(result.trackingNumber).toBe("9407100000000000000000");
  });

  it("throws a clear error when letter creation fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("Unprocessable", { status: 422 }));
    const client = new LobClient({ apiKey: "test_key", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.createLetter({ jobId: "job-x", to, from, file })).rejects.toThrow(
      /lob_create_letter_failed: 422/,
    );
  });
});

describe("LobClient — webhook signature verification (Lob algorithm, real HMAC)", () => {
  const secret = "whsec_test_abc123";
  const ts = "1756304520000"; // Lob-Signature-Timestamp as a string

  // Lob: signatureInput = `${timestamp}.${rawBody}`, HMAC-SHA256 hex, secret as key.
  function sign(body: string, timestamp = ts, withSecret = secret): string {
    return createHmac("sha256", withSecret).update(`${timestamp}.${body}`, "utf8").digest("hex");
  }

  it("fails closed when no webhook secret is configured", () => {
    const client = new LobClient({}); // no webhookSecret
    expect(client.hasWebhookSecret).toBe(false);
    expect(client.verifyWebhookSignature('{"a":1}', sign('{"a":1}'), ts)).toBe(false);
  });

  it("accepts a correctly-signed body", () => {
    const client = new LobClient({ webhookSecret: secret });
    expect(client.hasWebhookSecret).toBe(true);
    const body = JSON.stringify({ id: "evt_1", event_type: { id: "letter.mailed" } });
    expect(client.verifyWebhookSignature(body, sign(body), ts)).toBe(true);
  });

  it("rejects a body signed with the wrong secret", () => {
    const client = new LobClient({ webhookSecret: secret });
    const body = JSON.stringify({ id: "evt_1" });
    expect(client.verifyWebhookSignature(body, sign(body, ts, "wrong_secret"), ts)).toBe(false);
  });

  it("rejects a tampered body (signature computed over different bytes)", () => {
    const client = new LobClient({ webhookSecret: secret });
    const original = JSON.stringify({ id: "evt_1", amount: 100 });
    const tampered = JSON.stringify({ id: "evt_1", amount: 999999 });
    expect(client.verifyWebhookSignature(tampered, sign(original), ts)).toBe(false);
  });

  it("rejects when the timestamp is tampered (timestamp is part of the signed input)", () => {
    const client = new LobClient({ webhookSecret: secret });
    const body = JSON.stringify({ id: "evt_1" });
    // Signed with `ts`, but a different timestamp presented in the header.
    expect(client.verifyWebhookSignature(body, sign(body, ts), "9999999999999")).toBe(false);
  });

  it("rejects a missing signature or timestamp header", () => {
    const client = new LobClient({ webhookSecret: secret });
    expect(client.verifyWebhookSignature('{"a":1}', undefined, ts)).toBe(false);
    expect(client.verifyWebhookSignature('{"a":1}', sign('{"a":1}'), undefined)).toBe(false);
  });
});

describe("LobClient — isReplay (Step 4, replay window)", () => {
  const client = new LobClient({ webhookSecret: "s" });
  const now = 1_756_304_520_000; // fixed "now" in ms

  it("is not a replay for a fresh timestamp (ms epoch)", () => {
    expect(client.isReplay(String(now - 60_000), { now })).toBe(false); // 1 min old
  });

  it("is a replay for a stale timestamp beyond tolerance", () => {
    expect(client.isReplay(String(now - 10 * 60_000), { now })).toBe(true); // 10 min old > 5 min
  });

  it("handles seconds-epoch timestamps by magnitude", () => {
    expect(client.isReplay(String(Math.floor(now / 1000) - 60), { now })).toBe(false);
    expect(client.isReplay(String(Math.floor(now / 1000) - 600), { now })).toBe(true);
  });

  it("does not reject when the timestamp is unparseable (HMAC already authenticated it)", () => {
    expect(client.isReplay("not-a-timestamp", { now })).toBe(false);
  });
});

describe("LobClient — parseLetterEvent", () => {
  const client = new LobClient({});

  it("extracts fields from a valid letter.mailed event", () => {
    const parsed = client.parseLetterEvent({
      id: "evt_abc",
      event_type: { id: "letter.mailed", resource: "letters", object: "event_type" },
      reference_id: "ltr_123",
      date_created: "2026-08-27T14:22:00Z",
      body: { id: "ltr_123", carrier: "USPS", tracking_number: null, expected_delivery_date: "2026-09-02" },
      object: "event",
    });
    expect(parsed).toEqual({
      lobEventId: "evt_abc",
      eventType: "letter.mailed",
      lobLetterId: "ltr_123",
      trackingNumber: null,
      carrier: "USPS",
      expectedDeliveryDate: "2026-09-02",
      occurredAt: "2026-08-27T14:22:00Z",
    });
  });

  it("returns null for a non-letter event (e.g. a postcard)", () => {
    expect(
      client.parseLetterEvent({ id: "evt_x", event_type: { id: "postcard.created" }, reference_id: "psc_1" }),
    ).toBeNull();
  });

  it("returns null when the letter id is missing", () => {
    expect(client.parseLetterEvent({ id: "evt_y", event_type: { id: "letter.mailed" } })).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(client.parseLetterEvent(null)).toBeNull();
    expect(client.parseLetterEvent("not an object")).toBeNull();
  });
});
