/**
 * PCCDemo — Main PCC Demo Video Composition
 *
 * 9 scenes stitched with TransitionSeries.
 * Total: 4680 scene frames - 110 transition frames = 4570 frames (152.3s at 30fps)
 *
 * Scene durations (from storyboard):
 *   S01 Proof            600f  (20s)
 *   S02 Problem          480f  (16s)
 *   S03 Architecture     540f  (18s)
 *   S04A Onboarding      480f  (16s)
 *   S04B LiveJob        1140f  (38s)
 *   S05 EmergingMarkets  420f  (14s)
 *   S06 ScaleProof       330f  (11s)
 *   S07 Ecosystem        390f  (13s)
 *   S08 Close            300f  (10s)
 *
 * Transitions (storyboard-specified):
 *   S01→S02:  18f wipe-from-left
 *   S02→S03:   6f fade (hard cut)
 *   S03→S04A: 18f wipe-from-right
 *   S04A→S04B: 4f fade (hard cut black gap)
 *   S04B→S05: 18f wipe-from-right
 *   S05→S06:   4f fade (hard cut black gap)
 *   S06→S07:  24f fade (cross-dissolve — only dissolve in video)
 *   S07→S08:  18f wipe-from-left
 */

import React from "react";
import { AbsoluteFill } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { wipe } from "@remotion/transitions/wipe";

import { S01_Proof } from "../scenes/S01_Proof";
import { S02_Problem } from "../scenes/S02_Problem";
import { S03_Architecture } from "../scenes/S03_Architecture";
import { S04B_LiveJob } from "../scenes/S04B_LiveJob";
import { S05_EmergingMarkets } from "../scenes/S05_EmergingMarkets";
import { S05B_Implications } from "../scenes/S05B_Implications";
import { S06_ScaleProof } from "../scenes/S06_ScaleProof";
import { S07_Ecosystem } from "../scenes/S07_Ecosystem";
import { S08_Close } from "../scenes/S08_Close";

export const PCCDemo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: "#050a0e" }}>
    <TransitionSeries>
      {/* ── S01: PROOF (600f) ────────────────────────────────────────────── */}
      <TransitionSeries.Sequence durationInFrames={600}>
        <S01_Proof />
      </TransitionSeries.Sequence>

      {/* S01→S02: 18f horizontal wipe from left */}
      <TransitionSeries.Transition
        timing={linearTiming({ durationInFrames: 18 })}
        presentation={wipe({ direction: "from-left" })}
      />

      {/* ── S02: PROBLEM (480f) ──────────────────────────────────────────── */}
      <TransitionSeries.Sequence durationInFrames={480}>
        <S02_Problem />
      </TransitionSeries.Sequence>

      {/* S02→S03: 6f hard-cut fade */}
      <TransitionSeries.Transition
        timing={linearTiming({ durationInFrames: 6 })}
        presentation={fade()}
      />

      {/* ── S03: ARCHITECTURE + ONBOARDING (720f) ────────────────────────── */}
      <TransitionSeries.Sequence durationInFrames={720}>
        <S03_Architecture />
      </TransitionSeries.Sequence>

      {/* S03→S04B: 6f fade */}
      <TransitionSeries.Transition
        timing={linearTiming({ durationInFrames: 6 })}
        presentation={fade()}
      />

      {/* ── S04B: THE LIVE JOB (1140f) ───────────────────────────────────── */}
      <TransitionSeries.Sequence durationInFrames={1140}>
        <S04B_LiveJob />
      </TransitionSeries.Sequence>

      {/* S04B→S05: 18f horizontal wipe from right */}
      <TransitionSeries.Transition
        timing={linearTiming({ durationInFrames: 18 })}
        presentation={wipe({ direction: "from-right" })}
      />

      {/* ── S05: EMERGING MARKETS (420f) ─────────────────────────────────── */}
      <TransitionSeries.Sequence durationInFrames={420}>
        <S05_EmergingMarkets />
      </TransitionSeries.Sequence>

      {/* S05→S05B: 6f fade */}
      <TransitionSeries.Transition
        timing={linearTiming({ durationInFrames: 6 })}
        presentation={fade()}
      />

      {/* ── S05B: IMPLICATIONS (480f) ────────────────────────────────────── */}
      <TransitionSeries.Sequence durationInFrames={480}>
        <S05B_Implications />
      </TransitionSeries.Sequence>

      {/* S05B→S06: 4f hard-cut */}
      <TransitionSeries.Transition
        timing={linearTiming({ durationInFrames: 4 })}
        presentation={fade()}
      />

      {/* ── S06: SCALE PROOF (330f) ──────────────────────────────────────── */}
      <TransitionSeries.Sequence durationInFrames={330}>
        <S06_ScaleProof />
      </TransitionSeries.Sequence>

      {/* S06→S07: 24f cross-dissolve — the ONLY dissolve in the video */}
      <TransitionSeries.Transition
        timing={linearTiming({ durationInFrames: 24 })}
        presentation={fade()}
      />

      {/* ── S07: ECOSYSTEM (390f) ────────────────────────────────────────── */}
      <TransitionSeries.Sequence durationInFrames={390}>
        <S07_Ecosystem />
      </TransitionSeries.Sequence>

      {/* S07→S08: 18f horizontal wipe from left */}
      <TransitionSeries.Transition
        timing={linearTiming({ durationInFrames: 18 })}
        presentation={wipe({ direction: "from-left" })}
      />

      {/* ── S08: THE CLOSE (300f) ────────────────────────────────────────── */}
      <TransitionSeries.Sequence durationInFrames={300}>
        <S08_Close />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  </AbsoluteFill>
);

export default PCCDemo;
