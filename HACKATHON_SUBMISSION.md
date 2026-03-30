# PCC — Physical Capability Cloud: Hackathon Submission

**Track**: Fresh Code | **Themes**: AI & Robotics, Infrastructure & Digital Rights

**Live**: https://capability.network | **Repo**: https://github.com/wingdingspenpal/poop

---

## The Problem

Physical manufacturing is fragmented and opaque. A university lab in Boston with an idle HPLC cannot serve a biotech startup in Austin that needs compound analysis — not because the capability doesn't exist, but because finding it, vetting it, and coordinating it requires manual RFQs, phone calls, NDAs, and trust in opaque middlemen. That administrative overhead and layer of middle management adds cost at every step, passed to users (who pay more) and absorbed by operators (who earn less). There is no composable, trust-minimized protocol for discovering, negotiating, executing, verifying, and settling physical work across organizational boundaries.

The same gap exists at every scale: makerspaces, contract manufacturers, biotech core facilities, robotics labs, courier networks. Hundreds of billions of dollars in physical manufacturing capacity sits underutilized because there is no AWS for the physical world.

---

## The Solution

PCC is a decentralized cloud control plane where AI agents autonomously discover physical capabilities, negotiate prices, lock milestone escrow on-chain, stream cryptographic evidence during execution, and settle payment upon verified completion. No middlemen. No admin overhead. Operators keep more, users pay less.

Every physical site that installs a Shop Kernel becomes a programmable endpoint on the network. Capabilities — not machines, but what machines can do — are registered with typed specs, assurance tiers, and pricing. AI agents handle the rest: discovery via DHT gossip, bidding via auction pricing, execution scoping with cryptographic safety bounds, and settlement via smart contract.

The protocol fee on the `MilestoneEscrow` contract is the business model. More operators means more volume. More volume means more fees. There is no other revenue extraction mechanism — the protocol is credibly neutral by design. Like Uniswap for physical work.

---

## Architecture

The system runs a six-phase pipeline for every job:

**DISCOVER** — the User Agent queries the DHT gossip network for operators with matching capability types and assurance tiers. **BID** — operators set maximum prices; agents compete by bidding under the ceiling, with discounts driven by queue depth and reputation. **ESCROW** — milestone funds lock in the `MilestoneEscrow` smart contract on Base Sepolia before any work begins. **EXECUTE** — the Kernel Agent runs the job through a physical device adapter (OT-2, OctoPrint, Modbus PLC, SiLA instrument), streaming SHA-256 content-addressed evidence events in real time. **VERIFY** — evidence bundles are encrypted via Lit Protocol, stored permanently on IPFS via Storacha, Merkle-committed, and the proof hash anchored on Starknet. **SETTLE** — escrow releases automatically to each operator when evidence meets the contract's tier requirements; soulbound capability certificates mint on Solana.

The agent layer runs a typed A2A intent bus: User Agent, Broker Agent, Kernel Agent, and Evaluator Agent communicate through 34 defined intents. The sovereign data layer uses W3C DIDs for machine identity, Verifiable Credentials for capability attestation, IPFS CIDs for content-addressing, and ZK Merkle proofs for privacy-preserving evidence commitments.

---

## Sponsor Integrations

**Storacha / Filecoin**: Every evidence bundle is uploaded to the Storacha w3up network via `@storacha/client`, producing a permanent, content-addressed CIDv1 on Filecoin infrastructure. A separate public metadata CID is generated with no sensitive fields — safe for indexing. The storage factory switches transparently between in-process Helia and Storacha via the `EVIDENCE_STORAGE` environment variable.

**Starknet**: ZK proof hashes and Merkle roots are anchored on Starknet Sepolia via `starknet.js`. The proof hash is serialized as a felt252 field element and committed to a `ProofRegistry` contract. Raw evidence never touches the chain — only the commitment hash — preserving privacy while providing permanent chain-verifiable proof of execution.

**Lit Protocol**: Evidence bundles are encrypted with `UnifiedAccessControlCondition` arrays that gate decryption on on-chain escrow state. Only the escrow buyer or a credentialed verifier (reputation >= 100) can unlock the ciphertext. The real integration uses `@lit-protocol/lit-node-client` v6 on the `datil-test` network with threshold key shares held across Lit nodes.

---

## What Makes This Different

This is not a prototype. The codebase contains 25 packages, 3,300+ tests, 154 agent tools, 347 REST endpoints, and 34 A2A intents — running live at capability.network on Railway. A real OT-2 liquid handler robot is operating as the first operator node. The `pcc-node` Python package lets any operator register hardware in a single command. The DHT gossip network enables decentralized capability discovery without a central registry.

The assurance tier system scales from low-stakes prototyping (G-code hash only, no bond) to aerospace-grade verification (camera CV, independent inspector, TEE attestation, 25% operator bond). The same protocol handles a $0.10 print job and a $50,000 biotech assay run.

---

*Built during PL Genesis: Frontiers of Collaboration, March 2026.*
*Team: globalmysterysnailrevolution*
