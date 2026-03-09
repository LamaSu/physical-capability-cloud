import React from "react";
import { WizardStepContent, CertificationBadge } from "@pcc/ui";
import { useOnboardWizardStore } from "../../stores/onboard-wizard-store.js";
import { mockCertifications } from "../../api/mock-onboarding-data.js";

const baseInput = "w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 placeholder:text-white/20 focus:border-green-500/30 focus:outline-none transition-colors";

const trainingItems = [
  { key: "safety-basics", label: "Safety Basics Training" },
  { key: "fire-protocol", label: "Fire & Emergency Protocol" },
  { key: "evidence-collection", label: "Evidence Collection Standards" },
];

export function Step6_Operator() {
  const { operatorName, setOperatorName, certifications, addCertification, trainingAcknowledgments, setTrainingAck, nextStep, prevStep, isStepValid } =
    useOnboardWizardStore();

  React.useEffect(() => {
    if (certifications.length === 0) {
      mockCertifications.forEach((c) => addCertification(c));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <WizardStepContent
      title="Operator Profile"
      subtitle="Confirm your identity, certifications, and training."
      onBack={prevStep}
      onNext={nextStep}
      nextDisabled={!isStepValid(5)}
    >
      <div className="space-y-6 max-w-lg">
        <div>
          <label className="text-xs text-white/40 mb-1 block">Display Name *</label>
          <input
            className={baseInput}
            placeholder="Your operator name"
            value={operatorName}
            onChange={(e) => setOperatorName(e.target.value)}
          />
        </div>

        {/* Certifications */}
        <div className="space-y-2">
          <span className="text-xs text-white/30">Certifications</span>
          {certifications.map((c) => (
            <CertificationBadge
              key={c.id}
              name={c.name}
              issuer={c.issuer}
              expiresAt={c.expiresAt}
              status={c.status}
            />
          ))}
        </div>

        {/* Training Acknowledgments */}
        <div className="space-y-2">
          <span className="text-xs text-white/30">Training Acknowledgments</span>
          {trainingItems.map((t) => (
            <label key={t.key} className="flex items-center gap-3 cursor-pointer group">
              <div
                onClick={() => setTrainingAck(t.key, !trainingAcknowledgments[t.key])}
                className={`w-4 h-4 rounded border transition-all cursor-pointer ${
                  trainingAcknowledgments[t.key]
                    ? "bg-green-500/30 border-green-500/40"
                    : "border-white/[0.12] group-hover:border-white/20"
                }`}
              >
                {trainingAcknowledgments[t.key] && (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#7CB342" strokeWidth="2" strokeLinecap="round">
                    <path d="M4 8l3 3 5-5" />
                  </svg>
                )}
              </div>
              <span className="text-xs text-white/50">{t.label}</span>
            </label>
          ))}
        </div>
      </div>
    </WizardStepContent>
  );
}
