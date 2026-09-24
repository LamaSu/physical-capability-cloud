/**
 * Shared ephemeral-session-key revocation store (§8.5-2).
 *
 * Proves the store's contract: time-keyed records (Unix seconds), the two read
 * shapes the two consumers need (revokedIdSet() for the verify endpoint; list()
 * for the settlement path), earliest-wins idempotency, and default-now.
 */

import { describe, it, expect } from "vitest";
import {
  SessionRevocationStore,
  sessionRevocationStore,
} from "../services/session-revocation-store.js";

describe("SessionRevocationStore", () => {
  it("records a revocation and reads it back (time-keyed, Unix seconds)", () => {
    const store = new SessionRevocationStore();
    expect(store.isRevoked("s1")).toBe(false);
    expect(store.getRevokedAt("s1")).toBeUndefined();

    const at = store.revoke("s1", 1000);
    expect(at).toBe(1000);
    expect(store.isRevoked("s1")).toBe(true);
    expect(store.getRevokedAt("s1")).toBe(1000);
  });

  it("revoke() defaults revokedAt to ~now in Unix SECONDS", () => {
    const store = new SessionRevocationStore();
    const before = Math.floor(Date.now() / 1000);
    const at = store.revoke("s1");
    const after = Math.floor(Date.now() / 1000);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    // Seconds, not milliseconds (10-digit epoch, not 13).
    expect(at).toBeLessThan(1e12);
  });

  it("is idempotent and earliest-wins on double revoke (fail-closed)", () => {
    const store = new SessionRevocationStore();
    store.revoke("s1", 2000);
    // A later re-revoke must NOT push the revocation time later.
    expect(store.revoke("s1", 3000)).toBe(2000);
    expect(store.getRevokedAt("s1")).toBe(2000);
    // An earlier re-revoke DOES move it earlier (the session was dead sooner).
    expect(store.revoke("s1", 1500)).toBe(1500);
    expect(store.getRevokedAt("s1")).toBe(1500);
  });

  it("list() returns time-keyed records (settlement path shape)", () => {
    const store = new SessionRevocationStore();
    store.revoke("s1", 1000);
    store.revoke("s2", 2000);
    const records = store.list().sort((a, b) => a.revokedAt - b.revokedAt);
    expect(records).toEqual([
      { sessionId: "s1", revokedAt: 1000 },
      { sessionId: "s2", revokedAt: 2000 },
    ]);
  });

  it("revokedIdSet() returns the ids as a Set (verify-endpoint shape)", () => {
    const store = new SessionRevocationStore();
    store.revoke("s1", 1000);
    store.revoke("s2", 2000);
    const set = store.revokedIdSet();
    expect(set).toBeInstanceOf(Set);
    expect(set.has("s1")).toBe(true);
    expect(set.has("s2")).toBe(true);
    expect(set.has("s3")).toBe(false);
    expect(set.size).toBe(2);
  });

  it("clear() empties the store", () => {
    const store = new SessionRevocationStore();
    store.revoke("s1", 1000);
    store.clear();
    expect(store.isRevoked("s1")).toBe(false);
    expect(store.list()).toEqual([]);
    expect(store.revokedIdSet().size).toBe(0);
  });

  it("exports a shared module singleton", () => {
    expect(sessionRevocationStore).toBeInstanceOf(SessionRevocationStore);
  });
});
