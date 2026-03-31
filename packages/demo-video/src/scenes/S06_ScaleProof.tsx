/**
 * S06_ScaleProof — "Counter Slam"
 *
 * 330 frames (11 seconds). 4 metric panels slam in. Discord use #3.
 *
 * Frame 0:   Panel 1 slams — 3300 counter (DISCORD #ff0066 → #00ff88 at frame 75).
 * Frame 18:  Panel 2 slams — 154 counter, cyan.
 * Frame 36:  Panel 3 slams — 347 counter, cyan.
 * Frame 54:  Panel 4 slams — Apache 2.0 badge, emerald border/glow.
 * Frame 180: Final statement line springs in.
 *
 * Counter color arc (panel 1):
 *   frame 0-75:  #ff0066 (discord — problem recognized)
 *   frame 75-90: interpolate to #00ff88
 *   frame 90+:   #00ff88 (landed — problem solved)
 *
 * DESIGN RULES:
 * - Min font: 36px
 * - Max 5 elements on screen
 * - bg: #050a0e
 * - Discord #ff0066 used ONCE (panel 1 counter start color)
 * - Grid: 4 panels across, each 380x260px, spacing 40px
 */
import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  AbsoluteFill,
  interpolate,
} from "remotion";
import { C, F, SIZE, slam, slamScale, smooth, countTo } from "../lib";

// Metric panel geometry
const PANEL_W = 380;
const PANEL_H = 260;
const PANEL_GAP = 40;
const GRID_X = 128;
const GRID_Y = 280;

interface CounterPanelProps {
  frame: number;
  fps: number;
  enterFrame: number;
  panelX: number;
  value: number;
  label: string;
  valueColor: string;
  valueColorEnd?: string;
  colorTransitionStart?: number;
  colorTransitionDuration?: number;
  borderColor?: string;
  glowColor?: string;
  isBadge?: boolean;
  badgeText?: string;
  badgeSub?: string;
}

const CounterPanel: React.FC<CounterPanelProps> = ({
  frame,
  fps,
  enterFrame,
  panelX,
  value,
  label,
  valueColor,
  valueColorEnd,
  colorTransitionStart = 0,
  colorTransitionDuration = 15,
  borderColor = C.border,
  glowColor,
  isBadge = false,
  badgeText,
  badgeSub,
}) => {
  const panelP = slam(frame, fps, enterFrame);
  const panelScale = slamScale(frame, fps, enterFrame, 2.0);
  const panelOpacity = Math.min(panelP * 6, 1);

  // Counter value (count from 0 to target over 90 frames from enterFrame)
  const counted = countTo(frame, value, 90, enterFrame);
  const displayValue = isBadge
    ? badgeText ?? ""
    : counted.toLocaleString();

  // Color interpolation for the primary discord counter
  let displayColor = valueColor;
  if (valueColorEnd) {
    const colorP = interpolate(
      frame,
      [colorTransitionStart, colorTransitionStart + colorTransitionDuration],
      [0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
    // Hex interpolation: parse r,g,b from both colors and interpolate
    const from = hexToRgb(valueColor);
    const to   = hexToRgb(valueColorEnd);
    const r = Math.round(from.r + (to.r - from.r) * colorP);
    const g = Math.round(from.g + (to.g - from.g) * colorP);
    const b = Math.round(from.b + (to.b - from.b) * colorP);
    displayColor = `rgb(${r},${g},${b})`;
  }

  const boxShadow = glowColor
    ? `0 0 32px ${glowColor}, inset 0 0 24px ${glowColor}`
    : undefined;

  return (
    <div
      style={{
        position: "absolute",
        left: panelX,
        top: GRID_Y,
        width: PANEL_W,
        height: PANEL_H,
        backgroundColor: C.surface,
        border: `1.5px solid ${borderColor}`,
        borderRadius: 16,
        boxShadow,
        padding: "28px 32px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "flex-start",
        gap: 12,
        opacity: panelOpacity,
        transform: `scale(${panelScale})`,
        transformOrigin: "center center",
      }}
    >
      {/* Value / badge main text */}
      <div
        style={{
          fontFamily: F.brutalist,
          fontSize: isBadge ? 80 : 120,
          fontWeight: 700,
          color: displayColor,
          lineHeight: 1.0,
          letterSpacing: isBadge ? "0.01em" : "-0.02em",
          textShadow: `0 0 40px ${displayColor}55`,
        }}
      >
        {displayValue}
        {!isBadge && value >= 1000 && frame >= enterFrame + 90 && (
          <span style={{ fontSize: 64, marginLeft: 4, opacity: 0.7 }}>+</span>
        )}
      </div>

      {/* Label — muted for counters, accent for badge sublabel */}
      <div
        style={{
          fontFamily: F.swiss,
          fontSize: SIZE.label,
          fontWeight: isBadge ? 700 : 400,
          color: isBadge ? displayColor : C.muted,
          letterSpacing: "0.10em",
          textTransform: "uppercase" as const,
        }}
      >
        {label}
      </div>
    </div>
  );
};

function hexToRgb(hex: string) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export const S06_ScaleProof: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Panel x positions: 4 across
  const x1 = GRID_X;
  const x2 = GRID_X + PANEL_W + PANEL_GAP;
  const x3 = GRID_X + (PANEL_W + PANEL_GAP) * 2;
  const x4 = GRID_X + (PANEL_W + PANEL_GAP) * 3;

  // ── Final statement line (frame 180) ─────────────────────────────────────
  const statP = smooth(frame, fps, 180);
  const statY = interpolate(statP, [0, 1], [24, 0]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.bg,
        padding: "96px 128px",
      }}
    >
      {/* Panel 1 — Tests (discord: red → green) */}
      <CounterPanel
        frame={frame}
        fps={fps}
        enterFrame={0}
        panelX={x1}
        value={3300}
        label="TESTS PASSING"
        valueColor={C.discord}
        valueColorEnd={C.accent1}
        colorTransitionStart={75}
        colorTransitionDuration={15}
      />

      {/* Panel 2 — Agent tools (cyan) */}
      <CounterPanel
        frame={frame}
        fps={fps}
        enterFrame={18}
        panelX={x2}
        value={154}
        label="AGENT TOOLS"
        valueColor={C.accent2}
      />

      {/* Panel 3 — API endpoints (cyan) */}
      <CounterPanel
        frame={frame}
        fps={fps}
        enterFrame={36}
        panelX={x3}
        value={347}
        label="API ENDPOINTS"
        valueColor={C.accent2}
      />

      {/* Panel 4 — Apache 2.0 badge (emerald) */}
      <CounterPanel
        frame={frame}
        fps={fps}
        enterFrame={54}
        panelX={x4}
        value={0}
        label="OPEN FOREVER"
        valueColor={C.accent1}
        borderColor={C.accent1}
        glowColor="rgba(0,255,136,0.10)"
        isBadge
        badgeText="Apache 2.0"
      />

      {/* Final statement */}
      <div
        style={{
          position: "absolute",
          left: GRID_X,
          top: GRID_Y + PANEL_H + 48,
          right: 128,
          opacity: statP,
          transform: `translateY(${statY}px)`,
        }}
      >
        <div
          style={{
            fontFamily: F.swiss,
            fontSize: 56,
            fontWeight: 600,
            color: C.fg,
            lineHeight: 1.3,
            letterSpacing: "0.01em",
          }}
        >
          25 packages. One developer. One month.{" "}
          <span style={{ color: C.accent1 }}>Live at capability.network.</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

export default S06_ScaleProof;
