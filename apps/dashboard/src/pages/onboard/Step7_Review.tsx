import React from "react";
import { WizardStepContent, GlassPanel, GlowBadge } from "@pcc/ui";
import { useOnboardWizardStore } from "../../stores/onboard-wizard-store.js";

export function Step7_Review() {
  const { identity, documents, capabilities, spaceRequirements, pricing, operatorName, certifications, prevStep } =
    useOnboardWizardStore();

  const handleSubmit = () => {
    // In production, this would call the gateway API
    alert("Machine registration submitted! (mock)");
  };

  return (
    <WizardStepContent
      title="Review & Submit"
      subtitle="Review your machine registration before submitting."
      onBack={prevStep}
      onNext={handleSubmit}
      nextLabel="Submit Registration"
    >
      <div className="space-y-4 max-w-xl">
        {/* Identity */}
        <GlassPanel padding="md" className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-white/50">Machine Identity</span>
            <GlowBadge color="green">{identity.category || "—"}</GlowBadge>
          </div>
          <div className="text-sm text-white/70">{identity.name || "—"}</div>
          <div className="text-xs text-white/30">
            {identity.manufacturer} {identity.model}
          </div>
        </GlassPanel>

        {/* Documents */}
        <GlassPanel padding="md" className="space-y-1">
          <span className="text-xs font-medium text-white/50">Documents</span>
          <div className="text-sm text-white/50">{documents.length} file(s) uploaded</div>
        </GlassPanel>

        {/* Capabilities */}
        <GlassPanel padding="md" className="space-y-2">
          <span className="text-xs font-medium text-white/50">Capabilities ({capabilities.length})</span>
          {capabilities.map((c) => (
            <div key={c.id} className="flex items-center gap-2">
              <GlowBadge color="green">{c.type}</GlowBadge>
              <span className="text-xs text-white/50">{c.name}</span>
            </div>
          ))}
        </GlassPanel>

        {/* Space */}
        {spaceRequirements && (
          <GlassPanel padding="md" className="space-y-1">
            <span className="text-xs font-medium text-white/50">Physical Space</span>
            <div className="text-xs text-white/40">
              {spaceRequirements.footprint.width} x {spaceRequirements.footprint.depth} x {spaceRequirements.footprint.height} {spaceRequirements.footprint.unit}
              {" | "}{spaceRequirements.power.voltage}V {spaceRequirements.power.phase}ph
              {" | "}{spaceRequirements.weight.value} {spaceRequirements.weight.unit}
            </div>
          </GlassPanel>
        )}

        {/* Pricing */}
        {pricing && (
          <GlassPanel padding="md" className="space-y-1">
            <span className="text-xs font-medium text-white/50">Pricing</span>
            <div className="text-xs text-white/40">
              Base: ${pricing.baseCost} | Min: ${pricing.minimum} | {pricing.currency}
              {pricing.perMinute && ` | $${pricing.perMinute}/min`}
              {pricing.perGram && ` | $${pricing.perGram}/g`}
            </div>
          </GlassPanel>
        )}

        {/* Operator */}
        <GlassPanel padding="md" className="space-y-1">
          <span className="text-xs font-medium text-white/50">Operator</span>
          <div className="text-sm text-white/50">{operatorName || "—"}</div>
          <div className="text-xs text-white/30">{certifications.length} certification(s)</div>
        </GlassPanel>
      </div>
    </WizardStepContent>
  );
}
