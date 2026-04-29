import { describe, it, expect, beforeEach } from "vitest";
import {
  emit,
  tail,
  snapshot,
  redactString,
  redactPayload,
  _resetEventLogForTests,
} from "./event-bus.js";

beforeEach(() => {
  _resetEventLogForTests();
});

describe("event-bus — basic emit / tail / snapshot", () => {
  it("emits and reads events back via tail", () => {
    emit({ kind: "test.x", sponsor: "navi", text: "hi" });
    const evs = tail(0);
    expect(evs).toHaveLength(1);
    expect(evs[0]?.text).toBe("hi");
    expect(evs[0]?.t).toBeGreaterThan(0);
  });

  it("snapshot returns an immutable copy", () => {
    emit({ kind: "a", sponsor: "navi", text: "x" });
    const snap1 = snapshot();
    emit({ kind: "b", sponsor: "navi", text: "y" });
    expect(snap1).toHaveLength(1);
    expect(snapshot()).toHaveLength(2);
  });

  it("tail filters by since cursor", () => {
    emit({ kind: "old", sponsor: "navi", text: "before" });
    const cursor = Date.now();
    // Sleep one tick so subsequent emits get a later timestamp.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        emit({ kind: "new", sponsor: "navi", text: "after" });
        const out = tail(cursor);
        expect(out).toHaveLength(1);
        expect(out[0]?.kind).toBe("new");
        resolve();
      }, 5);
    });
  });
});

describe("event-bus — T1.6 credential redaction", () => {
  it("redacts postgres:// URIs in event text", () => {
    emit({
      kind: "db.connect",
      sponsor: "ghost",
      text: "POST postgres://user:supersecret@host/db",
    });
    const e = tail(0)[0];
    expect(e?.text).not.toContain("supersecret");
    expect(e?.text).toContain("***REDACTED***");
    expect(e?.text).toContain("postgres://user:");
  });

  it("redacts Authorization: Bearer tokens in text", () => {
    emit({
      kind: "http",
      sponsor: "navi",
      text: "header Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    });
    const e = tail(0)[0];
    expect(e?.text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(e?.text).toMatch(/Authorization:\s*Bearer\s*\*\*\*REDACTED\*\*\*/i);
  });

  it("redacts sk- and pcc_live_ tokens", () => {
    emit({
      kind: "auth",
      sponsor: "anthropic",
      text: "got key sk-ant-1234567890abcdefghijklmnopqr and pcc_live_abc123def456ghi789",
    });
    const e = tail(0)[0];
    expect(e?.text).not.toContain("sk-ant-1234567890abcdefghijklmnopqr");
    expect(e?.text).not.toContain("pcc_live_abc123def456ghi789");
    expect(e?.text).toContain("***REDACTED***");
  });

  it("redacts api_key= / token= / password= patterns", () => {
    emit({
      kind: "config",
      sponsor: "navi",
      text: 'api_key="abcd1234efgh5678ijkl9012", password="hunter22hunter22"',
    });
    const e = tail(0)[0];
    expect(e?.text).not.toContain("abcd1234efgh5678");
    expect(e?.text).not.toContain("hunter22hunter22");
    expect(e?.text).toContain("***REDACTED***");
  });

  it("redacts AWS access keys", () => {
    emit({ kind: "aws", sponsor: "aws", text: "key AKIAIOSFODNN7EXAMPLE in env" });
    const e = tail(0)[0];
    expect(e?.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(e?.text).toContain("AKIA***REDACTED***");
  });

  it("redacts secrets nested deep in payload object", () => {
    emit({
      kind: "config",
      sponsor: "navi",
      text: "configuring",
      payload: {
        db: { url: "postgres://u:hidden@host/db" },
        env: ["KEY=sk-ant-1234567890abcdefghijkl", "FOO=bar"],
        nested: { auth: { token: "Bearer eyJhbGciOiJIUzI1NiJ9.abc.def-something-long" } },
      },
    });
    const e = tail(0)[0];
    const flat = JSON.stringify(e?.payload ?? {});
    expect(flat).not.toContain("hidden");
    expect(flat).not.toContain("sk-ant-1234567890");
    expect(flat).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(flat).toContain("***REDACTED***");
  });

  it("does not double-redact already-redacted strings", () => {
    const input = "leaked: ***REDACTED*** here";
    expect(redactString(input)).toBe(input);
  });

  it("redactPayload is recursive and pure", () => {
    const out = redactPayload({
      a: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig123",
      b: ["postgres://u:p123456789@h"],
      c: { d: { token: "Bearer abcdefghij1234567890klmnopq" } },
    });
    const flat = JSON.stringify(out);
    expect(flat).toContain("***REDACTED***");
    expect(flat).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(flat).not.toContain("p123456789");
  });
});

describe("event-bus — T1.6 payload size cap", () => {
  it("truncates payloads larger than 64KB", () => {
    const big = "x".repeat(80_000);
    emit({
      kind: "blob",
      sponsor: "navi",
      text: "large blob",
      payload: { data: big },
    });
    const e = tail(0)[0];
    expect(e?.payload?._truncated).toBe(true);
    expect(typeof e?.payload?._preview).toBe("string");
    expect((e?.payload?._preview as string).length).toBeLessThanOrEqual(64 * 1024);
  });

  it("preserves payloads under the cap untouched", () => {
    emit({
      kind: "small",
      sponsor: "navi",
      text: "small",
      payload: { a: 1, b: "ok" },
    });
    const e = tail(0)[0];
    expect(e?.payload?._truncated).toBeUndefined();
    expect(e?.payload?.a).toBe(1);
  });
});

describe("event-bus — T1.6 ring buffer cap", () => {
  it("retains at most MAX_LOG_SIZE (200) events", () => {
    for (let i = 0; i < 250; i++) {
      emit({ kind: "n", sponsor: "navi", text: `evt ${i}` });
    }
    const all = snapshot();
    expect(all.length).toBeLessThanOrEqual(200);
    // Oldest events are evicted FIFO — the first remaining should be evt 50+.
    const first = all[0];
    expect(first?.text.replace(/^evt /, "")).toMatch(/^\d+$/);
    const firstIdx = Number(first!.text.replace(/^evt /, ""));
    expect(firstIdx).toBeGreaterThanOrEqual(50);
  });
});
