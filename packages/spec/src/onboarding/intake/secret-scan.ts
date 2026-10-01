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
 * none of them is not thereby known to be safe.
 *
 * Detectors (see each constant for the exact pattern):
 *   - pem             a PEM header `-----BEGIN <LABEL>-----`.
 *   - vendor-key      known API-key / token formats (Stripe, Anthropic/OpenAI-
 *                     style `sk-`, AWS access key id, Google API key, Slack,
 *                     GitHub, PCC keys) and JWTs.
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
 *                     ...). The authoritative address store is
 *                     location.streetAddress = {set: true}; this only catches
 *                     the common US/UK shape pasted into a free-text field.
 *                     No INTAKE_FIELDS entry holds a street address string, so
 *                     it is applied to every field.
 */

import { BIP39_ENGLISH_WORDLIST } from "./bip39-english.js";
import { walkValue } from "./walk.js";

export const INTAKE_SECRET_KINDS = [
  "pem",
  "vendor-key",
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
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9]{32,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{30,}/g,
  /pcc_(?:live|oracle|test)_[A-Za-z0-9]{16,}/g,
  // a JWT: three base64url segments, the first two start with `eyJ` ({"...)
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
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

function findSecretSpans(text: string): SecretSpan[] {
  const spans: SecretSpan[] = [];

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

/** No detector can match a string shorter than this (the shortest possible hit
 *  is a street address such as "1 A St"), so shorter object keys and path
 *  segments skip detection — it keeps a deeply nested structure linear. */
const MIN_DETECTABLE_LENGTH = 6;

/** `secretKindsOf` for an object key or path segment. */
function keyKinds(key: string): IntakeSecretKind[] {
  return key.length < MIN_DETECTABLE_LENGTH ? [] : secretKindsOf(key);
}

// ── Path formatting ──────────────────────────────────────────────────────

const MAX_SEGMENT_LENGTH = 80;

/**
 * One path segment, safe to put in a report or a log line. A key that itself
 * matches a detector is replaced by `[redacted:<kind>]`; otherwise `~` and `/`
 * are escaped (RFC 6901), anything outside printable ASCII is written as
 * `\u{hex}` (no log forging, and a lookalike character stays visible), and a
 * long segment is cut. Internal: shared with validateIntake's reports.
 */
export function pathSegment(raw: string): string {
  const kinds = keyKinds(raw);
  if (kinds.length > 0) return `[redacted:${kinds[0]}]`;
  const escaped = raw
    .replace(/~/g, "~0")
    .replace(/\//g, "~1")
    .replace(/[^\x20-\x7e]/gu, (ch) => `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}`);
  return escaped.length > MAX_SEGMENT_LENGTH ? `${escaped.slice(0, MAX_SEGMENT_LENGTH)}...` : escaped;
}

export function joinPath(segments: readonly string[]): string {
  return segments.map(pathSegment).join("/");
}

// ── Scanning ─────────────────────────────────────────────────────────────

/**
 * Scan every string in `value` (arrays and objects, recursively) with every
 * detector. Returns one `{path, kind}` per (string, kind) in document order;
 * empty when nothing matches. It never returns or logs the matched text, and
 * object keys are not scanned.
 */
export function scanIntakeStrings(value: unknown): IntakeSecretHit[] {
  const hits: IntakeSecretHit[] = [];
  walkValue(value, {
    string: (text, path) => {
      const kinds = secretKindsOf(text);
      if (kinds.length === 0) return;
      const where = joinPath(path());
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
 * its footer). An object key that itself matches a detector is renamed to
 * `[redacted:<kind>]`, suffixed `-2`, `-3`, ... if that would collide. Arrays
 * and objects are copied (an object that is not a plain object becomes a plain
 * object of its own enumerable properties); numbers, booleans, null and
 * undefined are returned as they are. The input is not modified.
 *
 * For safe LOGGING only. A record that has a hit must be rejected (see the
 * file header), not stored in redacted form.
 */
export function redactIntakeSecrets<T>(record: T): T {
  const copies = new Map<object, unknown>();
  const pending: { source: object; target: object }[] = [];

  const copyOf = (node: unknown): unknown => {
    if (typeof node === "string") return redactText(node);
    if (node === null || typeof node !== "object") return node;
    const known = copies.get(node);
    if (known !== undefined) return known;
    const target: object = Array.isArray(node) ? [] : {};
    copies.set(node, target);
    pending.push({ source: node, target });
    return target;
  };

  const root = copyOf(record);
  while (pending.length > 0) {
    const { source, target } = pending.pop()!;
    if (Array.isArray(source)) {
      for (let i = 0; i < source.length; i++) (target as unknown[])[i] = copyOf(source[i]);
      continue;
    }
    const usedKeys = new Set<string>();
    for (const [key, value] of Object.entries(source)) {
      const kinds = keyKinds(key);
      let outKey = kinds.length > 0 ? `[redacted:${kinds[0]}]` : key;
      if (kinds.length > 0) {
        for (let n = 2; usedKeys.has(outKey); n++) outKey = `[redacted:${kinds[0]}]-${n}`;
      }
      usedKeys.add(outKey);
      setOwn(target, outKey, copyOf(value));
    }
  }
  return root as T;
}
