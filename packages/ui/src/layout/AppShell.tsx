import React, { useRef, useState } from "react";
import { cn } from "../utils.js";

export interface AppShellProps {
  sidebar: React.ReactNode;
  topBar: React.ReactNode;
  statusBar: React.ReactNode;
  particles?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

const SKIP_LINK_HIDDEN_STYLE: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

const SKIP_LINK_VISIBLE_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 8,
  left: 8,
  zIndex: 50,
  padding: "8px 12px",
  borderRadius: 8,
  background: "#0a0b0d",
  color: "#f2f3f5",
  outline: "2px solid #6CA5F2",
  outlineOffset: 2,
};

export function AppShell({ sidebar, topBar, statusBar, particles, children, className }: AppShellProps) {
  const mainRef = useRef<HTMLElement>(null);
  const [skipFocused, setSkipFocused] = useState(false);

  return (
    <div className="relative flex h-screen overflow-hidden bg-forest-900">
      <a
        href="#pcc-main"
        style={skipFocused ? SKIP_LINK_VISIBLE_STYLE : SKIP_LINK_HIDDEN_STYLE}
        onFocus={() => setSkipFocused(true)}
        onBlur={() => setSkipFocused(false)}
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Skip to main content
      </a>

      {particles}

      {/* Sidebar */}
      <div className="relative z-10 flex-shrink-0">{sidebar}</div>

      {/* Main area */}
      <div className="relative z-10 flex flex-col flex-1 min-w-0">
        {topBar}
        <main
          ref={mainRef}
          id="pcc-main"
          tabIndex={-1}
          className={cn("flex-1 overflow-y-auto px-6 py-6", className)}
        >
          {children}
        </main>
        {statusBar}
      </div>
    </div>
  );
}
