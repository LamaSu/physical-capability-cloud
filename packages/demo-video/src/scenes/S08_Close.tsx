/**
 * S08_Close — "The Close"
 *
 * 300 frames (10 seconds). Clean resolution. Earned calm.
 *
 * Frame 0-18:  Wipe-in (handled by composition layer).
 * Frame 18:    Three-line tagline springs in — MONUMENT, 96px, C.fg.
 *              "Physical work, composable."
 *              "Verified by protocol."
 *              "Owned by operators."
 * Frame 90:    URL springs in — SWISS, 64px, C.accent1.
 *              "capability.network"
 * Frame 150:   CTA fades up — EXPRESSIVE, 44px, C.muted.
 *              "Join the operator beta."
 *
 * HC-9: 14 words total on screen (9 tagline + 1 URL + 4 CTA).
 * Near-empty: 80% dark space. Max 3 elements.
 * No discord use.
 *
 * DESIGN RULES:
 * - Min font: 44px (body)
 * - bg: #050a0e
 * - Optical center: ~55% vertical height (488px from top in 888px inner)
 */
import React from "react";
import { useCurrentFrame, useVideoConfig, AbsoluteFill, interpolate } from "remotion";
import { C, F, SIZE, smooth, fadeUp } from "../lib";

const TAGLINE_LINES = [
  "Physical work, composable.",
  "Verified by protocol.",
  "Owned by operators.",
];

export const S08_Close: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── Tagline spring (frame 18) ─────────────────────────────────────────────
  const tagP = smooth(frame, fps, 18);
  const tagY = interpolate(tagP, [0, 1], [32, 0]);

  // ── URL spring (frame 90) ─────────────────────────────────────────────────
  const urlP = smooth(frame, fps, 90);
  const urlY = interpolate(urlP, [0, 1], [24, 0]);

  // ── CTA fade up (frame 150) ───────────────────────────────────────────────
  const ctaAnim = fadeUp(frame, fps, 150);

  // Optical center: positioned so 3-line block sits at ~55% height.
  // Inner height = 1080 - 192 (top+bottom 96px padding) = 888px
  // 55% = ~488px from top of inner = 96+488 = 584 absolute.
  // 3-line MONUMENT 96px block ~= 96*1.2*3 = 346px tall.
  // Center of block at 584 → top at 584-173 = 411. Use y=380 for feel.
  const TAGLINE_TOP = 380;
  const URL_TOP     = 680;
  const CTA_TOP     = 760;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.bg,
      }}
    >
      {/* Subtle radial glow at optical center */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse 900px 500px at 50% 55%, rgba(0,255,136,0.04) 0%, transparent 70%)",
          pointerEvents: "none",
        }}
      />

      {/* Tagline — three lines */}
      <div
        style={{
          position: "absolute",
          left: 128,
          top: TAGLINE_TOP,
          right: 128,
          opacity: tagP,
          transform: `translateY(${tagY}px)`,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {TAGLINE_LINES.map((line, i) => (
          <div
            key={i}
            style={{
              fontFamily: F.monument,
              fontSize: SIZE.title,
              fontWeight: 700,
              color: C.fg,
              letterSpacing: "0.04em",
              lineHeight: 1.2,
              textTransform: "uppercase" as const,
            }}
          >
            {line}
          </div>
        ))}
      </div>

      {/* URL — capability.network */}
      <div
        style={{
          position: "absolute",
          left: 128,
          top: URL_TOP,
          opacity: urlP,
          transform: `translateY(${urlY}px)`,
        }}
      >
        <div
          style={{
            fontFamily: F.swiss,
            fontSize: 64,
            fontWeight: 600,
            color: C.accent1,
            letterSpacing: "0.02em",
            textShadow: `0 0 40px rgba(0,255,136,0.4), 0 0 80px rgba(0,255,136,0.15)`,
          }}
        >
          capability.network
        </div>
      </div>

      {/* CTA — Join the operator beta. */}
      <div
        style={{
          position: "absolute",
          left: 128,
          top: CTA_TOP,
          opacity: ctaAnim.opacity,
          transform: `translateY(${ctaAnim.y}px)`,
        }}
      >
        <div
          style={{
            fontFamily: F.express,
            fontSize: SIZE.body,
            fontWeight: 300,
            color: C.muted,
            letterSpacing: "0.02em",
          }}
        >
          Join the operator beta.
        </div>
      </div>
    </AbsoluteFill>
  );
};

export default S08_Close;
