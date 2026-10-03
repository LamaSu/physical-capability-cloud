/**
 * The hosted agent's tools are the pinned package's tools, called through the
 * gateway's MCP server AS THE USER.
 *
 * A signed-in session sends the user's own Bearer key to /mcp. A keyless
 * session sends no credential, to the read-only /mcp/apps. The key lives only
 * in this session's transport: it is never logged, never shown to the model,
 * and never put in a report. Every tool result, and every tool ERROR, is
 * scrubbed of secret-shaped values before the model sees it, because whatever
 * the model sees can reach the transcript. A raw transport error never leaves
 * this module: what is thrown is a fresh, scrubbed, bounded Error.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { GatedTool } from "./confirm.js";
import type { PinnedPack } from "./pack.js";

export interface ToolTransport {
  /** The version the server announced when the session was opened. The gateway
   * reports `<pack version>+sha256.<hex of the exact pack bytes>`, which is how
   * a session proves it runs the pinned pack. Undefined when it announced none. */
  serverVersion(): string | undefined;
  /** The tool names the connected surface serves (/mcp/apps serves a read-only subset). */
  listTools(): Promise<string[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** JSON field names whose values are secrets, whatever they contain. A name is
 * compared in lower case with `_` and `-` removed, so token, accessToken,
 * access_token and access-token are one name. Only WHOLE names match:
 * max_tokens, tokenCount and secretary are kept.
 *
 * R1-e (round 3): also passwd, pwd, secretkey, secretaccesskey (so
 * aws_secret_access_key= is covered), apisecret, appsecret. Deliberately NOT
 * added: session / sessionid (the agent must keep seeing negotiation session
 * ids) and pass (too common in benign text — "pass: 5" is a score, not a
 * credential). */
const SECRET_FIELDS: ReadonlySet<string> = new Set([
  "token", "accesstoken", "refreshtoken", "idtoken", "sessiontoken", "authtoken", "bearertoken",
  "apikey", "rawkey", "secret", "clientsecret", "secretkey", "secretaccesskey", "apisecret", "appsecret",
  "password", "passwd", "pwd", "passphrase", "privatekey",
  "mnemonic", "seed", "seedphrase", "bearer", "authorization",
]);

const isSecretField = (name: string): boolean => SECRET_FIELDS.has(name.toLowerCase().replace(/[_ -]/g, ""));

/** Secret-shaped strings. A bare 0x-prefixed 32-byte hex is NOT scrubbed:
 * transaction hashes and evidence digests have that shape, and the agent must
 * be able to show them. */
const SECRET_STRINGS: readonly RegExp[] = [
  /\bpcc_(live|test)_[A-Za-z0-9_-]{8,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // F1-b (round 4, 224a): the END marker is OPTIONAL — `[\s\S]*?` is lazy, so it
  // still finds a REAL END marker when one exists (unchanged behavior), but when
  // one is missing (truncated input, or the cap cut it before applying this
  // pass) this now matches to the end of the bounded input instead of matching
  // nothing at all, which is what let a cap-split key body survive whole.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // A bare JWT (header.payload.signature), wherever it sits: a session token has this shape.
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
];

export const REDACTED = "[redacted]";

/**
 * R5 (round 3 addendum 2): the most of any single string that `scrubText`
 * will scan. `scrubToolResult` otherwise passes a non-JSON text, and every
 * string inside a JSON result, through with no size cap at all — one long
 * attacker-written field blocks the event loop for every session (about 20
 * minutes at 1 MB, by the lane's extrapolation). Cut here, before any
 * scrubbing pass runs, same principle as `toolError`'s 20_000.
 */
export const SCRUB_TEXT_LIMIT = 200_000;
const TRUNCATED_MARKER = "…[truncated]";

/**
 * R5/R6 (round 3 addendum 2): URL userinfo, as a LINEAR scanner — the
 * backtracking regex this replaced was quadratic on adversarial input (20k
 * chars: 441ms; 40k: 1.8s, by the lane's measurement) and missed the
 * empty-username form (`redis://:pw@host`).
 *
 *   - for each `://`, scan the authority up to the first `/`, `?`, `#`,
 *     whitespace or the end;
 *   - if it contains `@`, the userinfo is the text before the LAST `@`
 *     (so a password containing `@` is covered too);
 *   - redact everything after the FIRST `:` in the userinfo (so an empty
 *     username, `:pw@host`, still loses the password).
 *
 * Every step advances monotonically and is bounded by the authority's own
 * length (schemes are capped at 32 chars backward from `://`), so the whole
 * scan is O(n) over the input, not O(n^2).
 */
function redactUrlUserinfo(text: string): string {
  let out = "";
  let cursor = 0;
  const n = text.length;
  let searchFrom = 0;
  const MAX_SCHEME_CHARS = 32;
  for (;;) {
    const schemeEnd = text.indexOf("://", searchFrom);
    if (schemeEnd === -1) break;
    let schemeStart = schemeEnd;
    while (schemeStart > 0 && schemeEnd - schemeStart < MAX_SCHEME_CHARS && /[A-Za-z0-9+.-]/.test(text[schemeStart - 1]!)) schemeStart--;
    if (schemeStart >= schemeEnd || !/[A-Za-z]/.test(text[schemeStart]!)) {
      searchFrom = schemeEnd + 3;
      continue;
    }
    let authorityEnd = schemeEnd + 3;
    while (authorityEnd < n && !/[\s/?#]/.test(text[authorityEnd]!)) authorityEnd++;
    const authority = text.slice(schemeEnd + 3, authorityEnd);
    const lastAt = authority.lastIndexOf("@");
    if (lastAt === -1) {
      searchFrom = authorityEnd;
      continue;
    }
    const userinfo = authority.slice(0, lastAt);
    const firstColon = userinfo.indexOf(":");
    // No password: the whole userinfo is redacted. A token sent as the USERNAME is the common
    // git-over-https form (`https://<token>@github.com/...`); a plain username is a cheap loss.
    const passStart = schemeEnd + 3 + (firstColon === -1 ? 0 : firstColon + 1);
    const passEnd = schemeEnd + 3 + lastAt;
    out += text.slice(cursor, passStart) + REDACTED;
    cursor = passEnd;
    searchFrom = authorityEnd;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * `Cookie:` / `Set-Cookie:` header VALUES. Every `name=value` pair's value is
 * redacted, whatever the name — simpler and at least as safe as trying to
 * recognize which cookie names are sensitive, and the lane's own spec allows
 * it ("attribute names stay readable; redacting their values too is
 * acceptable"). Runs on the header's text value only, up to end of line.
 * Linear: a flat alternation and two single-pass char classes, no nested or
 * ambiguous quantifiers to backtrack.
 */
const COOKIE_HEADER = /\b(Cookie|Set-Cookie)(:\s*)([^\r\n]+)/gi;
const COOKIE_PAIR = /([A-Za-z0-9_-]+)(=)([^;]*)/g;

/** SECRET_FIELDS as literal regex alternatives, longest first (defensive only:
 * a shorter member that happens to prefix a longer one, e.g. "seed" / "seedphrase",
 * is handled correctly either way by backtracking, since a short match that
 * cannot be followed by the separator fails and the engine tries the next
 * alternative at the same position). Every member is plain letters, but the
 * escape is kept so this stays correct if that ever changes.
 *
 * `authorization` is excluded here on purpose: the dedicated AUTH_HEADER_ASSIGNMENT
 * pass below owns that name (and `proxy-authorization`), so its scheme-word rule
 * isn't bypassed by also matching here. `isSecretField`/`scrub` (object-key
 * traversal) still treat `authorization` as secret via the full SECRET_FIELDS set. */
const SECRET_FIELD_ALTERNATION = [...SECRET_FIELDS]
  .filter((n) => n !== "authorization")
  .sort((a, b) => b.length - a.length)
  .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

/**
 * The natural multi-word SEPARATED spellings of a SECRET_FIELDS name that is
 * inherently a qualifier + noun (+ noun) in free text (`access token`,
 * `api key`, `secret access key`, ...). The zero-separator spelling
 * ("accesstoken") is already a literal member of SECRET_FIELDS and so is
 * covered by SECRET_FIELD_ALTERNATION directly.
 *
 * Spelled out as EXPLICIT word sequences — never "any word + any word" — so an
 * unrelated qualifier ("new token: x", "refused: token=x") cannot be greedily
 * absorbed into a non-matching candidate, which would consume those
 * characters and pre-empt the later, narrower match that `token` alone would
 * have won a few characters on.
 */
const COMPOUND_NAME =
  "(?:access|refresh|id|session|auth|bearer)[ _-]token|api[ _-]key|raw[ _-]key|private[ _-]key|seed[ _-]phrase|" +
  "secret[ _-]access[ _-]key|client[ _-]secret|secret[ _-]key|api[ _-]secret|app[ _-]secret";

/** The full name alternative: ONLY a recognized SECRET_FIELDS spelling can
 * start a match — never an arbitrary word — which is what keeps an unrelated
 * word's own stray `:`/`=` (a product name, a URL scheme, "refused:") from
 * being misread as a name and swallowing a real assignment that follows it. */
const ASSIGNMENT_NAME = `(?:${COMPOUND_NAME}|${SECRET_FIELD_ALTERNATION})`;

/**
 * R7 (round 3 addendum 2, regression from 73d1fe20): a QUOTED key (`"k"`,
 * `'k'`, `\"k\"`) has an unambiguous boundary — the closing quote — so unlike
 * a bare key it can safely be GENERIC: any run of up to 64 letters, digits,
 * `_`, `-` or space. `isSecretField` (which strips `_`/`-`/space before
 * comparing) decides whether it names a secret, so `"pass_phrase"`,
 * `"access__token"` and `"Pass-Word"` are covered even though none of those
 * exact spellings appears in ASSIGNMENT_NAME. A BARE key keeps the enumerated
 * alternation (ASSIGNMENT_NAME) — the free-text safety above still applies,
 * since a bare key has no boundary and a generic pattern there would let an
 * unrelated decoy word swallow a real assignment that follows it.
 */
const QUOTED_KEY = "[A-Za-z0-9_ -]{1,64}";

/**
 * R1-a (round 3): a name or value may be bare, `"..."`, `'...'`, or
 * backslash-escaped `\"...\"` (a JSON string pair as it appears when the JSON
 * itself sits inside another string, e.g. an error body that embedded the
 * request). The redaction keeps whichever style was used. The four forms are
 * independent alternatives (not a backreference) so the name's style and the
 * value's style need not match, though every lane probe happens to pair them.
 */
const NAME_PART = `(?:\\\\"(${QUOTED_KEY})\\\\"|"(${QUOTED_KEY})"|'(${QUOTED_KEY})'|(${ASSIGNMENT_NAME}))`;
const SEP_PART = `(\\s*[:=]\\s*)`;

/** R9 (round 3 addendum 2, LOW): never re-redact a value an earlier pass
 * (SECRET_STRINGS, or this module's own bracket pass) already reduced to
 * exactly `[redacted]` — without this, the bare-token alternative below would
 * match the marker's own `[redacted` (its `]` is outside the bare charset,
 * see R8) and wrap it again, producing `[redacted]]`. */
const REDACTED_ESCAPED = REDACTED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NOT_ALREADY_REDACTED = `(?!${REDACTED_ESCAPED})`;

/**
 * The value: escaped-double (runs to the next literal `\"`), double-quoted,
 * single-quoted (each running to its own closing quote, `\\.` escapes inner
 * occurrences), a bare NUMBER (R1-f: a secret-named key may hold a non-string
 * JSON value), or a bare token running to the first whitespace, quote, `&`,
 * `,`, `;`, `)`, `]`, `}` or end. R8: the bare-token alternative must never
 * start matching at `{` or `[` — those are object/array values, handled
 * wholesale by the bracket scanner below, never picked at one char at a time.
 * This exclusion is also what makes R9's double-bracket bug structurally
 * impossible here: an already-redacted `[redacted]` marker starts with `[`,
 * so the bare-token alternative can never start matching it, and the other
 * four alternatives all require a leading quote or digit that `[` is not. A
 * NOT_ALREADY_REDACTED guard is therefore only needed where a value can start
 * with `{`/`[` structurally regardless of quoting — see BRACKET_TRIGGER.
 *
 * F1-a (round 4, 224a): each quoted alternative's closing delimiter is now
 * `(?:<quote>|\\?$)` — the real quote OR (optionally one dangling backslash,
 * for a value cut mid-escape) then the end of the (already-bounded) input.
 * `scrubText` truncates BEFORE this pattern ever runs, so a value whose real
 * closing quote fell past SCRUB_TEXT_LIMIT looks identical to one that was
 * simply never closed — both now redact from the opening quote through the
 * end of input, rather than failing to match at all and leaving the raw
 * value (minus the first character the content class balked at) exposed.
 * The `$` anchor is unanchored by `m`, so it means end of this whole string,
 * i.e. end of the capped text — exactly the span that must be assumed secret.
 */
const VALUE_PART =
  '(?:\\\\"((?:(?!\\\\").)*)(?:\\\\"|\\\\?$)' +
  '|"((?:[^"\\\\]|\\\\.)*)(?:"|\\\\?$)' +
  "|'((?:[^'\\\\]|\\\\.)*)(?:'|\\\\?$)" +
  "|(-?\\d+(?:\\.\\d+)?)(?![\\w.])" +
  '|([^\\s"\'\\\\&,;)\\]}{[]+))';

/**
 * `name=value`, `name: value` or `name = "value"` in free text (not itself a
 * JSON string pair with an unescaped quote, which this pattern also now
 * covers directly — see NAME_PART/VALUE_PART): the VALUE of a secret-named
 * ASSIGNMENT. The name is not preceded by a letter or digit (so
 * `max_tokens=100`, `tokenCount=3`, `secretary: Bob` and `sessionId: s-123`
 * are kept — nothing in ASSIGNMENT_NAME can even start a match there, and
 * `session`/`sessionid`/`pass` are deliberately not secret names).
 */
const FREE_TEXT_ASSIGNMENT = new RegExp(`(?<![A-Za-z0-9])${NAME_PART}${SEP_PART}${VALUE_PART}`, "gi");

/** Re-wraps a redacted value in whichever quote style (if any) the match used. */
function wrapRedacted(vEsc: string | undefined, vDq: string | undefined, vSq: string | undefined, vNum: string | undefined): string {
  if (vEsc !== undefined) return `\\"${REDACTED}\\"`;
  if (vDq !== undefined) return `"${REDACTED}"`;
  if (vSq !== undefined) return `'${REDACTED}'`;
  if (vNum !== undefined) return `"${REDACTED}"`; // R1-f: a number value becomes a quoted redaction marker
  return REDACTED;
}

function redactAssignmentValue(
  nameEsc: string | undefined,
  nameDq: string | undefined,
  nameSq: string | undefined,
  nameBare: string | undefined,
  sep: string,
  vEsc: string | undefined,
  vDq: string | undefined,
  vSq: string | undefined,
  vNum: string | undefined,
  whole: string,
): string {
  const name = nameEsc ?? nameDq ?? nameSq ?? nameBare ?? "";
  if (!isSecretField(name)) return whole;
  const keyText = nameEsc !== undefined ? `\\"${nameEsc}\\"` : nameDq !== undefined ? `"${nameDq}"` : nameSq !== undefined ? `'${nameSq}'` : (nameBare as string);
  return `${keyText}${sep}${wrapRedacted(vEsc, vDq, vSq, vNum)}`;
}

/**
 * R1-b (round 3): after `authorization` or `proxy-authorization` specifically,
 * ANY single scheme word (`[A-Za-z][A-Za-z0-9._-]*` then whitespace) stays
 * visible — `Authorization: Token xyz` reads as `Authorization: Token
 * [redacted]`, whatever the scheme word is, not just the fixed
 * Basic/Bearer/Digest set. With no scheme word (one token only), that token
 * IS the value.
 *
 * F2 (round 4, 224a): everything AFTER the scheme word (or, with none, the
 * whole rest of the header) is redacted through the end of the LINE (`\r`,
 * `\n` or end of the bounded input) — not just one VALUE_PART component.
 * Digest (`username="…", realm="…", response="…"`) and AWS4-HMAC-SHA256
 * (`Credential=…, SignedHeaders=…, Signature=…`) carry several
 * comma-separated or quoted credential components; consuming only the first
 * left the rest — including the actual response/signature — exposed. No
 * other name gets this treatment: `token: abc def` still redacts only `abc`,
 * via FREE_TEXT_ASSIGNMENT below, since a non-auth value has no "rest of the
 * credential" to protect.
 */
const AUTH_HEADER_NAME = "(?:proxy[ _-]?authorization|authorization)";
const AUTH_HEADER_ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9])(${AUTH_HEADER_NAME})${SEP_PART}(?:([A-Za-z][A-Za-z0-9._-]*)\\s+)?([^\\r\\n]*)`,
  "gi",
);

function redactAuthHeader(name: string, sep: string, scheme: string | undefined, rest: string): string {
  const lead = scheme ? `${scheme} ` : "";
  // An empty rest (bare "Authorization:" with nothing after) has nothing to redact;
  // this also keeps the replacement a true no-op there, rather than inventing a marker.
  return rest.length === 0 ? `${name}${sep}${lead}` : `${name}${sep}${lead}${REDACTED}`;
}

/**
 * R8 (round 3 addendum 2): a secret-named key whose value starts with `{` or
 * `[` — the bare-token alternative above never starts there, so without this
 * pass the name+sep matched, one bracket character got redacted alone, and
 * the REST of the object/array (including the real secret somewhere inside
 * it) rode along untouched. Matches name+sep with a lookahead for the
 * upcoming bracket (and a guard against an already-redacted marker shaped
 * like `[redacted...`, same reasoning as R9).
 */
const BRACKET_TRIGGER = new RegExp(`(?<![A-Za-z0-9])${NAME_PART}${SEP_PART}(?=[{[])${NOT_ALREADY_REDACTED}`, "gi");

/**
 * Linear, quote-aware bracket matcher: `text[start]` is `{` or `[`. Returns
 * the index AFTER the matching close bracket, or `text.length` if the span
 * never closes (R8: an unterminated span is redacted to the end of the
 * — already capped, see SCRUB_TEXT_LIMIT — text).
 *
 * Tracks depth for the bracket's OWN type only; a different bracket type
 * nested inside (an array inside an object, say) is not itself tracked, but
 * on well-formed input its opens and closes are still balanced before ours
 * closes, so this is correct for valid JSON-shaped input and always
 * terminates (bounded by the text length) on anything else.
 *
 * Quote-aware: a bare `"`/`'` opens a string (closed by the same bare quote;
 * `\` escapes the next character, including a same-type quote, without
 * closing it) so a bracket CHARACTER inside an ordinary string value is never
 * miscounted as structural. ALSO recognizes the backslash-delimited form
 * (`\"...\"`, the escaped-JSON representation this scrubber already supports
 * elsewhere): a string opened by `\"` is closed only by the next `\"`, not by
 * a bare `"`, so the escaped-JSON case nests correctly too.
 */
function findBracketEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let stringQuote: string | null = null;
  let stringEscaped = false;
  const n = text.length;
  for (let i = start; i < n; i++) {
    const c = text[i];
    if (stringQuote !== null) {
      if (c === "\\") {
        if (stringEscaped && text[i + 1] === stringQuote) {
          stringQuote = null;
          i++;
          continue;
        }
        i++; // an ordinary escape within the string's content
        continue;
      }
      if (!stringEscaped && c === stringQuote) stringQuote = null;
      continue;
    }
    if (c === "\\" && (text[i + 1] === '"' || text[i + 1] === "'")) {
      stringQuote = text[i + 1]!;
      stringEscaped = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      stringQuote = c;
      stringEscaped = false;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return n;
}

/** Redacts every secret-named key's bracketed (object/array) value, scanning
 * once through `text` with `BRACKET_TRIGGER` + `findBracketEnd` (both
 * linear), rather than via `.replace()` — the replacement SPAN's length is
 * only known after scanning, which a fixed regex cannot express. */
function redactBracketedValues(text: string): string {
  let out = "";
  let cursor = 0;
  BRACKET_TRIGGER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BRACKET_TRIGGER.exec(text))) {
    if (m.index < cursor) continue; // inside a span already consumed below
    const whole = m[0];
    const name = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
    const bracketStart = m.index + whole.length;
    if (!isSecretField(name)) {
      BRACKET_TRIGGER.lastIndex = bracketStart; // not this key's value; keep scanning from here
      continue;
    }
    const bracketEnd = findBracketEnd(text, bracketStart);
    // Keep the quoting of the key's own form: an escaped key (`\"token\"`) sits inside a string,
    // where a bare quote would end that string.
    const q = m[1] !== undefined ? '\\"' : '"';
    out += text.slice(cursor, m.index) + whole + `${q}${REDACTED}${q}`;
    cursor = bracketEnd;
    BRACKET_TRIGGER.lastIndex = bracketEnd;
  }
  out += text.slice(cursor);
  return out;
}

export function scrubText(text: string): string {
  const bounded = text.length > SCRUB_TEXT_LIMIT ? `${text.slice(0, SCRUB_TEXT_LIMIT)}${TRUNCATED_MARKER}` : text;
  const shapes = SECRET_STRINGS.reduce((t, re) => t.replace(re, REDACTED), bounded);
  const noUserinfo = redactUrlUserinfo(shapes);
  const noCookies = noUserinfo.replace(COOKIE_HEADER, (_whole, header: string, sep: string, rest: string) => {
    const redactedRest = rest.replace(COOKIE_PAIR, (_m, n: string, eq: string) => `${n}${eq}${REDACTED}`);
    return `${header}${sep}${redactedRest}`;
  });
  const noAuthHeaders = noCookies.replace(
    AUTH_HEADER_ASSIGNMENT,
    (_whole: string, name: string, sep: string, scheme: string | undefined, rest: string) => redactAuthHeader(name, sep, scheme, rest),
  );
  const noBrackets = redactBracketedValues(noAuthHeaders);
  return noBrackets.replace(
    FREE_TEXT_ASSIGNMENT,
    (
      whole: string,
      nameEsc: string | undefined,
      nameDq: string | undefined,
      nameSq: string | undefined,
      nameBare: string | undefined,
      sep: string,
      vEsc: string | undefined,
      vDq: string | undefined,
      vSq: string | undefined,
      vNum: string | undefined,
    ) => redactAssignmentValue(nameEsc, nameDq, nameSq, nameBare, sep, vEsc, vDq, vSq, vNum, whole),
  );
}

export function scrub(value: unknown): unknown {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretField(k) ? REDACTED : scrub(v);
    }
    return out;
  }
  return value;
}

/** A tool result's text content, parsed as JSON when it is JSON, and scrubbed. */
export function scrubToolResult(result: { content?: unknown; isError?: unknown }): { isError: boolean; value: unknown } {
  const parts = Array.isArray(result.content) ? result.content : [];
  const texts = parts
    .filter((p): p is { type: "text"; text: string } => typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text")
    .map((p) => p.text);
  const values = texts.map((t) => {
    try {
      return scrub(JSON.parse(t));
    } catch {
      return scrubText(t);
    }
  });
  return { isError: result.isError === true, value: values.length === 1 ? values[0] : values };
}

/** The most of a tool's error message the model is shown: enough to act on, never a whole response body. */
export const TOOL_ERROR_LIMIT = 2_000;

/**
 * A tool failure as the model may see it: the message scrubbed with the same
 * rules as a tool result, then bounded. It is a FRESH Error: no `cause`, none
 * of the transport's own fields, so nothing raw reaches LLMAgent.
 */
export function toolError(err: unknown): Error {
  const message =
    typeof err === "string"
      ? err
      : err !== null && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : "the tool call failed";
  // Cap the work first, scrub, then cap what is shown: a secret the first cap cut in two is dropped by the last.
  const scrubbed = scrubText(message.slice(0, 20_000));
  return new Error(scrubbed.length > TOOL_ERROR_LIMIT ? `${scrubbed.slice(0, TOOL_ERROR_LIMIT)}…` : scrubbed);
}

/** Run a transport step; whatever it throws leaves as a scrubbed, bounded Error. */
async function sanitized<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw toolError(err);
  }
}

/** Connect to the gateway's MCP server as the user: /mcp with their key, or /mcp/apps with none. */
export async function connectMcp(gatewayBase: string, credential: string | null): Promise<ToolTransport> {
  const url = new URL(credential === null ? "/mcp/apps" : "/mcp", gatewayBase);
  const headers: Record<string, string> = credential === null ? {} : { authorization: `Bearer ${credential}` };
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  const client = new Client({ name: "pcc-hosted-agent", version: "0.1.0" });
  await sanitized(() => client.connect(transport));
  return {
    serverVersion: () => client.getServerVersion()?.version,
    listTools: () =>
      sanitized(async () => {
        const names: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined);
          names.push(...page.tools.map((t) => t.name));
          cursor = page.nextCursor;
        } while (cursor);
        return names;
      }),
    callTool: (name, args) =>
      sanitized(async () => {
        const result = await client.callTool({ name, arguments: args });
        const { isError, value } = scrubToolResult(result as { content?: unknown; isError?: unknown });
        if (isError) throw new Error(typeof value === "string" ? value : JSON.stringify(value));
        return value;
      }),
    close: () => client.close(),
  };
}

/** The pinned package's tools that the connected surface serves, each calling
 * through the session's transport. Whatever the transport returns or throws is
 * scrubbed here as well, so a transport that does not scrub (an injected one)
 * still cannot put a secret in front of the model or the confirming user. */
export function packTools(pack: PinnedPack, transport: ToolTransport, served: ReadonlySet<string>): GatedTool[] {
  return pack.tools.filter(({ def }) => served.has(def.name)).map(({ def, spec }) => ({
    def,
    spec,
    caller: async (input: unknown) => {
      try {
        return scrub(await transport.callTool(def.name, input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {}));
      } catch (err) {
        throw toolError(err);
      }
    },
  }));
}
