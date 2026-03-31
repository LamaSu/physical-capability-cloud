/**
 * S03_Architecture — "The Protocol" (REWRITTEN from storyboard.json)
 *
 * 540 frames (18 seconds). 6-phase protocol flow diagram.
 *
 * Frame 0:     "THE PROTOCOL" — MONUMENT 96px, slam
 * Frame 30:    Node 1: OPERATOR — slam
 * Frame 42:    Node 2: SHOP KERNEL — slam
 * Frame 54:    Node 3: PCC GATEWAY — slam
 * Frame 66:    Node 4: AI AGENT — slam
 * Frame 78:    Node 5: EVIDENCE STACK (emerald border) — slam
 * Frame 90:    Node 6: SETTLEMENT (gold border) — slam
 * Frame 108:   Connector lines draw left→right over 60 frames
 * Frame 200:   Caption: "No central registry. Any node failure is non-fatal."
 * Frame 320:   Discord rule: 2px vertical between Evidence↔Settlement
 *              Appears #ff0066, resolves to #00ff88 over 15 frames, gone at 350
 * Frame 420:   Pulse dot runs chain (30 frames)
 *
 * Discord: #ff0066 on rule between Evidence and Settlement — 30 frames only.
 * Max elements simultaneous: 5
 */
import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  AbsoluteFill,
  interpolate,
  Easing,
} from "remotion";
import { C, F, SIZE, smooth, slam, fadeUp } from "../lib";

// Node definitions
const NODES = [
  {
    id: "operator",
    label: "OPERATOR",
    sub1: "pcc-node",
    sub2: "pip install",
    x: 128,
    bg: C.surface,
    border: C.border,
    glow: "none",
    delay: 30,
    labelColor: C.fg,
  },
  {
    id: "shopkernel",
    label: "SHOP KERNEL",
    sub1: "Ed25519",
    sub2: "DHT gossip",
    x: 404,
    bg: C.surface,
    border: C.border,
    glow: `rgba(0,212,255,0.12)`,
    delay: 42,
    labelColor: C.fg,
  },
  {
    id: "gateway",
    label: "PCC GATEWAY",
    sub1: "347 endpoints",
    sub2: "Railway",
    x: 680,
    bg: "#121c2a",
    border: C.border,
    glow: "none",
    delay: 54,
    labelColor: C.fg,
  },
  {
    id: "aiagent",
    label: "AI AGENT",
    sub1: "A2A typed",
    sub2: "34 intents",
    x: 956,
    bg: C.surface,
    border: C.border,
    glow: `rgba(0,212,255,0.12)`,
    delay: 66,
    labelColor: C.fg,
  },
  {
    id: "evidence",
    label: "EVIDENCE STACK",
    sub1: "Storacha",
    sub2: "Lit  Starknet",
    x: 1232,
    bg: C.surface,
    border: C.accent1,
    glow: `rgba(0,255,136,0.15)`,
    delay: 78,
    labelColor: C.fg,
  },
  {
    id: "settlement",
    label: "SETTLEMENT",
    sub1: "MilestoneEscrow",
    sub2: "Flow  NEAR",
    x: 1508,
    bg: C.surface,
    border: C.gold,
    glow: `rgba(255,170,0,0.10)`,
    delay: 90,
    labelColor: C.fg,
  },
] as const;

const NODE_W = 220;
const NODE_H = 140;
const NODES_Y = 400; // center of nodes
const NODE_TOP = NODES_Y - NODE_H / 2;

export const S03_Architecture: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Title
  const titleSlam = slam(frame, fps, 0);
  const titleX = interpolate(titleSlam, [0, 1], [-60, 0]);
  const titleOpacity = Math.min(titleSlam * 6, 1);

  // Connector draw progress — frames 108–168
  const connectorProgress = interpolate(frame, [108, 168], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });

  // Caption — frame 200
  const caption = fadeUp(frame, fps, 200);

  // Discord rule — frames 320–350
  const ruleVisible = frame >= 320 && frame <= 350;
  const ruleColor = frame >= 320 && frame < 335
    ? interpolate(frame, [320, 335], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 1;
  // 0 = discord (#ff0066), 1 = accent1 (#00ff88)
  const ruleColorValue = frame < 335 ? C.discord : C.accent1;

  // Pulse animation — frames 420–450
  const pulseProgress = interpolate(frame, [420, 450], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const pulseVisible = frame >= 420 && frame <= 470;
  // Pulse dot X: from node1 center to node6 center
  const pulseX = pulseVisible
    ? interpolate(pulseProgress, [0, 1], [128 + NODE_W / 2, 1508 + NODE_W / 2])
    : -100;

  // End fade
  const endDim = interpolate(frame, [510, 540], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });

  return (
    <AbsoluteFill style={{ backgroundColor: C.bg, opacity: endDim }}>
      {/* Title */}
      <div
        style={{
          position: "absolute",
          top: 96,
          left: 128,
          fontFamily: F.monument,
          fontSize: SIZE.title,
          fontWeight: 700,
          color: C.fg,
          textTransform: "uppercase" as const,
          letterSpacing: "0.06em",
          lineHeight: 1,
          opacity: titleOpacity,
          transform: `translateX(${titleX}px)`,
        }}
      >
        THE PROTOCOL
      </div>

      {/* Connector lines — SVG */}
      <svg
        style={{ position: "absolute", top: 0, left: 0, width: 1920, height: 1080 }}
      >
        {NODES.slice(0, -1).map((node, i) => {
          const nextNode = NODES[i + 1];
          const x1 = node.x + NODE_W;
          const x2 = nextNode.x;
          const y = NODES_Y;
          const segmentEnd = connectorProgress * (NODES.length - 1);
          const segDone = Math.min(Math.max(segmentEnd - i, 0), 1);
          const segX2 = x1 + (x2 - x1) * segDone;
          return (
            <line
              key={node.id}
              x1={x1}
              y1={y}
              x2={segX2}
              y2={y}
              stroke={C.border}
              strokeWidth={2}
            />
          );
        })}

        {/* Pulse dot */}
        {pulseVisible && (
          <circle
            cx={pulseX}
            cy={NODES_Y}
            r={8}
            fill={C.accent1}
            style={{
              filter: `drop-shadow(0 0 8px ${C.accent1})`,
            }}
          />
        )}

        {/* Discord rule between Evidence and Settlement — vertical */}
        {ruleVisible && (
          <line
            x1={NODES[4].x + NODE_W + 8}
            y1={NODE_TOP - 12}
            x2={NODES[4].x + NODE_W + 8}
            y2={NODE_TOP + NODE_H + 12}
            stroke={ruleColorValue}
            strokeWidth={2}
            opacity={frame <= 350 ? interpolate(frame, [340, 350], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0}
          />
        )}
      </svg>

      {/* Nodes */}
      {NODES.map((node) => {
        const p = smooth(frame, fps, node.delay);
        const nodeX = interpolate(p, [0, 1], [-40, 0]);
        const nodeOpacity = Math.min(p * 5, 1);

        return (
          <div
            key={node.id}
            style={{
              position: "absolute",
              left: node.x,
              top: NODE_TOP,
              width: NODE_W,
              height: NODE_H,
              backgroundColor: node.bg,
              border: `1px solid ${node.border}`,
              borderRadius: 8,
              boxShadow: node.glow !== "none" ? `0 0 20px ${node.glow}` : undefined,
              opacity: nodeOpacity,
              transform: `translateX(${nodeX}px)`,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              padding: "12px 8px",
            }}
          >
            <div
              style={{
                fontFamily: F.swiss,
                fontSize: SIZE.label,
                fontWeight: 600,
                color: node.labelColor,
                textAlign: "center" as const,
                lineHeight: 1.2,
              }}
            >
              {node.label}
            </div>
            <div
              style={{
                fontFamily: F.brutalist,
                fontSize: SIZE.label,
                color: C.muted,
                textAlign: "center" as const,
                lineHeight: 1.3,
                whiteSpace: "pre-line" as const,
              }}
            >
              {`${node.sub1}\n${node.sub2}`}
            </div>
          </div>
        );
      })}

      {/* Caption */}
      {frame >= 200 && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: NODE_TOP + NODE_H + 48,
            fontFamily: F.swiss,
            fontSize: SIZE.label,
            color: C.muted,
            textAlign: "center" as const,
            opacity: caption.opacity,
            transform: `translateY(${caption.y}px)`,
          }}
        >
          No central registry. Any node failure is non-fatal.
        </div>
      )}
    </AbsoluteFill>
  );
};

export default S03_Architecture;
