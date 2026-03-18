import React from "react";

interface LoadingShellProps {
  rows?: number;
  className?: string;
}

/**
 * LoadingShell — skeleton loader matching the KPI card + list layout.
 */
export function LoadingShell({ rows = 3, className = "" }: LoadingShellProps) {
  return (
    <div className={`space-y-6 animate-pulse ${className}`}>
      {/* KPI skeleton */}
      <div className="grid grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-xl bg-white/[0.03] border border-white/[0.04]" />
        ))}
      </div>
      {/* List skeleton */}
      <div className="rounded-xl bg-white/[0.02] border border-white/[0.04] p-6 space-y-4">
        <div className="h-3 w-32 rounded bg-white/[0.06]" />
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex gap-4 items-center">
            <div className="h-10 w-10 rounded-full bg-white/[0.04]" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-48 rounded bg-white/[0.05]" />
              <div className="h-2 w-32 rounded bg-white/[0.03]" />
            </div>
            <div className="h-6 w-20 rounded bg-white/[0.04]" />
          </div>
        ))}
      </div>
    </div>
  );
}
