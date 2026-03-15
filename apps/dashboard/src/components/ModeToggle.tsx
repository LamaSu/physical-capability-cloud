import React from "react";
import { useUIStore } from "../stores/ui-store.js";
import { cn } from "@pcc/ui";

export function ModeToggle() {
  const { interfaceMode, toggleMode } = useUIStore();

  return (
    <button
      onClick={toggleMode}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all duration-200",
        interfaceMode === "agent"
          ? "bg-teal-500/10 border-teal-500/20 text-teal-300 hover:bg-teal-500/15"
          : "bg-white/[0.04] border-white/[0.08] text-white/50 hover:bg-white/[0.06]",
      )}
    >
      {interfaceMode === "agent" ? (
        <>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
          </svg>
          Dashboard
        </>
      ) : (
        <>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          Agent Chat
        </>
      )}
    </button>
  );
}
