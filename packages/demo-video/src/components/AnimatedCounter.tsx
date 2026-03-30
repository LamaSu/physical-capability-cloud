/**
 * AnimatedCounter — Brutalist voice number counter.
 * CC: Monospace (brutalist), tabular-nums, accent1 default.
 */
import React from "react";
import { useCurrentFrame } from "remotion";
import { FONTS, COLORS, countTo } from "../lib";

export const AnimatedCounter: React.FC<{
  to: number;
  from?: number;
  duration?: number;
  delay?: number;
  suffix?: string;
  prefix?: string;
  fontSize?: number;
  color?: string;
}> = ({
  to,
  from = 0,
  duration = 60,
  delay = 0,
  suffix = "",
  prefix = "",
  fontSize = 70,
  color = COLORS.accent1,
}) => {
  const frame = useCurrentFrame();
  const value = countTo(frame, to, duration, delay, from);

  return (
    <span
      style={{
        fontFamily: FONTS.brutalist,
        fontSize,
        fontWeight: 700,
        color,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {prefix}
      {value.toLocaleString()}
      {suffix}
    </span>
  );
};
