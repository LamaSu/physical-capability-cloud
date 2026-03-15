import React from "react";
import { useParams } from "react-router-dom";
import {
  GlassPanel, AmountDisplay, TierBadge, GlowBadge,
  ParamGroup, ContractSummary, PriceBreakdownChart,
} from "@pcc/ui";
import type { CapabilityType, AssuranceTier } from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { useBuilderStore } from "../stores/builder-store.js";

const processIcons: Record<string, string> = {
  hplc: "🧪",
  pcr: "🧬",
  microscopy: "🔬",
  "mass-spec": "⚗️",
  sequencing: "🧬",
  "2d-print": "🖨️",
  assembly: "🔧",
  fdm: "🏭",
  sla: "💧",
  "cnc-3axis": "⚙️",
  "laser-cut": "✂️",
};

const processDescriptions: Record<string, string> = {
  hplc: "High-Performance Liquid Chromatography — compound purity and separation analysis",
  pcr: "Polymerase Chain Reaction — DNA/RNA amplification and detection",
  microscopy: "Optical/Confocal Microscopy — high-resolution cellular and tissue imaging",
  "mass-spec": "Mass Spectrometry — molecular weight and structure identification",
  sequencing: "DNA/RNA Sequencing — genome and transcriptome analysis",
  "2d-print": "Large Format Printing — posters, reports, and documentation",
  assembly: "Assembly/Framing — manual or robot-assisted assembly tasks",
  fdm: "Fused Deposition Modeling — layer-by-layer thermoplastic extrusion",
  sla: "Stereolithography — UV-cured resin for fine details",
  "cnc-3axis": "3-axis CNC milling — subtractive machining for metal and plastic",
  "laser-cut": "Laser cutting — 2D sheet cutting with high precision",
};

export function BuilderPage() {
  const { type: urlType } = useParams();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const {
    selectedType, availableTypes, resolvedOptions, selections, contract,
    assuranceTier, selectType, updateSelection, setAssuranceTier, buildContract, reset,
  } = useBuilderStore();

  React.useEffect(() => {
    setPageMeta("Build Contract", "Configure capability parameters and pricing");
  }, [setPageMeta]);

  React.useEffect(() => {
    if (urlType && availableTypes.includes(urlType as CapabilityType) && urlType !== selectedType) {
      selectType(urlType as CapabilityType);
    }
  }, [urlType, availableTypes, selectedType, selectType]);

  // Compute live pricing
  const builder = useBuilderStore((s) => s.builder);
  const profileId = useBuilderStore((s) => s.profileId);
  const livePrice = React.useMemo(() => {
    if (!selectedType) return null;
    try {
      return builder.calculatePrice(selectedType, selections, profileId);
    } catch {
      return null;
    }
  }, [builder, selectedType, selections, profileId]);

  if (!selectedType) {
    return (
      <div className="space-y-6">
        <GlassPanel padding="lg">
          <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Select Process</h2>
          <div className="grid grid-cols-4 gap-3">
            {availableTypes.map((type) => (
              <GlassPanel
                key={type}
                hover
                padding="lg"
                className="text-center cursor-pointer"
                onClick={() => selectType(type)}
              >
                <div className="text-3xl mb-2">{processIcons[type] ?? "🔧"}</div>
                <div className="text-sm font-medium text-white/80">{type.toUpperCase().replace("-", " ")}</div>
                <div className="text-xs text-white/40 mt-1">{processDescriptions[type] ?? ""}</div>
              </GlassPanel>
            ))}
          </div>
        </GlassPanel>
      </div>
    );
  }

  return (
    <div className="flex gap-6">
      {/* Left: Parameter form */}
      <div className="flex-1 space-y-6">
        {/* Type header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{processIcons[selectedType] ?? "🔧"}</span>
            <div>
              <h2 className="text-lg font-semibold text-white/90">
                {resolvedOptions?.templateName ?? selectedType.toUpperCase()}
              </h2>
              <span className="text-xs text-white/30 font-mono">v{resolvedOptions?.templateVersion ?? "1.0"}</span>
            </div>
          </div>
          <button
            onClick={reset}
            className="text-xs text-white/30 hover:text-white/50 transition-colors"
          >
            ← Change process
          </button>
        </div>

        {/* Parameter groups */}
        {resolvedOptions?.groups.map((group) => (
          <GlassPanel key={group.name} padding="lg">
            <ParamGroup group={group} selections={selections} onChange={updateSelection} />
          </GlassPanel>
        ))}

        {/* Assurance Tier selector */}
        <GlassPanel padding="lg">
          <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-3">Assurance Tier</h3>
          <div className="flex gap-2">
            {([0, 1, 2, 3] as AssuranceTier[]).map((tier) => (
              <button
                key={tier}
                onClick={() => setAssuranceTier(tier)}
                className={`flex-1 py-2 rounded-lg border text-sm transition-all ${
                  assuranceTier === tier
                    ? "bg-green-500/15 border-green-500/30 text-green-400"
                    : "bg-white/[0.02] border-white/[0.06] text-white/40 hover:border-white/[0.12]"
                }`}
              >
                <TierBadge tier={tier} />
              </button>
            ))}
          </div>
        </GlassPanel>

        {/* Build button */}
        <button
          onClick={buildContract}
          className="w-full py-3 rounded-xl bg-green-500/20 border border-green-500/30 text-green-400 font-semibold text-sm hover:bg-green-500/30 hover:shadow-[0_0_20px_rgba(124,179,66,0.2)] transition-all"
        >
          Build Contract
        </button>
      </div>

      {/* Right: Live pricing + contract summary */}
      <div className="w-80 space-y-4 flex-shrink-0">
        {/* Live price */}
        <GlassPanel padding="lg" glow="green" className="sticky top-6">
          <div className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Live Price</div>
          <AmountDisplay
            amount={livePrice ? String(livePrice.totalPrice) : resolvedOptions?.basePrice ?? "0.00"}
            size="xl"
            glow
          />
          <div className="text-xs text-white/30 mt-1 font-mono">
            Base: ${resolvedOptions?.basePrice ?? "0.00"}
          </div>

          {/* Breakdown */}
          {livePrice && livePrice.breakdown.length > 0 && (
            <div className="mt-4 pt-4 border-t border-white/[0.06]">
              <PriceBreakdownChart
                breakdown={livePrice.breakdown}
                basePrice={resolvedOptions?.basePrice ?? "0.00"}
                totalPrice={String(livePrice.totalPrice)}
              />
            </div>
          )}
        </GlassPanel>

        {/* Machine info */}
        {resolvedOptions?.machineInfo && (
          <GlassPanel padding="md">
            <div className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Machine</div>
            <div className="text-sm text-white/70">{resolvedOptions.machineInfo.machineName}</div>
            <div className="text-xs text-white/30 font-mono">{resolvedOptions.machineInfo.kernelId}</div>
          </GlassPanel>
        )}

        {/* Contract output */}
        {contract && (
          <ContractSummary contract={contract} />
        )}
      </div>
    </div>
  );
}
