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
  style,
  ...props
}: GlassPanelProps) {
  const glowStyle =
    glow === "green"
      ? { boxShadow: "0 0 24px rgba(0, 255, 136, 0.12), 0 0 60px rgba(0, 255, 136, 0.04)" }
      : glow === "gold"
        ? { boxShadow: "0 0 24px rgba(255, 170, 0, 0.12), 0 0 60px rgba(255, 170, 0, 0.04)" }
        : {};

  return (
    <div
      className={cn(
        "rounded-xl backdrop-blur-2xl transition-all duration-200",
        hover && "cursor-pointer",
        paddingMap[padding],
        className,
      )}
      style={{
        background: "rgba(255, 255, 255, 0.04)",
        border: "1px solid rgba(255, 255, 255, 0.12)",
        ...glowStyle,
        ...style,
      }}
      onMouseEnter={
        hover
          ? (e) => {
              const el = e.currentTarget as HTMLDivElement;
              el.style.background = "rgba(255, 255, 255, 0.07)";
              el.style.borderColor = "rgba(0, 255, 136, 0.25)";
              el.style.boxShadow = "0 0 20px rgba(0, 255, 136, 0.1), inset 0 1px 0 rgba(255,255,255,0.06)";
            }
          : undefined
      }
      onMouseLeave={
        hover
          ? (e) => {
              const el = e.currentTarget as HTMLDivElement;
              el.style.background = "rgba(255, 255, 255, 0.04)";
              el.style.borderColor = "rgba(255, 255, 255, 0.12)";
              el.style.boxShadow = glow === "green"
                ? "0 0 24px rgba(0, 255, 136, 0.12), 0 0 60px rgba(0, 255, 136, 0.04)"
                : glow === "gold"
                  ? "0 0 24px rgba(255, 170, 0, 0.12), 0 0 60px rgba(255, 170, 0, 0.04)"
                  : "none";
            }
          : undefined
      }
      {...props}
    >
      {children}
    </div>
  );
}
