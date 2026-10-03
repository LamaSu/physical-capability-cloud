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
