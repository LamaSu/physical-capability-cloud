/**
 * S05_EmergingMarkets — Access (420 frames / 14s)
 * People who were locked out can now participate.
 */
import React from "react";
import {
  C, F, SIZE, SafeFrame, VStack, HStack, Panel, T, Reveal, Spacer,
} from "../lib";

export const S05_EmergingMarkets: React.FC = () => (
  <SafeFrame justify="center" gap={36}>
    <Reveal at={0} type="slam">
      <T font={F.monument} size={SIZE.title} color={C.fg} weight={700} uppercase tracking="0.04em">
        ACCESS CHANGES EVERYTHING
      </T>
    </Reveal>

    <Reveal at={30}>
      <T font={F.express} size={SIZE.body} color={C.muted}>
        Talent is everywhere. Equipment access is not. Until now.
      </T>
    </Reveal>

    <HStack gap={32} align="stretch">
      <Panel flex={1} padding={36} bg={C.surface} border={`1px solid ${C.border}`}>
        <VStack gap={16} align="center">
          <Reveal at={60}>
            <T font={F.brutalist} size={72} color={C.accent1} weight={700} align="center">34</T>
            <T font={F.swiss} size={SIZE.label} color={C.muted} align="center" uppercase tracking="0.08em">Countries connected</T>
          </Reveal>
        </VStack>
      </Panel>

      <Panel flex={1} padding={36} bg={C.surface} border={`1px solid ${C.border}`}>
        <VStack gap={16} align="center">
          <Reveal at={80}>
            <T font={F.brutalist} size={72} color={C.accent2} weight={700} align="center">30 min</T>
            <T font={F.swiss} size={SIZE.label} color={C.muted} align="center" uppercase tracking="0.08em">Zero to live operator</T>
          </Reveal>
        </VStack>
      </Panel>
    </HStack>

    <Reveal at={160}>
      <T font={F.express} size={SIZE.body} color={C.fg}>
        A student in Lagos connects to a biolab in Singapore. A maker in Mumbai finds a CNC shop in Detroit. No broker. No institutional affiliation.
      </T>
    </Reveal>

    <Reveal at={280}>
      <T font={F.express} size={SIZE.body} color={C.accent1}>
        The iGEM team grows their fluorescent neurons. They publish. They form a company. It could not have existed before PCC.
      </T>
    </Reveal>
  </SafeFrame>
);

export default S05_EmergingMarkets;
