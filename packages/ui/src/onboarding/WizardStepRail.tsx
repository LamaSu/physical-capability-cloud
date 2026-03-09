import React from "react";
import { cn } from "../utils.js";

export interface WizardStep {
  id: string;
  label: string;
  description?: string;
}

export interface WizardStepRailProps {
  steps: WizardStep[];
  currentStep: number;
  onStepClick?: (index: number) => void;
  className?: string;
}

export function WizardStepRail({ steps, currentStep, onStepClick, className }: WizardStepRailProps) {
  return (
    <nav className={cn("p-4 space-y-1", className)}>
      {steps.map((step, i) => {
        const isComplete = i < currentStep;
        const isCurrent = i === currentStep;
        const isClickable = onStepClick && i <= currentStep;

        return (
          <button
            key={step.id}
            onClick={() => isClickable && onStepClick(i)}
            disabled={!isClickable}
            className={cn(
              "w-full flex items-start gap-3 p-2 rounded-lg text-left transition-all",
              isClickable && "cursor-pointer hover:bg-white/[0.04]",
              !isClickable && "cursor-default",
            )}
          >
            {/* Step indicator */}
            <div className="relative flex flex-col items-center">
              <div
                className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center text-xs font-mono shrink-0 transition-all",
                  isComplete && "bg-green-500/20 border border-green-500/40 text-green-400 shadow-[0_0_10px_rgba(124,179,66,0.2)]",
                  isCurrent && "bg-green-500/10 border border-green-400/30 text-green-300",
                  !isComplete && !isCurrent && "bg-white/[0.03] border border-white/[0.08] text-white/20",
                )}
              >
                {isComplete ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M2 6l3 3 5-5" />
                  </svg>
                ) : (
                  i + 1
                )}
              </div>
              {/* Connector line */}
              {i < steps.length - 1 && (
                <div
                  className={cn(
                    "w-px h-6 mt-1",
                    isComplete ? "bg-green-500/30 shadow-[0_0_4px_rgba(124,179,66,0.3)]" : "bg-white/[0.06]",
                  )}
                />
              )}
            </div>

            {/* Label */}
            <div className="pt-0.5">
              <div
                className={cn(
                  "text-xs font-medium",
                  isCurrent ? "text-green-300" : isComplete ? "text-white/60" : "text-white/25",
                )}
              >
                {step.label}
              </div>
              {step.description && (
                <div className="text-[10px] text-white/20 mt-0.5">{step.description}</div>
              )}
            </div>
          </button>
        );
      })}
    </nav>
  );
}
