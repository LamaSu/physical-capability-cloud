import React from "react";
import type { BuilderContract } from "@pcc/spec";
import { GlassPanel } from "../primitives/GlassPanel.js";
import { AmountDisplay } from "../primitives/AmountDisplay.js";
import { TierBadge } from "../primitives/TierBadge.js";
import { GlowBadge } from "../primitives/GlowBadge.js";
import { PricingImpactTag } from "./PricingImpactTag.js";
import type { AssuranceTier } from "@pcc/spec";

export interface ContractSummaryProps {
  contract: BuilderContract;
  className?: string;
}

export function ContractSummary({ contract, className }: ContractSummaryProps) {
  return (
    <GlassPanel padding="lg" glow={contract.isValid ? "green" : "none"} className={className}>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-white/80">{contract.templateName}</div>
            {contract.machineInfo && (
              <div className="text-xs text-white/30 font-mono mt-0.5">{contract.machineInfo.machineName}</div>
            )}
          </div>
          <GlowBadge color={contract.isValid ? "green" : "red"}>
            {contract.isValid ? "Valid" : "Invalid"}
          </GlowBadge>
        </div>

        {/* Total Price */}
        <div className="flex items-center justify-between py-3 border-y border-white/[0.06]">
          <span className="text-sm text-white/50">Total Price</span>
          <AmountDisplay amount={contract.totalPrice} size="lg" glow />
        </div>

        {/* Price Breakdown */}
        {contract.priceBreakdown.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] text-white/30 uppercase tracking-wider">Price Breakdown</div>
            {contract.priceBreakdown.map((item) => (
              <PricingImpactTag key={item.paramKey} item={item} />
            ))}
          </div>
        )}

        {/* CWM Step */}
        <div className="pt-2 border-t border-white/[0.06] space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-white/30 uppercase tracking-wider">CWM Step Output</span>
            <TierBadge tier={contract.cwmStep.assuranceTier as AssuranceTier} />
          </div>
          <div className="text-xs font-mono text-white/30 bg-white/[0.02] rounded-lg p-3 max-h-40 overflow-y-auto">
            <pre>{JSON.stringify(contract.cwmStep, null, 2)}</pre>
          </div>
        </div>

        {/* Validation errors */}
        {contract.validationErrors.length > 0 && (
          <div className="space-y-1">
            {contract.validationErrors.map((err, i) => (
              <div key={i} className="text-xs text-red-400/80 flex items-center gap-1.5">
                <span className="text-red-400/40">!</span>
                <span>{err.paramKey}: {err.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </GlassPanel>
  );
}
