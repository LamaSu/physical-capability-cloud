import React, { useEffect, useRef, useState } from "react";
import { cn } from "@pcc/ui";
import {
  formatEventTime,
  levelDot,
  mergeEvents,
  payloadKeyCount,
  sponsorClass,
  type OnboardEvent,
} from "./activity-feed-logic.js";

/**
 * Live integration feed (sidebar) for the onboard chat console.
 *
 * Polls a gateway endpoint (default `/api/onboard/events?since=<cursor>`)
 * every `pollIntervalMs` (default 2000 ms), merges new events into a bounded
 * ring buffer (cap 80) and renders sponsor-coloured pills with an expandable
 * payload toggle.
 *
 * The component is independently testable — pass in `events` directly to
 * skip the network and render statically.
 */
export interface ActivityFeedProps {
  /**
   * Endpoint that returns `{ events: OnboardEvent[] }` for `?since=<ms>`.
   * Default matches the wave2-alpha gateway route convention.
   */
  endpoint?: string;
  /** Static events override (skips polling — used by tests + storybook). */
  events?: OnboardEvent[];
  /** Poll interval in ms. Defaults to navi v1's 1.5s cadence. */
  pollIntervalMs?: number;
  /** Max rows kept in the ring buffer. */
  capacity?: number;
  /** Optional title rendered in the sticky header. */
  title?: string;
}

const SPONSOR_COLOR: Record<string, string> = {
  guild: "bg-fuchsia-500/80 text-white",
  tinyfish: "bg-amber-500/90 text-black",
  nexla: "bg-green-400/80 text-black",
  insforge: "bg-pink-500/80 text-white",
  redis: "bg-red-500/80 text-white",
  ghost: "bg-teal-500/80 text-white",
  cdp: "bg-blue-600/80 text-white",
  x402: "bg-blue-600/80 text-white",
  agentic: "bg-blue-600/80 text-white",
  senso: "bg-yellow-400/90 text-black",
  navi: "bg-sky-500/80 text-white",
  vapi: "bg-white text-zinc-900",
};

export function ActivityFeed({
  endpoint = "/api/onboard/events",
  events: staticEvents,
  pollIntervalMs = 1500,
  capacity = 80,
  title = "Live integration feed",
}: ActivityFeedProps) {
  const [events, setEvents] = useState<OnboardEvent[]>(staticEvents ?? []);
  const cursorRef = useRef<number>(0);
  const isStatic = staticEvents !== undefined;

  useEffect(() => {
    if (isStatic) return;

    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`${endpoint}?since=${cursorRef.current}`, {
          credentials: "same-origin",
        });
        if (!res.ok) return;
        const body = (await res.json()) as { events?: OnboardEvent[] };
        const incoming = body.events ?? [];
        if (cancelled) return;
        setEvents((prev) => {
          const { events: merged, nextCursor } = mergeEvents(
            prev,
            incoming,
            cursorRef.current,
            capacity,
          );
          cursorRef.current = nextCursor;
          return merged;
        });
      } catch {
        // Silent — polling is best-effort.
      }
    }

    poll();
    const id = setInterval(poll, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [endpoint, pollIntervalMs, capacity, isStatic]);

  return (
    <aside
      className="flex flex-col h-full bg-zinc-950/95 border border-white/[0.06] rounded-xl overflow-hidden"
      data-testid="onboard-activity-feed"
    >
      <header className="px-3.5 py-2.5 border-b border-white/[0.06] bg-zinc-900/60">
        <h2 className="text-[11px] uppercase tracking-wider text-white/40 font-medium">
          {title}
        </h2>
        <div className="text-[10px] text-white/30 mt-0.5">
          All sponsor calls + voice-agent transcript stream here in real time.
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-1">
        {events.length === 0 ? (
          <div className="text-[11px] text-white/25 px-2 py-6 text-center">
            Waiting for events…
          </div>
        ) : (
          events.map((ev) => <FeedRow key={`${ev.t}-${ev.sponsor ?? ""}`} ev={ev} />)
        )}
      </div>
    </aside>
  );
}

interface FeedRowProps {
  ev: OnboardEvent;
}

function FeedRow({ ev }: FeedRowProps) {
  const [expanded, setExpanded] = useState(false);
  const klass = sponsorClass(ev.sponsor);
  const sponsorPill =
    SPONSOR_COLOR[klass] ?? "bg-white/[0.08] text-white/70 border border-white/[0.12]";
  const dot = levelDot(ev.level);
  const timeStr = formatEventTime(ev.t);
  const keyCount = payloadKeyCount(ev.payload);

  return (
    <div
      className="flex gap-2 py-1.5 border-b border-white/[0.04] last:border-b-0 text-[12px]"
      data-testid="onboard-activity-row"
    >
      <span
        className="text-white/40 text-[10px] min-w-[58px] pt-0.5"
        aria-label={`${ev.level ?? "info"} at ${timeStr}`}
      >
        {dot} {timeStr}
      </span>
      <span
        className={cn(
          "px-1.5 py-0.5 rounded text-[10px] font-medium self-start whitespace-nowrap",
          sponsorPill,
        )}
        data-testid="onboard-activity-sponsor"
      >
        {ev.sponsor ?? "Navi"}
      </span>
      <span className="flex-1 min-w-0 leading-snug text-white/80">
        {ev.kind && (
          <code className="text-[10px] text-white/40 mr-1.5">{ev.kind}</code>
        )}
        <div>
          {ev.text ?? ""}
          {ev.duration_ms != null && (
            <span className="text-white/30 text-[10px] ml-1.5">
              {ev.duration_ms}ms
            </span>
          )}
        </div>
        {keyCount > 0 && (
          <details
            className="mt-1"
            open={expanded}
            onToggle={(e) => setExpanded((e.target as HTMLDetailsElement).open)}
            data-testid="onboard-activity-payload-toggle"
          >
            <summary className="cursor-pointer text-[10px] text-sky-300/80 hover:text-sky-200">
              payload ({keyCount} keys)
            </summary>
            <pre className="bg-black/60 p-1.5 rounded text-[10px] text-emerald-200/80 overflow-x-auto mt-1">
              {JSON.stringify(ev.payload, null, 2)}
            </pre>
          </details>
        )}
      </span>
    </div>
  );
}
