# PL Genesis: Frontiers of Collaboration — Hackathon Intel

**Fetched**: 2026-03-28
**Deadline**: March 31, 2026
**Judging**: April 1-3, 2026
**Winners**: April 4, 2026
**Our Track**: Existing Code ($50K pool)

## Prize Structure
| Category | Amount | Details |
|----------|--------|---------|
| Fresh Code | $50,000 | 10 teams × $5,000 |
| Existing Code | $50,000 | 10 teams × $5,000 |
| Sponsor Bounties | $50,000+ | Targeted awards per sponsor |
| Flow Challenge | $10,000 | 10 teams × $1,000 |
| **Total** | **$150K+** | |

**Requirement**: Integrate at least one sponsor bounty.

## Sponsors (10 confirmed)
1. **Filecoin / Storacha** — IPFS decentralized storage
2. **Flow** — Layer-1 blockchain (Dapper Labs)
3. **Impulse AI** — AI platform
4. **Lit Protocol** — Decentralized encryption & access control
5. **NEAR** — Layer-1 blockchain, sharded
6. **Physical AI** — Physical AI / robotics
7. **Starknet** — ZK-rollup L2 on Ethereum
8. **Storacha** — IPFS storage (w3up)
9. **Zama** — Fully Homomorphic Encryption (FHE)
10. **World** — World ID, biometric identity

### Additional Partners
- Funding the Commons, Crecimiento, Hypercerts, Ethereum Foundation
- HER DAO, BlockseBlock, Edge City, CoinEasy, Filecoin Africa, Velric

## Judges (17 confirmed)
| # | Name | Title | Company | Sponsor? |
|---|------|-------|---------|----------|
| 1 | Juan Benet | Founder & CEO | Protocol Labs | Organizer |
| 2 | Molly Mackinlay | Engineering & Research Lead | Protocol Labs | Organizer |
| 3 | Ali Serag | DevRel Lead | **Flow** | ✅ SPONSOR |
| 4 | Brad Holden | Managing Partner | PL Capital | PL |
| 5 | Devinder Sodhi | AI Lead | Frontiertower | - |
| 6 | David Sneider | Co-Founder | **Lit Protocol** | ✅ SPONSOR |
| 7 | Mashal Waqar | Head of Marketing | Octant | - |
| 8 | Meghan Hughes | CMO | Matter Labs (zkSync) | - |
| 9 | Dhruv Varshney | DevRel Manager | **Storacha** | ✅ SPONSOR |
| 10 | Lain Calvo | Core Contributor | Crecimiento | Partner |
| 11 | Elliot Braem | DevRel | **NEAR** | ✅ SPONSOR |
| 12 | Sabeen Ali | Founder & CEO | DevSpot | Platform |
| 13 | Eshan Chordia | Founder & CEO | **Impulse AI** | ✅ SPONSOR |
| 14 | Omar Espejel | Crypto Developer | **Starknet** | ✅ SPONSOR |
| 15 | David Casey | CEO | Funding the Common | Partner |
| 16 | E.G. Galano | Co-Founder | Infura | PL |
| 17 | Benjamin Lavergne | Director Investment | Consensys | - |

**6 out of 17 judges represent sponsors.** Their integrations MUST be visible.

## Tracks
1. **Web3** — Digital Human Rights
2. **Crypto** — Economies & Governance
3. **AI / AGI / Robotics** — ← OUR PRIMARY TRACK
4. **BCI / Neurotech** — Brain-Computer Interfaces

## PCC Integration Cross-Reference

### ✅ ALREADY INTEGRATED (3 sponsors)
| Sponsor | PCC Integration | Package | Status |
|---------|----------------|---------|--------|
| **Storacha** | Evidence IPFS storage via w3up | packages/kernel | Real (w3up delegation) |
| **Lit Protocol** | AES-256-GCM evidence encryption | packages/kernel | Mock + Real available |
| **Starknet** | ZK proof hash anchoring | packages/verifier | Real (Sepolia) |

### ❌ NOT YET INTEGRATED (7 sponsors)
| Sponsor | Opportunity | Difficulty | Worth it? |
|---------|-------------|------------|-----------|
| **Flow** | Settlement chain, $10K bounty | Medium | YES — $10K separate bounty |
| **NEAR** | Settlement chain | Medium | Maybe — judge is NEAR DevRel |
| **Zama** | FHE for evidence encryption | Hard | No — 3 days left |
| **Impulse AI** | AI agent capabilities | Unknown | Maybe — judge is founder |
| **Physical AI** | Domain alignment (physical AI) | Low | YES — narrative alignment |
| **World** | Operator identity (World ID) | Medium | Maybe |
| **Hypercerts** | Capability certificates as impact certs | Medium | Maybe |

### NON-SPONSOR INTEGRATIONS (currently in video but not hackathon sponsors)
- Bittensor — verification subnet
- Base / Coinbase — settlement + x402
- Solana — soulbound cNFTs
- Story Protocol — IP registration
- UMA OOv3, Chainlink, EigenLayer — oracles
- Stripe, Yellowcard, Wise — fiat ramps

## STRATEGY: Maximize Wins

### Priority 1: Make existing sponsor integrations SHINE in video
The 3 sponsors we already integrate have JUDGES on the panel:
- David Sneider (Lit Protocol co-founder) — make Lit encryption prominent
- Dhruv Varshney (Storacha DevRel) — make IPFS evidence storage prominent
- Omar Espejel (Starknet) — make ZK proofs prominent

### Priority 2: Update video sponsor list
Current video lists: Filecoin/Storacha, Lit Protocol, Starknet, Bittensor, Base, Solana
Should prioritize: Filecoin/Storacha, Lit Protocol, Starknet, Flow*, NEAR*, Protocol Labs
(* if we add even lightweight integrations)

### Priority 3: Narrative alignment
- Physical AI is a sponsor — our "physical capability" domain IS physical AI
- AI/Robotics track — we are the physical infrastructure layer for AI agents
- "Existing Code" track — we have 25 packages, 3300+ tests

### Priority 4: Add Flow integration for $10K bounty
Flow has a separate $10K prize pool. Even a lightweight Flow wallet adapter would qualify.
