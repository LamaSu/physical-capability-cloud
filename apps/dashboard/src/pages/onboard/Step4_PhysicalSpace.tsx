import React from "react";
import { WizardStepContent, WorkspaceLayoutEditor } from "@pcc/ui";
import { useOnboardWizardStore } from "../../stores/onboard-wizard-store.js";
import { mockSpaceRequirements } from "../../api/mock-onboarding-data.js";

const baseInput = "w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 placeholder:text-white/20 focus:border-green-500/30 focus:outline-none transition-colors";

export function Step4_PhysicalSpace() {
  const { spaceRequirements, setSpaceRequirements, nextStep, prevStep, isStepValid } =
    useOnboardWizardStore();

  const reqs = spaceRequirements ?? mockSpaceRequirements;

  React.useEffect(() => {
    if (!spaceRequirements) setSpaceRequirements(mockSpaceRequirements);
  }, [spaceRequirements, setSpaceRequirements]);

  return (
    <WizardStepContent
      title="Physical Space"
      subtitle="Define the workspace footprint, power requirements, and environmental needs."
      onBack={prevStep}
      onNext={nextStep}
      nextDisabled={!isStepValid(3)}
    >
      <div className="space-y-6 max-w-xl">
        {/* Layout preview */}
        <WorkspaceLayoutEditor
          footprint={{ width: reqs.footprint.width, depth: reqs.footprint.depth, unit: reqs.footprint.unit }}
          clearances={{ front: reqs.clearances.front, back: reqs.clearances.back, left: reqs.clearances.left, right: reqs.clearances.right }}
        />

        {/* Footprint inputs */}
        <div>
          <span className="text-xs text-white/30">Footprint (mm)</span>
          <div className="grid grid-cols-3 gap-3 mt-2">
            <div>
              <label className="text-[10px] text-white/20 mb-1 block">Width</label>
              <input className={baseInput} type="number" value={reqs.footprint.width} readOnly />
            </div>
            <div>
              <label className="text-[10px] text-white/20 mb-1 block">Depth</label>
              <input className={baseInput} type="number" value={reqs.footprint.depth} readOnly />
            </div>
            <div>
              <label className="text-[10px] text-white/20 mb-1 block">Height</label>
              <input className={baseInput} type="number" value={reqs.footprint.height} readOnly />
            </div>
          </div>
        </div>

        {/* Power */}
        <div>
          <span className="text-xs text-white/30">Power Requirements</span>
          <div className="grid grid-cols-3 gap-3 mt-2">
            <div>
              <label className="text-[10px] text-white/20 mb-1 block">Voltage</label>
              <input className={baseInput} type="number" value={reqs.power.voltage} readOnly />
            </div>
            <div>
              <label className="text-[10px] text-white/20 mb-1 block">Amperage</label>
              <input className={baseInput} type="number" value={reqs.power.amperage} readOnly />
            </div>
            <div>
              <label className="text-[10px] text-white/20 mb-1 block">Phase</label>
              <input className={baseInput} type="number" value={reqs.power.phase} readOnly />
            </div>
          </div>
        </div>

        {/* Environmental */}
        <div>
          <span className="text-xs text-white/30">Environmental</span>
          <div className="grid grid-cols-2 gap-3 mt-2">
            {[
              { label: "Ventilation", value: reqs.environmental.ventilationRequired },
              { label: "Dust Extraction", value: reqs.environmental.dustExtraction },
              { label: "Fume Extraction", value: reqs.environmental.fumeExtraction },
              { label: "Vibration Isolation", value: reqs.vibrationIsolation },
            ].map((item) => (
              <div key={item.label} className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded border ${item.value ? "bg-green-500/30 border-green-500/40" : "border-white/[0.08]"}`} />
                <span className="text-xs text-white/40">{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </WizardStepContent>
  );
}
