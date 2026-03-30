/**
 * S02_Problem — "THE THESIS"
 *
 * 390 frames (13 seconds). The elevator pitch. Every judge must leave with one line.
 *
 * Frame 0-4:    Pure black.
 * Frame 5:      "AWS FOR THE PHYSICAL WORLD" SLAMS in — Monument, 72px, accent1 gold.
 *               slamScale from 2.5x. This is the ONE sentence.
 * Frame 45:     Editorial italic subtitle fades in below.
 *               Swiss label — package/test/url stats — small, tracked, muted.
 * Frame 90-340: FRACTURE sequence. 5 pairs × ~50 frames.
 *               OLD fills left half (discord, Monument 64px).
 *               NEW fills right half (accent1, Monument 64px).
 *               Both visible 15 frames → 2-frame flash → hard cut to next pair.
 * Frame 350:    Quick flash, dim to black.
 *
 * Voices: Monument (headlines), Editorial (subtitle), Swiss (label/sub-labels)
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
  FRACTURE_PAIRS,
  slamScale,
  slamSpring,
  smoothSpring,
  flashBurst,
  beatPulse,
} from "../lib";

// ─── Fracture constants ───────────────────────────────────────────────────────
const FRACTURE_START = 90;
const PAIR_DURATION = 50;
// Within each pair:
//   0-7   : OLD side slams in (left half)
//   8-15  : NEW side slams in (right half)
//   15-39 : Both held — tension
//   38-40 : 2-frame flash
//   40-50 : hard cut to black before next pair

export const S02_Problem: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── Phase detection ──────────────────────────────────────────────────────
  const inIntro = frame < FRACTURE_START;
  const fractureFrame = frame - FRACTURE_START;
  const pairIndex = Math.floor(fractureFrame / PAIR_DURATION);
  const pairFrame = fractureFrame % PAIR_DURATION;
  const inFracture =
    frame >= FRACTURE_START && pairIndex < FRACTURE_PAIRS.length;
  const inOutro = frame >= 350;

  // ── Beat / ambient ───────────────────────────────────────────────────────
  const beat = beatPulse(frame, fps, 170, 0.04);

  // ── End dim ──────────────────────────────────────────────────────────────
  const endDim = interpolate(frame, [350, 390], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });
  const endFlash = flashBurst(frame, 350, 2);

  // ── INTRO section ────────────────────────────────────────────────────────
  const headlineScale = slamScale(frame, fps, 5, 2.5);
  const headlineProgress = slamSpring(frame, fps, 5);
  const headlineOpacity = Math.min(headlineProgress * 6, 1);

  const subtitleProgress = smoothSpring(frame, fps, 45);
  const subtitleOpacity = interpolate(subtitleProgress, [0, 1], [0, 1]);
  const subtitleY = interpolate(subtitleProgress, [0, 1], [18, 0]);

  const labelProgress = smoothSpring(frame, fps, 52);
  const labelOpacity = interpolate(labelProgress, [0, 1], [0, 0.7]);
  const labelY = interpolate(labelProgress, [0, 1], [14, 0]);

  // Flash at headline slam
  const slamFlash = flashBurst(frame, 5, 2);

  if (frame < 5) {
    return <AbsoluteFill style={{ backgroundColor: "#000000" }} />;
  }

  if (inIntro) {
    return (
      <AbsoluteFill style={{ backgroundColor: COLORS.bg.deep }}>
        {/* Ambient glow */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(ellipse at 50% 48%, rgba(245,166,35,${0.06 + beat}) 0%, transparent 55%)`,
            pointerEvents: "none",
          }}
        />

        <AbsoluteFill
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 22,
            opacity: endDim,
          }}
        >
          {/* HEADLINE — Monument, 72px, gold, SLAM */}
          <div
            style={{
              fontFamily: FONTS.monument,
              fontSize: 140,
              fontWeight: 700,
              color: COLORS.accent1,
              textTransform: "uppercase",
              letterSpacing: "-0.02em",
              lineHeight: 1.0,
              textAlign: "center",
              opacity: headlineOpacity,
              transform: `scale(${headlineScale})`,
              textShadow: `
                0 0 60px rgba(245,166,35,0.7),
                0 0 120px rgba(245,166,35,0.3)
              `,
            }}
          >
            AWS FOR THE PHYSICAL WORLD
          </div>

          {/* Editorial subtitle */}
          <div
            style={{
              fontFamily: FONTS.editorial,
              fontSize: 60,
              fontWeight: 400,
              fontStyle: "italic",
              color: COLORS.fg,
              letterSpacing: "0.01em",
              textAlign: "center",
              opacity: subtitleOpacity,
              transform: `translateY(${subtitleY}px)`,
            }}
          >
            A decentralized cloud control plane for physical manufacturing
          </div>

          {/* Swiss stats label */}
          <div
            style={{
              fontFamily: FONTS.swiss,
              fontSize: 66,
              fontWeight: 400,
              color: COLORS.muted,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              textAlign: "center",
              opacity: labelOpacity,
              transform: `translateY(${labelY}px)`,
            }}
          >
            25 packages&nbsp;&nbsp;·&nbsp;&nbsp;3,300+ tests&nbsp;&nbsp;·&nbsp;&nbsp;live at capability.network
          </div>
        </AbsoluteFill>

        {/* Slam flash */}
        {slamFlash > 0 && (
          <AbsoluteFill
            style={{
              backgroundColor: `rgba(245,166,35,${slamFlash * 0.18})`,
              pointerEvents: "none",
            }}
          />
        )}
      </AbsoluteFill>
    );
  }

  // ── FRACTURE PAIRS ────────────────────────────────────────────────────────
  if (inFracture) {
    const pair = FRACTURE_PAIRS[pairIndex];

    // Hard-cut black between pairs: frames 46-49 of each pair are black
    if (pairFrame >= 46) {
      return <AbsoluteFill style={{ backgroundColor: "#000000" }} />;
    }

    // Flash at pair boundary (frames 38-40)
    const pairFlash = flashBurst(pairFrame, 38, 2);

    // OLD side: appears at pairFrame 0, slams from 2.5x
    const oldProgress = slamSpring(pairFrame, fps, 0);
    const oldScale = interpolate(oldProgress, [0, 1], [2.5, 1]);
    const oldOpacity = Math.min(oldProgress * 5, 1);

    // NEW side: appears at pairFrame 8, slams from 2.5x
    const newProgress = slamSpring(pairFrame, fps, 8);
    const newScale = interpolate(newProgress, [0, 1], [2.5, 1]);
    const newOpacity = Math.min(newProgress * 5, 1);

    // Sub-labels fade after their side slams
    const oldSubOpacity = interpolate(pairFrame, [6, 14], [0, 0.65], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    const newSubOpacity = interpolate(pairFrame, [14, 22], [0, 0.75], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

    // Divider line draws on at pairFrame 6
    const dividerHeight = interpolate(pairFrame, [6, 14], [0, 340], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    });
    const dividerOpacity = interpolate(pairFrame, [6, 10], [0, 0.35], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

    return (
      <AbsoluteFill style={{ backgroundColor: COLORS.bg.deep, opacity: endDim }}>
        {/* OLD atmosphere — coral tint left */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(ellipse at 25% 50%, rgba(248,113,113,${0.08 + beat}) 0%, transparent 45%)`,
            pointerEvents: "none",
          }}
        />
        {/* NEW atmosphere — gold tint right */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(ellipse at 75% 50%, rgba(245,166,35,${0.07 + beat}) 0%, transparent 45%)`,
            pointerEvents: "none",
          }}
        />

        {/* Center divider */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translateX(-50%) translateY(-50%)",
            width: 1,
            height: dividerHeight,
            background: `linear-gradient(180deg, transparent, ${COLORS.muted}, transparent)`,
            opacity: dividerOpacity,
          }}
        />

        {/* OLD — left half */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: "50%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
            opacity: oldOpacity,
          }}
        >
          <div
            style={{
              fontFamily: FONTS.monument,
              fontSize: 106,
              fontWeight: 700,
              color: COLORS.discord,
              textTransform: "uppercase",
              letterSpacing: "-0.01em",
              lineHeight: 1.05,
              textAlign: "center",
              maxWidth: 600,
              padding: "0 40px",
              transform: `scale(${oldScale})`,
              textShadow: `0 0 40px rgba(248,113,113,0.45)`,
            }}
          >
            {pair.old}
          </div>
          <div
            style={{
              fontFamily: FONTS.swiss,
              fontSize: 66,
              color: COLORS.muted,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              textAlign: "center",
              maxWidth: 480,
              padding: "0 40px",
              opacity: oldSubOpacity,
            }}
          >
            {pair.oldSub}
          </div>
        </div>

        {/* NEW — right half */}
        <div
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            width: "50%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
            opacity: newOpacity,
          }}
        >
          <div
            style={{
              fontFamily: FONTS.monument,
              fontSize: 106,
              fontWeight: 700,
              color: COLORS.accent1,
              textTransform: "uppercase",
              letterSpacing: "-0.01em",
              lineHeight: 1.05,
              textAlign: "center",
              maxWidth: 600,
              padding: "0 40px",
              transform: `scale(${newScale})`,
              textShadow: `0 0 50px rgba(245,166,35,0.55), 0 0 100px rgba(245,166,35,0.2)`,
            }}
          >
            {pair.new}
          </div>
          <div
            style={{
              fontFamily: FONTS.swiss,
              fontSize: 66,
              color: COLORS.accent2,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              textAlign: "center",
              maxWidth: 480,
              padding: "0 40px",
              opacity: newSubOpacity,
            }}
          >
            {pair.newSub}
          </div>
        </div>

        {/* Pair transition flash */}
        {pairFlash > 0 && (
          <AbsoluteFill
            style={{
              backgroundColor: `rgba(245,166,35,${pairFlash * 0.22})`,
              pointerEvents: "none",
            }}
          />
        )}
      </AbsoluteFill>
    );
  }

  // ── OUTRO — dim to black ──────────────────────────────────────────────────
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg.deep }}>
      <AbsoluteFill
        style={{
          opacity: endDim,
          backgroundColor: COLORS.bg.deep,
        }}
      />
      {endFlash > 0 && (
        <AbsoluteFill
          style={{
            backgroundColor: `rgba(245,166,35,${endFlash * 0.18})`,
            pointerEvents: "none",
          }}
        />
      )}
    </AbsoluteFill>
  );
};

export default S02_Problem;
