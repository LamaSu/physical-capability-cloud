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
 * Also here: scrubbing for DIAGNOSTIC text that leaves the gateway in a response (an adapter's
 * exception message, a status line). redactUrlCredentials replaces every URL-shaped token in the
 * text with a fixed marker (N71 round 4, astra pack 83c: there is no safe partial projection of a
 * URL embedded in arbitrary surrounding text — see the comment on URL_WITH_SCHEME), because an
 * error that quotes the URL a device was configured with quotes its credentials too (Node's fetch
 * does: "Request cannot be constructed from a URL that includes credentials: http://user:pass@host/").
 * redactDiagnostic adds redactSecrets. Neither is a substitute for not putting a value in the
 * message in the first place (N71).
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

// N71 round 4 (astra pack 83c, CRITICAL #1): rounds 2-3 tried to parse out a "safe" part of
// the URL to KEEP (host + path, as $2) and drop only userinfo/query/fragment around it. Both
// rounds' bugs were in that KEPT group, not the dropped ones:
//   - round 2/3: $2 excluded a wrapping-delimiter set (quote, angle bracket, backtick,
//     backslash) so the match wouldn't swallow `url='...'`. But those same characters are
//     LEGAL inside a real URL's userinfo/query/fragment, so a credential containing one
//     ended the match early, leaving the rest (the credential's tail, or a second
//     back-to-back URL) to fall outside the match and pass through .replace()'s /g loop
//     completely untouched.
//   - round 3 (astra pack 83c): even after fixing the DROPPED groups' boundary characters,
//     $2 itself never excluded comma, ':' or '@' — so a second, back-to-back URL (with its
//     OWN credentials) was consumed as if it were part of the first URL's "path" and
//     returned unchanged; and because $2 DID still exclude an apostrophe, a legal apostrophe
//     in an ordinary (credential-free) path truncated $2 — and therefore the whole match —
//     before the query group could even run, so a credential right after it was never
//     reached by any group.
//
// There is no fix that keeps parsing out a "safe" part of an arbitrary URL embedded in
// arbitrary surrounding text: any character excluded from the kept group to stop one bypass
// is legal syntax somewhere else and opens another. So round 4 keeps NOTHING. It matches a
// URL token conservatively (scheme through the next whitespace) and replaces the WHOLE thing
// with a fixed marker — never a reconstructed host/path, whether or not THIS token happens to
// carry a credential. A single bounded field that IS known to hold exactly one URL (not
// arbitrary prose) can still safely show host/path — but it must get there by parsing that
// field with the real URL constructor (as e.g. valueCarriesCredential does), never by this
// regex, and never by re-deriving a substring from matched groups.
const URL_WITH_SCHEME = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/** What redactUrlCredentials shows in place of an entire matched URL token. */
export const URL_REDACTED = "[url]";

/**
 * Replace every URL-shaped token in `s` — scheme through the next whitespace — with a fixed
 * marker. Conservative on purpose (N71 round 4, astra pack 83c): there is no safe partial
 * projection of a URL embedded in arbitrary surrounding text, so the whole token goes, not
 * just its userinfo/query/fragment, and not just the ones that happen to carry a credential.
 * Idempotent; text with no "scheme://" in it is returned unchanged.
 */
export function redactUrlCredentials(s: string): string {
  return s.replace(URL_WITH_SCHEME, URL_REDACTED);
}

/**
 * Scrub free text that is about to leave the gateway in a response (an adapter's exception message):
 * URL credentials first, then secret-shaped substrings (redactSecrets).
 */
export function redactDiagnostic(s: string): string {
  return redactSecrets(redactUrlCredentials(s));
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
 * Is `value` a plain identifier — safe to echo back in a diagnostic message (a device or
 * kernel id)? N71 round 3 (astra pack 83b): /setup/validate used to echo whatever a caller's
 * (or the server's own KERNEL_CONFIG's) `id`/`kernelId` field held, with no shape check — so an
 * operator who put a credential-bearing URL in an id field got it echoed back verbatim. A
 * non-string (e.g. an array, which stringifies to its contents when interpolated) is never
 * plain either. Checked against `redactSecrets` too: an identifier that happens to also be
 * vendor-key-shaped (`sk-...`) is not "plain" just because its characters are all alnum/hyphen.
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
