import React from "react";
import { cn } from "../utils.js";

export interface CertificationBadgeProps {
  name: string;
  issuer: string;
  expiresAt: string;
  status: "valid" | "expiring" | "expired";
  className?: string;
}

const statusStyles = {
  valid: { ring: "border-green-500/30", dot: "bg-green-500", text: "text-green-400/70", label: "Valid" },
  expiring: { ring: "border-yellow-500/30", dot: "bg-yellow-500", text: "text-yellow-400/70", label: "Expiring" },
  expired: { ring: "border-red-500/30", dot: "bg-red-500/60", text: "text-red-400/60", label: "Expired" },
};

export function CertificationBadge({ name, issuer, expiresAt, status, className }: CertificationBadgeProps) {
  const s = statusStyles[status];

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2 rounded-lg border bg-white/[0.02]",
        s.ring,
        className,
      )}
    >
      {/* Status dot */}
      <div className={cn("w-2 h-2 rounded-full shrink-0", s.dot)} />

      <div className="flex-1 min-w-0">
        <div className="text-xs text-white/70 truncate">{name}</div>
        <div className="text-[10px] text-white/25">{issuer}</div>
      </div>

      <div className="text-right shrink-0">
        <div className={cn("text-[10px] font-medium", s.text)}>{s.label}</div>
        <div className="text-[9px] text-white/15 font-mono">
          {new Date(expiresAt).toLocaleDateString()}
        </div>
      </div>
    </div>
  );
}
