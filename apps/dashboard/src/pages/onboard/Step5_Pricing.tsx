import React from "react";
import { WizardStepContent } from "@pcc/ui";
import { useOnboardWizardStore } from "../../stores/onboard-wizard-store.js";
import { withPriceField, type PriceField } from "./wizard-draft.js";

const baseInput = "w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 placeholder:text-white/20 focus:border-green-500/30 focus:outline-none transition-colors";

// PX-10 Wave 0 (product-steward #2561). This step used to fill the user's
// pricing with example values in read-only fields, compare it with an invented
// network average that one click applied to the user's own price, and chart a
// return on investment from made-up volumes. No network rate data exists yet,
// so the step records only what the user types.

const FIELDS: Array<{ key: PriceField; label: string; required: boolean }> = [
  { key: "baseCost", label: "Base Cost (USDC)", required: true },
  { key: "minimum", label: "Minimum (USDC)", required: false },
  { key: "perMinute", label: "Per Minute (USDC)", required: false },
  { key: "perGram", label: "Per Gram (USDC)", required: false },
];

export function Step5_Pricing() {
  const { pricing, setPricing, nextStep, prevStep, isStepValid } = useOnboardWizardStore();

  return (
    <WizardStepContent
      title="Pricing"
      subtitle="Set your rates. You can change them later."
      onBack={prevStep}
      onNext={nextStep}
      nextDisabled={!isStepValid(4)}
    >
      <div className="space-y-4 max-w-xl">
        <div className="grid grid-cols-2 gap-3">
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label className="text-xs text-white/40 mb-1 block">
                {f.label}
                {f.required ? " *" : ""}
              </label>
              <input
                className={baseInput}
                type="number"
                min="0"
                step="0.01"
                value={pricing?.[f.key] ?? ""}
                onChange={(e) => setPricing(withPriceField(pricing, f.key, e.target.value))}
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-white/30">Network rate comparisons aren't available yet.</p>
      </div>
    </WizardStepContent>
  );
}
