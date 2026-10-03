/**
 * One redaction for every observability sink (cross-family reviews r3 and r4 of #441): Sentry error
 * events, transactions, spans and breadcrumbs, the Fastify request log, and the audit log's request
 * URL. Each sink sends its WHOLE record through here, so no field is left to a field-local rule:
 *
 *   - Headers. Anywhere a value sits under a key named "headers", and in every span attribute
 *     http.request.header.* or http.response.header.*, a header keeps its value only when its name is
 *     on SAFE_HEADERS. The allowlist decides, not a name pattern, so a signature, HMAC or vendor
 *     credential header of any name (payment-signature, x-hmac-signature, lob-signature) is redacted.
 *   - Credential-named keys. Anywhere, a key whose name is credential-like has its value redacted.
 *   - Strings. In every string, each query, fragment or form parameter whose (decoded) name is
 *     credential-like has its value redacted, wherever the string sits: a URL, a query string, a log
 *     message, an error message or stack. A string that holds a JSON object or array (a captured
 *     request body) is parsed, redacted the same way, and written back.
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

/**
 * A request URL with the value of every query parameter dropped, whatever its name: the path and
 * the parameter names stay. For the request's own URL in a log line or an error report, where no
 * value is needed and a name list could miss one (an OAuth code, a one-time link's token).
 */
export function withoutQueryValues(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const hash = url.indexOf("#", q);
  const query = url.slice(q + 1, hash === -1 ? undefined : hash);
  const dropped = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq !== -1) return `${pair.slice(0, eq)}=${REDACTED}`;
      return pair === "" ? pair : REDACTED; // a bare value has no name to keep
    })
    .join("&");
  return url.slice(0, q + 1) + dropped + (hash === -1 ? "" : redactUrl(url.slice(hash)));
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
  return redactUrl(text);
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

/** One serialized log line, redacted as a whole: parsed when it is JSON, its parameters otherwise. */
export function redactLogLine(line: string): string {
  const newline = line.endsWith("\n") ? "\n" : "";
  try {
    return JSON.stringify(redactCredentials(JSON.parse(line))) + newline;
  } catch {
    return redactUrl(line);
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
