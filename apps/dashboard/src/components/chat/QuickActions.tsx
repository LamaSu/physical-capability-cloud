import React from "react";
import type { SuggestedAction } from "../../agent/agent-types.js";

interface QuickActionsProps {
  actions: SuggestedAction[];
  onSelect: (message: string) => void;
  disabled?: boolean;
}

export function QuickActions({ actions, onSelect, disabled }: QuickActionsProps) {
  if (!actions.length) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action, i) => (
        <button
          key={i}
          onClick={() => onSelect(action.message)}
          disabled={disabled}
          className="px-3 py-1.5 rounded-full text-xs font-medium
            bg-teal-500/8 border border-teal-500/15 text-teal-300/80
            hover:bg-teal-500/15 hover:border-teal-500/25 hover:text-teal-200
            disabled:opacity-40 disabled:cursor-not-allowed
            transition-all duration-200"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
