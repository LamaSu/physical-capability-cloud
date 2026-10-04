/**
 * Secret scrubbing for the public feedback sink (agent auto-feedback, Phase 2).
 *
 * Defense-in-depth: agents are told (system_prompt + report_hint) never to send
 * secrets, but a cold agent pasting a raw error body might include one. The server
 * scrubs secret-SHAPED substrings from agent-supplied FREE TEXT (summary / detail /
 * logs[].note) before persisting. Deliberately conservative — only patterns with a
 * very low false-positive rate, and it NEVER redacts a public wallet address
 * (0x + 40 hex): only 64-hex private-key-length values.
 *
 * Not a security boundary on its own — it reduces accidental leakage; the real
 * control is that the agent should never send secrets. Unit-tested in redaction.test.ts.
 *
 * N71 round 5 (astra pack 83d, CRITICAL #1) DELETED the diagnostic-text scrubber that
 * used to live here (redactUrlCredentials / redactDiagnostic / URL_REDACTED). Rounds
 * 2-4 each patched a new bypass of "find the URL token and replace it" (an underscore
 * shielding it from a \b boundary, an apostrophe inside a credential truncating the
 * kept group, a second back-to-back URL swallowed as "path") — and round 5 found a
 * WHATWG-valid "scheme:userinfo@host" with no "//" in it at all, which a fetch-alike
 * would still read the userinfo of. That is a confidentiality hole no regex boundary
 * can close for good, because the next bypass is always one more delimiter choice
 * away. The lane's rule now: THE SINK IS THE BOUNDARY — a diagnostic sink
 * (kernel-service.ts's health-check log; the OTel span in base.facade.ts) emits a
 * fixed code and, at most, a CLOSED-SET class name. Never a dependency's message,
 * scrubbed or not.
 *
 * Also here, a DIFFERENT role from the above (admission, not disclosure):
 * findEmitterManifestFormIssue and isPlainIdentifier refuse bad INPUT at the door —
 * they are not output scrubbers, even though both are "closed-set" in spirit.
 */

export const REDACTED = "[redacted]";

// Boundary strategy (review r3 #1 + r4 #1): use a negative lookbehind for an
// ALPHANUMERIC neighbor — NOT `\b`, which treats `_` as a word char and so is shielded
// by an underscore (`trace_pcc_live_…`), and NOT boundary-less, which over-redacts a key
// prefix embedded in an ordinary word (`task-force` contains `sk-force`). `(?<![A-Za-z0-9])`
// blocks a letter/digit neighbor while still allowing `_`, `-`, whitespace, and start.
const NLB = "(?<![A-Za-z0-9])"; // "not preceded by an identifier char"
const PATTERNS: Array<[RegExp, string]> = [
  // Authorization: Bearer <token>
  [new RegExp(`${NLB}Bearer\\s+[A-Za-z0-9._~+/=-]{12,}`, "gi"), "Bearer " + REDACTED],
  // PCC API keys — pcc_live_… / pcc_test_… . The secret body may contain _ or - .
  [new RegExp(`${NLB}pcc_(live|test)_[A-Za-z0-9_-]{6,}`, "gi"), "pcc_$1_redacted"],
  // JSON Web Tokens (header.payload.signature; header is base64 of `{"…`)
  [new RegExp(`${NLB}eyJ[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}`, "g"), "[redacted-jwt]"],
  // 64-hex secret (private key), WITH OR WITHOUT a 0x/0X prefix. Hex-specific
  // lookarounds so an underscore neighbor can't shield it and a 64-prefix of a longer
  // hex run isn't half-matched. A 40-hex address (public) is shorter → NOT matched.
  [/(?<![0-9a-fA-F])(?:0[xX])?[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g, "[redacted-hex]"],
  // Vendor key shapes: OpenAI sk- (incl. modern sk-proj-…), GitHub ghp_/gho_, Slack
  // xox*, AWS AKIA. Bounded both sides so a prefix inside a word (task-force) is safe.
  [new RegExp(`${NLB}(?:sk-[A-Za-z0-9_-]{16,}|gh[po]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})(?![A-Za-z0-9])`, "g"), "[redacted-key]"],
];

/** Replace secret-shaped substrings with a marker. Idempotent on already-clean text. */
export function redactSecrets(s: string): string {
  let out = s;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}

/** redactSecrets that passes null through (for optional fields). */
export function redactOrNull(s: string | null): string | null {
  return s === null ? null : redactSecrets(s);
}

// ---------------------------------------------------------------------------
// N71 round 3 (astra pack 83b): a few /detect and /setup/status fields are not a
// URL at all — a network name, a storage engine, a port, a NODE_ENV value — so
// redactUrlCredentials has nothing to parse. The same mistake (pasting a
// credential into the wrong env var) can land in any of them, so each gets a
// small fixed allow-list or a type check instead of a free-form scrub: show the
// value only when it PROVABLY is one of the few things it is supposed to be
// ("fail closed", astra's phrase for the minimal fix) — never "scrubbed, not
// generic", which astra's verdict names as insufficient on its own.
// ---------------------------------------------------------------------------

const KNOWN_NODE_ENVS = new Set(["test", "development", "production", "staging"]);
/** PCC_NETWORK values actually used in this repo (chain-client.ts, escrow-client.ts,
 *  protocol-client.ts, bundler-config.ts REDACT_KEEP). Not exhaustive of every chain
 *  that could ever be added — a new one shows as presence-only until added here,
 *  which is the fail-closed direction to be wrong in. */
const KNOWN_PCC_NETWORKS = new Set([
  "base", "base-sepolia", "sepolia", "ethereum", "mainnet", "polygon", "flow-evm-testnet",
]);
const KNOWN_STORAGE_TYPES = new Set(["local", "helia", "storacha"]);

export function isKnownNodeEnv(value: string): boolean {
  return KNOWN_NODE_ENVS.has(value);
}
export function isKnownPccNetwork(value: string): boolean {
  return KNOWN_PCC_NETWORKS.has(value.toLowerCase());
}
export function isKnownStorageType(value: string): boolean {
  return KNOWN_STORAGE_TYPES.has(value);
}
/** A bare port number (1-5 digits). Display-safety check only, not a range validator. */
export function isPlainPort(value: string): boolean {
  return /^\d{1,5}$/.test(value);
}

/**
 * Built-in ECMAScript Error subclasses whose CLASS NAME ALONE is safe to disclose: it
 * carries no message content, only which standard JS error category fired. N71 round 5
 * (astra pack 83d, CRITICAL #1): kernel-service.ts's checkDeviceHealth used to log
 * `err.message` (scrubbed, then not even that) when an adapter's getStatus() threw.
 * There is no scrub that closes every bypass of "find the secret inside arbitrary
 * prose" (see the file doc comment) — so the fix stops disclosing the message AT ALL,
 * fixed code + at most a class name. Checked via `instanceof`, never `.name` — `.name`
 * is a writable string any thrown value can forge with a plain property write.
 * `instanceof` is harder to spoof (it takes rewriting the prototype chain, e.g.
 * `Object.setPrototypeOf(new Error("x"), TypeError.prototype)`, not just a property
 * write) but N71 round 6 (astra pack 83e, L3) is explicit that it is not an unforgeable
 * identity proof either — that exact call makes `instanceof TypeError` pass without the
 * value ever being constructed via `new TypeError(...)`. What makes knownErrorClassName
 * (below) safe is not that its `instanceof` checks can't be spoofed; it is a closed
 * CLASSIFIER — every branch returns one literal from the fixed list right below, so even
 * a prototype-swapped error can only ever select a different fixed literal, never
 * attacker text. Deliberately NOT exhaustive (no AggregateError, no Node `SystemError`): a closed set
 * is supposed to be small, and every adapter in this repo throws a plain `Error` anyway
 * (see 83e-n71-report.md's inventory) — this just leaves room for the handful of
 * standard subclasses a transport/parsing failure could plausibly throw.
 */
const KNOWN_BUILTIN_ERROR_CLASSES: ReadonlyArray<readonly [string, new (message?: string) => Error]> = [
  ["TypeError", TypeError],
  ["RangeError", RangeError],
  ["SyntaxError", SyntaxError],
  ["ReferenceError", ReferenceError],
  ["URIError", URIError],
  ["EvalError", EvalError],
];

/** The literal name shown for anything NOT in the closed set above — including a
 *  non-Error throw, a bare `Error`, or a custom subclass this set doesn't name. */
export const UNKNOWN_ERROR_CLASS = "Error";

/** A fixed, closed-set class name for `err` — never `.message`, never `.name` (forgeable).
 *  Falls back to the literal "Error" for anything not in the known set, a bare `Error`,
 *  or a non-Error throw. Safe to log or export: it discloses a JS error CATEGORY, never
 *  content a thrower controls. */
export function knownErrorClassName(err: unknown): string {
  if (err instanceof Error) {
    for (const [name, ctor] of KNOWN_BUILTIN_ERROR_CLASSES) {
      if (err instanceof ctor) return name;
    }
  }
  return UNKNOWN_ERROR_CLASS;
}

/**
 * Is `value` a plain identifier — safe to echo back in a diagnostic message (a device or
 * kernel id)? N71 round 3 (astra pack 83b): /setup/validate used to echo whatever a caller's
 * (or the server's own KERNEL_CONFIG's) `id`/`kernelId` field held, with no shape check — so an
 * operator who put a credential-bearing URL in an id field got it echoed back verbatim. A
 * non-string (e.g. an array, which stringifies to its contents when interpolated) is never
 * plain either. Checked against `redactSecrets` too: an identifier that happens to also be
 * vendor-key-shaped (`sk-...`) is not "plain" just because its characters are all alnum/hyphen.
 *
 * Second use (N71 round 5, astra pack 83d HIGH #5 residual): the SAME grammar is reused,
 * unchanged, as the emitter-manifest gate's bind/via identifier check — see
 * findEmitterManifestFormIssue below. Both uses are ADMISSION gates (refuse bad input),
 * never an output boundary.
 */
export function isPlainIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) &&
    redactSecrets(value) === value
  );
}
/** What `/setup/validate` shows in place of a non-plain identifier. */
export const INVALID_ID = "[invalid id]";

/**
 * N71 round 6 (astra pack 83e): the general-purpose version of the `isPlainIdentifier`
 * echo pattern above, for any sink (a log, a span attribute, a telemetry event) that
 * wants to carry a caller- or operator-supplied id. Returns `value` unchanged when it IS
 * a plain identifier (an ordinary job/kernel/device id — never a credential, URL or
 * free-text sentence, since `isPlainIdentifier` already rejects those), else the fixed
 * literal `INVALID_ID` — never throws, and never echoes anything that isn't `value`
 * itself. THE SINK IS THE BOUNDARY: this is the one place every sink in the 12-file
 * scope launders an id through before logging/recording it (see the sink scanner,
 * n71-sink-scanner.test.ts, and 83f-n71-report.md for the full inventory).
 */
export function logSafeId(value: unknown): string {
  return isPlainIdentifier(value) ? value : INVALID_ID;
}

/**
 * A small integer safe to log: `value` itself when it is an integer within [min, max], otherwise
 * null. For fields that are typed as numbers but arrive from a request body, unchecked at runtime.
 */
export function logSafeSmallInt(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

// ---------------------------------------------------------------------------
// N71 round 3 (astra pack 83b, Q3): does an arbitrary caller-supplied value carry
// something that reads as a credential? Used to REFUSE a public matching artifact (a
// device's emits[] manifest, returned verbatim by every registration view) at the
// door — not to scrub a response. Independent signals, any one is enough:
//   - a secret-SHAPED key anywhere in the structure (apiKey, token, password, ...),
//     regardless of its value;
//   - a string value that is a URL with non-empty userinfo (via the real WHATWG URL
//     parser, not a hand-rolled regex — the same one Node's fetch uses, so it agrees
//     on what counts as userinfo, apostrophe included), or whose query OR FRAGMENT
//     names a secret-shaped key (N71 round 4, astra pack 83c HIGH #5: a fragment is
//     not part of `.searchParams` — that reflects only the `?query` — but is
//     conventionally `key=value`-shaped too, e.g. an OAuth2 implicit-flow token);
//   - ANY string value (URL or not) that is itself vendor-key/JWT/hex/bearer-shaped
//     (N71 round 4, astra pack 83c HIGH #5: reuses redactSecrets' own, already-tested
//     shapes — never a new pattern — so a bare `via: "sk-proj-..."` is caught even
//     though it is not a URL at all and `new URL(...)` on it throws).
// A plain identifier, a URL with no userinfo and an ordinary query (?id=7), or a bare
// non-URL, non-vendor-key-shaped string (a CSD id, a bind/via identifier) never
// matches any signal — verified empirically against both the attack cases and the
// controls below before this was written, not just reasoned about.
// ---------------------------------------------------------------------------

const SECRET_KEY_NAME =
  /^(api[-_]?key|secret|token|password|passwd|pwd|auth|credentials?|private[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token)$/i;

/** Does a URL's fragment (`#`-prefixed or not) carry a credential-shaped key or value?
 *  `.searchParams` never sees this — it reflects only the `?query` — so without this,
 *  `#token=...` rode through untouched (N71 round 4, astra pack 83c HIGH #5). */
function fragmentCarriesCredential(hash: string): boolean {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return false;
  if (redactSecrets(raw) !== raw) return true; // vendor-key/JWT/hex/bearer shape anywhere in it
  for (const key of new URLSearchParams(raw).keys()) {
    if (SECRET_KEY_NAME.test(key)) return true;
  }
  return false;
}

function stringLooksLikeCredential(s: string): boolean {
  // N71 round 4 (astra pack 83c, HIGH #5): a value does not need to be a URL to be
  // credential-shaped — `via: "sk-proj-..."` is a bare vendor key, not a URL. Reuse the
  // SAME shapes redactSecrets already recognizes (never a new pattern) as an
  // independent signal, checked before (and regardless of) URL parsing.
  if (redactSecrets(s) !== s) return true;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return false; // not an absolute URL — nothing more to check here
  }
  if (url.username || url.password) return true;
  for (const key of url.searchParams.keys()) {
    if (SECRET_KEY_NAME.test(key)) return true;
  }
  if (url.hash && fragmentCarriesCredential(url.hash)) return true;
  return false;
}

/** Recursively walk any JSON-shaped value for a credential-shaped key or value. */
export function valueCarriesCredential(value: unknown): boolean {
  if (typeof value === "string") return stringLooksLikeCredential(value);
  if (Array.isArray(value)) return value.some((v) => valueCarriesCredential(v));
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_NAME.test(key)) return true;
      if (valueCarriesCredential(v)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// N71 round 5 (astra pack 83d, HIGH #5 residual): valueCarriesCredential (above) is a
// SHAPE-based signal — a secret-named key, URL userinfo, a query/fragment key from a
// small fixed list, or a vendor-key/JWT/hex/bearer shape. Astra's round-5 example
// defeats all of it: {endpoint: "https://h.invalid/?session=<secret>"} names no
// recognized key, and the VALUE itself isn't vendor-key-shaped. Nothing about this
// value's SHAPE reads as a credential — no finite key-name list can ever be complete,
// because the next bypass is just the next key name nobody thought to list.
//
// The determinate fix is not a better shape-matcher; it is to stop admitting a
// manifest URL's query/fragment/userinfo AT ALL, full stop — a manifest string is for
// MATCHING, so scheme+host+path is enough. bind/via get the companion fix: a closed
// identifier grammar (isPlainIdentifier, reused verbatim), derived empirically from
// every bind/via value that exists in this repo today (see 83e-n71-report.md's
// inventory — adapter-manifests.ts's production defaults, the CSD fixture, every
// test). Neither check REPLACES valueCarriesCredential; both are independent, NARROWER
// admission gates (fail-closed on syntax, not on guessed intent).
//
// Explicitly OUT of scope (escalated to the steward as a cross-lane row, per the
// round-5 brief): per-primitive semantic param schemas — which keys/types a given
// primitive id's params may hold. `params` stays z.record(z.unknown()) at the
// spec-schema level (packages/spec, untouched this round); this gate is the
// GATEWAY's own boundary check on top of it.
// ---------------------------------------------------------------------------

/** A WHATWG special scheme written as "<scheme>:" — part of N71 round 5's "parses as
 *  a URL" test. Matters because a special-scheme URL is valid WITHOUT "//" at all
 *  (`new URL("http:u:pw@host")` succeeds, with userinfo "u:pw" and host "host" — see
 *  the file doc comment's CRITICAL #1), so neither `new URL()` succeeding nor a literal
 *  "://" substring alone would catch it if checked in isolation; this is the third,
 *  independent way a string can "parse as a URL". */
const SPECIAL_SCHEME_COLON = /^(?:https?|wss?|ftp|file):/i;

/**
 * Does `s` "parse as a URL", per N71 round 5's definition (three independent ways —
 * any one is enough): `new URL()` succeeds on it; it contains "://"; or it is the
 * scheme-colon form for a WHATWG special scheme (http/https/ws/wss/ftp/file) with no
 * "//" at all. Deliberately broader than any ONE of these alone: rounds 2-4's bypasses
 * were each exactly one delimiter choice escaping a narrower test.
 */
export function looksUrlShaped(s: string): boolean {
  if (SPECIAL_SCHEME_COLON.test(s)) return true;
  if (s.includes("://")) return true;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does `s` parse as a URL (looksUrlShaped) AND carry userinfo, a query, or a fragment?
 * N71 round 5's determinate fix for astra pack 83d CRITICAL #1 / HIGH #5: a manifest
 * value that is a URL at all gets scheme+host+path only, key name or content
 * irrelevant. If `s` is scheme-colon-shaped (looksUrlShaped) but `new URL()` itself
 * still throws on it (a malformed special-scheme string), fail closed and refuse too —
 * there is no way to otherwise prove the absence of userinfo/query/fragment in it.
 */
export function urlFormCarriesExtras(s: string): boolean {
  if (!looksUrlShaped(s)) return false;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return true; // scheme-colon-shaped but unparseable — fail closed, refuse
  }
  return Boolean(url.username || url.password || url.search || url.hash);
}

/** Closed set of reasons findEmitterManifestFormIssue can refuse a manifest. Internal
 *  to the implementer/tests — setup.ts collapses every one to the SAME public
 *  400 invalid_emitter_manifest; the reason itself is never echoed to a caller. */
export type EmitterManifestFormIssue = "url_form" | "bind_grammar" | "via_grammar";

/**
 * F5's determinate admission gate (N71 round 5, astra pack 83d). Walks every
 * declaration's `params` (recursively), `bind`, and `via` — NOT `id` or
 * `demonstrated` — looking for:
 *   - any string that parses as a URL (looksUrlShaped) and carries userinfo, a query,
 *     or a fragment → "url_form";
 *   - a `bind` present but not a plain identifier (isPlainIdentifier) → "bind_grammar";
 *   - a `via` present but not a plain identifier → "via_grammar".
 * Returns the FIRST issue found, or `null` if the manifest is clean. Independent of,
 * and run ALONGSIDE, valueCarriesCredential — see the section comment above for why
 * neither replaces the other, and for what is deliberately NOT checked here.
 */
export function findEmitterManifestFormIssue(
  emits: readonly unknown[],
): EmitterManifestFormIssue | null {
  function walkParamValue(v: unknown): EmitterManifestFormIssue | null {
    if (typeof v === "string") {
      return urlFormCarriesExtras(v) ? "url_form" : null;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        const issue = walkParamValue(item);
        if (issue) return issue;
      }
      return null;
    }
    if (v && typeof v === "object") {
      for (const val of Object.values(v as Record<string, unknown>)) {
        const issue = walkParamValue(val);
        if (issue) return issue;
      }
    }
    return null;
  }

  for (const decl of emits) {
    if (!decl || typeof decl !== "object") continue;
    const d = decl as Record<string, unknown>;
    // The URL-form rule covers EVERY string in the declaration: its id, params at any depth,
    // bind and via. Each one is stored and returned as part of a public artifact.
    const formIssue = walkParamValue(d);
    if (formIssue) return formIssue;
    if (typeof d.bind === "string") {
      if (urlFormCarriesExtras(d.bind)) return "url_form";
      if (!isPlainIdentifier(d.bind)) return "bind_grammar";
    }
    if (typeof d.via === "string") {
      if (urlFormCarriesExtras(d.via)) return "url_form";
      if (!isPlainIdentifier(d.via)) return "via_grammar";
    }
  }
  return null;
}
