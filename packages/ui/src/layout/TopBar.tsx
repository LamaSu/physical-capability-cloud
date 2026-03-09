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
        "flex items-center justify-between px-6 py-4 border-b border-white/[0.06]",
        "bg-forest-900/60 backdrop-blur-xl",
        className,
      )}
    >
      <div className="flex flex-col">
        <h1 className="text-lg font-semibold text-white/90">{title}</h1>
        {subtitle && <p className="text-xs text-white/40 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </header>
  );
}
