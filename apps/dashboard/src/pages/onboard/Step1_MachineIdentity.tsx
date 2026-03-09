import React from "react";
import { WizardStepContent } from "@pcc/ui";
import { useOnboardWizardStore } from "../../stores/onboard-wizard-store.js";

const baseInput = "w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 placeholder:text-white/20 focus:border-green-500/30 focus:outline-none transition-colors";

export function Step1_MachineIdentity() {
  const { identity, updateIdentity, nextStep, isStepValid } = useOnboardWizardStore();

  return (
    <WizardStepContent
      title="Machine Identity"
      subtitle="Tell us about your machine — name, manufacturer, and category."
      onNext={nextStep}
      nextDisabled={!isStepValid(0)}
    >
      <div className="space-y-4 max-w-lg">
        <div>
          <label className="text-xs text-white/40 mb-1 block">Machine Name *</label>
          <input
            className={baseInput}
            placeholder="e.g., Prusa MK4 Workshop"
            value={identity.name}
            onChange={(e) => updateIdentity({ name: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">Category *</label>
          <input
            className={baseInput}
            placeholder="e.g., fdm, cnc-3axis, bio-reactor, microfluidics..."
            value={identity.category}
            onChange={(e) => updateIdentity({ category: e.target.value })}
          />
          <p className="text-[10px] text-white/15 mt-1">Any string — use existing types or define new ones</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-white/40 mb-1 block">Manufacturer *</label>
            <input
              className={baseInput}
              placeholder="e.g., Prusa Research"
              value={identity.manufacturer}
              onChange={(e) => updateIdentity({ manufacturer: e.target.value })}
            />
          </div>
          <div>
            <label className="text-xs text-white/40 mb-1 block">Model</label>
            <input
              className={baseInput}
              placeholder="e.g., MK4"
              value={identity.model}
              onChange={(e) => updateIdentity({ model: e.target.value })}
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">Serial Number</label>
          <input
            className={baseInput}
            placeholder="Optional"
            value={identity.serialNumber}
            onChange={(e) => updateIdentity({ serialNumber: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">Description</label>
          <textarea
            className={`${baseInput} min-h-[80px] resize-y`}
            placeholder="Brief description of what this machine does..."
            value={identity.description}
            onChange={(e) => updateIdentity({ description: e.target.value })}
          />
        </div>
      </div>
    </WizardStepContent>
  );
}
