import React from "react";
import { WizardStepContent, GlassPanel, GlowBadge } from "@pcc/ui";
import { useOnboardWizardStore } from "../../stores/onboard-wizard-store.js";
import { OnboardHandoffPanel } from "../../components/onboard/OnboardHandoffPanel.js";
import { wizardDraft } from "./wizard-draft.js";

// ---------------------------------------------------------------------------
// PX-10 Wave 0 (product-steward #2386, QA #32). This step used to register the
// machine with a placeholder adapter onto a kernel that did not exist, and to
// report an "offline success" with an invented device id when the gateway was
// unreachable. The wizard cannot register a machine yet, so it registers
// nothing: the user reviews what they entered, and it goes to /onboard/chat.
// ---------------------------------------------------------------------------

export function Step7_Review() {
  const {
    identity,
    documents,
    capabilities,
    pricing,
    operatorName,
    certifications,
    prevStep,
  } = useOnboardWizardStore();

  const [handedOff, setHandedOff] = React.useState(false);

  if (handedOff) {
    return (
      <WizardStepContent
        title="Not registered yet"
        subtitle="This wizard can't register machines yet. Nothing was sent."
        onBack={() => setHandedOff(false)}
      >
        <div className="max-w-xl">
          <OnboardHandoffPanel
            machineLabel={identity.name || undefined}
            draft={wizardDraft({ identity, documents, capabilities, pricing, operatorName, certifications })}
          />
        </div>
      </WizardStepContent>
    );
  }

  return (
    <WizardStepContent
      title="Review"
      subtitle="Check what you entered. Nothing has been registered."
      onBack={prevStep}
      onNext={() => setHandedOff(true)}
      nextLabel="Continue"
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
          <div className="text-sm text-white/50">{documents.length} file(s) added</div>
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

        {/* Pricing */}
        {pricing && (
          <GlassPanel padding="md" className="space-y-1">
            <span className="text-xs font-medium text-white/50">Pricing</span>
            <div className="text-xs text-white/40">
              Base: {pricing.baseCost || "—"} | Min: {pricing.minimum || "—"} | {pricing.currency}
              {pricing.perMinute && ` | ${pricing.perMinute}/min`}
              {pricing.perGram && ` | ${pricing.perGram}/g`}
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
