import React from "react";

interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  className?: string;
}

/**
 * EmptyState — shown when a page or section has no data yet.
 * Clean, minimal, with an optional CTA to guide the user.
 */
export function EmptyState({ icon, title, description, action, className = "" }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center py-16 px-8 ${className}`}>
      {icon && (
        <div className="text-4xl mb-4 opacity-30">{icon}</div>
      )}
      <h3 className="text-sm font-medium text-white/50 mb-1">{title}</h3>
      {description && (
        <p className="text-xs text-white/25 max-w-xs text-center leading-relaxed">{description}</p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-4 px-4 py-1.5 text-xs font-medium text-teal-400 border border-teal-400/30 rounded-md hover:bg-teal-400/10 transition-all"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
