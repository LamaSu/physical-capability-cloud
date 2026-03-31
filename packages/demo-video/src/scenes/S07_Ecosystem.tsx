/**
 * S07_Ecosystem — "Sponsor Stack"
 *
 * 390 frames (13 seconds). 6 sponsor cards + footer.
 *
 * Frame 0:    "ECOSYSTEM" — MONUMENT, 96px, C.fg. Slam.
 * Frame 24:   Storacha (row 1, card 1) — large, emerald border, LIVE status.
 * Frame 42:   Lit Protocol (row 1, card 2) — standard, muted status.
 * Frame 60:   Starknet (row 1, card 3) — standard, muted status.
 * Frame 78:   Flow EVM (row 2, card 1) — emerald border, deployed status.
 * Frame 96:   NEAR (row 2, card 2) — standard, muted status.
 * Frame 114:  Impulse AI (row 2, card 3) — standard, muted status.
 * Frame 240:  Footer: "Built on Protocol Labs infrastructure." — fadeUp, muted.
 *
 * HC-11 tier differentiation:
 *   - Storacha + Flow EVM: emerald border + green status text (LIVE)
 *   - Lit + Starknet + NEAR + Impulse: dark border + muted status
 *
 * DESIGN RULES:
 * - Min font: 36px
 * - Max 5 elements visible at once (stagger entrance)
 * - bg: #050a0e
 * - No discord use in this scene
 */
import React from "react";
import { useCurrentFrame, useVideoConfig, AbsoluteFill, interpolate } from "remotion";
import { C, F, SIZE, slam, slamScale, smooth, fadeUp } from "../lib";

interface SponsorCard {
  name: string;
  status: string;
  live: boolean;
  enterFrame: number;
  row: number;
  col: number;
  wide?: boolean;
}

const CARDS: SponsorCard[] = [
  {
    name: "Storacha",
    status: "UCAN delegation — live evidence uploads",
    live: true,
    enterFrame: 24,
    row: 0,
    col: 0,
    wide: true,
  },
  {
    name: "Lit Protocol",
    status: "lit-node-client v7 — encryption module wired",
    live: false,
    enterFrame: 42,
    row: 0,
    col: 1,
  },
  {
    name: "Starknet",
    status: "starknet.js — ZK anchoring architecture",
    live: false,
    enterFrame: 60,
    row: 0,
    col: 2,
  },
  {
    name: "Flow EVM",
    status: "MilestoneEscrow deployed — FlowScan-verifiable",
    live: true,
    enterFrame: 78,
    row: 1,
    col: 0,
    wide: true,
  },
  {
    name: "NEAR",
    status: "1Click solver — cross-chain intent routing",
    live: false,
    enterFrame: 96,
    row: 1,
    col: 1,
  },
  {
    name: "Impulse AI",
    status: "complementary open infrastructure",
    live: false,
    enterFrame: 114,
    row: 1,
    col: 2,
  },
];

// Row/col layout constants
// Row 0: y=280, Row 1: y=500
// Wide card (col 0): w=500, standard: w=460
// Col positions: 0=128, 1=680, 2=1192
const ROW_Y = [280, 500];
const COL_X = [128, 680, 1192];
const CARD_H = 180;
const WIDE_W = 500;
const STD_W  = 460;

export const S07_Ecosystem: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── Title slam (frame 0) ──────────────────────────────────────────────────
  const titleScale = slamScale(frame, fps, 0, 2.2);
  const titleP     = slam(frame, fps, 0);
  const titleOpacity = Math.min(titleP * 6, 1);

  // ── Footer (frame 240) ────────────────────────────────────────────────────
  const footerAnim = fadeUp(frame, fps, 240);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.bg,
        padding: "96px 128px",
      }}
    >
      {/* ECOSYSTEM — title */}
      <div
        style={{
          position: "absolute",
          left: 128,
          top: 148,
          fontFamily: F.monument,
          fontSize: SIZE.title,
          fontWeight: 700,
          color: C.fg,
          textTransform: "uppercase" as const,
          letterSpacing: "0.06em",
          lineHeight: 1.0,
          opacity: titleOpacity,
          transform: `scale(${titleScale})`,
          transformOrigin: "left center",
        }}
      >
        ECOSYSTEM
      </div>

      {/* Sponsor cards */}
      {CARDS.map((card) => {
        const cardP = slam(frame, fps, card.enterFrame);
        const cardScale = slamScale(frame, fps, card.enterFrame, 1.8);
        const cardOpacity = Math.min(cardP * 6, 1);

        const cardW = card.wide ? WIDE_W : STD_W;
        const cardX = COL_X[card.col];
        const cardY = ROW_Y[card.row];

        const borderColor  = card.live ? C.accent1 : C.border;
        const statusColor  = card.live ? C.accent1 : C.muted;
        const glowColor    = card.live ? "rgba(0,255,136,0.10)" : undefined;

        return (
          <div
            key={card.name}
            style={{
              position: "absolute",
              left: cardX,
              top: cardY,
              width: cardW,
              height: CARD_H,
              backgroundColor: C.surface,
              border: `1.5px solid ${borderColor}`,
              borderRadius: 14,
              boxShadow: glowColor
                ? `0 0 24px ${glowColor}, inset 0 0 16px ${glowColor}`
                : undefined,
              padding: "22px 28px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              gap: 10,
              opacity: cardOpacity,
              transform: `scale(${cardScale})`,
              transformOrigin: "top left",
            }}
          >
            {/* Sponsor name */}
            <div
              style={{
                fontFamily: F.swiss,
                fontSize: SIZE.body,
                fontWeight: 700,
                color: C.fg,
                letterSpacing: "0.02em",
                lineHeight: 1.1,
              }}
            >
              {card.name}
            </div>

            {/* Status line */}
            <div
              style={{
                fontFamily: F.brutalist,
                fontSize: SIZE.label,
                fontWeight: 400,
                color: statusColor,
                letterSpacing: "0.02em",
                lineHeight: 1.3,
              }}
            >
              {card.status}
            </div>
          </div>
        );
      })}

      {/* Footer */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 96,
          display: "flex",
          justifyContent: "center",
          opacity: footerAnim.opacity,
          transform: `translateY(${footerAnim.y}px)`,
        }}
      >
        <div
          style={{
            fontFamily: F.swiss,
            fontSize: SIZE.label,
            fontWeight: 400,
            color: C.muted,
            letterSpacing: "0.06em",
          }}
        >
          Built on Protocol Labs infrastructure.
        </div>
      </div>
    </AbsoluteFill>
  );
};

export default S07_Ecosystem;
