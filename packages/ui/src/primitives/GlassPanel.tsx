import React from "react";
import { cn } from "../utils.js";

export interface GlassPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  hover?: boolean;
  glow?: "green" | "gold" | "none";
  padding?: "none" | "sm" | "md" | "lg";
}

const paddingMap = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};

export function GlassPanel({
  hover = false,
  glow = "none",
  padding = "md",
  className,
  children,
  ...props
}: GlassPanelProps) {
  return (
    <div
      className={cn(
        "rounded-xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-xl",
        hover && "transition-all duration-200 hover:bg-white/[0.06] hover:border-green-400/20 cursor-pointer",
        glow === "green" && "shadow-[0_0_20px_rgba(124,179,66,0.15)]",
        glow === "gold" && "shadow-[0_0_20px_rgba(255,179,0,0.15)]",
        paddingMap[padding],
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
