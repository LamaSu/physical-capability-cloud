import React from "react";
import { GlassPanel, GlowBadge } from "@pcc/ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SplitEntry {
  role: string;
  percentage: number;
  label: string;
  address?: string;
}

export interface SplitEditorProps {
  splits: SplitEntry[];
  onChange: (splits: SplitEntry[]) => void;
  presets?: Record<string, SplitEntry[]>;
  readOnly?: boolean;
  totalPrice?: number;
}

// ---------------------------------------------------------------------------
// Role color map
// ---------------------------------------------------------------------------

const ROLE_COLORS: Record<string, string> = {
  designer:  "bg-blue-500",
  operator:  "bg-green-500",
  verifier:  "bg-purple-500",
  network:   "bg-gray-500",
  curator:   "bg-yellow-500",
  assembler: "bg-orange-500",
};

const ROLE_TEXT_COLORS: Record<string, string> = {
  designer:  "text-blue-400",
  operator:  "text-green-400",
  verifier:  "text-purple-400",
  network:   "text-gray-400",
  curator:   "text-yellow-400",
  assembler: "text-orange-400",
};

function roleColor(role: string): string {
  return ROLE_COLORS[role] ?? "bg-pink-500";
}

function roleTextColor(role: string): string {
  return ROLE_TEXT_COLORS[role] ?? "text-pink-400";
}

// ---------------------------------------------------------------------------
// SplitEditor
// ---------------------------------------------------------------------------

export function SplitEditor({
  splits,
  onChange,
  presets,
  readOnly = false,
  totalPrice,
}: SplitEditorProps) {
  const total = splits.reduce((acc, s) => acc + s.percentage, 0);
  const isValid = Math.round(total) === 100;

  function updateSplit(index: number, value: number) {
    const clamped = Math.max(0, Math.min(100, value));
    const next = splits.map((s, i) => (i === index ? { ...s, percentage: clamped } : s));
    onChange(next);
  }

  function removeSplit(index: number) {
    onChange(splits.filter((_, i) => i !== index));
  }

  function addRole() {
    onChange([
      ...splits,
      { role: "custom", percentage: 0, label: "Custom Role" },
    ]);
  }

  function applyPreset(name: string) {
    if (presets && presets[name]) {
      onChange(presets[name].map((s) => ({ ...s })));
    }
  }

  return (
    <div className="space-y-4">
      {/* Preset selector */}
      {presets && Object.keys(presets).length > 0 && !readOnly && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-white/30 uppercase tracking-wider">Preset:</span>
          {Object.keys(presets).map((name) => (
            <button
              key={name}
              onClick={() => applyPreset(name)}
              className="px-2 py-1 rounded text-[10px] bg-white/[0.04] border border-white/[0.08] text-white/50 hover:bg-white/[0.08] hover:text-white/70 transition-all capitalize"
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {/* Stacked bar */}
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

      {/* Split rows */}
      <div className="space-y-2">
        {splits.map((s, i) => (
          <div key={i} className="flex items-center gap-3">
            {/* Color dot + label */}
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${roleColor(s.role)}`} />
            <div className="flex-1 min-w-0">
              {readOnly ? (
                <span className={`text-sm font-medium ${roleTextColor(s.role)}`}>{s.label}</span>
              ) : (
                <input
                  type="text"
                  value={s.label}
                  onChange={(e) => {
                    const next = splits.map((sp, idx) =>
                      idx === i ? { ...sp, label: e.target.value } : sp,
                    );
                    onChange(next);
                  }}
                  className="bg-transparent text-sm text-white/70 border-b border-white/[0.08] focus:border-white/20 outline-none w-full"
                />
              )}
              <div className="text-[10px] text-white/30 font-mono">{s.role}</div>
            </div>

            {/* Percentage input */}
            {readOnly ? (
              <span className="text-sm font-mono text-white/60 w-12 text-right">{s.percentage}%</span>
            ) : (
              <input
                type="number"
                min={0}
                max={100}
                value={s.percentage}
                onChange={(e) => updateSplit(i, parseInt(e.target.value, 10) || 0)}
                className="w-16 bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-white/70 text-right focus:border-white/20 outline-none"
              />
            )}

            {/* Per-job earnings preview */}
            {totalPrice !== undefined && (
              <span className="text-[10px] text-white/30 font-mono w-16 text-right">
                ${((totalPrice * s.percentage) / 100).toFixed(2)}
              </span>
            )}

            {/* Remove button */}
            {!readOnly && (
              <button
                onClick={() => removeSplit(i)}
                className="text-white/20 hover:text-red-400/60 transition-colors text-sm leading-none"
                title="Remove role"
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Validation + total */}
      <div className="flex items-center justify-between pt-2 border-t border-white/[0.06]">
        <div className="flex items-center gap-2">
          <GlowBadge color={isValid ? "green" : "red"}>
            {total}% total
          </GlowBadge>
          {!isValid && (
            <span className="text-[10px] text-red-400/70">Must equal 100%</span>
          )}
        </div>
        {!readOnly && (
          <button
            onClick={addRole}
            className="text-[10px] text-white/30 hover:text-white/60 border border-white/[0.08] hover:border-white/[0.15] rounded px-2 py-1 transition-all"
          >
            + Add Role
          </button>
        )}
      </div>

      {/* Per-job earnings summary */}
      {totalPrice !== undefined && (
        <div className="text-[10px] text-white/30">
          At <span className="text-white/50">${totalPrice.toFixed(2)}/job</span> you earn:{" "}
          {splits
            .filter((s) => s.role === "operator")
            .map((s) => (
              <span key={s.role} className="text-green-400/70">
                ${((totalPrice * s.percentage) / 100).toFixed(2)} (Operator)
              </span>
            ))}
        </div>
      )}
    </div>
  );
}
