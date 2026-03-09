import React from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { cn } from "../utils.js";
import { GlassPanel } from "../primitives/GlassPanel.js";

export interface ROIDataPoint {
  month: number;
  cumulativeRevenue: number;
  cumulativeCost: number;
  netPosition: number;
}

export interface ROIProjectionChartProps {
  data: ROIDataPoint[];
  breakEvenMonth?: number;
  className?: string;
}

export function ROIProjectionChart({ data, breakEvenMonth, className }: ROIProjectionChartProps) {
  return (
    <GlassPanel padding="md" className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-white/50">24-Month ROI Projection</span>
        {breakEvenMonth != null && (
          <span className="text-[10px] text-green-400/70 font-mono">
            Break-even: Month {breakEvenMonth}
          </span>
        )}
      </div>

      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="roiRevenue" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#7CB342" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#7CB342" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="roiCost" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#FFB300" stopOpacity={0.2} />
                <stop offset="100%" stopColor="#FFB300" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="month"
              tick={{ fontSize: 10, fill: "rgba(255,255,255,0.2)" }}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
              tickFormatter={(v) => `M${v}`}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "rgba(255,255,255,0.2)" }}
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
              labelFormatter={(v) => `Month ${v}`}
              formatter={(value: number) => [`$${value.toLocaleString()}`, ""]}
            />
            {breakEvenMonth != null && (
              <ReferenceLine x={breakEvenMonth} stroke="rgba(124,179,66,0.3)" strokeDasharray="4 2" label={{ value: "Break-even", fill: "rgba(124,179,66,0.4)", fontSize: 9, position: "top" }} />
            )}
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.06)" />
            <Area type="monotone" dataKey="cumulativeRevenue" stroke="#7CB342" strokeWidth={1.5} fill="url(#roiRevenue)" name="Revenue" />
            <Area type="monotone" dataKey="cumulativeCost" stroke="#FFB300" strokeWidth={1.5} fill="url(#roiCost)" name="Cost" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </GlassPanel>
  );
}
