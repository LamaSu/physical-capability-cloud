import React from "react";
import { GlassPanel, GlowBadge } from "@pcc/ui";

// ── Types ────────────────────────────────────────────────────────

export interface NegotiationSplit {
  role: string;
  percentage: number;
  label: string;
}

export interface NegotiationPanelProps {
  basePrice: number;
  splits: NegotiationSplit[];
  onSplitsChange: (splits: NegotiationSplit[]) => void;
  editable?: boolean;
}

// ── Presets ──────────────────────────────────────────────────────
//
// Legacy presets (Single-Step / Multi-Step / Community) keep `designer`
// and `network` so older saved drafts referencing them keep rendering.
// New presets (ADR-12) demonstrate the canonical ContributorRole taxonomy:
// protocol-author, integrator, model-author, network-treasury, etc.
//
// The contributor-economics presets mirror SPLIT_PROFILES.contributor*
// in @pcc/contracts/ts/story-defaults.ts byte-for-byte by percentage and
// role membership, so what the user sees in the UI matches what gets
// written on chain.

const PRESETS: Record<string, NegotiationSplit[]> = {
  "Single-Step": [
    { role: "designer",  percentage: 10, label: "CSD Author" },
    { role: "operator",  percentage: 70, label: "Machine Operator" },
    { role: "verifier",  percentage: 10, label: "Evidence Verifier" },
    { role: "network",   percentage: 10, label: "Protocol Treasury" },
  ],
  "Multi-Step": [
    { role: "designer",  percentage: 5,  label: "Workflow Designer" },
    { role: "operator",  percentage: 75, label: "Step Operators" },
    { role: "verifier",  percentage: 10, label: "Evidence Verifiers" },
    { role: "network",   percentage: 10, label: "Protocol Treasury" },
  ],
  "Community": [
    { role: "designer",  percentage: 20, label: "CSD Author" },
    { role: "operator",  percentage: 60, label: "Machine Operator" },
    { role: "curator",   percentage:  5, label: "Community Curator" },
    { role: "verifier",  percentage:  5, label: "Evidence Verifier" },
    { role: "network",   percentage: 10, label: "Protocol Treasury" },
  ],
  // ADR-12 contributor-economics presets — the canonical role taxonomy.
  "Contrib-Econ — Minimal": [
    { role: "operator",         percentage: 92, label: "Machine Operator" },
    { role: "verifier",         percentage:  3, label: "Evidence Verifier" },
    { role: "protocol-author",  percentage:  2, label: "CSD Author" },
    { role: "integrator",       percentage:  2, label: "Adapter Integrator" },
    { role: "network-treasury", percentage:  1, label: "Network Treasury" },
  ],
  "Contrib-Econ — With AI": [
    { role: "operator",         percentage: 87, label: "Machine Operator" },
    { role: "verifier",         percentage:  3, label: "Evidence Verifier" },
    { role: "protocol-author",  percentage:  2, label: "CSD Author" },
    { role: "integrator",       percentage:  2, label: "Adapter Integrator" },
    { role: "model-author",     percentage:  4, label: "Model Author" },
    { role: "network-treasury", percentage:  2, label: "Network Treasury" },
  ],
};

// ── Role styling ─────────────────────────────────────────────────
//
// Color assignments are stable so users can recognize each role across
// the dashboard. New ADR-12 roles get distinct hues that don't collide
// with the legacy palette (blue/green/purple/gray/yellow/orange):
//   • integrator         → cyan   (bridging adapter)
//   • protocol-author    → sky    (CSD author; close cousin of designer)
//   • model-author       → fuchsia (AI / model R&D)
//   • dataset-contributor → pink  (contribution lineage)
//   • insurer            → teal   (risk/coverage)
//   • network-treasury   → slate  (close cousin of legacy `network` gray)

const ROLE_COLORS: Record<string, string> = {
  // Legacy palette
  designer:  "bg-blue-500",
  operator:  "bg-green-500",
  verifier:  "bg-purple-500",
  network:   "bg-gray-500",
  curator:   "bg-yellow-500",
  // ADR-12 additions
  integrator:            "bg-cyan-500",
  "protocol-author":     "bg-sky-500",
  "model-author":        "bg-fuchsia-500",
  "dataset-contributor": "bg-pink-500",
  insurer:               "bg-teal-500",
  "network-treasury":    "bg-slate-500",
};

const ROLE_TEXT_COLORS: Record<string, string> = {
  // Legacy palette
  designer:  "text-blue-400",
  operator:  "text-green-400",
  verifier:  "text-purple-400",
  network:   "text-gray-400",
  curator:   "text-yellow-400",
  // ADR-12 additions
  integrator:            "text-cyan-400",
  "protocol-author":     "text-sky-400",
  "model-author":        "text-fuchsia-400",
  "dataset-contributor": "text-pink-400",
  insurer:               "text-teal-400",
  "network-treasury":    "text-slate-400",
};

function roleColor(role: string) {
  return ROLE_COLORS[role] ?? "bg-pink-500";
}

function roleTextColor(role: string) {
  return ROLE_TEXT_COLORS[role] ?? "text-pink-400";
}

// ── Component ────────────────────────────────────────────────────

export function NegotiationPanel({
  basePrice,
  splits,
  onSplitsChange,
  editable = true,
}: NegotiationPanelProps) {
  const [saved, setSaved] = React.useState(false);

  const total = splits.reduce((acc, s) => acc + s.percentage, 0);
  const isValid = Math.round(total) === 100;

  const operatorSplit = splits.find((s) => s.role === "operator");
  const operatorEarnings = operatorSplit
    ? (basePrice * operatorSplit.percentage) / 100
    : 0;

  function updatePercentage(index: number, value: number) {
    const clamped = Math.max(0, Math.min(100, value));
    onSplitsChange(splits.map((s, i) => (i === index ? { ...s, percentage: clamped } : s)));
  }

  function applyPreset(name: string) {
    const preset = PRESETS[name];
    if (preset) {
      onSplitsChange(preset.map((s) => ({ ...s })));
    }
  }

  function handleSave() {
    if (!isValid) return;
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider">
          Revenue Split Negotiation
        </h3>
        <GlowBadge color={isValid ? "green" : "red"}>
          {total}% total
        </GlowBadge>
      </div>

      {/* Preset selector */}
      {editable && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-white/25 uppercase tracking-wider">Preset:</span>
          {Object.keys(PRESETS).map((name) => (
            <button
              key={name}
              onClick={() => applyPreset(name)}
              className="px-2 py-1 rounded text-[10px] bg-white/[0.03] border border-white/[0.07] text-white/40 hover:bg-white/[0.07] hover:text-white/60 transition-all"
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {/* Horizontal stacked bar */}
      <div className="h-3 rounded-full overflow-hidden flex bg-white/[0.05]">
        {splits.map((s, i) => (
          <div
            key={i}
            className={`h-full transition-all duration-300 ${roleColor(s.role)}`}
            style={{ width: `${Math.max(0, Math.min(100, s.percentage))}%` }}
            title={`${s.label}: ${s.percentage}%`}
          />
        ))}
      </div>

      {/* Split rows with editable inputs */}
      <div className="space-y-2">
        {splits.map((s, i) => {
          const earnings = (basePrice * s.percentage) / 100;
          return (
            <div key={i} className="flex items-center gap-3">
              {/* Color dot */}
              <div className={`w-2 h-2 rounded-full flex-shrink-0 ${roleColor(s.role)}`} />

              {/* Label + role */}
              <div className="flex-1 min-w-0">
                <span className={`text-sm font-medium ${roleTextColor(s.role)}`}>{s.label}</span>
                <div className="text-[10px] text-white/25 font-mono">{s.role}</div>
              </div>

              {/* Percentage input */}
              {editable ? (
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={s.percentage}
                  onChange={(e) => updatePercentage(i, parseInt(e.target.value, 10) || 0)}
                  className="w-16 bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-white/70 text-right focus:border-white/20 outline-none"
                />
              ) : (
                <span className="text-sm font-mono text-white/60 w-16 text-right">
                  {s.percentage}%
                </span>
              )}

              {/* Per-job preview */}
              <span className="text-[10px] font-mono w-16 text-right text-white/30">
                ${earnings.toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>

      {/* Validation message */}
      {!isValid && (
        <div className="text-[10px] text-red-400/70">
          Percentages must sum to exactly 100% (currently {total}%)
        </div>
      )}

      {/* Operator earnings preview callout */}
      <GlassPanel padding="md" glow={isValid ? "green" : "none"}>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] text-white/30 uppercase tracking-wider">
              You&apos;ll earn per job
            </div>
            <div className="text-sm text-white/50 mt-0.5">
              At <span className="font-mono text-white/60">${basePrice.toFixed(2)}</span> pricing
              with <span className={roleTextColor("operator")}>{operatorSplit?.percentage ?? 0}%</span> operator split
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-mono text-emerald-400">
              ${operatorEarnings.toFixed(2)}
            </div>
            <div className="text-[10px] text-white/25">per completed job</div>
          </div>
        </div>
      </GlassPanel>

      {/* Save / Accept button */}
      {editable && (
        <button
          onClick={handleSave}
          disabled={!isValid}
          className={`w-full py-2.5 rounded-xl text-xs font-semibold transition-all ${
            saved
              ? "bg-emerald-500/20 border border-emerald-500/40 text-emerald-300"
              : isValid
              ? "bg-green-500/15 border border-green-500/25 text-green-400 hover:bg-green-500/25 hover:shadow-[0_0_16px_rgba(124,179,66,0.15)]"
              : "bg-white/[0.02] border border-white/[0.06] text-white/20 cursor-not-allowed"
          }`}
        >
          {saved ? "Split Saved" : "Accept Split"}
        </button>
      )}
    </div>
  );
}
