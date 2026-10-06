import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@pcc/ui";
import { WORKSPACE_HOME, nextWorkspace, workspaceForPath, type Workspace } from "../lib/workspaces.js";

const MODE_LABELS: Record<Workspace, { label: string; icon: React.ReactNode; color: string }> = {
  spatial: {
    label: "Spatial",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="1" />
        <circle cx="12" cy="5" r="1" />
        <circle cx="12" cy="19" r="1" />
        <circle cx="19" cy="12" r="1" />
        <circle cx="5" cy="12" r="1" />
        <path d="M12 6v5M12 13v5M13 12h5M6 12h5" />
      </svg>
    ),
    color: "bg-violet-500/10 border-violet-500/20 text-violet-300 hover:bg-violet-500/15",
  },
  agent: {
    label: "Agent",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    color: "bg-teal-500/10 border-teal-500/20 text-teal-300 hover:bg-teal-500/15",
  },
  dashboard: {
    label: "Dashboard",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="14" y="14" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
      </svg>
    ),
    color: "bg-white/[0.04] border-white/[0.08] text-white/50 hover:bg-white/[0.06]",
  },
};

/**
 * Shows the workspace the URL is in; clicking goes to the next workspace's
 * address. The workspace is never held in memory, so reloading or sharing a
 * link keeps it.
 */
export function ModeToggle() {
  const location = useLocation();
  const navigate = useNavigate();
  const current = workspaceForPath(location.pathname);
  const next = nextWorkspace(current);
  const mode = MODE_LABELS[current];

  return (
    <button
      type="button"
      onClick={() => navigate(WORKSPACE_HOME[next])}
      title={`Switch to ${MODE_LABELS[next].label}`}
      data-workspace={current}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all duration-200",
        mode.color,
      )}
    >
      {mode.icon}
      {mode.label}
    </button>
  );
}
