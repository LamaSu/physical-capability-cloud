import React from "react";
import { cn } from "../utils.js";

export interface DIDBadgeProps {
  did: string;
  className?: string;
}

const typeColors: Record<string, string> = {
  kernel: "text-green-400 bg-green-500/10 border-green-500/20",
  device: "text-blue-400 bg-blue-500/10 border-blue-500/20",
  operator: "text-purple-400 bg-purple-500/10 border-purple-500/20",
  agent: "text-gold-300 bg-gold-400/10 border-gold-400/20",
  key: "text-white/60 bg-white/5 border-white/10",
};

const typeIcons: Record<string, string> = {
  kernel: "\u{1F5A5}",    // desktop computer
  device: "\u{2699}",     // gear
  operator: "\u{1F464}",  // bust
  agent: "\u{1F916}",     // robot
  key: "\u{1F511}",       // key
};

function parseDID(did: string): { method: string; type: string; id: string } {
  const parts = did.split(":");
  if (parts.length >= 4 && parts[0] === "did" && parts[1] === "pcc") {
    return { method: "pcc", type: parts[2], id: parts.slice(3).join(":") };
  }
  if (parts.length >= 3 && parts[0] === "did" && parts[1] === "key") {
    const keyPart = parts.slice(2).join(":");
    return { method: "key", type: "key", id: keyPart.slice(0, 12) + "..." };
  }
  return { method: parts[1] ?? "unknown", type: "key", id: parts.slice(2).join(":") };
}

export function DIDBadge({ did, className }: DIDBadgeProps) {
  const { method, type, id } = parseDID(did);
  const color = typeColors[type] ?? typeColors.key;
  const icon = typeIcons[type] ?? "\u{1F310}";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-mono",
        color,
        className,
      )}
      title={did}
    >
      <span>{icon}</span>
      <span className="opacity-50">did:{method}:</span>
      <span className="font-medium">{type === "key" ? id : `${type}:${id}`}</span>
    </span>
  );
}
