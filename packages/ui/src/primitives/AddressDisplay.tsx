import React from "react";
import { cn, formatAddress } from "../utils.js";

export interface AddressDisplayProps {
  address: string;
  chars?: number;
  className?: string;
}

export function AddressDisplay({ address, chars = 4, className }: AddressDisplayProps) {
  return (
    <code
      className={cn("font-mono text-xs text-green-400/70 bg-white/[0.04] rounded px-1.5 py-0.5", className)}
      title={address}
    >
      {formatAddress(address, chars)}
    </code>
  );
}
