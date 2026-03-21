import React from "react";
import { cn } from "../utils.js";

export interface TopBarProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  className?: string;
}

export function TopBar({ title, subtitle, actions, className }: TopBarProps) {
  return (
    <header
      className={cn(
        "flex items-center justify-between px-6 py-4 backdrop-blur-xl relative",
        className,
      )}
      style={{
        background: "linear-gradient(180deg, rgba(5,10,14,0.85) 0%, rgba(9,15,21,0.75) 100%)",
      }}
    >
      {/* Scan-line texture overlay */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: "linear-gradient(transparent 50%, rgba(0, 255, 136, 0.015) 50%)",
          backgroundSize: "100% 4px",
        }}
      />

      {/* Bottom glow border */}
      <div
        className="absolute bottom-0 left-0 right-0 h-[1px]"
        style={{
          background: "linear-gradient(90deg, transparent 0%, rgba(0, 255, 136, 0.4) 20%, rgba(0, 212, 255, 0.3) 80%, transparent 100%)",
          boxShadow: "0 1px 8px rgba(0, 255, 136, 0.15)",
        }}
      />

      <div className="flex flex-col relative z-10">
        <h1
          className="text-lg font-semibold"
          style={{
            fontFamily: "var(--font-display, 'Space Grotesk', sans-serif)",
            color: "rgba(240,244,240,0.95)",
            letterSpacing: "0.01em",
          }}
        >
          {title}
        </h1>
        {subtitle && (
          <p
            className="text-xs mt-0.5"
            style={{ color: "rgba(0, 212, 255, 0.5)" }}
          >
            {subtitle}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-3 relative z-10">
          {actions}
        </div>
      )}
    </header>
  );
}
