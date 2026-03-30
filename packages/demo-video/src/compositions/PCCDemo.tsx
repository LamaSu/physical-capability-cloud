/**
 * PCCDemo — "DIES IRAE" Cut
 *
 * TikTok trailer energy. DnB pacing. Hard cuts. Flash transitions.
 * Structure follows a drum & bass track: build → drop → build → drop → breakdown → outro
 *
 * Scene arc:
 *   VOID (cold open) → IMPACT (title slam) → FRACTURE (rapid-fire contrast)
 *   → CIRCUIT (hero pipeline) → ARENA (terminal war) → CASCADE (evidence domino)
 *   → ANCIENT (reverent slow) → ETERNAL (final breath)
 *
 * Transitions: 3-6 frame hard cuts. No smooth fades. Flash frames embedded in scenes.
 */
import React from "react";
import { AbsoluteFill } from "remotion";
import {
  TransitionSeries,
  linearTiming,
  springTiming,
} from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";

import { S01_Hook } from "../scenes/S01_Hook";
import { S02_Problem } from "../scenes/S02_Problem";
import { S03_Pipeline } from "../scenes/S03_Pipeline";
import { S04_AgentNegotiation } from "../scenes/S04_AgentNegotiation";
import { S05_Evidence } from "../scenes/S05_Evidence";
import { S06_Dashboard } from "../scenes/S06_Dashboard";
import { S07_Stats } from "../scenes/S07_Stats";
import { S08_CTA } from "../scenes/S08_CTA";
import { COLORS } from "../lib";

export const PCCDemo: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#080b16" }}>
      <TransitionSeries>
        {/* S01: VOID — Cold open. Black → code types → flash */}
        <TransitionSeries.Sequence durationInFrames={120}>
          <S01_Hook />
        </TransitionSeries.Sequence>

        {/* HARD CUT — 3 frames, wipe right (aggressive) */}
        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 3 })}
          presentation={wipe({ direction: "from-left" })}
        />

        {/* S02: IMPACT — PCC slams in. Discord line. Fast subtitle. */}
        <TransitionSeries.Sequence durationInFrames={390}>
          <S02_Problem />
        </TransitionSeries.Sequence>

        {/* HARD CUT — 4 frames, fade (flash is embedded in S02's final frames) */}
        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 4 })}
          presentation={fade()}
        />

        {/* S03: FRACTURE — Rapid-fire OLD vs NEW alternating cuts */}
        <TransitionSeries.Sequence durationInFrames={510}>
          <S03_Pipeline />
        </TransitionSeries.Sequence>

        {/* HARD CUT — 4 frames, wipe (break energy) */}
        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 4 })}
          presentation={wipe({ direction: "from-right" })}
        />

        {/* S04: CIRCUIT — Pipeline as living circuit. Fast stagger. Light pulse. */}
        <TransitionSeries.Sequence durationInFrames={870}>
          <S04_AgentNegotiation />
        </TransitionSeries.Sequence>

        {/* HARD CUT — 6 frames (slightly longer breath before arena) */}
        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 6 })}
          presentation={fade()}
        />

        {/* S05: ARENA — Terminal bidding war. Fast typing. Discord flicker. */}
        <TransitionSeries.Sequence durationInFrames={570}>
          <S05_Evidence />
        </TransitionSeries.Sequence>

        {/* HARD CUT — 4 frames */}
        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 4 })}
          presentation={fade()}
        />

        {/* S06: CASCADE — Evidence domino fall. Discord flash on escrow. */}
        <TransitionSeries.Sequence durationInFrames={540}>
          <S06_Dashboard />
        </TransitionSeries.Sequence>

        {/* SLOW TRANSITION — 12 frames. The tempo SHIFTS. Deliberate breath. */}
        <TransitionSeries.Transition
          timing={springTiming({ config: { damping: 200 }, durationInFrames: 12 })}
          presentation={fade()}
        />

        {/* S07: ANCIENT — SLOW. Reverent. Giant type. Code background. Stats breathe. */}
        <TransitionSeries.Sequence durationInFrames={750}>
          <S07_Stats />
        </TransitionSeries.Sequence>

        {/* HARD CUT — 6 frames back to intensity for the close */}
        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 6 })}
          presentation={fade()}
        />

        {/* S08: ETERNAL — 200px PCC breathing. Sponsors. URL. Final dim to black. */}
        <TransitionSeries.Sequence durationInFrames={490}>
          <S08_CTA />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  );
};

export default PCCDemo;
