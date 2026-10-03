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
  // PEM private-key blocks, whole or cut off before the END line, in any letter case
  // (#458 round 1; N89). Runs first so the body isn't half-matched by the rules below.
  [/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|[\s\S]*$)/gi, "[redacted-private-key]"],
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

// A hex key wrapped across lines (N89): runs of 16 or more hex digits joined by line
// breaks, real or JSON-escaped, with 64 or more digits in all. Spaces don't join
// runs, so two ids on one line stay apart.
const WRAPPED_HEX = /(?<![0-9a-fA-F])(?:0[xX])?[0-9a-fA-F]{16,}(?:(?:\r?\n|\\r\\n|\\n)[ \t]*[0-9a-fA-F]{16,})+(?![0-9a-fA-F])/g;

function redactWrappedHex(run: string): string {
  return run.replace(/^0[xX]/, "").replace(/\\[rn]|\s/g, "").length >= 64 ? "[redacted-hex]" : run;
}

// A PKCS#8 private key in base64 or base64url, whole or wrapped (N89): what
// /api/auth/provision returns as private_key_pkcs8_base64. It is recognised by
// decoding its DER header (a SEQUENCE holding version 0 or 1, then the algorithm
// SEQUENCE), not by how it looks, so a public key (SPKI has no version) and other
// base64 survive. The span runs as far as the DER length says, across line breaks
// (real or JSON-escaped) and short runs of spaces.
const PKCS8_CANDIDATE = /(?<=^|[^A-Za-z0-9+/_-]|\\[nrt])M/g;

function isBase64Char(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9+/_-]/.test(c);
}

/** The index just past a gap that may sit inside a wrapped key, or `i` when there is none. */
function skipWrap(s: string, i: number): number {
  let j = i;
  if (s.startsWith("\r\n", j)) j += 2;
  else if (s[j] === "\n") j += 1;
  else if (s.startsWith("\\r\\n", j)) j += 4;
  else if (s.startsWith("\\n", j)) j += 2;
  const indent = j > i ? 8 : 2;
  for (let k = 0; k < indent && (s[j] === " " || s[j] === "\t"); k++) j++;
  return j;
}

/** Reads up to `count` base64 characters from `start`, across wraps. */
function readBase64(s: string, start: number, count: number): { chars: string; end: number } {
  let chars = "";
  let i = start;
  let end = start;
  while (chars.length < count && i < s.length) {
    if (isBase64Char(s[i])) {
      chars += s[i];
      end = ++i;
      continue;
    }
    const j = skipWrap(s, i);
    if (j === i || !isBase64Char(s[j])) break;
    i = j;
  }
  return { chars, end };
}

/** The DER byte length of a PKCS#8 PrivateKeyInfo whose first 16 base64 characters are `head`, or null. */
function pkcs8Length(head: string): number | null {
  const b = Buffer.from(head.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (b.length < 12 || b[0] !== 0x30) return null;
  let hdr: number;
  let len: number;
  if (b[1]! < 0x80) [hdr, len] = [2, b[1]!];
  else if (b[1] === 0x81) [hdr, len] = [3, b[2]!];
  else if (b[1] === 0x82) [hdr, len] = [4, (b[2]! << 8) | b[3]!];
  else return null;
  const versionThenAlgorithm = b[hdr] === 0x02 && b[hdr + 1] === 0x01 && (b[hdr + 2] === 0x00 || b[hdr + 2] === 0x01) && b[hdr + 3] === 0x30;
  return versionThenAlgorithm ? hdr + len : null;
}

function redactPkcs8Keys(s: string): string {
  let out = "";
  let last = 0;
  PKCS8_CANDIDATE.lastIndex = 0;
  for (let m = PKCS8_CANDIDATE.exec(s); m; m = PKCS8_CANDIDATE.exec(s)) {
    const head = readBase64(s, m.index, 16);
    const derLength = head.chars.length === 16 ? pkcs8Length(head.chars) : null;
    if (derLength === null) continue;
    let end = readBase64(s, m.index, Math.ceil((derLength * 4) / 3)).end;
    for (let k = 0; k < 2 && s[end] === "="; k++) end++;
    out += s.slice(last, m.index) + "[redacted-private-key]";
    last = end;
    PKCS8_CANDIDATE.lastIndex = end;
  }
  return out + s.slice(last);
}

// The value of a secret-named label (N89), in every form a pasted response or
// config takes: "name": "value", 'name': 'value', name: value, name=value, and
// \"name\":\"value\" inside JSON held in a JSON string. Quoted values are always
// redacted, up to the matching quote or, when unterminated, to the end. An unquoted
// value after ":" must look like a credential (a digit or symbol, or 12+ characters),
// so prose such as "password: wrong" survives.
const LABEL = /(?<![A-Za-z0-9_\\])(\\{0,3}["']|)([A-Za-z_][A-Za-z0-9_.-]{0,63})\1[ \t]*([:=])[ \t]*(?:\r?\n[ \t]*)?/g;
const QUOTE_TOKEN = /\\{0,3}["']/y;
const UNQUOTED_VALUE = /[^\s,;&)\]}'"<>]+/y;

// A name is secret when one of its words (split at _ - . and camelCase humps) is a
// secret word, or it says private key or API key: private_key_pkcs8_base64,
// privateKey, x-api-key, client_secret. seedling and secretary are not.
const SECRET_WORDS = new Set(["secret", "secrets", "password", "passwords", "passwd", "passphrase", "mnemonic", "seed", "privatekey", "apikey", "apikeys"]);

function isSecretName(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_.-]+/);
  return words.some((w, i) => SECRET_WORDS.has(w) || ((w === "private" || w === "api") && (words[i + 1] === "key" || words[i + 1] === "keys")));
}

/** Where a quoted value starting at `from` ends: the next quote `c` preceded by exactly `k` backslashes, or the end. */
function closingQuote(s: string, from: number, c: string, k: number): number {
  for (let i = from; ; ) {
    const j = s.indexOf(c, i);
    if (j < 0) return s.length;
    let b = 0;
    while (b <= k && j - b - 1 >= from && s[j - b - 1] === "\\") b++;
    if (b === k) return j - k;
    i = j + 1;
  }
}

function redactLabeledSecrets(s: string): string {
  let out = "";
  let last = 0;
  LABEL.lastIndex = 0;
  for (let m = LABEL.exec(s); m; m = LABEL.exec(s)) {
    if (!isSecretName(m[2]!)) continue;
    const valueAt = LABEL.lastIndex;
    let from = valueAt;
    let to: number;
    QUOTE_TOKEN.lastIndex = valueAt;
    const quote = QUOTE_TOKEN.exec(s);
    if (quote) {
      from = valueAt + quote[0].length;
      to = closingQuote(s, from, quote[0].slice(-1), quote[0].length - 1);
    } else {
      if (s.startsWith("[redacted", valueAt)) continue; // a rule above already took it
      UNQUOTED_VALUE.lastIndex = valueAt;
      const value = UNQUOTED_VALUE.exec(s)?.[0] ?? "";
      if (m[3] === ":" && !/[^A-Za-z]/.test(value) && value.length < 12) continue;
      if (/^[|>][-+]?$/.test(value)) continue; // a YAML block: the lines below are the value, and the rules above saw them
      to = valueAt + value.length;
    }
    if (to <= from) continue;
    out += s.slice(last, from) + REDACTED;
    last = to;
    LABEL.lastIndex = to;
  }
  return out + s.slice(last);
}

/** Replace secret-shaped substrings with a marker. Idempotent on already-clean text. */
export function redactSecrets(s: string): string {
  let out = s;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  out = out.replace(WRAPPED_HEX, redactWrappedHex);
  out = redactPkcs8Keys(out);
  // Last, so key material in a labeled value is already a marker: an unquoted value
  // ends at the first line break, which would leave the rest of a wrapped key.
  return redactLabeledSecrets(out);
}

/** redactSecrets that passes null through (for optional fields). */
export function redactOrNull(s: string | null): string | null {
  return s === null ? null : redactSecrets(s);
}
