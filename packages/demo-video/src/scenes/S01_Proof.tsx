/**
 * S01_Proof — "Cold Open" (REWRITTEN from storyboard.json)
 *
 * 600 frames (20 seconds). Opens on proof, not explanation.
 * OT-2 camera feed right 60%. Content left 40%.
 *
 * Frame 0–14:   Full-bleed dark bg. Silence. Machine is the only element.
 * Frame 15:     Terminal line 1 types: "kernel-agent: job_accepted — OT-2..."
 * Frame 60:     Terminal line 2 types: "evidence: archived — bafy...q7r4 | tier-2"
 * Frame 120:    "An AI agent submitted this job." — slams from left
 * Frame 150:    "The proof is permanent." — fade up, muted
 * Frame 300:    "CAPABILITY NETWORK" — MONUMENT 96px, SLAM
 * Frame 360:    "capability.network" — accent1, fade up
 * Frame 596:    Wipe right begins
 *
 * Discord: NONE in this scene.
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

// Typewriter helper
function typewriter(
  frame: number,
  text: string,
  startFrame: number,
  durationFrames: number
): string {
  if (frame < startFrame) return "";
  const elapsed = frame - startFrame;
  const charsPerFrame = text.length / durationFrames;
  const chars = Math.min(Math.floor(elapsed * charsPerFrame) + 1, text.length);
  return text.slice(0, chars);
}

const LINE1 = "kernel-agent: job_accepted — OT-2 liquid transfer protocol v2";
const LINE2 = "evidence: archived — bafy...q7r4 | tier-2 | 47 sensors";

export const S01_Proof: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Terminal line 1 — starts frame 15, 40 frames to type
  const l1 = typewriter(frame, LINE1, 15, 40);
  const l1Complete = frame >= 15 + 40;
  const l1CursorBlink = Math.sin((frame - 15) * 0.35) > 0;

  // Terminal line 2 — starts frame 60, 35 frames to type
  const l2Visible = frame >= 60;
  const l2 = typewriter(frame, LINE2, 60, 35);
  const l2Complete = frame >= 60 + 35;
  const l2CursorBlink = Math.sin((frame - 60) * 0.35) > 0;

  // "An AI agent submitted this job." — slam at frame 120
  const line3Slam = slam(frame, fps, 120);
  const line3X = interpolate(line3Slam, [0, 1], [-80, 0]);
  const line3Opacity = Math.min(line3Slam * 6, 1);

  // "The proof is permanent." — fadeUp at frame 150
  const line4 = fadeUp(frame, fps, 150);

  // "CAPABILITY NETWORK" — slam at frame 300
  const logoSlam = slam(frame, fps, 300);
  const logoX = interpolate(logoSlam, [0, 1], [-60, 0]);
  const logoOpacity = Math.min(logoSlam * 6, 1);

  // "capability.network" — fadeUp at frame 360
  const urlFade = fadeUp(frame, fps, 360);

  // Wipe right transition out — frames 580–600
  const wipeClip = interpolate(frame, [580, 600], [0, 100], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.bg,
        clipPath: `inset(0 ${wipeClip}% 0 0)`,
      }}
    >
      {/* OT-2 feed — right 60% (simulated with gradient for rendering) */}
      <div
        style={{
          position: "absolute",
          left: "40%",
          top: 0,
          right: 0,
          bottom: 0,
          background: `linear-gradient(135deg,
            rgba(0,30,60,0.7) 0%,
            rgba(0,60,80,0.5) 40%,
            rgba(0,40,60,0.6) 100%)`,
          opacity: 0.7,
        }}
      />

      {/* Subtle grid overlay on OT-2 side */}
      <div
        style={{
          position: "absolute",
          left: "40%",
          top: 0,
          right: 0,
          bottom: 0,
          backgroundImage: `
            linear-gradient(rgba(0,255,136,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0,255,136,0.03) 1px, transparent 1px)
          `,
          backgroundSize: "60px 60px",
          pointerEvents: "none",
        }}
      />

      {/* Left content panel — padding 96px top/bottom, 128px left */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "42%",
          bottom: 0,
          padding: "96px 0 96px 128px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-start",
        }}
      >
        {/* Vertical spacer — ~45% from top */}
        <div style={{ flex: "0 0 45%", minHeight: 0 }} />

        {/* Terminal line 1 */}
        <div
          style={{
            fontFamily: F.brutalist,
            fontSize: SIZE.label,
            color: C.accent1,
            lineHeight: 1.5,
            letterSpacing: "0.02em",
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}
        >
          {l1}
          {!l1Complete && (
            <span style={{ opacity: l1CursorBlink ? 1 : 0, color: C.accent1 }}>▌</span>
          )}
          {l1Complete && (
            <span style={{ opacity: l1CursorBlink ? 1 : 0, color: C.accent1 }}>▌</span>
          )}
        </div>

        {/* Terminal line 2 */}
        {l2Visible && (
          <div
            style={{
              fontFamily: F.brutalist,
              fontSize: SIZE.label,
              color: C.accent2,
              lineHeight: 1.5,
              letterSpacing: "0.02em",
              whiteSpace: "nowrap",
              overflow: "hidden",
              marginBottom: 32,
            }}
          >
            {l2}
            {!l2Complete && (
              <span style={{ opacity: l2CursorBlink ? 1 : 0, color: C.accent2 }}>▌</span>
            )}
          </div>
        )}

        {/* "An AI agent submitted this job." */}
        {frame >= 120 && (
          <div
            style={{
              fontFamily: F.express,
              fontSize: SIZE.body,
              color: C.fg,
              lineHeight: 1.4,
              opacity: line3Opacity,
              transform: `translateX(${line3X}px)`,
              marginBottom: 12,
            }}
          >
            An AI agent submitted this job.
          </div>
        )}

        {/* "The proof is permanent." */}
        {frame >= 150 && (
          <div
            style={{
              fontFamily: F.express,
              fontSize: SIZE.body,
              color: C.muted,
              lineHeight: 1.4,
              opacity: line4.opacity,
              transform: `translateY(${line4.y}px)`,
              marginBottom: 60,
            }}
          >
            The proof is permanent.
          </div>
        )}

        {/* CAPABILITY NETWORK — brand slam */}
        {frame >= 300 && (
          <div
            style={{
              fontFamily: F.monument,
              fontSize: SIZE.title,
              fontWeight: 700,
              color: C.fg,
              textTransform: "uppercase" as const,
              letterSpacing: "0.08em",
              lineHeight: 1,
              opacity: logoOpacity,
              transform: `translateX(${logoX}px)`,
              marginBottom: 12,
            }}
          >
            CAPABILITY NETWORK
          </div>
        )}

        {/* capability.network URL */}
        {frame >= 360 && (
          <div
            style={{
              fontFamily: F.swiss,
              fontSize: SIZE.label,
              color: C.accent1,
              letterSpacing: "0.04em",
              opacity: urlFade.opacity,
              transform: `translateY(${urlFade.y}px)`,
            }}
          >
            capability.network
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

export default S01_Proof;
