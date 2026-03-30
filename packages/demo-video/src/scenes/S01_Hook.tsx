/**
 * S01_Void — "The Cold Open"
 *
 * 120 frames (4 seconds). The pause before the storm.
 *
 * Frame 0-30:  Pure black. Nothing. The audience waits.
 * Frame 30:    A cursor blinks into existence (discord pink).
 * Frame 38:    Code types at 2 chars/frame — fast, urgent.
 *              "await world.connect()"
 * Frame 95:    Code complete. Cursor holds.
 * Frame 108:   2-frame WHITE FLASH — the beat drops.
 * Frame 110:   Hard cut out (handled by TransitionSeries).
 *
 * Axiom I: Hierarchy — the code is the ONLY thing. No decoration.
 * Axiom II: Tension — 1 second of nothing IS the tension. Discord cursor.
 * Axiom III: Medium is time — emptiness before revelation creates anticipation.
 *
 * Voice: Brutalist only. Raw. Mechanical. Terminal green on black.
 */
import React from "react";
import { useCurrentFrame, useVideoConfig, AbsoluteFill, interpolate } from "remotion";
import { COLORS, FONTS, typewriterChars, flashBurst } from "../lib";

const CODE_LINE = "await world.connect()";

export const S01_Hook: React.FC = () => {
  const frame = useCurrentFrame();

  // Phase 1: Pure black (0-30)
  if (frame < 30) {
    return <AbsoluteFill style={{ backgroundColor: "#000000" }} />;
  }

  // Cursor blink (frame 30+)
  const cursorVisible = Math.sin((frame - 30) * 0.35) > 0;

  // Code types at 2 chars/frame starting at frame 38
  const chars = typewriterChars(frame, 38, 2, CODE_LINE.length);
  const displayCode = CODE_LINE.slice(0, chars);
  const codeComplete = chars >= CODE_LINE.length;

  // Flash at frame 108 — 2-frame white burst
  const flash = flashBurst(frame, 108, 3);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000000" }}>
      {/* Code line — centered, brutalist voice */}
      <AbsoluteFill
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            fontFamily: FONTS.brutalist,
            fontSize: 100,
            color: COLORS.accent1,
            letterSpacing: "0.04em",
            textShadow: `0 0 20px rgba(245,166,35,0.4)`,
          }}
        >
          {displayCode}
          {!codeComplete && cursorVisible && (
            <span style={{ color: COLORS.discord }}>▌</span>
          )}
          {codeComplete && (
            <span
              style={{
                color: COLORS.discord,
                opacity: cursorVisible ? 1 : 0,
              }}
            >
              ▌
            </span>
          )}
        </div>
      </AbsoluteFill>

      {/* WHITE FLASH — the beat drop */}
      {flash > 0 && (
        <AbsoluteFill
          style={{
            backgroundColor: `rgba(255,255,255,${flash * 0.85})`,
            pointerEvents: "none",
          }}
        />
      )}
    </AbsoluteFill>
  );
};

export default S01_Hook;
