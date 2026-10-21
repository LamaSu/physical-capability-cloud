import React from "react";
import { cn } from "../utils.js";
import { PulseIndicator } from "../primitives/PulseIndicator.js";

/**
 * Connectivity of the client to the PCC gateway, as observed by the caller.
 * "unknown" means no observation yet; it never renders as connected.
 */
export type StatusBarNetworkStatus = "connected" | "reconnecting" | "disconnected" | "unknown";

export interface StatusBarProps {
  /**
   * Kernels online. `undefined` or `null` means the count is unknown (still
   * loading, or the read failed) and renders as "—", never as 0.
   */
  kernelsOnline?: number | null;
  /** Active jobs. Same unknown-is-not-zero rule as `kernelsOnline`. */
  activeJobs?: number | null;
  /**
   * The active-job count came from a list that may be truncated, so it is a
   * lower bound: rendered as "N+", never as an exact count.
   */
  activeJobsAtLeast?: boolean;
  networkStatus?: StatusBarNetworkStatus;
  blockNumber?: number;
  /**
   * Settlement network label (e.g. a chain name). Rendered only when the
   * caller has it from a trusted source; there is no default.
   */
  network?: string;
  className?: string;
}

const NETWORK_LABEL: Record<StatusBarNetworkStatus, string> = {
  connected: "Gateway online",
  reconnecting: "Reconnecting…",
  disconnected: "Gateway unreachable",
  unknown: "Checking gateway…",
};

const NETWORK_PULSE: Record<StatusBarNetworkStatus, "online" | "executing" | "offline"> = {
  connected: "online",
  reconnecting: "executing",
  disconnected: "offline",
  unknown: "offline",
};

function Count({ value, atLeast = false, className }: { value: number | null | undefined; atLeast?: boolean; className: string }) {
  if (value === undefined || value === null) {
    return (
      <span className="text-white/40" title="Unavailable">
        —
      </span>
    );
  }
  if (atLeast) {
    return (
      <span className={className} title={`At least ${value}; the list this came from may be truncated`}>
        {value}+
      </span>
    );
  }
  return <span className={className}>{value}</span>;
}

export function StatusBar({
  kernelsOnline,
  activeJobs,
  activeJobsAtLeast = false,
  networkStatus = "unknown",
  blockNumber,
  network,
  className,
}: StatusBarProps) {
  return (
    <footer
      className={cn(
        "flex items-center gap-6 px-4 py-1.5 border-t border-white/[0.06]",
        "bg-forest-900/80 backdrop-blur-xl text-[11px] font-mono",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-white/30" role="status">
        <PulseIndicator status={NETWORK_PULSE[networkStatus]} size="sm" />
        <span>{NETWORK_LABEL[networkStatus]}</span>
      </div>
      <div className="text-white/25">|</div>
      <div className="text-white/30">
        <Count value={kernelsOnline} className="text-green-400/60" /> kernels online
      </div>
      <div className="text-white/25">|</div>
      <div className="text-white/30">
        <Count value={activeJobs} atLeast={activeJobsAtLeast} className="text-gold-300/60" /> active jobs
      </div>
      {blockNumber !== undefined && (
        <>
          <div className="text-white/25">|</div>
          <div className="text-white/30">
            block <span className="text-white/50">#{blockNumber}</span>
          </div>
        </>
      )}
      {network && <div className="ml-auto text-white/20">{network}</div>}
    </footer>
  );
}
