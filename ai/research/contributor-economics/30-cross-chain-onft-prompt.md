# Cross-Chain `ContributorNFT` Portability — Hydrated Prompt for a Fresh Agent

**Status**: NOT STARTED. This doc is the briefing for whoever picks it up.
**Branch strategy**: NEW BRANCH from `master`, NOT a continuation of
`feat/contributor-economics`. The contributor-economics branch is already
171+ commits ahead and adding L0/CCIP wrapping on top would balloon it
past PR-reviewability.
**Recommended branch name**: `feat/contributor-nft-cross-chain`
**Estimated scope**: 1 implementer week (5-8 working days), audit-blocked
before mainnet broadcast.

---

## Why this exists

The contributor-economics build (shipped on `feat/contributor-economics`)
made a thesis claim: contributors earn across networks via a
sovereign-per-network identity. The actual v1 implementation lives on
whichever EVM chain `ContributorNFT.sol` is deployed to — currently
configured for Base Sepolia in
`C:\Users\globa\pcc-contributor-economics\packages\contracts\script\DeployContributorEconomics.s.sol`.
Contributors on Flow EVM, Sepolia L1, Optimism, or any other chain can't
earn from each other's jobs, which invalidates the multi-network thesis
the whole design was justified against.

Closing this gap is the difference between "ship to one testnet and
declare victory" and "ship the actual design users were promised."

---

## What's already in tree (read these first)

### Research

- `C:\Users\globa\pcc-contributor-economics\ai\research\contributor-economics\04-network-forkability.md`
  (994 lines, scout-networks-delta's landscape report). Especially:
  - §05-06: Optimism Superchain + Cosmos IBC (cross-chain interop models)
  - §09: Cross-chain NFT ownership — LayerZero ONFT, Wormhole, CCIP, CCT
  - §10: Shared registries — ENS for canonical name resolution
  - §11: Message-passing patterns — Chainlink CCIP, LayerZero OApp, Hyperlane
  - §15 + the Recommendation section: the chosen architecture is
    *"multi-chain + cross-chain NFTs + optional per-network treasury"*
    rather than a dedicated app-chain. This work implements that recommendation.

- `C:\Users\globa\pcc-contributor-economics\ai\research\contributor-economics\01-royalty-nft-standards.md`
  §"ERC-6551 TBA" (token-bound accounts) — relevant if each ContributorNFT
  should carry its own per-chain smart wallet, not just an EOA payout
  recipient. v1 just stores wallet addresses; v2 cross-chain may want TBAs.

### Existing contract code

- `C:\Users\globa\pcc-contributor-economics\packages\contracts\src\ContributorNFT.sol`
  — the canonical fresh-mint ERC-721 + ERC-2981. Wraps role + ipId +
  scheduleHash per token. THIS IS WHAT GETS CROSS-CHAIN-WRAPPED.
- `C:\Users\globa\pcc-contributor-economics\packages\contracts\src\RateScheduleRegistry.sol`
  — the immutable per-hash schedule store. Currently lives on one chain;
  **does it need to be cross-chain too?** Open question. If schedules
  are content-addressed, they could be re-published per chain (the hash
  is the same; the storage is per-chain). Cheaper than wrapping every
  schedule registry call.
- `C:\Users\globa\pcc-contributor-economics\packages\contracts\src\MilestoneEscrow.sol`
  — release() is single-chain by design. Cross-chain settlement is
  explicitly out of scope for THIS task.
- `C:\Users\globa\pcc-contributor-economics\packages\contracts\script\DeployContributorEconomics.s.sol`
  — the existing single-chain deploy script. Will need a cross-chain
  variant.

### Spec types

- `C:\Users\globa\pcc-contributor-economics\packages\spec\src\types\story.ts`
  — `StoryIPRegistration` has a `chain` field (`"story" | "story-aeneid"`).
  ContributorNFT may need similar.

### Docs that frame the gap

- `C:\Users\globa\pcc-contributor-economics\docs\CONTRIBUTOR_ECONOMICS.md`
  "Open scope cuts" section — explicitly lists "Cross-chain ContributorNFT
  portability" as a deliberate v1 deferral. Update it on landing.
- `C:\Users\globa\pcc-contributor-economics\ai\research\contributor-economics\99-resume-here.md`
  "Cross-chain `ContributorNFT` portability" subsection.

---

## The decision tree you have to navigate

### Decision 1: Which cross-chain primitive?

Three credible options. Pick one based on the v1 audit recommendations
in scout-networks-delta's report (§09). My read of that section:

| Primitive | Pros | Cons | Fit |
|---|---|---|---|
| **LayerZero ONFT** (v2) | Most adopted cross-chain NFT standard. Battle-tested. ~30 chains supported. Fastest to ship — clear inheritance pattern (extend ONFT721). | Bridge centralization risk (DVN model post-V2 mitigates). Requires LayerZero endpoint deployment per chain. | Likely the right v1 choice |
| **CCIP (Chainlink)** | Stronger decentralization story (DON-based). Backed by Chainlink. Native USDC support useful for the broader settlement layer. | Newer, fewer chains. Heavier integration. | Better long-term but slower to ship |
| **Wormhole NTT** | Native Token Transfers + Wormhole governance. Multi-chain ecosystem. | NFT-specific path is less mature than ONFT. | Skip for v1 |

**Recommendation**: ship LayerZero ONFT V2 for v1; document a v2 migration
path to CCIP if Chainlink ships native NFT support. Commit to ONE — don't
build multi-rail abstractions before you have one rail working.

### Decision 2: Which chains in v1?

scout-networks-delta named these as the realistic v1 set:
- Base Sepolia (canonical home — already where v1 deploys)
- Sepolia L1 (Ethereum testnet anchor)
- Flow EVM testnet (PCC sponsor; already integrated elsewhere)
- Optimism Sepolia (shares Superchain interop with Base)

**Don't ship more than 4 testnet chains in v1.** Each chain = its own
endpoint + monitoring + dust-account funding + deploy script + verifier
trust assumption. More chains = more rope.

### Decision 3: Sovereign or canonical?

Two patterns:

**(A) Sovereign-per-chain**: contributor mints a fresh ContributorNFT on
each chain they want to earn on. Identity is the EOA wallet, not the NFT.
Cross-chain royalty aggregation happens off-chain via an indexer that
sums earnings across chains for a given wallet.
- Pro: simplest. No bridge dependency.
- Con: contributor has to mint N times. Schedule hash is duplicated.

**(B) Canonical home + cross-chain mirrors**: contributor mints once on a
home chain (Base Sepolia). LayerZero ONFT mirrors the NFT to other chains
on demand. Single canonical token-id, multi-chain presence.
- Pro: one mint, multi-chain availability. Aligns with sovereign-identity
  thesis.
- Con: bridge dependency. Mint flow is more complex (initiate on home,
  await L0 message, verify on remote).

scout-networks-delta's recommendation tilts (B) for the cross-network
sovereign-identity story. **Default to (B)** unless you discover a
specific reason during scouting that flips it.

### Decision 4: Where does the schedule live?

- **(i) Schedule on home chain only**: cross-chain settlement reads the
  home chain via a relayer (CCIP/L0 message) at release time. SLOW.
- **(ii) Schedule replicated to every chain at mint**: same content-hash
  on every chain. Each chain's `RateScheduleRegistry` has the schedule
  locally. Settlement is fast but mint cost is multi-chain.
- **(iii) Schedule fetched lazily**: at first job-attribution against a
  given (chain, scheduleHash), the gateway publishes the schedule to that
  chain's registry. Amortized over usage.

**Default to (ii) for v1 and accept the per-chain mint cost.**
Settlement-time bridge calls are a much worse failure mode.

### Decision 5: Identity collision

What if two contributors on two chains pick the same `ipId` (Story IPAsset
ID)? The Story IPAsset registry is itself a chain-local concept. Possible
solutions:
- (a) Use a globally-unique ID format (e.g., `<chain-id>:<address>:<token-id>`)
- (b) Require contributors to register against a canonical ENS-resolved
  IPAsset on Ethereum mainnet
- (c) Accept collision risk and document it (low probability for the
  testnet stage; address before mainnet)

**Default to (c) for v1**, escalate to (a) for mainnet.

---

## Concrete deliverables

This is a 5-8 day implementer arc. Decompose into waves like the original
build did.

### Wave 1: Research narrowing + ADR

- Re-read scout-networks-delta's report §09-15 with v1 implementation in mind.
- Land an ADR at
  `C:\Users\globa\pcc-contributor-economics-cross-chain\ai\research\cross-chain-onft-adr.md`
  (or wherever the new branch's docs land) committing to:
  - LayerZero ONFT V2 (or alternative)
  - The specific 4 chains for v1
  - Pattern (B) canonical-home, schedules per-chain (ii)
- Identify all the LayerZero-specific deps + endpoint configurations.

### Wave 2: Contract refactoring

- New file: `packages/contracts/src/ContributorNFTOFT.sol` (extends OZ ONFT
  V2 base). Mint flow: same as current `ContributorNFT.sol` but token
  metadata serialized for L0 transport.
- Modify `RateScheduleRegistry.sol` if needed to expose a public
  `publish(scheduleHash, segments)` permissionlessly so other chains can
  re-publish the same schedule. (Currently scoped — verify what permission
  model exists.)
- LayerZero endpoint registration per chain — typically a `script/`
  one-off.
- New file: `packages/contracts/script/DeployContributorEconomicsCrossChain.s.sol`
  — wraps the existing single-chain deploy + LayerZero endpoint config
  + ONFT pairing.

### Wave 3: TypeScript SDK + dashboard

- Extend `@pcc/contracts/ts/payouts.ts` to handle multi-chain Payout
  resolution (recipient may be on a different chain than the escrow —
  decide policy: same-chain only? or cross-chain via L0 OFT messaging at
  release time?).
- Dashboard: a "Mirror to chain" UI on a published schedule's view page,
  letting a contributor opt their NFT into another chain's mirror.

### Wave 4: Tests

- Forge integration test that mints on Base Sepolia, mirrors via L0 to
  Flow EVM, verifies token presence + metadata equivalence on both.
- Scenario: schedule published to home, contributor's NFT mirrored to a
  remote chain, job runs on the remote chain, settlement walks the right
  RateSchedule registry locally.

### Wave 5: Docs

- Update `docs/CONTRIBUTOR_ECONOMICS.md` "Open scope cuts" — flip cross-chain
  from "deferred" to "shipped on `feat/contributor-nft-cross-chain`."
- Add `docs/CROSS_CHAIN.md` — operator/contributor-facing guide:
  - "How to mirror your NFT to chain X"
  - "Which chains are supported"
  - "What happens if a mirror chain is down"
- Update `99-resume-here.md` accordingly.

---

## Acceptance criteria

- A contributor mints once on Base Sepolia, calls a `mirror(chainId)`
  function, and within ~60 seconds the same `tokenId` is queryable on
  Flow EVM testnet (or whichever target chain).
- A job running on the mirror chain settles correctly: the contributor's
  bps share computed from the local RateSchedule lands in their wallet on
  that chain.
- All forge tests green; the L0 mock infrastructure is used in unit tests
  to avoid testnet flakiness.
- One real end-to-end mint + mirror + settlement flow demonstrated on live
  testnets (with screenshots / tx hashes captured in the docs).

---

## Constraints

- Do NOT modify `feat/contributor-economics` files — this is a new branch
  cut from `master`.
- Do NOT introduce a new bridge dep without going through the project's
  Gate A vetting (`/vet <path>`). LayerZero V2 contracts must pass.
- Do NOT touch live mainnet anything. v1 is testnet only.
- Do NOT skip the audit gate before mainnet — this is more bridge surface,
  not less.

---

## Out-of-scope for this task

- Cross-chain `MilestoneEscrow` settlement (jobs that originate on one
  chain and settle on another). Settlement stays single-chain in v1.
- Cross-chain `RateScheduleRegistry` synchronization (replication beyond
  per-chain re-publish). Lazy local-publish is the v1 model.
- Mainnet promotion — needs the audit + the gates documented in
  `C:\Users\globa\pcc-contributor-economics\docs\DEPLOY.md`.

---

## How to start

1. Create the new branch: `git checkout master && git pull lamasu master &&
   git checkout -b feat/contributor-nft-cross-chain`
2. Re-read `04-network-forkability.md` §09-15. The recommended pattern is
   already drafted — you're refining and implementing.
3. Land the ADR (Wave 1 deliverable). Get a sanity check from the user
   before pouring code into Waves 2-4.
4. Spawn implementers per wave, single-agent cadence (the lesson from the
   original build: parallel-7 burns the rate limit fast).

If you're an agent picking this up cold, the SUBAGENT_RULES.md +
agent-context-header.md injection still applies. AGENT_NAME pattern:
`impl-onft-<qualifier>` (e.g., `impl-onft-alpha`).

— Briefing prepared by orchestrator session
`c6a109d5-b579-4a98-a653-456ac2645c03` on 2026-04-29.
