/**
 * IntentCollectorClient — embeddable capture client for any agent app.
 *
 * Lifecycle:
 *   1. Caller constructs once at app boot with apiKey + ingestUrl.
 *   2. Caller either:
 *      - calls `captureIntent(envelope)` manually for high-precision events
 *      - wraps a fetch via `wrap(fetchImpl)` for auto-detection of intent
 *        URLs (commerce / mobility / scheduling) via the URL pattern library
 *      - mounts an Express / Next.js middleware (see ./middleware/*)
 *   3. Captured envelopes are batched in memory (size + interval) and
 *      POSTed to /api/intents/ingest as an array.
 *   4. On 5xx the batch is retried with exponential backoff (max 3 tries),
 *      then dropped + logged to stderr.
 *
 * Hard rules:
 *   - Zero blocking work in the request path — capture is fire-and-forget.
 *   - No raw PII over the wire — identifiers (`originAgentId`,
 *     `requesterIdHash` raw values) are sha256'd client-side before
 *     submission.
 *   - `enabled: false` (env var or constructor option) short-circuits
 *     everything; the client becomes a no-op (zero allocations, zero
 *     network).
 *   - The wrap path is a passthrough on errors — if envelope build OR
 *     submit fails, the underlying fetch result still flows back to the
 *     caller unchanged.
 *   - Per the schema, the gateway re-validates every envelope server-side.
 *     The client validates locally only enough to drop empty / clearly
 *     malformed envelopes; full validation happens at the gateway.
 */

import {
  type DemandEnvelope,
  computeCompositionSignature,
} from "@pcc/spec";
import { sha256 } from "@noble/hashes/sha256";
import { matchUrlPattern } from "./url-patterns.js";

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * A hash function for opaque identifier values. The default uses
 * @noble/hashes/sha256 (small, audited). Callers can swap in `crypto.subtle`
 * or any equivalent.
 */
export type Hasher = (input: string) => string;

/**
 * The shape passed to `captureIntent()` — a partial DemandEnvelope. The
 * client fills required fields the caller omitted:
 *   - `id` — random UUIDv4-ish if missing
 *   - `compositionSignature` — computed from `capabilityTypes` if missing
 *   - `createdAt` — `new Date().toISOString()` if missing
 *   - `source` — defaults to `"sdk"` if missing
 *
 * Any field present in the input is kept verbatim except identifiers
 * (`originAgentId`, `requesterIdHash`) which are hashed if they look raw.
 */
export type CapturedEnvelope = Partial<DemandEnvelope>;

/**
 * Result returned by `flush()`. `submittedCount` reports envelopes the
 * upstream accepted (2xx response). `droppedCount` is envelopes dropped
 * after exhausting retries.
 */
export interface SubmitResult {
  submittedCount: number;
  droppedCount: number;
  attempts: number;
  lastStatus?: number;
}

export interface IntentCollectorConfig {
  /** PCC API key, sent as `Authorization: Bearer <key>`. */
  apiKey: string | undefined;
  /** Full URL of the ingest endpoint. */
  ingestUrl: string;
  /** Max envelopes per batch before forced flush. */
  batchSize: number;
  /** Max time (ms) between flushes. */
  flushIntervalMs: number;
  /** Master enable switch. `false` short-circuits all capture work. */
  enabled: boolean;
  /** Hash function for opaque identifier fields. */
  hasher: Hasher;
}

// ─── Config loader ───────────────────────────────────────────────────────

/**
 * Build a config from env vars with sensible defaults. Constructor options
 * override the loaded config.
 *
 * Default `enabled` is `true` — opt-out via `PCC_INTENT_COLLECTOR_ENABLED=false`.
 */
export function loadCollectorConfig(
  env: NodeJS.ProcessEnv = (typeof process !== "undefined" ? process.env : {}) as NodeJS.ProcessEnv,
): IntentCollectorConfig {
  const enabled = env.PCC_INTENT_COLLECTOR_ENABLED !== "false";
  const batchSize = parseInt(env.PCC_INTENT_COLLECTOR_BATCH_SIZE ?? "", 10);
  const flushIntervalMs = parseInt(
    env.PCC_INTENT_COLLECTOR_FLUSH_INTERVAL_MS ?? "",
    10,
  );
  return {
    apiKey: env.PCC_API_KEY,
    ingestUrl: (
      env.PCC_INTENT_INGEST_URL ??
      "https://capability.network/api/intents/ingest"
    ).replace(/\/$/, ""),
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 50,
    flushIntervalMs:
      Number.isFinite(flushIntervalMs) && flushIntervalMs > 0
        ? flushIntervalMs
        : 5000,
    enabled,
    hasher: defaultHasher,
  };
}

// ─── Default hasher ──────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

/** Default hasher — sha256 over UTF-8 input, returns hex (no `0x` prefix). */
export function defaultHasher(input: string): string {
  const bytes = sha256(new TextEncoder().encode(input));
  return bytesToHex(bytes);
}

/**
 * Heuristic — does this string look already-hashed? 64 lowercase hex chars
 * with no other characters. Used to avoid double-hashing.
 */
function looksHashed(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

// ─── ID + small helpers ──────────────────────────────────────────────────

/**
 * Best-effort UUIDv4-ish id. Avoids the `crypto.randomUUID()` global since
 * older Node (<14.17) and some bundlers don't expose it. Format is
 * `intent-<hex>-<hex>` — opaque, stable for dedup at the gateway.
 */
function makeEnvelopeId(): string {
  const a = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  const b = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  const t = Date.now().toString(16);
  return `intent-${t}-${a}${b}`;
}

const STDERR = {
  warn(msg: string): void {
    if (typeof process !== "undefined" && process.stderr?.write) {
      process.stderr.write(`[intent-collector] WARN ${msg}\n`);
    }
  },
};

// ─── Client ──────────────────────────────────────────────────────────────

/**
 * Embeddable intent capture client. One instance per app is the intended
 * usage; multiple instances are safe but each maintains its own batch.
 */
export class IntentCollectorClient {
  private readonly cfg: IntentCollectorConfig;
  private readonly queue: DemandEnvelope[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<SubmitResult> | null = null;
  /** Public total of accepted envelopes (lifetime). */
  public submittedTotal = 0;
  /** Public total of dropped envelopes after retry exhaustion. */
  public droppedTotal = 0;

  constructor(opts: Partial<IntentCollectorConfig> & { fetchImpl?: typeof fetch } = {}) {
    const env = loadCollectorConfig();
    this.cfg = {
      apiKey: opts.apiKey ?? env.apiKey,
      ingestUrl: opts.ingestUrl ?? env.ingestUrl,
      batchSize: opts.batchSize ?? env.batchSize,
      flushIntervalMs: opts.flushIntervalMs ?? env.flushIntervalMs,
      enabled: opts.enabled ?? env.enabled,
      hasher: opts.hasher ?? env.hasher,
    };
    if (opts.fetchImpl) this.fetchImpl = opts.fetchImpl;
  }

  /**
   * Inject a fetch implementation. Test seam.
   */
  fetchImpl: typeof fetch = globalThis.fetch;

  /** Internal — start the flush timer if not already running. */
  private armTimer(): void {
    if (this.flushTimer || !this.cfg.enabled) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.cfg.flushIntervalMs);
    // Don't keep process alive purely for capture flushes.
    if (
      this.flushTimer &&
      typeof (this.flushTimer as { unref?: () => void }).unref === "function"
    ) {
      (this.flushTimer as { unref: () => void }).unref();
    }
  }

  /**
   * Capture an intent envelope. Fills required fields the caller omitted,
   * dedupes within the current batch via compositionSignature, and either
   * flushes immediately (batch full) or schedules a deferred flush.
   *
   * Returns immediately — submission happens asynchronously.
   */
  captureIntent(envelope: CapturedEnvelope): void {
    if (!this.cfg.enabled) return;
    const filled = this.fill(envelope);
    if (!filled) return; // dropped — couldn't form a meaningful envelope

    // Within-batch dedup. We keep the FIRST envelope per signature.
    const sig = filled.compositionSignature;
    if (this.queue.some((e) => e.compositionSignature === sig)) {
      return;
    }
    this.queue.push(filled);

    if (this.queue.length >= this.cfg.batchSize) {
      void this.flush();
    } else {
      this.armTimer();
    }
  }

  /**
   * Force-send the pending batch. Safe to call repeatedly; concurrent
   * flushes are coalesced. Returns the most recent submission outcome.
   */
  async flush(): Promise<SubmitResult> {
    if (!this.cfg.enabled || this.queue.length === 0) {
      return { submittedCount: 0, droppedCount: 0, attempts: 0 };
    }
    if (this.inFlight) return this.inFlight;

    const batch = this.queue.splice(0, this.queue.length);
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.inFlight = this.submitWithRetry(batch).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Wrap a fetch implementation. Returned function has the same signature
   * as fetch and side-effects only on intent-shaped URLs. On any thrown
   * error inside the capture path, the wrapper still returns the
   * underlying fetch result unchanged.
   *
   * Typical usage:
   *
   *   import { IntentCollectorClient } from "@pcc/intent-collector";
   *   const client = new IntentCollectorClient();
   *   globalThis.fetch = client.wrap(globalThis.fetch);
   */
  wrap<T extends typeof fetch>(fetchImpl: T): T {
    const self = this;
    const wrapped = async function wrappedFetch(
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      // Always defer the underlying call first so we never block on
      // capture work — capture happens in parallel.
      const responsePromise = fetchImpl.call(this, input as RequestInfo, init);
      try {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const method = (init?.method ?? (input as Request).method ?? "GET").toUpperCase();
        const body = init?.body;
        const match = matchUrlPattern(url, body, method);
        if (match) {
          self.captureIntent(match.partial);
        }
      } catch (e) {
        STDERR.warn(`wrap-fetch capture error (non-fatal): ${(e as Error).message}`);
      }
      return responsePromise;
    };
    return wrapped as T;
  }

  /**
   * Stop the flush timer + clear queue. Idempotent. For tests + graceful
   * shutdown.
   */
  shutdown(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.queue.length = 0;
  }

  /** Test inspector — current queue size. */
  queueSize(): number {
    return this.queue.length;
  }

  // ─── Internal: envelope filling ───────────────────────────────────────

  /**
   * Fill required envelope fields the caller omitted; hash raw identifier
   * values; drop envelopes too sparse to be meaningful.
   *
   * Returns `null` for envelopes the gateway is guaranteed to reject
   * (zero capability types, summary unset and untemplatable).
   */
  private fill(input: CapturedEnvelope): DemandEnvelope | null {
    const capabilityTypes =
      input.capabilityTypes && input.capabilityTypes.length > 0
        ? input.capabilityTypes
        : null;
    if (!capabilityTypes) {
      // Without capabilityTypes the envelope cannot aggregate. Drop.
      return null;
    }

    const summaryRaw = input.summary ?? `Captured intent: ${capabilityTypes.join("+")}`;
    const summary =
      summaryRaw.length > 200 ? summaryRaw.slice(0, 200) : summaryRaw;

    const compositionSignature =
      input.compositionSignature ??
      computeCompositionSignature(capabilityTypes, []);

    // Hash any raw-looking identifier values.
    const originAgentId =
      input.originAgentId !== undefined
        ? looksHashed(input.originAgentId)
          ? input.originAgentId
          : this.cfg.hasher(input.originAgentId)
        : undefined;
    const requesterIdHash =
      input.requesterIdHash !== undefined
        ? looksHashed(input.requesterIdHash)
          ? input.requesterIdHash
          : this.cfg.hasher(input.requesterIdHash)
        : undefined;

    return {
      id: input.id ?? makeEnvelopeId(),
      source: input.source ?? "sdk",
      compositionSignature,
      capabilityTypes,
      summary,
      embeddingQuantized: input.embeddingQuantized,
      geographicRegion: input.geographicRegion,
      budgetBand: input.budgetBand ?? "under_100",
      urgencyBand: input.urgencyBand ?? "standard",
      assuranceTier: input.assuranceTier,
      originAgentId,
      originAgentVendor: input.originAgentVendor,
      requesterIdHash,
      fulfillmentPath: input.fulfillmentPath,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
  }

  // ─── Internal: submission ─────────────────────────────────────────────

  private async submitWithRetry(batch: DemandEnvelope[]): Promise<SubmitResult> {
    if (!this.cfg.apiKey) {
      STDERR.warn(
        `dropping batch of ${batch.length} envelope(s) — PCC_API_KEY is not set`,
      );
      this.droppedTotal += batch.length;
      return {
        submittedCount: 0,
        droppedCount: batch.length,
        attempts: 0,
      };
    }

    const MAX_ATTEMPTS = 3;
    let lastStatus: number | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetchImpl(this.cfg.ingestUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body: JSON.stringify(batch),
        });
        lastStatus = res.status;

        // 2xx — success.
        if (res.status >= 200 && res.status < 300) {
          this.submittedTotal += batch.length;
          return {
            submittedCount: batch.length,
            droppedCount: 0,
            attempts: attempt,
            lastStatus,
          };
        }

        // 4xx — caller bug; do not retry, surface + drop.
        if (res.status >= 400 && res.status < 500) {
          STDERR.warn(
            `gateway rejected batch (status=${res.status}); dropping ${batch.length} envelope(s)`,
          );
          this.droppedTotal += batch.length;
          return {
            submittedCount: 0,
            droppedCount: batch.length,
            attempts: attempt,
            lastStatus,
          };
        }

        // 5xx — retry with backoff.
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt));
          continue;
        }
      } catch (e) {
        STDERR.warn(
          `submit attempt ${attempt} failed: ${(e as Error).message}`,
        );
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt));
          continue;
        }
      }
    }

    STDERR.warn(
      `exhausted ${MAX_ATTEMPTS} attempts; dropping ${batch.length} envelope(s)`,
    );
    this.droppedTotal += batch.length;
    return {
      submittedCount: 0,
      droppedCount: batch.length,
      attempts: MAX_ATTEMPTS,
      lastStatus,
    };
  }
}

// ─── Small utilities ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Exponential backoff with light jitter — attempt 1 ≈ 100ms, attempt 2 ≈ 300ms. */
function backoffMs(attempt: number): number {
  const base = 100 * 3 ** (attempt - 1);
  const jitter = Math.random() * 50;
  return base + jitter;
}
