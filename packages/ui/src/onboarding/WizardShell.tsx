import React from "react";
import { cn } from "../utils.js";

export interface WizardShellProps {
  stepRail: React.ReactNode;
  content: React.ReactNode;
  aiSidebar?: React.ReactNode;
  sidebarOpen?: boolean;
  className?: string;
}

export function WizardShell({ stepRail, content, aiSidebar, sidebarOpen = true, className }: WizardShellProps) {
  return (
    <div className={cn("flex h-full min-h-0", className)}>
      {/* Left step rail */}
      <div className="w-[200px] shrink-0 border-r border-white/[0.06] bg-white/[0.01] overflow-y-auto">
        {stepRail}
      </div>

      {/* Center content */}
      <div className="flex-1 min-w-0 overflow-y-auto p-6">
        {content}
      </div>

      {/* Right AI sidebar */}
      {aiSidebar && sidebarOpen && (
        <div className="w-[320px] shrink-0 border-l border-white/[0.06] bg-white/[0.01] overflow-y-auto">
          {aiSidebar}
        </div>
      )}
    </div>
  );
}
