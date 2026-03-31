/**
 * S04A_Onboarding — "OPERATOR ONBOARDING — pcc-node Terminal"
 *
 * 480 frames (16s). pip install → hardware auto-detect → key generation →
 * kernel registration → live on DHT. Left-aligned terminal panel in 65% of
 * frame. Right 35% is dark negative space with DHT viz + callout.
 *
 * Frame 0:    "OPERATOR ONBOARDING" title — SWISS 64px, slam
 * Frame 30:   "$ pip install pcc-node" — types in
 * Frame 80:   "Successfully installed pcc-node-1.4.2" (accent1)
 * Frame 120:  "$ pcc-node start --detect" — types in
 * Frame 170:  "Scanning hardware... OT-2 detected on USB0" (accent2)
 * Frame 210:  "Generating Ed25519 keypair..." (muted)
 * Frame 250:  'Public key: PCC1xKqR...7mWz (did:pcc:1xKqR)' (accent2)
 * Frame 290:  "Registering kernel with gateway..." (muted)
 * Frame 330:  '{"kernel_id": "krn_8f2a", "status": "active"}' (accent1)
 * Frame 370:  "Announcing to DHT gossip network..." (muted)
 * Frame 400:  "Kernel live. Discoverable by any agent." (accent1)
 * Frame 430:  Right callout: "47 seconds from install to live on network."
 *
 * Discord: none.
 * Max elements simultaneous: 3
 *
 * Transition in:  horizontal wipe from right (18 frames)
 * Transition out: hard cut (4-frame black) into S04B
 */

import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  AbsoluteFill,
  interpolate,
  Easing,
} from "remotion";
import { C, F, SIZE, smooth, slam } from "../lib";

interface TermLine {
  frameOffset: number;
  content: string;
  color: string;
  typewriterFrames: number;
}

const LINES: TermLine[] = [
  { frameOffset: 30,  content: "$ pip install pcc-node",                           color: C.fg,      typewriterFrames: 20 },
  { frameOffset: 80,  content: "Successfully installed pcc-node-1.4.2",             color: C.accent1, typewriterFrames: 12 },
  { frameOffset: 120, content: "$ pcc-node start --detect",                         color: C.fg,      typewriterFrames: 22 },
  { frameOffset: 170, content: "Scanning hardware... OT-2 detected on USB0",        color: C.accent2, typewriterFrames: 20 },
  { frameOffset: 210, content: "Generating Ed25519 keypair...",                      color: C.muted,   typewriterFrames: 15 },
  { frameOffset: 250, content: "Public key: PCC1xKqR...7mWz (did:pcc:1xKqR)",       color: C.accent2, typewriterFrames: 18 },
  { frameOffset: 290, content: "Registering kernel with gateway...",                 color: C.muted,   typewriterFrames: 14 },
  { frameOffset: 330, content: '{"kernel_id": "krn_8f2a", "status": "active"}',     color: C.accent1, typewriterFrames: 20 },
  { frameOffset: 370, content: "Announcing to DHT gossip network...",                color: C.muted,   typewriterFrames: 15 },
  { frameOffset: 400, content: "Kernel live. Discoverable by any agent.",            color: C.accent1, typewriterFrames: 18 },
];

const MAX_VISIBLE = 9;

function typeAt(frame: number, line: TermLine): string | null {
  if (frame < line.frameOffset) return null;
  const elapsed = frame - line.frameOffset;
  const charsPerFrame = line.content.length / line.typewriterFrames;
  const chars = Math.min(Math.floor(elapsed * charsPerFrame) + 1, line.content.length);
  return line.content.slice(0, chars);
}

// Static DHT node positions for SVG viz (right panel)
const DHT_NODES = [
  { x: 55,  y: 48 }, { x: 145, y: 72 }, { x: 225, y: 30 },
  { x: 305, y: 88 }, { x: 370, y: 45 }, { x: 80,  y: 140 },
  { x: 190, y: 155 }, { x: 280, y: 125 }, { x: 350, y: 170 },
  { x: 110, y: 210 }, { x: 240, y: 195 }, { x: 320, y: 238 },
  { x: 60,  y: 262 }, { x: 200, y: 275 }, { x: 395, y: 215 },
];
const NEW_NODE = { x: 290, y: 105 };

// Simple deterministic "edges" to show
const DHT_EDGES = [
  [0, 2], [1, 3], [2, 4], [3, 5], [5, 7],
  [6, 9], [7, 11], [8, 10], [9, 12], [10, 13],
];

export const S04A_Onboarding: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Title slam
  const titleSlam = slam(frame, fps, 0);
  const titleX = interpolate(titleSlam, [0, 1], [-60, 0]);
  const titleOpacity = Math.min(titleSlam * 6, 1);

  // Collect visible terminal lines
  const displayLines: Array<{ text: string; color: string }> = [];
  for (const line of LINES) {
    const text = typeAt(frame, line);
    if (text !== null) {
      displayLines.push({ text, color: line.color });
    }
  }
  const visibleLines = displayLines.slice(-MAX_VISIBLE);

  // DHT visualization appears at frame 390
  const dhtProgress = interpolate(frame, [390, 425], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const dhtVisible = frame >= 390;

  // Right-side callout — spring in at frame 430
  const calloutP = smooth(frame, fps, 430);
  const calloutX = interpolate(calloutP, [0, 1], [50, 0]);
  const calloutOpacity = Math.min(calloutP * 4, 1);

  // Transition in: horizontal wipe from right (frames 0–18)
  const wipeIn = interpolate(frame, [0, 18], [100, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // End dim
  const endDim = interpolate(frame, [456, 480], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.bg,
        opacity: endDim,
        clipPath: `inset(0 0 0 ${wipeIn}%)`,
      }}
    >
      {/* Title */}
      <div
        style={{
          position: "absolute",
          top: 96,
          left: 128,
          fontFamily: F.swiss,
          fontSize: SIZE.subtitle,
          fontWeight: 600,
          color: C.fg,
          opacity: titleOpacity,
          transform: `translateX(${titleX}px)`,
          letterSpacing: "0.02em",
        }}
      >
        OPERATOR ONBOARDING
      </div>

      {/* Terminal panel — left 65% */}
      <div
        style={{
          position: "absolute",
          top: 196,
          left: 128,
          width: 1080,
          bottom: 96,
          backgroundColor: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          padding: "24px 28px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          gap: 0,
          overflow: "hidden",
        }}
      >
        {visibleLines.map((line, i) => (
          <div
            key={i}
            style={{
              fontFamily: F.brutalist,
              fontSize: SIZE.label,
              color: line.color,
              lineHeight: 1.6,
              whiteSpace: "pre" as const,
              letterSpacing: "0.01em",
            }}
          >
            {line.text}
          </div>
        ))}
      </div>

      {/* Right panel — DHT visualization (top right) */}
      {dhtVisible && (
        <div
          style={{
            position: "absolute",
            top: 196,
            left: 1260,
            width: 530,
            height: 320,
            opacity: dhtProgress,
          }}
        >
          <svg width="460" height="300">
            {/* Existing DHT edges */}
            {DHT_EDGES.map(([a, b], i) => (
              <line
                key={i}
                x1={DHT_NODES[a].x}
                y1={DHT_NODES[a].y}
                x2={DHT_NODES[b].x}
                y2={DHT_NODES[b].y}
                stroke={C.border}
                strokeWidth={1}
                opacity={0.7}
              />
            ))}
            {/* New kernel connections */}
            {DHT_NODES.slice(0, 4).map((n, i) => (
              <line
                key={`nc-${i}`}
                x1={NEW_NODE.x}
                y1={NEW_NODE.y}
                x2={n.x}
                y2={n.y}
                stroke={C.accent1}
                strokeWidth={1}
                opacity={dhtProgress * 0.6}
              />
            ))}
            {/* Existing nodes */}
            {DHT_NODES.map((n, i) => (
              <circle
                key={i}
                cx={n.x}
                cy={n.y}
                r={5}
                fill={C.accent2}
                opacity={0.5}
              />
            ))}
            {/* New kernel — glowing */}
            <circle
              cx={NEW_NODE.x}
              cy={NEW_NODE.y}
              r={9}
              fill={C.accent1}
              opacity={dhtProgress}
              style={{ filter: `drop-shadow(0 0 12px ${C.accent1})` }}
            />
            {/* "NEW" label — 36px minimum */}
            <text
              x={NEW_NODE.x + 16}
              y={NEW_NODE.y + 8}
              fill={C.accent1}
              fontSize={36}
              fontFamily={F.brutalist}
              opacity={dhtProgress}
            >
              krn_8f2a
            </text>
          </svg>
        </div>
      )}

      {/* Right callout — payoff beat */}
      {frame >= 430 && (
        <div
          style={{
            position: "absolute",
            left: 1260,
            top: 560,
            width: 530,
            fontFamily: F.swiss,
            fontSize: SIZE.body,
            color: C.accent1,
            lineHeight: 1.45,
            opacity: calloutOpacity,
            transform: `translateX(${calloutX}px)`,
          }}
        >
          47 seconds from install
          <br />
          to live on network.
        </div>
      )}
    </AbsoluteFill>
  );
};

export default S04A_Onboarding;
