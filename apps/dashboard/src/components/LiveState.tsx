import React from "react";

/**
 * Honest states for live data.
 *
 * A read that failed is not an empty result. A page that defaults a failed
 * query to [] shows "0 jobs" or "Welcome, you're all set" during an outage,
 * which is a plausible fake. These components give every page one way to
 * say "this could not be loaded" and "this is older than it looks".
 */

/** A short, user-safe description of a failed read. */
export function describeReadError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 160);
  if (typeof error === "string" && error) return error.slice(0, 160);
  return "The request failed.";
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
        Unavailable
      </div>
      <h3 className="text-sm font-medium text-white/60 mb-1">Couldn't load {what}</h3>
      <p className="text-xs text-white/35 max-w-sm leading-relaxed">
        The PCC gateway didn't answer, so nothing is shown here rather than a guess.
        {error !== undefined && <span className="block mt-1 font-mono text-white/25">{describeReadError(error)}</span>}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 px-4 py-1.5 text-xs font-medium text-teal-400 border border-teal-400/30 rounded-md hover:bg-teal-400/10 transition-all"
        >
          Try again
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
  const when = updatedAt > 0 ? new Date(updatedAt).toLocaleTimeString() : "an earlier read";
  return (
    <div
      role="status"
      data-live-state="stale"
      className="flex items-center gap-3 px-4 py-2 rounded-lg bg-amber-500/[0.06] border border-amber-500/20 text-xs text-amber-200/70"
    >
      <span className="font-semibold uppercase tracking-wider text-amber-300/80">Stale</span>
      <span>
        Couldn't refresh {what}. Showing data from {when}.
      </span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="ml-auto text-teal-400/80 hover:text-teal-300">
          Retry
        </button>
      )}
    </div>
  );
}
