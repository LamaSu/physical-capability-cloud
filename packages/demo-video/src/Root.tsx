/**
 * Root — Remotion composition registry for PCC Demo Video
 *
 * Registers:
 *   - PCCDemo (main composition, id: "PCCDemo") — full 152.3s render
 *   - Individual scenes in "Scenes" folder for isolated preview/render
 *
 * Duration calculation (all at 30fps, 1920x1080):
 *   Scene frames:       600+480+540+480+1140+420+330+390+300 = 4680
 *   Transition frames:  18+6+18+4+18+4+24+18                =  110
 *   PCCDemo total:      4680 - 110                           = 4570
 */

import React from "react";
import { Composition, Folder } from "remotion";

import { PCCDemo } from "./compositions/PCCDemo";
import { S01_Proof } from "./scenes/S01_Proof";
import { S02_Problem } from "./scenes/S02_Problem";
import { S03_Architecture } from "./scenes/S03_Architecture";
import { S04B_LiveJob } from "./scenes/S04B_LiveJob";
import { S05_EmergingMarkets } from "./scenes/S05_EmergingMarkets";
import { S05B_Implications } from "./scenes/S05B_Implications";
import { S06_ScaleProof } from "./scenes/S06_ScaleProof";
import { S07_Ecosystem } from "./scenes/S07_Ecosystem";
import { S08_Close } from "./scenes/S08_Close";

const FPS = 30;
const W = 1920;
const H = 1080;

// Scene durations from storyboard (frames at 30fps)
const S01_FRAMES = 600;
const S02_FRAMES = 480;
const S03_FRAMES = 720;
const S04B_FRAMES = 1140;
const S05_FRAMES = 420;
const S06_FRAMES = 330;
const S07_FRAMES = 390;
const S08_FRAMES = 300;

// Transition durations (see PCCDemo.tsx for storyboard source)
const T_S01_S02 = 18;
const T_S02_S03 = 6;
const T_S03_S04B = 6;
const T_S04B_S05 = 18;
const T_S05_S06 = 4;
const T_S06_S07 = 24; // cross-dissolve — only dissolve in video
const T_S07_S08 = 18;

const S05B_FRAMES = 480;
const T_S05_S05B = 6;
const T_S05B_S06 = 4;

const TOTAL_SCENE_FRAMES =
  S01_FRAMES +
  S02_FRAMES +
  S03_FRAMES +
  S04B_FRAMES +
  S05_FRAMES +
  S05B_FRAMES +
  S06_FRAMES +
  S07_FRAMES +
  S08_FRAMES;

const TOTAL_TRANSITION_FRAMES =
  T_S01_S02 +
  T_S02_S03 +
  T_S03_S04B +
  T_S04B_S05 +
  T_S05_S05B +
  T_S05B_S06 +
  T_S06_S07 +
  T_S07_S08;

// In TransitionSeries, each transition overlaps with adjacent scenes,
// so total duration = sum(scene frames) - sum(transition frames)
const PCCDE_TOTAL_FRAMES = TOTAL_SCENE_FRAMES - TOTAL_TRANSITION_FRAMES;

export const Root: React.FC = () => (
  <>
    {/* Main composition — full demo video */}
    <Composition
      id="PCCDemo"
      component={PCCDemo}
      durationInFrames={PCCDE_TOTAL_FRAMES}
      fps={FPS}
      width={W}
      height={H}
    />

    {/* Individual scenes for isolated preview and test renders */}
    <Folder name="Scenes">
      <Composition
        id="S01-Proof"
        component={S01_Proof}
        durationInFrames={S01_FRAMES}
        fps={FPS}
        width={W}
        height={H}
      />
      <Composition
        id="S02-Problem"
        component={S02_Problem}
        durationInFrames={S02_FRAMES}
        fps={FPS}
        width={W}
        height={H}
      />
      <Composition
        id="S03-Architecture-Onboarding"
        component={S03_Architecture}
        durationInFrames={S03_FRAMES}
        fps={FPS}
        width={W}
        height={H}
      />
      <Composition
        id="S04B-LiveJob"
        component={S04B_LiveJob}
        durationInFrames={S04B_FRAMES}
        fps={FPS}
        width={W}
        height={H}
      />
      <Composition
        id="S05-EmergingMarkets"
        component={S05_EmergingMarkets}
        durationInFrames={S05_FRAMES}
        fps={FPS}
        width={W}
        height={H}
      />
      <Composition
        id="S05B-Implications"
        component={S05B_Implications}
        durationInFrames={S05B_FRAMES}
        fps={FPS}
        width={W}
        height={H}
      />
      <Composition
        id="S06-ScaleProof"
        component={S06_ScaleProof}
        durationInFrames={S06_FRAMES}
        fps={FPS}
        width={W}
        height={H}
      />
      <Composition
        id="S07-Ecosystem"
        component={S07_Ecosystem}
        durationInFrames={S07_FRAMES}
        fps={FPS}
        width={W}
        height={H}
      />
      <Composition
        id="S08-Close"
        component={S08_Close}
        durationInFrames={S08_FRAMES}
        fps={FPS}
        width={W}
        height={H}
      />
    </Folder>
  </>
);
