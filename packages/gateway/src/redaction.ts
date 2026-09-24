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

// ── Structured redaction for the onboarding chat (WP-D D1; bus #2288, board N9) ──
//
// redactSecrets() above scrubs FREE TEXT for the feedback sink and keeps its own
// markers (pinned by redaction.test.ts). redactSecretsDeep() below walks a
// JSON-shaped value (a tool result, a message history, an error string) and
// replaces every secret it finds with REDACTED_VALUE:
//   1. secret-field: the value under a secret-NAMED key is replaced whole,
//      whatever its shape (an `api_key` string, an `authorization` object, ...);
//   2. secret-shaped: credential-shaped substrings of every string, and of every
//      object KEY, are replaced (the shapes above, plus PEM and Ed25519 PKCS#8
//      private keys, pcc_oracle_ keys and payment-provider secrets);
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
// /api/auth/provision), `x-api-key`, `set-cookie`, `webhookSecret` and
// `operatorWalletPrivateKey` are caught, while `publicKey`, `apiKeyId`,
// `keyPrefix`, `idempotencyKey` and `maxTokens` are not.
/** A name CONTAINING one of these is a secret field. */
const SECRET_NAME_PARTS = ["privatekey", "secret", "password", "passphrase", "mnemonic", "seedphrase", "recoveryphrase"];
/** A name ENDING in one of these is a secret field. */
const SECRET_NAME_SUFFIXES = [
  "apikey", "rawkey", "privkey", "signingkey", "hmackey", "encryptionkey", "masterkey", "accesskey",
  "token", "cookie", "authorization",
];
/** Whole names outside the spec list that are secret fields on their own. */
const SECRET_NAMES = new Set(["credential", "credentials", "cookies", "jwt", "bearer"]);

/** True when a key's value must be treated as a secret, whatever its shape. */
export function isSecretFieldName(key: string): boolean {
  if (SPEC_SECRET_FIELD_RE.test(key)) return true;
  const n = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!n) return false;
  return (
    SECRET_NAMES.has(n) ||
    SECRET_NAME_PARTS.some((p) => n.includes(p)) ||
    SECRET_NAME_SUFFIXES.some((s) => n.endsWith(s))
  );
}

/**
 * Credential SHAPES for the deep walk, applied in this order: PEM blocks, then
 * the feedback-sink shapes above (Bearer first, so `Bearer pcc_live_…` is removed
 * as ONE secret), then shapes only the chat needs. A 64-hex value is removed
 * whether it is a private key or a public digest: the two look the same.
 */
const DEEP_SHAPES: RegExp[] = [
  // PEM private key block of any type (RSA, EC, OPENSSH, ENCRYPTED, PKCS#8). A block
  // with no END line is removed to the end of the string.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  // Bearer, pcc_live_/pcc_test_, JWT, 64-hex with or without 0x, vendor keys.
  ...PATTERNS.map(([re]) => re),
  new RegExp(`${NLB}pcc_oracle_[A-Za-z0-9_-]{6,}`, "g"),
  // Ed25519 PKCS#8 DER private key, base64: what /api/auth/provision mints as
  // ed25519.private_key_pkcs8_base64. Its first 16 DER bytes are fixed.
  /(?<![A-Za-z0-9+/])MC4CAQAwBQYDK2VwBCIEI[A-Za-z0-9+/]{40,}={0,2}/g,
  // Payment-provider secrets: Stripe-style secret/restricted keys, webhook signing secrets.
  new RegExp(`${NLB}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}`, "g"),
  new RegExp(`${NLB}whsec_[A-Za-z0-9+/=]{10,}`, "g"),
];

/** Replace every credential-shaped substring of `s`, reporting each secret removed. */
function scrubShapes(s: string, report: (secret: string) => void): string {
  let out = s;
  for (const re of DEEP_SHAPES) {
    out = out.replace(re, (m: string) => {
      const scheme = /^Bearer\s+/i.exec(m);
      if (scheme) {
        report(m.slice(scheme[0].length));
        return `${m.slice(0, 6)} ${REDACTED_VALUE}`; // keeps the caller's "Bearer"
      }
      report(m);
      return REDACTED_VALUE;
    });
  }
  return out;
}

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

/** A string holding a JSON object or array, parsed; undefined for anything else. */
function parseEmbeddedJson(s: string): object | undefined {
  const t = s.trimStart();
  if (t[0] !== "{" && t[0] !== "[") return undefined;
  try {
    const v: unknown = JSON.parse(s);
    return v !== null && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Own-property write that also works for a `__proto__` key from JSON.parse. */
function define(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Return a deep copy of `value` with every secret replaced by REDACTED_VALUE. The
 * input is never mutated. `onRedact` receives each removed secret (for a one-time
 * reveal to the caller whose own request produced it). Values that are already
 * redacted are not reported, so a second pass changes and reports nothing.
 */
export function redactSecretsDeep<T>(value: T, onRedact?: (r: Redaction) => void): T {
  const onPath = new WeakSet<object>();
  let changes = 0; // every replacement, reported or not (cycle and depth cuts too)
  const report = (r: Redaction) => {
    changes += 1;
    onRedact?.(r);
  };

  const walkString = (s: string, path: string, depth: number): string => {
    const embedded = depth < MAX_DEPTH ? parseEmbeddedJson(s) : undefined;
    if (embedded !== undefined) {
      const before = changes;
      const walked = walk(embedded, `${path}<json>`, depth + 1);
      return changes === before ? s : JSON.stringify(walked);
    }
    return scrubShapes(s, (secret) => report({ path, kind: "secret-shaped", value: secret }));
  };

  const walk = (v: unknown, path: string, depth: number): unknown => {
    if (typeof v === "string") return walkString(v, path, depth);
    if (v === null || typeof v !== "object") return v;
    if (depth >= MAX_DEPTH || onPath.has(v)) {
      changes += 1;
      return REDACTED_VALUE;
    }
    onPath.add(v);
    let out: unknown;
    if (Array.isArray(v)) {
      out = v.map((item, i) => walk(item, `${path}[${i}]`, depth + 1));
    } else {
      const obj: Record<string, unknown> = {};
      for (const [rawKey, item] of Object.entries(v as Record<string, unknown>)) {
        // A key can itself be a secret (a map keyed by token): scrub it, keep keys unique.
        let key = scrubShapes(rawKey, (secret) => report({ path: `${path}.<key>`, kind: "secret-shaped", value: secret }));
        for (let n = 2; Object.prototype.hasOwnProperty.call(obj, key); n += 1) key = `${key.replace(/#\d+$/, "")}#${n}`;
        const p = `${path}.${key}`;
        if (isSecretFieldName(rawKey) && !isEmptySecretSlot(item)) {
          if (item === REDACTED_VALUE) {
            // already redacted: nothing changes, nothing to reveal
          } else if (typeof item === "string" && item.includes(REDACTED_VALUE)) {
            changes += 1; // e.g. "Bearer [REDACTED]": rewritten whole, nothing left to reveal
          } else {
            report({ path: p, kind: "secret-field", value: secretText(item) });
          }
          define(obj, key, REDACTED_VALUE);
        } else {
          define(obj, key, walk(item, p, depth + 1));
        }
      }
      out = obj;
    }
    onPath.delete(v);
    return out;
  };

  return walk(value, "$", 0) as T;
}
