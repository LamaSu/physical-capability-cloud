import React from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { cn } from "../utils.js";
import { GlassPanel } from "../primitives/GlassPanel.js";

export interface DemandSupplyDataPoint {
  date: string;
  demand: number;
  supply: number;
}

export interface DemandSupplyChartProps {
  data: DemandSupplyDataPoint[];
  title?: string;
  className?: string;
}

export function DemandSupplyChart({ data, title = "Demand vs Supply", className }: DemandSupplyChartProps) {
  return (
    <GlassPanel padding="md" className={cn("space-y-3", className)}>
      <span className="text-xs font-medium text-white/50">{title}</span>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="dsSupply" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#7CB342" stopOpacity={0.25} />
                <stop offset="100%" stopColor="#7CB342" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="dsDemand" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#FFB300" stopOpacity={0.2} />
                <stop offset="100%" stopColor="#FFB300" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "rgba(255,255,255,0.2)" }}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "rgba(255,255,255,0.2)" }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              contentStyle={{
                background: "rgba(20,30,20,0.95)",
                border: "1px solid rgba(124,179,66,0.2)",
                borderRadius: 8,
                fontSize: 11,
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: 10 }}
              iconType="line"
            />
            <Area type="monotone" dataKey="demand" stroke="#FFB300" strokeWidth={1.5} fill="url(#dsDemand)" name="Demand" />
            <Area type="monotone" dataKey="supply" stroke="#7CB342" strokeWidth={1.5} fill="url(#dsSupply)" name="Supply" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </GlassPanel>
  );
}
