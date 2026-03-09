import React from "react";
import { WizardStepContent, MarketRateCard, ROIProjectionChart } from "@pcc/ui";
import { useOnboardWizardStore } from "../../stores/onboard-wizard-store.js";
import { mockPricingConfig, generateROIProjection } from "../../api/mock-onboarding-data.js";

const baseInput = "w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 placeholder:text-white/20 focus:border-green-500/30 focus:outline-none transition-colors";

export function Step5_Pricing() {
  const { pricing, setPricing, nextStep, prevStep, isStepValid } = useOnboardWizardStore();

  const p = pricing ?? mockPricingConfig;

  React.useEffect(() => {
    if (!pricing) setPricing(mockPricingConfig);
  }, [pricing, setPricing]);

  const baseCostNum = parseFloat(p.baseCost) || 0;
  const roiData = generateROIProjection(200, baseCostNum, 65);
  const breakEven = roiData.find((d) => d.netPosition >= 0)?.month;

  return (
    <WizardStepContent
      title="Pricing"
      subtitle="Set your rates and see how they compare to the network."
      onBack={prevStep}
      onNext={nextStep}
      nextDisabled={!isStepValid(4)}
    >
      <div className="space-y-6 max-w-xl">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-white/40 mb-1 block">Base Cost (USDC)</label>
            <input className={baseInput} type="number" step="0.01" value={p.baseCost} readOnly />
          </div>
          <div>
            <label className="text-xs text-white/40 mb-1 block">Minimum (USDC)</label>
            <input className={baseInput} type="number" step="0.01" value={p.minimum} readOnly />
          </div>
          <div>
            <label className="text-xs text-white/40 mb-1 block">Per Minute</label>
            <input className={baseInput} type="number" step="0.01" value={p.perMinute ?? ""} readOnly />
          </div>
          <div>
            <label className="text-xs text-white/40 mb-1 block">Per Gram</label>
            <input className={baseInput} type="number" step="0.01" value={p.perGram ?? ""} readOnly />
          </div>
        </div>

        <MarketRateCard
          yourRate={baseCostNum}
          networkAvg={28.5}
          networkLow={5}
          networkHigh={50}
          demandLevel="high"
          onApplyRate={(rate: number) => setPricing({ ...p, baseCost: rate.toFixed(2) })}
        />

        <ROIProjectionChart data={roiData} breakEvenMonth={breakEven} />
      </div>
    </WizardStepContent>
  );
}
