/**
 * S06_Cascade — "The Domino Fall"
 *
 * 540 frames (18 seconds). Evidence pipeline as a rapid chain reaction.
 *
 * Each step TRIGGERS the next — a light pulse travels down the chain.
 * 12-frame stagger (was 25). Twice as fast. Relentless.
 *
 * Frame 0:     Title — Editorial italic, holographic gradient. Slams (not fades).
 * Frame 18:    Steps cascade at 12-frame stagger (9 steps × 12 = 108 frames).
 * Frame 130:   Steps complete. Light pulse sweeps down (4-frame stagger).
 * Frame 200:   Step 8 (Escrow Settlement) — DISCORD FLASH. 2-frame full-screen burst.
 *              The money moment is the danger moment.
 * Frame 300:   Closer text arrives with authority.
 * Frame 500:   Dim for transition.
 *
 * Axiom I: Steps cascade top→bottom. Numbered circles enforce sequence.
 * Axiom II: Step 8 = discord. Money = danger = the intentional break.
 * Axiom III: Cascade → pulse → flash → settle. Time is the proof.
 *
 * Voices: Editorial (title), Swiss (steps), Monument (numbers), Expressive (closer)
 */
import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  AbsoluteFill,
  interpolate,
  Easing,
} from "remotion";
import { noise2D } from "@remotion/noise";
import {
  COLORS,
  FONTS,
  GRADIENTS,
  EVIDENCE_PIPELINE,
  slamSpring,
  smoothSpring,
  fadeSlideUp,
  flashBurst,
  beatPulse,
} from "../lib";
import { PulseIndicator } from "../components/PulseIndicator";

const STEP_STAGGER = 12; // frames between steps (was 25)
const STEP_HEIGHT = 48;

const ConnectorLine: React.FC<{ appearFrame: number; color: string }> = ({
  appearFrame,
  color,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = smoothSpring(frame, fps, appearFrame + 6);
  const h = interpolate(progress, [0, 1], [0, 14]);

  return (
    <div
      style={{
        width: 2,
        height: h,
        background: `linear-gradient(to bottom, ${color}88, transparent)`,
        marginLeft: 35,
        flexShrink: 0,
      }}
    />
  );
};

const EvidenceStep: React.FC<{
  index: number;
  step: string;
  detail: string;
  color: string;
  appearFrame: number;
  isDiscord: boolean;
}> = ({ index, step, detail, color, appearFrame, isDiscord }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Slam entrance (faster than before)
  const progress = slamSpring(frame, fps, appearFrame);
  const slideX = interpolate(progress, [0, 1], [-60, 0]);
  const enterOpacity = Math.min(progress * 4, 1);

  // Light pulse sweep at frame 130 + index*4
  const pulseStart = 130 + index * 4;
  const pulseFlash = flashBurst(frame, pulseStart, 4);

  // Glow state
  const glowPulse = pulseFlash;

  const borderColor = isDiscord
    ? `rgba(248,113,113,${0.4 + glowPulse * 0.6})`
    : `rgba(255,255,255,${0.06 + glowPulse * 0.4})`;

  const boxShadow = glowPulse > 0.02
    ? isDiscord
      ? `0 0 24px rgba(248,113,113,${glowPulse * 0.6})`
      : `0 0 24px ${color}${Math.round(glowPulse * 80).toString(16).padStart(2, "0")}`
    : undefined;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        height: STEP_HEIGHT,
        padding: "0 18px",
        background: COLORS.bg.surface,
        border: `1px solid ${borderColor}`,
        borderRadius: 10,
        opacity: enterOpacity,
        transform: `translateX(${slideX}px)`,
        boxShadow,
        flexShrink: 0,
      }}
    >
      {/* Number circle */}
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          backgroundColor: isDiscord ? COLORS.discord : color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: FONTS.monument,
            fontSize: 13,
            fontWeight: 700,
            color: COLORS.bg.deep,
            lineHeight: 1,
          }}
        >
          {index + 1}
        </span>
      </div>

      {/* Step name + detail */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: FONTS.swiss,
            fontSize: 22,
            fontWeight: 700,
            color: COLORS.fg,
            lineHeight: 1.2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {step}
        </div>
        <div
          style={{
            fontFamily: FONTS.swiss,
            fontSize: 17,
            fontWeight: 400,
            color: COLORS.muted,
            lineHeight: 1.2,
            marginTop: 1,
          }}
        >
          {detail}
        </div>
      </div>

      <PulseIndicator
        color={isDiscord ? COLORS.discord : color}
        size={7}
        delay={appearFrame}
      />
    </div>
  );
};

export const S06_Dashboard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Title SLAMS
  const titleProgress = slamSpring(frame, fps, 0);
  const titleScale = interpolate(titleProgress, [0, 1], [2, 1]);
  const titleOpacity = Math.min(titleProgress * 5, 1);
  const titleDrift = noise2D("s06-title", 0, (frame / fps) * 0.2) * 1.5;

  // Discord FLASH at step 8 — frame 200
  const escrowFlash = flashBurst(frame, 200, 3);

  // Closer text
  const closerFade = fadeSlideUp(frame, fps, 300);

  // End dim
  const endDim = interpolate(frame, [500, 538], [1, 0.2], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const beat = beatPulse(frame, fps, 170, 0.03);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg.deep,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        paddingTop: 44,
        paddingBottom: 36,
        paddingLeft: 80,
        paddingRight: 80,
        overflow: "hidden",
      }}
    >
      {/* Cyan ambient */}
      <div
        style={{
          position: "absolute",
          top: "35%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 800,
          height: 600,
          background: `radial-gradient(ellipse, rgba(148,184,255,${0.03 + beat}) 0%, transparent 65%)`,
          opacity: endDim,
          pointerEvents: "none",
        }}
      />

      {/* Discord ambient — bottom right */}
      <div
        style={{
          position: "absolute",
          bottom: "10%",
          right: "15%",
          width: 300,
          height: 300,
          background: "radial-gradient(circle, rgba(248,113,113,0.03) 0%, transparent 70%)",
          pointerEvents: "none",
        }}
      />

      {/* Title — Editorial italic, holographic, SLAM */}
      <div
        style={{
          opacity: titleOpacity * endDim,
          transform: `scale(${titleScale}) translateX(${titleDrift}px)`,
          marginBottom: 28,
          textAlign: "center",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: FONTS.editorial,
            fontSize: 48,
            fontWeight: 400,
            fontStyle: "italic",
            lineHeight: 1.1,
            background: GRADIENTS.holographic,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          Sovereign Infrastructure
        </span>
      </div>

      {/* Steps cascade — fast stagger */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          maxWidth: 840,
          gap: 0,
          flex: 1,
          opacity: endDim,
        }}
      >
        {EVIDENCE_PIPELINE.map((item, i) => {
          const appearFrame = 18 + i * STEP_STAGGER;
          const isDiscord = i === 7; // Escrow Settlement

          return (
            <React.Fragment key={i}>
              <EvidenceStep
                index={i}
                step={item.step}
                detail={item.detail}
                color={item.color}
                appearFrame={appearFrame}
                isDiscord={isDiscord}
              />
              {i < EVIDENCE_PIPELINE.length - 1 && (
                <ConnectorLine appearFrame={appearFrame} color={item.color} />
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* Closer — Expressive italic */}
      <div
        style={{
          marginTop: 20,
          opacity: closerFade.opacity * endDim,
          transform: `translateY(${closerFade.translateY}px)`,
          textAlign: "center",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: FONTS.expressive,
            fontSize: 24,
            fontWeight: 300,
            color: COLORS.muted,
            letterSpacing: "0.01em",
            fontStyle: "italic",
          }}
        >
          Zero trust required. The infrastructure does the coordination.
        </span>
      </div>

      {/* DISCORD FLASH on escrow step */}
      {escrowFlash > 0 && (
        <AbsoluteFill
          style={{
            backgroundColor: `rgba(248,113,113,${escrowFlash * 0.2})`,
            pointerEvents: "none",
          }}
        />
      )}
    </AbsoluteFill>
  );
};

export default S06_Dashboard;
