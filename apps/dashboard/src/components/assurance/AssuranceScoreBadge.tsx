/**
 * AssuranceScoreBadge — visualizes an assurance score on [0.0, 1.0].
 *
 * The assurance score is a weighted ALCOA+ compliance rollup produced by the
 * digital-verifier foundation. This badge surfaces it in the dashboard so
 * buyers and agents can rank kernels by evidence quality.
 *
 * Semantics:
 *   - 0.0  → unverified / no evidence
 *   - 1.0  → full ALCOA+ compliance, all tier requirements satisfied
 *   - null/undefined → not yet computed (shows em-dash in neutral gray)
 *
 * Color thresholds (matches dashboard solarpunk/holographic palette):
 *   - score < 0.50            → red    (critical — reject or investigate)
 *   - 0.50 ≤ score < 0.70     → amber  (warn — below production minimum)
 *   - 0.70 ≤ score < 0.85     → yellow (acceptable — standard production)
 *   - score ≥ 0.85            → green  (excellent — regulated / sovereign tier)
 */

import React from "react";
import { cn } from "@pcc/ui";

// ── Pure helpers (exported for unit tests) ──────────────────────────────────

export type AssuranceColor = "red" | "amber" | "yellow" | "green" | "neutral";

/**
 * Map a score in [0, 1] to a semantic color bucket.
 * Null/undefined/NaN/out-of-range → "neutral".
 */
export function scoreToColor(score: number | null | undefined): AssuranceColor {
  if (score == null || !Number.isFinite(score)) return "neutral";
  if (score < 0 || score > 1) return "neutral";
  if (score < 0.5) return "red";
  if (score < 0.7) return "amber";
  if (score < 0.85) return "yellow";
  return "green";
}

/**
 * Format a score for display.
 *   formatScore(0.926)          → "0.93"
 *   formatScore(0.926, true)    → "93%"
 *   formatScore(null)           → "—"
 *   formatScore(undefined)      → "—"
 */
export function formatScore(
  score: number | null | undefined,
  showPercent = false,
): string {
  if (score == null || !Number.isFinite(score)) return "—";
  if (showPercent) {
    return `${Math.round(score * 100)}%`;
  }
  return score.toFixed(2);
}

// ── Style tables (exported for tests) ───────────────────────────────────────

export const COLOR_CLASSES: Record<AssuranceColor, string> = {
  red: "bg-red-500/15 text-red-400 border-red-500/30",
  amber: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  yellow: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30",
  green: "bg-green-500/15 text-green-400 border-green-500/30",
  neutral: "bg-white/5 text-white/40 border-white/10",
};

export type AssuranceSize = "sm" | "md" | "lg";

export const SIZE_CLASSES: Record<AssuranceSize, string> = {
  sm: "px-1.5 py-0.5 text-[10px]",
  md: "px-2.5 py-0.5 text-xs",
  lg: "px-3 py-1 text-sm",
};

// ── Component ───────────────────────────────────────────────────────────────

export interface AssuranceScoreBadgeProps {
  /** Score in [0.0, 1.0]. null/undefined renders a neutral dash. */
  score: number | null | undefined;
  /** Badge size preset. Default "md". */
  size?: AssuranceSize;
  /** If true, renders "92%" instead of "0.92". */
  showPercent?: boolean;
  /** Additional classes merged via tailwind-merge. */
  className?: string;
}

const TOOLTIP =
  "Assurance Score: weighted ALCOA+ compliance (0 = unverified, 1 = full)";

export function AssuranceScoreBadge({
  score,
  size = "md",
  showPercent = false,
  className,
}: AssuranceScoreBadgeProps) {
  const color = scoreToColor(score);
  const label = formatScore(score, showPercent);

  return (
    <span
      title={TOOLTIP}
      aria-label={
        score == null
          ? "Assurance score not available"
          : `Assurance score ${label}`
      }
      data-assurance-color={color}
      data-assurance-size={size}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border font-mono font-medium tabular-nums",
        COLOR_CLASSES[color],
        SIZE_CLASSES[size],
        className,
      )}
    >
      {label}
    </span>
  );
}
