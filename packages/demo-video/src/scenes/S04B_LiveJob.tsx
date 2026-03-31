/**
 * S04B_LiveJob — Centerpiece (1140 frames / 38s)
 *
 * 5 beats:
 *   Beat 1 (0-240): A2A intent negotiation
 *   Beat 2 (240-480): OT-2 executing
 *   Beat 3 (480-720): Evidence archived (Storacha CID)
 *   Beat 4 (720-900): Settlement math
 *   Beat 5 (900-1100): Verification stack (Storacha, Lit, Starknet)
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
import { typewriterChars } from "../lib/animations";

/* ─── Beat 1: A2A Intent Bus (0-240) ─────────────────────────────────── */
const Beat1: React.FC = () => {
  const frame = useCurrentFrame();

  const intents = [
    { at: 24, text: "UserAgent -> BrokerAgent: CAPABILITY_QUERY", sub: "{ type: 'hplc', assurance: 2, budget: 500 }", color: C.accent2 },
    { at: 72, text: "BrokerAgent -> KernelAgent: JOB_OFFER", sub: "{ kernel_id: 'krn_8f2a', price: 487.50, tier: 2 }", color: C.accent2 },
    { at: 120, text: "KernelAgent -> BrokerAgent: JOB_ACCEPTED", sub: "{ escrow: '0x9e81...454', bond_posted: true }", color: C.accent1 },
    { at: 168, text: "KernelAgent -> UserAgent: EXECUTION_STARTED", sub: "{ scope_id: 'scp_2a9', class: 'SAFE_CONTROL' }", color: C.accent1 },
  ];

  return (
    <SafeFrame gap={32}>
      <Reveal at={0} type="slam">
        <T font={F.swiss} size={SIZE.subtitle} color={C.fg} weight={700} uppercase>
          AGENT NEGOTIATION
        </T>
      </Reveal>

      <Panel bg={C.surface} border={`1px solid ${C.border}`} padding={24}>
        <VStack gap={12}>
          {intents.map((intent, i) => {
            if (frame < intent.at) return null;
            const chars = typewriterChars(frame, intent.at, intent.text.length / 22, intent.text.length);
            return (
              <VStack key={i} gap={4}>
                <T font={F.brutalist} size={SIZE.label} color={intent.color}>
                  {intent.text.slice(0, chars)}
                  {chars < intent.text.length ? "\u2588" : ""}
                </T>
                {chars >= intent.text.length && (
                  <T font={F.brutalist} size={SIZE.label} color={C.muted}>
                    {intent.sub}
                  </T>
                )}
              </VStack>
            );
          })}
        </VStack>
      </Panel>

      <Spacer flex={1} />

      <Reveal at={180}>
        <T font={F.swiss} size={SIZE.body} color={C.accent2}>
          34 typed intents. Not chat. Not HTTP.
        </T>
      </Reveal>
    </SafeFrame>
  );
};

/* ─── Beat 2: OT-2 Executing (240-480) ───────────────────────────────── */
const Beat2: React.FC = () => {
  return (
    <SafeFrame justify="flex-end" gap={24}>
      <Reveal at={0} type="slam">
        <T font={F.monument} size={SIZE.subtitle} color={C.fg} weight={700} uppercase>
          EXECUTING
        </T>
      </Reveal>

      <Panel bg={C.surface} border={`1px solid ${C.accent1}`} glow={C.glow1} padding={24}>
        <VStack gap={12}>
          <T font={F.brutalist} size={SIZE.label} color={C.accent1}>
            OT-2 liquid transfer in progress
          </T>
          <T font={F.brutalist} size={SIZE.label} color={C.muted}>
            sensor telemetry | ECIES encrypted | hash-chained
          </T>
        </VStack>
      </Panel>

      <Spacer flex={1} />

      <Reveal at={30}>
        <T font={F.express} size={SIZE.body} color={C.fg} weight={300}>
          The kernel executes. Evidence accumulates.
        </T>
      </Reveal>
    </SafeFrame>
  );
};

/* ─── Beat 3: Evidence Archived (480-720) ─────────────────────────────── */
const Beat3: React.FC = () => {
  return (
    <SafeFrame gap={32}>
      <Reveal at={0} type="slam">
        <T font={F.swiss} size={SIZE.subtitle} color={C.fg} weight={700} uppercase>
          EVIDENCE ARCHIVED
        </T>
      </Reveal>

      <Reveal at={30} type="slam">
        <T font={F.brutalist} size={SIZE.subtitle} color={C.accent1} weight={700}>
          bafybeig7...xq7r4
        </T>
      </Reveal>

      <Reveal at={50}>
        <T font={F.swiss} size={SIZE.label} color={C.muted}>
          Storacha / pcc-evidence space
        </T>
      </Reveal>

      <Reveal at={90}>
        <T font={F.express} size={SIZE.body} color={C.fg}>
          Any verifier. No gateway required.
        </T>
      </Reveal>

      <Reveal at={120}>
        <T font={F.brutalist} size={SIZE.label} color={C.muted}>
          Tier-2 assurance | ECIES encrypted | hash-chained evidence log
        </T>
      </Reveal>
    </SafeFrame>
  );
};

/* ─── Beat 4: Settlement Math (720-900) ───────────────────────────────── */
const Beat4: React.FC = () => {
  return (
    <SafeFrame gap={32}>
      <Reveal at={0} type="slam">
        <T font={F.swiss} size={SIZE.subtitle} color={C.fg} weight={700} uppercase>
          SETTLEMENT
        </T>
      </Reveal>

      <HStack gap={32} align="stretch">
        {/* Operator Bond */}
        <Reveal at={30}>
          <Panel flex={1} bg={C.surface} border={`2px solid ${C.gold}`} padding={24}>
            <VStack gap={8}>
              <T font={F.swiss} size={SIZE.label} color={C.fg} weight={600}>
                Operator Bond
              </T>
              <T font={F.brutalist} size={SIZE.label} color={C.muted}>
                posted upfront / slashable
              </T>
            </VStack>
          </Panel>
        </Reveal>

        {/* Buyer Stake */}
        <Reveal at={48}>
          <Panel flex={1} bg={C.surface} border={`2px solid ${C.gold}`} padding={24}>
            <VStack gap={8}>
              <T font={F.swiss} size={SIZE.label} color={C.fg} weight={600}>
                Buyer Stake
              </T>
              <T font={F.brutalist} size={SIZE.label} color={C.muted}>
                locked in escrow / before work
              </T>
            </VStack>
          </Panel>
        </Reveal>

        {/* Evidence Verified */}
        <Reveal at={66}>
          <Panel flex={1} bg={C.surface} border={`2px solid ${C.accent1}`} padding={24}>
            <VStack gap={8}>
              <T font={F.swiss} size={SIZE.label} color={C.fg} weight={600}>
                Evidence Verified
              </T>
              <T font={F.brutalist} size={SIZE.label} color={C.muted}>
                tier met / auto-release
              </T>
            </VStack>
          </Panel>
        </Reveal>
      </HStack>

      <Spacer height={24} />

      {/* Value message */}
      <Reveal at={120}>
        <T font={F.express} size={SIZE.body} color={C.accent1}>
          Operators keep the value they generate.
        </T>
      </Reveal>
    </SafeFrame>
  );
};

/* ─── Beat 5: Architecture Acknowledgment (900-1100) ──────────────────── */
const Beat5: React.FC = () => {
  return (
    <SafeFrame gap={24}>
      <Reveal at={0} type="slam">
        <T font={F.monument} size={SIZE.subtitle} color={C.fg} weight={700} uppercase tracking="0.04em">
          THE SOVEREIGN STACK
        </T>
      </Reveal>

      {/* Row 1: Storacha + Lit */}
      <HStack gap={20} align="stretch">
        <Reveal at={12}>
          <Panel flex={1} bg={C.surface} border={`2px solid ${C.accent1}`} glow={C.glow1} padding={20}>
            <VStack gap={10}>
              <T font={F.swiss} size={SIZE.label} color={C.accent1} weight={600}>STORACHA</T>
              <T font={F.brutalist} size={SIZE.label} color={C.accent2}>
                w3up.upload(evidence) → bafy...xq7r
              </T>
              <T font={F.brutalist} size={SIZE.label} color={C.muted}>
                UCAN delegation | pcc-evidence space | LIVE
              </T>
            </VStack>
          </Panel>
        </Reveal>

        <Reveal at={30}>
          <Panel flex={1} bg={C.surface} border={`2px solid ${C.accent2}`} glow={C.glow2} padding={20}>
            <VStack gap={10}>
              <T font={F.swiss} size={SIZE.label} color={C.accent2} weight={600}>LIT PROTOCOL</T>
              <T font={F.brutalist} size={SIZE.label} color={C.accent2}>
                encrypt(bundle, accessConditions)
              </T>
              <T font={F.brutalist} size={SIZE.label} color={C.muted}>
                Chipotle v3 REST | AES-256-GCM | LIVE
              </T>
            </VStack>
          </Panel>
        </Reveal>
      </HStack>

      {/* Row 2: Starknet + Flow */}
      <HStack gap={20} align="stretch">
        <Reveal at={48}>
          <Panel flex={1} bg={C.surface} border={`2px solid ${C.accent1}`} padding={20}>
            <VStack gap={10}>
              <T font={F.swiss} size={SIZE.label} color={C.accent1} weight={600}>STARKNET</T>
              <T font={F.brutalist} size={SIZE.label} color={C.accent2}>
                anchor_proof(hash) → 0x4364...ebcd
              </T>
              <T font={F.brutalist} size={SIZE.label} color={C.muted}>
                ProofRegistry Cairo | Sepolia | LIVE
              </T>
            </VStack>
          </Panel>
        </Reveal>

        <Reveal at={66}>
          <Panel flex={1} bg={C.surface} border={`2px solid ${C.gold}`} padding={20}>
            <VStack gap={10}>
              <T font={F.swiss} size={SIZE.label} color={C.gold} weight={600}>FLOW EVM + NEAR</T>
              <T font={F.brutalist} size={SIZE.label} color={C.accent2}>
                MilestoneEscrow.settle() | 1Click solver
              </T>
              <T font={F.brutalist} size={SIZE.label} color={C.muted}>
                Settlement + cross-chain | LIVE
              </T>
            </VStack>
          </Panel>
        </Reveal>
      </HStack>

      <Reveal at={100}>
        <T font={F.express} size={SIZE.label} color={C.muted} align="center">
          5 sponsor integrations. All verified. All on-chain.
        </T>
      </Reveal>
    </SafeFrame>
  );
};

/* ─── Main Component: Switch between beats by frame ───────────────────── */
export const S04B_LiveJob: React.FC = () => {
  const frame = useCurrentFrame();

  if (frame < 240) return <Beat1 />;
  if (frame < 480) return <Beat2 />;
  if (frame < 720) return <Beat3 />;
  if (frame < 900) return <Beat4 />;
  return <Beat5 />;
};

export default S04B_LiveJob;
