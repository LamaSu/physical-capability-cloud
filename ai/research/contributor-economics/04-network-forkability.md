# Landscape: Network Primitive + Fork-Resistance

AGENT_NAME: scout-networks-delta
Research date: 2026-04-22
Output file: C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/04-network-forkability.md

## The design constraint being solved

PCC needs to be a protocol that:

1. **Has no single treasury that captures value** — the protocol contracts themselves take zero fee.
2. **Allows anyone to spin up their own PCC-compatible network** with:
   - Their own treasury share (including `treasury_bps = 0`)
   - Their own dispute rail (Kleros / UMA / multisig / optimistic-challenge / user-elected jury)
   - Their own allowlist / KYC / sybil-resistance policy
   - Their own operator onboarding rules
3. **Preserves seamless cross-network operation** for:
   - Operators (run a job on net-A today, net-B tomorrow, same reputation)
   - Adapters / contributors (mint ContributorNFT on net-A, get paid by a job on net-B)
   - Requesters (post on net-A, have an operator registered on net-B bid)
4. **Has no single-org kill-switch** — no multisig that can pause every PCC network, no DNS/ENS controller that can rename things, no oracle that can be subpoenaed.
5. **Interoperates via standards only** — `ContributorNFT`, `CompositionManifest`, `JobReceipt`, a small fixed vocabulary. Implementations are pluggable.

This is the "credibly neutral protocol" design problem. The question is which primitives to adopt.

Progress:
- [ ] 01. Optimism Superchain
- [ ] 02. zkSync Hyperchains / ZK Stack
- [ ] 03. Arbitrum Orbit
- [ ] 04. Polygon CDK / Supernets
- [ ] 05. Cosmos IBC
- [ ] 06. Ethereum restaked services (EigenLayer / Karak / Symbiotic)
- [ ] 07. L1 -> L2 -> L3 structure (when to go from contract to dedicated chain)
- [ ] 08. Fork-resistance models (credible neutrality, Vitalik writings)
- [ ] 09. Cross-chain NFT ownership (LayerZero ONFT, Wormhole, CCIP, CCT)
- [ ] 10. Shared registries (ENS, Safe / Zodiac, Sismo, Gitcoin Passport)
- [ ] 11. Message-passing patterns (CCIP, LayerZero OApp, Hyperlane, native bridges)
- [ ] 12. Treasury design without single treasury (RPGF, Protocol Guild)
- [ ] 13. Dispute resolution per network (Kleros, UMA, Claros L5 cross-network)
- [ ] 14. Semi-sovereign app-chains (Polkadot parachains, Avalanche subnets)
- [ ] 15. Simple alternative: permissionless deployment on every EVM chain


## 01. Optimism Superchain

URL: https://docs.optimism.io/interop/explainer, https://specs.optimism.io/interop/overview.html, https://docs.optimism.io/stack/interop/superchain-weth

### Mechanism
The Superchain is Optimism's answer to "many chains, one ecosystem". Launching in early 2026, the Superchain Interoperability Layer gives every OP Stack chain:

1. **Message passing protocol** — a cross-chain message primitive (`CrossL2Inbox`) that lets a contract on chain A atomically read/verify an event emitted by a contract on chain B.
2. **SuperchainERC20 token standard** — a token deployed to the same address on every Superchain chain, with `sendERC20()` / `relayERC20()` that burns on source, mints on destination. Native minting and burning; no wrapped assets, no liquidity pools.
3. **Interoperable chain set** — the dependency graph. Every OP Stack chain declares which other chains it trusts to read messages from. The default chain set is "all Superchain chains".
4. **Shared interop fault proof system** — when chain A's block references chain B's block, chain A's proof of validity depends on chain B also being valid. Proofs are interlocked. If B is invalidated, A's dependent messages are also invalidated (cross-chain reorgs).

### SuperchainWETH / ETH Shared Lockbox
ETH is the canonical gas token. To prevent wrapped-ETH fragmentation, Wonderland built the ETH Shared Lockbox: a singleton contract on L1 that holds all ETH deposited across Superchain chains. Every Superchain chain's ETH is fungible because the lockbox is the canonical custodian. A user on chain A can `sendETH()` to chain B, and the bridge just updates Merkle proofs — no liquidity pool. By early 2026 this is live across 34 OP chains representing >50% of L2 activity.

### What's sovereign vs shared
| Sovereign per chain | Shared across Superchain |
|---|---|
| Gas token choice (ETH default, but can customize) | Fault proof system |
| Governance model | ETH liquidity (via Shared Lockbox) |
| Sequencer operator | Message-passing protocol |
| Fee split / treasury | SuperchainERC20 token registry |
| DA choice (EthDA or altDA like Celestia) | Superchain Registry (chain allowlist) |

The Superchain Registry is the "allowlist" — a chain has to be governance-approved to join the interop set. This is a key fork-resistance consideration: you can fork OP Stack and run your own chain, but you won't be in the Superchain's interop set unless the Collective votes you in.

### Cost to operate per-network
- **Rollup chain on Ethereum**: ~$30-100k/year gas for L1 calldata + proof posting, depending on throughput. AltDA (Celestia) brings this to ~$5-20k/year.
- **L3 settled to OP Mainnet**: ~$2-10k/year.
- **Sequencer infra**: single server ~$200/month. HA sequencer ~$2k/month.
- **Optimism doesn't charge a license fee** for OP Stack itself. But the Law of Chains (superchain governance) requires you to share some sequencer revenue with the Optimism Collective if you want to be in the official Superchain.

### Governance story
Superchain chains share governance via the Optimism Collective (Token House + Citizen House). The Law of Chains is a constitutional document defining what "being a Superchain chain" means — including reserved rights (emergency upgrade multisig), shared security obligations, and revenue sharing. Chains that don't want this remain OP Stack chains but are outside the Superchain interop set.

### Fit for PCC 1-5

| Score | Rationale |
|---|---|
| **4/5** | Excellent technical fit for message-passing, good if PCC wants to be an "OP Stack tenant", BUT the Superchain Registry is a governance gate and the Law of Chains forces revenue-sharing to Optimism Collective. That's the opposite of "no single treasury". PCC could use OP Stack for the protocol-contract deployment pattern (identical contracts at identical addresses on every chain) without joining the official Superchain. Rank: high as a primitive, medium as the whole answer. |


## 02. zkSync Hyperchains / ZK Stack

URL: https://docs.zksync.io/zk-stack, https://docs.zksync.io/zk-stack/zk-chains, https://blog.matter-labs.io/introducing-the-zk-stack-c24240c2532a

### Mechanism
ZK Stack is Matter Labs's open-source framework for deploying your own ZK-rollup as either an L2 (settles to Ethereum) or an L3 (settles to zkSync Era or another Hyperchain). Hyperchains are the resulting chains. Key pieces:

1. **Hyperchain** - a sovereign ZK-rollup that the operator controls: tokenomics, consensus participation, DA layer, rollup mode, upgrade keys. Unlike OP Stack's Law of Chains, Hyperchains have no revenue-sharing requirement back to Matter Labs.
2. **Gateway** - a shared proof aggregation hub. Instead of each Hyperchain paying L1 gas to verify its own ZK proof, they post their proofs to the Gateway, which bundles them into one aggregated proof and settles to L1. This amortizes the proof-verification gas cost across many chains.
3. **Shared bridges** - assets can move between any two ZK-Stack chains without wrapping because the proofs are interlinked (chain A's state root is part of the aggregated proof that includes chain B's).
4. **Modular DA** - Hyperchain operators pick: full rollup (EthDA), Validium (off-chain DA with operator signatures), zkPorter (DA committee), or plug in Celestia/Avail/EigenDA.

### Sovereignty with interop
The ZK Stack's selling point is "sovereign but seamless". A Hyperchain operator can:
- Set any fee model, any gas token, any governance
- Choose how often to settle proofs (less frequent = cheaper, higher finality latency)
- Use the Gateway for interop OR run standalone

Interop between ZK chains is done by smart contracts that verify transactions across chains using Merkle proofs. It is NOT based on a shared sequencer or a governance-gated chain set (unlike Superchain Registry).

### What's sovereign vs shared
| Sovereign per chain | Shared across Hyperchains |
|---|---|
| Tokenomics, gas token | Gateway proof aggregator (optional) |
| DA layer choice | L1 settlement contract (or zkSync Era if L3) |
| Governance model | Cross-chain message verification via Merkle proofs |
| Rollup vs Validium vs zkPorter | Shared bridges for asset movement |
| Sequencer, operator identity | |

### Cost to operate per-network
- **Hyperchain (L2)**: L1 gas for proof settlement. With Gateway aggregation, this drops significantly - probably $10-50k/year at low throughput.
- **Hyperchain (L3)**: settles to zkSync Era or another Hyperchain - much cheaper, $1-10k/year.
- **Validium / zkPorter**: near-zero L1 cost, but weaker security. $0-5k/year.
- **Matter Labs doesn't charge a license fee**. Gateway access is pay-per-proof (small fee).

### Governance story
No shared governance mandate. Each Hyperchain is its own sovereign. Matter Labs provides the ZK Stack as open-source but doesn't control individual chain governance. This is distinct from Optimism's Law of Chains.

### Fit for PCC 1-5

| Score | Rationale |
|---|---|
| **3/5** | Strong sovereignty model (good for "anyone can run their own network"), but ZK proofs make bridging to non-ZK chains harder. Great primitive if PCC is all-in on ZK, but most robotics/DePIN infra lives on EVM L2s that aren't ZK-based (Base, Arbitrum, Polygon PoS). ZK stack also has less mindshare for NFTs specifically - contributor NFT ecosystems are EVM-native. Secondary option. |

## 03. Arbitrum Orbit

URL: https://docs.arbitrum.io/launch-arbitrum-chain/a-gentle-introduction, https://blog.arbitrum.io/arbitrum-orbit-anytrust-chains/, https://arbitrum.io/orbit

### Mechanism
Orbit is Arbitrum's toolkit for launching customizable chains that use Arbitrum's Nitro tech stack. Two main variants:

1. **Arbitrum Rollup chain** - full optimistic rollup with fraud proofs. DA goes to Ethereum calldata. Highest security, highest cost.
2. **Arbitrum AnyTrust chain** - a Data Availability Committee (DAC) stores transaction data off-chain. Only proofs go to Ethereum. Ultra-low gas cost. Trust assumption: at least one DAC member is honest.

Settlement choice:
- **Settle to Ethereum (L2)**: max security, more expensive.
- **Settle to Arbitrum One (L3)**: faster finality, lower cost. "Orbit chains can settle to Arbitrum One." This is the most common choice.

Customization knobs: throughput, privacy level, gas token (any ERC-20, including stablecoins!), governance, precompiles, DA layer. You can also write contracts in Rust/C/C++ via Stylus in addition to Solidity.

### What's sovereign vs shared
| Sovereign per chain | Shared |
|---|---|
| Gas token (any ERC-20 or ETH) | Nitro runtime and fraud-proof mechanism |
| Throughput and fee model | If L3: Arbitrum One as settlement layer |
| Privacy (Orbit + off-chain TEE or custom) | Arbitrum Rollup/AnyTrust contracts |
| DAC membership (if AnyTrust) | |

Interop: no Superchain-style shared interop protocol. Orbit chains talk to each other via generic bridge protocols (LayerZero, CCIP, Hyperlane, Axelar) or via Arbitrum One as a hub.

### Cost to operate per-network
- **Orbit L3 (AnyTrust)**: $5-20k/year. DAC membership is maintained by the operator (5-10 signers at ~$100/mo each for VPS).
- **Orbit L2 (Rollup)**: $30-80k/year.
- **No license fee from Offchain Labs**. Permissionless.

### Governance story
Each Orbit chain is fully sovereign - operator controls upgrade keys, DAC membership, fee share. No "Orbit Registry" governance overlay. If you settle to Arbitrum One, you get Arbitrum DAO security but not Arbitrum governance control.

### Fit for PCC 1-5

| Score | Rationale |
|---|---|
| **3.5/5** | Good sovereignty model, low operating cost with AnyTrust, can use any gas token (USDC gas token = great UX for robotics operators). But no native cross-Orbit interop protocol - you would have to pick a bridge (LayerZero, CCIP, Hyperlane) and pay for it separately. For PCC's requirement of "ContributorNFT on net-A works on net-B", this is extra plumbing. Useful if PCC wants one specific chain (say "pcc-anytrust") with USDC gas - but doesn't solve the multi-network problem on its own. |

## 04. Polygon CDK / Supernets / Agglayer

URL: https://polygon.technology/polygon-cdk, https://docs.polygon.technology/cdk/, https://polygon.technology/chain-development-kit

### Mechanism
Polygon CDK (formerly Supernets) is a multistack toolkit. Two deployment tracks:

1. **CDK OP Stack** - fork of OP Stack, OP-compatible, but connected to Polygon's Agglayer instead of Optimism's Superchain. Sovereign chain, no ZK prover (relies on pessimistic proofs).
2. **CDK Erigon** - ZK-rollup with Polygon zkEVM prover.

Both stacks ship "natively connected to Agglayer". Agglayer is Polygon's cross-chain coordination layer:
- A unified bridge contract on Ethereum that knows every CDK chain
- Pessimistic proofs that verify no chain has withdrawn more assets than it holds in the bridge (enforced at the bridge level)
- "Unified liquidity" - assets deposited on CDK chain A can be withdrawn on CDK chain B through the Agglayer bridge without wrapping

### What's sovereign vs shared
| Sovereign per chain | Shared via Agglayer |
|---|---|
| Governance, tokenomics | Unified bridge (pessimistic proof secured) |
| Gas token | Cross-chain liquidity pool |
| DA layer | Agglayer routing |
| Sequencer | Asset fungibility |

### Cost to operate per-network
- CDK chain: similar to Orbit, $5-40k/year depending on DA choice.
- Agglayer connection: small protocol fee (bps on cross-chain withdrawals).
- Polygon Labs doesn't charge a license; Agglayer fees go to a network-wide treasury.

### Governance story
Agglayer has a light governance model managed by Polygon Labs / Polygon community. Individual CDK chains are sovereign. There's less "Law of Chains"-style forced revenue-sharing than Optimism, but Agglayer does take a small bridge fee.

### Fit for PCC 1-5

| Score | Rationale |
|---|---|
| **3/5** | The pessimistic-proof design is interesting - it provides cross-chain safety without requiring ZK proofs on every chain. Agglayer's unified liquidity is nice for fungible assets but NFTs are trickier (Agglayer is token-focused). Good if PCC operators want "deposit USDC on chain A, use it on chain B" UX. Less compelling for the ContributorNFT portability story, where LayerZero ONFT or CCIP is a better primitive. |

## 05. Cosmos IBC / Interchain

URL: https://cosmos.network/ibc, https://cosmos.network/ibc-eureka, https://tutorials.cosmos.network/academy/3-ibc/1-what-is-ibc.html

### Mechanism
IBC (Inter-Blockchain Communication) is the original light-client-based interop protocol. It does NOT rely on a shared sequencer, a shared prover, or a shared bridge contract. Instead:

1. Each chain runs a **light client of every other chain it talks to**. The light client tracks the consensus state (headers) of the remote chain.
2. To send a cross-chain message, chain A emits a packet with a Merkle proof of inclusion. Chain B's light client of A verifies the header and the proof, then delivers the packet.
3. **Chains remain fully sovereign**: they run their own validator set, their own governance, their own asset model. IBC is purely a message layer.
4. Assets crossing IBC are represented with "IBC denoms" - ibc/<hash> strings that encode the trace of hops (e.g., `ibc/27394FB092...` means "ATOM originated on Cosmos Hub, hopped through channel-X on Osmosis").

### IBC Eureka (2025-2026)
Interchain Labs's IBC Eureka initiative brings IBC to Ethereum and L2s. IBC v2 light clients for EVM chains are in production. As of 2025-04, Ethereum, Solana (via adapter), Cosmos Hub, and ~50+ chains are in the IBC set. Total market cap bridged: $260B+.

### What's sovereign vs shared
| Sovereign per chain | Shared |
|---|---|
| Consensus (each chain = own validator set) | IBC protocol spec (standardized) |
| Governance | Light clients run on every connected chain |
| Tokenomics, gas, upgrade keys | Cross-chain denom format |
| Validator economics | Relayer network (permissionless) |

**This is the most sovereign model of any interop system.** No shared contract, no shared prover, no shared operator. Each chain is a standalone blockchain with its own security budget.

### Cost to operate per-network
- **Appchain with own validator set**: highest cost, $200k-$1M+/year for a 30-validator set.
- **Appchain secured by Replicated Security (Cosmos Hub provides validators)**: medium cost, $10-50k/year.
- **Appchain secured by Mesh Security (share validators with other chains)**: low cost, $5-25k/year.

### Governance story
Each chain = fully sovereign governance. No cross-chain governance. No shared treasury. This is the closest match to the "no single kill-switch" requirement.

### Fit for PCC 1-5

| Score | Rationale |
|---|---|
| **3/5** (as primary) **4.5/5** (as inspiration) | The Cosmos model is philosophically the perfect match: sovereign chains, no kill-switch, standardized interop. BUT - the whole robotics/DePIN/NFT economy is EVM-native. Deploying PCC on Cosmos means starting from zero on developer tools, wallet integrations (Cosmos wallets are separate from MetaMask), NFT standards (Cosmos NFT module is different from ERC-721), and liquidity. The design philosophy (sovereign chains + standardized message passing) is EXACTLY right for PCC's goal. Implementation: adopt IBC-like design *on EVM* via Hyperlane (permissionless), or use IBC Eureka to bridge between EVM and Cosmos if PCC ever needs it. |


## 06. Ethereum Restaked Services (EigenLayer / Karak / Symbiotic)

URL: https://app.eigenlayer.xyz/avs, https://unchainedcrypto.com/eigenlayer-competitors-symbiotic-karak/

### Mechanism
Restaking lets ETH stakers (and LST holders) re-use their staked capital to secure additional services called Actively Validated Services (AVSs) on EigenLayer, Distributed Secure Services (DSSes) on Karak, or Networks on Symbiotic. Key primitives:

1. **Operator**: an entity that runs nodes for one or more services. They receive delegated restake and earn rewards.
2. **Strategy**: the asset class being restaked (stETH, ETH, EIGEN, LP tokens...).
3. **Slashing conditions**: defined by each service, enforceable by on-chain contracts.
4. **Cross-chain**: EigenLayer, Karak, and Symbiotic all settle slashing on Ethereum mainnet, but the services themselves can operate on any chain (including Base, Arbitrum, Polygon).

### Protocol variants
| Feature | EigenLayer | Karak | Symbiotic |
|---|---|---|---|
| Asset support | ETH, LSTs, EIGEN | LSTs, stables, ERC-20, LP tokens | Any ERC-20 |
| Service model | AVS | DSS | "Network" |
| Slashing | Veto committee + resolver | Customizable | Customizable + resolver/veto |
| TVL (2026-02) | $18B restaked | $1-2B | $0.5-1B |
| Chain for asset deposits | Ethereum only | Multiple (ARB, Mantle, BSC, ETH) | Ethereum + L2s |

### Vertical AVSs (2026 trend)
As of Q1 2026, vertical AVS specialization is the dominant pattern: AVSs that do one thing — AI inference verification (EigenAI), data availability (EigenDA), cross-chain messaging (Hyperlane's Security AVS), oracles (Redstone AVS). PCC-relevant use cases:

- **Evidence-verifier AVS**: operators who stake ETH to attest "this job's evidence bundle matches the claimed output". Slashing if later proven false.
- **Reputation-computation AVS**: compute trust scores for kernels and contributors, with slashing for demonstrably wrong computations.
- **Dispute-arbitration AVS**: serve as PCC's Layer 5 optimistic-challenge backstop.

### What's sovereign vs shared
| Sovereign per service | Shared via restaking |
|---|---|
| Slashing conditions | Ethereum-level economic security ($18B+ for EigenLayer) |
| Operator requirements | Operator pool (1,900+ operators for EigenLayer) |
| Rewards model | Slashing execution layer (Ethereum mainnet) |
| Service-specific logic | Veto committees / resolvers (L1-hosted) |

### Cost to operate per-network
AVS operating cost varies wildly:
- **Lightweight AVS (oracles, attestations)**: $5-50k/year for infrastructure + slashing insurance.
- **Heavy AVS (DA layers, AI inference)**: $100k-$1M/year.
- **Rewards**: must pay operators ~4-10% APR on restaked capital to attract participation.

### Governance story
Each AVS defines its own governance (multisig, DAO, or autonomous contracts). EigenLayer itself has a DAO. No shared cross-AVS governance.

### Fit for PCC 1-5

| Score | Rationale |
|---|---|
| **4/5** | Extremely valuable as a primitive for specific PCC functions (verifier AVS, dispute AVS). Does NOT solve the "multi-chain registry" problem — AVSs are services, not chains. BUT — running PCC's verifier network as an AVS gives us Ethereum-level security guarantees for honest evidence verification without spinning up a new chain. Recommend: use EigenLayer AVS for verifier + dispute layer (Layer 4 of Claros), keep protocol contracts multichain and connected via cross-chain messaging. |

## 07. L1 -> L2 -> L3 structure — when to go from contract to dedicated chain

### The progression
1. **Contract on an existing L1/L2** (today's PCC on Base Sepolia): low cost, high interop, constrained by host-chain design decisions.
2. **Dedicated L2 or L3**: custom gas token, custom fee model, custom precompiles, but requires infra spend and developer mindshare.
3. **Sovereign appchain (Polkadot parachain, Cosmos zone, Avalanche L1)**: full sovereignty, weak interop with EVM world, highest cost.

### Thresholds that justify going from contract to chain

| Condition | Move to dedicated chain? |
|---|---|
| >10M tx/month sustained | Yes - you will hit EVM gas friction |
| Need sub-second finality for physical control loops | Yes - L1s/L2s can't give sub-100ms without a dedicated sequencer |
| Need custom precompiles (e.g., signature schemes for robot hardware) | Yes |
| Need a gas token that's stable vs fiat (USDC-gas) | Yes - use Orbit/CDK with USDC as gas |
| Need to control sequencer for MEV-free ordering | Yes |
| Need to guarantee censorship resistance beyond L1 | No - L1 is better |
| Need max interop with existing NFT/DeFi ecosystems | No - stay on existing L2s |
| <100k active users, <1M tx/month | No - contracts on Base/Arbitrum/Polygon are fine |

### PCC-specific analysis
PCC today: single chain (Base Sepolia), single escrow contract, 2.35% protocol fee. Volume is pre-revenue. There is no throughput justification for a dedicated chain.

Moving to a dedicated chain would hurt, not help, PCC right now, because:
- Robotics operators are far more likely to have Base/Arbitrum/Polygon wallets than a PCC-specific chain wallet
- NFT ecosystems (Story Protocol, OpenSea, ERC-8004 registrars) live on Ethereum and L2s, not on sovereign appchains
- USDC liquidity is on L1 and major L2s
- Dedicated chain = dedicated sequencer = single point of failure and regulatory exposure

### When PCC should revisit this
- >100M jobs/year sustained
- Regulatory clarity that a PCC-specific jurisdiction (say, a Liechtenstein-chartered DAO-owned appchain) is tax-advantaged
- Physical-control-loop use cases (robot control at <100ms round-trip) that can't be done with oracles

### Fit for PCC 1-5

| Score | Rationale |
|---|---|
| **2/5** (now) **4/5** (future) | Not yet. Multichain deployment on existing EVM chains is the right architecture for the next 2-3 years. Revisit when throughput or physical-control-loop requirements demand it. |

## 08. Fork-resistance models & credible neutrality

URL: https://nakamoto.com/credible-neutrality/ (original Vitalik essay), https://balajis.com/p/credible-neutrality, https://messari.io/report/credible-neutrality-as-a-guiding-principle

### Vitalik's four rules for credible neutrality (2020)
A mechanism is credibly neutral if just by looking at its design, it is easy to see that it does not discriminate for or against any specific people. The four rules:

1. **Don't write specific people or specific outcomes into the mechanism.** The mechanism should treat every participant the same way ex-ante.
2. **Open source and publicly verifiable execution.** Anyone should be able to audit the mechanism.
3. **Keep it simple.** Complex rules hide bias; simple rules are defensible. A market's "highest bid wins" is credibly neutral. A market's "highest bid wins unless committee decides otherwise" is not.
4. **Don't change it too often.** Stability signals that the mechanism is not being tweaked to favor specific outcomes.

### Why this matters for PCC
PCC's current design has a 2.35% hardcoded protocol fee going to a single treasury. That fails rule 1 (favors "the protocol treasury" as a specific entity) and is therefore not credibly neutral. If the treasury ever becomes political (governance capture, litigation, regulatory seizure), the whole PCC network inherits that risk.

The solution pattern: **separate the protocol from the network.**
- The **protocol** = the contracts, standards, SDKs, message formats. Zero fee, no treasury, open-source, immutable.
- A **network** = an instance of the protocol with opinionated defaults (fee, arbiter, KYC policy, allowlist). Many networks can exist. Networks compete on service quality, not on monopoly.

### Credible-neutrality design tactics for PCC

| Tactic | Effect |
|---|---|
| **Immutable core contracts** (no admin keys) | Can't be upgraded to steal funds or censor users |
| **Any ERC-20 as settlement token** | No lock-in to a protocol token |
| **Pluggable arbiter** | Network picks Kleros / UMA / jury / ML model; protocol doesn't care |
| **Pluggable treasury split** | Network sets `treasury_bps`; protocol enforces split but doesn't take any |
| **Standardized events** | Every network emits the same JobReceipt event shape, readable by indexers |
| **No governance token at protocol level** | No one can vote to change the protocol; only network-level policies can change |
| **Registry is append-only** | Once a kernel or contributor NFT is registered, it can't be removed |

### Legally credible neutrality (Barczentewicz 2024)
A recent academic analysis argues that credible neutrality also needs *legal* credibility: the mechanism should not create a natural person or legal entity who is the obvious target of a lawsuit or regulatory action. Specifically:
- No "protocol company" that collects fees
- No DAO multisig that can freeze funds (even for good reasons)
- No upgrade mechanism controlled by identified humans

This points toward designs like Tornado Cash (immutable, no admin keys) rather than Aave (governance-controlled upgrades).

### Fork-resistance vs fork-tolerance
There's a subtle distinction:
- **Fork-resistance**: it's hard to create a competing version of the protocol (e.g., because the brand and community are sticky, or because the core token has strong network effects).
- **Fork-tolerance**: it's easy to fork the protocol, AND that's fine, because forks are interoperable and don't split the user base.

PCC should aim for fork-tolerance, not fork-resistance. This is the Cosmos philosophy applied to EVM: "many PCC networks, all interoperable, none dominant".

### Fit for PCC 1-5

| Score | Rationale |
|---|---|
| **5/5** (as guiding principle) | This is the philosophical foundation of the fork-resistant design. Credible neutrality = protocol contracts are minimal, immutable, take no fee. All policy lives at the network layer. Directly addresses the user's constraint: "no single treasury, no kill-switch, anyone can run pcc-network-foo with treasury_bps=0". |

## 09. Cross-chain NFT ownership (LayerZero ONFT, Wormhole, CCIP, CCT)

### The three patterns
1. **Burn-and-mint** (LayerZero ONFT, Chainlink CCT): burn the NFT on source chain, mint on destination. Canonical supply preserved, no wrapped tokens.
2. **Lock-and-mint / lock-wrap** (Wormhole NFT bridge, LayerZero ONFT Adapter): lock original on source, mint wrapped version on destination. If destination fails, token is stuck.
3. **Message-passing only** (Hyperlane): send a message that encodes the NFT transfer, let the destination contract decide how to represent ownership. Most flexible, requires custom logic.

### LayerZero ONFT v2 (most popular for NFTs)
Two implementation modes:
- **ONFT contract**: deploy burn-and-mint contracts on every chain. Each chain has its own copy of the collection, but total supply is canonical (burn on A increments a counter, mint on B decrements it).
- **ONFT Adapter**: keep the original collection on one chain, deploy adapters on others. Original is locked in the adapter when bridged away.

For a ContributorNFT that needs to flow freely between networks, the **ONFT (burn-and-mint) mode** is the right pick. The contributor's NFT can exist on whichever chain is most useful at the moment (gas cheap chain for transfers, high-liquidity chain for royalty settlement).

### Chainlink CCT (Cross-Chain Token standard, 2024)
Newer than ONFT but backed by Chainlink CCIP's decentralized oracle network (DON). CCT is primarily for fungible tokens but the burn/mint pattern also supports NFTs with minor tooling. Main advantages:
- Built into CCIP (same security as Chainlink's $14T+ enabled TVL)
- Self-serve token deployment via Token Manager
- Multiple DON validation (less trust concentration than 19-of-N)

Trade-off: less NFT-specific tooling than LayerZero ONFT. For a pure NFT use case, ONFT has better ergonomics; for a token-heavy protocol (royalty tokens, reputation tokens), CCT is competitive.

### Wormhole NFT bridge
Uses lock-and-mint with 19 "Guardians" (validators) attesting to messages. Simpler than ONFT but has more trust concentration in the Guardian set. Notable real-world use: Dust Labs migrated DeGods + y00ts from Solana to Ethereum/Polygon via Wormhole.

### Hyperlane messaging for custom NFT logic
If PCC wants non-standard NFT behavior (e.g., royalty-token-bound NFTs where bridging also settles accumulated royalties), Hyperlane's permissionless message-passing with customizable Interchain Security Modules (ISMs) gives maximum flexibility. ISMs let you pick: multisig, light client, ZK proof, or custom logic.

### Recommended pattern for ContributorNFT
**LayerZero ONFT v2 with burn-and-mint** because:
- Canonical supply is preserved (critical for PCC's contributor reputation — can't have 2 copies of the same NFT floating around)
- Works on 70+ EVM chains
- Has deployment tooling and community patterns
- Enables contributors to relocate to whichever network is most economical for their current activity

Caveat: royalty routing should NOT bridge the NFT on every settlement. Instead:
- NFT lives on one chain (contributor's home chain)
- CCIP or LayerZero OApp delivers a cross-chain message "job on network-B settled, royalty of X USDC owed to contributor-Y"
- Network-B sends the royalty payment directly to contributor-Y's address on network-B (or to a universal address if using ENS / EIP-3770 / CAIP-10)

### Fit for PCC 1-5

| Score | Rationale |
|---|---|
| **5/5** | Essential primitive for "ContributorNFT portable across networks". LayerZero ONFT v2 is the right default. Consider CCT as a fallback if CCIP adoption among target chains is stronger than LayerZero's. |

## 10. Shared registries (ENS, Safe/Zodiac, Sismo, Gitcoin/Human Passport)

### ENS as the naming layer

ENS today is the canonical namespace on Ethereum mainnet. With CCIP Read (ENSIP-10, 2023) and the L2 resolver patterns:
- A name `alice.base.eth` lives on Base
- A name `bob.pcc.eth` could live wherever pcc.eth's resolver points
- Resolution happens via CCIP Read: L1 contract reverts with `OffchainLookup`, client queries gateway, gets L2 data, verifies
- Result: `alice.pcc.eth` can be a universal handle for a contributor across all networks

**Pattern for PCC**: register `pcc.eth`, set a universal resolver that reads from each network's local registry. A contributor minting ContributorNFT #1234 on Arbitrum gets `alice.pcc.eth` pointing to their Arbitrum address, but anyone resolving `alice.pcc.eth` from any other network can still find them.

Reverse ENS (primary name) gives a contributor discoverability: when an operator sees an address `0xabc...123` in a job log, they can reverse-resolve to `alice.pcc.eth` and view reputation.

### Safe / Zodiac for multichain org presence
Safe (formerly Gnosis Safe) is the most battle-tested multisig, deployed on 15+ chains. Zodiac is a module standard that adds governance patterns:

- **Governor Module**: token-voted proposals execute through a Safe
- **Reality Module**: off-chain signals (Discord polls, Snapshot votes) trigger Safe actions
- **Bridge Module**: cross-chain message-passing from one Safe to another
- **ConnextModule**: Safe on chain A can control a Safe on chain B via Connext

For PCC, a Safe + Zodiac pattern could be used by:
- Network operators (multisig + governance for each network's policy)
- Contributor DAOs (collaborative ContributorNFT ownership with governance)
- Dispute arbitration panels (each panel is a Safe with Reality module)

This is NOT needed at the protocol layer — the protocol has no admin. But it's useful at the network layer.

### Sismo (deprecated 2024) / Gitcoin Passport (now Human Passport)
Sismo shut down in 2024. The successor in the sybil-resistance space is **Human Passport** (formerly Gitcoin Passport, acquired by Holonym Foundation in 2025):

- Runs as an AVS on EigenLayer with $1.4B staked
- Combines cross-chain activity signals (Base, Ethereum, other EVM)
- ML-powered Sybil Detection Model analyzing wallet behavior in real-time
- Provides stamp-based scoring (GitHub, Google, ENS, proof-of-personhood, etc.)
- Integrates cross-chain: the passport stamp on one chain is verifiable from any chain

For PCC, Human Passport can be used at the network level:
- `pcc-network-strict`: requires a passport score of 20+ (typical sybil-resistance threshold)
- `pcc-network-open`: no passport requirement
- `pcc-network-kyc-required`: requires specific stamps (e.g., face-match, government ID)

Protocol doesn't enforce this; each network does.

### CAIP-10 for universal addresses
CAIP-10 gives us addresses that are chain-agnostic: `eip155:8453:0xabc...123` means "address 0xabc on Base (chain ID 8453)". CAIP-19 does the same for assets. PCC messages crossing networks should use CAIP-10 for addresses so messages are unambiguous.

### Fit for PCC 1-5

| Score | Rationale |
|---|---|
| **5/5** (ENS) **4/5** (Safe/Zodiac) **4/5** (Human Passport) | ENS is essential — gives us universal handles. Safe/Zodiac is optional but useful at network level. Human Passport is optional per-network for sybil resistance. All three fit the "no shared kill-switch" model because none of them are protocol-level requirements. |

