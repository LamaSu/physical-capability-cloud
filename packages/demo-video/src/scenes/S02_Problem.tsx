/**
 * S02_Problem — "Two Worlds" (REWRITTEN from storyboard.json)
 *
 * 480 frames (16 seconds). Two-panel contrast. Discord use #1.
 *
 * Two equal panels separated by 32px gutter at center.
 * LEFT (old world): surface panel #0d1520, muted treatment
 * RIGHT (new world): elevated #121c2a, accent glow
 *
 * Frame 0:    Left panel card springs up
 * Frame 0:    "WITHOUT PCC" label — SWISS 36px, muted
 * Frame 18:   "A biotech team in Bangalore..." — EXPRESSIVE 44px, fg
 * Frame 48:   "3 months. $40K. 2 flights. 3 NDAs." — BRUTALIST 44px, gold
 * Frame 72:   "No composable proof." — SWISS 44px, #ff0066 (DISCORD #1). Slam.
 * Frame 96:   Right panel card springs up. "WITH PCC" — accent1
 * Frame 114:  "Same team. Same job." — EXPRESSIVE 44px
 * Frame 132:  "47 seconds. 1.5% fee. On-chain proof." — BRUTALIST 44px, accent1
 * Frame 200:  "Xometry takes 34.5%. We take 1.5%." — SWISS 36px, muted (footer)
 *
 * Discord: #ff0066 on "No composable proof." — exactly ONCE in this scene.
 * Max elements simultaneous: 4
 */
import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  AbsoluteFill,
  interpolate,
  Easing,
} from "remotion";
import { C, F, SIZE, smooth, slam, fadeUp } from "../lib";

function springIn(frame: number, fps: number, delay: number) {
  const p = smooth(frame, fps, delay);
  return {
    opacity: Math.min(p * 4, 1),
    y: interpolate(p, [0, 1], [40, 0]),
  };
}

export const S02_Problem: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Left panel card
  const leftCard = springIn(frame, fps, 0);

  // Left panel contents
  const e01 = springIn(frame, fps, 0);
  const e02 = springIn(frame, fps, 18);
  const e03 = springIn(frame, fps, 48);
  // E04 — Discord slam
  const e04Slam = slam(frame, fps, 72);
  const e04X = interpolate(e04Slam, [0, 1], [-40, 0]);
  const e04Opacity = Math.min(e04Slam * 5, 1);

  // Right panel
  const rightCard = springIn(frame, fps, 96);
  const e05 = springIn(frame, fps, 96);
  const e06 = springIn(frame, fps, 114);
  const e07 = springIn(frame, fps, 132);

  // Footer stat
  const e08 = fadeUp(frame, fps, 200);

  // End fade out
  const endDim = interpolate(frame, [440, 480], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });

  const panelTop = 192;
  const panelHeight = 550;
  const leftX = 128;
  const panelWidth = 720;
  const rightX = 1072;
  const innerPad = 40;

  return (
    <AbsoluteFill style={{ backgroundColor: C.bg, opacity: endDim }}>
      {/* ── LEFT PANEL — old world ── */}
      <div
        style={{
          position: "absolute",
          left: leftX,
          top: panelTop,
          width: panelWidth,
          height: panelHeight,
          backgroundColor: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          opacity: leftCard.opacity,
          transform: `translateY(${leftCard.y}px)`,
        }}
      />

      {/* WITHOUT PCC label */}
      {frame >= 0 && (
        <div
          style={{
            position: "absolute",
            left: leftX + innerPad,
            top: panelTop + 40,
            fontFamily: F.swiss,
            fontSize: SIZE.label,
            fontWeight: 500,
            color: C.muted,
            letterSpacing: "0.12em",
            textTransform: "uppercase" as const,
            opacity: e01.opacity,
            transform: `translateY(${e01.y}px)`,
          }}
        >
          WITHOUT PCC
        </div>
      )}

      {/* "A biotech team in Bangalore needs HPLC analysis." */}
      {frame >= 18 && (
        <div
          style={{
            position: "absolute",
            left: leftX + innerPad,
            top: panelTop + 104,
            width: panelWidth - innerPad * 2,
            fontFamily: F.express,
            fontSize: SIZE.body,
            color: C.fg,
            lineHeight: 1.4,
            opacity: e02.opacity,
            transform: `translateY(${e02.y}px)`,
          }}
        >
          A biotech team in Bangalore
          <br />
          needs HPLC analysis.
        </div>
      )}

      {/* "3 months. $40K. 2 flights. 3 NDAs." */}
      {frame >= 48 && (
        <div
          style={{
            position: "absolute",
            left: leftX + innerPad,
            top: panelTop + 220,
            width: panelWidth - innerPad * 2,
            fontFamily: F.brutalist,
            fontSize: SIZE.body,
            color: C.gold,
            lineHeight: 1.4,
            opacity: e03.opacity,
            transform: `translateY(${e03.y}px)`,
          }}
        >
          3 months. $40K. 2 flights. 3 NDAs.
        </div>
      )}

      {/* "No composable proof." — DISCORD #1 */}
      {frame >= 72 && (
        <div
          style={{
            position: "absolute",
            left: leftX + innerPad,
            top: panelTop + 300,
            width: panelWidth - innerPad * 2,
            fontFamily: F.swiss,
            fontSize: SIZE.body,
            fontWeight: 600,
            color: C.discord,
            lineHeight: 1.2,
            opacity: e04Opacity,
            transform: `translateX(${e04X}px)`,
          }}
        >
          No composable proof.
        </div>
      )}

      {/* ── RIGHT PANEL — PCC world ── */}
      <div
        style={{
          position: "absolute",
          left: rightX,
          top: panelTop,
          width: panelWidth,
          height: panelHeight,
          backgroundColor: "#121c2a",
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          boxShadow: `0 0 40px rgba(0,255,136,0.06)`,
          opacity: rightCard.opacity,
          transform: `translateY(${rightCard.y}px)`,
        }}
      />

      {/* WITH PCC label */}
      {frame >= 96 && (
        <div
          style={{
            position: "absolute",
            left: rightX + innerPad,
            top: panelTop + 40,
            fontFamily: F.swiss,
            fontSize: SIZE.label,
            fontWeight: 500,
            color: C.accent1,
            letterSpacing: "0.12em",
            textTransform: "uppercase" as const,
            opacity: e05.opacity,
            transform: `translateY(${e05.y}px)`,
          }}
        >
          WITH PCC
        </div>
      )}

      {/* "Same team. Same job." */}
      {frame >= 114 && (
        <div
          style={{
            position: "absolute",
            left: rightX + innerPad,
            top: panelTop + 104,
            width: panelWidth - innerPad * 2,
            fontFamily: F.express,
            fontSize: SIZE.body,
            color: C.fg,
            lineHeight: 1.4,
            opacity: e06.opacity,
            transform: `translateY(${e06.y}px)`,
          }}
        >
          Same team. Same job.
        </div>
      )}

      {/* "47 seconds. 1.5% fee. On-chain proof." */}
      {frame >= 132 && (
        <div
          style={{
            position: "absolute",
            left: rightX + innerPad,
            top: panelTop + 220,
            width: panelWidth - innerPad * 2,
            fontFamily: F.brutalist,
            fontSize: SIZE.body,
            color: C.accent1,
            lineHeight: 1.4,
            opacity: e07.opacity,
            transform: `translateY(${e07.y}px)`,
          }}
        >
          47 seconds. 1.5% fee. On-chain proof.
        </div>
      )}

      {/* "Trustless. No broker." — right panel resolution */}
      {frame >= 160 && (
        <div
          style={{
            position: "absolute",
            left: rightX + innerPad,
            top: panelTop + 300,
            width: panelWidth - innerPad * 2,
            fontFamily: F.swiss,
            fontSize: SIZE.body,
            fontWeight: 600,
            color: C.accent1,
            lineHeight: 1.2,
            opacity: interpolate(smooth(frame, fps, 160), [0, 1], [0, 1]),
            transform: `translateY(${interpolate(smooth(frame, fps, 160), [0, 1], [20, 0])}px)`,
          }}
        >
          Trustless. No broker.
        </div>
      )}

      {/* Footer stat — spanning both panels */}
      {frame >= 200 && (
        <div
          style={{
            position: "absolute",
            left: leftX,
            top: panelTop + panelHeight + 28,
            width: rightX + panelWidth - leftX,
            fontFamily: F.swiss,
            fontSize: SIZE.label,
            color: C.muted,
            textAlign: "center" as const,
            opacity: e08.opacity,
            transform: `translateY(${e08.y}px)`,
          }}
        >
          Xometry takes 34.5%. We take 1.5%.
        </div>
      )}
    </AbsoluteFill>
  );
};

export default S02_Problem;
