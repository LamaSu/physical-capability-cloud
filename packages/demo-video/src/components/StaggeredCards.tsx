/**
 * StaggeredCards — Metric card grid with staggered reveal.
 * CC: Brutalist voice for numbers (tabular-nums), Swiss voice for labels (tracked uppercase).
 */
import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { FONTS, COLORS, smoothSpring, staggerDelay, countTo } from "../lib";

type StatCard = {
  readonly value: number;
  readonly label: string;
  readonly suffix?: string;
  readonly color?: string;
};

export const StaggeredCards: React.FC<{
  cards: readonly StatCard[];
  columns?: number;
  delay?: number;
  staggerFrames?: number;
}> = ({ cards, columns = 3, delay = 0, staggerFrames = 6 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gap: 20,
        width: "100%",
        maxWidth: 1100,
      }}
    >
      {cards.map((card, i) => {
        const cardDelay = delay + staggerDelay(i, staggerFrames);
        const progress = smoothSpring(frame, fps, cardDelay);
        const scale = interpolate(progress, [0, 1], [0.9, 1]);
        const value = countTo(frame, card.value, 50, cardDelay);

        return (
          <div
            key={i}
            style={{
              padding: "20px 16px",
              background: COLORS.bg.surface,
              border: `1px solid ${COLORS.bg.border}`,
              borderRadius: 12,
              textAlign: "center",
              transform: `scale(${scale})`,
              opacity: progress,
            }}
          >
            <div
              style={{
                fontFamily: FONTS.brutalist,
                fontSize: 94,
                fontWeight: 700,
                color: card.color || COLORS.accent1,
                fontVariantNumeric: "tabular-nums",
                marginBottom: 6,
              }}
            >
              {value.toLocaleString()}
              {card.suffix || ""}
            </div>
            <div
              style={{
                fontFamily: FONTS.swiss,
                fontSize: 60,
                fontWeight: 600,
                color: COLORS.muted,
                textTransform: "uppercase",
                letterSpacing: "0.15em",
              }}
            >
              {card.label}
            </div>
          </div>
        );
      })}
    </div>
  );
};
