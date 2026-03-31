/**
 * S05_Evidence — "The Live Job"
 *
 * 1200 frames (40s). The CENTERPIECE.
 *
 * Beat 1 (0-360):   Evidence pipeline — 5 steps, staggered entry.
 * Beat 2 (360-780):  Settlement economics — $175 vs $7.50, operator keeps $492.50.
 * Beat 3 (780-1080): Sponsor acknowledgment — 5 sponsors staggered.
 * Frame 1100-1200:   Dim out.
 *
 * Discord use #2: Step 5 border (the money moment).
 *
 * Design rules enforced:
 * - Min font 36px everywhere
 * - Max 5 elements on screen
 * - bg #050a0e
 * - Safe margins: 128px left/right, 96px top/bottom
 */
import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  AbsoluteFill,
  interpolate,
} from "remotion";
import { C, F, SIZE, smooth, slamScale, fadeUp } from "../lib";
import { SPONSORS, SETTLEMENT_MATH } from "../lib";


const EVIDENCE_STEPS = [
  {
    name: "Evidence Collected",
    detail: "6 events: peaks, purity, retention",
    color: C.accent1,
    borderColor: C.accent1,
  },
  {
    name: "Encrypted",
    detail: "Lit Protocol AES-256-GCM",
    color: C.accent2,
    borderColor: C.accent2,
  },
  {
    name: "Stored on IPFS",
    detail: "Storacha content-addressed",
    color: C.accent2,
    borderColor: C.accent2,
  },
  {
    name: "ZK Proof Anchored",
    detail: "Starknet Sepolia",
    color: C.accent1,
    borderColor: C.accent1,
  },
  {
    name: "Escrow Released",
    detail: `$${SETTLEMENT_MATH.operatorReceives} to operator`,
    color: C.gold,
    // Step 5 border is discord — USE #2
    borderColor: C.discord,
  },
] as const;

const EvidenceStep: React.FC<{
  index: number;
  step: typeof EVIDENCE_STEPS[number];
  appearFrame: number;
  dimOpacity: number;
}> = ({ index, step, appearFrame, dimOpacity }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const p = smooth(frame, fps, appearFrame);
  const translateY = interpolate(p, [0, 1], [24, 0]);

  return (
    <div
      style={{
        opacity: p * dimOpacity,
        transform: `translateY(${translateY}px)`,
        display: "flex",
        alignItems: "center",
        gap: 24,
        height: 72,
        padding: "0 24px",
        background: C.surface,
        border: `1.5px solid ${step.borderColor}`,
        borderRadius: 10,
        flexShrink: 0,
        boxSizing: "border-box" as const,
      }}
    >
      {/* Number circle */}
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: "50%",
          backgroundColor: step.color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: F.brutalist,
            fontSize: SIZE.label,
            fontWeight: 700,
            color: C.bg,
            lineHeight: 1,
          }}
        >
          {index + 1}
        </span>
      </div>

      {/* Step name */}
      <span
        style={{
          fontFamily: F.swiss,
          fontSize: 40,
          fontWeight: 600,
          color: C.fg,
          flexShrink: 0,
        }}
      >
        {step.name}
      </span>

      {/* Detail */}
      <span
        style={{
          fontFamily: F.swiss,
          fontSize: SIZE.label,
          fontWeight: 400,
          color: C.muted,
        }}
      >
        {step.detail}
      </span>
    </div>
  );
};

export const S05_Evidence: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── Beat 1: Evidence (0-360) ──
  const titleP = smooth(frame, fps, 0);
  const titleScale = slamScale(frame, fps, 0, 2.5);
  const subtitleFu = fadeUp(frame, fps, 40);

  // Steps stagger: first appears at frame 90, 50 frames apart
  const STEP_STAGGER = 50;

  // Dim beat1 content when beat2 starts
  const beat1Dim = interpolate(frame, [360, 410], [1, 0.25], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // ── Beat 2: Settlement (360-780) ──
  const beat2Visible = frame >= 360;

  // $175 — appears at 380
  const price175P = smooth(frame, fps, 380);
  const price175Fu = fadeUp(frame, fps, 380);
  const price175Label = fadeUp(frame, fps, 400);

  // $7.50 — appears at 500, $175 shrinks + moves left
  const price750P = smooth(frame, fps, 500);
  const price750Fu = fadeUp(frame, fps, 500);
  const price750Label = fadeUp(frame, fps, 520);

  // When $7.50 appears, $175 shifts left
  const leftShift = interpolate(smooth(frame, fps, 500), [0, 1], [0, -260], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Summary line at 640
  const summaryFu = fadeUp(frame, fps, 640);

  // Dim beat2 when beat3 starts
  const beat2Dim = interpolate(frame, [780, 820], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // ── Beat 3: Sponsors (780-1080) ──
  const beat3HeaderFu = fadeUp(frame, fps, 800);

  // End dim — shortened since Beat 3 removed
  const endDim = interpolate(frame, [750, 840], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.bg,
        padding: "96px 128px",
        overflow: "hidden",
        boxSizing: "border-box" as const,
      }}
    >
      {/* ── BEAT 1: Evidence pipeline ── */}
      {frame < 800 && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            padding: "96px 128px",
            display: "flex",
            flexDirection: "column",
            gap: 20,
            opacity: beat1Dim * endDim,
          }}
        >
          {/* Title */}
          <div
            style={{
              opacity: Math.min(titleP * 5, 1),
              transform: `scale(${titleScale})`,
              transformOrigin: "left center",
              marginBottom: 8,
            }}
          >
            <span
              style={{
                fontFamily: F.monument,
                fontSize: SIZE.title,
                fontWeight: 700,
                color: C.accent1,
                textTransform: "uppercase" as const,
                letterSpacing: "-0.02em",
                lineHeight: 1,
              }}
            >
              PROOF OF WORK
            </span>
          </div>

          {/* Subtitle */}
          <div
            style={{
              opacity: subtitleFu.opacity,
              transform: `translateY(${subtitleFu.y}px)`,
              marginBottom: 16,
            }}
          >
            <span
              style={{
                fontFamily: F.swiss,
                fontSize: SIZE.label,
                color: C.muted,
              }}
            >
              Every job produces cryptographic evidence
            </span>
          </div>

          {/* 5 evidence steps */}
          {EVIDENCE_STEPS.map((step, i) => (
            <EvidenceStep
              key={i}
              index={i}
              step={step}
              appearFrame={90 + i * STEP_STAGGER}
              dimOpacity={beat1Dim}
            />
          ))}
        </div>
      )}

      {/* ── BEAT 2: Settlement economics ── */}
      {beat2Visible && frame < 850 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 32,
            opacity: beat2Dim * endDim,
            padding: "96px 128px",
            boxSizing: "border-box" as const,
          }}
        >
          {/* Row of the two numbers */}
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "center",
              gap: 120,
              width: "100%",
            }}
          >
            {/* $175 — what Xometry keeps */}
            <div
              style={{
                opacity: price175P,
                transform: `translateY(${price175Fu.y}px) translateX(${leftShift}px)`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span
                style={{
                  fontFamily: F.monument,
                  fontSize: SIZE.data,
                  fontWeight: 700,
                  color: C.discord,
                  lineHeight: 1,
                  letterSpacing: "-0.03em",
                }}
              >
                35%
              </span>
              <span
                style={{
                  fontFamily: F.swiss,
                  fontSize: SIZE.label,
                  color: C.muted,
                  textAlign: "center",
                }}
              >
                XOMETRY · UBER · FIVERR
              </span>
              <span
                style={{
                  fontFamily: F.swiss,
                  fontSize: SIZE.label,
                  color: C.muted,
                  textAlign: "center",
                }}
              >
                ON A $500 JOB
              </span>
            </div>

            {/* $7.50 — PCC protocol fee */}
            {frame >= 500 && (
              <div
                style={{
                  opacity: price750P,
                  transform: `translateY(${price750Fu.y}px)`,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontFamily: F.monument,
                    fontSize: SIZE.data,
                    fontWeight: 700,
                    color: C.accent1,
                    lineHeight: 1,
                    letterSpacing: "-0.03em",
                  }}
                >
                  1.5%
                </span>
                <span
                  style={{
                    fontFamily: F.swiss,
                    fontSize: SIZE.label,
                    color: C.muted,
                    textAlign: "center",
                  }}
                >
                  PCC PROTOCOL FEE
                </span>
              </div>
            )}
          </div>

          {/* Summary line */}
          {frame >= 640 && (
            <div
              style={{
                opacity: summaryFu.opacity,
                transform: `translateY(${summaryFu.y}px)`,
                textAlign: "center",
              }}
            >
              <span
                style={{
                  fontFamily: F.express,
                  fontSize: SIZE.body,
                  fontWeight: 300,
                  color: C.fg,
                  lineHeight: 1.4,
                }}
              >
                Value flows to operators, not platforms.
              </span>
            </div>
          )}

          {/* Black market / supply chain line — frame 710 */}
          {frame >= 710 && (
            <div
              style={{
                opacity: fadeUp(frame, fps, 710).opacity,
                transform: `translateY(${fadeUp(frame, fps, 710).y}px)`,
                textAlign: "center",
              }}
            >
              <span
                style={{
                  fontFamily: F.swiss,
                  fontSize: SIZE.label,
                  fontWeight: 400,
                  color: C.muted,
                  lineHeight: 1.4,
                }}
              >
                $467B in counterfeit goods vanish when
              </span>
              <br />
              <span
                style={{
                  fontFamily: F.swiss,
                  fontSize: SIZE.label,
                  fontWeight: 600,
                  color: C.accent2,
                  lineHeight: 1.4,
                }}
              >
                every step has cryptographic proof.
              </span>
            </div>
          )}
        </div>
      )}

      {/* Beat 3 sponsors removed — already shown in architecture scene */}
    </AbsoluteFill>
  );
};

export default S05_Evidence;
