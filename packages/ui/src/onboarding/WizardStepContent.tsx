import React from "react";
import { cn } from "../utils.js";

export interface WizardStepContentProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  backLabel?: string;
  nextDisabled?: boolean;
  className?: string;
}

export function WizardStepContent({
  title,
  subtitle,
  children,
  onBack,
  onNext,
  nextLabel = "Continue",
  backLabel = "Back",
  nextDisabled = false,
  className,
}: WizardStepContentProps) {
  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-white/90">{title}</h2>
        {subtitle && <p className="text-sm text-white/40 mt-1">{subtitle}</p>}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>

      {/* Actions */}
      <div className="flex items-center justify-between mt-6 pt-4 border-t border-white/[0.06]">
        {onBack ? (
          <button
            onClick={onBack}
            className="px-4 py-2 rounded-lg text-sm text-white/30 hover:text-white/60 transition-colors"
          >
            &larr; {backLabel}
          </button>
        ) : (
          <div />
        )}
        {onNext && (
          <button
            onClick={onNext}
            disabled={nextDisabled}
            className={cn(
              "px-6 py-2 rounded-lg text-sm font-medium transition-all",
              nextDisabled
                ? "bg-white/[0.04] text-white/20 cursor-not-allowed"
                : "bg-green-500/20 border border-green-500/30 text-green-400 hover:bg-green-500/30",
            )}
          >
            {nextLabel} &rarr;
          </button>
        )}
      </div>
    </div>
  );
}
