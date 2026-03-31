/**
 * S08_CTA — "The Close"
 *
 * 360 frames (12s).
 *
 * Frame 0-15:    Pure #000000.
 * Frame 15:      "PCC" SLAMS in — SIZE.hero (140px), MONUMENT, C.accent1.
 *                slamScale 2.5x → 1x. Neon glow. Noise drift. Breathing opacity.
 * Frame 45:      "Every physical capability. One protocol." — EXPRESSIVE, 44px, C.fg
 * Frame 90:      "capability.network" — SWISS, 64px, C.fg
 * Frame 140:     "Open source. Apache 2.0. Public goods." — SWISS, 36px, C.muted
 * Frame 230-320: Content dims. PCC glow persists alone.
 * Frame 320-360: PCC glow dims to black.
 *
 * Background: subtle radial glow (C.accent1 at 0.05, centered).
 *
 * Design rules enforced:
 * - Min font 36px
 * - Max 5 elements on screen (PCC + 3 text lines + glow bg = 5)
 * - bg #050a0e (except first 15 frames which are pure #000000)
 * - Safe margins: 128px left/right, 96px top/bottom
 */
import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  AbsoluteFill,
  interpolate,
} from "remotion";
import { noise2D } from "@remotion/noise";
import { C, F, SIZE, smooth, slamScale, fadeUp, breathe } from "../lib";

export const S08_CTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Pure black for first 15 frames
  if (frame < 15) {
    return <AbsoluteFill style={{ backgroundColor: "#000000" }} />;
  }

  // PCC SLAM at frame 15
  const pccP = smooth(frame, fps, 15);
  const pccScale = slamScale(frame, fps, 15, 2.5);
  const pccOpacity = Math.min(pccP * 5, 1);

  // Breathing after settle
  const pccBreathe = pccP > 0.95 ? breathe(frame, fps, 0.82, 1) : pccP;

  // Noise drift for organic feel
  const driftX = noise2D("pcc-close-x", 0, (frame / fps) * 0.2) * 5;
  const driftY = noise2D("pcc-close-y", 1, (frame / fps) * 0.2) * 3;

  // "Every physical capability. One protocol." — frame 45
  const tagFu = fadeUp(frame, fps, 45);

  // "capability.network" — frame 90
  const urlFu = fadeUp(frame, fps, 90);

  // "Open source. Apache 2.0. Public goods." — frame 140
  const ossFu = fadeUp(frame, fps, 140);

  // Content dim: 230-290 (faster to make room for sponsors)
  const contentDim = interpolate(frame, [230, 290], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // PCC glow dim: 280-360
  const pccDim = interpolate(frame, [280, 360], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.bg,
        overflow: "hidden",
      }}
    >
      {/* Background radial glow — C.accent1 at 0.05 */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 800,
          height: 600,
          background: `radial-gradient(ellipse, rgba(0,255,136,0.05) 0%, transparent 65%)`,
          pointerEvents: "none",
          opacity: pccDim,
        }}
      />

      {/* Main content — vertically centered */}
      <AbsoluteFill
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "96px 128px",
          gap: 32,
          boxSizing: "border-box" as const,
        }}
      >
        {/* PCC — SIZE.hero (140px), MONUMENT, C.accent1 */}
        <div
          style={{
            opacity: pccOpacity * pccBreathe * pccDim,
            transform: `scale(${pccScale}) translate(${driftX}px, ${driftY}px)`,
            textAlign: "center",
          }}
        >
          <span
            style={{
              fontFamily: F.monument,
              fontSize: SIZE.hero,
              fontWeight: 700,
              letterSpacing: "-0.04em",
              lineHeight: 0.9,
              textTransform: "uppercase" as const,
              color: C.accent1,
              textShadow: `
                0 0 60px rgba(0,255,136,0.8),
                0 0 120px rgba(0,255,136,0.4),
                0 0 200px rgba(0,255,136,0.15)
              `,
            }}
          >
            PCC
          </span>
        </div>

        {/* "Every physical capability. One protocol." */}
        <div
          style={{
            opacity: tagFu.opacity * contentDim,
            transform: `translateY(${tagFu.y}px)`,
            textAlign: "center",
          }}
        >
          <span
            style={{
              fontFamily: F.express,
              fontSize: SIZE.body,
              fontWeight: 300,
              color: C.fg,
              lineHeight: 1.4,
            }}
          >
            Every physical capability. One protocol.
          </span>
        </div>

        {/* "capability.network" */}
        <div
          style={{
            opacity: urlFu.opacity * contentDim,
            transform: `translateY(${urlFu.y}px)`,
            textAlign: "center",
          }}
        >
          <span
            style={{
              fontFamily: F.swiss,
              fontSize: SIZE.subtitle,
              fontWeight: 600,
              color: C.fg,
              letterSpacing: "-0.01em",
            }}
          >
            capability.network
          </span>
        </div>

        {/* "Open source. Apache 2.0. Public goods." */}
        <div
          style={{
            opacity: ossFu.opacity * contentDim,
            transform: `translateY(${ossFu.y}px)`,
            textAlign: "center",
          }}
        >
          <span
            style={{
              fontFamily: F.swiss,
              fontSize: SIZE.label,
              fontWeight: 400,
              color: C.muted,
              letterSpacing: "0.02em",
            }}
          >
            Open source. Apache 2.0. Public goods.
          </span>
        </div>
      </AbsoluteFill>

      {/* Sponsors removed — already shown in architecture scene */}
    </AbsoluteFill>
  );
};

export default S08_CTA;
