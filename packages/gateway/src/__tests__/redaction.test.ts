import { describe, it, expect } from "vitest";
import { redactSecrets, redactOrNull, redactUrlCredentials, redactDiagnostic } from "../redaction.js";

/**
 * Secret scrubbing for the public feedback sink (Phase 2). Conservative: redacts
 * clearly-secret shapes, never a public wallet address, low false-positive on prose.
 */
describe("redactSecrets", () => {
  it("redacts an Authorization bearer token", () => {
    const out = redactSecrets("got 401 with Authorization: Bearer eyabc.DEF_ghijklmnop123");
    expect(out).not.toContain("eyabc.DEF_ghijklmnop123");
    expect(out).toContain("Bearer [redacted]");
  });

  it("redacts a PCC live/test key but keeps the prefix", () => {
    expect(redactSecrets("my key is pcc_live_ABCdef0123456789")).toBe("my key is pcc_live_redacted");
    expect(redactSecrets("pcc_test_ZZZ99988877")).toBe("pcc_test_redacted");
  });

  it("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJI.eyJzdWIiOiI1NTU".concat(".QsWpV7cSignatureHere");
    expect(redactSecrets(`token=${jwt}`)).toContain("[redacted-jwt]");
    expect(redactSecrets(`token=${jwt}`)).not.toContain("eyJhbGciOiJI");
  });

  it("redacts a 64-hex private key WITH 0x/0X/no-prefix, but NOT a 40-hex address (review #2/#3)", () => {
    const pk = "0x" + "a".repeat(64);
    const upper = "0X" + "d".repeat(64); // uppercase 0X prefix (round 2 #3)
    const bare = "c".repeat(64); // private key pasted without the 0x prefix
    const addr = "0x" + "b".repeat(40);
    const out = redactSecrets(`pk=${pk} up=${upper} bare=${bare} addr=${addr}`);
    expect(out).toContain("[redacted-hex]");
    expect(out).not.toContain("a".repeat(64));
    expect(out).not.toContain("d".repeat(64)); // 0X-prefixed key caught
    expect(out).not.toContain("c".repeat(64)); // unprefixed key caught
    expect(out).toContain(addr); // public address (40 hex) must survive
  });

  it("fully redacts a PCC key containing separators (review #2)", () => {
    // the secret body may contain _ or - — must not leave a trailing fragment.
    const out = redactSecrets("key pcc_live_abc_def-ghi123456 here");
    expect(out).toBe("key pcc_live_redacted here");
  });

  it("redacts common + modern vendor key shapes incl. sk-proj- (review #2)", () => {
    expect(redactSecrets("sk-" + "a".repeat(24))).toContain("[redacted-key]");
    expect(redactSecrets("sk-proj-" + "a".repeat(24))).toContain("[redacted-key]"); // modern OpenAI
    expect(redactSecrets("sk-proj-" + "a".repeat(24))).not.toContain("aaaa");
    expect(redactSecrets("ghp_" + "b".repeat(30))).toContain("[redacted-key]");
    expect(redactSecrets("AKIAABCDEFGHIJKLMNOP")).toContain("[redacted-key]");
  });

  it("leaves ordinary prose + short hex untouched (low false-positive)", () => {
    const prose = "POST /api/build/contract returned 500; the tier field was missing at 0xdeadbeef.";
    expect(redactSecrets(prose)).toBe(prose); // 0xdeadbeef is 8 hex — not a key
  });

  it("redacts a key adjacent to underscores / word chars — not shielded by \\b (review r3 #1)", () => {
    const hex = "0x" + "f".repeat(64);
    const out = redactSecrets(`trace_${hex}_suffix`);
    expect(out).not.toContain("f".repeat(64)); // \b would have missed this; lookarounds catch it
    expect(out).toContain("[redacted-hex]");
    // pcc key embedded right after an underscore
    expect(redactSecrets("prefix_pcc_live_SECRETBODY99")).not.toContain("SECRETBODY99");
  });

  it("does NOT over-redact a key prefix embedded in an ordinary word (review r4 #1)", () => {
    // "task-scheduler-abcdefghijklmnop" contains "sk-<16+>" — must survive (the alnum
    // neighbor blocks it) while a real key with a separator neighbor is still caught.
    const innocent = "restart the task-scheduler-abcdefghijklmnop service";
    expect(redactSecrets(innocent)).toBe(innocent);
    expect(redactSecrets("key: sk-" + "a".repeat(20))).toContain("[redacted-key]");
    expect(redactSecrets("_sk-" + "a".repeat(20))).toContain("[redacted-key]"); // underscore-adjacent caught
  });

  it("is idempotent on already-redacted text", () => {
    const once = redactSecrets("pcc_live_SECRETSECRET");
    expect(redactSecrets(once)).toBe(once);
  });

  it("redactOrNull passes null through", () => {
    expect(redactOrNull(null)).toBeNull();
    expect(redactOrNull("pcc_live_XXXXXXXX")).toBe("pcc_live_redacted");
  });
});

/**
 * Diagnostic text that leaves the gateway in a response (an adapter exception message, a status
 * env value). An error that quotes the URL a device was configured with quotes its credentials
 * too, so URL userinfo, query and fragment are dropped and the location is kept (N71).
 */
describe("redactUrlCredentials", () => {
  it("drops the userinfo and keeps scheme, host, port and path", () => {
    expect(redactUrlCredentials("connect failed for http://u:N71-SENTINEL@printer.invalid:5000/api/printer")).toBe(
      "connect failed for http://printer.invalid:5000/api/printer",
    );
  });

  it("drops the query string and the fragment, which carry tokens", () => {
    expect(redactUrlCredentials("GET https://h.invalid/v1/status?apikey=N71-SENTINEL&x=1#frag failed")).toBe(
      "GET https://h.invalid/v1/status failed",
    );
  });

  it("takes everything before the LAST @ of the authority as userinfo (a password with an @)", () => {
    expect(redactUrlCredentials("http://u:p@ss@host.invalid/path")).toBe("http://host.invalid/path");
    expect(redactUrlCredentials("http://user%40mail:pw@host.invalid/")).toBe("http://host.invalid/");
  });

  it("knows other schemes: ipp, opc.tcp, ws, uppercase", () => {
    expect(redactUrlCredentials("ipp://op:pw@printer.local:631/ipp/print.")).toBe("ipp://printer.local:631/ipp/print.");
    expect(redactUrlCredentials("opc.tcp://op:pw@plc.local:4840")).toBe("opc.tcp://plc.local:4840");
    expect(redactUrlCredentials("HTTP://U:P@HOST/X")).toBe("HTTP://HOST/X");
  });

  it("scrubs every URL in the text, including one inside brackets or followed by punctuation", () => {
    expect(redactUrlCredentials("(see http://a:b@one.invalid:80/x), then https://c:d@two.invalid/y?k=v done")).toBe(
      "(see http://one.invalid:80/x), then https://two.invalid/y done",
    );
  });

  it("does not take an @ in the path for userinfo", () => {
    expect(redactUrlCredentials("https://medium.invalid/@user and ws://h.invalid/a@b")).toBe(
      "https://medium.invalid/@user and ws://h.invalid/a@b",
    );
  });

  it("leaves a URL with no credentials, and text with no URL, untouched", () => {
    expect(redactUrlCredentials("http://host.invalid:5000/api/job")).toBe("http://host.invalid:5000/api/job");
    expect(redactUrlCredentials("file:///etc/hosts")).toBe("file:///etc/hosts");
    const prose = "connect ECONNREFUSED 10.0.0.5:5000 for ops@example.com";
    expect(redactUrlCredentials(prose)).toBe(prose);
  });

  it("is idempotent", () => {
    const once = redactUrlCredentials("x http://u:p@h.invalid/p?q=1 y");
    expect(redactUrlCredentials(once)).toBe(once);
  });
});

describe("redactDiagnostic", () => {
  it("drops URL credentials AND secret-shaped substrings", () => {
    const out = redactDiagnostic("401 from http://u:N71-SENTINEL@h.invalid/x with Authorization: Bearer abcDEF123456789xyz");
    expect(out).not.toContain("N71-SENTINEL");
    expect(out).not.toContain("abcDEF123456789xyz");
    expect(out).toContain("http://h.invalid/x");
    expect(out).toContain("Bearer [redacted]");
  });

  it("leaves an ordinary status line alone", () => {
    expect(redactDiagnostic("idle")).toBe("idle");
    expect(redactDiagnostic("device_not_found")).toBe("device_not_found");
  });
});
