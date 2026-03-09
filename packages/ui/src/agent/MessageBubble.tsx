import React from "react";
import { GlowBadge } from "../primitives/GlowBadge.js";
import { cn } from "../utils.js";

export interface MessageBubbleProps {
  from: string;
  role: "user" | "broker" | "kernel";
  intent: string;
  content: string;
  timestamp: string;
  className?: string;
}

const roleColors: Record<string, "green" | "gold" | "gray"> = {
  user: "green",
  broker: "gold",
  kernel: "gray",
};

const roleAlignments: Record<string, string> = {
  user: "ml-12",
  broker: "mr-12 ml-0",
  kernel: "mr-12 ml-0",
};

export function MessageBubble({ from, role, intent, content, timestamp, className }: MessageBubbleProps) {
  const isUser = role === "user";
  return (
    <div className={cn("space-y-1", roleAlignments[role], className)}>
      <div className={cn("flex items-center gap-2", isUser && "flex-row-reverse")}>
        <GlowBadge color={roleColors[role]}>{from}</GlowBadge>
        <code className="text-[10px] text-green-400/50 bg-white/[0.03] rounded px-1.5 py-0.5">{intent}</code>
        <span className="text-[10px] text-white/15 font-mono">{timestamp}</span>
      </div>
      <div
        className={cn(
          "rounded-xl px-4 py-2.5 text-sm",
          isUser
            ? "bg-green-500/10 border border-green-500/15 text-white/70"
            : "bg-white/[0.03] border border-white/[0.06] text-white/60",
        )}
      >
        {content}
      </div>
    </div>
  );
}
