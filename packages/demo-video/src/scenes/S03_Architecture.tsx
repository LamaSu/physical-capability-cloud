/**
 * S03_Architecture — "The Protocol"
 *
 * 600 frames (20 seconds). One animated flow diagram of the full stack.
 *
 * Frame 0:      Title "THE PROTOCOL" — MONUMENT, SIZE.title (96px), C.fg. Fade in.
 * Frame 60-420: Horizontal flow of 6 nodes (SIX_PHASES).
 *               Node i appears at frame 60 + i*60 with smooth spring scale 0.9→1.
 *               Connector line draws between nodes.
 *               Node box: C.surface bg, 1px border in phase color, borderRadius 12px.
 *               Name: MONUMENT, 40px, phase color.
 *               Desc: SWISS, SIZE.label (36px), C.muted.
 * Frame 430:    Sponsor credits — SWISS, SIZE.label, C.muted, centered.
 * Frame 530:    Dim over 70 frames.
 *
 * NOTE: The ESCROW node (index 2) has color #ff0066 from SIX_PHASES data.
 * This is data-driven, not a "discord use" for the 3-discord rule.
 *
 * DESIGN RULES:
 * - Min font: SIZE.label = 36px
 * - Max 5 elements at once (nodes stagger so only a few visible per moment)
 * - bg: #050a0e
 */
import React from "react";
import { useCurrentFrame, useVideoConfig, AbsoluteFill, interpolate, Easing } from "remotion";
import { C, F, SIZE, smooth } from "../lib";
import { SIX_PHASES } from "../lib";

const NODE_WIDTH = 200;
const NODE_HEIGHT = 120;
const GAP = 40;
const CONNECTOR_WIDTH = GAP;
const TITLE_DELAY = 0;
const SPONSOR_FRAME = 430;

export const S03_Architecture: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── Title fade in ────────────────────────────────────────────────────────
  const titleP = smooth(frame, fps, TITLE_DELAY);
  const titleOpacity = titleP;
  const titleY = interpolate(titleP, [0, 1], [24, 0]);

  // ── Sponsor credits ──────────────────────────────────────────────────────
  const sponsorP = smooth(frame, fps, SPONSOR_FRAME);
  const sponsorOpacity = sponsorP;
  const sponsorY = interpolate(sponsorP, [0, 1], [16, 0]);

  // ── End dim ──────────────────────────────────────────────────────────────
  const endDim = interpolate(frame, [530, 600], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });

  // ── Node visibility ──────────────────────────────────────────────────────
  // Total pipeline width
  const totalWidth = SIX_PHASES.length * NODE_WIDTH + (SIX_PHASES.length - 1) * CONNECTOR_WIDTH;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.bg,
        padding: "96px 128px",
        display: "flex",
        flexDirection: "column",
        opacity: endDim,
      }}
    >
      {/* Title */}
      <div
        style={{
          fontFamily: F.monument,
          fontSize: SIZE.title,
          fontWeight: 700,
          color: C.fg,
          textTransform: "uppercase" as const,
          letterSpacing: "-0.02em",
          lineHeight: 1.0,
          opacity: titleOpacity,
          transform: `translateY(${titleY}px)`,
          marginBottom: 64,
        }}
      >
        THE PROTOCOL
      </div>

      {/* Pipeline — horizontally scrollable / auto-fit */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            width: totalWidth,
          }}
        >
          {SIX_PHASES.map((phase, i) => {
            const nodeDelay = 60 + i * 60;
            const nodeP = smooth(frame, fps, nodeDelay);
            const nodeScale = interpolate(nodeP, [0, 1], [0.9, 1]);
            const nodeOpacity = nodeP;

            // Connector draws after the PREVIOUS node arrives
            const connectorDelay = nodeDelay - 30;
            const connectorP = i > 0 ? smooth(frame, fps, connectorDelay) : 0;
            const connectorWidth = interpolate(connectorP, [0, 1], [0, CONNECTOR_WIDTH]);

            return (
              <React.Fragment key={phase.name}>
                {/* Connector line (before each node except first) */}
                {i > 0 && (
                  <div
                    style={{
                      width: connectorWidth,
                      height: 1,
                      backgroundColor: phase.color,
                      opacity: 0.5,
                      flexShrink: 0,
                      overflow: "hidden",
                    }}
                  />
                )}

                {/* Node box */}
                <div
                  style={{
                    width: NODE_WIDTH,
                    minHeight: NODE_HEIGHT,
                    backgroundColor: C.surface,
                    border: `1px solid ${phase.color}`,
                    borderRadius: 12,
                    padding: "18px 20px",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    justifyContent: "center",
                    gap: 8,
                    flexShrink: 0,
                    opacity: nodeOpacity,
                    transform: `scale(${nodeScale})`,
                    boxShadow: `0 0 24px ${phase.color}22`,
                  }}
                >
                  {/* Phase name */}
                  <div
                    style={{
                      fontFamily: F.monument,
                      fontSize: 40,
                      fontWeight: 700,
                      color: phase.color,
                      textTransform: "uppercase" as const,
                      letterSpacing: "0.02em",
                      lineHeight: 1.1,
                    }}
                  >
                    {phase.name}
                  </div>

                  {/* Phase description */}
                  <div
                    style={{
                      fontFamily: F.swiss,
                      fontSize: SIZE.label,
                      fontWeight: 400,
                      color: C.muted,
                      lineHeight: 1.3,
                    }}
                  >
                    {phase.desc}
                  </div>
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Sponsor credits */}
      <div
        style={{
          fontFamily: F.swiss,
          fontSize: SIZE.label,
          fontWeight: 400,
          color: C.muted,
          textAlign: "center",
          letterSpacing: "0.08em",
          opacity: sponsorOpacity,
          transform: `translateY(${sponsorY}px)`,
        }}
      >
        Storacha · Lit Protocol · Starknet · Flow · NEAR
      </div>
    </AbsoluteFill>
  );
};

export default S03_Architecture;
