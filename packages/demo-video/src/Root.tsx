import React from "react";
import { Composition, Folder } from "remotion";
import { PCCDemo } from "./compositions/PCCDemo";
import { S01_Proof } from "./scenes/S01_Proof";
import { S02_Problem } from "./scenes/S02_Problem";
import { S03_Architecture } from "./scenes/S03_Architecture";
import { S04_Agents } from "./scenes/S04_Agents";
import { S05_Evidence } from "./scenes/S05_Evidence";
import { S06_Dashboard } from "./scenes/S06_Dashboard";
import { S07_Stats } from "./scenes/S07_Stats";
import { S08_CTA } from "./scenes/S08_CTA";

const FPS = 30;
const W = 1920;
const H = 1080;

export const Root: React.FC = () => (
  <>
    <Folder name="Full">
      <Composition id="PCCDemo" component={PCCDemo} durationInFrames={4050} fps={FPS} width={W} height={H} />
    </Folder>
    <Folder name="Scenes">
      <Composition id="S01-Proof" component={S01_Proof} durationInFrames={360} fps={FPS} width={W} height={H} />
      <Composition id="S02-Problem" component={S02_Problem} durationInFrames={540} fps={FPS} width={W} height={H} />
      <Composition id="S03-Arch" component={S03_Architecture} durationInFrames={600} fps={FPS} width={W} height={H} />
      <Composition id="S04-Agents" component={S04_Agents} durationInFrames={540} fps={FPS} width={W} height={H} />
      <Composition id="S05-Evidence" component={S05_Evidence} durationInFrames={870} fps={FPS} width={W} height={H} />
      <Composition id="S06-Access" component={S06_Dashboard} durationInFrames={450} fps={FPS} width={W} height={H} />
      <Composition id="S07-Scale" component={S07_Stats} durationInFrames={360} fps={FPS} width={W} height={H} />
      <Composition id="S08-Close" component={S08_CTA} durationInFrames={360} fps={FPS} width={W} height={H} />
    </Folder>
  </>
);
