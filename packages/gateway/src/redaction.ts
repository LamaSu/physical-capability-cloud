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
 * Linear time (WP-D R1): every scan in this file costs time proportional to its
 * input. A regex here is either a literal head followed by character classes that
 * cannot re-match what they skipped, or a sticky (anchored) test whose tail is one
 * greedy class at the END of the pattern, so it never backtracks. The JWT shape,
 * whose regex form restarted at every `-eyJ` and rescanned to the end of the run
 * (quadratic), is matched by jwtAt() instead, which skips every start it has
 * already proven to fail.
 *
 * Budgets are explicit (astra pack 97): a label name is read at most MAX_LABEL_RAW
 * characters long and decoded to at most MAX_LABEL_NAME; a connection-string or
 * form separator is looked for FIELD_SEP_WINDOW characters ahead; a mnemonic is
 * checksummed at most MNEMONIC_CHECKSUM_BUDGET times per string; a wrapped hex key
 * is joined over at most WRAPPED_HEX_MAX_LINES lines. Past a budget the scan fails
 * CLOSED (redacts) and never open.
 */

import { createHash } from "node:crypto";
import { english as BIP39_ENGLISH } from "viem/accounts";

const REDACTED = "[redacted]";

// Boundary strategy (review r3 #1 + r4 #1): use a negative lookbehind for an
// ALPHANUMERIC neighbor — NOT `\b`, which treats `_` as a word char and so is shielded
// by an underscore (`trace_pcc_live_…`), and NOT boundary-less, which over-redacts a key
// prefix embedded in an ordinary word (`task-force` contains `sk-force`). `(?<![A-Za-z0-9])`
// blocks a letter/digit neighbor while still allowing `_`, `-`, whitespace, and start.
const NLB = "(?<![A-Za-z0-9])"; // "not preceded by an identifier char"

// Authorization: Bearer <token>
const BEARER_RE = new RegExp(`${NLB}Bearer\\s+[A-Za-z0-9._~+/=-]{12,}`, "gi");
// PCC API keys — pcc_live_… / pcc_test_… . The secret body may contain _ or - .
const PCC_KEY_RE = new RegExp(`${NLB}pcc_(live|test)_[A-Za-z0-9_-]{6,}`, "gi");
// 64-hex secret (private key), WITH OR WITHOUT a 0x/0X prefix. Hex-specific
// lookarounds so an underscore neighbor can't shield it and a 64-prefix of a longer
// hex run isn't half-matched. A 40-hex address (public) is shorter → NOT matched.
const HEX_SECRET_RE = /(?<![0-9a-fA-F])(?:0[xX])?[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g;
// Vendor key shapes: OpenAI sk- (incl. modern sk-proj-…), GitHub ghp_/gho_, Slack
// xox*, AWS AKIA. Bounded both sides so a prefix inside a word (task-force) is safe.
const VENDOR_KEY_RE = new RegExp(
  `${NLB}(?:sk-[A-Za-z0-9_-]{16,}|gh[po]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})(?![A-Za-z0-9])`,
  "g",
);

/** Replace secret-shaped substrings with a marker. Idempotent on already-clean text. */
export function redactSecrets(s: string): string {
  // A PEM private-key block goes first, so its body is not half-matched by the shapes below (N89).
  let out = replacePrivateKeyBlocks(s);
  out = out.replace(BEARER_RE, "Bearer " + REDACTED);
  out = out.replace(PCC_KEY_RE, "pcc_$1_redacted");
  // JSON Web Tokens (header.payload.signature; header is base64 of `{"…`)
  out = replaceJwts(out, "[redacted-jwt]");
  out = out.replace(HEX_SECRET_RE, "[redacted-hex]");
  out = out.replace(VENDOR_KEY_RE, "[redacted-key]");
  // Then the value of a secret-named JSON string field, and key-like base64 runs (N89).
  return replaceBase64Runs(replaceSecretJsonStrings(out));
}

/** redactSecrets that passes null through (for optional fields). */
export function redactOrNull(s: string | null): string | null {
  return s === null ? null : redactSecrets(s);
}

// ── Character classes, by UTF-16 code unit (-1 = "no character") ────────────

const isDigit = (c: number) => c >= 48 && c <= 57;
const isUpper = (c: number) => c >= 65 && c <= 90;
const isLower = (c: number) => c >= 97 && c <= 122;
const isAlnum = (c: number) => isDigit(c) || isUpper(c) || isLower(c);
const isHexDigit = (c: number) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
/** [A-Za-z0-9+/], the standard base64 alphabet without padding. */
const isBase64 = (c: number) => isAlnum(c) || c === 43 || c === 47;
/** [A-Za-z0-9_.~+/=-]: every character any credential shape below is made of. */
export const isTokenChar = (c: number) =>
  isAlnum(c) || c === 95 || c === 46 || c === 126 || c === 43 || c === 47 || c === 61 || c === 45;
/** The characters `\s` matches. */
function isSpace(c: number): boolean {
  return (
    (c >= 9 && c <= 13) || c === 32 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) ||
    c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279
  );
}

/** Test a sticky regex at `i`; the end of its match, or -1. */
function stickyEnd(re: RegExp, s: string, i: number): number {
  re.lastIndex = i;
  return re.test(s) ? re.lastIndex : -1;
}

// ── JSON Web Tokens, in linear time (WP-D R1) ────────────────────────────────

const B64URL_RUN_Y = /[A-Za-z0-9_-]*/y;

/** End of the maximal [A-Za-z0-9_-] run that starts at `k`. */
function b64urlRunEnd(s: string, k: number): number {
  B64URL_RUN_Y.lastIndex = k;
  B64URL_RUN_Y.test(s);
  return B64URL_RUN_Y.lastIndex;
}

/** `e30` is `{}`, the smallest JSON object a JWT payload can be (RFC 7519: the claims set is an object). */
const JWT_MIN_PAYLOAD = 3;
/** A payload shorter than this must prove it is JSON (see jwtAt); a longer one is taken as it was before. */
const JWT_PLAIN_PAYLOAD = 6;

/** True when the base64url segment s[from, to) decodes to a JSON object. Bounded: only 3 to 5 characters reach it. */
function isJsonObjectSegment(s: string, from: number, to: number): boolean {
  try {
    const v: unknown = JSON.parse(Buffer.from(s.slice(from, to), "base64url").toString("utf8"));
    return v !== null && typeof v === "object" && !Array.isArray(v);
  } catch {
    return false;
  }
}

/**
 * Match `eyJ[A-Za-z0-9_-]{6,}.<payload>.[A-Za-z0-9_-]{6,}` at `i`, the way the greedy
 * regex would: each segment is a maximal [A-Za-z0-9_-] run, since `.` is not in
 * that class. The payload is 6+ characters, or 3 to 5 that decode to a JSON object
 * (`e30` is the claims set `{}`: astra pack 97, F4); the header's `eyJ` is base64
 * of `{"` and the signature segment must be present.
 *
 * On failure, `skipTo` is the end of the first segment's run: every later `eyJ`
 * start inside that run ends its first segment at the same place, so it finds the
 * same payload and signature and fails the same way, and need not be tried. A later
 * start only ever has a SHORTER header, and no other test (the short payload's JSON
 * decode included) looks at the header's text, so no later start can succeed where
 * this one failed. That is what keeps the scan linear.
 */
function jwtAt(s: string, i: number): { end: number; skipTo: number } {
  if (s.charCodeAt(i) !== 101 || s.charCodeAt(i + 1) !== 121 || s.charCodeAt(i + 2) !== 74) {
    return { end: -1, skipTo: i + 1 };
  }
  const e1 = b64urlRunEnd(s, i + 3);
  if (e1 - (i + 3) < 6 || s.charCodeAt(e1) !== 46) return { end: -1, skipTo: e1 };
  const e2 = b64urlRunEnd(s, e1 + 1);
  const payload = e2 - (e1 + 1);
  if (payload < JWT_MIN_PAYLOAD || s.charCodeAt(e2) !== 46) return { end: -1, skipTo: e1 };
  const e3 = b64urlRunEnd(s, e2 + 1);
  if (e3 - (e2 + 1) < 6) return { end: -1, skipTo: e1 };
  if (payload < JWT_PLAIN_PAYLOAD && !isJsonObjectSegment(s, e1 + 1, e2)) return { end: -1, skipTo: e1 };
  return { end: e3, skipTo: e3 };
}

/** Replace every JWT not preceded by a letter or digit with `marker` (the feedback sink's shape). */
function replaceJwts(s: string, marker: string): string {
  let out = "";
  let last = 0;
  let from = 0;
  for (let i = s.indexOf("eyJ", from); i >= 0; i = s.indexOf("eyJ", from)) {
    if (i > 0 && isAlnum(s.charCodeAt(i - 1))) {
      from = i + 1;
      continue;
    }
    const jwt = jwtAt(s, i);
    if (jwt.end > 0) {
      out += s.slice(last, i) + marker;
      last = jwt.end;
      from = jwt.end;
    } else {
      from = Math.max(i + 1, jwt.skipTo);
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

// ── What master's N89 fix adds to the sink (PR #478), in WP-D's linear-time style ──
//
// /api/auth/provision returns an agent's Ed25519 key as base64 PKCS#8 and as PEM, and
// the operator wallet's key as a field. Each of the three helpers below reuses a
// scanner the deep redactor already has, so the sink and the chat redactor cannot
// drift apart, and each leaves the text around what it removes untouched.

/** A PEM private-key block of any type, whole or cut off before its END line, becomes this. */
const PRIVATE_KEY_MARKER = "[redacted-private-key]";

function replacePrivateKeyBlocks(s: string): string {
  const spans: Span[] = [];
  addPemSpans(s, spans);
  return spans.length === 0 ? s : applySpans(s, spans, PRIVATE_KEY_MARKER);
}

/**
 * The value of a secret-named JSON string field, `"name":"value"`, becomes
 * `"name":"[redacted]"`; the name, the separator and the quotes stay. Only a
 * double-quoted name with a double-quoted value counts here: the sink stays
 * conservative, and the deep redactor's other label forms are the chat's concern.
 */
function replaceSecretJsonStrings(s: string): string {
  const spans: Span[] = [];
  addSecretLabelSpans(s, spans, true);
  return spans.length === 0 ? s : applySpans(s, spans, REDACTED);
}

/**
 * Base64 key material has no fixed prefix (a PKCS#8 key, for one). A run of 40 or
 * more base64 characters is one when it mixes upper case, lower case and digits,
 * which a path, an id or a sentence almost never does. A hex run is left alone: a
 * 64-hex key is already redacted above, and a checksummed 40-hex wallet address is
 * public. The lookbehind keeps the match to whole runs, so the scan is linear.
 */
const BASE64_RUN_RE = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}/g;
const HEX_ONLY_RE = /^(?:0[xX])?[0-9a-fA-F]+$/;

function replaceBase64Runs(s: string): string {
  return s.replace(BASE64_RUN_RE, (run) =>
    !HEX_ONLY_RE.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run) ? "[redacted-b64]" : run,
  );
}

// ── Structured redaction for the onboarding chat (WP-D D1; bus #2288, board N9) ──
//
// redactSecrets() above scrubs FREE TEXT for the feedback sink and keeps its own
// markers (pinned by redaction.test.ts). redactSecretsDeep() below walks a
// JSON-shaped value (a tool result, a message history, an error string) and
// replaces every secret it finds with REDACTED_VALUE:
//   1. secret-field: the value under a secret-NAMED key is replaced whole,
//      whatever its shape (an `api_key` string, an `authorization` object, a
//      `tokens` list, ...);
//   2. secret-shaped: credential-shaped substrings of every string, and of every
//      object KEY, are replaced (see scrubShapes);
//   3. embedded JSON: a string that parses as a JSON object or array is walked
//      as JSON, so a secret-named field inside a serialized body is caught too.
// Fail closed: a cycle, or a subtree deeper than MAX_DEPTH, is replaced, not walked.

/** What every removed secret becomes (WP-D D1). */
export const REDACTED_VALUE = "[REDACTED]";

/** WP-D D1's secret field names, verbatim. Everything it matches is a secret field. */
export const SPEC_SECRET_FIELD_RE =
  /^(api_?key|apikey|raw_?key|private_?key|privatekey|secret|client_?secret|access_?token|refresh_?token|id_?token|token|password|passphrase|mnemonic|seed|authorization|cookie)$/i;

// Beyond the spec list (fail closed), a name is compared lower-cased with every
// non-alphanumeric dropped, so `private_key_pkcs8_base64` (minted by
// /api/auth/provision), `x-api-key`, `set-cookie`, `webhookSecret`,
// `operatorWalletPrivateKey`, `llm_auth` and `X-PCC-Session` are caught, while
// `publicKey`, `apiKeyId`, `keyPrefix`, `idempotencyKey`, `maxTokens` and
// `authorizationUrl` are not.
/** A name CONTAINING one of these is a secret field. */
const SECRET_NAME_PARTS = ["privatekey", "secret", "password", "passphrase", "mnemonic", "seedphrase", "recoveryphrase"];
/** A name ENDING in one of these is a secret field. */
const SECRET_NAME_SUFFIXES = [
  "apikey", "rawkey", "privkey", "signingkey", "hmackey", "encryptionkey", "masterkey", "accesskey",
  "token", "cookie", "authorization", "auth", "hmac", "pccsession",
];
/**
 * Whole names outside the spec list that are secret fields on their own. `pwd` is
 * the connection-string alias of `password` (ODBC `PWD=`, ADO.NET `Pwd=`); as a
 * whole name only, so `cwd`-style names are untouched. In free text the label scan
 * accepts it only where it is a password (see scanLabelValue): `PWD=/home/me` is
 * the shell's working directory.
 */
const SECRET_NAMES = new Set(["credential", "credentials", "cookies", "jwt", "bearer", "pwd"]);
/** Names that hold a session TOKEN when their value is a string (PCC SIWE sessions are UUIDs; WP-D round 4, L5). */
const SESSION_TOKEN_NAMES = new Set(["session", "sessionid", "sid"]);

const normalizeName = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/** True when a key's value must be treated as a secret, whatever its shape. */
export function isSecretFieldName(key: string): boolean {
  if (SPEC_SECRET_FIELD_RE.test(key)) return true;
  const n = normalizeName(key);
  if (!n) return false;
  return (
    SECRET_NAMES.has(n) ||
    SECRET_NAME_PARTS.some((p) => n.includes(p)) ||
    SECRET_NAME_SUFFIXES.some((s) => n.endsWith(s))
  );
}

/** A parent object whose `key` / `keys` child is key material (`{ signing: { key } }`). */
const SECRET_PARENT_PARTS = [
  "secret", "private", "credential", "auth", "signing", "signer", "hmac", "session", "token", "apikey",
  "crypt", "vault", "wallet", "keystore", "keychain", "keyring",
];
const HEX_KEY_MATERIAL_RE = /^(?:0[xX])?[0-9a-fA-F]{32,}$/;
const UUID_KEY_MATERIAL_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const B64_KEY_MATERIAL_RE = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;

/** A string that reads as random key material: long hex, a UUID, or base64 mixing upper, lower and digits. */
function isKeyMaterial(v: unknown): boolean {
  if (typeof v !== "string") return false;
  if (HEX_KEY_MATERIAL_RE.test(v) || UUID_KEY_MATERIAL_RE.test(v)) return true;
  return B64_KEY_MATERIAL_RE.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) && /[0-9]/.test(v);
}

/**
 * True when the value under `key` is a secret field (WP-D D1, R6). Beyond the
 * names isSecretFieldName() matches:
 *   - a plural of a secret name (`tokens`, `api_keys`, `sessionTokens`) holds a
 *     collection of secrets, unless its value is a number, which is a count
 *     (`maxTokens: 4096`, `input_tokens: 12`);
 *   - a generic `key` / `keys` is a secret under a secret-ish parent
 *     (`{ wallet: { key } }`), or when it holds random-looking key material.
 */
function isSecretField(key: string, value: unknown, parentKey: string | null): boolean {
  if (isSecretFieldName(key)) return true;
  const n = normalizeName(key);
  if (SESSION_TOKEN_NAMES.has(n) && typeof value === "string") return true;
  if (n.length > 1 && n.endsWith("s") && typeof value !== "number" && isSecretFieldName(n.slice(0, -1))) return true;
  if (n === "key" || n === "keys") {
    const parent = parentKey === null ? "" : normalizeName(parentKey);
    if (SECRET_PARENT_PARTS.some((p) => parent.includes(p))) return true;
    return Array.isArray(value) ? value.some(isKeyMaterial) : isKeyMaterial(value);
  }
  return false;
}

// ── Credential shapes in free text, in linear time (WP-D R1, R6) ────────────
//
// scrubShapes() collects the spans of every secret it finds, then replaces each
// merged span with REDACTED_VALUE. The detectors, each linear:
//   1. token runs: one pass finds every maximal run of [A-Za-z0-9_.~+/=-]; every
//      self-identifying shape (pcc_live_…, JWT, 64-hex, vendor keys, PKCS#8) lies
//      inside one run. Inside a run each shape is tried only where it may start
//      (after a non-alphanumeric neighbour, per the shape's own boundary rule),
//      with an anchored (sticky) regex, and a match resumes the scan after its end;
//   2. schemes: a run that follows `Bearer` and whitespace (12+ characters; fewer when
//      it reads like a token or the word sits where a header value sits, see
//      addSchemeSpan) or `Basic` (base64 of a printable `user:password`);
//   3. labels: `name: value`, `name=value` and `"name": "value"` where `name` is a
//      secret name, whatever the value's shape, consumed whole by the delimiters of
//      the enclosing format (see addSecretLabelSpans); an `Authorization` label keeps
//      its scheme word, such as `Basic`;
//   4. URL userinfo: the `user:password` in `scheme://user:password@host`;
//   5. PEM private-key blocks, BEGIN to END (or to the end of the text);
//   6. BIP-39 mnemonics: a window of 12/15/18/21/24 wordlist words whose checksum
//      holds, however few distinct words it has, and a run of 12+ words with 10+
//      distinct ones that fails it (a mistyped phrase is still a phrase);
//   7. a 64-digit hex key wrapped over lines (the contiguous 64-hex shape is 1).

/** Self-identifying shapes. Each is anchored where it is tried and ends in one greedy class (or a fixed width). */
const PCC_KEY_Y = /pcc_(?:live|test|oracle)_[A-Za-z0-9_-]{6,}/iy;
const PAYMENT_KEY_Y = /[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/y;
const WEBHOOK_SECRET_Y = /whsec_[A-Za-z0-9+/=]{10,}/y;
const OPENAI_KEY_Y = /sk-[A-Za-z0-9_-]{16,}/y;
const GITHUB_TOKEN_Y = /gh[po]_[A-Za-z0-9]{20,}/y;
const SLACK_TOKEN_Y = /xox[baprs]-[A-Za-z0-9-]{10,}/y;
const AWS_KEY_ID_Y = /AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/y;
/** L5: GitHub fine-grained PATs, Google API keys and npm tokens. */
const GITHUB_PAT_Y = /github_pat_[A-Za-z0-9_]{22,}/y;
const GOOGLE_API_KEY_Y = /AIza[0-9A-Za-z_-]{35}/y;
const NPM_TOKEN_Y = /npm_[A-Za-z0-9]{36}/y;
/** A 64-hex value is removed whether it is a private key or a public digest: the two look the same. */
const HEX_SECRET_Y = /(?:0[xX])?[0-9a-fA-F]{64,}/y;
/** Ed25519 PKCS#8 DER private key, base64 (what /api/auth/provision mints). Its first 16 DER bytes are fixed. */
const ED25519_PKCS8_Y = /MC4CAQAwBQYDK2VwBCIEI[A-Za-z0-9+/]{40,}={0,2}/y;

const TOKEN_RUN_RE = /[A-Za-z0-9_.~+/=-]+/g;
/** The shortest run any self-identifying shape (or a Bearer token) fits in. */
const MIN_SHAPE_RUN = 12;
/** The shortest Basic credential: base64 of `a:b`. */
const MIN_SCHEME_RUN = 4;

interface Span {
  start: number;
  end: number;
}

/**
 * The self-identifying shapes inside the token run [a, b). With `keepDigests`, a
 * bare 64-hex value is kept: an owner-only view needs the hashes a human must
 * check before confirming (WP-D round 4, L3). Every other shape is still removed.
 */
function addShapeSpans(s: string, a: number, b: number, spans: Span[], keepDigests = false): void {
  let jwtFrom = a; // every JWT start before this index is known to fail
  let i = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    const prev = i > a ? s.charCodeAt(i - 1) : -1;
    let end = -1;
    if (!isAlnum(prev)) {
      switch (c) {
        case 80: // P
        case 112: // p
          end = stickyEnd(PCC_KEY_Y, s, i);
          break;
        case 115: // s
          end = Math.max(stickyEnd(PAYMENT_KEY_Y, s, i), stickyEnd(OPENAI_KEY_Y, s, i));
          break;
        case 114: // r
          end = stickyEnd(PAYMENT_KEY_Y, s, i);
          break;
        case 119: // w
          end = stickyEnd(WEBHOOK_SECRET_Y, s, i);
          break;
        case 103: // g
          end = Math.max(stickyEnd(GITHUB_TOKEN_Y, s, i), stickyEnd(GITHUB_PAT_Y, s, i));
          break;
        case 110: // n
          end = stickyEnd(NPM_TOKEN_Y, s, i);
          break;
        case 120: // x
          end = stickyEnd(SLACK_TOKEN_Y, s, i);
          break;
        case 65: // A
          end = Math.max(stickyEnd(AWS_KEY_ID_Y, s, i), stickyEnd(GOOGLE_API_KEY_Y, s, i));
          break;
        case 101: // e
          if (i >= jwtFrom) {
            const jwt = jwtAt(s, i);
            if (jwt.end > 0) end = jwt.end;
            else jwtFrom = jwt.skipTo;
          }
          break;
      }
    }
    if (c === 77 && !isBase64(prev)) end = Math.max(end, stickyEnd(ED25519_PKCS8_Y, s, i)); // M
    if (!keepDigests && isHexDigit(c) && !isHexDigit(prev)) end = Math.max(end, stickyEnd(HEX_SECRET_Y, s, i));
    if (end > i) {
      spans.push({ start: i, end });
      i = end;
    } else {
      i += 1;
    }
  }
}

/** True when `word` (lower-case) ends at index `j`, with no letter or digit right before it. */
function wordEndsAt(s: string, j: number, word: string): boolean {
  const start = j - word.length + 1;
  if (start < 0 || (start > 0 && isAlnum(s.charCodeAt(start - 1)))) return false;
  return s.slice(start, j + 1).toLowerCase() === word;
}

const BASIC_CREDENTIAL_Y = /[A-Za-z0-9+/]{4,}={0,2}/y;

/** End of a Basic credential at `a` (base64 of printable `user:password`), or -1. */
function basicCredentialEnd(s: string, a: number): number {
  const end = stickyEnd(BASIC_CREDENTIAL_Y, s, a);
  if (end < 0) return -1;
  const bytes = Buffer.from(s.slice(a, end), "base64");
  if (bytes.length < 3 || !bytes.includes(58)) return -1;
  for (const byte of bytes) if (byte < 32 || byte > 126) return -1;
  return end;
}

const isLetter = (c: number) => isUpper(c) || isLower(c);

/** A run of 4+ token characters that is not all letters (a digit, `_`, `-`, `.`...): it reads like a credential, not a word. */
function looksLikeTokenRun(s: string, a: number, b: number): boolean {
  if (b - a < 4) return false;
  for (let i = a; i < b; i += 1) if (!isLetter(s.charCodeAt(i))) return true;
  return false;
}

/** True when the word at `start` sits where a header VALUE sits: right after a quote, a backtick or `=`. */
function atValuePosition(s: string, start: number): boolean {
  let p = start - 1;
  while (p >= 0 && (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9)) p -= 1;
  const c = p >= 0 ? s.charCodeAt(p) : -1;
  return c === 34 || c === 39 || c === 96 || c === 61;
}

/**
 * `Bearer <run>` / `Basic <run>`: the run [a, b) after a scheme word and whitespace.
 *
 * A Bearer run is a credential when it has MIN_SHAPE_RUN (12) or more characters,
 * which no English word has; or when it reads like a token (4+ characters with a
 * digit or a token mark: `short123`); or when the word `Bearer` sits where a header
 * value sits (after a quote, a backtick or `=`). An `Authorization:` label needs
 * none of this: addSecretLabelSpans takes any value after it. What stays UNREDACTED
 * is a short all-letters word after `Bearer` in running text ("Bearer tokens go in
 * the header", "Bearer bonds"): it cannot be told from prose, and redacting it
 * would erase ordinary sentences about the scheme. That is the one narrowing of the
 * claim that a Bearer token is always removed (astra pack 97, coverage limits).
 */
function addSchemeSpan(s: string, a: number, b: number, spans: Span[]): void {
  let j = a - 1;
  if (j < 0 || !isSpace(s.charCodeAt(j))) return;
  while (j >= 0 && isSpace(s.charCodeAt(j))) j -= 1;
  if (wordEndsAt(s, j, "bearer")) {
    if (b - a >= MIN_SHAPE_RUN || looksLikeTokenRun(s, a, b) || atValuePosition(s, j - 5)) spans.push({ start: a, end: b });
  } else if (b - a >= MIN_SCHEME_RUN && wordEndsAt(s, j, "basic")) {
    const end = basicCredentialEnd(s, a);
    if (end > a) spans.push({ start: a, end });
  }
}

function addTokenRunSpans(s: string, spans: Span[], keepDigests = false): void {
  TOKEN_RUN_RE.lastIndex = 0;
  for (let m = TOKEN_RUN_RE.exec(s); m !== null; m = TOKEN_RUN_RE.exec(s)) {
    const a = m.index;
    const b = a + m[0].length;
    addSchemeSpan(s, a, b, spans);
    if (b - a >= MIN_SHAPE_RUN) addShapeSpans(s, a, b, spans, keepDigests);
  }
}

/** A word, blanks, and a non-blank: the shape of `<scheme> <credential>` at the start of an Authorization value. */
const AUTH_SCHEME_Y = /[A-Za-z][A-Za-z0-9._-]{0,31}[ \t]+(?=\S)/y;
/**
 * The scheme words an Authorization value may start with (IANA registry, and the common
 * unregistered ones). Only these are kept: any other first word is the credential itself,
 * so `authorization=hunter2 and more` loses `hunter2` too (it used to be taken for a scheme).
 */
const AUTH_SCHEMES: ReadonlySet<string> = new Set([
  "basic", "bearer", "token", "digest", "negotiate", "ntlm", "oauth", "hawk", "hmac", "mutual", "dpop", "gnap", "hoba",
  "privatetoken", "vapid", "apikey", "api-key", "key", "jwt", "aws", "aws4-hmac-sha256", "scram-sha-1", "scram-sha-256",
]);

/** Where an Authorization value's credential starts at `k`: after a known scheme word and its blanks, else at `k`. */
function authCredentialStart(s: string, k: number): number {
  const end = stickyEnd(AUTH_SCHEME_Y, s, k);
  if (end < 0) return k;
  let w = k;
  while (w < end && !isBlank(s.charCodeAt(w))) w += 1;
  return AUTH_SCHEMES.has(s.slice(k, w).toLowerCase()) ? end : k;
}

// ── Labelled credentials, in one forward pass (WP-D round 4, L5; astra pack 97: F1, F2, F5) ──
//
// `name: value`, `name=value` and `"name": "value"` where `name` is a secret name:
// header lines (X-Api-Key: ...), URL query and fragment parameters, key=value
// pairs, connection-string fields (Pwd=...), YAML keys, and secret-named JSON
// fragments inside prose. addSecretLabelSpans() reads each label once, consumes its
// value WHOLE by the delimiters of the format the label sits in, and resumes after
// that value: nothing is rescanned (`authorization=` x n used to be quadratic), and
// a value that cannot be delimited safely FAILS CLOSED to the end of its line.
//
// The NAME is read as bare characters or as a quoted string, then DECODED before it
// is compared (F2): a bare name percent-decodes (`access%5ftoken`), a quoted name
// unescapes JSON and JS escapes (the backslash forms of u, x, n, ...). The VALUE
// that follows is replaced from its ORIGINAL text, and the surrounding text is
// never rewritten. Budgets: a name is read at most MAX_LABEL_RAW characters long
// and decoded to at most MAX_LABEL_NAME; a separator is looked for at most
// FIELD_SEP_WINDOW characters ahead.
//
// The VALUE, by what encloses the label:
//   a quoted value    runs to the matching quote. A backslash escapes the next
//                     character; a doubled quote is an escaped quote (SQL, ADO.NET).
//                     Never past the end of the line; a quote that never closes
//                     FAILS CLOSED: the rest of the line is the value.
//   a URL parameter   (after `?`, `&` or `#`) runs to `&`, `#` or whitespace, or to a
//                     quote that reads as closing one. It may be percent-encoded.
//   `name: value`     runs to the end of the line, or to the quote that encloses
//                     the label when it opens one (`-H 'Authorization: Basic ...'`).
//                     With nothing after the colon, the value is the next non-empty
//                     line indented deeper than the label's line; a YAML block
//                     scalar (`|`, `>`) takes every such line.
//   `"name": value`   in a JSON-like fragment (quoted name, unquoted value) runs to
//                     `,`, `}`, `]` or whitespace. A value that opens `{` or `[`
//                     cannot be delimited here: it FAILS CLOSED to the line's end.
//   `name=value`      after a `;`, or as the first field of a line that has more
//                     `;name=` fields after it (a connection string), runs to the
//                     `;` that closes the field and may hold spaces. Anywhere else
//                     it runs to whitespace, cut earlier at a `&`, `;` or `,` that is
//                     followed by `name=` or by the end of the line (form bodies,
//                     logfmt). A scheme word (Bearer, Basic) takes the token after it.

/** A bare or quoted name is read at most this many characters long (raw, before decoding). */
const MAX_LABEL_RAW = 192;
/** A decoded name is at most this long: a longer one is no field name (the scanner's limit before decoding was 64 too). */
const MAX_LABEL_NAME = 64;
/** How far ahead a `;` that ends a connection-string field is looked for, when the label starts its line. */
const FIELD_SEP_WINDOW = 512;
/** The longest field name that can follow a field separator (`User ID`, `Initial Catalog`, `MultipleActiveResultSets`). */
const MAX_FIELD_NAME = 64;

/**
 * Groups: 1 a double-quoted name, 2 a single-quoted name, 3 a bare name, 4 the
 * separator (`:` or `=`), 5 an opening quote of the value. A bare name is a whole run
 * of [A-Za-z0-9_%.+~[]-] (the lookbehind makes it start where the run starts), so
 * there is one candidate per run and no suffix is retried. Every repeat is bounded by
 * MAX_LABEL_RAW and its two alternatives start with different characters, so a failing
 * candidate costs at most 2 * MAX_LABEL_RAW steps and never backtracks combinatorially.
 * (decodeLabelName enforces MAX_LABEL_RAW on the raw length of a quoted name, whose
 * escape pairs make a repeat two characters long.)
 */
const LABEL_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9_%.+~[\]-])(?:"((?:[^"\\\r\n]|\\.){1,${MAX_LABEL_RAW}})"|'((?:[^'\\\r\n]|\\.){1,${MAX_LABEL_RAW}})'|([A-Za-z0-9_%.+~-][A-Za-z0-9_%.+~[\]-]{0,${MAX_LABEL_RAW - 1}}))[ \t]*([:=])[ \t]*(["']?)`,
  "g",
);
/** A value that is already a redaction placeholder: left alone, so a second pass changes nothing. */
const PLACEHOLDER_VALUE_RE = /^(?:\[REDACTED\]|\[redacted(?:-[a-z]+)?\])$/;
/** The header line of a YAML block scalar: `|`, `>`, `|-`, `>+`, `|2`. */
const BLOCK_SCALAR_RE = /^[|>][+-]?[0-9]?[+-]?$/;
/** The three JSON literals that are not strings or numbers. */
const JSON_LITERAL_RE = /^(?:null|true|false)$/;

const isBlank = (c: number) => c === 32 || c === 9;

/** Index of the line break that ends the line holding `from`, or the end of the text. */
function lineEnd(s: string, from: number): number {
  const n = s.indexOf("\n", from);
  return n === -1 ? s.length : n;
}

/** `to`, moved back over trailing whitespace (spaces, a CR) but never before `from`. */
function trimEnd(s: string, from: number, to: number): number {
  let e = to;
  while (e > from && isSpace(s.charCodeAt(e - 1))) e -= 1;
  return e;
}

/**
 * Percent-decoding of a URL parameter NAME: `%5f` is `_`. A malformed `%` stays as it is.
 * (A `+`, a space in a form, needs no decoding: normalizeName drops it either way.)
 */
function percentDecode(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) === 37 && i + 2 < raw.length && isHexDigit(raw.charCodeAt(i + 1)) && isHexDigit(raw.charCodeAt(i + 2))) {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out += raw[i];
    }
  }
  return out;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** Unescaping of a quoted NAME: the JSON escapes, plus the JS/Python x form. An unknown escape keeps its character. */
function unescapeName(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== "\\" || i + 1 >= raw.length) {
      out += ch;
      continue;
    }
    const e = raw[i + 1];
    const digits = e === "u" ? 4 : e === "x" ? 2 : 0;
    if (digits > 0) {
      const hex = raw.slice(i + 2, i + 2 + digits);
      if (hex.length === digits && /^[0-9a-fA-F]+$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 1 + digits;
        continue;
      }
    }
    out += SIMPLE_ESCAPES[e] ?? e;
    i += 1;
  }
  return out;
}

/**
 * The name as written, decoded for its format; undefined when it is over a budget:
 * more than MAX_LABEL_RAW raw characters (LABEL_RE bounds the REPEATS of a quoted name,
 * and an escape pair is one repeat of two characters, so a raw name can be up to twice
 * that long) or more than MAX_LABEL_NAME once decoded.
 */
function decodeLabelName(raw: string, quoted: boolean): string | undefined {
  if (raw.length > MAX_LABEL_RAW) return undefined;
  let name = raw;
  if (quoted) {
    if (raw.indexOf("\\") !== -1) name = unescapeName(raw);
  } else if (raw.indexOf("%") !== -1) {
    name = percentDecode(raw);
  }
  return name.length > MAX_LABEL_NAME ? undefined : name;
}

/**
 * True when the quote character at `i` reads as a CLOSING quote: it ends the text, or a
 * blank, `,`, `;`, `)`, `]`, `}` or `>` follows it. A raw quote followed by anything
 * else is part of the value. (A secret that holds a quote followed by one of those marks
 * is cut there: the one ambiguity a URL value leaves, and a raw quote is not URL syntax.)
 */
function closesQuote(s: string, i: number): boolean {
  const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 10;
  return isSpace(next) || next === 44 || next === 59 || next === 41 || next === 93 || next === 125 || next === 62;
}

/** Index of the closing quote of a value that starts at `from`, or the end of the line when it never closes. */
function quotedEnd(s: string, from: number, quote: number): number {
  const n = s.length;
  let i = from;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 10) return i;
    if (c === 92) {
      i += i + 1 < n && s.charCodeAt(i + 1) !== 10 ? 2 : 1; // a backslash escapes a character, never a line break
      continue;
    }
    if (c === quote) {
      if (s.charCodeAt(i + 1) !== quote) return i;
      i += 2; // a doubled quote is an escaped quote
      continue;
    }
    i += 1;
  }
  return n;
}

/** True when a field NAME followed by `=` starts at `j`: a letter, then letters, digits, spaces, `_`, `.` or `-`. */
function fieldNameAt(s: string, j: number): boolean {
  if (!isLetter(s.charCodeAt(j))) return false;
  const stop = Math.min(s.length, j + MAX_FIELD_NAME + 1);
  for (let i = j + 1; i < stop; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 61) return true;
    if (!(isAlnum(c) || c === 32 || c === 95 || c === 46 || c === 45)) return false;
  }
  return false;
}

/**
 * The first of the separators c1, c2, c3 (a character code, or -1 for none) in
 * [from, limit) that ENDS a field: what follows it, after blanks, is the end of the
 * line or the next `name=`. Stops at the end of the line. Bounded by `limit`.
 */
function firstFieldSep(s: string, from: number, limit: number, c1: number, c2: number, c3: number): number {
  for (let i = from; i < limit; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 10) return -1;
    if (c !== c1 && c !== c2 && c !== c3) continue;
    let j = i + 1;
    while (j < s.length && isBlank(s.charCodeAt(j))) j += 1;
    if (j >= s.length || s.charCodeAt(j) === 10 || s.charCodeAt(j) === 13 || fieldNameAt(s, j)) return i;
  }
  return -1;
}

/** After a scheme word (`Bearer`, `Basic`) that is the whole value so far, the token that follows it belongs to the value. */
function extendPastScheme(s: string, start: number, end: number): number {
  const len = end - start;
  if (len !== 5 && len !== 6) return end;
  const word = s.slice(start, end).toLowerCase();
  if (word !== "basic" && word !== "bearer") return end;
  let i = end;
  while (i < s.length && isBlank(s.charCodeAt(i))) i += 1;
  if (i === end) return end;
  let j = i;
  while (j < s.length && !isSpace(s.charCodeAt(j))) j += 1;
  return j > i ? j : end;
}

/**
 * The value of a label whose own line holds none: the next non-empty line indented
 * DEEPER than the label's line, as [start, end) of that line's text (its indentation
 * stays). A block scalar takes every such line, to the first that is not deeper.
 * `from` is anywhere on the label's line at or after the separator.
 */
function indentedValue(s: string, labelAt: number, from: number, block: boolean): { start: number; end: number } | null {
  const n = s.length;
  const lineStart = labelAt > 0 ? s.lastIndexOf("\n", labelAt - 1) + 1 : 0;
  let indent = 0;
  while (lineStart + indent < n && isBlank(s.charCodeAt(lineStart + indent))) indent += 1;
  let start = -1;
  let end = -1;
  let pos = lineEnd(s, from);
  while (pos < n) {
    pos += 1; // over the line break, to the first character of the next line
    const le = lineEnd(s, pos);
    let q = pos;
    while (q < le && isBlank(s.charCodeAt(q))) q += 1;
    const contentEnd = trimEnd(s, q, le);
    if (contentEnd === q) {
      pos = le; // a blank line
      continue;
    }
    if (q - pos <= indent) break; // not deeper: the value, if any, is over
    if (start < 0) start = q;
    end = contentEnd;
    if (!block) break;
    pos = le;
  }
  return start < 0 ? null : { start, end };
}

interface LabelValue {
  start: number;
  end: number;
  /** Where the label scan resumes: past everything this value consumed. */
  resume: number;
  /** True where a `pwd` label is a password (a quoted value, a connection string, a URL, a `:` pair), not the shell's PWD. */
  password: boolean;
}

/**
 * The value of the label found at `labelAt`, whose value starts at `k0` (after the
 * separator `sep`, the blanks and the optional opening quote `valueQuote`). null when
 * the label has no value. `auth` marks an Authorization label, which keeps a leading
 * scheme word. See the table above.
 */
function scanLabelValue(
  s: string,
  labelAt: number,
  k0: number,
  sep: number,
  quotedName: boolean,
  valueQuote: number,
  auth: boolean,
): LabelValue | null {
  const n = s.length;
  let k = k0;
  if (auth && k < n) k = authCredentialStart(s, k);
  if (valueQuote !== 0) {
    const close = quotedEnd(s, k, valueQuote);
    const closed = close < n && s.charCodeAt(close) === valueQuote;
    return { start: k, end: closed ? close : trimEnd(s, k, close), resume: closed ? close + 1 : close, password: true };
  }
  const c0 = k < n ? s.charCodeAt(k) : 10;
  if (c0 === 10 || c0 === 13) {
    const v = indentedValue(s, labelAt, k, false);
    return v === null ? null : { start: v.start, end: v.end, resume: v.end, password: true };
  }
  const prev = labelAt > 0 ? s.charCodeAt(labelAt - 1) : -1;
  if (prev === 63 || prev === 38 || prev === 35) {
    // a URL query or fragment parameter: ? & #. A raw quote INSIDE the value is part of it; only a quote that
    // reads as a closing one ends it, so `"url":"https://h/?token=abc","n":1` keeps its structure.
    let i = k;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 38 || c === 35 || isSpace(c) || (i > k && (c === 34 || c === 39 || c === 96) && closesQuote(s, i))) break;
      i += 1;
    }
    return { start: k, end: i, resume: i, password: true };
  }
  // A quote right before the label opens the string it sits in; that quote closes the value.
  const enclosing = !quotedName && (prev === 34 || prev === 39 || prev === 96) ? prev : -1;
  if (sep === 58) {
    if (quotedName) {
      if (c0 === 123 || c0 === 91) {
        const stop = lineEnd(s, k); // a structure cannot be delimited here: fail closed
        return { start: k, end: trimEnd(s, k, stop), resume: stop, password: true };
      }
      let i = k;
      while (i < n) {
        const c = s.charCodeAt(i);
        if (c === 44 || c === 125 || c === 93 || isSpace(c)) break;
        i += 1;
      }
      // JSON's own empty slots (`"token": null`, `"hasApiKey": false`) hold nothing, as in the structured walk;
      // redacting them would turn valid JSON into invalid JSON.
      if (i - k <= 5 && JSON_LITERAL_RE.test(s.slice(k, i))) return null;
      return { start: k, end: i, resume: i, password: true };
    }
    let i = k;
    while (i < n && s.charCodeAt(i) !== 10 && s.charCodeAt(i) !== enclosing) i += 1;
    const end = trimEnd(s, k, i);
    if (end - k <= 4 && BLOCK_SCALAR_RE.test(s.slice(k, end))) {
      const v = indentedValue(s, labelAt, i, true);
      return v === null ? null : { start: v.start, end: v.end, resume: v.end, password: true };
    }
    return { start: k, end, resume: i, password: true };
  }
  // name=value
  let p = labelAt - 1;
  while (p >= 0 && isBlank(s.charCodeAt(p))) p -= 1;
  const before = p >= 0 ? s.charCodeAt(p) : 10;
  if (before === 59) {
    // a connection-string field: ends at the `;` that closes it, and may hold spaces
    const sepAt = firstFieldSep(s, k, n, 59, -1, -1);
    const stop = sepAt >= 0 ? sepAt : lineEnd(s, k);
    return { start: k, end: trimEnd(s, k, stop), resume: stop, password: true };
  }
  if (before === 10 || before === 13) {
    // the first field of a line may be the first field of a connection string
    const semi = firstFieldSep(s, k, Math.min(n, k + FIELD_SEP_WINDOW), 59, -1, -1);
    if (semi >= 0) return { start: k, end: trimEnd(s, k, semi), resume: semi, password: true };
  }
  let i = k;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (isSpace(c) || c === enclosing) break;
    i += 1;
  }
  const cut = firstFieldSep(s, k, i, 38, 59, 44);
  const end = cut >= 0 ? cut : extendPastScheme(s, k, i);
  return { start: k, end, resume: end, password: false };
}

/**
 * Add the span of the value of every secret-named label in `s`. With `jsonStringsOnly`
 * only `"name": "value"` (a double-quoted name with a double-quoted value) counts, which
 * is all the feedback sink redacts.
 */
function addSecretLabelSpans(s: string, spans: Span[], jsonStringsOnly = false): void {
  LABEL_RE.lastIndex = 0;
  for (let m = LABEL_RE.exec(s); m !== null; m = LABEL_RE.exec(s)) {
    const quotedName = m[3] === undefined;
    const raw = m[3] !== undefined ? m[3] : m[1] !== undefined ? m[1] : m[2];
    const valueQuote = m[5];
    if (jsonStringsOnly && (m[1] === undefined || valueQuote !== '"')) continue;
    if (raw.length < 3) continue; // no secret name is shorter than `jwt`, `sid` or `pwd`
    const name = decodeLabelName(raw, quotedName);
    if (name === undefined) continue;
    const norm = normalizeName(name);
    if (!isSecretFieldName(name) && !SESSION_TOKEN_NAMES.has(norm)) continue;
    const value = scanLabelValue(
      s,
      m.index,
      m.index + m[0].length,
      m[4].charCodeAt(0),
      quotedName,
      valueQuote === "" ? 0 : valueQuote.charCodeAt(0),
      norm.endsWith("authorization"),
    );
    if (value === null) continue;
    if (norm === "pwd" && !value.password) continue;
    const size = value.end - value.start;
    if (size > 0 && !(size <= 32 && PLACEHOLDER_VALUE_RE.test(s.slice(value.start, value.end).trim()))) {
      spans.push({ start: value.start, end: value.end });
    }
    if (LABEL_RE.lastIndex < value.resume) LABEL_RE.lastIndex = value.resume;
  }
}

// ── BIP-39 mnemonics: the checksum decides, not the number of distinct words ──────
//
// A BIP-39 phrase of 12, 15, 18, 21 or 24 words carries a checksum: the first
// words-per-3 bits of the SHA-256 of its entropy are its last bits. A window of
// wordlist words that passes it IS a mnemonic, whatever its words are: `abandon` x11
// + `about` is the published all-zero vector, and a phrase of few distinct words is
// no less a key (astra pack 97, F3). Repetition does not make it prose.

/**
 * BIP-39 English words, each with the 11-bit value it stands for. This is viem's
 * list (no new dependency): all 2048 words, `abandon` to `zoo`, whose SHA-256 as the
 * published english.txt is 2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda.
 */
const BIP39_INDEX: ReadonlyMap<string, number> = new Map(BIP39_ENGLISH.map((w, i): [string, number] => [w, i]));
const MNEMONIC_MIN_WORDS = 12;
/** The lengths a phrase can have, longest first so a 24-word phrase is not split at a 12-word prefix that happens to pass. */
const MNEMONIC_LENGTHS: readonly number[] = [24, 21, 18, 15, 12];
/**
 * What is left for runs the checksum rejects: a run of 12+ wordlist words with 10+
 * distinct ones is still taken for a phrase, because a seed phrase with one word
 * mistyped or swapped fails the checksum (15 times in 16) and is still the secret.
 * Distinct words are what separates it from prose: a sentence repeats its words.
 */
const MNEMONIC_MIN_DISTINCT = 10;
/**
 * Checksums per string. Each is one SHA-256 over at most 32 bytes. A run so long it
 * is not decided within this budget FAILS CLOSED: the whole run is redacted, since
 * real prose does not hold hundreds of consecutive wordlist words.
 */
const MNEMONIC_CHECKSUM_BUDGET = 8192;
const WORD_RE = /[A-Za-z]+/g;
const MNEMONIC_GAP_RE = /^[ \t\r\n,]+$/;
const ENTROPY = Buffer.alloc(32);

/** True when the `len` words idx[from, from + len) (11-bit values) pass the BIP-39 checksum. */
function mnemonicChecksumOk(idx: number[], from: number, len: number): boolean {
  const checksumBits = len / 3;
  const entropyBytes = (len * 11 - checksumBits) / 8;
  let acc = 0;
  let accBits = 0;
  let out = 0;
  for (let j = 0; j < len; j += 1) {
    acc = (acc << 11) | idx[from + j];
    accBits += 11;
    while (accBits >= 8 && out < entropyBytes) {
      accBits -= 8;
      ENTROPY[out] = (acc >> accBits) & 0xff;
      out += 1;
      acc &= (1 << accBits) - 1;
    }
  }
  // What is left in acc is exactly the checksum: accBits === checksumBits.
  const digest = createHash("sha256").update(ENTROPY.subarray(0, entropyBytes)).digest();
  return digest[0] >> (8 - checksumBits) === acc;
}

/**
 * Seed phrases in `s`: runs of wordlist words separated only by whitespace or
 * commas. In each run, every window of 12/15/18/21/24 words that passes the
 * checksum (leftmost, then longest) is redacted; and, when 10+ of the run's words are
 * distinct, so is the whole run. Linear: at most MNEMONIC_CHECKSUM_BUDGET checksums.
 */
function addMnemonicSpans(s: string, spans: Span[]): void {
  let idx: number[] = [];
  let starts: number[] = [];
  let ends: number[] = [];
  let distinct = new Set<number>();
  let budget = MNEMONIC_CHECKSUM_BUDGET;
  const close = () => {
    const n = idx.length;
    if (n >= MNEMONIC_MIN_WORDS) {
      let exhausted = false;
      let i = 0;
      while (i + MNEMONIC_MIN_WORDS <= n && !exhausted) {
        let hit = 0;
        for (const len of MNEMONIC_LENGTHS) {
          if (i + len > n) continue;
          if (budget === 0) {
            exhausted = true;
            break;
          }
          budget -= 1;
          if (mnemonicChecksumOk(idx, i, len)) {
            hit = len;
            break;
          }
        }
        if (hit > 0) {
          spans.push({ start: starts[i], end: ends[i + hit - 1] });
          i += hit;
        } else {
          i += 1;
        }
      }
      if (exhausted || distinct.size >= MNEMONIC_MIN_DISTINCT) spans.push({ start: starts[0], end: ends[n - 1] });
    }
    idx = [];
    starts = [];
    ends = [];
    distinct = new Set<number>();
  };
  let runEnd = -1;
  WORD_RE.lastIndex = 0;
  for (let m = WORD_RE.exec(s); m !== null; m = WORD_RE.exec(s)) {
    const a = m.index;
    const b = a + m[0].length;
    const word = m[0].length >= 3 && m[0].length <= 8 ? BIP39_INDEX.get(m[0].toLowerCase()) : undefined;
    if (word === undefined) {
      close();
      continue;
    }
    if (idx.length > 0 && !MNEMONIC_GAP_RE.test(s.slice(runEnd, a))) close();
    idx.push(word);
    starts.push(a);
    ends.push(b);
    runEnd = b;
    if (distinct.size < MNEMONIC_MIN_DISTINCT) distinct.add(word);
  }
  close();
}

// ── A 64-digit hex key wrapped over lines (astra pack 97, coverage limits) ─────────
//
// The contiguous 64-hex shape (HEX_SECRET_Y) misses a key pasted as two 32-digit
// lines, or as `xxd -p`'s 60 + 4. Hex runs that each end a line and ADD UP TO EXACTLY
// 64 digits are joined, across single line breaks (and the indentation after them),
// into one secret. Bounded: at most WRAPPED_HEX_MAX_LINES runs, so a column of hex
// words is not a key. Two bare 32-hex lines (two MD5 sums) are indistinguishable from
// a wrapped key and are redacted too; a digest is not worth a leaked key.

const WRAPPED_HEX_DIGITS = 64;
const WRAPPED_HEX_MAX_LINES = 4;
/** A line of the key holds at least this many digits. */
const WRAPPED_HEX_MIN_RUN = 4;

/** The end of the run of hex digits that starts at `from`, looked at for at most `max + 1` digits: a result over `max` long means `too long`. */
function hexRunEnd(s: string, from: number, max: number): number {
  let i = from;
  while (i < s.length && i - from <= max && isHexDigit(s.charCodeAt(i))) i += 1;
  return i;
}

function addWrappedHexSpans(s: string, spans: Span[]): void {
  for (let nl = s.indexOf("\n"); nl !== -1; nl = s.indexOf("\n", nl + 1)) {
    // the hex run that ends this line: back over a CR and blanks, then over hex digits
    let e = nl;
    if (e > 0 && s.charCodeAt(e - 1) === 13) e -= 1;
    while (e > 0 && isBlank(s.charCodeAt(e - 1))) e -= 1;
    let b = e;
    while (b > 0 && e - b < WRAPPED_HEX_DIGITS && isHexDigit(s.charCodeAt(b - 1))) b -= 1;
    let total = e - b;
    // (the walk stopped at a non-hex character or the start, so the run is whole on its left; a run of 64+ is the contiguous shape's)
    if (total < WRAPPED_HEX_MIN_RUN || total >= WRAPPED_HEX_DIGITS) continue;
    let end = e;
    let pos = nl + 1;
    for (let lines = 1; lines < WRAPPED_HEX_MAX_LINES; lines += 1) {
      let q = pos;
      while (q < s.length && isBlank(s.charCodeAt(q))) q += 1;
      const r = hexRunEnd(s, q, WRAPPED_HEX_DIGITS - total);
      const len = r - q;
      if (len < WRAPPED_HEX_MIN_RUN || total + len > WRAPPED_HEX_DIGITS) break;
      total += len;
      end = r;
      if (total === WRAPPED_HEX_DIGITS) {
        const prefixed = b >= 2 && (s.charCodeAt(b - 1) === 120 || s.charCodeAt(b - 1) === 88) && s.charCodeAt(b - 2) === 48;
        spans.push({ start: prefixed ? b - 2 : b, end });
        break;
      }
      // a run that is not the last must end its line too, or the key is not wrapped here
      let t = r;
      while (t < s.length && (isBlank(s.charCodeAt(t)) || s.charCodeAt(t) === 13)) t += 1;
      if (s.charCodeAt(t) !== 10) break;
      pos = t + 1;
    }
  }
}

/** `://user:password@`: the lookahead-then-backreference cannot backtrack into the userinfo. */
const URL_USERINFO_RE = /:\/\/(?=([^\s/?#@[\]"'<>`\\]+))\1@/g;

function addUserinfoSpans(s: string, spans: Span[]): void {
  URL_USERINFO_RE.lastIndex = 0;
  for (let m = URL_USERINFO_RE.exec(s); m !== null; m = URL_USERINFO_RE.exec(s)) {
    const start = m.index + 3;
    spans.push({ start, end: start + m[1].length });
  }
}

/** A PEM private key block of any type (RSA, EC, OPENSSH, ENCRYPTED, PKCS#8, PGP). */
const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END_RE = /-----END [A-Z0-9 ]{0,64}PRIVATE KEY(?: BLOCK)?-----/g;

function addPemSpans(s: string, spans: Span[]): void {
  if (!s.includes("-----BEGIN ")) return;
  PEM_BEGIN_RE.lastIndex = 0;
  for (let m = PEM_BEGIN_RE.exec(s); m !== null; m = PEM_BEGIN_RE.exec(s)) {
    PEM_END_RE.lastIndex = m.index + m[0].length;
    const endLine = PEM_END_RE.exec(s);
    // A block with no END line is removed to the end of the text.
    const stop = endLine ? endLine.index + endLine[0].length : s.length;
    spans.push({ start: m.index, end: stop });
    PEM_BEGIN_RE.lastIndex = stop;
  }
}

/**
 * Replace each span of `s` with `marker`; overlapping or touching spans are one
 * secret. `report` receives the text each marker replaced. `spans` must not be empty.
 */
function applySpans(s: string, spans: Span[], marker: string, report?: (secret: string) => void): string {
  spans.sort((x, y) => x.start - y.start);
  let out = "";
  let last = 0;
  let start = spans[0].start;
  let end = spans[0].end;
  const flush = () => {
    out += s.slice(last, start) + marker;
    report?.(s.slice(start, end));
    last = end;
  };
  for (let k = 1; k < spans.length; k += 1) {
    const span = spans[k];
    if (span.start <= end) {
      if (span.end > end) end = span.end; // overlapping or touching: one secret
      continue;
    }
    flush();
    start = span.start;
    end = span.end;
  }
  flush();
  return out + s.slice(last);
}

/** Replace every credential-shaped substring of `s`, reporting each secret removed. */
function scrubShapes(s: string, report: (secret: string) => void, keepDigests = false): string {
  if (s.length === 0) return s;
  const spans: Span[] = [];
  addPemSpans(s, spans);
  addUserinfoSpans(s, spans);
  addSecretLabelSpans(s, spans);
  addMnemonicSpans(s, spans);
  addTokenRunSpans(s, spans, keepDigests);
  // A wrapped hex key is a digest-shaped value too: an owner-only view that keeps digests keeps it.
  if (!keepDigests) addWrappedHexSpans(s, spans);
  return spans.length === 0 ? s : applySpans(s, spans, REDACTED_VALUE, report);
}

// ── The deep walk ─────────────────────────────────────────────────────────

const MAX_DEPTH = 64;

export type RedactionKind = "secret-field" | "secret-shaped";

/** One removed value, reported to the optional onRedact callback. */
export interface Redaction {
  /** JSONPath-like location, e.g. `$.usage.header`, `$[2].content`, `$.body<json>.api_key`. */
  path: string;
  kind: RedactionKind;
  /** The removed secret itself (a whole field value, or one credential-shaped substring). */
  value: string;
}

/** A value under a secret name that holds nothing secret (`token: null`, `hasApiKey: false`). */
function isEmptySecretSlot(v: unknown): boolean {
  return v === null || v === undefined || v === "" || typeof v === "boolean";
}

function secretText(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return "[unserializable]";
  }
}

/** Number of `:` outside strings in valid JSON text: one per object member in the source. */
function countJsonMembers(text: string): number {
  let members = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i += 1; // backslash: skip the escaped character
      else if (c === 34) inString = false;
    } else if (c === 34) {
      inString = true;
    } else if (c === 58) {
      members += 1;
    }
  }
  return members;
}

/** Number of object members in a parsed JSON value (iterative: no recursion limit). */
function countParsedMembers(root: object): number {
  let members = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== "object") continue;
    if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
      continue;
    }
    const keys = Object.keys(v);
    members += keys.length;
    for (const k of keys) stack.push((v as Record<string, unknown>)[k]);
  }
  return members;
}

/**
 * A string holding a JSON object or array, parsed; undefined for anything else.
 * `lossy` is true when parsing dropped members: a duplicate key keeps only its last
 * value, so the text holds values the parsed copy does not (WP-D R6).
 */
function parseEmbeddedJson(s: string): { value: object; lossy: boolean } | undefined {
  // Parse the TRIMMED text (L5): trim() also drops a BOM, which JSON.parse rejects,
  // so a BOM-prefixed {"api_key":"opaque"} used to skip the walk entirely.
  const t = s.trim();
  if (t[0] !== "{" && t[0] !== "[") return undefined;
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return undefined;
  }
  if (v === null || typeof v !== "object") return undefined;
  return { value: v, lossy: countJsonMembers(t) !== countParsedMembers(v) };
}

/** Own-property write that also works for a `__proto__` key from JSON.parse. */
function define(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Return a deep copy of `value` with every secret replaced by REDACTED_VALUE. The
 * input is never mutated. `onRedact` receives each removed secret. Values that are
 * already redacted are not reported, so a second pass changes and reports nothing.
 */
export interface RedactOptions {
  /**
   * Keep bare 64-hex values (digests, hashes). ONLY for an owner-only view of
   * arguments the owner is about to confirm (WP-D round 4, L3). Secret-named
   * fields and every self-identifying credential shape are still removed, and
   * anything persisted or sent to a model keeps the default, full redaction.
   */
  keepDigests?: boolean;
}

export function redactSecretsDeep<T>(value: T, onRedact?: (r: Redaction) => void, opts: RedactOptions = {}): T {
  const keepDigests = opts.keepDigests === true;
  const onPath = new WeakSet<object>();
  let changes = 0; // every replacement, reported or not (cycle and depth cuts too)
  const report = (r: Redaction) => {
    changes += 1;
    onRedact?.(r);
  };

  const walkString = (s: string, path: string, depth: number): string => {
    let text = s;
    const embedded = depth < MAX_DEPTH ? parseEmbeddedJson(s) : undefined;
    if (embedded !== undefined) {
      const before = changes;
      const walked = walk(embedded.value, `${path}<json>`, depth + 1, null);
      // Re-serialize from the redacted copy when the walk removed something, or when
      // the parse was lossy (the dropped duplicate may be the secret).
      if (changes !== before || embedded.lossy) {
        if (changes === before) changes += 1;
        text = JSON.stringify(walked);
      }
    }
    // Shapes are scrubbed from whatever text is returned, JSON or not: a value the
    // parse dropped or a number is still text a secret can sit in.
    return scrubShapes(text, (secret) => report({ path, kind: "secret-shaped", value: secret }), keepDigests);
  };

  const walk = (v: unknown, path: string, depth: number, parentKey: string | null): unknown => {
    if (typeof v === "string") return walkString(v, path, depth);
    if (v === null || typeof v !== "object") return v;
    if (depth >= MAX_DEPTH || onPath.has(v)) {
      changes += 1;
      return REDACTED_VALUE;
    }
    onPath.add(v);
    let out: unknown;
    if (Array.isArray(v)) {
      out = v.map((item, i) => walk(item, `${path}[${i}]`, depth + 1, parentKey));
    } else {
      const obj: Record<string, unknown> = {};
      const suffixes = new Map<string, number>(); // next #n per colliding key: O(1) per collision
      for (const [rawKey, item] of Object.entries(v as Record<string, unknown>)) {
        // A key can itself be a secret (a map keyed by token): scrub it, keep keys unique.
        const scrubbed = scrubShapes(rawKey, (secret) => report({ path: `${path}.<key>`, kind: "secret-shaped", value: secret }), keepDigests);
        let key = scrubbed;
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          let n = suffixes.get(scrubbed) ?? 1;
          do {
            n += 1;
            key = `${scrubbed}#${n}`;
          } while (Object.prototype.hasOwnProperty.call(obj, key));
          suffixes.set(scrubbed, n);
        }
        const p = `${path}.${key}`;
        if (isSecretField(rawKey, item, parentKey) && !isEmptySecretSlot(item)) {
          if (item === REDACTED_VALUE) {
            // already redacted: nothing changes, nothing to report
          } else if (typeof item === "string" && item.includes(REDACTED_VALUE)) {
            changes += 1; // e.g. "Bearer [REDACTED]": rewritten whole, nothing left to report
          } else {
            report({ path: p, kind: "secret-field", value: secretText(item) });
          }
          define(obj, key, REDACTED_VALUE);
        } else {
          define(obj, key, walk(item, p, depth + 1, rawKey));
        }
      }
      out = obj;
    }
    onPath.delete(v);
    return out;
  };

  return walk(value, "$", 0, null) as T;
}
