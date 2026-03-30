import React from "react";
import { Composition, Folder } from "remotion";
import { PCCDemo } from "./compositions/PCCDemo";
import { S01_Hook } from "./scenes/S01_Hook";
import { S02_Problem } from "./scenes/S02_Problem";
import { S03_Pipeline } from "./scenes/S03_Pipeline";
import { S04_AgentNegotiation } from "./scenes/S04_AgentNegotiation";
import { S05_Evidence } from "./scenes/S05_Evidence";
import { S06_Dashboard } from "./scenes/S06_Dashboard";
import { S07_Stats } from "./scenes/S07_Stats";
import { S08_CTA } from "./scenes/S08_CTA";

const FPS = 30;
const W = 1920;
const H = 1080;

/**
 * Scene durations — "DIES IRAE" cut
 * Total with transitions: 4200 frames (140s @ 30fps)
 *
 * ACT I — THE INVOCATION
 *   S01 Void:     120f (4s)  — cold open, code types, flash
 *   S02 Impact:   390f (13s) — PCC slams, discord line, fast subtitle
 *
 * ACT II — THE MACHINE
 *   S03 Fracture: 510f (17s) — rapid-fire old vs new cuts, fee slam
 *   S04 Circuit:  870f (29s) — pipeline hero, fast stagger, light pulse
 *   S05 Arena:    570f (19s) — terminal war, fast typing, discord flicker
 *   S06 Cascade:  540f (18s) — evidence domino, discord flash
 *
 * ACT III — THE REVELATION
 *   S07 Ancient:  750f (25s) — SLOW. reverent. giant type. stats breathe.
 *   S08 Eternal:  490f (16s) — 200px PCC breathing. sponsors. final black.
 */
const SCENES = {
  S01: 120,
  S02: 390,
  S03: 510,
  S04: 870,
  S05: 570,
  S06: 540,
  S07: 750,
  S08: 490,
} as const;

export const Root: React.FC = () => {
  return (
    <>
      <Folder name="Full-Demo">
        <Composition
          id="PCCDemo-Full"
          component={PCCDemo}
          durationInFrames={4200}
          fps={FPS}
          width={W}
          height={H}
        />
      </Folder>
      <Folder name="Scenes">
        <Composition
          id="S01-Void"
          component={S01_Hook}
          durationInFrames={SCENES.S01}
          fps={FPS}
          width={W}
          height={H}
        />
        <Composition
          id="S02-Impact"
          component={S02_Problem}
          durationInFrames={SCENES.S02}
          fps={FPS}
          width={W}
          height={H}
        />
        <Composition
          id="S03-Fracture"
          component={S03_Pipeline}
          durationInFrames={SCENES.S03}
          fps={FPS}
          width={W}
          height={H}
        />
        <Composition
          id="S04-Circuit"
          component={S04_AgentNegotiation}
          durationInFrames={SCENES.S04}
          fps={FPS}
          width={W}
          height={H}
        />
        <Composition
          id="S05-Arena"
          component={S05_Evidence}
          durationInFrames={SCENES.S05}
          fps={FPS}
          width={W}
          height={H}
        />
        <Composition
          id="S06-Cascade"
          component={S06_Dashboard}
          durationInFrames={SCENES.S06}
          fps={FPS}
          width={W}
          height={H}
        />
        <Composition
          id="S07-Ancient"
          component={S07_Stats}
          durationInFrames={SCENES.S07}
          fps={FPS}
          width={W}
          height={H}
        />
        <Composition
          id="S08-Eternal"
          component={S08_CTA}
          durationInFrames={SCENES.S08}
          fps={FPS}
          width={W}
          height={H}
        />
      </Folder>
    </>
  );
};
