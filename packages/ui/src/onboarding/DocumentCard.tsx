import React from "react";
import { cn } from "../utils.js";
import { GlassPanel } from "../primitives/GlassPanel.js";
import { GlowBadge } from "../primitives/GlowBadge.js";

export interface DocumentCardProps {
  filename: string;
  sizeBytes: number;
  mimeType: string;
  analysisStatus: "pending" | "analyzing" | "complete" | "failed";
  extractedInsights?: string[];
  className?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

const mimeIcons: Record<string, string> = {
  "application/pdf": "PDF",
  "image/png": "PNG",
  "image/jpeg": "JPG",
  "text/plain": "TXT",
  "text/csv": "CSV",
};

const statusConfig: Record<string, { label: string; color: "green" | "gold" | "gray" }> = {
  pending: { label: "Pending", color: "gray" },
  analyzing: { label: "Analyzing...", color: "gold" },
  complete: { label: "Complete", color: "green" },
  failed: { label: "Failed", color: "gray" },
};

export function DocumentCard({ filename, sizeBytes, mimeType, analysisStatus, extractedInsights, className }: DocumentCardProps) {
  const status = statusConfig[analysisStatus];
  const icon = mimeIcons[mimeType] ?? "DOC";

  return (
    <GlassPanel padding="sm" className={cn("flex items-start gap-3", className)}>
      {/* File type badge */}
      <div className="w-10 h-10 rounded-lg bg-white/[0.04] border border-white/[0.08] flex items-center justify-center shrink-0">
        <span className="text-[10px] font-mono font-bold text-white/30">{icon}</span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-white/70 truncate">{filename}</span>
          <GlowBadge color={status.color}>{status.label}</GlowBadge>
        </div>
        <span className="text-[10px] text-white/20">{formatBytes(sizeBytes)}</span>

        {analysisStatus === "analyzing" && (
          <div className="mt-2 flex items-center gap-2">
            <div className="w-4 h-4 border border-green-400/30 border-t-green-400 rounded-full animate-spin" />
            <span className="text-[10px] text-green-400/50">AI processing...</span>
          </div>
        )}

        {extractedInsights && extractedInsights.length > 0 && (
          <div className="mt-2 space-y-1">
            {extractedInsights.map((insight, i) => (
              <div key={i} className="text-[10px] text-white/30 flex items-start gap-1.5">
                <span className="text-green-400/50 mt-px">*</span>
                <span>{insight}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </GlassPanel>
  );
}
