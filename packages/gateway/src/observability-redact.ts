/**
 * One redaction for every observability sink (cross-family reviews r3 to r5 of #441): Sentry error
 * events, transactions, spans and breadcrumbs, the Fastify request log, the audit log's request URL
 * and every PostHog event. Each sink sends its WHOLE record through here. The rule is VALUE-FREE by
 * default (the PR steward's rule for round 6): no name list decides what a sink keeps.
 *
 *   - URLs. In every string, every URL-like token (a URL, a path, or a bare query or fragment) keeps
 *     its path and its parameter NAMES, and drops every query and fragment VALUE, whatever the name.
 *     An encoded separator (%3F, %23, %26, %3D) counts as the separator.
 *   - Form-encoded strings (a query string, a form body) drop every value.
 *   - Bodies. A request body (Sentry's request.data, any "body" field) and Sentry's request cookies
 *     are dropped whole. The SDK is also told not to collect them (sentry.ts).
 *   - Headers. Anywhere a value sits under a key named "headers", and in every span attribute
 *     http.request.header.* or http.response.header.*, a header keeps its value only when its name is
 *     on SAFE_HEADERS: the allowlist decides.
 *   - A second line, for prose: a key, or a name=value pair in text, whose name is credential-like
 *     has its value redacted too. Nothing above depends on it.
 *   - A string that holds a JSON object or array is parsed, redacted the same way, and written back.
 * Nothing is changed in place: a record is copied as it is redacted, so an object the application
 * still holds (a console breadcrumb's arguments) is never altered.
 */

export const REDACTED = "[redacted]";

/**
 * Names whose values are credentials or session secrets: the SDK's own list for span attributes
 * (@sentry/core utils/request.js SENSITIVE_HEADER_SNIPPETS), with signature, sig and hmac added. It
 * is not what protects headers: SAFE_HEADERS is.
 */
const CREDENTIAL_NAME = /auth|token|secret|session|password|passwd|pwd|key|jwt|bearer|sso|saml|csrf|xsrf|credential|cookie|signature|sig|hmac/i;

/** The headers an observability record may carry with their values. Every other header is redacted. */
const SAFE_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "host",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "origin",
  "pragma",
  "referer",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sentry-trace",
  "traceparent",
  "tracestate",
  "user-agent",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-pcc-trace-id",
  "x-request-id",
]);

const HEADERS_KEY = /^headers$/i;
/** A request body under any of the names records give it: dropped whole, whatever it holds. */
const BODY_KEY = /^(?:body|raw_?body|req_?body|request_?body)$/i;
/** Under a Sentry event's `request`: the body and the cookies, dropped whole. */
const REQUEST_DROPPED: ReadonlySet<string> = new Set(["data", "cookies"]);
const HEADER_ATTRIBUTE = /^http\.(?:request|response)\.header\.(.+)$/i;
const QUERY_STRING_KEY = /^query_string$/i;
/** The SDK's own processing state: read after beforeSend to build the envelope, never sent as event data. */
const UNTOUCHED_KEYS: ReadonlySet<string> = new Set(["sdkProcessingMetadata"]);
/** Deeper than this, a value is redacted whole rather than left unread. */
const MAX_DEPTH = 32;
/** A JSON string longer than this is not parsed; its parameters are still redacted. */
const MAX_JSON_STRING = 256 * 1024;

/** A query, fragment or form parameter: its separator (or the start), its name, and its value. */
const PARAM = /(^|[?&;#\s])([^=&;#?\s]+)=([^&;#\s]*)/g;
/** A token of text up to whitespace or a quote: a candidate URL. */
const TOKEN = /[^\s"'`<>\\]+/g;
/** A token that is a URL: a scheme, a path from the root, or a bare query or fragment. */
const URL_START = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/|[?#])/i;
/** A whole string that is form-encoded: name=value pairs joined by "&", nothing else. */
const FORM = /^[^\s=&?#]+=[^\s&]*(?:&[^\s=&?#]*(?:=[^\s&]*)?)*$/;
/**
 * An encoded separator counts as the separator (cross-family review r6 of #441, MEDIUM 3): %3F and
 * %23 start a query or fragment, and %26 and %3D split its pairs, in any case. So
 * "/cb%3Fzq1%3D..." drops its value as "/cb?zq1=..." does. Where a rule reads separators, it reads
 * them decoded, and its output shows them decoded.
 */
const ENCODED_SEPARATOR = /%(3f|23|26|3d)/gi;
const SEPARATORS: Readonly<Record<string, string>> = { "3f": "?", "23": "#", "26": "&", "3d": "=" };
const decodeSeparators = (text: string) => text.replace(ENCODED_SEPARATOR, (_match, hex: string) => SEPARATORS[hex.toLowerCase()]!);

const decodedName = (name: string) => {
  try {
    return decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return name; // an undecodable name is judged as written
  }
};

const isSafeHeader = (name: string) => SAFE_HEADERS.has(name.trim().toLowerCase().replace(/_/g, "-"));

/** A URL, a query string or any text, with the value of every credential-named parameter redacted. */
export function redactUrl(text: string): string {
  return text.replace(PARAM, (match, separator: string, name: string) =>
    CREDENTIAL_NAME.test(decodedName(name)) ? `${separator}${name}=${REDACTED}` : match,
  );
}

/** Every value of a query, fragment or form dropped, whatever its name: the names stay. */
function dropValues(params: string): string {
  return params
    .split("&")
    .map((pair) => {
      if (pair === "") return pair;
      const eq = pair.indexOf("=");
      return eq === -1 ? REDACTED : `${pair.slice(0, eq)}=${REDACTED}`; // a bare value has no name to keep
    })
    .join("&");
}

/**
 * A URL with the value of every query and fragment parameter dropped, whatever its name: the path
 * and the parameter names stay. A fragment is treated as a query (an OAuth implicit grant puts its
 * token there), and a URL with a fragment and no query is covered too.
 */
export function withoutQueryValues(raw: string): string {
  const url = decodeSeparators(raw);
  const cut = url.search(/[?#]/);
  if (cut === -1) return raw;
  const hash = url.indexOf("#", cut);
  let out = url.slice(0, cut);
  if (url[cut] === "?") out += `?${dropValues(url.slice(cut + 1, hash === -1 ? undefined : hash))}`;
  if (hash !== -1) out += `#${dropValues(url.slice(hash + 1))}`;
  return out;
}

/** Text with every URL-like token's query and fragment values dropped; a form-encoded string drops every value. */
function withoutUrlValues(text: string): string {
  const whole = decodeSeparators(text.trim());
  if (FORM.test(whole)) return dropValues(whole);
  return text.replace(TOKEN, (raw) => {
    const token = decodeSeparators(raw);
    const cut = token.search(/[?#]/);
    if (cut === -1) return raw;
    // A URL, or any token whose query or fragment holds a name=value pair ("callback?code=...").
    return URL_START.test(token) || token.slice(cut).includes("=") ? withoutQueryValues(token) : raw;
  });
}

function redactString(text: string, depth: number, onPath: WeakSet<object>): string {
  const head = text.trimStart()[0];
  if ((head === "{" || head === "[") && text.length <= MAX_JSON_STRING) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined; // not JSON: a plain string
    }
    if (parsed !== undefined) return JSON.stringify(redactValue(parsed, undefined, depth + 1, onPath));
  }
  return redactUrl(withoutUrlValues(text));
}

/** Headers in any shape a record carries them: an object, [name, value] pairs, or raw header lines. */
function redactHeaders(value: unknown, depth: number, onPath: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return value
      .split(/(\r?\n)/)
      .map((line) => {
        const colon = line.indexOf(":");
        return colon === -1 || isSafeHeader(line.slice(0, colon)) ? line : `${line.slice(0, colon)}: ${REDACTED}`;
      })
      .join("");
  }
  if (Array.isArray(value)) {
    return value.map((pair) =>
      Array.isArray(pair) && typeof pair[0] === "string"
        ? isSafeHeader(pair[0])
          ? redactValue(pair, undefined, depth + 1, onPath)
          : [pair[0], REDACTED]
        : REDACTED,
    );
  }
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    out[name] = isSafeHeader(name) ? redactValue(headerValue, name, depth + 1, onPath) : REDACTED;
  }
  return out;
}

function redactValue(value: unknown, key: string | undefined, depth: number, onPath: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value, depth, onPath);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  if (depth > MAX_DEPTH || onPath.has(value)) return REDACTED;
  onPath.add(value);
  try {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactString(value.message, depth, onPath),
        ...(value.stack ? { stack: redactString(value.stack, depth, onPath) } : {}),
      };
    }
    if (Array.isArray(value)) return value.map((item) => redactValue(item, undefined, depth + 1, onPath));
    const out: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(value)) {
      const attribute = HEADER_ATTRIBUTE.exec(name);
      if (UNTOUCHED_KEYS.has(name)) out[name] = child;
      else if (BODY_KEY.test(name) || (key === "request" && REQUEST_DROPPED.has(name))) out[name] = child === undefined ? child : REDACTED;
      else if (HEADERS_KEY.test(name)) out[name] = redactHeaders(child, depth + 1, onPath);
      else if (attribute) out[name] = isSafeHeader(attribute[1]!) ? redactValue(child, name, depth + 1, onPath) : REDACTED;
      else if (CREDENTIAL_NAME.test(name)) out[name] = REDACTED;
      else if (QUERY_STRING_KEY.test(name) && child !== null && child !== undefined && typeof child !== "string") out[name] = REDACTED;
      else out[name] = redactValue(child, name, depth + 1, onPath);
    }
    return out;
  } finally {
    onPath.delete(value);
  }
}

/** A copy of a record (a Sentry event, span or breadcrumb, a log object) with every credential redacted. */
export function redactCredentials<T>(record: T): T {
  return redactValue(record, undefined, 0, new WeakSet()) as T;
}

/** One serialized log line, redacted as a whole: parsed when it is JSON, as text otherwise. */
export function redactLogLine(line: string): string {
  const newline = line.endsWith("\n") ? "\n" : "";
  try {
    return JSON.stringify(redactCredentials(JSON.parse(line))) + newline;
  } catch {
    return redactUrl(withoutUrlValues(line));
  }
}

interface LoggedRequest {
  method?: string;
  url?: string;
  hostname?: string;
  ip?: string;
  socket?: { remotePort?: number };
}

/**
 * The gateway's Fastify logger options: pino at level info, a request serializer that logs the
 * request's URL with every query value dropped and no header, and every line redacted as a whole
 * before it is written, whatever logged it (an error's message or stack, a route's own url field).
 */
export function gatewayLoggerOptions() {
  return {
    level: "info",
    serializers: {
      req: (req: LoggedRequest) => ({
        method: req.method,
        url: typeof req.url === "string" ? withoutQueryValues(req.url) : req.url,
        hostname: req.hostname,
        remoteAddress: req.ip,
        remotePort: req.socket?.remotePort,
      }),
    },
    hooks: { streamWrite: redactLogLine },
  };
}
