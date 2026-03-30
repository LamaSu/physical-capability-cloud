/**
 * S04_Circuit — "The Living Pipeline"
 *
 * 870 frames (29 seconds). Hero scene. The machine revealed.
 *
 * Frame 0-20:   Title whispers in (Expressive thin — restraint before power).
 * Frame 20-120: Six phase cards SLAM in with 15-frame stagger (fast, aggressive).
 * Frame 60-150: SVG connectors draw at 2x speed between nodes.
 * Frame 160:    LIGHT PULSE travels through all 6 nodes — 4 frames each.
 *               Each node's glow SPIKES as the pulse passes.
 * Frame 200:    Glow ripple — faster, more aggressive (4-frame stagger).
 * Frame 300:    Three key insights WHIP UP from bottom.
 * Frame 500+:   Code fragments scroll slowly in background (TypeScript texture).
 * Frame 830:    Everything dims for transition.
 *
 * Axiom I: Phases are the heroes. Title whispers to let them speak.
 * Axiom II: ESCROW (index 2) has discord border. The "lock" moment stands apart.
 * Axiom III: Sequential reveal → pulse → ripple → insights. Layered time.
 *
 * Voices: Expressive thin (title), Monument (phase names), Swiss (descriptions, insights)
 */
import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  AbsoluteFill,
  spring,
  interpolate,
  Easing,
} from "remotion";
import { noise2D } from "@remotion/noise";
import {
  COLORS,
  FONTS,
  SIX_PHASES,
  CODE_FRAGMENTS,
  slamSpring,
  smoothSpring,
  fadeSlideUp,
  whipUp,
  flashBurst,
  beatPulse,
} from "../lib";
import { PulseIndicator } from "../components/PulseIndicator";

const NODE_STAGGER = 15; // frames between each node (was 50)

const PhaseCard: React.FC<{
  phase: (typeof SIX_PHASES)[number];
  index: number;
}> = ({ phase, index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const nodeDelay = 20 + index * NODE_STAGGER;
  const progress = slamSpring(frame, fps, nodeDelay);
  const enterScale = interpolate(progress, [0, 1], [1.8, 1]); // slam from 1.8x
  const enterOpacity = Math.min(progress * 4, 1);

  // Light pulse — travels through at frame 160 + index*4
  const pulseFrame = 160 + index * 4;
  const pulseFlash = flashBurst(frame, pulseFrame, 6);

  // Glow ripple at frame 200 + index*4
  const rippleDelay = 200 + index * 4;
  const ripple = spring({
    frame: frame - rippleDelay,
    fps,
    config: { stiffness: 600, damping: 10 },
    durationInFrames: 25,
  });
  const rippleGlow = interpolate(ripple, [0, 0.4, 1], [0, 1, 0.15]);

  // Continuous idle glow
  const idleGlow =
    frame > nodeDelay + 12
      ? 0.3 + noise2D(`glow-${index}`, 0, (frame / fps) * 0.5) * 0.2
      : 0;

  const totalGlow = Math.max(idleGlow, rippleGlow, pulseFlash);

  // Discord override for ESCROW (index 2)
  const isEscrow = index === 2;
  const borderColor = isEscrow ? COLORS.discord : phase.color;
  const glowColor = isEscrow ? COLORS.discord : phase.color;

  return (
    <div
      style={{
        opacity: enterOpacity,
        transform: `scale(${enterScale})`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        flex: 1,
        maxWidth: 220,
      }}
    >
      <div
        style={{
          width: "100%",
          padding: "18px 12px 16px",
          background: COLORS.bg.surface,
          border: `1px solid ${borderColor}${Math.round((0.3 + totalGlow * 0.7) * 255).toString(16).padStart(2, "0")}`,
          borderRadius: 12,
          boxShadow: `
            0 0 ${12 + totalGlow * 36}px ${glowColor}${Math.round(totalGlow * 180).toString(16).padStart(2, "0")},
            inset 0 1px 0 rgba(255,255,255,0.04)
          `,
          textAlign: "center",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Radial bg glow */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(ellipse at center, ${glowColor}${Math.round(totalGlow * 40).toString(16).padStart(2, "0")} 0%, transparent 70%)`,
            pointerEvents: "none",
          }}
        />

        {/* Index badge */}
        <div
          style={{
            position: "absolute",
            top: 6,
            right: 8,
            fontFamily: FONTS.brutalist,
            fontSize: 14,
            color: borderColor,
            opacity: 0.5,
            letterSpacing: "0.05em",
          }}
        >
          {String(index + 1).padStart(2, "0")}
        </div>

        {/* Pulse */}
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
          <PulseIndicator
            color={isEscrow ? COLORS.discord : phase.color}
            size={8}
            delay={nodeDelay + 3}
          />
        </div>

        {/* Phase name — Monument */}
        <div
          style={{
            fontFamily: FONTS.monument,
            fontSize: 22,
            fontWeight: 700,
            color: borderColor,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            position: "relative",
            lineHeight: 1.2,
          }}
        >
          {phase.name}
        </div>
      </div>

      {/* Description — Swiss */}
      <div
        style={{
          fontFamily: FONTS.swiss,
          fontSize: 16,
          color: COLORS.muted,
          textAlign: "center",
          lineHeight: 1.4,
          maxWidth: 200,
        }}
      >
        {phase.desc}
      </div>
    </div>
  );
};

/** SVG connector — draws at 2x speed */
const Connector: React.FC<{ fromIndex: number; color: string }> = ({
  fromIndex,
  color,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const connDelay = 20 + fromIndex * NODE_STAGGER + 8;
  const progress = smoothSpring(frame, fps, connDelay, 10); // faster draw
  const lineLen = 56;
  const dashOffset = interpolate(progress, [0, 1], [lineLen, 0]);

  return (
    <div
      style={{
        flex: "0 0 56px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        paddingBottom: 48,
      }}
    >
      <svg width={56} height={10} overflow="visible">
        <line x1={0} y1={5} x2={56} y2={5} stroke={`${color}2a`} strokeWidth={1.5} />
        <line
          x1={0} y1={5} x2={56} y2={5}
          stroke={color}
          strokeWidth={1.5}
          strokeDasharray={lineLen}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
        />
        <polygon points="48,1.5 56,5 48,8.5" fill={color} opacity={progress} />
      </svg>
    </div>
  );
};

/** Key insights — WHIP UP from bottom, not gentle fade */
const KeyInsights: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const insights = [
    "AI agents discover & negotiate automatically",
    "Milestone escrow locks funds before work starts",
    "Cryptographic evidence proves every step",
  ];

  return (
    <div style={{ display: "flex", gap: 18, justifyContent: "center", flexWrap: "wrap", padding: "0 20px" }}>
      {insights.map((text, i) => {
        const delay = 300 + i * 12;
        const { opacity, translateY } = whipUp(frame, fps, delay, 80);

        return (
          <div
            key={i}
            style={{
              opacity,
              transform: `translateY(${translateY}px)`,
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 18px",
              background: "rgba(255,255,255,0.03)",
              border: `1px solid rgba(255,255,255,0.08)`,
              borderRadius: 40,
            }}
          >
            <div
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: COLORS.emerald,
                boxShadow: `0 0 7px rgba(52,211,153,0.7)`,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontFamily: FONTS.swiss,
                fontSize: 22,
                color: COLORS.fg,
                fontWeight: 400,
              }}
            >
              {text}
            </span>
          </div>
        );
      })}
    </div>
  );
};

/** Scrolling code fragments — background texture */
const CodeTexture: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const codeOpacity = interpolate(frame, [500, 540], [0, 0.08], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  if (codeOpacity <= 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        opacity: codeOpacity,
        pointerEvents: "none",
      }}
    >
      {CODE_FRAGMENTS.map((line, i) => {
        const y = ((i * 68 - (frame * 0.3)) % 1200) + 100;
        const x = 100 + (i % 3) * 600;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              top: y,
              left: x,
              fontFamily: FONTS.brutalist,
              fontSize: 18,
              color: COLORS.accent2,
              whiteSpace: "nowrap",
              opacity: 0.4 + noise2D(`code-${i}`, 0, (frame / fps) * 0.1) * 0.3,
            }}
          >
            {line}
          </div>
        );
      })}
    </div>
  );
};

export const S04_AgentNegotiation: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleProgress = smoothSpring(frame, fps, 0);
  const titleY = interpolate(titleProgress, [0, 1], [15, 0]);

  // End dim
  const endDim = interpolate(frame, [830, 868], [1, 0.2], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const beat = beatPulse(frame, fps, 170, 0.02);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg.deep,
        padding: "42px 52px 36px",
        display: "flex",
        flexDirection: "column",
        gap: 28,
      }}
    >
      {/* Code texture */}
      <CodeTexture />

      {/* Beat-synced ambient glow */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse at 50% 30%, rgba(148,184,255,${0.03 + beat}) 0%, transparent 55%)`,
          pointerEvents: "none",
        }}
      />

      {/* Title — Expressive thin voice (whisper before the machine speaks) */}
      <div
        style={{
          opacity: titleProgress * endDim,
          transform: `translateY(${titleY}px)`,
          fontFamily: FONTS.expressive,
          fontSize: 52,
          fontWeight: 100,
          color: COLORS.fg,
          textAlign: "center",
          letterSpacing: "0.01em",
          lineHeight: 1.1,
          zIndex: 1,
        }}
      >
        How It Works
      </div>

      {/* Phase nodes — fast stagger, vertically centered */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: 1,
          zIndex: 1,
          gap: 0,
          opacity: endDim,
        }}
      >
        {SIX_PHASES.map((phase, i) => (
          <React.Fragment key={phase.name}>
            <PhaseCard phase={phase} index={i} />
            {i < SIX_PHASES.length - 1 && (
              <Connector fromIndex={i} color={phase.color} />
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Key insights — whip up */}
      <div style={{ zIndex: 1, opacity: endDim }}>
        <KeyInsights />
      </div>
    </AbsoluteFill>
  );
};

export default S04_AgentNegotiation;
