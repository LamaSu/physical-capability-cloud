/**
 * TerminalLog — Agent negotiation feed.
 * CC: Brutalist voice (Space Mono), signal mood surface colors.
 */
import React from "react";
import { useCurrentFrame, interpolate, Easing } from "remotion";
import { FONTS, COLORS } from "../lib";

type LogEntry = {
  readonly tag: string;
  readonly tagColor: string;
  readonly text: string;
};

export const TerminalLog: React.FC<{
  entries: readonly LogEntry[];
  delay?: number;
  framesPerEntry?: number;
  fontSize?: number;
}> = ({ entries, delay = 0, framesPerEntry = 10, fontSize = 18 }) => {
  const frame = useCurrentFrame();
  const adjustedFrame = Math.max(0, frame - delay);

  return (
    <div
      style={{
        fontFamily: FONTS.brutalist,
        fontSize,
        padding: 28,
        background: COLORS.bg.subtle,
        borderRadius: 12,
        border: `1px solid ${COLORS.bg.border}`,
        lineHeight: 2,
        width: "100%",
      }}
    >
      {entries.map((entry, i) => {
        const entryFrame = adjustedFrame - i * framesPerEntry;
        if (entryFrame < 0) return null;

        const opacity = interpolate(entryFrame, [0, 6], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const x = interpolate(entryFrame, [0, 6], [-20, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic),
        });

        return (
          <div key={i} style={{ opacity, transform: `translateX(${x}px)` }}>
            <span style={{ color: entry.tagColor, fontWeight: 700 }}>
              [{entry.tag}]
            </span>
            <span style={{ color: COLORS.fg }}> {entry.text}</span>
          </div>
        );
      })}
    </div>
  );
};
