/**
 * S03_Fracture — "The Rapid-Fire Contrast"
 *
 * 510 frames (17 seconds). NOT a side-by-side comparison.
 * Full-screen ALTERNATING CUTS: OLD (discord) smash → NEW (accent1) smash.
 *
 * Structure:
 *   5 pairs × ~80 frames each = 400 frames
 *   + Fee comparison slam = 110 frames
 *
 * Each pair:
 *   Frame 0-3:   Discord flash (transition beat)
 *   Frame 3-40:  OLD text fills screen — discord color, brutalist, massive
 *   Frame 40-43: Accent flash
 *   Frame 43-80: NEW text fills screen — accent1, monument, massive
 *
 * Final: "20-40%" SLASHES → "1.5%" EXPLODES in.
 *
 * Axiom I: Each word is the ONLY thing on screen. Maximum hierarchy.
 * Axiom II: OLD IS discord. The wrong color. The system that must break.
 * Axiom III: The RHYTHM of cuts is the design. Fast→faster→fastest→HOLD.
 *
 * Voices: Brutalist (old), Monument (new), Swiss (sub-labels)
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
  slamSpring,
  slamScale,
  flashBurst,
  bouncySpring,
  smoothSpring,
  beatPulse,
} from "../lib";

const PAIR_DURATION = 80; // frames per old/new pair
const OLD_HOLD = 37; // frames old text holds
const NEW_START = 40; // frame within pair where new starts
const FEE_START = PAIR_DURATION * FRACTURE_PAIRS.length; // frame 400

export const S03_Pipeline: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Which pair are we in?
  const pairIndex = Math.floor(frame / PAIR_DURATION);
  const pairFrame = frame % PAIR_DURATION;
  const inPairs = pairIndex < FRACTURE_PAIRS.length;

  // Fee comparison section (after all pairs)
  const inFee = frame >= FEE_START;
  const feeFrame = frame - FEE_START;

  // Beat pulse for background energy
  const beat = beatPulse(frame, fps, 170, 0.04);

  if (inPairs) {
    const pair = FRACTURE_PAIRS[pairIndex];
    const isOld = pairFrame < OLD_HOLD;
    const isTransition = pairFrame >= OLD_HOLD && pairFrame < NEW_START;
    const isNew = pairFrame >= NEW_START;

    // OLD phase
    if (isOld || isTransition) {
      const oldScale = slamScale(frame, fps, pairIndex * PAIR_DURATION, 2.5);
      const oldOpacity = interpolate(pairFrame, [0, 3], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      // Flash at start of OLD
      const oldFlash = flashBurst(pairFrame, 0, 2);
      // Fade out at end
      const oldDim = isTransition
        ? interpolate(pairFrame, [OLD_HOLD, NEW_START], [1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
        : 1;

      return (
        <AbsoluteFill style={{ backgroundColor: COLORS.bg.deep }}>
          {/* Coral atmosphere — "old world" tension */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: `radial-gradient(ellipse at center, rgba(248,113,113,${0.06 + beat}) 0%, transparent 60%)`,
              pointerEvents: "none",
            }}
          />

          <AbsoluteFill
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              opacity: oldOpacity * oldDim,
            }}
          >
            {/* OLD text — Brutalist, massive, coral */}
            <div
              style={{
                fontFamily: FONTS.brutalist,
                fontSize: 76,
                fontWeight: 700,
                color: COLORS.discord,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                lineHeight: 1.1,
                textAlign: "center",
                maxWidth: 1400,
                transform: `scale(${oldScale})`,
                textShadow: `0 0 40px rgba(248,113,113,0.5)`,
              }}
            >
              {pair.old}
            </div>
            {/* Sub-label — Swiss, muted */}
            <div
              style={{
                fontFamily: FONTS.swiss,
                fontSize: 28,
                color: COLORS.muted,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                opacity: interpolate(pairFrame, [8, 16], [0, 0.7], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }),
              }}
            >
              {pair.oldSub}
            </div>
          </AbsoluteFill>

          {/* Coral flash — old world */}
          {oldFlash > 0 && (
            <AbsoluteFill
              style={{
                backgroundColor: `rgba(248,113,113,${oldFlash * 0.2})`,
                pointerEvents: "none",
              }}
            />
          )}
        </AbsoluteFill>
      );
    }

    // NEW phase
    if (isNew) {
      const newLocalFrame = pairFrame - NEW_START;
      const newScale = slamScale(frame, fps, pairIndex * PAIR_DURATION + NEW_START, 2.5);
      const newOpacity = interpolate(newLocalFrame, [0, 3], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      // Green flash at start of NEW
      const newFlash = flashBurst(newLocalFrame, 0, 2);

      return (
        <AbsoluteFill style={{ backgroundColor: COLORS.bg.deep }}>
          {/* Amber atmosphere — "new world" momentum */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: `radial-gradient(ellipse at center, rgba(245,166,35,${0.06 + beat}) 0%, transparent 60%)`,
              pointerEvents: "none",
            }}
          />

          <AbsoluteFill
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              opacity: newOpacity,
            }}
          >
            {/* NEW text — Monument, massive, amber gold */}
            <div
              style={{
                fontFamily: FONTS.monument,
                fontSize: 88,
                fontWeight: 700,
                color: COLORS.accent1,
                textTransform: "uppercase",
                letterSpacing: "-0.02em",
                lineHeight: 1.1,
                textAlign: "center",
                maxWidth: 1400,
                transform: `scale(${newScale})`,
                textShadow: `0 0 50px rgba(245,166,35,0.6), 0 0 100px rgba(245,166,35,0.2)`,
              }}
            >
              {pair.new}
            </div>
            {/* Sub-label */}
            <div
              style={{
                fontFamily: FONTS.swiss,
                fontSize: 28,
                color: COLORS.fg,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                opacity: interpolate(newLocalFrame, [6, 14], [0, 0.8], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }),
              }}
            >
              {pair.newSub}
            </div>
          </AbsoluteFill>

          {/* Amber flash */}
          {newFlash > 0 && (
            <AbsoluteFill
              style={{
                backgroundColor: `rgba(245,166,35,${newFlash * 0.15})`,
                pointerEvents: "none",
              }}
            />
          )}
        </AbsoluteFill>
      );
    }
  }

  // ── FEE COMPARISON SLAM ──
  if (inFee) {
    // Old fee SLAMS in at feeFrame 0
    const oldFeeProgress = slamSpring(feeFrame, fps, 0);
    const oldFeeScale = slamScale(feeFrame, fps, 0, 2);

    // Strikethrough draws at feeFrame 20
    const strikeWidth = interpolate(feeFrame, [20, 30], [0, 100], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    });

    // Arrow appears
    const arrowOpacity = interpolate(feeFrame, [30, 36], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

    // New fee EXPLODES — bouncy spring at feeFrame 35
    const newFeeProgress = bouncySpring(feeFrame, fps, 35);
    const newFeeScale = interpolate(newFeeProgress, [0, 1], [0.3, 1]);

    // "protocol fee" label
    const labelFade = smoothSpring(feeFrame, fps, 55);

    // Discord flash at feeFrame 0
    const feeFlash = flashBurst(feeFrame, 0, 2);

    return (
      <AbsoluteFill style={{ backgroundColor: COLORS.bg.deep }}>
        {/* Dual atmosphere — coral left (old), amber right (new) */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `
              radial-gradient(ellipse at 30% 50%, rgba(248,113,113,0.05) 0%, transparent 40%),
              radial-gradient(ellipse at 70% 50%, rgba(245,166,35,0.06) 0%, transparent 40%)
            `,
            pointerEvents: "none",
          }}
        />

        <AbsoluteFill
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 60,
          }}
        >
          {/* Old fee — Brutalist, discord, with strikethrough */}
          <div
            style={{
              position: "relative",
              opacity: oldFeeProgress,
              transform: `scale(${oldFeeScale})`,
            }}
          >
            <span
              style={{
                fontFamily: FONTS.brutalist,
                fontSize: 88,
                fontWeight: 700,
                color: COLORS.discord,
                letterSpacing: "-0.02em",
              }}
            >
              20-40%
            </span>
            {/* Animated strikethrough */}
            <div
              style={{
                position: "absolute",
                top: "52%",
                left: 0,
                height: 4,
                width: `${strikeWidth}%`,
                background: COLORS.discord,
                borderRadius: 2,
                boxShadow: `0 0 12px rgba(248,113,113,0.7)`,
              }}
            />
          </div>

          {/* Arrow */}
          <span
            style={{
              fontFamily: FONTS.monument,
              fontSize: 48,
              color: COLORS.muted,
              opacity: arrowOpacity,
            }}
          >
            →
          </span>

          {/* New fee — Monument, accent1, BOUNCY */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
            }}
          >
            <div
              style={{
                opacity: newFeeProgress > 0.01 ? 1 : 0,
                transform: `scale(${newFeeScale})`,
              }}
            >
              <span
                style={{
                  fontFamily: FONTS.monument,
                  fontSize: 120,
                  fontWeight: 700,
                  color: COLORS.accent1,
                  letterSpacing: "-0.04em",
                  lineHeight: 1,
                  textShadow: `0 0 60px rgba(245,166,35,0.6), 0 0 120px rgba(245,166,35,0.2)`,
                }}
              >
                1.5%
              </span>
            </div>
            <div
              style={{
                fontFamily: FONTS.swiss,
                fontSize: 22,
                fontWeight: 600,
                color: COLORS.muted,
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                opacity: labelFade,
              }}
            >
              PROTOCOL FEE
            </div>
          </div>
        </AbsoluteFill>

        {/* Coral flash at fee start */}
        {feeFlash > 0 && (
          <AbsoluteFill
            style={{
              backgroundColor: `rgba(248,113,113,${feeFlash * 0.15})`,
              pointerEvents: "none",
            }}
          />
        )}
      </AbsoluteFill>
    );
  }

  // Fallback (shouldn't reach)
  return <AbsoluteFill style={{ backgroundColor: "#000000" }} />;
};

export default S03_Pipeline;
