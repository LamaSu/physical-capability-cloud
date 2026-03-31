/**
 * S05_EmergingMarkets — "GLOBAL ACCESS"
 *
 * 420 frames (14 seconds). Neurotech story resolution + global access.
 *
 * Frame 0:    "GLOBAL ACCESS" — MONUMENT, 96px, C.fg. Slam entrance.
 * Frame 24:   Yellowcard UI panel (left). Spring entrance.
 * Frame 60:   "34 countries. No corporate account. No minimum deal size." — SWISS, 44px, C.fg.
 * Frame 120:  "A lab in Nairobi..." story lines — EXPRESSIVE, 44px, C.muted.
 * Frame 240:  Neurotech resolution — EXPRESSIVE, 44px, C.accent1 (green). Story A closes.
 *
 * DESIGN RULES:
 * - Min font: 36px
 * - Max 5 elements on screen
 * - bg: #050a0e
 * - No discord use in this scene
 * - Layout: left panel (Yellowcard UI) + right panel (story lines)
 */
import React from "react";
import { useCurrentFrame, useVideoConfig, AbsoluteFill, interpolate } from "remotion";
import { C, F, SIZE, slam, slamScale, smooth } from "../lib";

const COUNTRIES = [
  { name: "Kenya",     code: "KES", flag: "🇰🇪" },
  { name: "Nigeria",   code: "NGN", flag: "🇳🇬" },
  { name: "Argentina", code: "ARS", flag: "🇦🇷" },
  { name: "Colombia",  code: "COP", flag: "🇨🇴" },
  { name: "India",     code: "INR", flag: "🇮🇳" },
];

export const S05_EmergingMarkets: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── Title slam (frame 0) ──────────────────────────────────────────────────
  const titleScale = slamScale(frame, fps, 0, 2.2);
  const titleP     = slam(frame, fps, 0);
  const titleOpacity = Math.min(titleP * 6, 1);

  // ── Yellowcard panel (frame 24) ───────────────────────────────────────────
  const panelP  = smooth(frame, fps, 24);
  const panelY  = interpolate(panelP, [0, 1], [40, 0]);

  // ── Right top: 3 bullet lines (frame 60) ─────────────────────────────────
  const bulletP = smooth(frame, fps, 60);
  const bulletY = interpolate(bulletP, [0, 1], [24, 0]);

  // ── Story lines (frame 120) ───────────────────────────────────────────────
  const storyP  = smooth(frame, fps, 120);
  const storyY  = interpolate(storyP, [0, 1], [24, 0]);

  // ── Resolution (frame 240) ────────────────────────────────────────────────
  const resolveP = smooth(frame, fps, 240);
  const resolveY = interpolate(resolveP, [0, 1], [24, 0]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.bg,
        padding: "96px 128px",
        display: "flex",
        flexDirection: "column",
        gap: 0,
      }}
    >
      {/* GLOBAL ACCESS — title */}
      <div
        style={{
          fontFamily: F.monument,
          fontSize: SIZE.title,
          fontWeight: 700,
          color: C.fg,
          textTransform: "uppercase" as const,
          letterSpacing: "0.06em",
          lineHeight: 1.0,
          opacity: titleOpacity,
          transform: `scale(${titleScale})`,
          transformOrigin: "left center",
          marginBottom: 32,
        }}
      >
        GLOBAL ACCESS
      </div>

      {/* Two-column body */}
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          gap: 52,
          flex: 1,
          alignItems: "flex-start",
        }}
      >
        {/* LEFT — Yellowcard UI mockup */}
        <div
          style={{
            width: 720,
            flexShrink: 0,
            backgroundColor: "#0d1520",
            border: `1px solid #1e2d40`,
            borderRadius: 16,
            padding: "28px 32px",
            opacity: panelP,
            transform: `translateY(${panelY}px)`,
            display: "flex",
            flexDirection: "column",
            gap: 0,
          }}
        >
          {/* Panel header */}
          <div
            style={{
              fontFamily: F.swiss,
              fontSize: SIZE.label,
              fontWeight: 600,
              color: C.accent1,
              letterSpacing: "0.12em",
              textTransform: "uppercase" as const,
              marginBottom: 20,
              paddingBottom: 16,
              borderBottom: `1px solid ${C.border}`,
            }}
          >
            YELLOWCARD — FIAT RAMP
          </div>

          {/* "No corporate account required" label */}
          <div
            style={{
              fontFamily: F.swiss,
              fontSize: SIZE.label,
              fontWeight: 400,
              color: C.muted,
              letterSpacing: "0.04em",
              marginBottom: 24,
            }}
          >
            No corporate account required
          </div>

          {/* Country rows */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 18,
            }}
          >
            {COUNTRIES.map((c, i) => {
              const rowP = smooth(frame, fps, 24 + i * 16);
              return (
                <div
                  key={c.code}
                  style={{
                    display: "flex",
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    opacity: rowP,
                    backgroundColor: i === 4 ? "rgba(0,255,136,0.06)" : "transparent",
                    borderRadius: 8,
                    padding: "6px 12px",
                    margin: "0 -12px",
                  }}
                >
                  <div
                    style={{
                      fontFamily: F.swiss,
                      fontSize: SIZE.body,
                      fontWeight: 400,
                      color: C.fg,
                      display: "flex",
                      alignItems: "center",
                      gap: 14,
                    }}
                  >
                    <span style={{ fontSize: 36 }}>{c.flag}</span>
                    {c.name}
                  </div>
                  <div
                    style={{
                      fontFamily: F.brutalist,
                      fontSize: SIZE.label,
                      fontWeight: 700,
                      color: i === 4 ? C.accent1 : C.accent2,
                      letterSpacing: "0.08em",
                    }}
                  >
                    {c.code}
                  </div>
                </div>
              );
            })}
          </div>

          {/* USD to local currencies note */}
          <div
            style={{
              fontFamily: F.brutalist,
              fontSize: SIZE.label,
              fontWeight: 400,
              color: C.muted,
              marginTop: 24,
              paddingTop: 16,
              borderTop: `1px solid ${C.border}`,
              letterSpacing: "0.04em",
            }}
          >
            USD → KES · ARS · NGN · COP · INR · +30 more
          </div>
        </div>

        {/* RIGHT — story text column */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 36,
          }}
        >
          {/* Bullet lines: 34 countries / no corporate account / no minimum */}
          <div
            style={{
              opacity: bulletP,
              transform: `translateY(${bulletY}px)`,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            {[
              "34 countries.",
              "No corporate account.",
              "No minimum deal size.",
            ].map((line, i) => (
              <div
                key={i}
                style={{
                  fontFamily: F.swiss,
                  fontSize: SIZE.body,
                  fontWeight: 600,
                  color: C.fg,
                  letterSpacing: "0.01em",
                  lineHeight: 1.3,
                }}
              >
                {line}
              </div>
            ))}
          </div>

          {/* Story lines: Nairobi → Berlin → IPFS → on-chain */}
          <div
            style={{
              opacity: storyP,
              transform: `translateY(${storyY}px)`,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {[
              "A lab in Nairobi. A buyer in Berlin.",
              "Evidence on IPFS. Settled on-chain.",
              "No broker. No platform.",
            ].map((line, i) => (
              <div
                key={i}
                style={{
                  fontFamily: F.express,
                  fontSize: SIZE.body,
                  fontWeight: 300,
                  color: C.muted,
                  letterSpacing: "0.01em",
                  lineHeight: 1.4,
                }}
              >
                {line}
              </div>
            ))}
          </div>

          {/* Story A resolution — ACCENT1 green */}
          <div
            style={{
              opacity: resolveP,
              transform: `translateY(${resolveY}px)`,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {[
              "The neurotech team in Bangalore forms a company.",
              "It could not have existed before.",
            ].map((line, i) => (
              <div
                key={i}
                style={{
                  fontFamily: F.express,
                  fontSize: SIZE.body,
                  fontWeight: 400,
                  color: C.accent1,
                  letterSpacing: "0.01em",
                  lineHeight: 1.4,
                }}
              >
                {line}
              </div>
            ))}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

export default S05_EmergingMarkets;
