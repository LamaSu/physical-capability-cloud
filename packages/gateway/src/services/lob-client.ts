/**
 * Lob print-and-mail client — creates real letters via Lob's REST API
 * (https://api.lob.com/v1, Letters endpoint) and verifies inbound webhook
 * signatures. Lob is a SECOND operator for the same document.print-and-mail
 * contract the human/USPS leg (EasyPost, PR #297) fulfils: a job can route to
 * either, and the buyer agent should not be able to tell which mailed it.
 *
 * No SDK dependency: Lob's API is a handful of plain REST calls, and a raw
 * fetch() keeps the new-dependency surface (and Gate A scope) at zero. Auth is
 * HTTP Basic with the API key as username, empty password — confirmed from the
 * Lob OpenAPI (`components.securitySchemes.basicAuth`) and every `-u <KEY>:`
 * code sample. Identical convention to easypost-client.ts.
 *
 * Mock mode (no LOB_API_KEY set): synthesizes a letter locally so the gateway
 * boots and the route contract is testable with ZERO external calls. Every
 * field it produces is fabricated-by-design and the result carries
 * `simulated: true`, which flows straight to `EvidenceEvent.source.simulated`
 * so detector layers treat it as non-authentic. This is NOT Lob's own test
 * mode (a `test_...` key still hits the real API) — it's this codebase's
 * "no credential configured at all" convention, matching easypost-client.ts /
 * fiat-ramp.ts.
 *
 * ---------------------------------------------------------------------------
 * ASSURANCE ASYMMETRY — read before trusting a Lob "delivered" event.
 * ---------------------------------------------------------------------------
 * The human/USPS leg pre-buys a USPS-issued label, commits {jobId,
 * destinationHash, trackingCode, labelHash} BEFORE the envelope reaches a
 * human, and then an INDEPENDENT USPS acceptance scan — keyed by that same
 * USPS tracking code — closes the pre-committed claim. The confirmer (USPS) is
 * not the operator.
 *
 * Lob is printer AND mailer AND the webhook emitter. `letter.mailed` is Lob
 * ASSERTING it handed the piece to USPS; there is no upstream commitment that
 * an independent party later confirms. Standard Lob letters have
 * `tracking_number: null`, so the only identifier shared between our
 * commitment and Lob's confirmation is Lob's OWN `ltr_` id, confirmed by Lob's
 * OWN webhook — the whole loop is inside one operator. `letter.delivered` is
 * typically Lob's expected/estimated delivery, not a guaranteed USPS scan.
 *
 * So: Lob evidence is OPERATOR SELF-REPORT — strictly weaker than a USPS scan
 * against a pre-committed label (a real `AssuranceTier` gap; tiers are 0|1|2|3
 * in @pcc/spec). We still compute a creation-time `commitment` because binding
 * job -> letter -> destination -> document (via fileHash) is better than
 * nothing and matches the carrier shape, but we DO NOT pretend the
 * confirmation is independent. Elevating this leg to the human leg's tier would
 * require certified/registered mail (a real USPS tracking_number) or an
 * out-of-band scan — neither is assumed here.
 *
 * Webhook signature algorithm read from Lob's Webhooks Integration Guide
 * (help.lob.com/print-and-mail/getting-data-and-results/using-webhooks), not
 * guessed — see ai/research/lob-webhook-signature-notes.md for the verbatim
 * steps.
 */

import { randomUUID, createHmac, timingSafeEqual, createHash } from "node:crypto";

/** A postal address in this client's friendly shape; mapped to Lob's snake_case wire fields on send. */
export interface LobAddress {
  name: string;
  addressLine1: string;
  addressLine2?: string;
  addressCity: string;
  addressState: string;
  addressZip: string;
  addressCountry?: string; // default "US"
}

export interface CreateLetterParams {
  jobId: string;
  to: LobAddress;
  from: LobAddress;
  /**
   * The letter contents Lob will print — an HTML string, a remote URL to an
   * HTML/PDF, or a Lob template id (`tmpl_...`). This is Lob's required `file`
   * param, and it is what `commitment.fileHash` binds the job to.
   */
  file: string;
  /** Color vs black & white. Lob requires this; defaults to false (B&W). */
  color?: boolean;
  doubleSided?: boolean;
  description?: string;
  /**
   * Lob requires `use_type`. A document printed and mailed to fulfil a job is
   * transactional, so we default to "operational" (not "marketing").
   */
  useType?: "operational" | "marketing";
  mailType?: "usps_first_class" | "usps_standard";
}

/**
 * Computed at letter-creation time, BEFORE any mailed/delivered event. Binds
 * this PCC job to this Lob letter, this destination, and this document.
 *
 * Weaker than easypost-client.ts's ShipmentCommitment in one specific,
 * unavoidable way: there is no USPS-issued tracking code shared with an
 * independent confirmer, so `lobLetterId` (Lob's own id) is the only handle
 * the later — Lob-emitted — events reference. The commitment prevents "some
 * unrelated letter got mailed" confusion; it does NOT make Lob's self-report
 * independently checkable. See the file header.
 */
export interface LetterCommitment {
  /** SHA-256 hex of jobId + destinationHash + lobLetterId + fileHash + committedAt. */
  hash: string;
  jobId: string;
  destinationHash: string;
  lobLetterId: string;
  fileHash: string;
  committedAt: string;
}

export interface CreateLetterResult {
  lobLetterId: string;
  carrier: string; // usually "USPS"
  /** null for standard letters — Lob only issues a real USPS tracking_number for certified/registered mail. */
  trackingNumber: string | null;
  expectedDeliveryDate: string | null;
  /** Lob's PDF proof URL for the rendered letter. */
  url: string;
  commitment: LetterCommitment;
  /** True in mock mode (no LOB_API_KEY). Flows to EvidenceEvent.source.simulated. */
  simulated: boolean;
}

/** A normalized Lob letter event, extracted from an inbound Event webhook body. */
export interface LobLetterEvent {
  /** Lob's `evt_...` id — the idempotency key for webhook retries. */
  lobEventId: string;
  /** e.g. "letter.created" | "letter.rendered_pdf" | "letter.mailed" | "letter.in_transit" | "letter.delivered". */
  eventType: string;
  /** The `ltr_...` id this event is about (Lob `reference_id` / `body.id`). */
  lobLetterId: string;
  trackingNumber: string | null;
  carrier: string | null;
  expectedDeliveryDate: string | null;
  occurredAt: string;
}

export interface LobClientConfig {
  apiKey?: string;
  webhookSecret?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

function canonicalAddressForHash(a: LobAddress): string {
  // Field order fixed on purpose — this string is hashed, order must be stable.
  return [
    a.name,
    a.addressLine1,
    a.addressLine2 ?? "",
    a.addressCity,
    a.addressState,
    a.addressZip,
    a.addressCountry ?? "US",
  ]
    .map((s) => s.trim().toLowerCase())
    .join("|");
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function buildCommitment(params: CreateLetterParams, lobLetterId: string): LetterCommitment {
  const destinationHash = sha256Hex(canonicalAddressForHash(params.to));
  const fileHash = sha256Hex(params.file);
  const committedAt = new Date().toISOString();
  const hash = sha256Hex(
    [params.jobId, destinationHash, lobLetterId, fileHash, committedAt].join("|"),
  );
  return { hash, jobId: params.jobId, destinationHash, lobLetterId, fileHash, committedAt };
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

/** Maps this client's friendly address shape to Lob's snake_case wire fields. */
function addressToLob(a: LobAddress) {
  return {
    name: a.name,
    address_line1: a.addressLine1,
    address_line2: a.addressLine2,
    address_city: a.addressCity,
    address_state: a.addressState,
    address_zip: a.addressZip,
    address_country: a.addressCountry ?? "US",
  };
}

interface LobLetterResponse {
  id?: string;
  carrier?: string;
  tracking_number?: string | null;
  expected_delivery_date?: string | null;
  url?: string;
  object?: string;
}

export class LobClient {
  readonly isMock: boolean;
  private readonly apiKey: string;
  private readonly webhookSecret: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: LobClientConfig = {}) {
    this.isMock = !config.apiKey;
    this.apiKey = config.apiKey ?? "mock";
    this.webhookSecret = config.webhookSecret;
    this.baseUrl = config.baseUrl ?? "https://api.lob.com/v1";
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  get hasWebhookSecret(): boolean {
    return !!this.webhookSecret;
  }

  private authHeader(): string {
    // Lob HTTP Basic auth: API key as username, empty password.
    return "Basic " + Buffer.from(`${this.apiKey}:`).toString("base64");
  }

  /**
   * Creates a letter. Real mode POSTs one JSON request to `/letters`; mock mode
   * fabricates an equivalent, clearly-marked-simulated result with zero network
   * calls. The commitment is computed after the letter id exists (Lob assigns
   * it) in both modes.
   */
  async createLetter(params: CreateLetterParams): Promise<CreateLetterResult> {
    if (this.isMock) return this.createMockLetter(params);

    // Lob's create-letter endpoint accepts application/json (confirmed from the
    // OpenAPI requestBody; form-encoded/multipart are alternatives we don't
    // need since `file` is an HTML string / URL / template id, not an upload).
    const res = await this.fetchImpl(`${this.baseUrl}/letters`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
        // Lob honors Idempotency-Key for 24h: a retry after a timeout-after-charge,
        // or a re-POST after a gateway restart wiped the in-memory store, returns the
        // SAME letter instead of charging twice. The jobId is the natural key — one
        // job, one letter, one charge (carrier audit L4; money-path double-charge class).
        "Idempotency-Key": params.jobId,
      },
      body: JSON.stringify({
        to: addressToLob(params.to),
        from: addressToLob(params.from),
        file: params.file,
        color: params.color ?? false,
        double_sided: params.doubleSided,
        description: params.description,
        use_type: params.useType ?? "operational",
        mail_type: params.mailType,
      }),
    });
    if (!res.ok) {
      throw new Error(`lob_create_letter_failed: ${res.status} ${await safeText(res)}`);
    }
    const letter = (await res.json()) as LobLetterResponse;
    if (!letter.id) {
      throw new Error("lob_create_letter_no_id: letter created but no id returned");
    }
    return {
      lobLetterId: letter.id,
      carrier: letter.carrier ?? "USPS",
      trackingNumber: letter.tracking_number ?? null,
      expectedDeliveryDate: letter.expected_delivery_date ?? null,
      url: letter.url ?? "",
      commitment: buildCommitment(params, letter.id),
      simulated: false,
    };
  }

  private createMockLetter(params: CreateLetterParams): CreateLetterResult {
    const lobLetterId = `ltr_mock_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    // Mock delivery estimate: a plausible +5 days, purely fabricated. Marked
    // simulated, so no layer should read it as a real Lob estimate.
    const eta = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return {
      lobLetterId,
      carrier: "USPS",
      // Honest: standard Lob letters carry no USPS tracking number, so mock
      // mode returns null rather than fabricating a fake one.
      trackingNumber: null,
      expectedDeliveryDate: eta,
      url: `https://lob-mock.invalid/letters/${lobLetterId}.pdf`,
      commitment: buildCommitment(params, lobLetterId),
      simulated: true,
    };
  }

  /**
   * Verifies a Lob webhook signature — Steps 1-3 of Lob's Webhooks Integration
   * Guide (read, not guessed; see ai/research/lob-webhook-signature-notes.md):
   *
   *   signatureInput = `${Lob-Signature-Timestamp}.${rawBody}`   (Step 1)
   *   expected       = hex( HMAC-SHA256(key = webhookSecret, msg = signatureInput) )  (Step 2)
   *   valid          = timingSafeEqual(expected, `Lob-Signature` header)  (Step 3)
   *
   * Both the timestamp header and the raw body are REQUIRED — the timestamp is
   * part of the signed input, and re-serializing a parsed body can byte-differ
   * from what Lob signed and would make a genuine webhook fail. Fails closed:
   * with no configured secret this always returns false, never "verified ok".
   * (Step 4, the replay/timestamp-freshness check, is `isReplay` below.)
   */
  verifyWebhookSignature(
    // Buffer preferred: the MAC must cover the EXACT bytes received. (Widened
    // from string when this route unified with carrier.ts's Buffer rawBody
    // augmentation after PR #297 merged in — a string template would coerce a
    // Buffer lossily on invalid UTF-8, so the MAC is built incrementally.)
    rawBody: Buffer | string,
    signatureHeader: string | undefined | null,
    timestampHeader: string | undefined | null,
  ): boolean {
    if (!this.webhookSecret) {
      // No secret configured: nothing to verify against. Fail closed — the
      // caller must treat this as "not verified", never as "verified ok".
      return false;
    }
    if (!signatureHeader || !timestampHeader) return false;

    const bodyBytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
    const expected = createHmac("sha256", this.webhookSecret)
      .update(`${timestampHeader}.`, "utf8")
      .update(bodyBytes)
      .digest("hex");

    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signatureHeader, "utf8");
    if (a.length !== b.length) return false; // timingSafeEqual requires equal-length buffers
    return timingSafeEqual(a, b);
  }

  /**
   * Step 4 (optional in Lob's guide, enforced here): is this a stale/replayed
   * timestamp? Returns true ONLY when it can PROVE the `Lob-Signature-Timestamp`
   * is older than `toleranceMs` (Lob recommends 5 minutes). When the timestamp
   * cannot be parsed, returns false (do not reject) — authenticity is already
   * guaranteed by the HMAC over the timestamp, so freshness enforcement is
   * defense-in-depth, not the security boundary.
   *
   * Lob's guide states the timestamp is sent "as a string" but does not pin the
   * epoch unit, so we detect seconds vs milliseconds by magnitude and also
   * accept an ISO-8601 date, to avoid false replay rejections of genuine
   * webhooks.
   */
  isReplay(
    timestampHeader: string | undefined | null,
    opts: { toleranceMs?: number; now?: number } = {},
  ): boolean {
    const toleranceMs = opts.toleranceMs ?? 5 * 60 * 1000;
    const now = opts.now ?? Date.now();
    const ms = parseTimestampMs(timestampHeader);
    if (ms === null) return false; // unparseable -> cannot prove staleness -> don't reject
    return now - ms > toleranceMs;
  }

  /**
   * Extracts the fields this integration needs from a parsed Lob Event webhook
   * body. Returns null for anything that is not a `letter.*` event about a
   * letter we can identify.
   */
  parseLetterEvent(body: unknown): LobLetterEvent | null {
    const evt = body as {
      id?: string;
      event_type?: { id?: string };
      reference_id?: string;
      date_created?: string;
      body?: {
        id?: string;
        tracking_number?: string | null;
        carrier?: string | null;
        expected_delivery_date?: string | null;
      };
    };
    if (!evt || typeof evt !== "object") return null;
    const eventType = evt.event_type?.id;
    if (!eventType || !eventType.startsWith("letter.")) return null;
    const lobLetterId = evt.reference_id ?? evt.body?.id;
    if (!lobLetterId) return null;
    return {
      lobEventId: evt.id ?? randomUUID(),
      eventType,
      lobLetterId,
      trackingNumber: evt.body?.tracking_number ?? null,
      carrier: evt.body?.carrier ?? null,
      expectedDeliveryDate: evt.body?.expected_delivery_date ?? null,
      occurredAt: evt.date_created ?? new Date().toISOString(),
    };
  }
}

/** Parse a Lob-Signature-Timestamp string to epoch ms, or null if unparseable. */
function parseTimestampMs(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    // Heuristic: 13-digit ~ ms since epoch; 10-digit ~ seconds. Anything with
    // fewer than ~12 digits is treated as seconds.
    return trimmed.length >= 12 ? n : n * 1000;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

let singleton: LobClient | undefined;
let singletonConfigGen: string | undefined;
let testOverride: LobClient | undefined;

/**
 * Lob DOCUMENTS its key prefixes (unlike EasyPost): `live_...` hits production,
 * `test_...` hits Lob's Test Environment (real API, sandbox data, no tracking
 * events for letters). Anything else is either mock (no key at all — this
 * codebase's convention) or UNRECOGNIZED, which production must refuse rather
 * than guess (carrier audit L3: a test_ key in production is sandbox-as-real).
 */
export function lobKeyMode(key: string | undefined): "live" | "test" | "mock" | "unknown" {
  if (!key) return "mock";
  if (key.startsWith("live_")) return "live";
  if (key.startsWith("test_")) return "test";
  return "unknown";
}

export function getLobClient(): LobClient {
  if (testOverride) return testOverride;
  // Config-generation tracking (same fix as the EasyPost client, sol #316 re-review
  // row 3b): a rotated key or webhook secret must retire the cached client at the
  // next call — a stale singleton would keep verifying webhooks against the RETIRED
  // secret while request gates read the new environment.
  const gen = `${process.env.LOB_API_KEY ?? ""} ${process.env.LOB_WEBHOOK_SECRET ?? ""}`;
  if (singleton && singletonConfigGen !== gen) singleton = undefined;
  if (!singleton) {
    singleton = new LobClient({
      apiKey: process.env.LOB_API_KEY,
      webhookSecret: process.env.LOB_WEBHOOK_SECRET,
    });
    singletonConfigGen = gen;
  }
  return singleton;
}

/** Test-only: force getLobClient() to return a specific instance (e.g. one with a stub fetchImpl). */
export function _setLobClientForTests(client: LobClient | undefined): void {
  testOverride = client;
}
