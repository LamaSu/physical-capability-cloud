/**
 * TypewriterText — Character-by-character text reveal.
 * CC: Brutalist voice when mono=true, Swiss voice otherwise. Discord cursor.
 */
import React from "react";
import { useCurrentFrame } from "remotion";
import { FONTS, COLORS, typewriterChars } from "../lib";

export const TypewriterText: React.FC<{
  text: string;
  delay?: number;
  charsPerFrame?: number;
  fontSize?: number;
  showCursor?: boolean;
  cursorColor?: string;
  color?: string;
  mono?: boolean;
}> = ({
  text,
  delay = 0,
  charsPerFrame = 0.8,
  fontSize = 40,
  showCursor = true,
  cursorColor = COLORS.discord,
  color = COLORS.fg,
  mono = false,
}) => {
  const frame = useCurrentFrame();
  const visibleChars = typewriterChars(frame, delay, charsPerFrame, text.length);
  const displayText = text.slice(0, visibleChars);
  const cursorOpacity = Math.sin(frame * 0.2) > 0 ? 1 : 0;

  return (
    <div
      style={{
        fontFamily: mono ? FONTS.brutalist : FONTS.swiss,
        fontSize,
        color,
        lineHeight: 1.6,
        maxWidth: 1200,
        letterSpacing: mono ? "0.02em" : "0",
      }}
    >
      {displayText}
      {showCursor && visibleChars < text.length && (
        <span style={{ color: cursorColor, opacity: cursorOpacity }}>▌</span>
      )}
    </div>
  );
};
