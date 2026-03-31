/**
 * S03_Architecture — The Protocol + Onboarding (720 frames / 24s)
 *
 * Part 1 (0-360): 6-phase protocol flow
 * Part 2 (360-720): Quick terminal showing pip install → live
 * Discord use #2 at frame 300 (verify→settle line)
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import {
  C, F, SIZE, SafeFrame, VStack, HStack, Panel, T, Reveal, Spacer,
} from "../lib";

const PHASES = [
  { name: "DISCOVER", color: C.accent2 },
  { name: "BID", color: C.gold },
  { name: "ESCROW", color: C.discord },
  { name: "EXECUTE", color: C.accent1 },
  { name: "VERIFY", color: C.accent1 },
  { name: "SETTLE", color: C.gold },
] as const;

const TERM_LINES = [
  { at: 380, text: "$ pip install pcc-node", color: C.fg },
  { at: 410, text: "  Detecting hardware... OT-2 on USB0", color: C.accent2 },
  { at: 440, text: "  Ed25519 keypair generated", color: C.muted },
  { at: 460, text: "  Kernel registered. Live on DHT.", color: C.accent1 },
] as const;

export const S03_Architecture: React.FC = () => {
  const frame = useCurrentFrame();

  const showPart1 = frame < 400;
  const showPart2 = frame >= 340;

  return (
    <SafeFrame justify="center" gap={36}>
      {/* Part 1: Protocol flow */}
      {showPart1 && (
        <>
          <Reveal at={0} type="slam">
            <T font={F.monument} size={SIZE.title} color={C.fg} weight={700} uppercase tracking="0.04em" align="center">
              THE PROTOCOL
            </T>
          </Reveal>

          {/* Row 1: DISCOVER BID ESCROW */}
          <HStack gap={16} align="stretch" justify="center">
            {PHASES.slice(0, 3).map((phase, i) => (
              <Reveal key={phase.name} at={30 + i * 15} type="slam">
                <Panel flex={1} bg={C.surface} border={`2px solid ${phase.color}`} padding={20}>
                  <T font={F.swiss} size={SIZE.label} color={phase.color} weight={600} align="center">
                    {phase.name}
                  </T>
                </Panel>
              </Reveal>
            ))}
          </HStack>
          {/* Row 2: EXECUTE VERIFY SETTLE */}
          <HStack gap={16} align="stretch" justify="center">
            {PHASES.slice(3).map((phase, i) => (
              <Reveal key={phase.name} at={75 + i * 15} type="slam">
                <Panel flex={1} bg={C.surface} border={`2px solid ${phase.color}`} padding={20}>
                  <T font={F.swiss} size={SIZE.label} color={phase.color} weight={600} align="center">
                    {phase.name}
                  </T>
                </Panel>
              </Reveal>
            ))}
          </HStack>

          <Reveal at={180}>
            <T font={F.swiss} size={SIZE.label} color={C.muted} align="center">
              Designed for decentralization. No single point of failure.
            </T>
          </Reveal>

          <Reveal at={250}>
            <T font={F.swiss} size={SIZE.label} color={C.muted} align="center">
              Storacha · Lit Protocol · Starknet · Flow · NEAR
            </T>
          </Reveal>
        </>
      )}

      {/* Part 2: Quick onboarding terminal */}
      {showPart2 && (
        <>
          <Reveal at={340} type="slam">
            <T font={F.monument} size={SIZE.subtitle} color={C.accent2} weight={700} uppercase>
              GET ON THE NETWORK
            </T>
          </Reveal>

          <Panel bg={C.surface} border={`1px solid ${C.border}`} padding={28}>
            <VStack gap={12}>
              {TERM_LINES.map((line, i) => (
                <Reveal key={i} at={line.at}>
                  <T font={F.brutalist} size={SIZE.label} color={line.color}>{line.text}</T>
                </Reveal>
              ))}
            </VStack>
          </Panel>

          <Reveal at={500}>
            <T font={F.express} size={SIZE.body} color={C.accent1}>
              Minutes from install to discoverable by any agent on Earth.
            </T>
          </Reveal>
        </>
      )}
    </SafeFrame>
  );
};

export default S03_Architecture;
