/**
 * Pure helpers for rendering the live integration feed (right sidebar of the
 * onboard chat console).
 *
 * Ported from navi v1 packages/backend/public/index.html eventRow() — the
 * sponsor-colour mapping was inline switch-style CSS classes; we factor those
 * out so they can be unit-tested and reused by both the ActivityFeed component
 * and any future event-stream surface (e.g. a dashboard tile).
 */

/**
 * Single event emitted by the agent-onboarder gateway's event-bus.
 * Shape mirrors navi v1's events: { t, sponsor, kind?, level?, text?, payload?, duration_ms? }.
 */
export interface OnboardEvent {
  /** Unix epoch ms, used for `?since=` polling cursor. */
  t: number;
  /** Sponsor / integration name (e.g. "TinyFish", "Nexla", "InsForge"). */
  sponsor?: string;
  /** Optional event subtype (e.g. "scrape", "ingest_docs"). */
  kind?: string;
  /** Severity. Drives the prefix dot. */
  level?: "info" | "ok" | "warn" | "err";
  /** Human-readable headline. */
  text?: string;
  /** Optional structured payload — rendered behind a <details> toggle. */
  payload?: Record<string, unknown> | null;
  /** Duration in ms, rendered next to the text in muted style. */
  duration_ms?: number | null;
}

/**
 * Map sponsor name → CSS class suffix used by the sponsor-pill colour scheme.
 *
 * Navi v1 used inline class names like "evb guild" / "evb tinyfish". We carry
 * the same suffix so existing styles (defined in the route page Tailwind utility
 * classes) stay 1:1 with the hackathon visual.
 *
 * Returns "" when the sponsor is unknown — caller can use that to fall through
 * to a default neutral pill.
 */
export function sponsorClass(sponsor: string | undefined | null): string {
  if (!sponsor) return "";
  // Navi v1 split on whitespace AND open-paren: e.g. "Coinbase (CDP)" → "coinbase".
  const key = sponsor.toLowerCase().split(/\s|\(/)[0] ?? "";
  // Navi v1 recognised these sponsor keys explicitly.
  const known = new Set([
    "guild",
    "tinyfish",
    "nexla",
    "insforge",
    "redis",
    "ghost",
    "cdp",
    "x402",
    "agentic",
    "senso",
    "navi",
    "vapi",
  ]);
  return known.has(key) ? key : "";
}

/** Map severity → emoji dot the feed renders before the timestamp. */
export function levelDot(level: OnboardEvent["level"]): "🟢" | "🟡" | "🔴" | "🔵" {
  switch (level) {
    case "ok":
      return "🟢";
    case "warn":
      return "🟡";
    case "err":
      return "🔴";
    case "info":
    default:
      return "🔵";
  }
}

/** HH:MM:SS in the local timezone, mirroring navi v1's display. */
export function formatEventTime(t: number): string {
  return new Date(t).toLocaleTimeString().split(" ")[0] ?? "";
}

/**
 * Merge a batch of new events into a bounded ring buffer (oldest first) and
 * advance the `since` cursor.
 *
 * The route layer polls `/api/onboard/events?since=<cursor>` every 2s; this
 * helper gives back the list to render and the next cursor to send.
 *
 * Capacity defaults to navi v1's 80-row cap.
 */
export function mergeEvents(
  current: OnboardEvent[],
  incoming: OnboardEvent[],
  prevCursor: number,
  capacity = 80,
): { events: OnboardEvent[]; nextCursor: number } {
  if (incoming.length === 0) {
    return { events: current, nextCursor: prevCursor };
  }
  // Sort incoming oldest-first so latest ends up at the head when we reverse
  // for display.
  const sorted = [...incoming].sort((a, b) => a.t - b.t);
  const merged = [...sorted, ...current].slice(0, capacity);
  const nextCursor = sorted.reduce(
    (max, ev) => Math.max(max, ev.t),
    prevCursor,
  );
  return { events: merged, nextCursor };
}

/**
 * Number of keys in the payload, or 0 if absent. Used by the route page to
 * gate the <details>/<summary> "payload (N keys)" toggle.
 */
export function payloadKeyCount(payload: OnboardEvent["payload"]): number {
  if (!payload) return 0;
  return Object.keys(payload).length;
}
