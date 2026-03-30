/**
 * CapabilityTicker — Scrolling capability list.
 * Supports eased start: ticker begins slow and accelerates to cruise speed.
 * CC: Brutalist voice, Deep Space Protocol palette.
 */
import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import { FONTS, COLORS, CAPABILITIES_TICKER } from "../lib";

export const CapabilityTicker: React.FC<{
  speed?: number;
  fontSize?: number;
  /** Frame at which the ticker starts moving (for eased acceleration) */
  tickerStartFrame?: number;
}> = ({ speed = 2, fontSize = 15, tickerStartFrame = 0 }) => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();

  const items = [...CAPABILITIES_TICKER, ...CAPABILITIES_TICKER];
  const totalWidth = items.length * 220;

  // Eased speed: starts at 0, ramps to full speed over 45 frames
  const easedSpeed = interpolate(
    frame,
    [tickerStartFrame, tickerStartFrame + 45],
    [0, speed],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    }
  );

  // Accumulate position using eased speed — approximate by using mid-ramp integral
  // For frames before start: no movement
  // For ramp phase: quadratic curve position
  // For after ramp: linear at full speed
  const rampEnd = tickerStartFrame + 45;
  let x: number;
  if (frame <= tickerStartFrame) {
    x = 0;
  } else if (frame <= rampEnd) {
    // Integrate eased speed over ramp — cubic ease-out integral
    const t = (frame - tickerStartFrame) / 45;
    // cubic ease-out: 1 - (1-t)^3 → integral: t - (t^2)/2 + (t^3)/3 - (t^4)/4... approx with simpler
    // Use average of 0..speed during ramp: quadratic approximation
    const rampFrames = frame - tickerStartFrame;
    x = -(rampFrames * rampFrames * speed) / (2 * 45);
  } else {
    // Ramp phase distance
    const rampDist = (45 * speed) / 2;
    // Linear phase distance
    const linearDist = (frame - rampEnd) * speed;
    x = -(rampDist + linearDist);
  }

  // Wrap around
  const wrappedX = x % (totalWidth / 2);

  return (
    <div
      style={{
        position: "absolute",
        bottom: 40,
        left: 0,
        width: "100%",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 24,
          transform: `translateX(${wrappedX}px)`,
          whiteSpace: "nowrap",
        }}
      >
        {items.map((cap, i) => (
          <span
            key={i}
            style={{
              fontFamily: FONTS.brutalist,
              fontSize,
              color: COLORS.muted,
              padding: "5px 14px",
              border: `1px solid ${COLORS.bg.border}`,
              borderRadius: 6,
              flexShrink: 0,
              letterSpacing: "0.03em",
              textTransform: "uppercase",
            }}
          >
            {cap}
          </span>
        ))}
      </div>
    </div>
  );
};
