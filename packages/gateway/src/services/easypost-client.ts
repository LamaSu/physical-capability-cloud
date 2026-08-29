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
 * This is NOT EasyPost's own "test mode" (a real EasyPost TEST key still hits
 * the real API, in EasyPost's sandbox) — it's this codebase's convention for
 * "no credential configured at all", matching fiat-ramp.ts's
 * StripeOnrampClient / YellowcardClient / WiseClient pattern (mock = !env var).
 *
 * PROVIDER MODE (sol #297 round 2, CRITICAL): EasyPost's docs define no key
 * prefix that distinguishes test from production keys, and third-party pages
 * contradict each other — so this client does NOT sniff key prefixes. Every
 * EasyPost object carries a provider-attested `mode: "test" | "production"`;
 * the client reads it from the created Shipment BEFORE /buy and from every
 * Tracker webhook, binds it into the commitment and the evidence, and — when
 * `requireProductionMode` is set (production boot) — refuses anything that
 * is not "production". Evidence from a test-mode tracker is never authentic.
 *
 * PURCHASE IS TWO PHASES (sol round 2, NEW-2): `createAndBuy` ends the moment
 * EasyPost has charged; the caller durably records that BEFORE
 * `finalizeLabel` downloads/hashes/content-addresses the label and builds
 * the commitment. A failure after /buy therefore never leads to a second
 * charge on retry — the recorded purchase is finalized instead.
 */

import { randomUUID, createHmac, timingSafeEqual, createHash } from "node:crypto";
import { canonicalize } from "@pcc/spec";
import { getCidBlobStorage, type ICidBlobStorage } from "./cid-blob-storage.js";

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

/** "production" = a real EasyPost production account; "test" = EasyPost sandbox; "mock" = no credential at all (this codebase). */
export type ProviderMode = "production" | "test" | "mock";

/**
 * The pre-execution binding sol's reviews (coord #1382, PR #297) require.
 * Computed BEFORE the label reaches a human, so the later carrier webhook
 * closes a pre-committed claim rather than observing an unrelated scan.
 *
 * WHAT IT PROVES: that at `committedAt` the gateway bound THIS job, THIS
 * document hash, THIS destination, THIS carrier-issued tracking code /
 * shipment / tracker, and THESE exact label bytes together — and, when
 * `signature` is present and verifies (commitment-signer.ts), that the
 * gateway's key attested to that binding. A bare `hash` that recomputes is
 * NOT an attestation; only the signature is.
 * WHAT IT DOES NOT PROVE: that the envelope the carrier scans contains the
 * document, is non-empty, or that the label was not moved to another
 * envelope. Document-to-envelope binding needs the print leg (kernel-signed
 * page count + hash of the label it printed, fetched by labelCid) + the
 * pre-seal handoff photo; the scan binds envelope to mail stream only.
 * Stated in the capability definition, never blurred.
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
  /** CIDv1 of the same bytes in the gateway blob store — how the print leg fetches the EXACT bytes. */
  labelCid: string;
  /** Provider-attested environment the purchase was made in. Only "production" is authentic. */
  providerMode: ProviderMode;
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
  /** sha256 hex of canonicalize(body). Integrity only — see signature for authenticity. */
  hash: string;
  /** null when no gateway signing key is configured (dev/test only; production boot requires one). */
  signature: CommitmentSignature | null;
}

export type CommitmentSigner = (
  body: ShipmentCommitmentBody,
  hash: string,
) => Promise<CommitmentSignature | null>;

/** Phase 1 result: EasyPost has charged; nothing else has happened yet. Record this durably before phase 2. */
export interface BoughtShipment {
  shipmentId: string;
  trackerId: string | null;
  trackingCode: string;
  labelUrl: string;
  carrier: string;
  service: string;
  rate: string;
  currency: string;
  providerMode: ProviderMode;
  mock: boolean;
}

/** Phase 2 result: label bytes hashed + content-addressed, commitment built (and signed when a signer is configured). */
export interface FinalizedLabel {
  labelHash: string;
  labelCid: string;
  commitment: ShipmentCommitment;
}

export type CreateLabelResult = BoughtShipment & FinalizedLabel;

export interface TrackingLocation {
  city: string | null;
  state: string | null;
  country: string | null;
  zip: string | null;
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
  /** Provider-attested environment of the tracker ("test" | "production"); null when absent from the payload. */
  providerMode: "test" | "production" | null;
  /** The carrier's own words for the latest scan (tracking_details[].message), when present. */
  carrierMessage: string | null;
  /** Where the latest scan happened (tracking_details[].tracking_location), when present — "accepted, ZIP 94103". */
  trackingLocation: TrackingLocation | null;
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
  /** Refuse any parcel heavier than this (oz). Default 70. */
  maxWeightOz?: number;
  /** Refuse to buy from, or accept tracker webhooks for, anything whose provider-attested mode is not "production". Set in production boot. */
  requireProductionMode?: boolean;
  /** Per-request upstream timeout (ms). Default 15000. */
  timeoutMs?: number;
  /** Maximum label download size (bytes). Default 5 MiB. */
  maxLabelBytes?: number;
  signer?: CommitmentSigner;
  /** Content-addressed store for label bytes; defaults to the gateway's shared CID blob store. Tests inject an in-memory one. */
  blobStore?: ICidBlobStorage;
  now?: () => Date;
}

const DEFAULT_MAX_RATE_USD = 25;
const DEFAULT_MAX_WEIGHT_OZ = 70;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_LABEL_BYTES = 5 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const ALLOWED_LABEL_TYPES = [/^image\//i, /^application\/pdf/i];

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

/** Recomputes the hash from the commitment's own fields. False = tampered or malformed. INTEGRITY ONLY — not an attestation. */
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
  mode?: string;
  tracking_code?: string;
  rates?: EasyPostRate[];
  selected_rate?: EasyPostRate;
  postage_label?: { label_url?: string };
  tracker?: { id?: string };
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parseProviderMode(v: unknown): "test" | "production" | null {
  return v === "test" || v === "production" ? v : null;
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
  readonly requireProductionMode: boolean;
  private readonly apiKey: string;
  private readonly webhookSecret: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxLabelBytes: number;
  private readonly signer: CommitmentSigner | undefined;
  private readonly blobStore: ICidBlobStorage | undefined;
  private readonly now: () => Date;

  constructor(config: EasyPostClientConfig = {}) {
    this.isMock = !config.apiKey;
    this.apiKey = config.apiKey ?? "mock";
    this.webhookSecret = config.webhookSecret;
    this.baseUrl = config.baseUrl ?? "https://api.easypost.com/v2";
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.maxRateUsd = config.maxRateUsd ?? DEFAULT_MAX_RATE_USD;
    this.maxWeightOz = config.maxWeightOz ?? DEFAULT_MAX_WEIGHT_OZ;
    this.requireProductionMode = config.requireProductionMode ?? false;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxLabelBytes = config.maxLabelBytes ?? DEFAULT_MAX_LABEL_BYTES;
    this.signer = config.signer;
    this.blobStore = config.blobStore;
    this.now = config.now ?? (() => new Date());
    if (this.requireProductionMode && this.isMock) {
      throw new EasyPostError("mock_forbidden_in_production", null, "requireProductionMode set without an API key");
    }
  }

  get hasWebhookSecret(): boolean {
    return !!this.webhookSecret;
  }

  private authHeader(): string {
    // EasyPost HTTP Basic auth: API key as username, empty password.
    return "Basic " + Buffer.from(`${this.apiKey}:`).toString("base64");
  }

  /** Upstream call with a timeout and no redirect-following (a provider URL must not bounce us anywhere). */
  private upstream(url: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
  }

  /** Store label bytes content-addressed; returns the CID the print leg fetches by. */
  private async storeLabel(bytes: Buffer, mediaType: string): Promise<string> {
    const store = this.blobStore ?? (await getCidBlobStorage());
    const meta = await store.put(new Uint8Array(bytes), { mediaType });
    return meta.cid;
  }

  private checkParcel(p: EasyPostParcel): void {
    if (!Number.isFinite(p.weightOz) || p.weightOz <= 0) {
      throw new EasyPostError("invalid_parcel", null, "weightOz must be > 0");
    }
    if (p.weightOz > this.maxWeightOz) {
      throw new EasyPostError("weight_exceeds_ceiling", null, `weightOz ${p.weightOz} > ceiling ${this.maxWeightOz}`);
    }
  }

  private checkParams(params: CreateLabelParams): void {
    if (!isValidDocumentHash(params.documentHash)) {
      throw new EasyPostError("invalid_document_hash", null, "documentHash must be 64 lowercase hex");
    }
    this.checkParcel(params.parcel);
  }

  /**
   * PHASE 1 — create the shipment, pick the cheapest usable USD rate, enforce
   * ceilings and provider mode, then /buy. Returns the moment EasyPost has
   * charged. The caller MUST durably record the result before phase 2.
   */
  async createAndBuy(params: CreateLabelParams): Promise<BoughtShipment> {
    this.checkParams(params);
    if (this.isMock) return this.mockBought();

    const shipmentRes = await this.upstream(`${this.baseUrl}/shipments`, {
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
    const providerMode = parseProviderMode(shipment.mode);
    if (!providerMode) {
      throw new EasyPostError("easypost_invalid_response", null, `shipment.mode missing/unknown: ${String(shipment.mode)}`);
    }
    // Decide BEFORE /buy: a test-mode shipment must never be charged-and-recorded in production.
    if (this.requireProductionMode && providerMode !== "production") {
      throw new EasyPostError("provider_mode_not_production", null, `shipment.mode=${providerMode} under requireProductionMode`);
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
      throw new EasyPostError("rate_exceeds_ceiling", null, `cheapest rate ${cheapest.usd} USD > ceiling ${this.maxRateUsd}`);
    }

    const buyRes = await this.upstream(`${this.baseUrl}/shipments/${shipment.id}/buy`, {
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
      // EasyPost has charged but returned an unusable object. Surface it as
      // its own code so the caller can record a purchase that needs manual
      // reconciliation rather than silently re-buying.
      throw new EasyPostError("easypost_bought_but_unusable", null, `bought shipment ${shipmentId} missing tracking_code/label_url`);
    }
    if (!/^https:\/\//.test(labelUrl)) {
      throw new EasyPostError("easypost_bought_but_unusable", null, `label_url is not https (shipment ${shipmentId})`);
    }
    const boughtMode = parseProviderMode(bought.mode) ?? providerMode;

    return {
      shipmentId,
      trackerId: nonEmptyString(bought.tracker?.id) ? bought.tracker!.id! : null,
      trackingCode,
      labelUrl,
      carrier: bought.selected_rate?.carrier ?? cheapest.r.carrier ?? "unknown",
      service: bought.selected_rate?.service ?? cheapest.r.service ?? "unknown",
      rate: bought.selected_rate?.rate ?? cheapest.r.rate ?? String(cheapest.usd),
      currency: bought.selected_rate?.currency ?? cheapest.r.currency ?? "USD",
      providerMode: boughtMode,
      mock: false,
    };
  }

  /**
   * PHASE 2 — download the label BYTES (size-capped, type-checked, no
   * redirects), hash + content-address them, build and sign the commitment.
   * Idempotent: safe to re-run for an already-recorded purchase.
   */
  async finalizeLabel(params: CreateLabelParams, bought: BoughtShipment): Promise<FinalizedLabel> {
    this.checkParams(params);
    let labelBytes: Buffer;
    let mediaType: string;
    if (bought.mock) {
      labelBytes = Buffer.from(`MOCK-LABEL:${bought.shipmentId}:${bought.trackingCode}`);
      mediaType = "text/plain";
    } else {
      const labelRes = await this.upstream(bought.labelUrl, { method: "GET" });
      if (!labelRes.ok) {
        throw new EasyPostError("easypost_label_download_failed", labelRes.status, await safeText(labelRes));
      }
      mediaType = (labelRes.headers.get("content-type") ?? "").split(";")[0]!.trim();
      if (!ALLOWED_LABEL_TYPES.some((re) => re.test(mediaType))) {
        throw new EasyPostError("easypost_label_unexpected_type", null, `label content-type ${mediaType || "<none>"}`);
      }
      const declared = Number(labelRes.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > this.maxLabelBytes) {
        throw new EasyPostError("easypost_label_too_large", null, `declared ${declared} > cap ${this.maxLabelBytes}`);
      }
      labelBytes = Buffer.from(await labelRes.arrayBuffer());
      if (labelBytes.length === 0) {
        throw new EasyPostError("easypost_invalid_response", null, "label download was empty");
      }
      if (labelBytes.length > this.maxLabelBytes) {
        throw new EasyPostError("easypost_label_too_large", null, `received ${labelBytes.length} > cap ${this.maxLabelBytes}`);
      }
    }
    const labelHash = sha256Hex(labelBytes);
    const labelCid = await this.storeLabel(labelBytes, mediaType);

    const body: ShipmentCommitmentBody = {
      v: 1,
      jobId: params.jobId,
      kernelId: params.kernelId,
      documentHash: params.documentHash,
      destinationHash: sha256Hex(canonicalAddressForHash(params.toAddress)),
      trackingCode: bought.trackingCode,
      shipmentId: bought.shipmentId,
      trackerId: bought.trackerId,
      carrier: bought.carrier,
      service: bought.service,
      labelHash,
      labelCid,
      providerMode: bought.providerMode,
      mock: bought.mock,
      committedAt: this.now().toISOString(),
    };
    const hash = computeCommitmentHash(body);
    const signature = this.signer ? await this.signer(body, hash) : null;
    return { labelHash, labelCid, commitment: { ...body, hash, signature } };
  }

  /** Convenience: both phases back to back. Route code uses the phases separately so the purchase is recorded between them. */
  async buyCheapestLabel(params: CreateLabelParams): Promise<CreateLabelResult> {
    const bought = await this.createAndBuy(params);
    const finalized = await this.finalizeLabel(params, bought);
    return { ...bought, ...finalized };
  }

  private mockBought(): BoughtShipment {
    const shipmentId = `shp_mock_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const trackerId = `trk_mock_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const trackingCode = `EZMOCK${hashToPositiveInt(shipmentId).toString().padStart(10, "0").slice(0, 10)}`;
    return {
      shipmentId,
      trackerId,
      trackingCode,
      labelUrl: `https://easypost-mock.invalid/labels/${shipmentId}.png`,
      carrier: "USPS",
      service: "First",
      rate: "4.50",
      currency: "USD",
      providerMode: "mock",
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
   * application layer by the persisted, transactionally-claimed
   * per-event-id ledger in carrier-shipment-store.ts.
   *
   * NOTE: EasyPost's Zendesk support article additionally references an
   * X-Hmac-Signature-V2 header with timestamp-based replay protection, but
   * that article returned HTTP 403 on every fetch attempt and its exact
   * byte-construction could not be independently verified — NOT implemented
   * here rather than guessed. Follow-up once that page is reachable.
   *
   * MUST be called with the raw request BYTES exactly as received.
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
        mode?: unknown;
        shipment_id?: unknown;
        tracking_code?: unknown;
        status?: unknown;
        status_detail?: unknown;
        carrier?: unknown;
        updated_at?: unknown;
        tracking_details?: unknown;
      };
    };
    if (!evt || typeof evt !== "object") return null;
    if (!nonEmptyString(evt.description) || !evt.description.startsWith("tracker.")) return null;
    // The event id is the replay/dedupe key — a webhook without one is not
    // processable (we would have no way to reject its replay).
    if (!nonEmptyString(evt.id)) return null;
    const r = evt.result;
    if (!r || !nonEmptyString(r.tracking_code) || !nonEmptyString(r.status)) return null;
    const occurredAt =
      nonEmptyString(r.updated_at) && !Number.isNaN(Date.parse(r.updated_at))
        ? new Date(Date.parse(r.updated_at)).toISOString()
        : null;
    if (!occurredAt) return null; // carrier timestamp is what orders events; refuse without it
    const latest = latestTrackingDetail(r.tracking_details);
    return {
      easypostEventId: evt.id,
      trackerId: nonEmptyString(r.id) ? r.id : null,
      shipmentId: nonEmptyString(r.shipment_id) ? r.shipment_id : null,
      trackingCode: r.tracking_code,
      status: r.status,
      carrier: nonEmptyString(r.carrier) ? r.carrier : null,
      statusDetail: nonEmptyString(r.status_detail) ? r.status_detail : null,
      occurredAt,
      providerMode: parseProviderMode(r.mode),
      carrierMessage: latest && nonEmptyString(latest.message) ? latest.message : null,
      trackingLocation: latest?.tracking_location ? toTrackingLocation(latest.tracking_location) : null,
    };
  }
}

interface RawTrackingDetail {
  message?: unknown;
  status?: unknown;
  datetime?: unknown;
  tracking_location?: unknown;
}

/** The most recent scan by the carrier's own datetime (falls back to array order when datetimes are missing). */
function latestTrackingDetail(details: unknown): RawTrackingDetail | null {
  if (!Array.isArray(details) || details.length === 0) return null;
  let best: RawTrackingDetail | null = null;
  let bestT = -Infinity;
  for (let i = 0; i < details.length; i++) {
    const d = details[i] as RawTrackingDetail;
    if (!d || typeof d !== "object") continue;
    const t = nonEmptyString(d.datetime) ? Date.parse(d.datetime) : NaN;
    const score = Number.isNaN(t) ? i : t;
    if (score >= bestT) {
      bestT = score;
      best = d;
    }
  }
  return best;
}

function toTrackingLocation(loc: unknown): TrackingLocation | null {
  if (!loc || typeof loc !== "object") return null;
  const l = loc as Record<string, unknown>;
  const pick = (k: string) => (nonEmptyString(l[k]) ? (l[k] as string) : null);
  const out = { city: pick("city"), state: pick("state"), country: pick("country"), zip: pick("zip") };
  return out.city || out.state || out.country || out.zip ? out : null;
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
      requireProductionMode: process.env.NODE_ENV === "production",
      signer: defaultSigner,
    });
  }
  return singleton;
}

/** Test-only: force getEasyPostClient() to return a specific instance (e.g. one with a stub fetchImpl). */
export function _setEasyPostClientForTests(client: EasyPostClient | undefined): void {
  testOverride = client;
}
