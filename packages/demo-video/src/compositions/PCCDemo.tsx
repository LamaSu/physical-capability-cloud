import React from "react";
import { AbsoluteFill } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { wipe } from "@remotion/transitions/wipe";

import { S01_Proof } from "../scenes/S01_Proof";
import { S02_Problem } from "../scenes/S02_Problem";
import { S03_Architecture } from "../scenes/S03_Architecture";
import { S04_Agents } from "../scenes/S04_Agents";
import { S05_Evidence } from "../scenes/S05_Evidence";
import { S06_Dashboard } from "../scenes/S06_Dashboard";
import { S07_Stats } from "../scenes/S07_Stats";
import { S08_CTA } from "../scenes/S08_CTA";

export const PCCDemo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: "#050a0e" }}>
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={600}>
        <S01_Proof />
      </TransitionSeries.Sequence>

      <TransitionSeries.Transition timing={linearTiming({ durationInFrames: 4 })} presentation={wipe({ direction: "from-left" })} />

      <TransitionSeries.Sequence durationInFrames={540}>
        <S02_Problem />
      </TransitionSeries.Sequence>

      <TransitionSeries.Transition timing={linearTiming({ durationInFrames: 4 })} presentation={fade()} />

      <TransitionSeries.Sequence durationInFrames={600}>
        <S03_Architecture />
      </TransitionSeries.Sequence>

      <TransitionSeries.Transition timing={linearTiming({ durationInFrames: 4 })} presentation={wipe({ direction: "from-right" })} />

      <TransitionSeries.Sequence durationInFrames={540}>
        <S04_Agents />
      </TransitionSeries.Sequence>

      <TransitionSeries.Transition timing={linearTiming({ durationInFrames: 6 })} presentation={fade()} />

      <TransitionSeries.Sequence durationInFrames={1200}>
        <S05_Evidence />
      </TransitionSeries.Sequence>

      <TransitionSeries.Transition timing={linearTiming({ durationInFrames: 4 })} presentation={fade()} />

      <TransitionSeries.Sequence durationInFrames={450}>
        <S06_Dashboard />
      </TransitionSeries.Sequence>

      <TransitionSeries.Transition timing={linearTiming({ durationInFrames: 6 })} presentation={wipe({ direction: "from-left" })} />

      <TransitionSeries.Sequence durationInFrames={360}>
        <S07_Stats />
      </TransitionSeries.Sequence>

      <TransitionSeries.Transition timing={linearTiming({ durationInFrames: 6 })} presentation={fade()} />

      <TransitionSeries.Sequence durationInFrames={360}>
        <S08_CTA />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  </AbsoluteFill>
);

export default PCCDemo;
