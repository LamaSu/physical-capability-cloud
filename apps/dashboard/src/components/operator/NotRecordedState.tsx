import React from "react";

/**
 * Shown where the operator pages have no real source yet (earnings history,
 * certifications, maintenance, machine utilization). It says so plainly and
 * shows no sample values and no empty list that would read as "none".
 *
 * Same props and data attribute as shell's NotLiveState
 * (fix/shell-no-prod-mock, components/DemoState.tsx); fold into it once that
 * lands on master.
 */
export function NotRecordedState({ what, detail, className = "" }: { what: string; detail?: string; className?: string }) {
  return (
    <div
      role="status"
      data-live-state="not-live"
      className={`flex flex-col items-center justify-center py-10 px-6 text-center ${className}`}
    >
      <div className="text-xs font-semibold uppercase tracking-wider text-white/40 mb-1">Not recorded yet</div>
      <h3 className="text-sm font-medium text-white/60 mb-1">PCC doesn't record {what} yet</h3>
      <p className="text-xs text-white/35 max-w-sm leading-relaxed">{detail ?? "Nothing is shown here rather than sample values."}</p>
    </div>
  );
}
