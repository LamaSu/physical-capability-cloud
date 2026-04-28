/**
 * Pure helpers for routing user input in the onboard chat console.
 * Ported from navi v1 packages/backend/public/index.html (vanilla JS regex helpers)
 * into typed, testable TS.
 *
 * The chat thread takes whatever the operator types and decides whether it is:
 *   - a company-name + URL bootstrap line ("Acme Co at https://acme.com")
 *   - one or more URLs to scrape
 *   - one or more document URLs to ingest
 *   - one or more DB connection strings to wire
 *   - a "build/deploy/ship/go live/finish/done" command
 *   - free-form text (advance the conversation)
 *
 * The route layer (../routes/onboard/chat/index.tsx) consumes `parseInputIntent`
 * and dispatches to the matching gateway endpoint.
 */

/** Returns true for http(s):// URLs (anywhere in the trimmed string). */
export function looksLikeUrl(text: string): boolean {
  return /^https?:\/\//i.test(text.trim());
}

/** Returns true for known DB / cloud connection string protocols. */
export function looksLikeConnString(text: string): boolean {
  return /^(postgres|postgresql|mysql|mongodb|redis|s3|sharepoint):\/\//i.test(
    text.trim(),
  );
}

/**
 * Returns true if the URL/path looks like a document file the agent should
 * ingest into the verifier DB rather than scrape as a website.
 */
export function looksLikeDoc(text: string): boolean {
  return /\.pdf|\.docx|\.html?$|drive\.google\.com|sharepoint\.com\/.+\.(pdf|docx)/i.test(
    text,
  );
}

/** Returns true for the "deploy now" command set the operator might type. */
export function looksLikeBuildCommand(text: string): boolean {
  return /^(build|deploy|ship|go live|finish|done)$/i.test(text.trim());
}

/**
 * Bootstrap line detection: "<company> at <url>", "<company> @ <url>",
 * "<company> — <url>", or "<company> - <url>".
 *
 * Returns the parsed { name, url } pair when matched, or null when the line
 * does not look like a bootstrap.
 */
export function parseBootstrap(text: string): { name: string; url: string } | null {
  const m = text.match(/^(.+?)\s+(?:at|@|—|-)\s+(https?:\/\/\S+)/i);
  if (!m) return null;
  return { name: m[1]!.trim(), url: m[2]!.trim() };
}

export type InputIntent =
  | { kind: "bootstrap"; name: string; url: string | null }
  | { kind: "connections"; connections: string[] }
  | { kind: "ingest_docs"; urls: string[] }
  | { kind: "scrape_url"; url: string }
  | { kind: "scrape_many"; urls: string[]; docs: string[] }
  | { kind: "build" }
  | { kind: "noop" };

/**
 * Top-level dispatcher. Given a message and whether a session is already
 * established, returns the intent the chat layer should act on.
 *
 * Decision order matches navi v1 onSend():
 *   1. No session yet → treat as bootstrap (with optional URL)
 *   2. Connection strings present → wire them
 *   3. Single doc URL → ingest
 *   4. Single non-doc URL → scrape
 *   5. Multiple URLs → split docs from sites, ingest + scrape
 *   6. "build" / "deploy" → kick the agent build
 *   7. Otherwise → noop (reply with conversational nudge)
 */
export function parseInputIntent(
  text: string,
  hasSession: boolean,
): InputIntent {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "noop" };

  // No session yet → always a bootstrap. URL is optional.
  if (!hasSession) {
    const parsed = parseBootstrap(trimmed);
    if (parsed) {
      return { kind: "bootstrap", name: parsed.name, url: parsed.url };
    }
    return { kind: "bootstrap", name: trimmed, url: null };
  }

  const tokens = trimmed.split(/\s+/);
  const urls = tokens.filter(looksLikeUrl);
  const conns = tokens.filter(looksLikeConnString);

  if (conns.length > 0) {
    return { kind: "connections", connections: conns };
  }

  if (urls.length === 1 && looksLikeDoc(urls[0]!)) {
    return { kind: "ingest_docs", urls: [urls[0]!] };
  }
  if (urls.length === 1) {
    return { kind: "scrape_url", url: urls[0]! };
  }
  if (urls.length > 1) {
    const docs = urls.filter((u) => looksLikeDoc(u));
    const others = urls.filter((u) => !looksLikeDoc(u));
    return { kind: "scrape_many", urls: others, docs };
  }

  if (looksLikeBuildCommand(trimmed)) {
    return { kind: "build" };
  }

  return { kind: "noop" };
}
