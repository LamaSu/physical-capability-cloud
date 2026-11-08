/**
 * Redact secrets from a value before it is LOGGED (FC-8; astra pack 61, CRITICAL).
 *
 * The e2e/smoke scripts logged raw gateway responses verbatim, which printed real
 * secrets: a Lit `usageKey`, a provisioned `api_key`, or an `x-oracle-key`
 * reflected in a diagnostic. A value-shape string redactor (redaction.ts
 * redactSecrets) does not catch a key whose value has no recognizable shape
 * (e.g. `usageKey: "lit_secret_123"`). So this redacts BY KEY NAME first —
 * any field whose name looks like a credential is dropped regardless of its
 * value — and passes surviving strings through the shape redactor as a second
 * layer. Over-redaction in a log is safe, so the key match is deliberately broad.
 */
import { redactSecrets } from "../redaction.js";
import { createHash } from "node:crypto";

const SENSITIVE_NEEDLES = [
  "secret",
  "private",
  "apikey",
  "usagekey",
  "oraclekey",
  "signingkey",
  "sessionkey",
  "accesstoken",
  "refreshtoken",
  "mnemonic",
  "credential",
  "authorization",
  "password",
  "passphrase",
  "bearer",
  "seed",
];

/** A field name that should never have its value logged. */
export function isSensitiveLogKey(key: string): boolean {
  const norm = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (norm === "key" || norm === "token" || norm === "auth" || norm === "seed") return true;
  if (norm.endsWith("key") || norm.endsWith("token") || norm.endsWith("secret") || norm.endsWith("password")) return true;
  return SENSITIVE_NEEDLES.some((n) => norm.includes(n));
}

const REDACTED = "[redacted]";

/**
 * A copy of `value` safe to log: the value of any sensitive-looking key is
 * replaced with `[redacted]`, every other string is run through the shape
 * redactor, arrays and depth are capped. Never throws.
 */
export function redactLogValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[redacted-depth]";
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    const capped = value.slice(0, 100).map((v) => redactLogValue(v, depth + 1));
    if (value.length > 100) capped.push(`[+${value.length - 100} more]`);
    return capped;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveLogKey(k) ? REDACTED : redactLogValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** JSON of `value` with secrets removed, capped to `max` characters. Never throws. */
export function safeLogJson(value: unknown, max = 800): string {
  let s: string;
  try {
    s = JSON.stringify(redactLogValue(value));
  } catch {
    return "[unserializable]";
  }
  if (s === undefined) return "undefined";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ── FC-8 round 2 (astra pack 61b, CRITICAL) ─────────────────────────────────
//
// Pack 61's fix above routed each script's HTTP Body/Response logging through
// safeLogJson, but several OTHER print sites in the same e2e/smoke scripts
// still interpolated a raw oracle/gateway value or a raw caught exception
// directly, bypassing safeLogJson entirely: a non-JSON response body, an
// `.error` field used as a fallback next to an id, or `.message`/the whole
// error object in a top-level catch. Regexes cannot make safeLogJson a sound
// boundary for free text (see redact-log.test.ts's documented gaps), so these
// three helpers instead replace each such site with a VALIDATED, ALLOW-LISTED
// projection — a fingerprinted id, a class-name-shaped error label, or a
// parsed-and-redacted JSON body — and a static fallback otherwise. Never an
// arbitrary body, error message, or stack.

/**
 * Parse `text` (an HTTP response body) as JSON and redact it with
 * `safeLogJson`; a non-JSON body (an HTML error page, a plain-text
 * diagnostic, or a reflected header) is withheld entirely rather than
 * printed raw, since it has no key-name structure for the shape layer to
 * anchor on. Never throws.
 */
export function safeLogResponseText(text: string, max = 800): string {
  try {
    return safeLogJson(JSON.parse(text), max);
  } catch {
    return "[non-JSON response withheld]";
  }
}

// ── FC-8 round 5 (astra pack 61d, DO-NOT-SHIP at #326 @d8190fe3) ───────────
//
// Round 4's safeLogErrorName kept a SHAPE check (an identifier-looking
// `.name`) — exactly the defect finding 3 rejected for safeLogId, just
// moved to a different field. "PCCOracleKey5f1e" is precisely as
// identifier-shaped as "TypeError"; a dependency can set `.name` to
// anything it wants. The fix is the same move as finding 3's: stop
// shape-checking and enumerate the CLOSED set of names these scripts'
// catch blocks are actually written to distinguish. Anything else —
// however identifier-shaped — collapses to "Error".
const KNOWN_ERROR_NAMES = new Set<string>([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
  "AbortError", "TimeoutError",
]);

/**
 * A bounded, validated label safe to log for a thrown value: only `.name`,
 * and only when it is one of KNOWN_ERROR_NAMES — a CLOSED enum, not a shape
 * check (round 4's shape check let a dependency-controlled string like
 * "PCCOracleKey5f1e" through unchanged, since it is just as
 * identifier-shaped as "TypeError"). `.message` and `.stack` are free text
 * — exactly where a caught secret (e.g. a header value embedded in a
 * fetch/dependency error) ends up — so this never reads them, and any
 * `.name` outside the enum, identifier-shaped or not, falls back to
 * "Error". Never throws.
 */
export function safeLogErrorName(e: unknown): string {
  const name = e && typeof e === "object" && "name" in e ? (e as { name?: unknown }).name : undefined;
  return typeof name === "string" && KNOWN_ERROR_NAMES.has(name) ? name : "Error";
}

// ── FC-8 round 4 (astra pack 61c, FC-8's third failed round) ───────────────
//
// Rounds 2-3 validated each field's SHAPE before logging it (an id-shaped
// string, a hex-shaped string, a URL-safe path) and printed the value
// itself once it passed. The steward's round-4 ruling (bus #6482) rejects
// that model outright: a SHAPE check is not a content check, so a
// credential that happens to look like an id (or a hex string, or a
// URL-safe path) still prints verbatim. The property this file now
// enforces instead: a script's output may contain ONLY a fixed label the
// script authors wrote, a value from a CLOSED set the caller explicitly
// enumerates, a boolean, a locally-computed bounded number, or a FIXED-
// LENGTH FINGERPRINT that reveals nothing about its input. Nothing else.
// Concretely:
//   - safeLogId no longer returns the value — it returns a short SHA-256
//     fingerprint, so a reader can see "the same id reappeared" without the
//     id (or anything shaped like it) ever appearing. Callers MUST only use
//     this for genuine identifiers (job/scope/tool-call ids, CIDs, proof/
//     commitment/quote/intent ids) — never for a status, mode, network,
//     type, fee, route, or amount, which have no "it's just an opaque
//     handle" excuse and belong in safeLogEnum (closed set) or nowhere.
//   - safeLogHex is the same fingerprint treatment for hex/tx-hash-shaped
//     values, since a hex-encoded secret satisfies a hex-shape check just
//     as well as a real hash does.
//   - safeLogUrlPath and safeLogIdList are REMOVED. A logged HTTP path must
//     be a fixed ROUTE TEMPLATE the caller writes as a literal string (e.g.
//     "GET /api/jobs/:id/status") — never built from a real path containing
//     a response-derived segment, encoded or not. There is no helper for
//     this because there is nothing to validate: the caller simply never
//     constructs the logged string from untrusted input in the first place.

/** Fixed-length output; never varies with input length, never reveals the input. */
function fingerprint(value: string): string {
  return `id:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12)}`;
}

/**
 * A short SHA-256 fingerprint of `value`, safe to log for correlation
 * ("this is the same id as three lines up") without ever printing the id
 * (or anything that merely looks like one) itself. Only for genuine
 * identifier fields — never a status/mode/network/type/fee/route/amount.
 * Never throws.
 */
export function safeLogId(value: unknown, fallback = "(none)"): string {
  return typeof value === "string" && value.length > 0 ? fingerprint(value) : fallback;
}

export interface IntBounds { min: number; max: number; }

/**
 * An integer (number or bigint) safe to log — ONLY when it falls inside
 * [bounds.min, bounds.max] inclusive. Round 4 left this unbounded (any
 * finite integer printed verbatim, whatever its magnitude); bounds are now
 * REQUIRED per call site, matching the field actually being printed (an
 * HTTP status is 0-599, a byte count is bounded, a poll counter is
 * bounded) rather than accepting any integer a dependency hands back.
 * Out of range, non-integer, or non-numeric → fallback.
 */
export function safeLogInt(value: unknown, bounds: IntBounds, fallback = "(none)"): string {
  if (typeof value === "bigint") {
    if (!Number.isFinite(bounds.min) || !Number.isFinite(bounds.max)) return fallback;
    const min = BigInt(Math.trunc(bounds.min));
    const max = BigInt(Math.trunc(bounds.max));
    return value >= min && value <= max ? value.toString() : fallback;
  }
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return value >= bounds.min && value <= bounds.max ? String(value) : fallback;
  }
  return fallback;
}

/** A boolean safe to log as-is; anything else (including a truthy non-boolean) → fallback. */
export function safeLogBool(value: unknown, fallback = "(unknown)"): string {
  return typeof value === "boolean" ? String(value) : fallback;
}

/** A string safe to log only if it exactly matches one of `allowed` (a closed, caller-supplied set). Anything else → fallback, e.g. "(unexpected)". */
export function safeLogEnum(value: unknown, allowed: readonly string[], fallback = "(unexpected)"): string {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

/** Known-safe MIME types for the camera/evidence content-type fields. Params (e.g. `; charset=`) are stripped before matching. */
const CONTENT_TYPES = [
  "application/json", "application/octet-stream", "text/plain", "text/html",
  "image/jpeg", "image/png", "image/gif", "image/webp",
] as const;

/** A Content-Type header value safe to log: its base type only if it's one of CONTENT_TYPES. */
export function safeLogContentType(value: unknown, fallback = "(unknown)"): string {
  if (typeof value !== "string") return fallback;
  const base = value.split(";")[0]?.trim().toLowerCase();
  return base && (CONTENT_TYPES as readonly string[]).includes(base) ? base : fallback;
}

/**
 * A short SHA-256 fingerprint of a `0x`-hex string (a tx hash, a
 * signature), safe to log for correlation without printing the value — a
 * hex-encoded secret satisfies the hex-shape check just as well as a real
 * hash does, so the shape check alone (round 3's behavior) was not a
 * content boundary. Anything not hex-shaped → fallback. Never throws.
 */
export function safeLogHex(value: unknown, fallback = "(none)"): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return fallback;
  return fingerprint(value);
}

// ── FC-8 round 5 (astra pack 61d, DO-NOT-SHIP at #326 @d8190fe3) ───────────
//
// The round-4 review's additional blocking finding: the e2e scripts still
// logged raw dependency-returned tx hashes, receipt topics, and addresses,
// a raw environment-derived verifier address and report path, and raw
// Git/GitHub output in the Bash script. Round 4 gave safeLogId/safeLogHex a
// sound per-script call-site allowlist for GATEWAY-issued opaque ids; this
// round gives every PUBLIC CHAIN or GIT identifier (a tx hash, an address,
// a topic, a commit SHA) its own single, auditable function instead of
// each script rolling its own raw interpolation — which is exactly how so
// many of them ended up printed verbatim in the first place.

/** The shape each PublicIdKind must satisfy before it is logged at all. */
export type PublicIdKind = "address" | "hash" | "commitSha";

const PUBLIC_ID_SHAPES: Record<PublicIdKind, RegExp> = {
  address: /^0x[0-9a-fA-F]{40}$/, // a 20-byte chain address
  hash: /^0x[0-9a-fA-F]{64}$/, // a 32-byte tx hash / topic / content hash
  commitSha: /^[0-9a-f]{40}$/, // a full git SHA-1, no 0x prefix
};

/**
 * The module-wide rule for every value publicIdForLog logs. "fingerprint"
 * (the default): print a correlation fingerprint, never the real value.
 * "verbatim": print the real value once the lane's stewards have signed
 * off on that for a given consumer. Every publicIdForLog call site reads
 * this ONE constant, so flipping it is the entire migration — no call site
 * changes. Keep at "fingerprint" until the steward explicitly rules
 * otherwise (see the round-4 report).
 */
export const PUBLIC_ID_RULE: "fingerprint" | "verbatim" = "fingerprint";

/**
 * The ONE function for logging a PUBLIC chain/git identifier — a tx hash,
 * an address, a topic, a commit SHA, a GitHub run id. Shape-validates
 * `value` against `kind` FIRST (e.g. a hash must be `0x` plus exactly 64
 * hex characters): anything that fails that check prints "(invalid)"
 * rather than whatever it actually was, so a secret that happens to be
 * mis-shaped for the kind it is logged as is never printed either. A
 * missing/non-string value prints "(none)". A value that passes the shape
 * check is then logged per PUBLIC_ID_RULE above: fingerprinted (default),
 * or, once the lane flips that one constant, verbatim. Never throws.
 *
 * Distinct from safeLogId/safeLogHex (GATEWAY-issued opaque ids): those
 * have no "verbatim" mode and never will — they stay fingerprint-only
 * forever, by design, regardless of PUBLIC_ID_RULE. publicIdForLog is only
 * for identifiers that are intrinsically PUBLIC chain/git data.
 */
export function publicIdForLog(value: unknown, kind: PublicIdKind): string {
  if (typeof value !== "string" || value.length === 0) return "(none)";
  if (!PUBLIC_ID_SHAPES[kind].test(value)) return "(invalid)";
  return PUBLIC_ID_RULE === "verbatim" ? value : fingerprint(value);
}

/**
 * "configured" if an env-derived value (or any other value that must never
 * itself reach a log — a CLI-supplied path, a bash env var) is a non-empty
 * string, else "missing". NEVER the value itself. Never throws.
 */
export function envPresence(value: unknown): "configured" | "missing" {
  return typeof value === "string" && value.length > 0 ? "configured" : "missing";
}

/** A plain decimal-number string: digits, at most one decimal point, an optional leading "-". Nothing else matches — not a key, a token, or a JWT, all of which require characters outside [0-9.-]. */
const DECIMAL_RE = /^-?\d{1,32}(\.\d{1,32})?$/;

/**
 * A locally-FORMATTED decimal amount (as produced by viem's formatEther /
 * formatUnits — never a raw dependency string) safe to log as-is; anything
 * else → fallback. Deliberately narrow, unlike the broader "looks like an
 * id" shape round 4 rejected: this shape cannot coincide with any
 * credential shape this codebase redacts.
 */
export function safeLogDecimal(value: unknown, fallback = "(none)"): string {
  return typeof value === "string" && DECIMAL_RE.test(value) ? value : fallback;
}

/**
 * The current time as an ISO-8601 string. Always locally generated
 * (`new Date().toISOString()`) — never externally supplied — provided so a
 * call site doesn't need a bare `new Date()...` expression at a log hole
 * (the AST sink guard requires every hole to be a call to one of this
 * module's exports; a zero-argument local clock read is unconditionally
 * safe).
 */
export function nowIso(): string {
  return new Date().toISOString();
}

// ── FC-8 round 5b (steward ruling #6712, DECISIONS 00:53) ──────────────────
//
// Round 5's default (PUBLIC_ID_RULE = "fingerprint") hid every chain value
// publicIdForLog touched — including a genuine, publicly-visible tx hash or
// address, which is not a secret and is exactly what an operator reading a
// report needs to look an execution up on a block explorer. The steward's
// ruling, verbatim: "Chain values: shape-validated tx hashes and addresses
// print VERBATIM via a typed publicChainRef in the REPORT/stdout sinks
// only, never in third-party bodies." Concretely:
//   - publicChainRef is a NEW, separate function — not a PUBLIC_ID_RULE
//     flip on publicIdForLog. A shape-valid tx hash, address, or event
//     topic is ALWAYS verbatim here, by design; there is no fingerprint
//     mode and nothing to flip later.
//   - git/GitHub identifiers (commit SHAs, run ids) are NOT chain values —
//     they keep publicIdForLog, fingerprinted, unchanged.
//   - a SHAPE check is still not a CONTENT check (the exact defect
//     publicIdForLog itself was built to close for gateway-issued ids), so
//     publicChainRef carries the same risk a dependency-controlled,
//     hex-shaped secret could satisfy its shape gate too. The ruling
//     accepts that risk ONLY for the sinks an AST guard can audit every
//     call site of (stdout/stderr/the report file) — never inside an
//     expression that builds a request body, where that same risk would
//     reach a THIRD PARTY (e.g. the printer) instead of an operator's own
//     terminal/report. findPublicChainRefOutsideSinks (support/
//     fc8-round5-ast-guard.ts) enforces the call-site restriction
//     statically; the per-script dynamic canary tests prove it behaviorally.

/** The shape each PublicChainRefKind must satisfy before it is printed at all. "tx" and "topic" share a shape (both are 32-byte chain values) but are named separately so a call site documents which it means. */
export type PublicChainRefKind = "tx" | "address" | "topic";

const CHAIN_REF_SHAPES: Record<PublicChainRefKind, RegExp> = {
  tx: /^0x[0-9a-fA-F]{64}$/, // a 32-byte transaction hash
  topic: /^0x[0-9a-fA-F]{64}$/, // a 32-byte event-log topic
  address: /^0x[0-9a-fA-F]{40}$/, // a 20-byte chain address
};

/**
 * The ONE function for printing a PUBLIC chain value — a transaction hash,
 * an address, or an event-log topic — VERBATIM, per the steward's ruling
 * (#6712). Shape-validates `value` against `kind` first; anything that
 * fails that check (including a missing/non-string value — there is no
 * separate "(none)" state here, unlike publicIdForLog) prints "(invalid)"
 * rather than whatever it actually was, so a secret mis-shaped for the
 * kind it is logged as is never printed either. Never throws.
 *
 * Distinct from publicIdForLog (git/GitHub ids — fingerprint, no verbatim
 * mode, ever) and from safeLogId/safeLogHex (gateway-issued opaque ids —
 * same). Callers MUST only reach this from a stdout/stderr/report sink —
 * never from an expression that builds a request body (findPublicChainRefOutsideSinks
 * enforces this statically; see fc8-round5-ast-guard.ts).
 */
export function publicChainRef(value: unknown, kind: PublicChainRefKind): string {
  if (typeof value !== "string") return "(invalid)";
  return CHAIN_REF_SHAPES[kind].test(value) ? value : "(invalid)";
}

/**
 * Scrubs every shape-valid chain value (`0x` + exactly 40 or 64 hex
 * characters) out of already-rendered free text, replacing each with its
 * publicIdForLog fingerprint. For the one case where the SAME text that is
 * safe verbatim on stdout/in the report is ALSO reused as a THIRD-PARTY
 * request body — real-e2e-verbose.ts/real-e2e.ts both submit their
 * entire accumulated stdout log as a print job's `parameters.content` —
 * so the ruling's allowed sink and the ruling's forbidden destination
 * would otherwise be the exact same string. 64-hex runs are scrubbed
 * before 40-hex ones, each with a trailing-hex-character boundary check
 * (`(?![0-9a-fA-F])`), so a hash is never left partially matched or
 * mis-split into an address-shaped remainder; the literal `0x` anchor
 * means a run longer than 64 hex characters (which publicChainRef itself
 * would never have printed verbatim in the first place — anything but
 * exactly 40 or 64 chars is "(invalid)") is deliberately left alone rather
 * than guessed at. Never throws; a non-string input returns "".
 */
export function redactChainValuesFromText(text: unknown): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, (m) => publicIdForLog(m, "hash"))
    .replace(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g, (m) => publicIdForLog(m, "address"));
}
