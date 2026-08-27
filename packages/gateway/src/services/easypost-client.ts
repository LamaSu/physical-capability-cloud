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
 * Mock mode is FORBIDDEN in production — routes/carrier.ts fails boot.
 *
 * Revised after sol's cross-family review of PR #297 (DO-NOT-SHIP, 15
 * findings). Changes: the commitment binds the DOCUMENT hash + kernel +
 * shipment/tracker identity + label BYTES (not the URL string) + mock state,
 * is hashed over canonical JSON, and can be signed by the gateway key; every
 * EasyPost response field we index on is validated non-empty; postage rate
 * and parcel weight are ceiling-checked BEFORE purchase; upstream error
 * bodies stay server-side; HMAC runs over raw BYTES.
 */

import { randomUUID, createHmac, timingSafeEqual, createHash } from "node:crypto";
import { canonicalize } from "@pcc/spec";

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
  kernelId: string;
  /** sha256 hex of the document the job is to print and mail. Bound into the commitment. */
  documentHash: string;
  toAddress: EasyPostAddress;
  fromAddress: EasyPostAddress;
  parcel: EasyPostParcel;
}

/**
 * The pre-execution binding sol's reviews (coord #1382, PR #297) require.
 * Computed BEFORE the label reaches a human, so the later carrier webhook
 * closes a pre-committed claim rather than observing an unrelated scan.
 *
 * WHAT IT PROVES: that at `committedAt` the gateway bound THIS job, THIS
 * document hash, THIS destination, THIS carrier-issued tracking code /
 * shipment / tracker, and THESE exact label bytes together — and, when
 * `signature` is present, that the gateway's key attested to that binding.
 * WHAT IT DOES NOT PROVE: that the envelope the carrier scans contains the
 * document, is non-empty, or that the label was not moved to another
 * envelope. Document-to-envelope binding needs the print leg (kernel-signed
 * page count) + the pre-seal handoff photo; the scan binds envelope to mail
 * stream only. Stated in the capability definition, never blurred.
 */
export interface ShipmentCommitmentBody {
  v: 1;
  jobId: string;
  kernelId: string;
  documentHash: string;
  destinationHash: string;
  trackingCode: string;
  shipmentId: string;
  trackerId: string | null;
  carrier: string;
  service: string;
  /** sha256 hex of the label BYTES as downloaded from EasyPost (mock: of a deterministic mock label). */
  labelHash: string;
  mock: boolean;
  committedAt: string;
}

export interface CommitmentSignature {
  alg: string;
  kid: string;
  /** Compact JWS over canonicalize(body); verifiable against the gateway JWKS. */
  jws: string;
}

export interface ShipmentCommitment extends ShipmentCommitmentBody {
  /** sha256 hex of canonicalize(body). */
  hash: string;
  /** null when no gateway signing key is configured (PCC_AGENT_CARD_SIGNING_KEY). */
  signature: CommitmentSignature | null;
}

export type CommitmentSigner = (
  body: ShipmentCommitmentBody,
  hash: string,
) => Promise<CommitmentSignature | null>;

export interface CreateLabelResult {
  shipmentId: string;
  trackerId: string | null;
  trackingCode: string;
  labelUrl: string;
  labelHash: string;
  carrier: string;
  service: string;
  rate: string;
  currency: string;
  commitment: ShipmentCommitment;
  mock: boolean;
}

export interface TrackerWebhookEvent {
  easypostEventId: string;
  /** EasyPost Tracker object id (trk_...), when present. Checked against the purchased shipment's tracker. */
  trackerId: string | null;
  /** EasyPost Shipment id (shp_...), when present on the tracker. */
  shipmentId: string | null;
  trackingCode: string;
  /** unknown|pre_transit|in_transit|out_for_delivery|available_for_pickup|return_to_sender|delivered|failure|cancelled */
  status: string;
  carrier: string | null;
  statusDetail: string | null;
  occurredAt: string;
}

export class EasyPostError extends Error {
  constructor(
    /** Stable, safe-to-return code. */
    readonly code: string,
    /** Upstream HTTP status when applicable. */
    readonly status: number | null,
    /** Server-side detail (may echo provider diagnostics) — log, never return. */
    readonly detail: string,
  ) {
    super(`${code}${status != null ? ` (${status})` : ""}`);
    this.name = "EasyPostError";
  }
}

export interface EasyPostClientConfig {
  apiKey?: string;
  webhookSecret?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Refuse any rate above this (USD). Default 25. */
  maxRateUsd?: number;
  /** Refuse any parcel heavier than this (oz). Default 70 (USPS First-Class Package ceiling is ~15.99 oz; leave headroom for Priority). */
  maxWeightOz?: number;
  signer?: CommitmentSigner;
  now?: () => Date;
}

const DEFAULT_MAX_RATE_USD = 25;
const DEFAULT_MAX_WEIGHT_OZ = 70;
const HEX64 = /^[0-9a-f]{64}$/;

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function canonicalAddressForHash(a: EasyPostAddress): string {
  // Field order fixed on purpose — this string is hashed, order must be stable.
  return [a.name, a.street1, a.street2 ?? "", a.city, a.state, a.zip, a.country ?? "US"]
    .map((s) => s.trim().toLowerCase())
    .join("|");
}

export function computeCommitmentHash(body: ShipmentCommitmentBody): string {
  return sha256Hex(canonicalize(body));
}

/** Recomputes the hash from the commitment's own fields. False = tampered or malformed. */
export function verifyCommitmentHash(c: ShipmentCommitment): boolean {
  const { hash, signature: _sig, ...body } = c;
  if (!HEX64.test(hash)) return false;
  return computeCommitmentHash(body as ShipmentCommitmentBody) === hash;
}

export function isValidDocumentHash(s: unknown): s is string {
  return typeof s === "string" && HEX64.test(s);
}

function hashToPositiveInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 2000);
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
  id?: string;
  carrier?: string;
  service?: string;
  rate?: string;
  currency?: string;
}

interface EasyPostShipment {
  id?: string;
  tracking_code?: string;
  rates?: EasyPostRate[];
  selected_rate?: EasyPostRate;
  postage_label?: { label_url?: string };
  tracker?: { id?: string };
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parseRateUsd(r: EasyPostRate): number | null {
  if (!nonEmptyString(r.rate)) return null;
  const n = Number(r.rate);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cur = (r.currency ?? "USD").toUpperCase();
  if (cur !== "USD") return null; // ceiling is in USD; refuse to compare across currencies
  return n;
}

export class EasyPostClient {
  readonly isMock: boolean;
  readonly maxRateUsd: number;
  readonly maxWeightOz: number;
  private readonly apiKey: string;
  private readonly webhookSecret: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly signer: CommitmentSigner | undefined;
  private readonly now: () => Date;

  constructor(config: EasyPostClientConfig = {}) {
    this.isMock = !config.apiKey;
    this.apiKey = config.apiKey ?? "mock";
    this.webhookSecret = config.webhookSecret;
    this.baseUrl = config.baseUrl ?? "https://api.easypost.com/v2";
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.maxRateUsd = config.maxRateUsd ?? DEFAULT_MAX_RATE_USD;
    this.maxWeightOz = config.maxWeightOz ?? DEFAULT_MAX_WEIGHT_OZ;
    this.signer = config.signer;
    this.now = config.now ?? (() => new Date());
  }

  get hasWebhookSecret(): boolean {
    return !!this.webhookSecret;
  }

  private authHeader(): string {
    // EasyPost HTTP Basic auth: API key as username, empty password.
    return "Basic " + Buffer.from(`${this.apiKey}:`).toString("base64");
  }

  private async buildCommitment(
    params: CreateLabelParams,
    fields: {
      trackingCode: string;
      shipmentId: string;
      trackerId: string | null;
      carrier: string;
      service: string;
      labelHash: string;
      mock: boolean;
    },
  ): Promise<ShipmentCommitment> {
    const body: ShipmentCommitmentBody = {
      v: 1,
      jobId: params.jobId,
      kernelId: params.kernelId,
      documentHash: params.documentHash,
      destinationHash: sha256Hex(canonicalAddressForHash(params.toAddress)),
      trackingCode: fields.trackingCode,
      shipmentId: fields.shipmentId,
      trackerId: fields.trackerId,
      carrier: fields.carrier,
      service: fields.service,
      labelHash: fields.labelHash,
      mock: fields.mock,
      committedAt: this.now().toISOString(),
    };
    const hash = computeCommitmentHash(body);
    const signature = this.signer ? await this.signer(body, hash) : null;
    return { ...body, hash, signature };
  }

  private checkParcel(p: EasyPostParcel): void {
    if (!Number.isFinite(p.weightOz) || p.weightOz <= 0) {
      throw new EasyPostError("invalid_parcel", null, "weightOz must be > 0");
    }
    if (p.weightOz > this.maxWeightOz) {
      throw new EasyPostError(
        "weight_exceeds_ceiling",
        null,
        `weightOz ${p.weightOz} > ceiling ${this.maxWeightOz}`,
      );
    }
  }

  /**
   * Buys the cheapest available USD rate for a shipment. Real mode makes
   * three EasyPost calls (create shipment -> buy -> download label bytes);
   * mock mode fabricates an equivalent, clearly-marked-mock result with zero
   * network calls. Ceilings are enforced BEFORE money moves.
   */
  async buyCheapestLabel(params: CreateLabelParams): Promise<CreateLabelResult> {
    if (!isValidDocumentHash(params.documentHash)) {
      throw new EasyPostError("invalid_document_hash", null, "documentHash must be 64 lowercase hex");
    }
    this.checkParcel(params.parcel);
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
      throw new EasyPostError("easypost_create_shipment_failed", shipmentRes.status, await safeText(shipmentRes));
    }
    const shipment = (await shipmentRes.json()) as EasyPostShipment;
    if (!nonEmptyString(shipment.id)) {
      throw new EasyPostError("easypost_invalid_response", null, "shipment.id missing");
    }
    const priced = (shipment.rates ?? [])
      .map((r) => ({ r, usd: parseRateUsd(r) }))
      .filter((x): x is { r: EasyPostRate; usd: number } => x.usd != null && nonEmptyString(x.r.id));
    if (priced.length === 0) {
      throw new EasyPostError("easypost_no_rates", null, "no usable USD rates returned");
    }
    priced.sort((a, b) => a.usd - b.usd);
    const cheapest = priced[0]!;
    if (cheapest.usd > this.maxRateUsd) {
      throw new EasyPostError(
        "rate_exceeds_ceiling",
        null,
        `cheapest rate ${cheapest.usd} USD > ceiling ${this.maxRateUsd}`,
      );
    }

    const buyRes = await this.fetchImpl(`${this.baseUrl}/shipments/${shipment.id}/buy`, {
      method: "POST",
      headers: { Authorization: this.authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ rate: { id: cheapest.r.id } }),
    });
    if (!buyRes.ok) {
      throw new EasyPostError("easypost_buy_failed", buyRes.status, await safeText(buyRes));
    }
    const bought = (await buyRes.json()) as EasyPostShipment;
    const shipmentId = nonEmptyString(bought.id) ? bought.id : shipment.id;
    const trackingCode = bought.tracking_code;
    const labelUrl = bought.postage_label?.label_url;
    if (!nonEmptyString(trackingCode) || !nonEmptyString(labelUrl)) {
      throw new EasyPostError(
        "easypost_invalid_response",
        null,
        `bought shipment missing tracking_code/label_url (id=${shipmentId})`,
      );
    }
    if (!/^https:\/\//.test(labelUrl)) {
      throw new EasyPostError("easypost_invalid_response", null, "label_url is not https");
    }

    // Hash the label BYTES, not the URL string — the URL is a mutable pointer.
    const labelRes = await this.fetchImpl(labelUrl, { method: "GET" });
    if (!labelRes.ok) {
      throw new EasyPostError("easypost_label_download_failed", labelRes.status, await safeText(labelRes));
    }
    const labelBytes = Buffer.from(await labelRes.arrayBuffer());
    if (labelBytes.length === 0) {
      throw new EasyPostError("easypost_invalid_response", null, "label download was empty");
    }
    const labelHash = sha256Hex(labelBytes);

    const carrier = bought.selected_rate?.carrier ?? cheapest.r.carrier ?? "unknown";
    const service = bought.selected_rate?.service ?? cheapest.r.service ?? "unknown";
    const trackerId = nonEmptyString(bought.tracker?.id) ? bought.tracker!.id! : null;

    return {
      shipmentId,
      trackerId,
      trackingCode,
      labelUrl,
      labelHash,
      carrier,
      service,
      rate: bought.selected_rate?.rate ?? cheapest.r.rate ?? String(cheapest.usd),
      currency: bought.selected_rate?.currency ?? cheapest.r.currency ?? "USD",
      commitment: await this.buildCommitment(params, {
        trackingCode,
        shipmentId,
        trackerId,
        carrier,
        service,
        labelHash,
        mock: false,
      }),
      mock: false,
    };
  }

  private async buyMockLabel(params: CreateLabelParams): Promise<CreateLabelResult> {
    const shipmentId = `shp_mock_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const trackerId = `trk_mock_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const trackingCode = `EZMOCK${hashToPositiveInt(shipmentId).toString().padStart(10, "0").slice(0, 10)}`;
    const labelUrl = `https://easypost-mock.invalid/labels/${shipmentId}.png`;
    const labelHash = sha256Hex(Buffer.from(`MOCK-LABEL:${shipmentId}:${trackingCode}`));

    return {
      shipmentId,
      trackerId,
      trackingCode,
      labelUrl,
      labelHash,
      carrier: "USPS",
      service: "First",
      rate: "4.50",
      currency: "USD",
      commitment: await this.buildCommitment(params, {
        trackingCode,
        shipmentId,
        trackerId,
        carrier: "USPS",
        service: "First",
        labelHash,
        mock: true,
      }),
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
   * (current, documented) scheme, so a captured genuine delivery is
   * replayable at the transport layer; replay is neutralised at the
   * application layer by the persisted per-event-id ledger in
   * carrier-shipment-store.ts.
   *
   * NOTE: EasyPost's Zendesk support article additionally references an
   * X-Hmac-Signature-V2 header with timestamp-based replay protection, but
   * that article returned HTTP 403 on every fetch attempt and its exact
   * byte-construction could not be independently verified — NOT implemented
   * here rather than guessed. Follow-up once that page is reachable.
   *
   * MUST be called with the raw request BYTES exactly as received — decoding
   * and re-encoding can byte-differ from what EasyPost signed.
   */
  verifyWebhookSignature(rawBody: Buffer | string, headerValue: string | undefined | null): boolean {
    if (!this.webhookSecret) {
      // No secret configured: nothing to verify against. Fail closed — the
      // caller must treat this as "not verified", never as "verified ok".
      return false;
    }
    if (!headerValue) return false;

    const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
    const digest = "hmac-sha256-hex=" + createHmac("sha256", this.webhookSecret).update(bytes).digest("hex");

    const a = Buffer.from(digest, "utf8");
    const b = Buffer.from(headerValue, "utf8");
    if (a.length !== b.length) return false; // timingSafeEqual requires equal-length buffers
    return timingSafeEqual(a, b);
  }

  /** Extracts the fields this integration needs from a parsed EasyPost webhook body. */
  parseTrackerEvent(body: unknown): TrackerWebhookEvent | null {
    const evt = body as {
      id?: unknown;
      description?: unknown;
      result?: {
        id?: unknown;
        shipment_id?: unknown;
        tracking_code?: unknown;
        status?: unknown;
        status_detail?: unknown;
        carrier?: unknown;
        updated_at?: unknown;
      };
    };
    if (!evt || typeof evt !== "object") return null;
    if (!nonEmptyString(evt.description) || !evt.description.startsWith("tracker.")) return null;
    // The event id is the replay/dedupe key — a webhook without one is not
    // processable (we would have no way to reject its replay).
    if (!nonEmptyString(evt.id)) return null;
    const r = evt.result;
    if (!r || !nonEmptyString(r.tracking_code) || !nonEmptyString(r.status)) return null;
    const occurredAt = nonEmptyString(r.updated_at) && !Number.isNaN(Date.parse(r.updated_at))
      ? new Date(Date.parse(r.updated_at)).toISOString()
      : null;
    if (!occurredAt) return null; // carrier timestamp is what orders events; refuse without it
    return {
      easypostEventId: evt.id,
      trackerId: nonEmptyString(r.id) ? r.id : null,
      shipmentId: nonEmptyString(r.shipment_id) ? r.shipment_id : null,
      trackingCode: r.tracking_code,
      status: r.status,
      carrier: nonEmptyString(r.carrier) ? r.carrier : null,
      statusDetail: nonEmptyString(r.status_detail) ? r.status_detail : null,
      occurredAt,
    };
  }
}

let singleton: EasyPostClient | undefined;
let testOverride: EasyPostClient | undefined;
let defaultSigner: CommitmentSigner | undefined;

/** Wire the gateway's commitment signer (set at boot; null-safe when no key is configured). */
export function setDefaultCommitmentSigner(signer: CommitmentSigner | undefined): void {
  defaultSigner = signer;
  singleton = undefined; // rebuild lazily with the signer attached
}

export function getEasyPostClient(): EasyPostClient {
  if (testOverride) return testOverride;
  if (!singleton) {
    const maxRate = Number(process.env.EASYPOST_MAX_RATE_USD);
    const maxWeight = Number(process.env.EASYPOST_MAX_WEIGHT_OZ);
    singleton = new EasyPostClient({
      apiKey: process.env.EASYPOST_API_KEY,
      webhookSecret: process.env.EASYPOST_WEBHOOK_SECRET,
      maxRateUsd: Number.isFinite(maxRate) && maxRate > 0 ? maxRate : undefined,
      maxWeightOz: Number.isFinite(maxWeight) && maxWeight > 0 ? maxWeight : undefined,
      signer: defaultSigner,
    });
  }
  return singleton;
}

/** Test-only: force getEasyPostClient() to return a specific instance (e.g. one with a stub fetchImpl). */
export function _setEasyPostClientForTests(client: EasyPostClient | undefined): void {
  testOverride = client;
}
