Generate a PCC Job Timeline React component showing milestone progress with evidence and evaluator attestations.

Pattern source: Virtuals ACP Job Dashboard + Pakt escrow payouts

## Component Spec

Generate a `JobTimeline` component in `packages/ui/src/escrow/JobTimeline.tsx` with:

- **Vertical timeline**: Left-aligned dot + line, each milestone is a node
- **Per milestone node**: Status color dot (green=complete, gold=in-progress, gray=pending, red=failed)
- **Milestone content**: Name, escrow amount, evidence CID (IPFSLink), evaluator attestation badge
- **Evidence detail**: Expandable — click to show evidence events, ZK proof status, Bittensor score
- **Challenge window**: If Tier 3, show countdown bar (ChallengeWindowBar)
- **Props**: `milestones: Array<{ id, name, status, amount, evidenceCid?, evaluator?, zkProofStatus, bittensorScore, challengeDeadline? }>`

## Design
- Timeline line: `border-l-2 border-white/[0.06]` with `ml-3 pl-6 space-y-6`
- Dots: 8px circles, status-colored with glow
- Expand/collapse: `motion.div` with `AnimatePresence`
- Use existing: `GlassPanel`, `IPFSLink`, `GlowBadge`, `AmountDisplay`, `ChallengeWindowBar`
