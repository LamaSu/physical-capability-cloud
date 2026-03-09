import React from "react";
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { cn } from "../utils.js";
import { GlassPanel } from "../primitives/GlassPanel.js";

export interface EarningsDataPoint {
  date: string;
  earnings: number;
  cumulative: number;
}

export type EarningsPeriod = "7d" | "30d" | "90d" | "1y";

export interface EarningsChartProps {
  data: EarningsDataPoint[];
  period: EarningsPeriod;
  onPeriodChange?: (period: EarningsPeriod) => void;
  totalEarnings?: number;
  currency?: string;
  className?: string;
}

const periods: EarningsPeriod[] = ["7d", "30d", "90d", "1y"];

export function EarningsChart({ data, period, onPeriodChange, totalEarnings, currency = "USDC", className }: EarningsChartProps) {
  return (
    <GlassPanel padding="md" className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between">
        <div>
          <span className="text-xs font-medium text-white/50">Earnings</span>
          {totalEarnings != null && (
            <span className="ml-2 text-sm font-mono text-green-400">${totalEarnings.toLocaleString()} {currency}</span>
          )}
        </div>
        {onPeriodChange && (
          <div className="flex gap-1">
            {periods.map((p) => (
              <button
                key={p}
                onClick={() => onPeriodChange(p)}
                className={cn(
                  "px-2 py-0.5 rounded text-[10px] font-mono transition-all",
                  p === period
                    ? "bg-green-500/15 text-green-400 border border-green-500/20"
                    : "text-white/20 hover:text-white/40",
                )}
              >
                {p}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "rgba(255,255,255,0.2)" }}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
            />
            <YAxis
              yAxisId="bar"
              tick={{ fontSize: 10, fill: "rgba(255,255,255,0.2)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `$${v}`}
            />
            <YAxis
              yAxisId="line"
              orientation="right"
              tick={{ fontSize: 10, fill: "rgba(255,255,255,0.15)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
            />
            <Tooltip
              contentStyle={{
                background: "rgba(20,30,20,0.95)",
                border: "1px solid rgba(124,179,66,0.2)",
                borderRadius: 8,
                fontSize: 11,
              }}
              formatter={(value: number, name: string) => [`$${value.toLocaleString()}`, name]}
            />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <Bar yAxisId="bar" dataKey="earnings" fill="rgba(124,179,66,0.3)" radius={[2, 2, 0, 0]} name="Daily" />
            <Line yAxisId="line" type="monotone" dataKey="cumulative" stroke="#FFB300" strokeWidth={1.5} dot={false} name="Cumulative" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </GlassPanel>
  );
}
