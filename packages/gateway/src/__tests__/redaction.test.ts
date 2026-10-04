import { describe, it, expect } from "vitest";
import {
  redactSecrets,
  redactOrNull,
  redactUrlCredentials,
  redactDiagnostic,
  valueCarriesCredential,
} from "../redaction.js";

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
  // N71 round 4 (astra pack 83c, CRITICAL #1): round 3 kept a "retained group" — host+path —
  // and only widened which characters bounded it. That group's exclusion set never excluded
  // comma, ':' or '@', so a second back-to-back URL (with its OWN credentials) could ride
  // along inside what looked like the first URL's path; and because the group DID exclude an
  // apostrophe, a legal apostrophe in an ordinary path truncated the match before the query
  // group could even run, leaving the unmatched remainder (and the credential in it) to pass
  // through .replace()'s /g loop untouched. There is no safe partial projection of an
  // arbitrary URL embedded in arbitrary surrounding text, so round 4 retains NOTHING: the
  // whole scheme-to-whitespace token is replaced with a fixed marker, whether or not THIS
  // particular token happens to carry a credential.
  it("replaces the whole URL token with a fixed marker, never a kept host/path", () => {
    expect(redactUrlCredentials("connect failed for http://u:N71-SENTINEL@printer.invalid:5000/api/printer")).toBe(
      "connect failed for [url]",
    );
  });

  it("replaces the whole token when the credential is in the query string or fragment too", () => {
    expect(redactUrlCredentials("GET https://h.invalid/v1/status?apikey=N71-SENTINEL&x=1#frag failed")).toBe(
      "GET [url] failed",
    );
  });

  it("replaces the whole token regardless of how many '@' or '%40' it contains", () => {
    expect(redactUrlCredentials("http://u:p@ss@host.invalid/path")).toBe("[url]");
    expect(redactUrlCredentials("http://user%40mail:pw@host.invalid/")).toBe("[url]");
  });

  it("knows other schemes: ipp, opc.tcp, ws, uppercase", () => {
    expect(redactUrlCredentials("ipp://op:pw@printer.local:631/ipp/print.")).toBe("[url]");
    expect(redactUrlCredentials("opc.tcp://op:pw@plc.local:4840")).toBe("[url]");
    expect(redactUrlCredentials("HTTP://U:P@HOST/X")).toBe("[url]");
  });

  it("replaces every URL token in the text, swallowing trailing punctuation up to the next whitespace", () => {
    expect(redactUrlCredentials("(see http://a:b@one.invalid:80/x), then https://c:d@two.invalid/y?k=v done")).toBe(
      "(see [url] then [url] done",
    );
  });

  it("replaces a credential-free URL too — it no longer tries to tell userinfo from a path '@'", () => {
    expect(redactUrlCredentials("https://medium.invalid/@user and ws://h.invalid/a@b")).toBe("[url] and [url]");
  });

  it("replaces ANY url-shaped token, even one with no credential; leaves text with no URL at all untouched", () => {
    // Round 3 kept a credential-free URL as "still a usable diagnostic." Round 4 (astra pack
    // 83c) drops that distinction: telling "has a credential" apart from "does not" in
    // ARBITRARY surrounding text is exactly the ambiguous-delimiting problem CRITICAL #1
    // exploited. There is no safe partial projection, so every url-shaped token is replaced,
    // whether or not this one happens to carry a secret.
    expect(redactUrlCredentials("http://host.invalid:5000/api/job")).toBe("[url]");
    expect(redactUrlCredentials("file:///etc/hosts")).toBe("[url]");
    const prose = "connect ECONNREFUSED 10.0.0.5:5000 for ops@example.com";
    expect(redactUrlCredentials(prose)).toBe(prose); // no "scheme://" anywhere — not a URL token
  });

  it("is idempotent", () => {
    const once = redactUrlCredentials("x http://u:p@h.invalid/p?q=1 y");
    expect(redactUrlCredentials(once)).toBe(once);
  });
});

/**
 * N71 round 4 (astra's verdict on pack 83c at 9b30fd73). Round 3 only widened which boundary
 * characters the KEPT host+path group excluded — it never stopped that group from being an
 * ambiguously-delimited RETAINED token: its exclusion set never excluded comma, ':' or '@', so
 * a second back-to-back URL's own credentials rode along inside what looked like the first
 * URL's path and came back unchanged; and because the group DID exclude an apostrophe, a legal
 * apostrophe in an ordinary (credential-free) path truncated the match before the query group
 * could even run — the credential after it was never reached by any group, and the unmatched
 * remainder was emitted as-is by `.replace`'s /g loop, since it does not itself start a new
 * "scheme://" match. Round 4 does not add another exclusion character (the same regex arms
 * race astra's verdict says to stop playing) — it stops retaining ANY part of the URL.
 */
describe("redactUrlCredentials: ambiguous delimiting, no retained token (astra pack 83c)", () => {
  const SENTINEL = "N71-SENTINEL";

  it("[neg] astra's reproduction: a comma-separated back-to-back URL's credentials no longer ride along inside the first URL's 'path'", () => {
    const out = redactUrlCredentials(`https://first.invalid/x,https://u:${SENTINEL}@second.invalid/y`);
    expect(out).not.toContain(SENTINEL);
  });

  it("[neg] astra's reproduction: a legal apostrophe in the path no longer truncates the match before the query", () => {
    const out = redactUrlCredentials(`https://host.invalid/pa'th?token=${SENTINEL}`);
    expect(out).not.toContain(SENTINEL);
  });

  it("[neg] an immediate (unseparated) back-to-back URL — no comma, no whitespace at all", () => {
    const out = redactUrlCredentials(`https://first.invalid/xhttps://u:${SENTINEL}@second.invalid/y`);
    expect(out).not.toContain(SENTINEL);
  });

  it("[neg] three back-to-back URLs, semicolon- and comma-joined", () => {
    const out = redactUrlCredentials(
      `https://a.invalid/one;https://u:${SENTINEL}-mid@b.invalid/two,https://c.invalid/three?k=${SENTINEL}-end`,
    );
    expect(out).not.toContain(SENTINEL);
  });

  it("URLs separated by real whitespace are each matched (and replaced) independently", () => {
    const out = redactUrlCredentials(`https://first.invalid/x https://u:${SENTINEL}@second.invalid/y`);
    expect(out).toBe("[url] [url]");
  });
});

describe("redactDiagnostic", () => {
  it("drops URL credentials AND secret-shaped substrings", () => {
    const out = redactDiagnostic("401 from http://u:N71-SENTINEL@h.invalid/x with Authorization: Bearer abcDEF123456789xyz");
    expect(out).not.toContain("N71-SENTINEL");
    expect(out).not.toContain("abcDEF123456789xyz");
    expect(out).toContain("[url]"); // round 4: the whole URL token, never a kept host/path (astra pack 83c)
    expect(out).toContain("Bearer [redacted]");
  });

  it("leaves an ordinary status line alone", () => {
    expect(redactDiagnostic("idle")).toBe("idle");
    expect(redactDiagnostic("device_not_found")).toBe("device_not_found");
  });
});

/**
 * N71 round 3 (astra's verdict on pack 83b at b7106adc). The URL scrubber was a regex that treated
 * an apostrophe as a delimiter. An apostrophe is legal in URI userinfo, query and fragment, so a
 * password, token or fragment containing one came back unchanged or with its tail intact:
 *
 *   http://u:pa'ss@host.invalid/x              -> returned unchanged
 *   https://host.invalid/?token=abc'SECRET     -> https://host.invalid/'SECRET
 *   https://host.invalid/#abc'SECRET           -> https://host.invalid/'SECRET
 *
 * The same holds for a double quote, `<`, `>`, a backtick and a backslash: the regex listed them as
 * delimiters, the WHATWG URL parser (which is what fetch uses) accepts them. Every case below embeds a
 * synthetic sentinel, and none may come back out.
 */
describe("redactUrlCredentials: characters that are valid inside a credential (astra pack 83b)", () => {
  const SENTINEL = "N71-SENTINEL";

  /** [what is in the URL, the URL]. */
  const BYPASSES: Array<[string, string]> = [
    ["an apostrophe in the password", `http://u:pa'${SENTINEL}@host.invalid/x`],
    ["an apostrophe in the username", `http://us'er${SENTINEL}:pw@host.invalid/x`],
    ["an apostrophe in a query value", `https://host.invalid/?token=abc'${SENTINEL}`],
    ["an apostrophe in the fragment", `https://host.invalid/#abc'${SENTINEL}`],
    ["a double quote in the password", `http://u:pa"${SENTINEL}@host.invalid/x`],
    ["a double quote in a query value", `https://host.invalid/?token=ab"${SENTINEL}`],
    ["a double quote in the fragment", `https://host.invalid/#ab"${SENTINEL}`],
    ["an angle bracket in the password", `http://u:pa<${SENTINEL}@host.invalid/x`],
    ["an angle bracket in a query value", `https://host.invalid/?token=ab<${SENTINEL}>`],
    ["a backtick in the password", `http://u:pa\`${SENTINEL}@host.invalid/x`],
    ["a backslash in the password", `http://u:pa\\${SENTINEL}@host.invalid/x`],
  ];

  it.each(BYPASSES)("drops %s, bare and inside text", (_what, url) => {
    for (const text of [url, `connect failed for ${url} (retrying)`, `url='${url}'`, `url="${url}"`, `<${url}>`]) {
      expect(redactUrlCredentials(text), text).not.toContain(SENTINEL);
      expect(redactDiagnostic(text), text).not.toContain(SENTINEL);
    }
  });

  it("returns astra's three V8 rows without the secret (verbatim inputs)", () => {
    // The verdict's table: the second and third came back as `https://host.invalid/'SECRET`, the first unchanged.
    expect(redactUrlCredentials("http://u:pa'ss@host.invalid/x")).not.toContain("pa'ss");
    expect(redactUrlCredentials("https://host.invalid/?token=abc'SECRET")).not.toContain("SECRET");
    expect(redactUrlCredentials("https://host.invalid/#abc'SECRET")).not.toContain("SECRET");
  });

  it("control: the rows astra found sound still hold (encoded @ and :, IPv6, a non-HTTP scheme)", () => {
    expect(redactUrlCredentials(`http://u%40name:p%3Ass@[::1]:80/a?x=${SENTINEL}#${SENTINEL}`)).not.toContain(SENTINEL);
    expect(redactUrlCredentials(`opc.tcp://u:pw${SENTINEL}@[::1]:4840/x#${SENTINEL}`)).not.toContain(SENTINEL);
  });
});

/**
 * N71 round 4 (astra pack 83c, HIGH #5): valueCarriesCredential's two signals (URL
 * userinfo/password, URL query key) miss a value that is credential-SHAPED but not itself a
 * URL (`via: "sk-proj-..."` is a bare vendor key, not a URL — `new URL(...)` on it throws, so
 * the old code returned false immediately), and miss a URL's FRAGMENT entirely
 * (`url.searchParams` reflects only the `?query`, never the `#fragment`), so `#token=...`
 * rode through. Round 4 adds two signals, both reusing EXISTING, already-tested closed sets
 * (never a new regex heuristic): redactSecrets' own vendor-key/JWT/hex/bearer shapes as a
 * second, independent check on ANY string value; and the SAME secret-key-name check, applied
 * to the fragment too (parsed the same way a query string already is).
 */
describe("valueCarriesCredential (astra pack 83c, HIGH #5)", () => {
  const SENTINEL = "N71-SENTINEL";

  it("[neg] a bare vendor-key-shaped string is a credential even though it is not a URL", () => {
    expect(
      valueCarriesCredential({ id: "decl.self_attested", via: "sk-proj-ABCDEFGHIJKLMNOPQRST" }),
    ).toBe(true);
  });

  it("[neg] a credential named in a URL fragment (not the query) is still caught", () => {
    expect(
      valueCarriesCredential({
        id: "decl.self_attested",
        params: { endpoint: `https://host.invalid/#token=${SENTINEL}` },
      }),
    ).toBe(true);
  });

  it("[neg] a vendor key in 'bind' is caught the same way", () => {
    expect(valueCarriesCredential({ id: "decl.self_attested", bind: "AKIA" + "A".repeat(16) })).toBe(true);
  });

  it("control: an ordinary identifier string in via/bind is not a credential", () => {
    expect(
      valueCarriesCredential({ id: "decl.self_attested", via: "captureSnapshot", bind: "capturePhotoCid" }),
    ).toBe(false);
  });

  it("control: a URL fragment with no secret-shaped key or value is not a credential", () => {
    expect(valueCarriesCredential({ params: { callback: "https://h.invalid/cb#section-2" } })).toBe(false);
  });
});
