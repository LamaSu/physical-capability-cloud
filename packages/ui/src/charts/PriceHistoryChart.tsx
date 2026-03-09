import React from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { cn } from "../utils.js";
import { GlassPanel } from "../primitives/GlassPanel.js";

export interface PriceHistoryDataPoint {
  date: string;
  price: number;
}

export interface PriceHistoryChartProps {
  data: PriceHistoryDataPoint[];
  currentPrice?: number;
  currency?: string;
  title?: string;
  className?: string;
}

export function PriceHistoryChart({ data, currentPrice, currency = "USDC", title = "Price History", className }: PriceHistoryChartProps) {
  return (
    <GlassPanel padding="md" className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-white/50">{title}</span>
        {currentPrice != null && (
          <span className="text-xs font-mono text-green-400">${currentPrice.toFixed(2)} {currency}</span>
        )}
      </div>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
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
              tickFormatter={(v) => `$${v}`}
            />
            <Tooltip
              contentStyle={{
                background: "rgba(20,30,20,0.95)",
                border: "1px solid rgba(124,179,66,0.2)",
                borderRadius: 8,
                fontSize: 11,
              }}
              formatter={(value: number) => [`$${value.toFixed(2)}`, "Price"]}
            />
            {currentPrice != null && (
              <ReferenceLine
                y={currentPrice}
                stroke="rgba(124,179,66,0.3)"
                strokeDasharray="4 2"
                label={{ value: "Current", fill: "rgba(124,179,66,0.4)", fontSize: 9, position: "right" }}
              />
            )}
            <Line type="monotone" dataKey="price" stroke="#7CB342" strokeWidth={1.5} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </GlassPanel>
  );
}
