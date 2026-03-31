/**
 * S02_Problem — The Value Extraction Problem (480 frames / 16s)
 * NOT a side-by-side comparison. A sequence: the problem builds, then the shift.
 * Discord use #1: "No proof it ever happened."
 */
import React from "react";
import {
  C, F, SIZE, SafeFrame, VStack, Panel, T, Reveal, Spacer,
} from "../lib";

export const S02_Problem: React.FC = () => (
  <SafeFrame justify="center" gap={40}>
    {/* The problem — builds piece by piece */}
    <Reveal at={0} type="slam">
      <T font={F.monument} size={SIZE.title} color={C.fg} weight={700}>
        Where does the value go?
      </T>
    </Reveal>

    <Reveal at={30}>
      <T font={F.express} size={SIZE.body} color={C.muted}>
        An iGEM team wants to grow fluorescent neurons. They have the protocol. They have the talent. They don't have a lab.
      </T>
    </Reveal>

    <Reveal at={50}>
      <T font={F.express} size={SIZE.body} color={C.muted}>
        Building a wet lab: $500K–$2M. A CDMO contract for small-batch work: $50K minimum. Or 6 weeks of cold emails to beg for access.
      </T>
    </Reveal>

    <Panel bg={C.surface} border={`1px solid ${C.border}`} padding={36}>
      <VStack gap={20}>
        <Reveal at={90}>
          <T font={F.brutalist} size={SIZE.body} color={C.gold}>
            Uber takes 40% from every driver.
          </T>
        </Reveal>
        <Reveal at={110}>
          <T font={F.brutalist} size={SIZE.body} color={C.gold}>
            Xometry takes 34.5% from every manufacturer.
          </T>
        </Reveal>
        <Reveal at={130}>
          <T font={F.brutalist} size={SIZE.body} color={C.gold}>
            $9B in NIH grants → admin overhead, not research.
          </T>
        </Reveal>
      </VStack>
    </Panel>

    {/* Discord #1 — the emotional hit */}
    <Reveal at={180} type="slam">
      <T font={F.swiss} size={SIZE.subtitle} color={C.discord} weight={600}>
        35–65% of value. Gone. Before work even starts.
      </T>
    </Reveal>

    {/* The shift */}
    <Reveal at={280}>
      <T font={F.express} size={SIZE.body} color={C.accent1}>
        What if operators kept what they earned?
      </T>
    </Reveal>
  </SafeFrame>
);

export default S02_Problem;
