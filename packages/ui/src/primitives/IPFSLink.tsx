import React from "react";
import { cn } from "../utils.js";

export interface IPFSLinkProps {
  cid: string;
  label?: string;
  gateway?: string;
  className?: string;
}

export function IPFSLink({
  cid,
  label,
  gateway = "https://dweb.link/ipfs",
  className,
}: IPFSLinkProps) {
  const shortCid = cid.length > 16 ? `${cid.slice(0, 8)}...${cid.slice(-6)}` : cid;
  const href = `${gateway}/${cid}`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1.5 rounded border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-xs font-mono text-blue-400 hover:bg-blue-500/20 transition-colors",
        className,
      )}
      title={`IPFS: ${cid}`}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2" />
        <line x1="12" y1="22" x2="12" y2="15.5" />
        <polyline points="22 8.5 12 15.5 2 8.5" />
      </svg>
      <span>{label ?? shortCid}</span>
    </a>
  );
}
