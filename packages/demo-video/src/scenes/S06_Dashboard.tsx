/**
 * S06_Dashboard — "GLOBAL ACCESS"
 *
 * 540 frames (18 seconds). Judge target: Sabeen Ali (social impact),
 * Mashal Waqar (public goods), Lain Calvo (emerging markets),
 * David Casey (coordination).
 *
 * The EMERGING MARKETS scene. PCC is accessible to anyone, anywhere.
 *
 * Frame 0-5:   Black.
 * Frame 6:     "ANY OPERATOR. ANYWHERE." SLAMS in — Monument, 64px, accent1. slamScale 2x.
 * Frame 30:    "pip install pcc-node" — Brutalist, 28px, accent2. Spring entrance.
 * Frame 60:    "34 countries..." — Swiss, muted. Fade in.
 * Frame 90-380: Four feature cards, 2x2 grid, staggered 40 frames.
 * Frame 400:   Impact quote — Editorial italic, accent2.
 * Frame 480:   "No middlemen..." — Swiss, muted.
 * Frame 510:   Dim to black.
 *
 * Voices: Monument (headline), Brutalist (command, card-stat), Swiss (body, labels),
 *         Editorial (impact quote)
 */
import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  AbsoluteFill,
  interpolate,
  Easing,
} from "remotion";
import {
  COLORS,
  FONTS,
  slamSpring,
  slamScale,
  smoothSpring,
  fadeSlideUp,
} from "../lib";

type FeatureCardData = {
  stat: string;
  statColor: string;
  statSize: number;
  label: string;
  caption: string;
  captionItalic?: boolean;
};

const FEATURE_CARDS: FeatureCardData[] = [
  {
    stat: "30 MIN",
    statColor: COLORS.emerald,
    statSize: 68,
    label: "from zero to live operator",
    caption: "Hardware auto-detect → keys → register → go",
  },
  {
    stat: "34",
    statColor: COLORS.gold,
    statSize: 68,
    label: "emerging market countries",
    caption: "Yellowcard · Stripe · Wise",
  },
  {
    stat: "APACHE 2.0",
    statColor: COLORS.accent2,
    statSize: 54,
    label: "open spec, open protocol",
    caption: "Not a marketplace. A public good.",
    captionItalic: true,
  },
  {
    stat: "OT-2",
    statColor: COLORS.discord,
    statSize: 68,
    label: "liquid handling robot",
    caption: "First node. Live in San Francisco.",
  },
];

const FeatureCard: React.FC<{
  card: FeatureCardData;
  appearFrame: number;
}> = ({ card, appearFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = smoothSpring(frame, fps, appearFrame);
  const translateY = interpolate(progress, [0, 1], [24, 0]);

  return (
    <div
      style={{
        opacity: progress,
        transform: `translateY(${translateY}px)`,
        background: COLORS.bg.surface,
        border: `1px solid ${COLORS.bg.border}`,
        borderRadius: 12,
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        flex: 1,
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontFamily: FONTS.monument,
          fontSize: card.statSize,
          fontWeight: 700,
          color: card.statColor,
          lineHeight: 1,
          letterSpacing: card.statSize >= 68 ? "-0.02em" : "-0.01em",
        }}
      >
        {card.stat}
      </div>
      <div
        style={{
          fontFamily: FONTS.swiss,
          fontSize: 34,
          fontWeight: 600,
          color: COLORS.fg,
          textTransform: "uppercase" as const,
          letterSpacing: "0.08em",
        }}
      >
        {card.label}
      </div>
      <div
        style={{
          fontFamily: card.captionItalic ? FONTS.editorial : FONTS.brutalist,
          fontSize: 60,
          fontWeight: 400,
          color: COLORS.muted,
          fontStyle: card.captionItalic ? ("italic" as const) : ("normal" as const),
          letterSpacing: card.captionItalic ? "0" : "0.04em",
          marginTop: 2,
        }}
      >
        {card.caption}
      </div>
    </div>
  );
};

export const S06_Dashboard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Pure black for first 5 frames
  if (frame < 5) {
    return <AbsoluteFill style={{ backgroundColor: "#000000" }} />;
  }

  // Headline SLAM — Monument, 64px, accent1
  const headlineProgress = slamSpring(frame, fps, 6);
  const headlineScale = slamScale(frame, fps, 6, 2);
  const headlineOpacity = Math.min(headlineProgress * 5, 1);

  // pip install line — spring entrance at frame 30
  const cmdProgress = smoothSpring(frame, fps, 30);
  const cmdTranslateY = interpolate(cmdProgress, [0, 1], [20, 0]);

  // Subtext fade at frame 60
  const subtextOpacity = interpolate(frame, [60, 80], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // Grid appears frame 90-380 (4 cards × 40 frames)
  const CARD_STAGGER = 40;
  const cardAppearFrames = FEATURE_CARDS.map((_, i) => 90 + i * CARD_STAGGER);

  // Impact quote — fade in at frame 400
  const quoteFade = fadeSlideUp(frame, fps, 400);

  // No-middlemen line at frame 480
  const noMiddlemenOpacity = interpolate(frame, [480, 500], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // Dim to black
  const endDim = interpolate(frame, [510, 540], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg.deep,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        paddingTop: 44,
        paddingBottom: 32,
        paddingLeft: 72,
        paddingRight: 72,
        overflow: "hidden",
        opacity: endDim,
      }}
    >
      {/* Subtle gold ambient */}
      <div
        style={{
          position: "absolute",
          top: "20%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 700,
          height: 400,
          background:
            "radial-gradient(ellipse, rgba(245,166,35,0.04) 0%, transparent 65%)",
          pointerEvents: "none",
        }}
      />

      {/* Headline */}
      <div
        style={{
          opacity: headlineOpacity,
          transform: `scale(${headlineScale})`,
          textAlign: "center",
          marginBottom: 20,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: FONTS.monument,
            fontSize: 106,
            fontWeight: 700,
            color: COLORS.accent1,
            letterSpacing: "-0.02em",
            textTransform: "uppercase" as const,
            textShadow: "0 0 40px rgba(245,166,35,0.4)",
          }}
        >
          Any Operator. Anywhere.
        </span>
      </div>

      {/* pip install pcc-node */}
      <div
        style={{
          opacity: cmdProgress,
          transform: `translateY(${cmdTranslateY}px)`,
          marginBottom: 10,
          textAlign: "center",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: FONTS.brutalist,
            fontSize: 66,
            fontWeight: 700,
            color: COLORS.accent2,
            letterSpacing: "0.02em",
          }}
        >
          pip install pcc-node
        </span>
      </div>

      {/* Subtext */}
      <div
        style={{
          opacity: subtextOpacity,
          marginBottom: 28,
          textAlign: "center",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: FONTS.swiss,
            fontSize: 66,
            fontWeight: 400,
            color: COLORS.muted,
            letterSpacing: "0.01em",
          }}
        >
          34 countries. Fiat ramps. No corporate account.
        </span>
      </div>

      {/* 2×2 feature card grid */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          width: "100%",
          maxWidth: 880,
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* Row 1 */}
        <div style={{ display: "flex", gap: 12, flex: 1 }}>
          <FeatureCard card={FEATURE_CARDS[0]} appearFrame={cardAppearFrames[0]} />
          <FeatureCard card={FEATURE_CARDS[1]} appearFrame={cardAppearFrames[1]} />
        </div>
        {/* Row 2 */}
        <div style={{ display: "flex", gap: 12, flex: 1 }}>
          <FeatureCard card={FEATURE_CARDS[2]} appearFrame={cardAppearFrames[2]} />
          <FeatureCard card={FEATURE_CARDS[3]} appearFrame={cardAppearFrames[3]} />
        </div>
      </div>

      {/* Impact quote */}
      <div
        style={{
          marginTop: 20,
          opacity: quoteFade.opacity,
          transform: `translateY(${quoteFade.translateY}px)`,
          textAlign: "center",
          maxWidth: 780,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: FONTS.editorial,
            fontSize: 66,
            fontWeight: 400,
            fontStyle: "italic",
            color: COLORS.accent2,
            lineHeight: 1.5,
          }}
        >
          Any lab, any shop, any operator — connected to every buyer on Earth.
        </span>
      </div>

      {/* No middlemen */}
      <div
        style={{
          marginTop: 10,
          opacity: noMiddlemenOpacity,
          textAlign: "center",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: FONTS.swiss,
            fontSize: 66,
            fontWeight: 400,
            color: COLORS.muted,
            letterSpacing: "0.06em",
          }}
        >
          No middlemen. No minimum deal size.
        </span>
      </div>
    </AbsoluteFill>
  );
};

export default S06_Dashboard;
