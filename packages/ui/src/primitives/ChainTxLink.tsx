import React from "react";
import { cn } from "../utils.js";

export interface ChainTxLinkProps {
  txHash: string;
  chain: "base-sepolia" | "base" | "solana-devnet" | "solana" | "ethereum" | string;
  className?: string;
}

const explorers: Record<string, { name: string; urlPrefix: string }> = {
  "base-sepolia": { name: "BaseScan", urlPrefix: "https://sepolia.basescan.org/tx/" },
  base: { name: "BaseScan", urlPrefix: "https://basescan.org/tx/" },
  ethereum: { name: "Etherscan", urlPrefix: "https://etherscan.io/tx/" },
  "solana-devnet": { name: "Solana Explorer", urlPrefix: "https://explorer.solana.com/tx/?cluster=devnet&tx=" },
  solana: { name: "Solana Explorer", urlPrefix: "https://explorer.solana.com/tx/" },
};

const chainColors: Record<string, string> = {
  "base-sepolia": "text-blue-400 border-blue-500/20 bg-blue-500/10",
  base: "text-blue-400 border-blue-500/20 bg-blue-500/10",
  ethereum: "text-purple-400 border-purple-500/20 bg-purple-500/10",
  "solana-devnet": "text-green-400 border-green-500/20 bg-green-500/10",
  solana: "text-green-400 border-green-500/20 bg-green-500/10",
};

export function ChainTxLink({ txHash, chain, className }: ChainTxLinkProps) {
  const explorer = explorers[chain];
  const shortHash = txHash.length > 16 ? `${txHash.slice(0, 8)}...${txHash.slice(-6)}` : txHash;
  const color = chainColors[chain] ?? "text-white/60 border-white/10 bg-white/5";

  const content = (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-mono transition-colors",
        color,
        explorer && "hover:bg-white/10 cursor-pointer",
        className,
      )}
      title={`${chain}: ${txHash}`}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M7 7h.01" />
        <path d="M17 7h.01" />
        <path d="M7 17h.01" />
        <path d="M17 17h.01" />
        <path d="M12 12h.01" />
      </svg>
      <span>{shortHash}</span>
    </span>
  );

  if (!explorer) return content;

  return (
    <a href={`${explorer.urlPrefix}${txHash}`} target="_blank" rel="noopener noreferrer">
      {content}
    </a>
  );
}
