import { describe, it, expect } from "vitest";
import { generateSigningKeyPair } from "../crypto.js";
import {
  createFreshnessEnvelope,
  verifyFreshnessEnvelope,
  computePayloadHash,
  freshnessSigningInput,
  ConsumedNonceSet,
  type FreshnessEnvelope,
} from "../freshness.js";

const T0 = Date.parse("2026-06-24T12:00:00Z"); // fixed wall-clock for determinism
const WINDOW = 5 * 60 * 1000; // 5 minutes (RTP's freshness window)

function makeEnv(
  kp: { publicKey: string; secretKey: string },
  overrides: Partial<{ ttlMs: number; nonce: string; jobId: string }> = {},
): FreshnessEnvelope {
  const payload = { action: "release", milestone: 0, amount: "100" };
  return createFreshnessEnvelope(
    {
      jobId: overrides.jobId ?? "job-1",
      signer: "did:pcc:agent-1",
      payloadHash: computePayloadHash(payload),
      issuedAtMs: T0,
      ttlMs: overrides.ttlMs ?? 10 * 60 * 1000,
      nonce: overrides.nonce,
    },
    kp.secretKey,
  );
}

describe("freshness: computePayloadHash", () => {
  it("is sha256:<hex> and deterministic", () => {
    const h = computePayloadHash({ a: 1 });
    expect(h).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(computePayloadHash({ a: 1 })).toBe(h);
  });

  it("is canonical — key-order independent (uses the unified canonicalize)", () => {
    expect(computePayloadHash({ a: 1, b: 2 })).toBe(computePayloadHash({ b: 2, a: 1 }));
  });
});

describe("freshness: create / verify", () => {
  it("a freshly created envelope verifies ok within the window", () => {
    const kp = generateSigningKeyPair();
    const env = makeEnv(kp);
    expect(
      verifyFreshnessEnvelope(env, kp.publicKey, { now: T0 + 1000, windowMs: WINDOW }),
    ).toEqual({ ok: true });
  });

  it("senderSig is over the unified canonical input (signing-input is reproducible)", () => {
    const kp = generateSigningKeyPair();
    const env = makeEnv(kp);
    expect(freshnessSigningInput(env)).toContain(env.nonce);
    expect(verifyFreshnessEnvelope(env, kp.publicKey, { now: T0, windowMs: WINDOW }).ok).toBe(true);
  });

  it("rejects a tampered jobId as bad_signature", () => {
    const kp = generateSigningKeyPair();
    const env: FreshnessEnvelope = { ...makeEnv(kp), jobId: "job-EVIL" };
    expect(
      verifyFreshnessEnvelope(env, kp.publicKey, { now: T0, windowMs: WINDOW }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered payloadHash as bad_signature", () => {
    const kp = generateSigningKeyPair();
    const env: FreshnessEnvelope = { ...makeEnv(kp), payloadHash: "sha256:" + "0".repeat(64) };
    expect(verifyFreshnessEnvelope(env, kp.publicKey, { now: T0, windowMs: WINDOW }).ok).toBe(false);
  });

  it("rejects the wrong public key as bad_signature", () => {
    const kp = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const env = makeEnv(kp);
    expect(
      verifyFreshnessEnvelope(env, other.publicKey, { now: T0, windowMs: WINDOW }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a stale envelope on both sides of the window", () => {
    const kp = generateSigningKeyPair();
    const env = makeEnv(kp);
    expect(
      verifyFreshnessEnvelope(env, kp.publicKey, { now: T0 + WINDOW + 1, windowMs: WINDOW }),
    ).toEqual({ ok: false, reason: "stale" });
    expect(
      verifyFreshnessEnvelope(env, kp.publicKey, { now: T0 - WINDOW - 1, windowMs: WINDOW }),
    ).toEqual({ ok: false, reason: "stale" });
  });

  it("rejects an expired envelope even while still within the freshness window", () => {
    const kp = generateSigningKeyPair();
    const env = makeEnv(kp, { ttlMs: 60 * 1000 }); // expiry = T0 + 60s
    // now = T0 + 120s: fresh (|120s| <= 300s) but past expiry.
    expect(
      verifyFreshnessEnvelope(env, kp.publicKey, { now: T0 + 120 * 1000, windowMs: WINDOW }),
    ).toEqual({ ok: false, reason: "expired" });
  });
});

describe("freshness: single-use nonce (replay protection)", () => {
  it("rejects a replay with the same ConsumedNonceSet", () => {
    const kp = generateSigningKeyPair();
    const env = makeEnv(kp);
    const consumed = new ConsumedNonceSet();
    expect(
      verifyFreshnessEnvelope(env, kp.publicKey, { now: T0, windowMs: WINDOW, consumed }),
    ).toEqual({ ok: true });
    expect(
      verifyFreshnessEnvelope(env, kp.publicKey, { now: T0 + 1000, windowMs: WINDOW, consumed }),
    ).toEqual({ ok: false, reason: "replayed" });
  });

  it("does not consume a nonce on a failed check (no nonce burning)", () => {
    const kp = generateSigningKeyPair();
    const consumed = new ConsumedNonceSet();
    const env = makeEnv(kp);
    // A stale verify must not record the nonce.
    verifyFreshnessEnvelope(env, kp.publicKey, {
      now: T0 + WINDOW + 1,
      windowMs: WINDOW,
      consumed,
    });
    expect(consumed.size).toBe(0);
    // The same nonce is therefore still usable for a legitimate request.
    expect(verifyFreshnessEnvelope(env, kp.publicKey, { now: T0, windowMs: WINDOW, consumed }).ok).toBe(
      true,
    );
    expect(consumed.size).toBe(1);
  });

  it("ConsumedNonceSet lazily prunes expired entries", () => {
    const consumed = new ConsumedNonceSet();
    consumed.add("n1", 1000);
    consumed.add("n2", 5000);
    expect(consumed.size).toBe(2);
    expect(consumed.prune(2000)).toBe(1); // n1's window closed
    expect(consumed.size).toBe(1);
    expect(consumed.has("n1", 2000)).toBe(false);
    expect(consumed.has("n2", 2000)).toBe(true);
  });
});
