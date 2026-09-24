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
 */

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
  let out = s.replace(BEARER_RE, "Bearer " + REDACTED);
  out = out.replace(PCC_KEY_RE, "pcc_$1_redacted");
  // JSON Web Tokens (header.payload.signature; header is base64 of `{"…`)
  out = replaceJwts(out, "[redacted-jwt]");
  out = out.replace(HEX_SECRET_RE, "[redacted-hex]");
  return out.replace(VENDOR_KEY_RE, "[redacted-key]");
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

/**
 * Match `eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}` at `i`, the
 * way the greedy regex would: each segment is a maximal [A-Za-z0-9_-] run, since
 * `.` is not in that class. On failure, `skipTo` is the end of the first
 * segment's run: every later `eyJ` start inside that run ends its first segment at
 * the same place (so it fails the same way), and need not be tried.
 */
function jwtAt(s: string, i: number): { end: number; skipTo: number } {
  if (s.charCodeAt(i) !== 101 || s.charCodeAt(i + 1) !== 121 || s.charCodeAt(i + 2) !== 74) {
    return { end: -1, skipTo: i + 1 };
  }
  const e1 = b64urlRunEnd(s, i + 3);
  if (e1 - (i + 3) < 6 || s.charCodeAt(e1) !== 46) return { end: -1, skipTo: e1 };
  const e2 = b64urlRunEnd(s, e1 + 1);
  if (e2 - (e1 + 1) < 6 || s.charCodeAt(e2) !== 46) return { end: -1, skipTo: e1 };
  const e3 = b64urlRunEnd(s, e2 + 1);
  if (e3 - (e2 + 1) < 6) return { end: -1, skipTo: e1 };
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
/** Whole names outside the spec list that are secret fields on their own. */
const SECRET_NAMES = new Set(["credential", "credentials", "cookies", "jwt", "bearer"]);

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
//   2. schemes: a run that follows `Bearer` (12+ characters) or `Basic` (base64 of
//      a printable `user:password`) and whitespace;
//   3. an `Authorization:` / `authorization=` label: the credential after it,
//      whatever its shape, keeping a scheme word such as `Basic`;
//   4. URL userinfo: the `user:password` in `scheme://user:password@host`;
//   5. PEM private-key blocks, BEGIN to END (or to the end of the text).

/** Self-identifying shapes. Each is anchored where it is tried and ends in one greedy class (or a fixed width). */
const PCC_KEY_Y = /pcc_(?:live|test|oracle)_[A-Za-z0-9_-]{6,}/iy;
const PAYMENT_KEY_Y = /[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/y;
const WEBHOOK_SECRET_Y = /whsec_[A-Za-z0-9+/=]{10,}/y;
const OPENAI_KEY_Y = /sk-[A-Za-z0-9_-]{16,}/y;
const GITHUB_TOKEN_Y = /gh[po]_[A-Za-z0-9]{20,}/y;
const SLACK_TOKEN_Y = /xox[baprs]-[A-Za-z0-9-]{10,}/y;
const AWS_KEY_ID_Y = /AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/y;
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

/** The self-identifying shapes inside the token run [a, b). */
function addShapeSpans(s: string, a: number, b: number, spans: Span[]): void {
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
          end = stickyEnd(GITHUB_TOKEN_Y, s, i);
          break;
        case 120: // x
          end = stickyEnd(SLACK_TOKEN_Y, s, i);
          break;
        case 65: // A
          end = stickyEnd(AWS_KEY_ID_Y, s, i);
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
    if (isHexDigit(c) && !isHexDigit(prev)) end = Math.max(end, stickyEnd(HEX_SECRET_Y, s, i));
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

/** `Bearer <run>` / `Basic <run>`: the run [a, b) after a scheme word and whitespace. */
function addSchemeSpan(s: string, a: number, b: number, spans: Span[]): void {
  let j = a - 1;
  if (j < 0 || !isSpace(s.charCodeAt(j))) return;
  while (j >= 0 && isSpace(s.charCodeAt(j))) j -= 1;
  if (wordEndsAt(s, j, "bearer")) {
    if (b - a >= MIN_SHAPE_RUN) spans.push({ start: a, end: b });
  } else if (wordEndsAt(s, j, "basic")) {
    const end = basicCredentialEnd(s, a);
    if (end > a) spans.push({ start: a, end });
  }
}

function addTokenRunSpans(s: string, spans: Span[]): void {
  TOKEN_RUN_RE.lastIndex = 0;
  for (let m = TOKEN_RUN_RE.exec(s); m !== null; m = TOKEN_RUN_RE.exec(s)) {
    const a = m.index;
    const b = a + m[0].length;
    if (b - a >= MIN_SCHEME_RUN) addSchemeSpan(s, a, b, spans);
    if (b - a >= MIN_SHAPE_RUN) addShapeSpans(s, a, b, spans);
  }
}

const AUTHORIZATION_LABEL_RE = /(?<![A-Za-z0-9])(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?/gi;
/** An optional scheme word (Basic, Bearer, Token, AWS4-HMAC-SHA256) before the credential. */
const AUTH_SCHEME_Y = /[A-Za-z][A-Za-z0-9._-]{0,31}[ \t]+(?=[A-Za-z0-9_.~+/=[-])/y;
const TOKEN_RUN_Y = /[A-Za-z0-9_.~+/=-]+/y;

function addAuthorizationSpans(s: string, spans: Span[]): void {
  AUTHORIZATION_LABEL_RE.lastIndex = 0;
  for (let m = AUTHORIZATION_LABEL_RE.exec(s); m !== null; m = AUTHORIZATION_LABEL_RE.exec(s)) {
    let k = m.index + m[0].length;
    const scheme = stickyEnd(AUTH_SCHEME_Y, s, k);
    if (scheme > k) k = scheme;
    const end = stickyEnd(TOKEN_RUN_Y, s, k);
    if (end > k) spans.push({ start: k, end });
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

/** Replace every credential-shaped substring of `s`, reporting each secret removed. */
function scrubShapes(s: string, report: (secret: string) => void): string {
  if (s.length === 0) return s;
  const spans: Span[] = [];
  addPemSpans(s, spans);
  addUserinfoSpans(s, spans);
  addAuthorizationSpans(s, spans);
  addTokenRunSpans(s, spans);
  if (spans.length === 0) return s;
  spans.sort((x, y) => x.start - y.start);
  let out = "";
  let last = 0;
  let start = spans[0].start;
  let end = spans[0].end;
  const flush = () => {
    out += s.slice(last, start) + REDACTED_VALUE;
    report(s.slice(start, end));
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
  const t = s.trimStart();
  if (t[0] !== "{" && t[0] !== "[") return undefined;
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return undefined;
  }
  if (v === null || typeof v !== "object") return undefined;
  return { value: v, lossy: countJsonMembers(s) !== countParsedMembers(v) };
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
export function redactSecretsDeep<T>(value: T, onRedact?: (r: Redaction) => void): T {
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
    return scrubShapes(text, (secret) => report({ path, kind: "secret-shaped", value: secret }));
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
        const scrubbed = scrubShapes(rawKey, (secret) => report({ path: `${path}.<key>`, kind: "secret-shaped", value: secret }));
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
