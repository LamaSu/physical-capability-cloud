import React from "react";
import { cn } from "../utils.js";

export interface GlowBadgeProps {
  color?: "green" | "gold" | "red" | "gray" | "teal" | "cyan";
  children: React.ReactNode;
  className?: string;
}

const colorStyles = {
  green: "bg-green-500/15 text-green-400 border-green-500/30",
  gold: "bg-gold-400/15 text-gold-300 border-gold-400/30",
  red: "bg-red-500/15 text-red-400 border-red-500/30",
  gray: "bg-white/5 text-white/60 border-white/10",
  teal: "bg-teal-500/20 text-teal-300 border-teal-500/30",
  cyan: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
};

export function GlowBadge({ color = "green", children, className }: GlowBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium font-mono",
        colorStyles[color],
        className,
      )}
    >
      {children}
    </span>
  );
}
