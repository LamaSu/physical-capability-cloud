/**
 * Device intake — secret and sensitive-value scan over every string.
 *
 * Free-text intake answers (device.description, a source's doc/section, ...)
 * are where a producer can paste something that must never be stored or shown:
 * a private key, an API token, a recovery phrase, a payout address, a street
 * address. `scanIntakeStrings` walks every string in a value (answer values,
 * sources, nested arrays and objects) and reports where a detector below
 * matches. A hit is only `{path, kind}` — the matched text is never returned,
 * logged or thrown. Object KEYS are not scanned here; `validateIntake` checks
 * keys separately.
 *
 * Policy for producers: call `validateIntake` — or at least
 * `scanIntakeStrings` — BEFORE logging or persisting a record, and again before
 * any public projection of it. Rejecting is the rule: a record with a hit is
 * not ok and its value belongs in the authoritative private store (the payout
 * destination and street address are `{set: true}` in the record; the real
 * values go to their own stores). `redactIntakeSecrets` is for log output
 * only; it is not a way to keep a record that has a hit.
 *
 * These are heuristic detectors, not proof of absence: a string that matches
 * none of them is not thereby known to be safe. Each string is matched as
 * written, one string at a time: a copy that is obfuscated (split by invisible
 * characters, spelled in full-width forms) or spread across several strings is
 * not detected.
 *
 * Paths never echo an unknown key: a key outside the closed intake vocabulary
 * (vocabulary.ts) is shown only as `#` plus 12 hex digits of its SHA-256, so a
 * credential pasted as a key, in any format, never reaches a report or a log.
 *
 * One exact exemption: a source's `contentHash` (answers/<field>/source/
 * contentHash) is a typed `sha256:<64 hex>` digest of cited text, not a secret,
 * so a string at that path in exactly that form is not scanned.
 *
 * Detectors (see each constant for the exact pattern):
 *   - pem             a PEM header `-----BEGIN <LABEL>-----`.
 *   - vendor-key      known API-key / token formats (Stripe, any `sk-` key
 *                     including `sk-proj-`/`sk-ant-`, AWS, Google, Slack,
 *                     GitHub, GitLab, Hugging Face, npm, SendGrid, Shopify,
 *                     DigitalOcean, Azure storage, PCC keys) and JWTs.
 *   - labeled-secret  a value written after a secret-ish label (`api_key: …`,
 *                     `password=…`, `token: …`, `Bearer …`) that is at least 12
 *                     characters and contains a digit: it catches credentials
 *                     whose format no vendor pattern knows.
 *   - hex-secret      64 hex characters, with or without `0x`, as a whole
 *                     token (not part of a longer run of hex digits).
 *   - payout-address  an EVM address (`0x` + 40 hex, as a whole token). No
 *                     INTAKE_FIELDS entry holds an address string
 *                     (payout.destination is `{set: true}` only), so there is
 *                     no per-field exemption: it is flagged everywhere.
 *   - mnemonic        12 or more consecutive words, all on the BIP-39 English
 *                     wordlist (case-insensitive; digits, punctuation and
 *                     whitespace between words do not break a run). This is
 *                     deliberately broader than "checksum-valid": no checksum
 *                     is computed, so a run of 12 listed words is flagged even
 *                     when it would not be a valid phrase.
 *   - street-address  a HEURISTIC backstop only: a house number, 1 to 4
 *                     capitalized words, then a street-type word (Street, Ave,
 *                     Way, Lane, Drive, ...). The authoritative address store is
 *                     location.streetAddress = {set: true}; this only catches
 *                     the common US/UK shape pasted into a free-text field.
 *                     No INTAKE_FIELDS entry holds a street address string, so
 *                     it is applied to every field.
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { BIP39_ENGLISH_WORDLIST } from "./bip39-english.js";
import { CONTENT_HASH_PATTERN } from "../citation-rules.js";
import { INTAKE_KEY_VOCABULARY } from "./vocabulary.js";
import { walkValue, type WalkPathSegment } from "./walk.js";

export const INTAKE_SECRET_KINDS = [
  "pem",
  "vendor-key",
  "labeled-secret",
  "hex-secret",
  "payout-address",
  "mnemonic",
  "street-address",
] as const;
export type IntakeSecretKind = (typeof INTAKE_SECRET_KINDS)[number];

/** One detector match. `path` is JSON-pointer-like (`answers/<fieldId>/value/...`,
 *  array indices as numbers) and never contains the matched text. */
export interface IntakeSecretHit {
  path: string;
  kind: IntakeSecretKind;
}

// ── Detectors ────────────────────────────────────────────────────────────
//
// Every regex is global and used ONLY through String.prototype.matchAll (which
// works on a copy), so the shared lastIndex is never advanced.

/** `-----BEGIN <LABEL>-----`; the label is captured so a redaction can reach
 *  the matching `-----END <LABEL>-----` footer. */
const PEM_BEGIN = /-----BEGIN ([A-Z0-9 ]{3,40})-----/g;

const VENDOR_KEY_PATTERNS: readonly RegExp[] = [
  /sk_live_[A-Za-z0-9]{10,}/g,
  /rk_live_[A-Za-z0-9]{10,}/g,
  // any `sk-` key: sk-ant-, sk-proj-, sk-svcacct-, sk-admin- and bare sk- (hyphens and underscores allowed)
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g,
  /whsec_[A-Za-z0-9]{20,}/g,
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /ya29\.[A-Za-z0-9_-]{20,}/g,
  /xox[abeoprs]-[A-Za-z0-9-]{10,}/g,
  /xapp-[A-Za-z0-9-]{10,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{30,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /hf_[A-Za-z0-9]{30,}/g,
  /npm_[A-Za-z0-9]{36,}/g,
  /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}/g,
  /dop_v1_[a-f0-9]{64}/g,
  /AccountKey=[A-Za-z0-9+/=]{40,}/g,
  /pcc_(?:live|oracle|test)_[A-Za-z0-9]{16,}/g,
  // a JWT: three base64url segments, the first two start with `eyJ` ({"...)
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/**
 * A value after a secret-ish label, or a Bearer token: credentials whose format
 * no vendor pattern knows. The value must be at least 12 characters with no
 * whitespace or quote and contain a digit, so prose such as "password: see the
 * manual" does not match.
 */
const LABELED_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:api[_ -]?key|apikey|secret|client[_ -]?secret|access[_ -]?key|private[_ -]?key|token|password|passwd|pwd|passphrase|auth)\b["']?\s*[:=]\s*["']?(?=[^\s"']*[0-9])[^\s"']{12,}/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
];

/** 64 hex characters (a 32-byte key or digest), optionally `0x`-prefixed,
 *  bounded by non-hex on both sides. */
const HEX_SECRET = /(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;

/** An EVM address: `0x` + 40 hex, bounded by non-hex on both sides (so the
 *  first 40 digits of a 64-hex secret are not an address). */
const PAYOUT_ADDRESS = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

/** A recovery phrase is at least this many consecutive listed words. */
const MNEMONIC_MIN_WORDS = 12;
const WORD_TOKEN = /[A-Za-z]+/g;
const BIP39_WORDS: ReadonlySet<string> = new Set(BIP39_ENGLISH_WORDLIST);

// Street-address heuristic. Case-sensitive on the capital letters: the words
// between the number and the street type must start with a capital (so
// "3 drive bays" and "4 way valve" never match); the street type is its
// Title-case spelling or its ALL-CAPS spelling. A house number may carry one
// letter ("221B") or be a range ("12-14"), and an ordinal ("5th") counts as a
// word ("350 5th Avenue").
const STREET_TYPES = [
  "Street",
  "St",
  "Avenue",
  "Ave",
  "Boulevard",
  "Blvd",
  "Road",
  "Rd",
  "Parkway",
  "Pkwy",
  "Highway",
  "Hwy",
  "Terrace",
  "Court",
  "Ct",
  "Place",
  "Pl",
  "Square",
  "Sq",
  "Way",
  "Lane",
  "Ln",
  "Drive",
  "Dr",
  "Circle",
  "Cir",
  "Trail",
  "Plaza",
  "Alley",
  "Crescent",
  "Close",
  "Loop",
];
const STREET_TYPE_ALTERNATION = [...STREET_TYPES, ...STREET_TYPES.map((t) => t.toUpperCase())].join("|");
const STREET_WORD = "(?:[A-Z][A-Za-z'\\u2019.-]*|\\d{1,3}(?:st|nd|rd|th|ST|ND|RD|TH))";
const STREET_ADDRESS = new RegExp(
  `(?<![A-Za-z0-9])\\d{1,6}(?:-\\d{1,6})?[A-Za-z]?\\s+(?:${STREET_WORD}\\s+){1,4}(?:${STREET_TYPE_ALTERNATION})\\b`,
  "g",
);

// ── Span finding ─────────────────────────────────────────────────────────

interface SecretSpan {
  start: number;
  end: number;
  kind: IntakeSecretKind;
}

function mnemonicSpans(text: string): SecretSpan[] {
  const spans: SecretSpan[] = [];
  let runStart = 0;
  let runEnd = 0;
  let runLength = 0;
  const flush = (): void => {
    if (runLength >= MNEMONIC_MIN_WORDS) spans.push({ start: runStart, end: runEnd, kind: "mnemonic" });
    runLength = 0;
  };
  for (const match of text.matchAll(WORD_TOKEN)) {
    const index = match.index ?? 0;
    if (BIP39_WORDS.has(match[0].toLowerCase())) {
      if (runLength === 0) runStart = index;
      runEnd = index + match[0].length;
      runLength += 1;
    } else {
      flush();
    }
  }
  flush();
  return spans;
}

/** No detector can match a string shorter than this (the shortest possible hit
 *  is a street address such as "1 A St"), so shorter strings skip detection
 *  altogether — it keeps scanning cheap and a deeply nested structure linear. */
const MIN_DETECTABLE_LENGTH = 6;

function findSecretSpans(text: string): SecretSpan[] {
  const spans: SecretSpan[] = [];
  if (text.length < MIN_DETECTABLE_LENGTH) return spans;

  for (const match of text.matchAll(PEM_BEGIN)) {
    const start = match.index ?? 0;
    // Reach through the matching footer so a redaction removes the key body
    // too; without a footer, the rest of the string is treated as the body.
    const footer = `-----END ${match[1]}-----`;
    const footerAt = text.indexOf(footer, start + match[0].length);
    spans.push({ start, end: footerAt === -1 ? text.length : footerAt + footer.length, kind: "pem" });
  }
  for (const pattern of VENDOR_KEY_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      spans.push({ start, end: start + match[0].length, kind: "vendor-key" });
    }
  }
  for (const pattern of LABELED_SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      spans.push({ start, end: start + match[0].length, kind: "labeled-secret" });
    }
  }
  for (const match of text.matchAll(HEX_SECRET)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length, kind: "hex-secret" });
  }
  for (const match of text.matchAll(PAYOUT_ADDRESS)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length, kind: "payout-address" });
  }
  spans.push(...mnemonicSpans(text));
  for (const match of text.matchAll(STREET_ADDRESS)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length, kind: "street-address" });
  }
  return spans;
}

/** Merge overlapping spans; a merged span keeps the kind of its earliest member. */
function mergeSpans(spans: readonly SecretSpan[]): SecretSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SecretSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) {
      if (span.end > last.end) last.end = span.end;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/** The distinct kinds that match `text`, in INTAKE_SECRET_KINDS order. Internal:
 *  used by validateIntake to keep key text out of its report. */
export function secretKindsOf(text: string): IntakeSecretKind[] {
  const found = new Set(findSecretSpans(text).map((s) => s.kind));
  return INTAKE_SECRET_KINDS.filter((kind) => found.has(kind));
}

// ── Path formatting ──────────────────────────────────────────────────────

const MAX_SEGMENT_LENGTH = 80;

const NO_KEYS: ReadonlySet<string> = new Set();
const TOKEN_SEPARATOR = String.fromCharCode(0);

/**
 * Every object key anywhere in `value` (array indices are not keys). A report
 * or a redacted copy of `value` never shows a token equal to one of them, so a
 * token cannot reproduce a raw key the caller wrote (astra pack 120e).
 */
export function rawKeysOf(value: unknown): ReadonlySet<string> {
  const keys = new Set<string>();
  walkValue(value, { key: (key) => keys.add(key) });
  return keys;
}

/** `#` plus 12 hex of sha256(raw); re-derived (sha256 of raw, NUL, n) until `taken` refuses it no longer. */
function tokenOf(raw: string, taken: (candidate: string) => boolean): string {
  for (let n = 0; ; n++) {
    const material = n === 0 ? raw : `${raw}${TOKEN_SEPARATOR}${n}`;
    const candidate = `#${bytesToHex(sha256(new TextEncoder().encode(material))).slice(0, 12)}`;
    if (!taken(candidate)) return candidate;
  }
}

/**
 * One path segment, safe to put in a report or a log line. Only a real array
 * index (a NUMBER, as the walker records one) or an object key in the closed
 * intake vocabulary (INTAKE_KEY_VOCABULARY) is shown verbatim, with `~` and `/`
 * escaped (RFC 6901) and anything outside printable ASCII written as `\u{hex}`.
 * Every other object key, including a numeric-looking one such as "123456", is
 * written as a one-way token: `#` plus the first 12 hex digits of its SHA-256,
 * so a credential or PIN pasted as a key, in a format no detector knows, is
 * never echoed (astra packs 120c and 120d). `reserved` holds every raw key of
 * the input being reported (rawKeysOf); a token equal to one of them is
 * re-derived, so no token ever reproduces a key the caller wrote (astra pack
 * 120e). Without collisions, the same key always gets the same token.
 * Internal: shared with validateIntake's reports.
 */
export function pathSegment(raw: WalkPathSegment, reserved: ReadonlySet<string> = NO_KEYS): string {
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : "#index";
  if (!INTAKE_KEY_VOCABULARY.has(raw)) return tokenOf(raw, (candidate) => reserved.has(candidate));
  const escaped = raw
    .replace(/~/g, "~0")
    .replace(/\//g, "~1")
    .replace(/[^\x20-\x7e]/gu, (ch) => `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}`);
  return escaped.length > MAX_SEGMENT_LENGTH ? `${escaped.slice(0, MAX_SEGMENT_LENGTH)}...` : escaped;
}

export function joinPath(segments: readonly WalkPathSegment[], reserved: ReadonlySet<string> = NO_KEYS): string {
  return segments.map((segment) => pathSegment(segment, reserved)).join("/");
}

// ── Scanning ─────────────────────────────────────────────────────────────

/** A typed digest of cited text at answers/<field>/source/contentHash: the one exact exemption,
 *  shared by the scan and by log redaction (astra pack 120d), in the same format the schema accepts. */
function isSourceContentHash(text: string, path: readonly WalkPathSegment[]): boolean {
  return (
    path.length === 4 &&
    path[0] === "answers" &&
    typeof path[1] === "string" &&
    path[2] === "source" &&
    path[3] === "contentHash" &&
    CONTENT_HASH_PATTERN.test(text)
  );
}

/**
 * Scan every string in `value` (arrays and objects, recursively) with every
 * detector. Returns one `{path, kind}` per (string, kind) in document order;
 * empty when nothing matches. It never returns or logs the matched text, and
 * object keys are not scanned.
 */
export function scanIntakeStrings(value: unknown): IntakeSecretHit[] {
  const hits: IntakeSecretHit[] = [];
  const reserved = rawKeysOf(value);
  walkValue(value, {
    string: (text, path) => {
      if (isSourceContentHash(text, path())) return;
      const kinds = secretKindsOf(text);
      if (kinds.length === 0) return;
      const where = joinPath(path(), reserved);
      for (const kind of kinds) hits.push({ path: where, kind });
    },
  });
  return hits;
}

// ── Redaction (log output only) ──────────────────────────────────────────

function redactText(text: string): string {
  const spans = mergeSpans(findSecretSpans(text));
  if (spans.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += `${text.slice(cursor, span.start)}[redacted:${span.kind}]`;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

function setOwn(target: object, key: string, value: unknown): void {
  // defineProperty, not assignment: a key named "__proto__" must stay data.
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * A deep copy of `record` in which every string that matches a detector has
 * each match replaced by `[redacted:<kind>]` (a PEM block is replaced through
 * its footer). An object key outside the closed intake vocabulary is renamed
 * to its `pathSegment` token (`#` plus 12 hex digits of its SHA-256). A token
 * never equals any raw key anywhere in `record`, nor another key's token in the
 * same object: on a collision it is re-derived. So an unknown key never reaches
 * a log verbatim, whatever its format, and no token reproduces a raw key (astra
 * pack 120e); a numeric-looking key ("123456") is a key,
 * not an array index, and is renamed too (astra pack 120d). The typed digest at
 * answers/<field>/source/contentHash is kept as it is, exactly as the scan
 * exempts it. Arrays and objects are copied (an object that is not a plain
 * object becomes a plain object of its own enumerable properties); an object
 * reachable twice is copied once, at the first path it is reached by. Numbers,
 * booleans, null and undefined are returned as they are. The input is not
 * modified.
 *
 * For safe LOGGING only. A record that has a hit must be rejected (see the
 * file header), not stored in redacted form.
 */
export function redactIntakeSecrets<T>(record: T): T {
  const copies = new Map<object, unknown>();
  const pending: { source: object; target: object; path: WalkPathSegment[] }[] = [];
  const reserved = rawKeysOf(record);

  const copyOf = (node: unknown, path: WalkPathSegment[]): unknown => {
    if (typeof node === "string") return isSourceContentHash(node, path) ? node : redactText(node);
    if (node === null || typeof node !== "object") return node;
    const known = copies.get(node);
    if (known !== undefined) return known;
    const target: object = Array.isArray(node) ? [] : {};
    copies.set(node, target);
    pending.push({ source: node, target, path });
    return target;
  };

  const root = copyOf(record, []);
  while (pending.length > 0) {
    const { source, target, path } = pending.pop()!;
    if (Array.isArray(source)) {
      for (let i = 0; i < source.length; i++) (target as unknown[])[i] = copyOf(source[i], [...path, i]);
      continue;
    }
    // Keys that are kept as they are claim their names first, so a renamed key
    // can never take (and then be overwritten by) one of them.
    const entries = Object.entries(source).map(([key, value]) => ({ key, value, kept: pathSegment(key) === key }));
    const usedKeys = new Set(entries.filter((e) => e.kept).map((e) => e.key));
    for (const { key, value, kept } of entries) {
      let outKey = key;
      if (!kept) {
        outKey = tokenOf(key, (candidate) => reserved.has(candidate) || usedKeys.has(candidate));
        usedKeys.add(outKey);
      }
      setOwn(target, outKey, copyOf(value, [...path, key]));
    }
  }
  return root as T;
}
