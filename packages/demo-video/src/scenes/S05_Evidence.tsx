/**
 * S05_Arena — "The Terminal War"
 *
 * 570 frames (19 seconds). Agent bidding at DnB speed.
 *
 * Frame 0:     Title SLAMS in — Monument, accent2 (cyan, not green for voice variety).
 * Frame 8:     Three operator cards appear SIMULTANEOUSLY — slam from bottom.
 *              No stagger. They arrive together like fighters entering an arena.
 * Frame 30:    Terminal log starts typing — 18 frames per entry (fast, urgent).
 * Frame 300:   Discord card (MachineShop Beta) FLICKERS — it's losing the bid.
 *              Strobe effect: 4-frame on/off for 20 frames.
 * Frame 380:   "Winner: LAB-01" line appears. Discord card dims permanently.
 * Frame 420:   Status bar SNAPS in from bottom.
 * Frame 530:   Everything dims for transition.
 *
 * Axiom I: Title → cards → terminal → status. Clear reading order.
 * Axiom II: Middle card IS discord. The loser marked from birth.
 * Axiom III: Simultaneous entrance → sequential typing → strobe → snap. Time layers.
 *
 * Voices: Monument (title), Swiss (names), Brutalist (capabilities, terminal, status)
 */
import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  AbsoluteFill,
  interpolate,
} from "remotion";
import { noise2D } from "@remotion/noise";
import {
  COLORS,
  FONTS,
  NEGOTIATION_LOG,
  slamSpring,
  slamScale,
  smoothSpring,
  whipUp,
  strobe,
  beatPulse,
  flashBurst,
} from "../lib";
import { PulseIndicator } from "../components/PulseIndicator";
import { TerminalLog } from "../components/TerminalLog";

type OperatorCard = {
  name: string;
  capability: string;
  dotColor: string;
  isDiscord?: boolean;
};

const OPERATORS: OperatorCard[] = [
  { name: "BioLab Alpha", capability: "HPLC · 99.2% purity · 4hr", dotColor: COLORS.accent2 },
  { name: "MachineShop Beta", capability: "CNC · ±0.01mm · Same-day", dotColor: COLORS.discord, isDiscord: true },
  { name: "CourierNet Gamma", capability: "Same-day delivery · 50km", dotColor: COLORS.accent1 },
];

const OperatorCardItem: React.FC<{ op: OperatorCard; index: number }> = ({
  op,
  index,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ALL cards slam in at frame 8 — no stagger
  const { opacity, translateY } = whipUp(frame, fps, 8, 120);

  // Discord card flickers at frame 300-320
  const flickerActive = op.isDiscord && frame >= 300 && frame < 320;
  const flickerOpacity = flickerActive
    ? strobe(frame, 300, 320, 4, 0.5)
    : 1;

  // Discord card dims permanently after frame 380
  const discordDim = op.isDiscord
    ? interpolate(frame, [380, 400], [1, 0.25], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 1;

  // Noise drift
  const driftY = noise2D(`card-${index}`, 0, (frame / fps) * 0.25) * 2;

  return (
    <div
      style={{
        opacity: opacity * flickerOpacity * discordDim,
        transform: `translateY(${translateY + driftY}px)`,
        flex: 1,
      }}
    >
      <div
        style={{
          padding: "16px 18px",
          background: COLORS.bg.surface,
          border: `1px solid ${op.dotColor}${op.isDiscord ? "88" : "3a"}`,
          borderRadius: 12,
          boxShadow: op.isDiscord
            ? `0 0 20px rgba(248,113,113,0.3), inset 0 1px 0 rgba(255,255,255,0.04)`
            : `0 0 16px ${op.dotColor}18, inset 0 1px 0 rgba(255,255,255,0.04)`,
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse at center top, ${op.dotColor}08 0%, transparent 60%)`, pointerEvents: "none" }} />

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, position: "relative" }}>
          <PulseIndicator color={op.dotColor} size={9} delay={12} />
          <span style={{ fontFamily: FONTS.swiss, fontSize: 24, fontWeight: 700, color: COLORS.fg, letterSpacing: "-0.01em" }}>
            {op.name}
          </span>
          {op.isDiscord && (
            <span style={{ fontFamily: FONTS.brutalist, fontSize: 14, color: COLORS.discord, padding: "3px 9px", border: `1px solid ${COLORS.discord}44`, borderRadius: 3, letterSpacing: "0.1em", marginLeft: "auto" }}>
              BIDDING
            </span>
          )}
        </div>

        <div style={{ fontFamily: FONTS.brutalist, fontSize: 18, color: COLORS.muted, letterSpacing: "0.04em", paddingLeft: 19, position: "relative" }}>
          {op.capability}
        </div>

        <div style={{ marginTop: 12, height: 2, borderRadius: 2, background: `linear-gradient(90deg, ${op.dotColor}66 0%, ${op.dotColor}11 100%)` }} />
      </div>
    </div>
  );
};

/** Status bar — SNAPS in from bottom at frame 420 */
const StatusBar: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { opacity, translateY } = whipUp(frame, fps, 420, 60);

  const stats = [
    { label: "operators", value: "3", color: COLORS.accent1 },
    { label: "bids", value: "15", color: COLORS.accent2 },
    { label: "locked", value: "$3,932", color: COLORS.discord },
  ];

  return (
    <div
      style={{
        opacity,
        transform: `translateY(${translateY}px)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 36,
        padding: "14px 36px",
        background: "rgba(0,0,0,0.55)",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: 10,
      }}
    >
      {stats.map((stat, i) => (
        <React.Fragment key={stat.label}>
          {i > 0 && <div style={{ width: 1, height: 22, background: "rgba(255,255,255,0.08)" }} />}
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <PulseIndicator color={stat.color} size={7} delay={420 + i * 4} />
            <span style={{ fontFamily: FONTS.brutalist, fontSize: 24, fontWeight: 700, color: stat.color, letterSpacing: "0.04em", fontVariantNumeric: "tabular-nums" }}>
              {stat.value}
            </span>
            <span style={{ fontFamily: FONTS.swiss, fontSize: 18, color: COLORS.muted, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              {stat.label}
            </span>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};

export const S05_Evidence: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Title SLAMS
  const titleProgress = slamSpring(frame, fps, 0);
  const titleScale = slamScale(frame, fps, 0, 2);
  const titleOpacity = Math.min(titleProgress * 5, 1);

  // Terminal opacity
  const termOpacity = interpolate(frame, [28, 38], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // End dim
  const endDim = interpolate(frame, [530, 568], [1, 0.2], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Discord flash when card flickers
  const flickerFlash = flashBurst(frame, 300, 2);

  const beat = beatPulse(frame, fps, 170, 0.04);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg.deep,
        padding: "40px 60px 36px",
        display: "flex",
        flexDirection: "column",
        gap: 18,
      }}
    >
      {/* Blue-white atmosphere */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse at 50% 0%, rgba(148,184,255,${0.05 + beat}) 0%, transparent 50%)`,
          pointerEvents: "none",
        }}
      />

      {/* Title — Monument, accent2, SLAM */}
      <div
        style={{
          opacity: titleOpacity * endDim,
          transform: `scale(${titleScale})`,
          fontFamily: FONTS.monument,
          fontSize: 52,
          fontWeight: 700,
          color: COLORS.accent2,
          textAlign: "center",
          letterSpacing: "0.02em",
          textTransform: "uppercase",
          textShadow: `0 0 40px rgba(148,184,255,0.4)`,
          zIndex: 1,
        }}
      >
        Competitive Bidding
      </div>

      {/* Operator cards — all slam simultaneously */}
      <div style={{ display: "flex", gap: 16, zIndex: 1, opacity: endDim }}>
        {OPERATORS.map((op, i) => (
          <OperatorCardItem key={op.name} op={op} index={i} />
        ))}
      </div>

      {/* Terminal — faster typing */}
      <div
        style={{
          opacity: termOpacity * endDim,
          flex: 1,
          display: "flex",
          flexDirection: "column",
          zIndex: 1,
          minHeight: 0,
        }}
      >
        <TerminalLog
          entries={NEGOTIATION_LOG}
          delay={30}
          framesPerEntry={18}
          fontSize={20}
        />
      </div>

      {/* Status bar — snaps in */}
      <div style={{ zIndex: 1, opacity: endDim }}>
        <StatusBar />
      </div>

      {/* Discord flash on flicker */}
      {flickerFlash > 0 && (
        <AbsoluteFill
          style={{
            backgroundColor: `rgba(248,113,113,${flickerFlash * 0.12})`,
            pointerEvents: "none",
          }}
        />
      )}
    </AbsoluteFill>
  );
};

export default S05_Evidence;
