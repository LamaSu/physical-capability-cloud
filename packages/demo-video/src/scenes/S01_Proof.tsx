/**
 * S01_Proof — Cold Open (600 frames / 20s)
 *
 * Terminal lines type in, then brand slam.
 * Narrative: Opens on proof of work, not explanation.
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import {
  C,
  F,
  SIZE,
  SafeFrame,
  VStack,
  HStack,
  Panel,
  T,
  Reveal,
  Spacer,
  smooth,
  slam,
  fadeUp,
  countTo,
} from "../lib";
import { typewriterChars } from "../lib/animations";

/** Typewriter text: renders chars up to current frame */
const Typewriter: React.FC<{
  text: string;
  startFrame: number;
  duration: number;
  font: string;
  size: number;
  color: string;
}> = ({ text, startFrame, duration, font, size, color }) => {
  const frame = useCurrentFrame();
  const chars = typewriterChars(frame, startFrame, text.length / duration, text.length);
  const visible = text.slice(0, chars);
  const showCursor = frame >= startFrame && chars < text.length;

  return (
    <T font={font} size={size} color={color} weight={400}>
      {visible}
      {showCursor ? "\u2588" : ""}
    </T>
  );
};

export const S01_Proof: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <SafeFrame gap={40} justify="center">
      {/* Terminal line 1 */}
      <Reveal at={15}>
        <Typewriter
          text="kernel-agent: job_accepted -- OT-2 liquid transfer protocol v2"
          startFrame={15}
          duration={40}
          font={F.brutalist}
          size={SIZE.label}
          color={C.accent1}
        />
      </Reveal>

      {/* Terminal line 2 */}
      <Reveal at={60}>
        <Typewriter
          text="evidence: archived -- bafy...q7r4 | tier-2 | encrypted telemetry"
          startFrame={60}
          duration={35}
          font={F.brutalist}
          size={SIZE.label}
          color={C.accent2}
        />
      </Reveal>

      <Spacer height={40} />

      {/* Statement 1 */}
      <Reveal at={120} type="slam">
        <T font={F.express} size={SIZE.body} color={C.fg} weight={400}>
          An AI agent submits a job.
        </T>
      </Reveal>

      {/* Statement 2 */}
      <Reveal at={150}>
        <T font={F.express} size={SIZE.body} color={C.muted} weight={300}>
          The world will never be the same.
        </T>
      </Reveal>

      <Spacer height={40} />

      {/* Brand slam — tighter timing */}
      <Reveal at={180} type="slam">
        <T
          font={F.monument}
          size={SIZE.title}
          color={C.fg}
          weight={700}
          uppercase
          tracking="0.08em"
        >
          PHYSICAL CAPABILITY CLOUD
        </T>
      </Reveal>

      {/* URL */}
      <Reveal at={360}>
        <T font={F.swiss} size={SIZE.label} color={C.accent1}>
          capability.network
        </T>
      </Reveal>
    </SafeFrame>
  );
};

export default S01_Proof;
