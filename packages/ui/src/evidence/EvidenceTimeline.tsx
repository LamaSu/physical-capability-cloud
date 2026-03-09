import React from "react";
import type { EvidenceEvent } from "@pcc/spec";
import { GlowBadge } from "../primitives/GlowBadge.js";
import { HashDisplay } from "../primitives/HashDisplay.js";
import { cn } from "../utils.js";

export interface EvidenceTimelineProps {
  events: EvidenceEvent[];
  className?: string;
}

const eventTypeIcons: Record<string, string> = {
  gcode_received: "📥",
  gcode_hash_verified: "✅",
  gcode_loaded: "📂",
  execution_started: "▶️",
  execution_progress: "⏳",
  execution_completed: "✔️",
  execution_failed: "❌",
  power_profile_sample: "⚡",
  power_profile_summary: "📊",
  camera_snapshot: "📷",
  cv_inspection_result: "🔍",
  tee_attestation: "🔐",
  custody_sealed: "📦",
  custody_handoff_initiated: "🤝",
  custody_handoff_confirmed: "✅",
};

const eventTypeColors: Record<string, "green" | "gold" | "gray" | "red"> = {
  execution_started: "gold",
  execution_completed: "green",
  execution_failed: "red",
  power_profile_summary: "gold",
  tee_attestation: "green",
};

export function EvidenceTimeline({ events, className }: EvidenceTimelineProps) {
  return (
    <div className={cn("space-y-0", className)}>
      {events.map((event, i) => {
        const isLast = i === events.length - 1;
        const time = new Date(event.timestamp).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const icon = eventTypeIcons[event.type] ?? "📋";
        const color = eventTypeColors[event.type] ?? "gray";

        return (
          <div key={event.id} className="flex gap-3">
            {/* Timeline line */}
            <div className="flex flex-col items-center w-8">
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-white/[0.04] border border-white/[0.06] text-sm flex-shrink-0">
                {icon}
              </div>
              {!isLast && <div className="w-px flex-1 bg-white/[0.06] min-h-[16px]" />}
            </div>

            {/* Content */}
            <div className="flex-1 pb-4 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <GlowBadge color={color}>{event.type.replace(/_/g, " ")}</GlowBadge>
                <span className="text-[10px] text-white/20 font-mono">{time}</span>
              </div>
              <div className="text-xs text-white/30 font-mono mt-1">
                {event.source.deviceType} · {event.source.deviceId}
              </div>
              <HashDisplay hash={event.hash} className="mt-1" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
