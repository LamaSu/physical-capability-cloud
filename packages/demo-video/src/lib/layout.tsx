/**
 * Layout System — prevents overlap, overflow, and collision.
 *
 * RULES ENFORCED:
 * - SafeFrame: 128px horizontal, 96px vertical margin. Nothing escapes.
 * - VStack/HStack: flexbox only, no absolute positioning. Gap-based spacing.
 * - TextBlock: max-width enforced, overflow hidden, font size validated.
 * - NO absolute positioning in scene code. Ever.
 */
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { C } from "./colors";
import { smooth, slam, fadeUp } from "./anim";

// ─── SafeFrame ──────────────────────────────────────────────────────────────
// Wraps entire scene. Enforces safe margins. Centers content via flexbox.
export const SafeFrame: React.FC<{
  children: React.ReactNode;
  bg?: string;
  justify?: "flex-start" | "center" | "flex-end" | "space-between";
  align?: "flex-start" | "center" | "flex-end" | "stretch";
  gap?: number;
  opacity?: number;
}> = ({
  children,
  bg = C.bg,
  justify = "flex-start",
  align = "stretch",
  gap = 32,
  opacity = 1,
}) => (
  <AbsoluteFill style={{ backgroundColor: bg, opacity }}>
    <div
      style={{
        position: "absolute",
        top: 96,
        bottom: 96,
        left: 128,
        right: 128,
        display: "flex",
        flexDirection: "column",
        justifyContent: justify,
        alignItems: align,
        gap,
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  </AbsoluteFill>
);

// ─── VStack ─────────────────────────────────────────────────────────────────
// Vertical flex column. No absolute positioning.
export const VStack: React.FC<{
  children: React.ReactNode;
  gap?: number;
  align?: "flex-start" | "center" | "flex-end" | "stretch";
  justify?: "flex-start" | "center" | "flex-end" | "space-between";
  style?: React.CSSProperties;
}> = ({ children, gap = 16, align = "flex-start", justify = "flex-start", style }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      gap,
      alignItems: align,
      justifyContent: justify,
      width: "100%",
      overflow: "hidden",
      flexShrink: 0,
      ...style,
    }}
  >
    {children}
  </div>
);

// ─── HStack ─────────────────────────────────────────────────────────────────
// Horizontal flex row. No absolute positioning.
export const HStack: React.FC<{
  children: React.ReactNode;
  gap?: number;
  align?: "flex-start" | "center" | "flex-end" | "stretch";
  justify?: "flex-start" | "center" | "flex-end" | "space-between" | "space-around";
  style?: React.CSSProperties;
}> = ({ children, gap = 24, align = "flex-start", justify = "flex-start", style }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "row",
      gap,
      alignItems: align,
      justifyContent: justify,
      width: "100%",
      overflow: "hidden",
      flexShrink: 0,
      ...style,
    }}
  >
    {children}
  </div>
);

// ─── Panel ──────────────────────────────────────────────────────────────────
// Contained box with surface bg, border, padding. Content can't escape.
export const Panel: React.FC<{
  children: React.ReactNode;
  width?: string | number;
  flex?: number;
  padding?: number;
  bg?: string;
  border?: string;
  glow?: string;
  radius?: number;
  style?: React.CSSProperties;
}> = ({
  children,
  width,
  flex,
  padding = 32,
  bg = C.surface,
  border = `1px solid ${C.border}`,
  glow,
  radius = 8,
  style,
}) => (
  <div
    style={{
      width,
      flex,
      padding,
      backgroundColor: bg,
      border,
      borderRadius: radius,
      boxShadow: glow ? `0 0 30px ${glow}` : undefined,
      overflow: "hidden",
      flexShrink: 0,
      ...style,
    }}
  >
    {children}
  </div>
);

// ─── T (Text) ───────────────────────────────────────────────────────────────
// Text block with overflow protection. Font size MUST be >= 36.
export const T: React.FC<{
  children: React.ReactNode;
  font: string;
  size: number;
  color?: string;
  weight?: number;
  tracking?: string;
  uppercase?: boolean;
  italic?: boolean;
  maxLines?: number;
  align?: "left" | "center" | "right";
  style?: React.CSSProperties;
}> = ({
  children,
  font,
  size,
  color = C.fg,
  weight = 400,
  tracking = "0",
  uppercase = false,
  italic = false,
  maxLines,
  align = "left",
  style,
}) => (
  <div
    style={{
      fontFamily: font,
      fontSize: Math.max(size, 36), // ENFORCE MINIMUM
      fontWeight: weight,
      color,
      letterSpacing: tracking,
      textTransform: uppercase ? "uppercase" : "none",
      fontStyle: italic ? "italic" : "normal",
      lineHeight: 1.3,
      textAlign: align,
      overflow: "hidden",
      textOverflow: "ellipsis",
      width: "100%",
      flexShrink: 0,
      ...(maxLines
        ? {
            display: "-webkit-box",
            WebkitLineClamp: maxLines,
            WebkitBoxOrient: "vertical" as const,
          }
        : {}),
      ...style,
    }}
  >
    {children}
  </div>
);

// ─── Reveal ─────────────────────────────────────────────────────────────────
// Animated entrance wrapper. Shows children at `at` frame with chosen animation.
export const Reveal: React.FC<{
  children: React.ReactNode;
  at: number;
  type?: "fadeUp" | "slam" | "fade";
}> = ({ children, at, type = "fadeUp" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (frame < at) return null;

  let opacity = 1;
  let transform = "none";

  if (type === "fadeUp") {
    const fu = fadeUp(frame, fps, at);
    opacity = fu.opacity;
    transform = `translateY(${fu.y}px)`;
  } else if (type === "slam") {
    const s = slam(frame, fps, at);
    opacity = Math.min(s * 6, 1);
    const x = (1 - s) * -50;
    transform = `translateX(${x}px)`;
  } else {
    opacity = smooth(frame, fps, at);
  }

  return (
    <div style={{ opacity, transform, flexShrink: 0, width: "100%", overflow: "hidden" }}>
      {children}
    </div>
  );
};

// ─── Spacer ─────────────────────────────────────────────────────────────────
// Flexible space that pushes elements apart.
export const Spacer: React.FC<{ flex?: number; height?: number }> = ({
  flex = 1,
  height,
}) => <div style={{ flex: height ? undefined : flex, height, flexShrink: height ? 0 : 1 }} />;

// ─── FadeOut ────────────────────────────────────────────────────────────────
// Wraps SafeFrame content and dims it at the end of a scene.
export const FadeOut: React.FC<{
  children: React.ReactNode;
  startFrame: number;
  endFrame: number;
}> = ({ children, startFrame, endFrame }) => {
  const frame = useCurrentFrame();
  const { Easing } = require("remotion");
  const opacity =
    frame < startFrame
      ? 1
      : frame > endFrame
        ? 0
        : 1 - (frame - startFrame) / (endFrame - startFrame);
  return <div style={{ opacity, width: "100%", height: "100%", display: "contents" }}>{children}</div>;
};
