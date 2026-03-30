# PCC — Physical Capability Cloud

**Track**: Fresh Code | **Themes**: AI & Robotics, Infrastructure & Digital Rights
**Live**: https://capability.network | **Repo**: https://github.com/wingdingspenpal/poop

---

## The Problem

Physical manufacturing is fragmented and opaque. A university lab in Boston with an idle HPLC cannot serve a biotech startup in Austin that needs compound analysis — not because the capability doesn't exist, but because finding it requires manual RFQs, phone calls, NDAs, and trust in opaque middlemen. Administrative overhead and middle management add cost at every step — passed to users who pay more and absorbed by operators who earn less. A lab operator in Buenos Aires cannot offer bioreactor capacity to global buyers because no open protocol connects physical capability to demand across borders.

The same gap exists at every scale: makerspaces, contract manufacturers, biotech core facilities, robotics labs. Hundreds of billions in physical manufacturing capacity sits underutilized because there is no AWS for the physical world.

---

## The Solution

PCC is a decentralized cloud control plane where AI agents autonomously discover physical capabilities, negotiate prices, lock milestone escrow on-chain, stream cryptographic evidence during execution, and settle payment upon verified completion. No middlemen. Operators keep more, users pay less.

Every physical site that installs a Shop Kernel becomes a programmable endpoint. Capabilities — not machines, but what machines can *do* — are registered with typed specs, assurance tiers, and pricing. The six-phase pipeline runs: **DISCOVER** (DHT gossip) → **BID** (auction pricing) → **ESCROW** (on-chain milestone lock) → **EXECUTE** (device adapter streams evidence) → **VERIFY** (Lit encryption, Storacha storage, Starknet ZK anchoring) → **SETTLE** (auto-release + soulbound certificate).

The `PCCProtocol` root contract charges an immutable 1.5% clearing fee on every settlement — hardcoded at deployment, governance-adjustable within bounds (0.1%–5%), but can never be zero. No token inflation, no speculative tokenomics. A sustainable infrastructure business model.

---

## Sponsor Integrations

**Storacha / Filecoin**: Evidence bundles uploaded via `@storacha/client` w3up, producing permanent content-addressed CIDv1 hashes. Public metadata CID generated separately for safe indexing.

**Starknet**: ZK proof hashes anchored on Starknet Sepolia via `starknet.js` as felt252 field elements. Raw evidence never touches the chain — only commitment hashes.

**Lit Protocol**: Evidence encrypted with `UnifiedAccessControlCondition` arrays gating decryption on escrow state. Only the buyer or credentialed verifiers can decrypt.

**Flow**: MilestoneEscrow + MockUSDC deployed to Flow EVM Testnet — same Solidity, sub-cent transaction costs.

**NEAR**: Cross-chain payment intents via 1Click API. Agents on any chain can fund PCC escrows through NEAR's solver network.

---

## What Makes This Different

This is not a prototype. 25 packages, 3,300+ tests, 154 agent tools, 347 REST endpoints, 34 A2A intents — live at capability.network. A real OT-2 liquid handler robot runs as the first operator node. The `pcc-node` Python package lets any operator — from a lab in Kenya to a factory in Shenzhen — register hardware in one command. The DHT gossip network enables decentralized discovery without a central registry.

The Yellowcard fiat ramp enables operators in 34 emerging market countries to receive payment in local currency via mobile money — removing the barriers that keep small manufacturers out of global supply chains. The assurance tier system scales from a $0.10 print job to a $50,000 biotech assay.

---

*Built during PL Genesis: Frontiers of Collaboration, March 2026.*
*Team: globalmysterysnailrevolution*
