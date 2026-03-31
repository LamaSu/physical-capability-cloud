/**
 * S05B_Implications — Economic Implications (480 frames / 16s)
 * The world-changing effects of making physical work composable and verifiable.
 */
import React from "react";
import {
  C, F, SIZE, SafeFrame, VStack, Panel, T, Reveal, Spacer,
} from "../lib";

export const S05B_Implications: React.FC = () => (
  <SafeFrame justify="center" gap={36}>
    <Reveal at={0} type="slam">
      <T font={F.monument} size={SIZE.title} color={C.fg} weight={700} uppercase tracking="0.04em">
        WHAT THIS MEANS
      </T>
    </Reveal>

    <Reveal at={30}>
      <T font={F.express} size={SIZE.body} color={C.accent1}>
        Every physical supply chain becomes semi-digital. From concept to delivery, auditable and composable.
      </T>
    </Reveal>

    <VStack gap={24}>
      <Reveal at={70}>
        <Panel bg={C.surface} border={`1px solid ${C.border}`} padding={32}>
          <VStack gap={8}>
            <T font={F.swiss} size={SIZE.body} color={C.fg} weight={600}>
              Open science becomes economically viable.
            </T>
            <T font={F.express} size={SIZE.label} color={C.muted}>
              When every step has cryptographic proof, IP is protected by math — not lawyers. Researchers share methods without losing credit.
            </T>
          </VStack>
        </Panel>
      </Reveal>

      <Reveal at={130}>
        <Panel bg={C.surface} border={`1px solid ${C.border}`} padding={32}>
          <VStack gap={8}>
            <T font={F.swiss} size={SIZE.body} color={C.fg} weight={600}>
              Black markets lose their economic advantage.
            </T>
            <T font={F.express} size={SIZE.label} color={C.muted}>
              $467B in counterfeit goods exist because supply chains are opaque. Transparent evidence chains remove the shadows they hide in.
            </T>
          </VStack>
        </Panel>
      </Reveal>

      <Reveal at={190}>
        <Panel bg={C.surface} border={`1px solid ${C.border}`} padding={32}>
          <VStack gap={8}>
            <T font={F.swiss} size={SIZE.body} color={C.fg} weight={600}>
              Operators earn what they're worth.
            </T>
            <T font={F.express} size={SIZE.label} color={C.muted}>
              No platform extracting 35–65%. Physical capability priced by open markets, settled automatically, value flows directly to the people doing the work.
            </T>
          </VStack>
        </Panel>
      </Reveal>
    </VStack>

    <Reveal at={320}>
      <T font={F.express} size={SIZE.body} color={C.muted}>
        This is infrastructure for the next century.
      </T>
    </Reveal>
  </SafeFrame>
);

export default S05B_Implications;
