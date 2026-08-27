/**
 * EasyPost client tests — mock-mode label buy, real-mode buy against an
 * injected fetchImpl (no network), webhook signature verification against a
 * hand-computed HMAC (not a stubbed bypass — this exercises the real
 * algorithm both directions), and tracker-event parsing.
 */

import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { EasyPostClient } from "../services/easypost-client.js";

const toAddress = {
  name: "Recipient Name",
  street1: "100 Court St",
  city: "Brooklyn",
  state: "NY",
  zip: "11201",
};
const fromAddress = {
  name: "PCC Operator",
  street1: "1 Shop Way",
  city: "San Francisco",
  state: "CA",
  zip: "94103",
};
const parcel = { weightOz: 1.5 };

describe("EasyPostClient — mock mode", () => {
  it("fabricates a label with no network calls, marked mock", async () => {
    const client = new EasyPostClient({}); // no apiKey
    expect(client.isMock).toBe(true);

    const result = await client.buyCheapestLabel({ jobId: "job-1", toAddress, fromAddress, parcel });

    expect(result.mock).toBe(true);
    expect(result.trackingCode).toMatch(/^EZMOCK\d{10}$/);
    expect(result.labelUrl).toContain("easypost-mock.invalid");
    expect(result.carrier).toBe("USPS");
    expect(result.commitment.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.commitment.jobId).toBe("job-1");
    expect(result.commitment.trackingCode).toBe(result.trackingCode);
  });

  it("produces a different tracking code per shipment id (not a constant)", async () => {
    const client = new EasyPostClient({});
    const a = await client.buyCheapestLabel({ jobId: "job-a", toAddress, fromAddress, parcel });
    const b = await client.buyCheapestLabel({ jobId: "job-b", toAddress, fromAddress, parcel });
    expect(a.trackingCode).not.toBe(b.trackingCode);
    expect(a.shipmentId).not.toBe(b.shipmentId);
  });
});

describe("EasyPostClient — real mode (injected fetchImpl, no network)", () => {
  it("creates a shipment, buys the CHEAPEST rate, and returns the bought shipment's fields", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      if (String(url).endsWith("/shipments")) {
        return new Response(
          JSON.stringify({
            id: "shp_real_123",
            rates: [
              { id: "rate_expensive", carrier: "UPS", service: "Ground", rate: "12.40", currency: "USD" },
              { id: "rate_cheap", carrier: "USPS", service: "First", rate: "4.13", currency: "USD" },
            ],
          }),
          { status: 200 },
        );
      }
      if (String(url).endsWith("/shipments/shp_real_123/buy")) {
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
      throw new Error(`unexpected fetch: ${url}`);
    });

    const client = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(client.isMock).toBe(false);

    const result = await client.buyCheapestLabel({ jobId: "job-real-1", toAddress, fromAddress, parcel });

    expect(result.mock).toBe(false);
    expect(result.shipmentId).toBe("shp_real_123");
    expect(result.trackingCode).toBe("9400111899223197428490");
    expect(result.labelUrl).toBe("https://easypost-cdn.example/label.png");
    expect(result.carrier).toBe("USPS"); // cheapest, not the UPS rate listed first
    expect(result.rate).toBe("4.13");

    // Buy call selected the cheap rate id, not the first-listed one.
    const buyCall = calls.find((c) => c.url.endsWith("/buy"))!;
    const buyBody = JSON.parse(buyCall.init.body as string);
    expect(buyBody.rate.id).toBe("rate_cheap");

    // HTTP Basic auth: base64("EZAKtest:")
    const authHeader = (calls[0]!.init.headers as Record<string, string>).Authorization;
    expect(authHeader).toBe(`Basic ${Buffer.from("EZAKtest:").toString("base64")}`);
  });

  it("throws a clear error when shipment creation fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad request", { status: 422 }));
    const client = new EasyPostClient({ apiKey: "EZAKtest", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      client.buyCheapestLabel({ jobId: "job-x", toAddress, fromAddress, parcel }),
    ).rejects.toThrow(/easypost_create_shipment_failed/);
  });
});

describe("EasyPostClient — webhook signature verification", () => {
  const secret = "whsec_test_abc123";

  function sign(body: string, withSecret = secret): string {
    return "hmac-sha256-hex=" + createHmac("sha256", withSecret).update(body, "utf8").digest("hex");
  }

  it("fails closed when no webhook secret is configured", () => {
    const client = new EasyPostClient({}); // no webhookSecret
    expect(client.hasWebhookSecret).toBe(false);
    expect(client.verifyWebhookSignature('{"a":1}', sign('{"a":1}'))).toBe(false);
  });

  it("accepts a correctly-signed body", () => {
    const client = new EasyPostClient({ webhookSecret: secret });
    expect(client.hasWebhookSecret).toBe(true);
    const body = JSON.stringify({ id: "evt_1", description: "tracker.updated" });
    expect(client.verifyWebhookSignature(body, sign(body))).toBe(true);
  });

  it("rejects a body signed with the wrong secret", () => {
    const client = new EasyPostClient({ webhookSecret: secret });
    const body = JSON.stringify({ id: "evt_1" });
    expect(client.verifyWebhookSignature(body, sign(body, "wrong_secret"))).toBe(false);
  });

  it("rejects a tampered body (signature computed over different bytes)", () => {
    const client = new EasyPostClient({ webhookSecret: secret });
    const original = JSON.stringify({ id: "evt_1", amount: 100 });
    const tampered = JSON.stringify({ id: "evt_1", amount: 999999 });
    expect(client.verifyWebhookSignature(tampered, sign(original))).toBe(false);
  });

  it("rejects a missing signature header", () => {
    const client = new EasyPostClient({ webhookSecret: secret });
    expect(client.verifyWebhookSignature('{"a":1}', undefined)).toBe(false);
  });
});

describe("EasyPostClient — parseTrackerEvent", () => {
  const client = new EasyPostClient({});

  it("extracts fields from a valid tracker.updated event", () => {
    const parsed = client.parseTrackerEvent({
      id: "evt_abc",
      description: "tracker.updated",
      result: {
        tracking_code: "9400111899223197428490",
        status: "in_transit",
        status_detail: "arrived_at_destination_facility",
        carrier: "USPS",
        updated_at: "2026-08-27T12:00:00Z",
      },
    });
    expect(parsed).toEqual({
      easypostEventId: "evt_abc",
      trackingCode: "9400111899223197428490",
      status: "in_transit",
      carrier: "USPS",
      statusDetail: "arrived_at_destination_facility",
      occurredAt: "2026-08-27T12:00:00Z",
    });
  });

  it("returns null for a non-tracker event", () => {
    expect(client.parseTrackerEvent({ id: "evt_x", description: "batch.created", result: {} })).toBeNull();
  });

  it("returns null when tracking_code or status is missing", () => {
    expect(
      client.parseTrackerEvent({ id: "evt_y", description: "tracker.updated", result: { status: "in_transit" } }),
    ).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(client.parseTrackerEvent(null)).toBeNull();
    expect(client.parseTrackerEvent("not an object")).toBeNull();
  });
});
