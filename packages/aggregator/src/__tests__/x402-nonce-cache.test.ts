import { describe, it, expect } from "vitest";
import { NonceCache } from "../x402-nonce-cache.js";

const NONCE = "0x" + "ab".repeat(32);
const FROM = "0x1234567890abcdef1234567890abcdef12345678";
const CID = "sha256:" + "f".repeat(64);

describe("NonceCache", () => {
  it("returns undefined for unknown (nonce, from)", () => {
    const c = new NonceCache();
    expect(c.get(NONCE, FROM)).toBeUndefined();
  });

  it("set + get round-trips the CID", () => {
    const c = new NonceCache();
    c.set(NONCE, FROM, CID);
    expect(c.get(NONCE, FROM)?.receiptCID).toBe(CID);
  });

  it("is case-insensitive on both nonce and from", () => {
    const c = new NonceCache();
    c.set(NONCE.toUpperCase(), FROM.toUpperCase(), CID);
    expect(c.get(NONCE.toLowerCase(), FROM.toLowerCase())?.receiptCID).toBe(CID);
  });

  it("expires entries past the TTL", () => {
    let t = 0;
    const c = new NonceCache({ ttlMs: 100, now: () => t });
    c.set(NONCE, FROM, CID);
    t = 50;
    expect(c.get(NONCE, FROM)?.receiptCID).toBe(CID);
    t = 200;
    expect(c.get(NONCE, FROM)).toBeUndefined();
  });

  it("evictExpired removes stale entries from size()", () => {
    let t = 0;
    const c = new NonceCache({ ttlMs: 100, now: () => t });
    c.set(NONCE, FROM, CID);
    c.set("0x" + "01".repeat(32), FROM, CID);
    expect(c.size()).toBe(2);
    t = 200;
    expect(c.size()).toBe(0);
  });

  it("set on existing key overwrites the timestamp + cid", () => {
    let t = 0;
    const c = new NonceCache({ ttlMs: 100, now: () => t });
    c.set(NONCE, FROM, CID);
    t = 80;
    const cid2 = "sha256:" + "1".repeat(64);
    c.set(NONCE, FROM, cid2);
    t = 150;
    // Still alive (refreshed at t=80, TTL 100, alive until 180)
    expect(c.get(NONCE, FROM)?.receiptCID).toBe(cid2);
  });

  it("clear empties the cache", () => {
    const c = new NonceCache();
    c.set(NONCE, FROM, CID);
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.get(NONCE, FROM)).toBeUndefined();
  });

  it("two different from addresses with the same nonce are separate entries", () => {
    const c = new NonceCache();
    const otherFrom = "0x9999999999999999999999999999999999999999";
    c.set(NONCE, FROM, CID);
    c.set(NONCE, otherFrom, "sha256:" + "9".repeat(64));
    expect(c.get(NONCE, FROM)?.receiptCID).toBe(CID);
    expect(c.get(NONCE, otherFrom)?.receiptCID).toBe("sha256:" + "9".repeat(64));
  });
});
