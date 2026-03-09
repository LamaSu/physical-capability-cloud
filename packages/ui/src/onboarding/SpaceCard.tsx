import React from "react";
import { cn } from "../utils.js";
import { GlassPanel } from "../primitives/GlassPanel.js";
import { GlowBadge } from "../primitives/GlowBadge.js";

export interface SpaceCardProps {
  name: string;
  address: string;
  monthlyPrice: string;
  currency?: string;
  availableSlots: number;
  totalSlots: number;
  amenities: string[];
  power: { voltage: number; amperage: number; phase: 1 | 3 };
  rating: number;
  matchScore?: number;
  accessSchedule: string;
  onClick?: () => void;
  className?: string;
}

export function SpaceCard({
  name,
  address,
  monthlyPrice,
  currency = "USDC",
  availableSlots,
  totalSlots,
  amenities,
  power,
  rating,
  matchScore,
  accessSchedule,
  onClick,
  className,
}: SpaceCardProps) {
  return (
    <GlassPanel hover={!!onClick} padding="md" className={cn("space-y-3", className)} onClick={onClick}>
      <div className="flex items-start justify-between">
        <div>
          <h4 className="text-sm font-medium text-white/80">{name}</h4>
          <p className="text-[10px] text-white/30 mt-0.5">{address}</p>
        </div>
        {matchScore != null && (
          <GlowBadge color={matchScore >= 80 ? "green" : matchScore >= 50 ? "gold" : "gray"}>
            {matchScore}% match
          </GlowBadge>
        )}
      </div>

      <div className="grid grid-cols-4 gap-2 text-center">
        <div>
          <div className="text-[10px] text-white/20">Price/mo</div>
          <div className="text-xs font-mono text-green-400">${monthlyPrice}</div>
        </div>
        <div>
          <div className="text-[10px] text-white/20">Slots</div>
          <div className="text-xs font-mono text-white/50">{availableSlots}/{totalSlots}</div>
        </div>
        <div>
          <div className="text-[10px] text-white/20">Power</div>
          <div className="text-xs font-mono text-white/50">{power.voltage}V/{power.phase}ph</div>
        </div>
        <div>
          <div className="text-[10px] text-white/20">Rating</div>
          <div className="text-xs font-mono text-yellow-400">{rating.toFixed(1)}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {amenities.slice(0, 5).map((a) => (
          <span key={a} className="text-[9px] px-1.5 py-0.5 rounded bg-white/[0.03] border border-white/[0.06] text-white/25">
            {a}
          </span>
        ))}
        {amenities.length > 5 && (
          <span className="text-[9px] px-1.5 py-0.5 text-white/15">+{amenities.length - 5}</span>
        )}
      </div>

      <div className="text-[10px] text-white/15 font-mono">{accessSchedule}</div>
    </GlassPanel>
  );
}
