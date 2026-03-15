import React from "react";
import { WizardShell, WizardStepRail, OnboardingAIBubble } from "@pcc/ui";
import type { WizardStep } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useOnboardWizardStore } from "../stores/onboard-wizard-store.js";
import { Step1_MachineIdentity } from "./onboard/Step1_MachineIdentity.js";
import { Step2_Documentation } from "./onboard/Step2_Documentation.js";
import { Step3_Capabilities } from "./onboard/Step3_Capabilities.js";
import { Step4_PhysicalSpace } from "./onboard/Step4_PhysicalSpace.js";
import { Step5_Pricing } from "./onboard/Step5_Pricing.js";
import { Step6_Operator } from "./onboard/Step6_Operator.js";
import { Step7_Review } from "./onboard/Step7_Review.js";

const wizardSteps: WizardStep[] = [
  { id: "identity", label: "Machine Identity", description: "Name, type, manufacturer" },
  { id: "docs", label: "Documentation", description: "Upload for AI analysis" },
  { id: "capabilities", label: "Capabilities", description: "What it can do" },
  { id: "space", label: "Physical Space", description: "Footprint & power" },
  { id: "pricing", label: "Pricing", description: "Rates & ROI" },
  { id: "operator", label: "Operator", description: "Profile & certs" },
  { id: "review", label: "Review", description: "Submit registration" },
];

const aiMessages = [
  { id: "1", content: "Welcome! I'll help you register your machine on the PCCP network. Start by entering your machine details.", timestamp: "now" },
  { id: "2", content: "Tip: Upload manufacturer datasheets in step 2 and I'll automatically extract capabilities, tolerances, and materials.", suggestions: ["Upload a PDF datasheet", "Skip to manual entry"], timestamp: "now" },
];

const stepComponents = [
  Step1_MachineIdentity,
  Step2_Documentation,
  Step3_Capabilities,
  Step4_PhysicalSpace,
  Step5_Pricing,
  Step6_Operator,
  Step7_Review,
];

export function OnboardWizardPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { step, setStep } = useOnboardWizardStore();

  React.useEffect(() => {
    setPageMeta("Machine Onboarding", `Step ${step + 1} of ${wizardSteps.length}`);
  }, [setPageMeta, step]);

  const StepComponent = stepComponents[step];

  return (
    <div className="h-[calc(100vh-120px)] -m-6">
      <WizardShell
        stepRail={<WizardStepRail steps={wizardSteps} currentStep={step} onStepClick={setStep} />}
        content={<StepComponent />}
        aiSidebar={
          <div className="p-4 space-y-4">
            <div className="text-[10px] text-white/20 font-mono uppercase tracking-wider mb-2">
              AI Assistant
            </div>
            {aiMessages.map((m) => (
              <OnboardingAIBubble key={m.id} content={m.content} suggestions={m.suggestions} timestamp={m.timestamp} />
            ))}
          </div>
        }
      />
    </div>
  );
}
