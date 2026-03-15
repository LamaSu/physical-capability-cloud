import React from "react";
import { cn } from "../utils.js";

export interface AIAction {
  label: string;
  onClick: () => void;
}

export interface OnboardingAIBubbleProps {
  content: string;
  suggestions?: string[];
  actions?: AIAction[];
  timestamp?: string;
  className?: string;
}

export function OnboardingAIBubble({ content, suggestions, actions, timestamp, className }: OnboardingAIBubbleProps) {
  return (
    <div className={cn("space-y-2 mr-8", className)}>
      <div className="flex items-center gap-2">
        <div className="w-5 h-5 rounded-full bg-green-500/20 border border-green-500/30 flex items-center justify-center">
          <span className="text-[8px] text-green-400 font-bold">AI</span>
        </div>
        <span className="text-[10px] text-green-400/40 font-mono">PCCP Assistant</span>
        {timestamp && <span className="text-[10px] text-white/10 font-mono">{timestamp}</span>}
      </div>

      <div className="rounded-xl px-4 py-2.5 text-sm bg-green-500/[0.06] border border-green-500/10 text-white/60 leading-relaxed">
        {content}
      </div>

      {suggestions && suggestions.length > 0 && (
        <div className="space-y-1 pl-2">
          {suggestions.map((s, i) => (
            <div key={i} className="text-[11px] text-green-400/40 flex items-start gap-1.5">
              <span className="text-green-500/30 mt-px">-</span>
              <span>{s}</span>
            </div>
          ))}
        </div>
      )}

      {actions && actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pl-2">
          {actions.map((a) => (
            <button
              key={a.label}
              onClick={a.onClick}
              className="px-2.5 py-1 rounded-md text-[10px] font-medium bg-green-500/10 border border-green-500/20 text-green-400/60 hover:bg-green-500/20 transition-all"
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
