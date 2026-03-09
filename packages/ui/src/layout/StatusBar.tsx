import React from "react";
import { cn } from "../utils.js";
import { PulseIndicator } from "../primitives/PulseIndicator.js";

export interface StatusBarProps {
  kernelsOnline?: number;
  activeJobs?: number;
  networkStatus?: "connected" | "reconnecting" | "disconnected";
  blockNumber?: number;
  className?: string;
}

export function StatusBar({
  kernelsOnline = 0,
  activeJobs = 0,
  networkStatus = "connected",
  blockNumber,
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
      <div className="flex items-center gap-2 text-white/30">
        <PulseIndicator
          status={networkStatus === "connected" ? "online" : networkStatus === "reconnecting" ? "executing" : "offline"}
          size="sm"
        />
        <span>{networkStatus === "connected" ? "Connected" : networkStatus === "reconnecting" ? "Reconnecting..." : "Disconnected"}</span>
      </div>
      <div className="text-white/25">|</div>
      <div className="text-white/30">
        <span className="text-green-400/60">{kernelsOnline}</span> kernels online
      </div>
      <div className="text-white/25">|</div>
      <div className="text-white/30">
        <span className="text-gold-300/60">{activeJobs}</span> active jobs
      </div>
      {blockNumber !== undefined && (
        <>
          <div className="text-white/25">|</div>
          <div className="text-white/30">
            block <span className="text-white/50">#{blockNumber}</span>
          </div>
        </>
      )}
      <div className="ml-auto text-white/20">base-sepolia</div>
    </footer>
  );
}
