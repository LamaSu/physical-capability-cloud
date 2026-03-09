import React from "react";
import { cn, formatHash } from "../utils.js";

export interface HashDisplayProps {
  hash: string;
  chars?: number;
  className?: string;
}

export function HashDisplay({ hash, chars = 8, className }: HashDisplayProps) {
  const display = hash.startsWith("sha256:") ? `sha256:${formatHash(hash.slice(7), chars)}` : formatHash(hash, chars);
  return (
    <code
      className={cn("font-mono text-xs text-white/40 bg-white/[0.04] rounded px-1.5 py-0.5", className)}
      title={hash}
    >
      {display}
    </code>
  );
}
