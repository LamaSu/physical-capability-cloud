/**
 * Signed request-freshness envelope.
 *
 * RTP-absorption doc 03 §6.7 / §7.5 (the transport-independent freshness slice).
 * RTP carries an UNSIGNED `issued_at` and a stateful `task_id` set. PCC signs the
 * freshness fields (it already has Ed25519 keys) and adds a single-use nonce —
 * the EIP-712 / JWT `jti`+`exp` / AWS SigV4 `X-Amz-Date` pattern.
 *
 * The `senderSig` is an Ed25519 signature (via ./crypto) over the SAME canonical
 * form the rest of PCC uses (@pcc/spec `canonicalize`, unified in the companion
 * a2a canonicalization fix), covering `{ payloadHash, issuedAt, expiry, nonce, jobId }`.
 *
 * Doc 02's `TransportEnvelope` is gated (libp2p-vs-dht-core decision) and not built
 * here, so this envelope is standalone; when the transport abstraction lands these
 * become additive fields on it (doc 03 §7.5).
 *
 * Conformance (doc 03 §6.8): freshness keys live ALONGSIDE payloads, never inside —
 * this envelope wraps a payload by hash reference and never mutates it; verification
 * uses wall-clock `now` (C-3), not block time; the nonce is single-use (C-2).
 */

import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { canonicalize } from "@pcc/spec";
import { sign, verify } from "./crypto.js";

/** A request-freshness envelope: signed `issuedAt`/`expiry`/`nonce` over a payload hash. */
export interface FreshnessEnvelope {
  /** The job this request pertains to (bound into the signature). */
  jobId: string;
  /** RFC3339 issuance time — SIGNED (RTP leaves issued_at unsigned). */
  issuedAt: string;
  /** RFC3339 hard expiry — reject at/after this. */
  expiry: string;
  /** Single-use nonce; the gateway keeps a consumed-set with TTL = freshness window. */
  nonce: string;
  /** sha256 of the canonical payload, e.g. "sha256:<hex>" — fast integrity pre-check. */
  payloadHash: string;
  /** Ed25519 hop signature over canonicalize({payloadHash,issuedAt,expiry,nonce,jobId}). */
  senderSig: { alg: "ed25519"; signer: string; value: string };
}

/** Fields the `senderSig` covers — the exact canonical bytes that are signed. */
interface SignedFreshnessFields {
  payloadHash: string;
  issuedAt: string;
  expiry: string;
  nonce: string;
  jobId: string;
}

/**
 * The canonical bytes that `senderSig` signs. Uses the unified @pcc/spec
 * `canonicalize` (JCS) so a signature verifies identically across transports.
 */
export function freshnessSigningInput(f: SignedFreshnessFields): string {
  return canonicalize({
    payloadHash: f.payloadHash,
    issuedAt: f.issuedAt,
    expiry: f.expiry,
    nonce: f.nonce,
    jobId: f.jobId,
  });
}

/**
 * sha256 of a payload's canonical JSON, formatted "sha256:<hex>". Order-independent
 * (canonical), and bit-identical to `@pcc/spec` `sha256(canonicalize(payload))`.
 */
export function computePayloadHash(payload: unknown): string {
  return "sha256:" + createHash("sha256").update(canonicalize(payload)).digest("hex");
}

/** Input to {@link createFreshnessEnvelope}. `issuedAtMs` is injected for determinism. */
export interface CreateFreshnessInput {
  jobId: string;
  /** Signer identifier carried in the envelope (e.g. did / key ref); not the key itself. */
  signer: string;
  /** Hash of the wrapped payload — use {@link computePayloadHash}. */
  payloadHash: string;
  /** Wall-clock issuance time, epoch ms. */
  issuedAtMs: number;
  /** Time-to-live in ms; `expiry = issuedAtMs + ttlMs`. */
  ttlMs: number;
  /** Optional explicit nonce; defaults to a random nanoid. */
  nonce?: string;
}

/** Build and sign a freshness envelope with the given Ed25519 secret key (hex). */
export function createFreshnessEnvelope(
  input: CreateFreshnessInput,
  secretKey: string,
): FreshnessEnvelope {
  const issuedAt = new Date(input.issuedAtMs).toISOString();
  const expiry = new Date(input.issuedAtMs + input.ttlMs).toISOString();
  const nonce = input.nonce ?? nanoid();
  const value = sign(
    freshnessSigningInput({ payloadHash: input.payloadHash, issuedAt, expiry, nonce, jobId: input.jobId }),
    secretKey,
  );
  return {
    jobId: input.jobId,
    issuedAt,
    expiry,
    nonce,
    payloadHash: input.payloadHash,
    senderSig: { alg: "ed25519", signer: input.signer, value },
  };
}

/** Why a freshness check failed. */
export type FreshnessRejectReason = "bad_signature" | "stale" | "expired" | "replayed";

/** Result of {@link verifyFreshnessEnvelope}. */
export type FreshnessVerdict = { ok: true } | { ok: false; reason: FreshnessRejectReason };

/** Options for {@link verifyFreshnessEnvelope}. */
export interface VerifyFreshnessOptions {
  /** Wall-clock now, epoch ms (C-3: use Date.now(), not block time). */
  now: number;
  /** Max |now - issuedAt|, in ms — the clock-skew / staleness window. */
  windowMs: number;
  /** Single-use nonce tracker; if provided, replays are rejected. */
  consumed?: ConsumedNonceSet;
}

/**
 * Verify a freshness envelope. Checks, in order: signature, freshness window,
 * expiry, then single-use nonce. The nonce is consumed ONLY when every prior
 * check passes, so a forged/stale message cannot burn a victim's nonce.
 */
export function verifyFreshnessEnvelope(
  env: FreshnessEnvelope,
  signerPublicKey: string,
  opts: VerifyFreshnessOptions,
): FreshnessVerdict {
  const input = freshnessSigningInput(env);
  if (!verify(input, env.senderSig.value, signerPublicKey)) {
    return { ok: false, reason: "bad_signature" };
  }

  const issued = Date.parse(env.issuedAt);
  if (Number.isNaN(issued) || Math.abs(opts.now - issued) > opts.windowMs) {
    return { ok: false, reason: "stale" };
  }

  const exp = Date.parse(env.expiry);
  if (Number.isNaN(exp) || opts.now >= exp) {
    return { ok: false, reason: "expired" };
  }

  if (opts.consumed) {
    if (opts.consumed.has(env.nonce, opts.now)) {
      return { ok: false, reason: "replayed" };
    }
    // Remember the nonce until at least the end of the freshness window; after
    // that the staleness check rejects any replay anyway (doc 03 §6.7).
    opts.consumed.add(env.nonce, opts.now + opts.windowMs);
  }

  return { ok: true };
}

/**
 * In-memory single-use nonce set with lazy TTL eviction. A nonce is remembered
 * until its expiry instant (epoch ms), after which it is treated as unseen.
 */
export class ConsumedNonceSet {
  private readonly seen = new Map<string, number>();

  /** True if `nonce` is still within its remembered window at `now`. */
  has(nonce: string, now: number): boolean {
    const exp = this.seen.get(nonce);
    if (exp == null) return false;
    if (now >= exp) {
      this.seen.delete(nonce);
      return false;
    }
    return true;
  }

  /** Remember `nonce` until `expiryMs` (epoch ms). */
  add(nonce: string, expiryMs: number): void {
    this.seen.set(nonce, expiryMs);
  }

  /** Drop all entries whose window has closed at `now`; returns the count removed. */
  prune(now: number): number {
    let removed = 0;
    for (const [nonce, exp] of this.seen) {
      if (now >= exp) {
        this.seen.delete(nonce);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.seen.size;
  }
}
