/**
 * S07_Ecosystem — Sponsor Stack (390 frames / 13s)
 *
 * 6 sponsor cards with honest tier status.
 * Real sponsors (Storacha, Flow, NEAR) get accent1.
 * Architecture sponsors (Lit, Starknet) get muted.
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
} from "../lib";
import { SPONSORS } from "../lib/data";

interface SponsorRow {
  name: string;
  status: string;
  live: boolean;
  at: number;
}

const SPONSOR_ROWS: SponsorRow[] = [
  { name: "Storacha", status: "UCAN delegation -- live evidence uploads", live: true, at: 24 },
  { name: "Lit Protocol", status: "lit-node-client v7 -- encryption module wired", live: false, at: 42 },
  { name: "Starknet", status: "starknet.js -- ZK anchoring architecture", live: false, at: 60 },
  { name: "Flow EVM", status: "MilestoneEscrow deployed -- FlowScan-verifiable", live: true, at: 78 },
  { name: "NEAR", status: "1Click solver -- cross-chain intent routing", live: true, at: 96 },
  { name: "Impulse AI", status: "complementary open infrastructure", live: false, at: 114 },
];

export const S07_Ecosystem: React.FC = () => {
  return (
    <SafeFrame gap={32}>
      {/* Title */}
      <Reveal at={0} type="slam">
        <T
          font={F.monument}
          size={SIZE.title}
          color={C.fg}
          weight={700}
          uppercase
          tracking="0.06em"
        >
          ECOSYSTEM
        </T>
      </Reveal>

      {/* Sponsor rows */}
      <VStack gap={16}>
        {SPONSOR_ROWS.map((s) => (
          <Reveal key={s.name} at={s.at} type="slam">
            <Panel
              bg={C.surface}
              border={`1px solid ${s.live ? C.accent1 : C.border}`}
              glow={s.live ? C.glow1 : undefined}
              padding={20}
            >
              <HStack gap={24} align="center">
                <T
                  font={F.swiss}
                  size={SIZE.body}
                  color={C.fg}
                  weight={600}
                  style={{ flex: 0, minWidth: 200, width: "auto" }}
                >
                  {s.name}
                </T>
                <T
                  font={F.brutalist}
                  size={SIZE.label}
                  color={s.live ? C.accent1 : C.muted}
                  style={{ flex: 1 }}
                >
                  {s.status}
                </T>
              </HStack>
            </Panel>
          </Reveal>
        ))}
      </VStack>

      <Spacer flex={1} />

      {/* Footer */}
      <Reveal at={240}>
        <T font={F.swiss} size={SIZE.label} color={C.muted} align="center">
          Built on Protocol Labs infrastructure.
        </T>
      </Reveal>
    </SafeFrame>
  );
};

export default S07_Ecosystem;
