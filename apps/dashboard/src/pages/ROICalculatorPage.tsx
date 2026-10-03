/**
 * ROI Calculator: a planning estimate from the viewer's own numbers.
 *
 * It reads no PCC data and calls no gateway route. The projection is
 * arithmetic over four numbers the viewer types (equipment cost, monthly
 * costs, average job value, jobs per month), done in the browser, and the page
 * labels it as an estimate from those inputs. Until all four are entered it
 * shows no figures.
 *
 * Before this change it took its projection from api/mock-onboarding-data.ts,
 * which returns nothing, so next to pre-filled figures nobody had typed it
 * always showed "N/A" and "$0". It asked for an equipment cost it never used,
 * and turned utilization into jobs with two unexplained constants. The
 * gateway's POST /api/marketplace/roi is not a source either: it substitutes
 * its own figures for missing inputs and ignores the equipment cost.
 */

import React from "react";
import { useNavigate } from "react-router-dom";
import { GlassPanel, ROIProjectionChart } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useMarketplaceStore, type ROIInputs } from "../stores/marketplace-store.js";

const baseInput = "w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 focus:border-green-500/30 focus:outline-none transition-colors";

/** Months projected. ROIProjectionChart (@pcc/ui) is titled "24-Month ROI Projection". */
const HORIZON_MONTHS = 24;

const FIELDS: ReadonlyArray<{ key: keyof ROIInputs; label: string }> = [
  { key: "equipmentCost", label: "Equipment Cost ($, one time)" },
  { key: "monthlyCost", label: "Monthly Costs ($)" },
  { key: "avgJobValue", label: "Avg Job Value ($)" },
  { key: "jobsPerMonth", label: "Jobs per Month" },
];

interface ROIPoint {
  month: number;
  cumulativeRevenue: number;
  cumulativeCost: number;
  netPosition: number;
}

interface ROIEstimate {
  monthlyRevenue: number;
  points: ROIPoint[];
  /** The first month from which the net position stays at zero or better, within the horizon. */
  breakEvenMonth: number | undefined;
  netAtHorizon: number;
}

/** A number the viewer typed, zero or more; null when the field is blank or holds anything else. */
function parseInput(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** To the cent, so a break-even that lands exactly on zero isn't missed by a rounding error. */
function toCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The estimate, a pure function of the four inputs. Revenue is jobs per month
 * times the average job value. Costs are the equipment cost at month 0 plus
 * the monthly costs. Null until all four inputs are valid.
 */
function estimateROI(inputs: ROIInputs): ROIEstimate | null {
  const equipmentCost = parseInput(inputs.equipmentCost);
  const monthlyCost = parseInput(inputs.monthlyCost);
  const avgJobValue = parseInput(inputs.avgJobValue);
  const jobsPerMonth = parseInput(inputs.jobsPerMonth);
  if (equipmentCost === null || monthlyCost === null || avgJobValue === null || jobsPerMonth === null) return null;

  const monthlyRevenue = toCents(avgJobValue * jobsPerMonth);
  const points: ROIPoint[] = [];
  for (let month = 0; month <= HORIZON_MONTHS; month++) {
    const cumulativeRevenue = toCents(monthlyRevenue * month);
    const cumulativeCost = toCents(equipmentCost + monthlyCost * month);
    points.push({ month, cumulativeRevenue, cumulativeCost, netPosition: toCents(cumulativeRevenue - cumulativeCost) });
  }
  const breakEven = points.findIndex((_, i) => points.slice(i).every((p) => p.netPosition >= 0));
  return {
    monthlyRevenue,
    points,
    breakEvenMonth: breakEven === -1 ? undefined : points[breakEven]!.month,
    netAtHorizon: points[HORIZON_MONTHS]!.netPosition,
  };
}

/** Whole dollars, with a minus sign for a loss. */
function formatDollars(n: number): string {
  const whole = Math.round(Math.abs(n));
  return `${n < 0 && whole > 0 ? "−" : ""}$${whole.toLocaleString("en-US")}`;
}

export function ROICalculatorPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { roiInputs, updateROIInput } = useMarketplaceStore();

  React.useEffect(() => {
    setPageMeta("ROI Calculator", "Estimate a return from your own numbers");
  }, [setPageMeta]);

  const estimate = estimateROI(roiInputs);

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <button onClick={() => navigate("/marketplace")} className="text-xs text-white/30 hover:text-white/50 transition-colors">
        &larr; Back to Marketplace
      </button>

      {/* Inputs */}
      <GlassPanel padding="lg" className="space-y-4">
        <div className="space-y-1">
          <span className="text-xs font-medium text-white/50">Your Numbers</span>
          <p className="text-[11px] text-white/30 leading-relaxed">
            A planning estimate from the numbers you enter. It uses no PCC market data: the job value and the number of
            jobs are your own assumptions. Fees and taxes are not included.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label htmlFor={`roi-${f.key}`} className="text-[10px] text-white/30 mb-1 block">
                {f.label}
              </label>
              <input
                id={`roi-${f.key}`}
                className={baseInput}
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={roiInputs[f.key]}
                onChange={(e) => updateROIInput(f.key, e.target.value)}
              />
            </div>
          ))}
        </div>
      </GlassPanel>

      {estimate === null ? (
        <GlassPanel padding="lg" className="text-center">
          <p className="text-xs text-white/40">Enter all four numbers, each zero or more, to see an estimate.</p>
        </GlassPanel>
      ) : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-3 gap-4">
            <GlassPanel padding="md" className="text-center">
              <div className="text-[10px] text-white/20">Break-Even</div>
              <div className="text-lg font-mono text-green-400 mt-1">
                {estimate.breakEvenMonth !== undefined ? `Month ${estimate.breakEvenMonth}` : `Not within ${HORIZON_MONTHS} months`}
              </div>
            </GlassPanel>
            <GlassPanel padding="md" className="text-center">
              <div className="text-[10px] text-white/20">Net After {HORIZON_MONTHS} Months</div>
              <div className={`text-lg font-mono mt-1 ${estimate.netAtHorizon >= 0 ? "text-green-400" : "text-red-400"}`}>
                {formatDollars(estimate.netAtHorizon)}
              </div>
            </GlassPanel>
            <GlassPanel padding="md" className="text-center">
              <div className="text-[10px] text-white/20">Monthly Revenue</div>
              <div className="text-lg font-mono text-white/60 mt-1">{formatDollars(estimate.monthlyRevenue)}</div>
            </GlassPanel>
          </div>

          {/* Chart */}
          <ROIProjectionChart data={estimate.points} breakEvenMonth={estimate.breakEvenMonth} />
          <p className="text-[10px] text-white/25 text-center">
            Estimate from your inputs: revenue is jobs per month times the average job value; costs are the equipment
            cost up front plus the monthly costs.
          </p>
        </>
      )}
    </div>
  );
}
