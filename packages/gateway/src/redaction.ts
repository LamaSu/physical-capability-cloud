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
 * exception message, a status line). redactUrlCredentials drops the userinfo, query and fragment
 * of every URL in the text, because an error that quotes the URL a device was configured with
 * quotes its credentials too (Node's fetch does: "Request cannot be constructed from a URL that
 * includes credentials: http://user:pass@host/"). redactDiagnostic adds redactSecrets. Neither is
 * a substitute for not putting a value in the message in the first place (N71).
 */

const REDACTED = "[redacted]";

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

// scheme://[userinfo@]authority-and-path[?query][#fragment], per URL grammar: the authority ends at the
// first "/", "?" or "#" (or whitespace/quote), and its userinfo is everything before the LAST "@" in it.
// Userinfo, query and fragment are dropped; the location (host, port, path) is kept.
const URL_WITH_SCHEME =
  /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/?#'"<>`\\]*@)?([^\s?#'"<>`]*)(?:\?[^\s#'"<>`]*)?(?:#[^\s'"<>`]*)?/gi;

/**
 * Drop the credentials from every URL in `s`: userinfo (`user:pass@`), query string and fragment, which
 * routinely carry tokens (`?apikey=...`). The scheme, host, port and path stay, so the text is still a
 * usable diagnostic. Idempotent; text with no URL in it is returned unchanged.
 */
export function redactUrlCredentials(s: string): string {
  return s.replace(URL_WITH_SCHEME, "$1$2");
}

/**
 * Scrub free text that is about to leave the gateway in a response (an adapter's exception message):
 * URL credentials first, then secret-shaped substrings (redactSecrets).
 */
export function redactDiagnostic(s: string): string {
  return redactSecrets(redactUrlCredentials(s));
}
