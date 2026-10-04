import { describe, it, expect } from "vitest";
import {
  redactSecrets,
  redactOrNull,
  valueCarriesCredential,
  knownErrorClassName,
  looksUrlShaped,
  urlFormCarriesExtras,
  findEmitterManifestFormIssue,
  isPlainIdentifier,
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

/**
 * N71 round 5 (astra pack 83d, CRITICAL #1): checkDeviceHealth's console.warn used to log
 * err.message (scrubbed by the now-deleted redactUrlCredentials/redactDiagnostic). THE SINK
 * IS THE BOUNDARY now — a fixed code plus, at most, a closed-set class name, checked via
 * `instanceof` (never `.name`, which any thrown value can forge).
 */
describe("knownErrorClassName", () => {
  it("names a built-in subclass via instanceof", () => {
    expect(knownErrorClassName(new TypeError("x"))).toBe("TypeError");
    expect(knownErrorClassName(new RangeError("x"))).toBe("RangeError");
    expect(knownErrorClassName(new SyntaxError("x"))).toBe("SyntaxError");
    expect(knownErrorClassName(new ReferenceError("x"))).toBe("ReferenceError");
    expect(knownErrorClassName(new URIError("x"))).toBe("URIError");
    expect(knownErrorClassName(new EvalError("x"))).toBe("EvalError");
  });

  it("[neg] a plain Error falls back to the literal 'Error', never its .message", () => {
    expect(knownErrorClassName(new Error("password=N71-SENTINEL"))).toBe("Error");
  });

  it("[neg] a forged .name does not change the result — instanceof is what's checked, not .name", () => {
    const forged = Object.assign(new Error("password=N71-SENTINEL"), { name: "TypeError" });
    expect(knownErrorClassName(forged)).toBe("Error"); // NOT "TypeError" — forged is not instanceof TypeError
  });

  it("[neg] a non-Error throw (string, object) also falls back to 'Error'", () => {
    expect(knownErrorClassName("password=N71-SENTINEL")).toBe("Error");
    expect(knownErrorClassName({ message: "password=N71-SENTINEL" })).toBe("Error");
    expect(knownErrorClassName(null)).toBe("Error");
    expect(knownErrorClassName(undefined)).toBe("Error");
  });

  it("a real custom subclass (e.g. facade-errors.ts's NotFoundError) also falls back to 'Error' — not in the closed set", () => {
    class CustomError extends Error {}
    expect(knownErrorClassName(new CustomError("password=N71-SENTINEL"))).toBe("Error");
  });
});

/**
 * N71 round 5 (astra pack 83d, CRITICAL #1 / HIGH #5 residual): "parses as a URL" per the
 * round-5 brief's own definition — three independent, OR'd ways. The scheme-colon form
 * matters specifically because `new URL("http:u:pw@host")` SUCCEEDS (no "//" needed for a
 * WHATWG special scheme) — this is the exact bypass astra's CRITICAL #1 found in the
 * now-deleted redactUrlCredentials's `\b...://` matcher.
 */
describe("looksUrlShaped", () => {
  it("true: new URL() succeeds", () => {
    expect(looksUrlShaped("https://h.invalid/x")).toBe(true);
    expect(looksUrlShaped("mailto:ops@example.com")).toBe(true);
  });

  it("true: contains '://' even if not parseable as a whole string", () => {
    expect(looksUrlShaped("prefix http://u:p@h.invalid/x suffix")).toBe(true);
  });

  it("true: scheme-colon form with no '//' at all, for every listed special scheme", () => {
    for (const scheme of ["http", "https", "ws", "wss", "ftp", "file"]) {
      expect(looksUrlShaped(`${scheme}:u:p@h.invalid`), scheme).toBe(true);
    }
  });

  it("false: a plain identifier or bare word", () => {
    expect(looksUrlShaped("capturePhotoCid")).toBe(false);
    expect(looksUrlShaped("opcua-node")).toBe(false);
    expect(looksUrlShaped("commitment.labelHash")).toBe(false);
  });

  it("false: a colon-containing string whose prefix isn't even a valid scheme shape (digit-led)", () => {
    // NOTE: a WORD-led "scheme:rest" (e.g. "custom:thing") DOES satisfy condition 1
    // (new URL() accepts any alpha-led scheme as an opaque, non-special URL) — that's
    // not a gap, it's condition 1 correctly firing; this case instead exercises a
    // string none of the three conditions catch at all: no "://", not one of the six
    // special schemes, and not even a generically-valid scheme shape (must start with
    // an ASCII alpha, not a digit) for new URL() to accept.
    expect(looksUrlShaped("3:30pm")).toBe(false);
  });
});

describe("urlFormCarriesExtras", () => {
  const SENTINEL = "N71-SENTINEL";

  it("[neg] astra's own example: a query with a non-credential-named key", () => {
    expect(urlFormCarriesExtras(`https://h.invalid/?session=${SENTINEL}`)).toBe(true);
  });

  it("[neg] a fragment with a non-credential-named key", () => {
    expect(urlFormCarriesExtras(`https://h.invalid/#session=${SENTINEL}`)).toBe(true);
  });

  it("[neg] userinfo", () => {
    expect(urlFormCarriesExtras(`https://u:${SENTINEL}@h.invalid/`)).toBe(true);
  });

  it("[neg] the scheme-colon, no-'//' bypass WITH userinfo", () => {
    expect(urlFormCarriesExtras(`http:u:${SENTINEL}@h.invalid`)).toBe(true);
  });

  it("[neg] scheme-colon-shaped but unparseable fails closed (refused)", () => {
    expect(urlFormCarriesExtras("https:")).toBe(true); // special-scheme-colon form; new URL("https:") throws
  });

  it("control: a plain scheme+host+path URL, no userinfo/query/fragment", () => {
    expect(urlFormCarriesExtras("https://h.invalid/cb")).toBe(false);
  });

  it("control: not URL-shaped at all", () => {
    expect(urlFormCarriesExtras("capturePhotoCid")).toBe(false);
    expect(urlFormCarriesExtras("ops@example.com")).toBe(false);
  });
});

/**
 * N71 round 5 (astra pack 83d, HIGH #5 residual): the determinate part of F5, independent
 * of valueCarriesCredential. See redaction.ts's section comment for the full rationale and
 * 83e-n71-report.md for the real-manifest inventory this grammar is derived from.
 */
describe("findEmitterManifestFormIssue", () => {
  const SENTINEL = "N71-SENTINEL";

  it("[neg] astra's own example: a URL query with a non-credential-named key → url_form", () => {
    expect(
      findEmitterManifestFormIssue([{ id: "decl.self_attested", params: { endpoint: `https://h.invalid/?session=${SENTINEL}` } }]),
    ).toBe("url_form");
  });

  it("[neg] the same, nested inside an array inside params → url_form (recursive walk)", () => {
    expect(
      findEmitterManifestFormIssue([
        { id: "decl.self_attested", params: { hops: [{ ok: 1 }, { endpoint: `https://h.invalid/?session=${SENTINEL}` }] } },
      ]),
    ).toBe("url_form");
  });

  it("[neg] bind that is not a plain identifier → bind_grammar", () => {
    expect(findEmitterManifestFormIssue([{ id: "decl.self_attested", bind: "cid/with/slash" }])).toBe("bind_grammar");
  });

  it("[neg] via that is not a plain identifier → via_grammar", () => {
    expect(findEmitterManifestFormIssue([{ id: "decl.self_attested", via: "capture snapshot" }])).toBe("via_grammar");
  });

  it("[neg] a URL with userinfo in bind → url_form (checked before the grammar check)", () => {
    expect(
      findEmitterManifestFormIssue([{ id: "decl.self_attested", bind: `https://u:${SENTINEL}@h.invalid` }]),
    ).toBe("url_form");
  });

  it("returns null for a clean manifest", () => {
    expect(
      findEmitterManifestFormIssue([
        { id: "decl.self_attested" },
        { id: "capture.photo_nonced", params: { media: "photo", minClass: "CC1" }, bind: "capturePhotoCid", via: "captureSnapshot" },
      ]),
    ).toBeNull();
  });

  it("control: every bind/via value found anywhere in the repo today (see 83e-n71-report.md) returns null", () => {
    const manifest = [
      { id: "decl.self_attested" },
      { id: "ident.registered_key", via: "toKernelOutput" },
      { id: "receipt.kernel_signed", via: "toKernelOutput" },
      { id: "artifact.hash", bind: "outputArtifactCid", via: "gcode" },
      { id: "artifact.hash", bind: "outputDocumentCid", via: "print" },
      { id: "telemetry.envelope_conformance", via: "telemetry" },
      { id: "telemetry.envelope_conformance", via: "opcua-node" },
      { id: "telemetry.envelope_conformance", via: "sila-feature" },
      { id: "confirm.target_system", params: { channel: "api" }, via: "http-response" },
      { id: "capture.photo_nonced", bind: "capturePhotoCid", via: "captureSnapshot" },
      { id: "artifact.hash", bind: "sensorLogCid", via: "stopRecording" },
      { id: "artifact.hash", bind: "cid", via: "x" },
      { id: "decl.self_attested", bind: "declaration" },
      { id: "machine.execution_log", bind: "machineLogChainCid" },
      { id: "telemetry.envelope_conformance", bind: "sensorSummaryCid" },
      { id: "decl.self_attested", bind: "printer_log_captured" },
      { id: "decl.self_attested", bind: "commitment.labelHash" },
      { id: "decl.self_attested", bind: "recipientSignatureCid" },
    ];
    for (const decl of manifest) {
      if (decl.bind) expect(isPlainIdentifier(decl.bind), `bind=${decl.bind}`).toBe(true);
      if (decl.via) expect(isPlainIdentifier(decl.via), `via=${decl.via}`).toBe(true);
    }
    expect(findEmitterManifestFormIssue(manifest)).toBeNull();
  });
});
