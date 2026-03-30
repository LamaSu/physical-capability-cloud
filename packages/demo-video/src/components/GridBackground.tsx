/**
 * GridBackground — Dot grid overlay.
 * CC: Uses signal mood subtle color for dots.
 */
import React from "react";
import { useVideoConfig } from "remotion";
import { COLORS } from "../lib";

export const GridBackground: React.FC<{ opacity?: number }> = ({
  opacity = 0.3,
}) => {
  const { width, height } = useVideoConfig();

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width,
        height,
        opacity,
        backgroundImage: `radial-gradient(rgba(148,184,255,0.05) 1px, transparent 1px)`,
        backgroundSize: "24px 24px",
      }}
    />
  );
};
