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

/** A short, class-name-shaped label (e.g. "TypeError", "HttpRequestError"). */
const ERROR_NAME_RE = /^[A-Z][A-Za-z0-9]{0,63}$/;

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

/**
 * A bounded, validated label safe to log for a thrown value: only `.name`
 * (a short, class-name-shaped identifier), and only when it actually looks
 * like one. `.message` and `.stack` are free text — exactly where a caught
 * secret (e.g. a header value embedded in a fetch/dependency error) ends up
 * — so this never reads them, and a hostile `.name` that isn't
 * identifier-shaped (whatever characters it uses) falls back to "Error".
 * Never throws.
 */
export function safeLogErrorName(e: unknown): string {
  const name = e && typeof e === "object" && "name" in e ? (e as { name?: unknown }).name : undefined;
  return typeof name === "string" && ERROR_NAME_RE.test(name) ? name : "Error";
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

/** An integer (number or bigint) safe to log as-is; anything else → fallback. */
export function safeLogInt(value: unknown, fallback = "(none)"): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return String(value);
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
