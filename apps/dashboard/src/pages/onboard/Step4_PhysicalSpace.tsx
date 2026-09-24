import React from "react";
import { WizardStepContent } from "@pcc/ui";
import { useOnboardWizardStore } from "../../stores/onboard-wizard-store.js";

// PX-10 Wave 0. This step used to fill in example footprint, power and
// environment values (mock data) as the user's machine, in read-only fields,
// and they then flowed into the review as if the user had entered them. The
// wizard does not collect these yet, so the step says so and saves nothing.
export function Step4_PhysicalSpace() {
  const { nextStep, prevStep } = useOnboardWizardStore();

  return (
    <WizardStepContent
      title="Physical Space"
      subtitle="Footprint, power and environmental needs."
      onBack={prevStep}
      onNext={nextStep}
    >
      <div className="max-w-xl rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 space-y-2">
        <p className="text-sm text-white/70">This wizard doesn't collect space requirements yet.</p>
        <p className="text-xs text-white/40">
          Describe your machine's footprint, power and environmental needs in the onboarding chat
          at the end of the wizard. Nothing on this step is saved or sent.
        </p>
      </div>
    </WizardStepContent>
  );
}
