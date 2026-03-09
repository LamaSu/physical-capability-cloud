import React from "react";
import { WizardStepContent, CapabilitySuggestionCard, GlassPanel, GlowBadge } from "@pcc/ui";
import { useOnboardWizardStore } from "../../stores/onboard-wizard-store.js";

export function Step3_Capabilities() {
  const { aiSuggestions, capabilities, acceptSuggestion, rejectSuggestion, removeCapability, nextStep, prevStep, isStepValid } =
    useOnboardWizardStore();

  return (
    <WizardStepContent
      title="Capabilities"
      subtitle="Review AI suggestions and define what your machine can do."
      onBack={prevStep}
      onNext={nextStep}
      nextDisabled={!isStepValid(2)}
    >
      <div className="space-y-6 max-w-xl">
        {/* AI Suggestions */}
        {aiSuggestions.length > 0 && (
          <div className="space-y-3">
            <span className="text-xs text-white/30">AI Suggestions</span>
            {aiSuggestions.map((s) => (
              <CapabilitySuggestionCard
                key={s.id}
                name={s.name}
                type={s.type}
                description={s.description}
                confidence={s.confidence}
                materials={s.materials}
                sourceReason={s.sourceReason}
                onAccept={() => acceptSuggestion(s.id)}
                onReject={() => rejectSuggestion(s.id)}
              />
            ))}
          </div>
        )}

        {/* Accepted capabilities */}
        {capabilities.length > 0 && (
          <div className="space-y-3">
            <span className="text-xs text-white/30">Accepted Capabilities ({capabilities.length})</span>
            {capabilities.map((cap) => (
              <GlassPanel key={cap.id} padding="sm" glow="green" className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-white/70">{cap.name}</span>
                    <GlowBadge color="green">{cap.type}</GlowBadge>
                    {cap.source === "ai-suggested" && (
                      <span className="text-[9px] text-green-400/40 font-mono">AI</span>
                    )}
                  </div>
                  <p className="text-[10px] text-white/30 mt-0.5">{cap.materials.join(", ")}</p>
                </div>
                <button
                  onClick={() => removeCapability(cap.id)}
                  className="text-xs text-white/20 hover:text-red-400/60 transition-colors px-2"
                >
                  Remove
                </button>
              </GlassPanel>
            ))}
          </div>
        )}

        {aiSuggestions.length === 0 && capabilities.length === 0 && (
          <GlassPanel padding="lg" className="text-center">
            <p className="text-sm text-white/30">
              Upload documentation in the previous step to get AI-suggested capabilities,
              or add capabilities manually.
            </p>
          </GlassPanel>
        )}
      </div>
    </WizardStepContent>
  );
}
