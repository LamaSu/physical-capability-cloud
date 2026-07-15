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

const PATTERNS: Array<[RegExp, string]> = [
  // Authorization: Bearer <token>
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer " + REDACTED],
  // PCC API keys — pcc_live_… / pcc_test_… (keep the prefix, drop the secret)
  [/\bpcc_(live|test)_[A-Za-z0-9]{6,}/gi, "pcc_$1_" + REDACTED.slice(1, -1)],
  // JSON Web Tokens (header.payload.signature; header is base64 of `{"…`)
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, "[redacted-jwt]"],
  // Private-key / 64-hex secrets (0x + 64 hex). A 40-hex ADDRESS is public → NOT matched.
  [/\b0x[0-9a-fA-F]{64,}\b/g, "0x" + REDACTED],
  // Common vendor key shapes (OpenAI sk-, GitHub ghp_/gho_, Slack xox*, AWS AKIA)
  [/\b(?:sk-[A-Za-z0-9]{16,}|gh[po]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, "[redacted-key]"],
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
