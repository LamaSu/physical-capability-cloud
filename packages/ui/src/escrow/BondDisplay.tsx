import React from "react";
import type { BondConfig, AssuranceTier } from "@pcc/spec";
import { cn } from "../utils.js";

export interface BondDisplayProps {
  config: BondConfig;
  milestoneAmount?: string;
  className?: string;
}

export function BondDisplay({ config, milestoneAmount, className }: BondDisplayProps) {
  const amount = milestoneAmount ? parseFloat(milestoneAmount) : 0;
  const operatorBond = amount * (config.operatorBondPercent / 100);
  const challengerBond = amount * (config.challengerBondPercent / 100);
  const challengeHours = config.challengeWindowSeconds / 3600;

  return (
    <div className={cn("space-y-2", className)}>
      <div className="text-[10px] text-white/30 uppercase tracking-wider">
        Tier {config.tier} Bond Config
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="p-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
          <div className="text-white/30">Operator Bond</div>
          <div className="font-mono text-white/60">{config.operatorBondPercent}%</div>
          {amount > 0 && <div className="text-[10px] text-green-400/50 font-mono">${operatorBond.toFixed(2)}</div>}
        </div>
        <div className="p-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
          <div className="text-white/30">Challenger Bond</div>
          <div className="font-mono text-white/60">{config.challengerBondPercent}%</div>
          {amount > 0 && <div className="text-[10px] text-gold-300/50 font-mono">${challengerBond.toFixed(2)}</div>}
        </div>
        <div className="p-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
          <div className="text-white/30">Challenge Window</div>
          <div className="font-mono text-white/60">{challengeHours}h</div>
        </div>
        <div className="p-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
          <div className="text-white/30">Slash Rate</div>
          <div className="font-mono text-red-400/60">{config.slashPercent}%</div>
        </div>
      </div>
    </div>
  );
}
