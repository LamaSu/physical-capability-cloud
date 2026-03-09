import React from "react";
import { cn } from "../utils.js";

export interface AppShellProps {
  sidebar: React.ReactNode;
  topBar: React.ReactNode;
  statusBar: React.ReactNode;
  particles?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function AppShell({ sidebar, topBar, statusBar, particles, children, className }: AppShellProps) {
  return (
    <div className="relative flex h-screen overflow-hidden bg-forest-900">
      {particles}

      {/* Sidebar */}
      <div className="relative z-10 flex-shrink-0">{sidebar}</div>

      {/* Main area */}
      <div className="relative z-10 flex flex-col flex-1 min-w-0">
        {topBar}
        <main className={cn("flex-1 overflow-y-auto px-6 py-6", className)}>
          {children}
        </main>
        {statusBar}
      </div>
    </div>
  );
}
