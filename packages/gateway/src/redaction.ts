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

// ── Structured redaction (onboard-chat secret exposure, bus #2288 / board N9) ──
//
// redactSecrets() above scrubs FREE TEXT. redactSecretsDeep() walks a JSON-shaped
// value (a tool result, a message history) and applies two rules:
//   1. secret-field: the value under a secret-NAMED key is replaced wholesale,
//      whatever its shape (an `api_key` string, an `authorization` object, ...);
//   2. secret-shaped: every string anywhere goes through redactSecrets() above.
// Fail closed: a cycle or a subtree deeper than MAX_DEPTH is replaced, not walked.

/** Marker for a value removed because of its key name. */
export const REDACTED_VALUE = "[REDACTED]";

/** Exact secret field names (WP-D D1). */
const SECRET_FIELD_EXACT =
  /^(api_?key|apikey|raw_?key|private_?key|privatekey|secret|client_?secret|access_?token|refresh_?token|id_?token|token|password|passphrase|mnemonic|seed|authorization|cookie)$/i;
/**
 * Compound names that END in a secret noun (`operatorWalletPrivateKey`,
 * `webhookSecret`, `sessionToken`). Deliberately narrower than "ends in key/token",
 * so `publicKey`, `idempotencyKey` and `paymentToken` are left alone.
 */
const SECRET_FIELD_SUFFIX =
  /(private_?key|api_?key|secret|password|passphrase|mnemonic|access_?token|refresh_?token|id_?token|session_?token|auth_?token|bearer_?token)$/i;

const MAX_DEPTH = 64;

export type RedactionKind = "secret-field" | "secret-shaped";

/** One removed value, reported to the optional onRedact callback. */
export interface Redaction {
  /** JSONPath-like location, e.g. `$.usage.header` or `$[2].content`. */
  path: string;
  kind: RedactionKind;
  /** The removed secret itself (a field value, or one secret-shaped substring). */
  value: string;
}

/** True when a key's value must be treated as a secret regardless of its shape. */
export function isSecretFieldName(key: string): boolean {
  return SECRET_FIELD_EXACT.test(key) || SECRET_FIELD_SUFFIX.test(key);
}

/** The secret-shaped substrings redactSecrets() would remove, normalized (no `Bearer ` prefix). */
function secretShapedMatches(s: string): string[] {
  const found: string[] = [];
  for (const [re] of PATTERNS) {
    for (const m of s.matchAll(re)) found.push(m[0].replace(/^Bearer\s+/i, ""));
  }
  return found;
}

/**
 * Return a deep copy of `value` with every secret removed. The input is never
 * mutated. `onRedact` receives each removed value (for a one-time reveal to the
 * user who caused it); it is not called for values that are already redacted, so
 * running this twice is a no-op.
 */
export function redactSecretsDeep<T>(value: T, onRedact?: (r: Redaction) => void): T {
  const onPath = new WeakSet<object>();
  const walk = (v: unknown, path: string, depth: number): unknown => {
    if (typeof v === "string") {
      const out = redactSecrets(v);
      if (out !== v && onRedact) {
        for (const m of secretShapedMatches(v)) onRedact({ path, kind: "secret-shaped", value: m });
      }
      return out;
    }
    if (v === null || typeof v !== "object") return v;
    if (depth >= MAX_DEPTH || onPath.has(v)) return REDACTED_VALUE;
    onPath.add(v);
    let out: unknown;
    if (Array.isArray(v)) {
      out = v.map((item, i) => walk(item, `${path}[${i}]`, depth + 1));
    } else {
      const obj: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        const p = `${path}.${k}`;
        const isEmpty = item === null || item === undefined || item === "" || typeof item === "boolean";
        if (isSecretFieldName(k) && !isEmpty) {
          if (item === REDACTED_VALUE) {
            obj[k] = item;
          } else {
            onRedact?.({ path: p, kind: "secret-field", value: typeof item === "string" ? item : JSON.stringify(item) });
            obj[k] = REDACTED_VALUE;
          }
        } else {
          obj[k] = walk(item, p, depth + 1);
        }
      }
      out = obj;
    }
    onPath.delete(v);
    return out;
  };
  return walk(value, "$", 0) as T;
}
