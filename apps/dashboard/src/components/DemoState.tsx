import React from "react";
import { demoModeHref } from "../lib/demo-mode.js";

/**
 * The two states a page with no live data source can be in.
 *
 * Production: NotLiveState says the view is not connected to live data. It
 * never shows an empty list that reads as "there is nothing", and never shows
 * sample values.
 * Demo mode (lib/demo-mode.ts): the page may render its fixtures under a
 * DemoBanner that stays on screen.
 */

export interface NotLiveStateProps {
  /** What this view would show, in plain words: "fund governance", "oracle status". */
  what: string;
  /** Optional: what it is waiting on, e.g. "No gateway route serves this yet." */
  detail?: string;
  /** Offer a link into demo mode when the page has fixtures to show. */
  hasDemo?: boolean;
  className?: string;
}

export function NotLiveState({ what, detail, hasDemo = false, className = "" }: NotLiveStateProps) {
  return (
    <div
      role="status"
      data-live-state="not-live"
      className={`flex flex-col items-center justify-center py-12 px-8 text-center ${className}`}
    >
      <div className="text-xs font-semibold uppercase tracking-wider text-white/40 mb-1">Not live</div>
      <h3 className="text-sm font-medium text-white/60 mb-1">{what} isn't connected to live data yet</h3>
      <p className="text-xs text-white/35 max-w-sm leading-relaxed">
        {detail ?? "Nothing is shown here rather than sample values."}
      </p>
      {hasDemo && (
        <a href={demoModeHref(true)} className="mt-4 text-xs text-teal-400/80 hover:text-teal-300 underline underline-offset-4">
          View the demo version (sample data, labelled)
        </a>
      )}
    </div>
  );
}

/** Persistent banner over a page that is rendering fixtures in demo mode. */
export function DemoBanner({ what }: { what: string }) {
  return (
    <div
      role="status"
      data-live-state="demo"
      className="flex items-center gap-3 px-4 py-2 rounded-lg bg-violet-500/[0.08] border border-violet-500/30 text-xs text-violet-200/80"
    >
      <span className="font-semibold uppercase tracking-wider text-violet-300">Demo data</span>
      <span>{what}: sample values, not live PCC state.</span>
      <a href={demoModeHref(false)} className="ml-auto text-violet-300/80 hover:text-violet-200 underline underline-offset-4">
        Leave demo mode
      </a>
    </div>
  );
}
