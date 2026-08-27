/**
 * EasyPost carrier client — buys real postage labels via EasyPost's REST API
 * and verifies inbound tracking webhooks.
 *
 * No SDK dependency: EasyPost's API is a handful of plain REST calls, and a
 * raw fetch() keeps the new-dependency surface (and Gate A scope) at zero.
 * Auth is HTTP Basic with the API key as username, empty password (EasyPost
 * convention).
 *
 * Mock mode (no EASYPOST_API_KEY set): synthesizes a shipment locally so the
 * gateway boots and the route contract is testable with zero external calls.
 * This is NOT EasyPost's own "test mode" (a real EZTK... test key still hits
 * the real API, in EasyPost's sandbox) — it's this codebase's convention for
 * "no credential configured at all", matching fiat-ramp.ts's
 * StripeOnrampClient / YellowcardClient / WiseClient pattern (mock = !env var).
 */

import { randomUUID, createHmac, timingSafeEqual, createHash } from "node:crypto";

export interface EasyPostAddress {
  name: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string; // default "US"
  phone?: string;
}

export interface EasyPostParcel {
  weightOz: number;
  lengthIn?: number;
  widthIn?: number;
  heightIn?: number;
}

export interface CreateLabelParams {
  jobId: string;
  toAddress: EasyPostAddress;
  fromAddress: EasyPostAddress;
  parcel: EasyPostParcel;
}

/**
 * The pre-execution binding sol's review (coord #1382) requires: a carrier
 * scan only proves "some labeled parcel entered the network," not that it is
 * THIS document to THIS recipient. Computed and returned BEFORE the label
 * ever reaches a human, so the later webhook closes a pre-committed claim
 * instead of merely observing an unrelated scan.
 */
export interface ShipmentCommitment {
  /** SHA-256 hex of jobId + destinationHash + trackingCode + labelHash + committedAt. */
  hash: string;
  jobId: string;
  destinationHash: string;
  trackingCode: string;
  labelHash: string;
  committedAt: string;
}

export interface CreateLabelResult {
  shipmentId: string;
  trackerId: string | null;
  trackingCode: string;
  labelUrl: string;
  carrier: string;
  service: string;
  rate: string;
  currency: string;
  commitment: ShipmentCommitment;
  mock: boolean;
}

export interface TrackerWebhookEvent {
  easypostEventId: string;
  trackingCode: string;
  /** unknown|pre_transit|in_transit|out_for_delivery|available_for_pickup|return_to_sender|delivered|failure|cancelled */
  status: string;
  carrier: string | null;
  statusDetail: string | null;
  occurredAt: string;
}

export interface EasyPostClientConfig {
  apiKey?: string;
  webhookSecret?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

function canonicalAddressForHash(a: EasyPostAddress): string {
  // Field order fixed on purpose — this string is hashed, order must be stable.
  return [a.name, a.street1, a.street2 ?? "", a.city, a.state, a.zip, a.country ?? "US"]
    .map((s) => s.trim().toLowerCase())
    .join("|");
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function buildCommitment(
  params: CreateLabelParams,
  trackingCode: string,
  labelUrl: string,
): ShipmentCommitment {
  const destinationHash = sha256Hex(canonicalAddressForHash(params.toAddress));
  const labelHash = sha256Hex(labelUrl || trackingCode);
  const committedAt = new Date().toISOString();
  const hash = sha256Hex(
    [params.jobId, destinationHash, trackingCode, labelHash, committedAt].join("|"),
  );
  return { hash, jobId: params.jobId, destinationHash, trackingCode, labelHash, committedAt };
}

function hashToPositiveInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable body>";
  }
}

function addressToEasyPost(a: EasyPostAddress) {
  return {
    name: a.name,
    street1: a.street1,
    street2: a.street2,
    city: a.city,
    state: a.state,
    zip: a.zip,
    country: a.country ?? "US",
    phone: a.phone,
  };
}

function parcelToEasyPost(p: EasyPostParcel) {
  return { weight: p.weightOz, length: p.lengthIn, width: p.widthIn, height: p.heightIn };
}

interface EasyPostRate {
  id: string;
  carrier: string;
  service: string;
  rate: string;
  currency?: string;
}

interface EasyPostShipment {
  id: string;
  tracking_code?: string;
  rates?: EasyPostRate[];
  selected_rate?: EasyPostRate;
  postage_label?: { label_url?: string };
  tracker?: { id?: string };
}

export class EasyPostClient {
  readonly isMock: boolean;
  private readonly apiKey: string;
  private readonly webhookSecret: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: EasyPostClientConfig = {}) {
    this.isMock = !config.apiKey;
    this.apiKey = config.apiKey ?? "mock";
    this.webhookSecret = config.webhookSecret;
    this.baseUrl = config.baseUrl ?? "https://api.easypost.com/v2";
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  get hasWebhookSecret(): boolean {
    return !!this.webhookSecret;
  }

  private authHeader(): string {
    // EasyPost HTTP Basic auth: API key as username, empty password.
    return "Basic " + Buffer.from(`${this.apiKey}:`).toString("base64");
  }

  /**
   * Buys the cheapest available rate for a shipment. Real mode makes two
   * EasyPost calls (create shipment -> buy); mock mode fabricates an
   * equivalent, clearly-marked-mock result with zero network calls. The
   * commitment is computed before returning in both modes.
   */
  async buyCheapestLabel(params: CreateLabelParams): Promise<CreateLabelResult> {
    if (this.isMock) return this.buyMockLabel(params);

    const shipmentRes = await this.fetchImpl(`${this.baseUrl}/shipments`, {
      method: "POST",
      headers: { Authorization: this.authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({
        shipment: {
          to_address: addressToEasyPost(params.toAddress),
          from_address: addressToEasyPost(params.fromAddress),
          parcel: parcelToEasyPost(params.parcel),
        },
      }),
    });
    if (!shipmentRes.ok) {
      throw new Error(
        `easypost_create_shipment_failed: ${shipmentRes.status} ${await safeText(shipmentRes)}`,
      );
    }
    const shipment = (await shipmentRes.json()) as EasyPostShipment;
    const rates = shipment.rates ?? [];
    if (rates.length === 0) {
      throw new Error("easypost_no_rates: shipment created but no rates returned");
    }
    const cheapest = [...rates].sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate))[0]!;

    const buyRes = await this.fetchImpl(`${this.baseUrl}/shipments/${shipment.id}/buy`, {
      method: "POST",
      headers: { Authorization: this.authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ rate: { id: cheapest.id } }),
    });
    if (!buyRes.ok) {
      throw new Error(`easypost_buy_failed: ${buyRes.status} ${await safeText(buyRes)}`);
    }
    const bought = (await buyRes.json()) as EasyPostShipment;
    const labelUrl = bought.postage_label?.label_url ?? "";
    const trackingCode = bought.tracking_code ?? "";

    return {
      shipmentId: bought.id,
      trackerId: bought.tracker?.id ?? null,
      trackingCode,
      labelUrl,
      carrier: bought.selected_rate?.carrier ?? cheapest.carrier,
      service: bought.selected_rate?.service ?? cheapest.service,
      rate: bought.selected_rate?.rate ?? cheapest.rate,
      currency: bought.selected_rate?.currency ?? cheapest.currency ?? "USD",
      commitment: buildCommitment(params, trackingCode, labelUrl),
      mock: false,
    };
  }

  private buyMockLabel(params: CreateLabelParams): CreateLabelResult {
    const shipmentId = `shp_mock_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const trackingCode = `EZMOCK${hashToPositiveInt(shipmentId).toString().padStart(10, "0").slice(0, 10)}`;
    const labelUrl = `https://easypost-mock.invalid/labels/${shipmentId}.png`;

    return {
      shipmentId,
      trackerId: `trk_mock_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      trackingCode,
      labelUrl,
      carrier: "USPS",
      service: "First",
      rate: "4.50",
      currency: "USD",
      commitment: buildCommitment(params, trackingCode, labelUrl),
      mock: true,
    };
  }

  /**
   * Verifies EasyPost's webhook HMAC signature (X-Hmac-Signature header).
   *
   * Algorithm confirmed 2026-08-27 from two independently-read primary
   * sources — EasyPost's own Go SDK source
   * (github.com/EasyPost/easypost-go/blob/master/webhook.go) and
   * docs.easypost.com/docs/webhooks — which agree: digest =
   * "hmac-sha256-hex=" + hex(HMAC-SHA256(webhookSecret, rawBody)), compared
   * with a timing-safe equality check. No timestamp/path binding in this
   * (current, documented) scheme.
   *
   * NOTE: EasyPost's Zendesk support article additionally references an
   * X-Hmac-Signature-V2 header with timestamp-based replay protection, but
   * that article returned HTTP 403 on every fetch attempt and its exact
   * byte-construction could not be independently verified — NOT implemented
   * here rather than guessed. Flagged as a follow-up once that page is
   * reachable (or EasyPost support confirms the construction directly).
   *
   * MUST be called with the raw request body exactly as received —
   * re-serializing parsed JSON can byte-differ from what EasyPost signed and
   * would make a genuine webhook fail verification.
   */
  verifyWebhookSignature(rawBody: string, headerValue: string | undefined | null): boolean {
    if (!this.webhookSecret) {
      // No secret configured: nothing to verify against. Fail closed — the
      // caller must treat this as "not verified", never as "verified ok".
      return false;
    }
    if (!headerValue) return false;

    const digest =
      "hmac-sha256-hex=" +
      createHmac("sha256", this.webhookSecret).update(rawBody, "utf8").digest("hex");

    const a = Buffer.from(digest, "utf8");
    const b = Buffer.from(headerValue, "utf8");
    if (a.length !== b.length) return false; // timingSafeEqual requires equal-length buffers
    return timingSafeEqual(a, b);
  }

  /** Extracts the fields this integration needs from a parsed EasyPost webhook body. */
  parseTrackerEvent(body: unknown): TrackerWebhookEvent | null {
    const evt = body as {
      id?: string;
      description?: string;
      result?: {
        tracking_code?: string;
        status?: string;
        status_detail?: string;
        carrier?: string;
        updated_at?: string;
      };
    };
    if (!evt || typeof evt !== "object") return null;
    if (!evt.description || !evt.description.startsWith("tracker.")) return null;
    const r = evt.result;
    if (!r?.tracking_code || !r.status) return null;
    return {
      easypostEventId: evt.id ?? randomUUID(),
      trackingCode: r.tracking_code,
      status: r.status,
      carrier: r.carrier ?? null,
      statusDetail: r.status_detail ?? null,
      occurredAt: r.updated_at ?? new Date().toISOString(),
    };
  }
}

let singleton: EasyPostClient | undefined;
let testOverride: EasyPostClient | undefined;

export function getEasyPostClient(): EasyPostClient {
  if (testOverride) return testOverride;
  if (!singleton) {
    singleton = new EasyPostClient({
      apiKey: process.env.EASYPOST_API_KEY,
      webhookSecret: process.env.EASYPOST_WEBHOOK_SECRET,
    });
  }
  return singleton;
}

/** Test-only: force getEasyPostClient() to return a specific instance (e.g. one with a stub fetchImpl). */
export function _setEasyPostClientForTests(client: EasyPostClient | undefined): void {
  testOverride = client;
}
