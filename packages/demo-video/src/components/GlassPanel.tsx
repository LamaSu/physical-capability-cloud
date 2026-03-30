/**
 * GlassPanel — Surface container with glass morphism.
 * CC: Uses signal mood surface colors, organic radius (warmth 0.6 → 12px).
 */
import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { COLORS, GRADIENTS, smoothSpring } from "../lib";

export const GlassPanel: React.FC<{
  children: React.ReactNode;
  delay?: number;
  width?: number | string;
  height?: number | string;
  padding?: number;
  glowColor?: string;
  borderRadius?: number;
}> = ({
  children,
  delay = 0,
  width = "auto",
  height = "auto",
  padding = 24,
  glowColor = COLORS.accent1,
  borderRadius = 12,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = smoothSpring(frame, fps, delay);
  const scale = interpolate(progress, [0, 1], [0.95, 1]);

  // Parse color for glow — extract from hex
  const glowRgb = glowColor === COLORS.discord ? "255,0,102"
    : glowColor === COLORS.accent2 ? "0,204,255"
    : "0,255,136";

  return (
    <div
      style={{
        width,
        height,
        padding,
        background: COLORS.bg.surface,
        border: `1px solid ${COLORS.bg.border}`,
        borderRadius,
        boxShadow: `0 0 24px rgba(${glowRgb},0.08)`,
        transform: `scale(${scale})`,
        opacity: progress,
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
};
