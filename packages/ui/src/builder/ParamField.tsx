import React from "react";
import type { ResolvedParam } from "@pcc/spec";
import { cn } from "../utils.js";

export interface ParamFieldProps {
  param: ResolvedParam;
  value: string | number | boolean | string[] | undefined;
  onChange: (key: string, value: string | number | boolean | string[]) => void;
}

export function ParamField({ param, value, onChange }: ParamFieldProps) {
  const { def, visible, restricted } = param;
  if (!visible) return null;

  const baseInputClass = cn(
    "w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/80",
    "outline-none focus:border-green-500/30 transition-colors",
    restricted && "border-gold-400/20",
  );

  return (
    <div className={cn("space-y-1.5", restricted && "opacity-90")}>
      <div className="flex items-center gap-2">
        <label className="text-sm font-medium text-white/70">{def.label}</label>
        {def.required && <span className="text-red-400/60 text-xs">*</span>}
        {restricted && (
          <span className="text-[10px] text-gold-300/60 bg-gold-400/10 rounded px-1.5 py-0.5">constrained</span>
        )}
      </div>

      {def.description && (
        <p className="text-xs text-white/30">{def.description}</p>
      )}

      {def.type === "enum" && !def.multi && (
        <select
          className={baseInputClass}
          value={typeof value === "string" ? value : def.defaultValue ?? ""}
          onChange={(e) => onChange(def.key, e.target.value)}
        >
          <option value="" className="bg-forest-800">Select...</option>
          {def.options.map((opt) => (
            <option key={opt.value} value={opt.value} className="bg-forest-800">
              {opt.label}
              {opt.pricingImpact ? ` (${opt.pricingImpact.label})` : ""}
            </option>
          ))}
        </select>
      )}

      {def.type === "enum" && def.multi && (
        <div className="flex flex-wrap gap-2">
          {def.options.map((opt) => {
            const selected = Array.isArray(value) ? value.includes(opt.value) : value === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  const current = Array.isArray(value) ? value : [];
                  const next = selected
                    ? current.filter((v) => v !== opt.value)
                    : [...current.filter((v) => v !== "none"), opt.value];
                  onChange(def.key, next.length === 0 ? ["none"] : next);
                }}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-xs font-medium border transition-all",
                  selected
                    ? "bg-green-500/20 border-green-500/30 text-green-400"
                    : "bg-white/[0.03] border-white/[0.06] text-white/50 hover:border-white/[0.12]",
                )}
              >
                {opt.label}
                {opt.pricingImpact && (
                  <span className="ml-1 text-[10px] text-gold-300/60">{opt.pricingImpact.label}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {def.type === "number" && (
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={def.min}
            max={def.max}
            step={def.step}
            value={typeof value === "number" ? value : def.defaultValue ?? def.min}
            onChange={(e) => onChange(def.key, parseFloat(e.target.value))}
            className="flex-1 accent-green-500"
          />
          <span className="text-sm font-mono text-white/70 w-16 text-right">
            {typeof value === "number" ? value : def.defaultValue ?? def.min}
            {def.unit ? ` ${def.unit}` : ""}
          </span>
        </div>
      )}

      {def.type === "boolean" && (
        <button
          type="button"
          onClick={() => onChange(def.key, !(value ?? def.defaultValue ?? false))}
          className={cn(
            "relative w-11 h-6 rounded-full transition-colors",
            (value ?? def.defaultValue) ? "bg-green-500/40" : "bg-white/[0.08]",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform",
              (value ?? def.defaultValue) && "translate-x-5",
            )}
          />
        </button>
      )}

      {def.type === "string" && (
        <input
          type="text"
          className={baseInputClass}
          placeholder={def.placeholder}
          maxLength={def.maxLength}
          value={typeof value === "string" ? value : def.defaultValue ?? ""}
          onChange={(e) => onChange(def.key, e.target.value)}
        />
      )}

      {/* Pricing impact tag */}
      {param.currentPricingImpact && (
        <div className="text-[10px] text-gold-300/60 font-mono">
          {param.currentPricingImpact.label}
        </div>
      )}
    </div>
  );
}
