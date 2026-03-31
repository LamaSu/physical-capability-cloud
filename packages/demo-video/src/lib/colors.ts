/**
 * PCC Video Design System — Signal Mood, Kinetic Mode
 * Source: ai/research/video-war-room/cross-synthesis.md
 *
 * HARD RULES:
 * - Discord (#ff0066) appears exactly 3 times in the entire video
 * - Muted text must be #8fa3b8 (not #6b7d8e — projector contrast fix)
 * - bg is #050a0e (not pure black — blue undertone for depth)
 */
export const C = {
  bg:      "#050a0e",
  surface: "#0d1520",
  border:  "#1e2d40",
  fg:      "#f0f4f0",
  muted:   "#8fa3b8",    // lifted from #6b7d8e for projector contrast
  accent1: "#00ff88",    // emerald — primary signal
  accent2: "#00d4ff",    // cyan — secondary
  gold:    "#ffaa00",    // escrow/payment
  discord: "#ff0066",    // exactly 3 uses
  glow1:   "rgba(0,255,136,0.15)",
  glow2:   "rgba(0,212,255,0.12)",
} as const;
