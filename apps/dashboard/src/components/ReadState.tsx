import React from "react";

const UNAVAILABLE = "Unavailable";
const COULD_NOT_LOAD = (what: string) => `Couldn't load ${what}`;
const READ_UNAVAILABLE = "PCC couldn't read this from the gateway, so nothing is shown here rather than a guess.";
const REQUEST_FAILED = "The request failed.";
const TRY_AGAIN = "Try again";
const STALE = "Stale";
const EARLIER_READ = "an earlier read";
const COULD_NOT_REFRESH = (what: string, time: string) => `Couldn't refresh ${what}. Showing data from ${time}.`;
const RETRY = "Retry";

export const CAPABILITY_PAGES_NOTICE = (pages: number) =>
  `Read in ${pages} pages; the gateway gives no snapshot across pages.`;

/** A short, user-safe description of a failed read. */
export function describeReadError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 160);
  if (typeof error === "string" && error) return error.slice(0, 160);
  return REQUEST_FAILED;
}

export interface UnavailableStateProps {
  /** What could not be loaded, in plain words: "jobs", "your account". */
  what: string;
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}

/**
 * Shown instead of data when a live read failed and there is nothing earlier
 * to show. Never shown for a successful empty result; that is an EmptyState.
 */
export function UnavailableState({ what, error, onRetry, className = "" }: UnavailableStateProps) {
  return (
    <div
      role="status"
      data-live-state="unavailable"
      className={`flex flex-col items-center justify-center py-12 px-8 text-center ${className}`}
    >
      <div className="text-xs font-semibold uppercase tracking-wider text-amber-300/80 mb-1">
        {UNAVAILABLE}
      </div>
      <h3 className="text-sm font-medium text-white/60 mb-1">{COULD_NOT_LOAD(what)}</h3>
      <p className="text-xs text-white/35 max-w-sm leading-relaxed">
        {READ_UNAVAILABLE}
        {error !== undefined && <span className="block mt-1 font-mono text-white/25">{describeReadError(error)}</span>}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 px-4 py-1.5 text-xs font-medium text-teal-400 border border-teal-400/30 rounded-md hover:bg-teal-400/10 transition-all"
        >
          {TRY_AGAIN}
        </button>
      )}
    </div>
  );
}

export interface StaleNoticeProps {
  what: string;
  /** When the data on screen was last read successfully (ms since epoch). */
  updatedAt: number;
  onRetry?: () => void;
}

/**
 * Shown above data when the latest refresh failed but an earlier read
 * succeeded: the data stays visible and is labelled with its age.
 */
export function StaleNotice({ what, updatedAt, onRetry }: StaleNoticeProps) {
  const when = updatedAt > 0 ? new Date(updatedAt).toLocaleTimeString() : EARLIER_READ;
  return (
    <div
      role="status"
      data-live-state="stale"
      className="flex items-center gap-3 px-4 py-2 rounded-lg bg-amber-500/[0.06] border border-amber-500/20 text-xs text-amber-200/70"
    >
      <span className="font-semibold uppercase tracking-wider text-amber-300/80">{STALE}</span>
      <span>
        {COULD_NOT_REFRESH(what, when)}
      </span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="ml-auto text-teal-400/80 hover:text-teal-300">
          {RETRY}
        </button>
      )}
    </div>
  );
}
