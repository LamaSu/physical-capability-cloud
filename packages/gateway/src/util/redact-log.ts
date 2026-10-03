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
// projection — an id-shaped string, a class-name-shaped error label, or a
// parsed-and-redacted JSON body — and a static fallback otherwise. Never an
// arbitrary body, error message, or stack.

/** A short, class-name-shaped label (e.g. "TypeError", "HttpRequestError"). */
const ERROR_NAME_RE = /^[A-Z][A-Za-z0-9]{0,63}$/;

/** A short, bounded identifier: letters, digits, `_`, `.`, `-`. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

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

/**
 * A value safe to log as an id: only when it already looks like one (short,
 * identifier-shaped). Anything else — including a free-text error message a
 * caller might otherwise have printed via `id ?? error` — becomes
 * `fallback`. Never throws.
 */
export function safeLogId(value: unknown, fallback = "(none)"): string {
  return typeof value === "string" && ID_RE.test(value) ? value : fallback;
}

// ── FC-8 round 3 (astra pack 61b, census closure) ───────────────────────────
//
// Round 2 closed the three CRITICAL summary rows. Astra's full census lists
// many more sites across the same scripts where a gateway/oracle-derived
// value reaches a print statement unvalidated — not necessarily secret-shaped,
// but also never checked, so the scripts "cannot support an ANY-value-ANY-path
// confidentiality guarantee" (the verdict's own words). These five helpers
// give every remaining site a VALIDATED, narrow type to log instead of the
// raw value: an integer (status codes, sizes, counts, block numbers), a
// boolean, a short allow-listed enum (job status, content-type), a bounded
// hex string (tx hashes, signatures — a bounded prefix only), or a URL path
// restricted to URL-safe identifier characters. Anything that doesn't fit
// becomes a fixed fallback — never the raw value.

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

/** A string safe to log only if it exactly matches one of `allowed`. */
export function safeLogEnum(value: unknown, allowed: readonly string[], fallback = "(unknown)"): string {
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

/** A `0x`-hex string (tx hash, signature) safe to log as a bounded prefix; anything else → fallback. */
export function safeLogHex(value: unknown, maxChars = 20, fallback = "(none)"): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) return fallback;
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

/** A URL path safe to log: only URL-safe identifier characters, no spaces/quotes (where a secret would have to sit). */
export function safeLogUrlPath(value: unknown, fallback = "(path withheld)"): string {
  return typeof value === "string" && /^[A-Za-z0-9/_.\-?=&%:]{1,256}$/.test(value) ? value : fallback;
}

/** Each element of `value` run through safeLogId and comma-joined; non-arrays/non-strings → fallback. */
export function safeLogIdList(value: unknown, fallback = "(unknown)"): string {
  if (!Array.isArray(value)) return fallback;
  return value.slice(0, 20).map((v) => safeLogId(v, "?")).join(", ");
}
