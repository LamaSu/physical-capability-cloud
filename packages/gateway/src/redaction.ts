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
 */

const REDACTED = "[redacted]";

// Boundary strategy (review r3 #1 + r4 #1): use a negative lookbehind for an
// ALPHANUMERIC neighbor — NOT `\b`, which treats `_` as a word char and so is shielded
// by an underscore (`trace_pcc_live_…`), and NOT boundary-less, which over-redacts a key
// prefix embedded in an ordinary word (`task-force` contains `sk-force`). `(?<![A-Za-z0-9])`
// blocks a letter/digit neighbor while still allowing `_`, `-`, whitespace, and start.
const NLB = "(?<![A-Za-z0-9])"; // "not preceded by an identifier char"
const PATTERNS: Array<[RegExp, string]> = [
  // PEM private-key blocks, including a block cut off before its END line (#458
  // round 1). Runs first so the body isn't half-matched by the rules below.
  [/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|[\s\S]*$)/g, "[redacted-private-key]"],
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

// The value of a secret-named JSON field (N89): /api/auth/provision returns the
// agent's Ed25519 key as "private_key_pkcs8_base64": "…", and the operator wallet's
// key as "private_key". Names match case-insensitively, so privateKey and apiKey
// count. An escaped quote inside the value doesn't end it.
const JSON_STRING_FIELD = /"([A-Za-z0-9_-]+)"(\s*:\s*)"(?:[^"\\]|\\[\s\S])*"/g;
const SECRET_FIELD_NAME = /private[_-]?key|secret|api[_-]?key|passw(?:or)?d|mnemonic|seed/i;

// Base64 key material, such as a PKCS#8 key, has no fixed prefix (N89). A run of 40
// or more base64 characters counts as one when it mixes upper case, lower case and
// digits, which a path, an id or a sentence almost never does. A hex run is left
// alone: a 64-hex key is already redacted above, and a checksummed 40-hex wallet
// address is public.
const BASE64_RUN = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}/g;

function redactBase64Run(run: string): string {
  if (/^(?:0[xX])?[0-9a-fA-F]+$/.test(run)) return run;
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run) ? "[redacted-b64]" : run;
}

/** Replace secret-shaped substrings with a marker. Idempotent on already-clean text. */
export function redactSecrets(s: string): string {
  let out = s;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  out = out.replace(JSON_STRING_FIELD, (m, name: string, sep: string) =>
    SECRET_FIELD_NAME.test(name) ? `"${name}"${sep}"${REDACTED}"` : m,
  );
  return out.replace(BASE64_RUN, redactBase64Run);
}

/** redactSecrets that passes null through (for optional fields). */
export function redactOrNull(s: string | null): string | null {
  return s === null ? null : redactSecrets(s);
}
