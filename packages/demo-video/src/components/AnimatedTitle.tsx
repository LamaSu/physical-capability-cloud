/**
 * AnimatedTitle — Monument voice display text with spring entrance.
 * CC: Uses monument font by default. Gradient uses holographic (discord-inclusive).
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { FONTS, COLORS, GRADIENTS, fadeSlideUp } from "../lib";

export const AnimatedTitle: React.FC<{
  text: string;
  delay?: number;
  fontSize?: number;
  color?: string;
  gradient?: boolean;
  align?: "center" | "left";
  voice?: "monument" | "editorial" | "swiss" | "brutalist" | "expressive";
  italic?: boolean;
  weight?: number;
}> = ({
  text,
  delay = 0,
  fontSize = 94,
  color = COLORS.fg,
  gradient = false,
  align = "center",
  voice = "monument",
  italic = false,
  weight,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { opacity, translateY } = fadeSlideUp(frame, fps, delay);

  const defaultWeight = voice === "monument" || voice === "brutalist" ? 700
    : voice === "expressive" ? 100 : 400;

  return (
    <div
      style={{
        fontFamily: FONTS[voice],
        fontSize,
        fontWeight: weight ?? defaultWeight,
        fontStyle: italic ? "italic" : "normal",
        letterSpacing: voice === "monument" ? "-0.03em"
          : voice === "brutalist" ? "0.05em"
          : voice === "swiss" ? "-0.01em" : "0.01em",
        lineHeight: fontSize > 72 ? 0.85 : 1.1,
        textTransform: voice === "monument" || voice === "brutalist" ? "uppercase" as const : "none" as const,
        color,
        opacity,
        transform: `translateY(${translateY}px)`,
        textAlign: align,
        ...(gradient
          ? {
              background: GRADIENTS.holographic,
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }
          : {}),
      }}
    >
      {text}
    </div>
  );
};
