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
  // More vendor shapes (#458 round 1): Google API keys (AIza…), Stripe secret and
  // restricted keys (sk_/rk_ live/test), GitHub app and fine-grained tokens, and
  // Hugging Face tokens.
  [new RegExp(`${NLB}(?:AIza[0-9A-Za-z_-]{35}|[sr]k_(?:live|test)_[0-9A-Za-z]{10,}|gh[usr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|hf_[A-Za-z0-9]{30,})(?![A-Za-z0-9_-])`, "g"), "[redacted-key]"],
];

// `token=…`, `api_key: …`, `password=…` and similar: the value is redacted when it
// looks like a credential (it holds a digit, or is 16+ characters), so prose such
// as "token: expired" survives.
const KEY_VALUE = /(?<![A-Za-z0-9])(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd)(\s*[=:]\s*)(["']?)([^\s"'&,;]{8,})/gi;

/** Replace secret-shaped substrings with a marker. Idempotent on already-clean text. */
export function redactSecrets(s: string): string {
  let out = s;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  out = out.replace(KEY_VALUE, (m, key: string, sep: string, quote: string, value: string) =>
    /\d/.test(value) || value.length >= 16 ? `${key}${sep}${quote}${REDACTED}` : m,
  );
  return out;
}

/** redactSecrets that passes null through (for optional fields). */
export function redactOrNull(s: string | null): string | null {
  return s === null ? null : redactSecrets(s);
}
