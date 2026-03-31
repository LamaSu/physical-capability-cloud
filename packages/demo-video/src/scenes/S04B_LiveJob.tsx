/**
 * S04B_LiveJob — "THE LIVE JOB — Centerpiece"
 *
 * 1140 frames (38s). Five sequential beats, hard cuts between beats.
 *
 * BEAT 1 (0–240):   A2A Intent Bus — terminal stream, negotiation
 * BEAT 2 (240–480): OT-2 Executing — full-bleed dark bg + text overlay
 * BEAT 3 (480–780): Evidence Archived — CID panel, India story sidebar
 * BEAT 4 (780–990): Settlement — fee math diagram
 * BEAT 5 (990–1140): Architecture Acknowledgment — Storacha / Lit / Starknet
 *
 * Discord: none.
 * Max elements simultaneous: 5
 *
 * Transition in:  horizontal wipe from left (18 frames)
 * Transition out: horizontal wipe right (18 frames) into S05
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

// ─────────────────────────────────────────────────────────────────────────────
// Typewriter helper
// ─────────────────────────────────────────────────────────────────────────────
function typeAt(frame: number, text: string, startFrame: number, dur: number): string {
  if (frame < startFrame) return "";
  const elapsed = frame - startFrame;
  const chars = Math.min(Math.floor((elapsed / dur) * text.length) + 1, text.length);
  return text.slice(0, chars);
}

// ─────────────────────────────────────────────────────────────────────────────
// Beat 1: A2A Intent Stream (frames 0–239)
// ─────────────────────────────────────────────────────────────────────────────
interface IntentLine {
  frameOffset: number;
  main: string;
  sub: string;
  mainColor: string;
  typewriterFrames: number;
}

const INTENT_LINES: IntentLine[] = [
  {
    frameOffset: 24,
    main: "UserAgent → BrokerAgent: CAPABILITY_QUERY",
    sub:  "{ capability: 'eeg-calibration', assurance: 2, budget: 700 }",
    mainColor: C.accent2,
    typewriterFrames: 22,
  },
  {
    frameOffset: 72,
    main: "BrokerAgent → KernelAgent[IISc]: JOB_OFFER",
    sub:  "{ price_usdc: 620, delivery_hours: 48, tier: 2 }",
    mainColor: C.accent2,
    typewriterFrames: 22,
  },
  {
    frameOffset: 120,
    main: "KernelAgent[IISc] → BrokerAgent: JOB_ACCEPTED",
    sub:  "{ escrow: '0x9e81...6454', bond_posted: true }",
    mainColor: C.accent1,
    typewriterFrames: 22,
  },
  {
    frameOffset: 168,
    main: "KernelAgent → UserAgent: EXECUTION_STARTED",
    sub:  "{ scope_id: 'scp_2a9', class: 'SAFE_CONTROL' }",
    mainColor: C.accent1,
    typewriterFrames: 22,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Beat 4: Settlement nodes
// ─────────────────────────────────────────────────────────────────────────────
const SETTLE_NODES = [
  { label: "Operator Bond", sub1: "posted upfront", sub2: "slashable",         x: 128,  border: C.gold,    delay: 0 },
  { label: "Buyer Stake",   sub1: "locked in escrow", sub2: "before work",     x: 460,  border: C.gold,    delay: 18 },
  { label: "Evidence Verified", sub1: "tier met",    sub2: "auto-release",     x: 792,  border: C.accent1, delay: 36 },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Beat 5: Sponsor cards
// ─────────────────────────────────────────────────────────────────────────────
const SPONSOR_CARDS = [
  {
    name: "Storacha",
    status: "UCAN delegation — live evidence uploads",
    statusColor: C.accent1,
    border: C.accent1,
    x: 128,
    delay: 18,
  },
  {
    name: "Lit Protocol",
    status: "lit-node-client v7 — encryption module wired",
    statusColor: C.muted,
    border: C.border,
    x: 680,
    delay: 30,
  },
  {
    name: "Starknet",
    status: "starknet.js — ZK anchoring architecture",
    statusColor: C.muted,
    border: C.border,
    x: 1232,
    delay: 42,
  },
] as const;

export const S04B_LiveJob: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Transition in: wipe from left frames 0–18
  const wipeIn = interpolate(frame, [0, 18], [100, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  // Transition out: wipe right frames 1122–1140
  const wipeOut = interpolate(frame, [1122, 1140], [0, 100], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });

  // Current beat
  const beat = frame < 240 ? 1 : frame < 480 ? 2 : frame < 780 ? 3 : frame < 990 ? 4 : 5;

  // ── Beat offsets
  const b1 = frame;              // 0–239
  const b2 = frame - 240;        // 0–239
  const b3 = frame - 480;        // 0–299
  const b4 = frame - 780;        // 0–209
  const b5 = frame - 990;        // 0–149

  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.bg,
        clipPath: `inset(0 ${wipeOut}% 0 ${wipeIn}%)`,
      }}
    >
      {/* ══════════════════════════════════════════════════════════════
          BEAT 1 — A2A Intent Bus (0–239)
          ══════════════════════════════════════════════════════════════ */}
      {beat === 1 && (
        <>
          {/* Heading */}
          {(() => {
            const headSlam = slam(b1, fps, 0);
            const headX = interpolate(headSlam, [0, 1], [-60, 0]);
            return (
              <div
                style={{
                  position: "absolute",
                  top: 96,
                  left: 128,
                  fontFamily: F.swiss,
                  fontSize: SIZE.subtitle,
                  fontWeight: 600,
                  color: C.fg,
                  opacity: Math.min(headSlam * 6, 1),
                  transform: `translateX(${headX}px)`,
                }}
              >
                AGENT NEGOTIATION
              </div>
            );
          })()}

          {/* Terminal panel */}
          <div
            style={{
              position: "absolute",
              top: 196,
              left: 128,
              width: 1080,
              height: 520,
              backgroundColor: C.surface,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              padding: "24px 28px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "flex-start",
              gap: 0,
              overflow: "hidden",
            }}
          >
            {INTENT_LINES.map((line, i) => {
              if (b1 < line.frameOffset) return null;
              const mainText = typeAt(b1, line.main, line.frameOffset, line.typewriterFrames);
              const subReady = b1 >= line.frameOffset + line.typewriterFrames;
              return (
                <div key={i} style={{ marginBottom: 16 }}>
                  <div
                    style={{
                      fontFamily: F.brutalist,
                      fontSize: SIZE.label,
                      color: line.mainColor,
                      lineHeight: 1.5,
                      letterSpacing: "0.01em",
                    }}
                  >
                    {mainText}
                  </div>
                  {subReady && (
                    <div
                      style={{
                        fontFamily: F.brutalist,
                        fontSize: SIZE.label,
                        color: C.muted,
                        lineHeight: 1.4,
                        paddingLeft: 16,
                      }}
                    >
                      {line.sub}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Right callout — appears at b1=180 */}
          {b1 >= 180 && (() => {
            const p = smooth(b1, fps, 180);
            return (
              <div
                style={{
                  position: "absolute",
                  left: 1260,
                  top: 400,
                  width: 530,
                  fontFamily: F.swiss,
                  fontSize: SIZE.body,
                  color: C.accent2,
                  lineHeight: 1.45,
                  opacity: Math.min(p * 4, 1),
                  transform: `translateY(${interpolate(p, [0, 1], [20, 0])}px)`,
                }}
              >
                34 typed intents.
                <br />
                Not chat. Not HTTP.
              </div>
            );
          })()}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════
          BEAT 2 — OT-2 Executing (240–479)
          ══════════════════════════════════════════════════════════════ */}
      {beat === 2 && (
        <>
          {/* OT-2 simulated — dark with lab color tones */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: `
                radial-gradient(ellipse 900px 600px at 60% 40%, rgba(0,60,80,0.55) 0%, transparent 70%),
                radial-gradient(ellipse 600px 400px at 40% 70%, rgba(0,30,50,0.4) 0%, transparent 60%)
              `,
            }}
          />
          {/* Grid overlay — lab equipment feeling */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage: `
                linear-gradient(rgba(0,212,255,0.04) 1px, transparent 1px),
                linear-gradient(90deg, rgba(0,212,255,0.04) 1px, transparent 1px)
              `,
              backgroundSize: "80px 80px",
            }}
          />
          {/* OT-2 label — bottom safe zone */}
          {b2 >= 30 && (() => {
            const fu = fadeUp(b2, fps, 30);
            return (
              <div
                style={{
                  position: "absolute",
                  bottom: 120,
                  left: 128,
                  fontFamily: F.express,
                  fontSize: SIZE.body,
                  color: C.fg,
                  lineHeight: 1.4,
                  opacity: fu.opacity,
                  transform: `translateY(${fu.y}px)`,
                }}
              >
                The kernel executes. Evidence accumulates.
              </div>
            );
          })()}
          {/* Status indicator top-left */}
          <div
            style={{
              position: "absolute",
              top: 96,
              left: 128,
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                backgroundColor: C.accent1,
                boxShadow: `0 0 10px ${C.accent1}`,
                animation: undefined,
                opacity: Math.sin(b2 * 0.15) > 0 ? 1 : 0.3,
              }}
            />
            <span
              style={{
                fontFamily: F.brutalist,
                fontSize: SIZE.label,
                color: C.accent1,
              }}
            >
              OT-2 EXECUTING
            </span>
          </div>
          {/* Sensor reading stream */}
          {b2 >= 60 && (
            <div
              style={{
                position: "absolute",
                top: 160,
                right: 128,
                width: 400,
                fontFamily: F.brutalist,
                fontSize: SIZE.label,
                color: C.muted,
                lineHeight: 1.7,
                textAlign: "right" as const,
                opacity: Math.min(smooth(b2, fps, 60) * 4, 1),
              }}
            >
              {`sensor[temp]: ${(36.8 + Math.sin(b2 * 0.1) * 0.4).toFixed(1)}°C`}
              <br />
              {`sensor[flow]: ${(12.3 + Math.cos(b2 * 0.08) * 0.6).toFixed(1)} µL/s`}
              <br />
              {`log[${b2 + 1000}]: evidence_chunk_${Math.floor(b2 / 30) + 1}`}
              <br />
              {`hash: 0x${(0xabc123 + b2).toString(16).padStart(8, "0")}...`}
            </div>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════
          BEAT 3 — Evidence Archived (480–779)
          ══════════════════════════════════════════════════════════════ */}
      {beat === 3 && (
        <>
          {/* Heading */}
          {(() => {
            const headSlam = slam(b3, fps, 0);
            return (
              <div
                style={{
                  position: "absolute",
                  top: 96,
                  left: 128,
                  fontFamily: F.swiss,
                  fontSize: SIZE.subtitle,
                  fontWeight: 600,
                  color: C.fg,
                  opacity: Math.min(headSlam * 6, 1),
                  transform: `translateX(${interpolate(headSlam, [0, 1], [-60, 0])}px)`,
                }}
              >
                EVIDENCE ARCHIVED
              </div>
            );
          })()}

          {/* CID panel */}
          <div
            style={{
              position: "absolute",
              top: 196,
              left: 128,
              width: 1040,
              height: 460,
              backgroundColor: C.surface,
              border: `1px solid ${C.accent1}`,
              borderRadius: 8,
              boxShadow: `0 0 40px rgba(0,255,136,0.1)`,
              padding: "32px 36px",
              opacity: Math.min(smooth(b3, fps, 0) * 5, 1),
              transform: `translateY(${interpolate(smooth(b3, fps, 0), [0, 1], [30, 0])}px)`,
            }}
          >
            {/* CID — slam at b3=30 */}
            {b3 >= 30 && (
              <div
                style={{
                  fontFamily: F.brutalist,
                  fontSize: SIZE.subtitle,
                  color: C.accent1,
                  letterSpacing: "0.02em",
                  lineHeight: 1.2,
                  opacity: Math.min(slam(b3, fps, 30) * 6, 1),
                  transform: `translateX(${interpolate(slam(b3, fps, 30), [0, 1], [-40, 0])}px)`,
                  marginBottom: 16,
                }}
              >
                bafybeig7...xq7r4
              </div>
            )}
            {/* Source label */}
            {b3 >= 50 && (
              <div
                style={{
                  fontFamily: F.swiss,
                  fontSize: SIZE.label,
                  color: C.muted,
                  marginBottom: 24,
                  opacity: Math.min(smooth(b3, fps, 50) * 4, 1),
                }}
              >
                Storacha / pcc-evidence space
              </div>
            )}
            {/* "Any verifier" claim */}
            {b3 >= 90 && (
              <div
                style={{
                  fontFamily: F.express,
                  fontSize: SIZE.body,
                  color: C.fg,
                  lineHeight: 1.4,
                  marginBottom: 20,
                  opacity: Math.min(smooth(b3, fps, 90) * 4, 1),
                  transform: `translateY(${interpolate(smooth(b3, fps, 90), [0, 1], [16, 0])}px)`,
                }}
              >
                Any verifier. No gateway required.
              </div>
            )}
            {/* Tier details */}
            {b3 >= 120 && (
              <div
                style={{
                  fontFamily: F.brutalist,
                  fontSize: SIZE.label,
                  color: C.muted,
                  lineHeight: 1.5,
                  opacity: Math.min(smooth(b3, fps, 120) * 4, 1),
                }}
              >
                Tier-2 assurance · 47 sensors · ECIES encrypted · hash-chained log
              </div>
            )}
          </div>

          {/* India story sidebar */}
          {b3 >= 60 && (
            <div
              style={{
                position: "absolute",
                top: 240,
                left: 1220,
                width: 570,
                fontFamily: F.express,
                fontSize: 40,
                color: C.fg,
                lineHeight: 1.5,
                opacity: Math.min(smooth(b3, fps, 60) * 4, 1),
                transform: `translateY(${interpolate(smooth(b3, fps, 60), [0, 1], [24, 0])}px)`,
              }}
            >
              Dr. Nair, IISER Pune.
              <br />
              EEG calibration.
              <br />
              48 hours.
              <br />
              No institutional access required.
            </div>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════
          BEAT 4 — Settlement (780–989)
          ══════════════════════════════════════════════════════════════ */}
      {beat === 4 && (
        <>
          {/* Heading */}
          {(() => {
            const headSlam = slam(b4, fps, 0);
            return (
              <div
                style={{
                  position: "absolute",
                  top: 96,
                  left: 128,
                  fontFamily: F.swiss,
                  fontSize: SIZE.subtitle,
                  fontWeight: 700,
                  color: C.gold,
                  letterSpacing: "-0.02em",
                  textTransform: "uppercase" as const,
                  opacity: Math.min(headSlam * 6, 1),
                  transform: `translateX(${interpolate(headSlam, [0, 1], [-60, 0])}px)`,
                }}
              >
                SETTLEMENT
              </div>
            );
          })()}

          {/* Settlement nodes */}
          {SETTLE_NODES.map((node, i) => {
            if (b4 < node.delay) return null;
            const p = smooth(b4, fps, node.delay);
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: node.x,
                  top: 220,
                  width: 300,
                  height: 160,
                  backgroundColor: C.surface,
                  border: `1px solid ${node.border}`,
                  borderRadius: 8,
                  padding: "16px 20px",
                  opacity: Math.min(p * 4, 1),
                  transform: `translateY(${interpolate(p, [0, 1], [30, 0])}px)`,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                <div
                  style={{
                    fontFamily: F.swiss,
                    fontSize: SIZE.label,
                    fontWeight: 600,
                    color: C.fg,
                  }}
                >
                  {node.label}
                </div>
                <div
                  style={{
                    fontFamily: F.brutalist,
                    fontSize: SIZE.label,
                    color: C.muted,
                    lineHeight: 1.4,
                  }}
                >
                  {node.sub1}
                  <br />
                  {node.sub2}
                </div>
              </div>
            );
          })}

          {/* PCC fee math — two lines */}
          {b4 >= 60 && (() => {
            const p = smooth(b4, fps, 60);
            return (
              <>
                <div
                  style={{
                    position: "absolute",
                    top: 430,
                    left: 128,
                    right: 128,
                    fontFamily: F.brutalist,
                    fontSize: SIZE.body,
                    color: C.accent1,
                    lineHeight: 1.5,
                    opacity: Math.min(p * 4, 1),
                    transform: `translateY(${interpolate(p, [0, 1], [20, 0])}px)`,
                  }}
                >
                  $500 job  →  $492.50 operator  |  $7.50 protocol (1.5%)
                </div>
                {b4 >= 90 && (
                  <div
                    style={{
                      position: "absolute",
                      top: 510,
                      left: 128,
                      right: 128,
                      fontFamily: F.brutalist,
                      fontSize: SIZE.body,
                      color: C.muted,
                      lineHeight: 1.5,
                      opacity: Math.min(smooth(b4, fps, 90) * 4, 1),
                      transform: `translateY(${interpolate(smooth(b4, fps, 90), [0, 1], [16, 0])}px)`,
                    }}
                  >
                    Xometry same job  →  $327.50 operator  |  $172.50 platform (34.5%)
                  </div>
                )}
              </>
            );
          })()}

          {/* Escrow flow diagram — right side, div-based for 36px min rule */}
          {b4 >= 30 && (
            <div
              style={{
                position: "absolute",
                top: 180,
                right: 96,
                width: 500,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 0,
                opacity: Math.min(smooth(b4, fps, 30) * 4, 1),
              }}
            >
              {/* BUYER box */}
              <div style={{
                width: 320,
                backgroundColor: C.surface,
                border: `1px solid ${C.gold}`,
                borderRadius: 6,
                padding: "12px 20px",
                textAlign: "center" as const,
              }}>
                <div style={{ fontFamily: F.brutalist, fontSize: SIZE.label, color: C.fg }}>BUYER</div>
                <div style={{ fontFamily: F.brutalist, fontSize: SIZE.label, color: C.muted }}>locks stake</div>
              </div>
              {/* Arrow */}
              <div style={{ width: 2, height: 32, backgroundColor: C.border }} />
              {/* ESCROW box */}
              <div style={{
                width: 320,
                backgroundColor: C.surface,
                border: `1px solid ${C.accent2}`,
                borderRadius: 6,
                padding: "12px 20px",
                textAlign: "center" as const,
              }}>
                <div style={{ fontFamily: F.brutalist, fontSize: SIZE.label, color: C.fg }}>ESCROW</div>
                <div style={{ fontFamily: F.brutalist, fontSize: SIZE.label, color: C.muted }}>smart contract</div>
              </div>
              {/* Arrow */}
              <div style={{ width: 2, height: 32, backgroundColor: C.border, position: "relative" }}>
                {/* Animated flow dot */}
                {b4 >= 90 && (
                  <div style={{
                    position: "absolute",
                    left: -5,
                    top: interpolate(b4, [90, 150], [0, 80], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) }),
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    backgroundColor: C.accent1,
                    boxShadow: `0 0 10px ${C.accent1}`,
                  }} />
                )}
              </div>
              {/* OPERATOR box */}
              <div style={{
                width: 320,
                backgroundColor: C.surface,
                border: `1px solid ${C.accent1}`,
                borderRadius: 6,
                padding: "12px 20px",
                textAlign: "center" as const,
              }}>
                <div style={{ fontFamily: F.brutalist, fontSize: SIZE.label, color: C.accent1 }}>OPERATOR</div>
                <div style={{ fontFamily: F.brutalist, fontSize: SIZE.label, color: C.muted }}>receives $492.50</div>
              </div>
            </div>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════
          BEAT 5 — Architecture Acknowledgment (990–1139)
          ══════════════════════════════════════════════════════════════ */}
      {beat === 5 && (
        <>
          {/* Heading */}
          {(() => {
            const headSlam = slam(b5, fps, 0);
            return (
              <div
                style={{
                  position: "absolute",
                  top: 96,
                  left: 128,
                  fontFamily: F.swiss,
                  fontSize: SIZE.subtitle,
                  fontWeight: 600,
                  color: C.fg,
                  opacity: Math.min(headSlam * 6, 1),
                  transform: `translateX(${interpolate(headSlam, [0, 1], [-60, 0])}px)`,
                }}
              >
                VERIFICATION STACK
              </div>
            );
          })()}

          {/* Sponsor cards — 3 across */}
          {SPONSOR_CARDS.map((card, i) => {
            if (b5 < card.delay) return null;
            const p = smooth(b5, fps, card.delay);
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: card.x,
                  top: 230,
                  width: 460,
                  height: 220,
                  backgroundColor: C.surface,
                  border: `1px solid ${card.border}`,
                  borderRadius: 8,
                  padding: "28px 32px",
                  opacity: Math.min(p * 4, 1),
                  transform: `translateY(${interpolate(p, [0, 1], [30, 0])}px)`,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  gap: 14,
                }}
              >
                <div
                  style={{
                    fontFamily: F.swiss,
                    fontSize: SIZE.body,
                    fontWeight: 700,
                    color: C.fg,
                    letterSpacing: "0.02em",
                  }}
                >
                  {card.name}
                </div>
                <div
                  style={{
                    fontFamily: F.brutalist,
                    fontSize: SIZE.label,
                    color: card.statusColor,
                    lineHeight: 1.4,
                  }}
                >
                  {card.status}
                </div>
              </div>
            );
          })}

          {/* Bottom caption */}
          {b5 >= 90 && (
            <div
              style={{
                position: "absolute",
                bottom: 120,
                left: 128,
                right: 128,
                fontFamily: F.swiss,
                fontSize: SIZE.label,
                color: C.muted,
                textAlign: "center" as const,
                opacity: Math.min(smooth(b5, fps, 90) * 4, 1),
                transform: `translateY(${interpolate(smooth(b5, fps, 90), [0, 1], [16, 0])}px)`,
              }}
            >
              All three wired. All open source. Apache 2.0.
            </div>
          )}
        </>
      )}
    </AbsoluteFill>
  );
};

export default S04B_LiveJob;
