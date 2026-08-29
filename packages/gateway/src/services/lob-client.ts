/**
 * Lob carrier client — prints AND mails a letter via Lob's print-and-mail
 * API (the second operator behind the identical print-and-mail contract:
 * demo-print-and-mail.md §2, "THE TWO-OPERATOR PROOF").
 *
 * The point of this module is that it emits the SAME ShipmentCommitment and
 * the SAME tracker-event shape as the EasyPost/human leg — imported from
 * easypost-client.ts, not re-declared — so the oracle's verdict program
 * needs no operator-specific branch. Same contract, same evidence types,
 * same oracle. (This branch is stacked on feat/carrier-integration for
 * exactly that reason.)
 *
 * WHY LOB'S TRACKING QUALIFIES (research note ai/research/lob-second-
 * operator.md, sources: help.lob.com tracking-your-mail / using-webhooks):
 * every US mail piece Lob prints carries a unique Intelligent Mail Barcode;
 * In Transit / In Local Area / Processed for Delivery / Delivered /
 * Re-routed / Returned to Sender are USPS-SCAN-DERIVED events on plain
 * First Class — carrier-attributed, not Lob-self-attested. (Received /
 * In Production / Mailed are Lob-attested and map to no-op statuses here.)
 *
 * PROVIDER MODE: unlike EasyPost, Lob DOCUMENTS its key prefixes — test_
 * and live_ (docs.lob.com authentication; per-environment key pairs). Mode
 * is derived from the key prefix, fail-closed on an unrecognized prefix.
 * Webhook environment comes from which secret verified the signature: Lob
 * webhooks are configured per environment with distinct secrets, and — per
 * the research note — tracking events DO NOT EXIST in Lob's Test
 * Environment, so a test-key deployment can prove creation/render/webhook
 * plumbing but never the carrier-scan leg. That limit is surfaced, never
 * blurred: providerMode rides in the commitment and evidence exactly as it
 * does for EasyPost.
 *
 * CHARGE SEMANTICS: Lob's POST /v1/letters is a SINGLE atomic
 * create-and-charge that honors an Idempotency-Key header (24h window,
 * Lob-documented). Passing the jobId as the idempotency key makes retries
 * provider-side idempotent — the entire reserve/buy_in_flight/recovery
 * machinery EasyPost required (sol #297 R3-1/R4/R5) collapses to "same key,
 * same letter". The store's reservation still guards concurrent local
 * requests; ambiguous outcomes recover by re-POSTing with the SAME key.
 *
 * WEBHOOK AUTH (help.lob.com using-webhooks): Lob-Signature = hex
 * HMAC-SHA256(secret, `${Lob-Signature-Timestamp}.${rawBody}`), timing-safe
 * compare, recommended 5-minute timestamp tolerance — timestamp-bound and
 * therefore replay-resistant at the transport layer, STRONGER than
 * EasyPost's body-only v1 scheme; the persisted event-id ledger still
 * applies on top.
 */

import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { getCidBlobStorage, type ICidBlobStorage } from "./cid-blob-storage.js";
import {
  EasyPostError as CarrierError,
  computeCommitmentHash,
  canonicalAddressForHash,
  sha256Hex,
  type CommitmentSigner,
  type CreateLabelParams,
  type EasyPostAddress,
  type FinalizedLabel,
  type ProviderMode,
  type ShipmentCommitmentBody,
  type TrackerWebhookEvent,
  type TrackingLocation,
} from "./easypost-client.js";

export { CarrierError };

/** Parameters for a Lob letter: the shared address/document identity plus the document bytes Lob is to print. */
export interface CreateLetterParams extends Omit<CreateLabelParams, "parcel"> {
  /** The PDF to print and mail, base64. Its sha256 MUST equal documentHash — verified here, fail closed. */
  documentPdfB64: string;
  /** Lob use_type; PCC print-and-mail jobs are operational mail. */
  useType?: "operational" | "marketing";
}

/** Result of the single-phase create-and-charge, in the carrier-shared vocabulary. */
export interface CreatedLetter {
  /** Lob letter id (ltr_...) — the shipment identity. */
  letterId: string;
  /**
   * USPS tracking number when Lob assigns one; for plain First Class the
   * scan webhooks key on the LETTER id, so that is the tracking identity.
   */
  trackingCode: string;
  carrier: string;
  service: string;
  expectedDeliveryDate: string | null;
  /** Signed URL of the rendered artifact Lob will print (fetched + content-addressed in finalize). */
  renderedPdfUrl: string;
  providerMode: ProviderMode;
  mock: boolean;
}

export type CreateLetterResult = CreatedLetter & FinalizedLabel;

/** Lob's letter tracking-event ids -> the shared tracker-status vocabulary the store's lattice consumes. */
export const LOB_EVENT_STATUS_MAP: Readonly<Record<string, string>> = {
  // USPS-scan-derived (carrier-attributed) — the ones that move the lattice:
  "letter.in_transit": "in_transit",
  "letter.in_local_area": "in_transit",
  "letter.processed_for_delivery": "out_for_delivery",
  "letter.delivered": "delivered",
  "letter.returned_to_sender": "return_to_sender",
  "letter.re_routed": "in_transit",
  "letter.international_exit": "in_transit",
  // Lob-attested lifecycle (print side) — no-op for the mail lattice:
  "letter.created": "pre_transit",
  "letter.rendered_pdf": "pre_transit",
  "letter.rendered_thumbnails": "pre_transit",
  "letter.in_production": "pre_transit",
  "letter.mailed": "pre_transit",
};

export interface LobClientConfig {
  apiKey?: string;
  webhookSecret?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Refuse letters priced above this (USD). Default 10 — a letter, not a parcel. */
  maxLetterUsd?: number;
  /** Refuse to create letters, or accept webhooks, outside a live_ environment. Set in production boot. */
  requireProductionMode?: boolean;
  /** Webhook timestamp tolerance (ms). Lob recommends 5 minutes. */
  webhookToleranceMs?: number;
  timeoutMs?: number;
  maxPdfBytes?: number;
  signer?: CommitmentSigner;
  blobStore?: ICidBlobStorage;
  now?: () => Date;
}

const DEFAULT_MAX_LETTER_USD = 10;
const DEFAULT_TOLERANCE_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PDF_BYTES = 10 * 1024 * 1024;
const ALLOWED_RENDER_TYPES: ReadonlySet<string> = new Set(["application/pdf"]);
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Lob-documented key prefixes: test_ / live_. Anything else (with a key
 * present) is refused rather than guessed — an unclassifiable environment
 * must never mint evidence.
 */
export function providerModeFromLobKey(apiKey: string | undefined): ProviderMode {
  if (!apiKey) return "mock";
  if (apiKey.startsWith("live_")) return "production";
  if (apiKey.startsWith("test_")) return "test";
  throw new CarrierError("lob_key_unrecognized", null, "Lob keys begin with test_ or live_; refusing to classify this one");
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 2000);
  } catch {
    return "<unreadable body>";
  }
}

function addressToLob(a: EasyPostAddress) {
  return {
    name: a.name,
    address_line1: a.street1,
    address_line2: a.street2,
    address_city: a.city,
    address_state: a.state,
    address_zip: a.zip,
    address_country: a.country ?? "US",
  };
}

interface LobLetter {
  id?: string;
  tracking_number?: string | null;
  carrier?: string;
  url?: string;
  expected_delivery_date?: string;
  mail_type?: string;
}

export class LobClient {
  readonly isMock: boolean;
  readonly providerMode: ProviderMode;
  readonly maxLetterUsd: number;
  readonly requireProductionMode: boolean;
  private readonly apiKey: string;
  private readonly webhookSecret: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly toleranceMs: number;
  private readonly timeoutMs: number;
  private readonly maxPdfBytes: number;
  private readonly signer: CommitmentSigner | undefined;
  private readonly blobStore: ICidBlobStorage | undefined;
  private readonly now: () => Date;

  constructor(config: LobClientConfig = {}) {
    this.providerMode = providerModeFromLobKey(config.apiKey);
    this.isMock = this.providerMode === "mock";
    this.apiKey = config.apiKey ?? "mock";
    this.webhookSecret = config.webhookSecret;
    this.baseUrl = config.baseUrl ?? "https://api.lob.com/v1";
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.maxLetterUsd = config.maxLetterUsd ?? DEFAULT_MAX_LETTER_USD;
    this.requireProductionMode = config.requireProductionMode ?? false;
    this.toleranceMs = config.webhookToleranceMs ?? DEFAULT_TOLERANCE_MS;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPdfBytes = config.maxPdfBytes ?? DEFAULT_MAX_PDF_BYTES;
    this.signer = config.signer;
    this.blobStore = config.blobStore;
    this.now = config.now ?? (() => new Date());
    if (this.requireProductionMode && this.providerMode !== "production") {
      // Pre-charge, structural: a mock or test_ environment can never mint
      // authentic evidence, so production refuses to construct at all —
      // including the documented no-tracking-events-in-test limitation.
      throw new CarrierError("provider_mode_not_production", null, `Lob providerMode=${this.providerMode} under requireProductionMode`);
    }
  }

  get hasWebhookSecret(): boolean {
    return !!this.webhookSecret;
  }

  private authHeader(): string {
    // Lob HTTP Basic auth: API key as username, empty password.
    return "Basic " + Buffer.from(`${this.apiKey}:`).toString("base64");
  }

  private upstream(url: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
  }

  private async storeArtifact(bytes: Buffer, mediaType: string): Promise<string> {
    const store = this.blobStore ?? (await getCidBlobStorage());
    const meta = await store.put(new Uint8Array(bytes), { mediaType });
    return meta.cid;
  }

  private checkParams(params: CreateLetterParams): Buffer {
    if (!nonEmptyString(params.documentHash) || !HEX64.test(params.documentHash)) {
      throw new CarrierError("invalid_document_hash", null, "documentHash must be 64 lowercase hex");
    }
    if (!nonEmptyString(params.documentPdfB64)) {
      throw new CarrierError("invalid_document", null, "documentPdfB64 is required — Lob prints what we send, so we must know exactly what that is");
    }
    const pdf = Buffer.from(params.documentPdfB64, "base64");
    if (pdf.length === 0 || pdf.length > this.maxPdfBytes) {
      throw new CarrierError("invalid_document", null, `document is empty or exceeds ${this.maxPdfBytes} bytes`);
    }
    // The commitment binds documentHash; Lob prints these bytes. If they do
    // not hash to documentHash, the claim "Lob printed THE document" would be
    // false at the moment of purchase. Fail closed, pre-charge.
    const actual = sha256Hex(pdf);
    if (actual !== params.documentHash) {
      throw new CarrierError("document_hash_mismatch", null, `documentHash=${params.documentHash} but bytes hash to ${actual}`);
    }
    return pdf;
  }

  /**
   * SINGLE-PHASE create-and-charge. Idempotency-Key = jobId (Lob-documented,
   * 24h window): a retry after an ambiguous outcome re-POSTs with the SAME
   * key and receives the SAME letter — the provider is the recovery
   * mechanism, so there is no separate lookup/reconcile split here. The
   * caller still records buy_in_flight before dispatch so a crash mid-call
   * is recovered by the idempotent retry, never by a guess.
   */
  async createLetter(params: CreateLetterParams): Promise<CreatedLetter> {
    const pdf = this.checkParams(params);
    if (this.isMock) return this.mockCreated(params);

    const res = await this.upstream(`${this.baseUrl}/letters`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
        "Idempotency-Key": params.jobId,
      },
      body: JSON.stringify({
        description: `pcc:${params.jobId}`,
        to: addressToLob(params.toAddress),
        from: addressToLob(params.fromAddress),
        file: `data:application/pdf;base64,${pdf.toString("base64")}`,
        color: false,
        use_type: params.useType ?? "operational",
      }),
    });
    if (!res.ok) {
      throw new CarrierError("lob_create_letter_failed", res.status, await safeText(res));
    }
    const letter = (await res.json()) as LobLetter;
    if (!nonEmptyString(letter.id)) {
      throw new CarrierError("lob_invalid_response", null, "letter.id missing after create — charge state unknown; retry with the same Idempotency-Key");
    }
    if (!nonEmptyString(letter.url) || !/^https:\/\//.test(letter.url)) {
      throw new CarrierError("lob_created_but_unusable", null, `letter ${letter.id} has no usable rendered url`);
    }
    return {
      letterId: letter.id,
      trackingCode: nonEmptyString(letter.tracking_number) ? letter.tracking_number : letter.id,
      carrier: nonEmptyString(letter.carrier) ? letter.carrier : "USPS",
      service: letter.mail_type === "usps_standard" ? "usps_standard" : "usps_first_class",
      expectedDeliveryDate: nonEmptyString(letter.expected_delivery_date) ? letter.expected_delivery_date : null,
      renderedPdfUrl: letter.url,
      providerMode: this.providerMode,
      mock: false,
    };
  }

  /**
   * Finalize: fetch the RENDERED artifact (what Lob will actually print),
   * hash + content-address it, and build the SAME ShipmentCommitmentBody the
   * EasyPost leg builds — labelHash/labelCid bind the rendered bytes, so
   * "hash of what was printed" is checkable on this leg too.
   */
  async finalizeLetter(params: CreateLetterParams, created: CreatedLetter): Promise<FinalizedLabel> {
    this.checkParams(params);
    let artifact: Buffer;
    let mediaType: string;
    if (created.mock) {
      artifact = Buffer.from(`MOCK-LOB-LETTER:${created.letterId}:${params.documentHash}`);
      mediaType = "application/pdf";
    } else {
      const res = await this.upstream(created.renderedPdfUrl, { method: "GET" });
      if (!res.ok) {
        throw new CarrierError("lob_render_download_failed", res.status, await safeText(res));
      }
      mediaType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!ALLOWED_RENDER_TYPES.has(mediaType)) {
        throw new CarrierError("lob_render_unexpected_type", null, `rendered content-type ${mediaType || "<none>"}`);
      }
      artifact = await this.readCapped(res);
      if (artifact.length === 0) {
        throw new CarrierError("lob_invalid_response", null, "rendered download was empty");
      }
    }
    const labelHash = sha256Hex(artifact);
    const labelCid = await this.storeArtifact(artifact, mediaType);

    const body: ShipmentCommitmentBody = {
      v: 1,
      jobId: params.jobId,
      kernelId: params.kernelId,
      documentHash: params.documentHash,
      destinationHash: sha256Hex(canonicalAddressForHash(params.toAddress)),
      trackingCode: created.trackingCode,
      shipmentId: created.letterId,
      trackerId: null,
      carrier: created.carrier,
      service: created.service,
      labelHash,
      labelCid,
      providerMode: created.providerMode,
      mock: created.mock,
      committedAt: this.now().toISOString(),
    };
    const hash = computeCommitmentHash(body);
    const signature = this.signer ? await this.signer(body, hash) : null;
    return { labelHash, labelCid, commitment: { ...body, hash, signature } };
  }

  private async readCapped(res: Response): Promise<Buffer> {
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxPdfBytes) {
      throw new CarrierError("lob_render_too_large", null, `declared ${declared} > cap ${this.maxPdfBytes}`);
    }
    const body = res.body as ReadableStream<Uint8Array> | null;
    if (!body) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > this.maxPdfBytes) throw new CarrierError("lob_render_too_large", null, `received ${buf.length} > cap ${this.maxPdfBytes}`);
      return buf;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > this.maxPdfBytes) {
            await reader.cancel().catch(() => {});
            throw new CarrierError("lob_render_too_large", null, `streamed ${total} > cap ${this.maxPdfBytes}`);
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }

  private mockCreated(params: CreateLetterParams): CreatedLetter {
    const letterId = `ltr_mock_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    return {
      letterId,
      trackingCode: letterId,
      carrier: "USPS",
      service: "usps_first_class",
      expectedDeliveryDate: null,
      renderedPdfUrl: `https://lob-mock.invalid/letters/${letterId}.pdf`,
      providerMode: "mock",
      mock: true,
    };
  }

  /**
   * Verifies Lob's webhook signature: Lob-Signature = hex(HMAC-SHA256(secret,
   * `${Lob-Signature-Timestamp}.${rawBody}`)), timing-safe, with a timestamp
   * tolerance window (replay-resistant at the transport layer — the
   * timestamp is INSIDE the MAC, unlike EasyPost's v1 scheme). Fails closed
   * on a missing secret, header, timestamp, or a stale timestamp.
   */
  verifyWebhookSignature(
    rawBody: Buffer | string,
    signatureHeader: string | undefined | null,
    timestampHeader: string | undefined | null,
  ): boolean {
    if (!this.webhookSecret) return false;
    if (!signatureHeader || !timestampHeader) return false;
    const tsNum = Number(timestampHeader);
    const tsMs = Number.isFinite(tsNum)
      ? // Lob sends epoch millis; accept seconds too (defensive) by magnitude.
        tsNum > 10_000_000_000 ? tsNum : tsNum * 1000
      : Date.parse(timestampHeader);
    if (Number.isNaN(tsMs)) return false;
    if (Math.abs(this.now().getTime() - tsMs) > this.toleranceMs) return false;

    const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
    const digest = createHmac("sha256", this.webhookSecret)
      .update(`${timestampHeader}.`)
      .update(bytes)
      .digest("hex");
    const a = Buffer.from(digest, "utf8");
    const b = Buffer.from(signatureHeader, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Parses a Lob webhook body into the SHARED TrackerWebhookEvent shape (the
   * `easypostEventId` field carries the provider event id generically). The
   * tracking identity is the LETTER id (or its tracking number when the
   * letter carries one and the store indexed it). providerMode is this
   * client's own environment: Lob webhooks are configured per environment
   * with distinct secrets, so the verifying secret IS the env attestation.
   */
  parseLetterEvent(body: unknown): TrackerWebhookEvent | null {
    const evt = body as {
      id?: unknown;
      event_type?: { id?: unknown };
      body?: { id?: unknown; tracking_number?: unknown; expected_delivery_date?: unknown } & Record<string, unknown>;
      date_created?: unknown;
    };
    if (!evt || typeof evt !== "object") return null;
    const typeId = evt.event_type?.id;
    if (!nonEmptyString(typeId) || !typeId.startsWith("letter.")) return null;
    if (!nonEmptyString(evt.id)) return null; // provider event id = the replay/dedupe key
    const letter = evt.body;
    if (!letter || !nonEmptyString(letter.id)) return null;
    const status = LOB_EVENT_STATUS_MAP[typeId];
    if (!status) return null; // unknown letter.* event: not processable, never guessed
    const occurredAt =
      nonEmptyString(evt.date_created) && !Number.isNaN(Date.parse(evt.date_created))
        ? new Date(Date.parse(evt.date_created)).toISOString()
        : null;
    if (!occurredAt) return null;

    // Location: Lob tracking events may carry {location: "ZIP or city"} on
    // the event body; surfaced when present, never fabricated.
    const rawLoc = (letter as Record<string, unknown>).location;
    const trackingLocation: TrackingLocation | null = nonEmptyString(rawLoc)
      ? { city: null, state: null, country: null, zip: /^\d{5}(-\d{4})?$/.test(rawLoc) ? rawLoc : null }
      : null;

    return {
      easypostEventId: evt.id, // generic provider event id (field name is historical)
      trackerId: null,
      shipmentId: letter.id,
      trackingCode: nonEmptyString(letter.tracking_number) ? letter.tracking_number : letter.id,
      status,
      carrier: "USPS",
      statusDetail: typeId,
      occurredAt,
      providerMode: this.providerMode === "mock" ? null : this.providerMode,
      carrierMessage: nonEmptyString(rawLoc) ? `Lob ${typeId} at ${rawLoc}` : null,
      trackingLocation,
    };
  }
}

let singleton: LobClient | undefined;
let testOverride: LobClient | undefined;
let defaultSigner: CommitmentSigner | undefined;

export function setDefaultLobCommitmentSigner(signer: CommitmentSigner | undefined): void {
  defaultSigner = signer;
  singleton = undefined;
}

export function getLobClient(): LobClient {
  if (testOverride) return testOverride;
  if (!singleton) {
    const maxLetter = Number(process.env.LOB_MAX_LETTER_USD);
    singleton = new LobClient({
      apiKey: process.env.LOB_API_KEY,
      webhookSecret: process.env.LOB_WEBHOOK_SECRET,
      maxLetterUsd: Number.isFinite(maxLetter) && maxLetter > 0 ? maxLetter : undefined,
      requireProductionMode: process.env.NODE_ENV === "production",
      signer: defaultSigner,
    });
  }
  return singleton;
}

export function _setLobClientForTests(client: LobClient | undefined): void {
  testOverride = client;
}
