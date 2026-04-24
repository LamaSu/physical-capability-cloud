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


## 11. Message-passing patterns for job settlement

### The problem
In a multi-network PCC world, a job may be posted on Base, accepted by an operator registered on Arbitrum, use materials owned by a contributor on Optimism, settle on Polygon (because USDC gas is cheapest there), and have reputation updates applied to the ContributorNFT on Ethereum mainnet. The core question: **how do these five chains coordinate atomically?**

### Option A: Chainlink CCIP + CCT (enterprise-grade)
URL: https://chain.link/cross-chain, https://docs.chain.link/ccip/concepts/cross-chain-token

- **Architecture**: DON (Decentralized Oracle Network) of 5-11 nodes per lane. Each lane is a chain-pair. Messages are signed by DON quorum and verified on destination.
- **Security**: multiple DONs, independent risk management, proven at institutional scale (Swift, DTCC, 11,000+ banks via Chainlink integrations as of 2026).
- **Speed**: ~10-20 minutes between chains (slow compared to LayerZero).
- **Cost**: moderate. Higher than LayerZero, lower than native bridges.
- **NFT support**: via CCT (Cross-Chain Token Standard, 2024) — burn/mint or lock/mint.

### Option B: LayerZero v2 OApp (fastest, widest reach)
URL: https://docs.layerzero.network/v2/concepts/applications/oapp-standard

- **Architecture**: Ultra-Light Node on each chain, DVNs (Decentralized Verifier Networks) chosen per-application. "Application-owned security" — each OApp picks its own DVN set.
- **Security**: configurable. Default uses LayerZero Labs + Google Cloud + another DVN for a 3-of-3 requirement. Apps can require more DVNs.
- **Speed**: 30 seconds to 3 minutes (fastest).
- **Cost**: lowest among major options. Gas on source + destination only.
- **NFT support**: native via ONFT v2 standard.
- **Reach**: 150+ chains, 75% of cross-chain bridge volume (2025).

### Option C: Hyperlane (permissionless, sovereign)
URL: https://www.hyperlane.xyz

- **Architecture**: mailbox contract on each chain. Messages delivered by permissionless relayers. Security via Interchain Security Modules (ISM) — apps pick between multisig, light client, ZK proof, or custom.
- **Permissionless**: anyone can deploy Hyperlane to any chain without asking permission.
- **Speed**: 30 seconds to 5 minutes.
- **Cost**: very low. Relayer-market-priced.
- **NFT support**: via custom OApp-style contracts; no ONFT-equivalent standard.
- **Reach**: 150+ chains.

### Option D: Axelar GMP (General Message Passing)
URL: https://docs.axelar.dev/dev/general-message-passing/overview/

- **Architecture**: Axelar blockchain is the hub. Gateway contracts on each chain relay messages through Axelar validators.
- **Security**: 75 active validators, proof-of-stake consensus with $AXL staking.
- **Speed**: ~2 minutes (120 seconds gateway-to-gateway).
- **Cost**: moderate. Pay in any supported token, not just AXL.
- **NFT support**: via ITS (Interchain Token Service) which supports NFTs with some work.
- **Reach**: 70+ chains.

### Option E: Native bridges (e.g., Optimism, Arbitrum standard bridges)
- **Architecture**: canonical chain-specific bridge, e.g., Optimism L1StandardBridge.
- **Security**: backed by the L2's fraud proof system.
- **Speed**: fast deposits (minutes), slow withdrawals (7 days for optimistic rollups).
- **Cost**: high gas on withdrawals.
- **NFT support**: canonical ERC-721 bridging.

### Option F: IBC (Cosmos-native, Eureka for EVM)
URL: https://cosmos.network/ibc-eureka

- **Architecture**: light client on each chain, Merkle proofs verify cross-chain packets.
- **Security**: per-chain consensus. Most decentralized.
- **Speed**: ~30 seconds.
- **Cost**: low.
- **NFT support**: via ICS-721 (cross-chain NFT standard for Cosmos).
- **Reach**: 100+ Cosmos chains, Ethereum via IBC Eureka (2025).

### Comparison table

| Protocol | Speed | Cost | Security Model | NFT support | Reach | Decentralization |
|---|---|---|---|---|---|---|
| CCIP | 10-20 min | $$ | DON quorum | CCT (good) | 40+ chains | Medium |
| LayerZero v2 | 0.5-3 min | $ | Configurable DVNs | ONFT (excellent) | 150+ chains | Medium |
| Hyperlane | 0.5-5 min | $ | Configurable ISM | Custom | 150+ chains | High (permissionless) |
| Axelar | ~2 min | $$ | PoS validators | ITS | 70+ chains | Medium |
| Native bridges | Fast in, slow out | $$$ | L2-specific | ERC-721 | Per-L2 | Varies |
| IBC Eureka | 0.5 min | $ | Light clients | ICS-721 | 50+ | Very high |

### Recommendation for PCC
Use **LayerZero v2 OApp** as the default for job-settlement messages (fast, cheap, widely deployed). Use **CCIP** as a fallback for networks that explicitly require enterprise-grade Chainlink-verified messaging (some regulated contexts). Wire both as interchangeable adapters.

Specific PCC message types:
- `JobReceiptV1` — includes jobId, settlement details, evidence CID, contributor royalty split. Sent from settlement chain to contributor chain via LayerZero.
- `ReputationUpdateV1` — sent from any network to Mainnet ENS reputation record via LayerZero.
- `DisputeEscalatedV1` — sent from any network to the dispute-arbitration AVS (on Ethereum for slashing) via LayerZero.

### Fit for PCC 1-5

| Score | Rationale |
|---|---|
| **5/5** | Essential primitive. LayerZero v2 is the clear winner for PCC's use case (fast, cheap, NFT-native, 150+ chains). Hyperlane is a strong permissionless alternative. Use an adapter pattern so PCC can switch if needed. |

## 12. Treasury design without a single treasury

### The problem
If the protocol takes zero fee, who funds:
- Audits of the core contracts?
- Test-vector runs (reference implementations)?
- Developer tooling (SDKs, CLIs, docs)?
- Maintenance of shared registries (the canonical ContributorNFT factory)?
- Public advocacy and documentation?

### Model 1: Protocol Guild (pure public-goods funding)
URL: https://protocol-guild.readthedocs.io, https://splits.org/blog/protocol-guild/

Protocol Guild (Ethereum Core Devs) is the canonical model:
- A self-curated membership of active contributors (Ethereum currently ~190 members across ~30 teams)
- A 0x4F...split contract on Ethereum receives donations
- Donations vest to members over time (4-year cliff-vesting is common)
- Members don't evaluate proposals; you're a member by maintaining a registry entry that's approved by peers
- **No protocol fee.** All funding comes from donations — projects that voluntarily pledge 1% of token supply, foundations (VanEck ETF donates 10% of profits), and one-off grants (Arbitrum gave $3.4M)

For PCC, this maps to:
- `PCCGuild`: self-curated registry of active protocol contributors
- Splits-style vesting contract on mainnet
- Donations voluntary, not mandated
- Members = people who ship protocol contracts, SDKs, specs, not people who run networks

Advantage: **zero coercion**. Networks that want to use the PCC protocol don't have to donate. Contributors are paid only to the extent the ecosystem feels they should be. Matches credible neutrality.

Risk: underfunded in early days. Protocol Guild only took off after Ethereum became a $300B asset.

### Model 2: Optimism RetroPGF (impact-based)
URL: https://medium.com/ethereum-optimism/retroactive-public-goods-funding-33c9b7d00f0c

RetroPGF works retroactively:
- A DAO ("Results Oracle") decides what delivered value in the last cycle
- Funds projects after the fact based on demonstrated impact
- Typical cycle: 3-6 months, $10M-$50M distributed per cycle (Optimism)

For PCC, this would require a PCC token for RetroPGF to use as the funding unit, which contradicts the "no governance token at protocol level" principle.

Hybrid option: Use USDC as the RetroPGF unit, funded by voluntary network operator donations (e.g., `pcc-network-foo` can optionally contribute 0.5% of its treasury to a rolling public-goods pool). Impact assessment by rotating committee.

### Model 3: Optional per-network treasury with bps config
Each network sets its own `treasury_bps` (basis points taken from each settlement). The treasury address is set by the network operator. Networks compete on fee policy:
- `pcc-network-zerofee`: `treasury_bps = 0`
- `pcc-network-sustainability`: `treasury_bps = 50` (0.5%) -> goes to PCCGuild
- `pcc-network-operator-funded`: `treasury_bps = 200` (2%) -> goes to the operator's own multisig

Requesters see the fee before committing; they can choose the network with the fee model they prefer.

The PROTOCOL contract just enforces the bps split mechanically. It doesn't receive any of it.

### Model 4: Quadratic funding rounds
Gitcoin-style quadratic funding rounds paid for by voluntary donors, matched by a one-off matching pool. Good for project-specific funding but less predictable.

### Recommended hybrid for PCC
Combine Models 1 + 3:
- **Protocol-level treasury: ZERO**. Hardcoded in contracts. Immutable.
- **Network-level treasury: OPTIONAL**. Network operator sets `treasury_bps` at deployment. Can be 0. Treasury address is the operator's own.
- **PCCGuild (Protocol Guild model)**: Splits-based vesting contract on Ethereum. Funded by voluntary donations from anyone (including network operators who choose to). Members are self-curated. Registry is publicly verifiable.
- **Encouraged (not required) convention**: networks that opt-in to the "Community-Supported" badge voluntarily route some percentage of their network treasury to PCCGuild.

### Fit for PCC 1-5

| Score | Rationale |
|---|---|
| **5/5** | Protocol Guild + network-optional-treasury is the credibly-neutral answer. No single treasury captures protocol value. Funding flows voluntarily based on network operator choice and community support. Matches user requirement exactly. |

## 13. Dispute resolution per network

### The design
Each network picks its arbiter. The protocol exposes an `IArbiter` interface; networks plug in their choice. A job run on `pcc-network-A` with `arbiter = Kleros` will have disputes resolved by Kleros; the same operator running a job on `pcc-network-B` with `arbiter = UMA` will have disputes resolved by UMA.

### Arbiter options

#### A. Kleros
URL: https://kleros.io, https://docs.kleros.io/products/court

- **Model**: juror-based court system. Jurors stake PNK tokens. Random selection with stake-weighted probability. Appeals double the jury size.
- **Evidence**: structured; parties submit evidence via smart contract.
- **Precedent**: A Mexican court enforced a Kleros ruling in 2023 — legal legitimacy precedent.
- **Fit for PCC**: best for human-judgment disputes ("did this 3D print meet the contract specs?"). Bad for pure-data disputes (use UMA instead).

#### B. UMA Optimistic Oracle
URL: https://docs.uma.xyz

- **Model**: optimistic — a proposer asserts a fact, a liveness period allows disputes, escalation to DVM voting if disputed.
- **Best for**: binary or numeric fact disputes ("did the delivery arrive?", "is this sensor reading within spec?").
- **Cost**: very low for uncontested proposals; moderate for contested ones.
- **Speed**: 0.5-2 hour liveness; longer if escalated.
- **Integration**: Across Protocol (bridge) is the most prominent user, securing billions in cross-chain transfers.
- **Fit for PCC**: excellent for evidence verification disputes. Default for `pcc-network-default`.

#### C. Claros Layer 5 (optimistic-challenge) — PCC's own
Based on PCC's existing Claros Trust Layer 5 design. Operators post evidence optimistically; challengers can stake to dispute; unchallenged evidence finalizes after a window. This is the PCC-native default.

#### D. User-elected jury
Each network has a pool of registered jurors (human). Disputes are randomly assigned. Networks can require jurors to have certain credentials (licensed engineer, medical-device technician, etc.) for regulated verticals.

#### E. Network operator multisig
Low-decentralization but high-speed. The network operator manually arbitrates. Acceptable for small/closed networks (e.g., a company running `pcc-network-internal` for their own robots).

#### F. EigenLayer AVS dispute-arbitration
Operators who stake ETH attest to dispute outcomes. Slashing on demonstrably wrong attestations. This is the most decentralized and economically-secure option but requires AVS bootstrap.

### Cross-network disputes
What if a job on network A has an operator registered on network B, and they disagree? Who arbitrates?

**Answer: the network where the JOB was posted arbitrates.** The job posting establishes the contract. The operator implicitly agreed to that network's arbiter when they accepted the job.

Cross-network dispute flow:
1. Requester on network A posts job, selects `pcc-network-A` (arbiter = UMA).
2. Operator on network B accepts the job. Their acceptance message crosses via LayerZero; it includes an ack of the network A arbiter.
3. Dispute arises. UMA arbitration happens on network A. Slashing of the operator's bond happens on network A (bonds are locked on network A at job-acceptance time; the operator's network B identity is linked via ContributorNFT).
4. Reputation update (bad outcome for this operator) crosses via LayerZero to network B's reputation registry.

Key invariant: **the job's arbiter is set at job-post time, not at dispute time.** This prevents arbiter-shopping.

### Fit for PCC 1-5

| Score | Rationale |
|---|---|
| **5/5** | Plug-in arbiter interface + network-level choice is the correct design. Default = UMA for speed + Claros L5 for evidence-specific, with Kleros available for human-judgment complexity. Cross-network dispute flow resolves at the job-posting network. No shared kill-switch. |

## 14. Semi-sovereign appchains (Polkadot parachains, Avalanche subnets)

### Polkadot parachains + JAM (2026)
URL: https://polkadot.network, https://polkadot.com/technology/jam

Polkadot's shared security model lets parachains inherit Relay Chain validator security without running their own validator set. The JAM (Join-Accumulate Machine) upgrade (2026) generalizes this to "services" — any computation can run on Polkadot's validator set as a service, not just parachain blocks.

- **Sovereignty per chain**: tokenomics, governance, runtime logic — fully controlled by parachain team.
- **Shared**: security (Relay Chain validators), XCM cross-chain messaging.
- **Cost**: historically ~$1-5M/year for a parachain slot lease. With JAM's services model, costs should drop significantly — pay per compute used.
- **Interop**: XCM (Cross-Consensus Messaging), native to Polkadot. Does NOT natively talk to EVM chains; requires bridges.

For PCC: overkill unless Polkadot ecosystem has a killer feature PCC needs. Would fragment from EVM developer base.

### Avalanche L1s (formerly Subnets)
URL: https://build.avax.network

After the Etna upgrade (2024-12), Avalanche L1s are "fully sovereign Layer 1s" with ~99.9% reduced launch costs (no longer need 2,000 AVAX per validator):

- **Sovereignty**: define own validator set, tokenomics, execution logic, compliance rules
- **Shared**: Avalanche subnet coordination layer, Warp Messaging for cross-L1 comms
- **Cost**: dramatically reduced post-Etna. Small operators can now run L1s.
- **Interop**: Warp Messaging within Avalanche ecosystem; external chains via bridges.
- **Regulatory-friendly**: operators can define KYC rules at L1 level (good for enterprise PCC networks)

For PCC: interesting as one of the network options. An enterprise deploying `pcc-network-pharma` (FDA-regulated, KYC-required) could launch an Avalanche L1 with baked-in compliance rules. But the protocol itself should stay EVM-multichain.

### Cosmos appchains (see section 05)

### When to use an appchain vs a contract deployment

| Situation | Appchain? |
|---|---|
| Regulatory isolation needed (e.g., sanctioned-jurisdiction compliance) | Yes — Avalanche L1 with baked-in KYC |
| Privacy-required (medical, defense) | Maybe — zkSync Hyperchain with Validium |
| High-throughput robotics control | Yes — L3 on Arbitrum Orbit or ZK Stack |
| Standard capability marketplace | No — deploy contracts on Base/Arbitrum/Polygon |
| Small network (<1k operators) | No — contracts on existing chain |

### Fit for PCC 1-5

| Score | Rationale |
|---|---|
| **2.5/5** | Semi-sovereign appchains are useful for *some* PCC networks (regulated verticals) but shouldn't be the default. Protocol stays on commodity EVM chains; specialty networks can opt into Avalanche L1 or Hyperchain if their vertical requires it. Don't build a PCC-specific appchain. |

## 15. The simple alternative: permissionless deployment on every EVM chain

### The pattern
Deploy the same contracts, at the same addresses (via CREATE2 deterministic factories), on every chain PCC wants to reach. No L2/L3 decision. No shared sequencer. No shared governance. Just:

- `PCCProtocolFactory` at `0x<deterministic>` on Base, Arbitrum, Optimism, Polygon, zkSync, Linea, Scroll, Mantle, Celo, Avalanche C-chain, Ethereum, etc.
- `ContributorNFT` (LayerZero ONFT v2) at `0x<deterministic>` on every chain
- `JobEscrow` implementation at `0x<deterministic>` on every chain
- `ArbiterInterface` on every chain, with each network picking its arbiter at deploy time

### CREATE2 deterministic addresses
URL: https://www.getfoundry.sh/guides/deterministic-deployments-using-create2

CREATE2 lets you deploy contracts to deterministic addresses based on:
- The deployer address (can be a singleton factory like Safe Proxy Factory)
- The contract bytecode
- A salt (any bytes32 you choose)

By using a canonical "Deterministic Deployment Proxy" contract at the same address on all EVM chains (it's already deployed there — it's a well-known utility), PCC can ensure that `PCCProtocolFactory` exists at THE SAME address on Ethereum mainnet, Base, Arbitrum, Polygon, zkSync, Avalanche C-chain, BSC, Celo, Scroll, Mantle, Linea, and so on.

Benefits:
- **Trust simplification**: the contract at `0x<canonical>` on any chain is provably the same bytecode.
- **UX simplification**: SDK can hardcode ONE address, works on every chain.
- **Fork-tolerance**: a fork can deploy the same contract on a new chain, and it'll work with every existing client.

### Mainnet canonical registry
One canonical chain (Ethereum mainnet) hosts:
- `pcc.eth` ENS domain
- The canonical `ContributorNFT` home (where reputation history aggregates)
- The canonical `PCCGuild` splits contract

Other chains have local copies. LayerZero cross-chain messages sync reputation to mainnet. Reads on any chain can CCIP-Read from mainnet.

### No shared chain-level governance
There is no Law of Chains, no Superchain Registry, no cross-chain multisig. Each chain is just a deployment target. The protocol contracts are immutable on each.

### What is shared vs not shared
| Shared (standards only) | Not shared (per-network decision) |
|---|---|
| `ContributorNFT` (ONFT) standard | Fee model |
| `JobReceipt` event schema | Arbiter |
| `CompositionManifest` schema | Sybil resistance / KYC policy |
| `IArbiter` interface | Operator allowlist |
| CAIP-10 address format | Gas token |
| LayerZero OApp message envelope | Chain-specific bridge preferences |

### Cost breakdown
- **Protocol development**: one-time. Audit the core contracts once ($200-500k for serious auditors).
- **Per-chain deployment**: gas only. Base deployment of PCC protocol contracts per chain: ~$50-500 in gas.
- **Maintenance**: minimal. Contracts are immutable.
- **SDK and client infra**: one codebase, deployed anywhere. ~$100k/year for a small maintainer team (funded by PCCGuild).
- **Mainnet canonical registry**: modest gas for reputation writes (~$5-50 per update, batched).

### Limitations
- No shared sequencer benefits (PCC doesn't need this)
- No single "PCC chain" brand to rally around (good for credible neutrality, neutral for marketing)
- Each new chain adds a dependency on that chain's continued existence (graceful: if a chain dies, NFTs and reputation on other chains are unaffected)

### Fit for PCC 1-5

| Score | Rationale |
|---|---|
| **5/5** | **This is the answer.** Permissionless deployment on every EVM chain + LayerZero ONFT for NFTs + CCIP/LayerZero for messages + ENS for canonical names + PCCGuild for public-goods funding. Matches every stated constraint. Practical to build. Preserves EVM ecosystem compatibility. Supports unlimited network operators with zero permission. |

## Recommendation: PCC Network Architecture

**Chosen pattern**: Permissionless multichain deployment + LayerZero ONFT v2 + optional per-network treasury + plug-in arbiter + PCCGuild public-goods funding.

### The architecture in one diagram

```
        CANONICAL REGISTRY                    NETWORK-SPECIFIC DEPLOYMENTS
        (Ethereum Mainnet)                      (on any EVM chain)
        -------------------                   ----------------------------
        pcc.eth ENS domain                  pcc-network-default (Base)
        ContributorNFT home                 - treasury_bps = 0
        PCCGuild splits                     - arbiter = UMA + Claros L5
        ERC-8004 registry                   - sybil = none
                |                           pcc-network-zerofee (Optimism)
                | sync via                   - treasury_bps = 0
                | LayerZero OApp             - arbiter = Kleros
                v                            - sybil = none
                                            pcc-network-regulated (Avalanche L1)
        CROSS-CHAIN MESSAGES                 - treasury_bps = 150 (to FDA reg fund)
        -----------------------              - arbiter = licensed engineer jury
        JobReceiptV1                         - sybil = gov ID + credential check
        ReputationUpdateV1                  pcc-network-internal (Base private L3)
        DisputeEscalatedV1                   - treasury_bps = 0 (internal use)
                                             - arbiter = company multisig
                                             - sybil = employee allowlist
```

### Deployment layers

**Layer 0 — Core protocol contracts (immutable, CREATE2-deployed on every EVM chain)**
- `PCCProtocolFactory` — deploys network instances (JobEscrow, ArbiterRegistry)
- `ContributorNFT` (LayerZero ONFT v2) — portable contributor identity
- `JobEscrow` implementation — milestone-based settlement
- `IArbiter`, `ISybilResistance`, `ITreasury` — interfaces networks implement
- `LayerZeroOApp` router — message passing

**Layer 1 — Canonical registries (Ethereum mainnet only)**
- ENS domain `pcc.eth` with CCIP Read resolvers pointing to L2 ContributorNFT data
- ERC-8004 Agent Registration File (already in use by PCC, see CLAUDE.md)
- PCCGuild splits contract
- `ContributorNFTMaster` — canonical home for reputation aggregation

**Layer 2 — Network instances (deployed by operators)**
- `PCCNetworkConfig` — sets `treasury_bps`, `treasury_address`, `arbiter`, `sybil_policy`
- Network-specific allowlists, KYC integration, pricing policy
- Can be deployed on ANY EVM chain, including permissioned L3s

**Layer 3 — Cross-chain message layer**
- LayerZero v2 for job receipts, reputation, disputes
- CCIP as fallback for enterprise-only networks
- IBC Eureka for bridging to Cosmos if needed (unlikely short-term)

**Layer 4 — Dispute resolution**
- Default: UMA Optimistic Oracle + Claros L5 (optimistic challenge)
- Opt-in: Kleros (complex human judgment)
- Regulated: licensed jury (per vertical)
- Advanced: EigenLayer AVS dispute-arbitration service (future)

**Layer 5 — Public goods funding**
- PCCGuild (Protocol Guild model) at `pccguild.eth` on mainnet
- Funded by voluntary donations from networks, foundations, individual donors
- Vests to active contributors (4-year cliff typical)
- No coercion; networks with `treasury_bps=0` are first-class citizens

### What this achieves

- **No single treasury**: protocol contracts take zero fee. Each network has optional treasury. PCCGuild is voluntary.
- **No single kill-switch**: no multisig can pause protocol contracts. No DAO votes on protocol. Each chain deployment is immutable.
- **Fork-tolerant**: if someone forks the protocol and deploys a competing ContributorNFT standard, their NFTs don't work with existing networks (incompatible standard), so forks naturally lose to the network effect of the original. If someone deploys a new NETWORK with the same protocol, that's fine and encouraged.
- **Seamless cross-network operation**: ContributorNFT portable via LayerZero ONFT, reputation synced via OApp messages, payments settle on whichever chain is cheapest, dispute arbitration follows the job posting.
- **Standards-based interop**: ContributorNFT, CompositionManifest, JobReceipt schemas are fixed; implementations plug-in.

### Concrete deployment plan

**Phase 1 — Standards finalization (Q2 2026)**
- Finalize ContributorNFT v1 spec (LayerZero ONFT v2-based)
- Finalize CompositionManifest v1 spec (reuse from existing PCC CSD)
- Finalize JobReceiptV1, ReputationUpdateV1, DisputeEscalatedV1 message schemas
- Publish as PCC-IP-1, PCC-IP-2, PCC-IP-3 (PCC Improvement Proposals)
- Get 3+ outside implementations for each spec

**Phase 2 — Core contract deployment (Q3 2026)**
- Deploy `PCCProtocolFactory`, `ContributorNFT`, `JobEscrow` at deterministic CREATE2 addresses on: Ethereum, Base, Arbitrum One, Optimism, Polygon PoS, Linea, Scroll, zkSync Era, Celo, Mantle, BSC, Avalanche C-chain, Ink
- Audit: $300k budget (Trail of Bits or similar)
- Register `pcc.eth` ENS with CCIP Read resolvers

**Phase 3 — Reference networks (Q4 2026)**
- `pcc-network-default`: Base, treasury_bps=0, arbiter=UMA+ClarosL5, sybil=none
- `pcc-network-op`: Optimism, treasury_bps=0, arbiter=Kleros, sybil=none
- `pcc-network-zerofee`: Arbitrum, treasury_bps=0, arbiter=ClarosL5, sybil=none

Document each. Open-source the network deployment scripts. Make it a 1-command deployment for new network operators.

**Phase 4 — Migration + retirement of single-chain model (Q1 2027)**
- Migrate existing PCC state from Base Sepolia single-chain 2.35%-fee model to multichain zero-fee model
- Deprecate the 2.35% fee escrow contract
- Airdrop existing ContributorNFT holders to the new standard
- Set up PCCGuild, seed with initial donations

**Phase 5 — Ecosystem expansion (2027+)**
- Encourage third parties to spin up their own PCC networks
- Document operator onboarding (how to run `pcc-network-yourname`)
- Integrate with leading wallets (MetaMask, Rabby, Coinbase Wallet) via standard NFT display

### Why not other options

- **Optimism Superchain**: forces revenue sharing; fails credible neutrality.
- **zkSync Hyperchains**: good sovereignty, but ZK focus limits EVM NFT ecosystem access.
- **Arbitrum Orbit**: good option for a specific network, not the whole protocol.
- **Polygon CDK / Agglayer**: Agglayer adds a light governance overlay; unnecessary complexity.
- **Cosmos / IBC**: philosophically perfect but EVM ecosystem incompatible.
- **Dedicated appchain** (Polkadot / Avalanche L1 / custom): premature; hurts ecosystem access; delays shipping.

### Open questions for implementation

1. **Canonical gas sponsor for cross-chain messaging**: who pays LayerZero fees when a reputation update crosses from settlement network to canonical registry? Likely the network operator bakes this into their `treasury_bps` or eats the cost as part of operating the network.

2. **Reputation merge conflicts**: if the same contributor acts badly on two networks simultaneously, do their reputations propagate atomically? Probably eventually-consistent with timestamped updates is fine.

3. **NFT recovery if a chain dies**: if Polygon PoS were to be deprecated, contributors whose ContributorNFT is on Polygon would need a migration path. Standard: their ContributorNFT, being LayerZero ONFT v2, can burn on Polygon and mint on any other supported chain at any time (already supported by ONFT standard).

4. **Slashing and operator bonds across networks**: an operator with a bond on network A takes a job on network B. Dispute on B. Slashing on B fails (no bond). Cross-chain slashing is hard; likely solution is to require operators to have bonds on each network they accept jobs on, OR have a global bond contract that any network can slash against (runs on mainnet, expensive but clean).

5. **Anti-Sybil across networks**: a bad actor may mint ContributorNFTs from many addresses to farm reputation. Mitigation: Human Passport integration at the `pcc.eth` registration layer (optional per-network).

6. **Legal entity wrapping**: networks may want a legal entity wrapper (LLC, Liechtenstein Stiftung, etc.). Protocol remains entity-less. Networks can wrap themselves.

### Summary table

| Requirement | Met? | By |
|---|---|---|
| No single treasury | YES | Protocol contracts take zero fee |
| Anyone can spin up pcc-network-foo | YES | PCCProtocolFactory is permissionless |
| Custom treasury per network (incl. zero) | YES | Network sets `treasury_bps` at deploy |
| Seamless cross-network operation | YES | LayerZero ONFT + cross-chain messages |
| No single-org kill-switch | YES | Protocol contracts immutable on every chain |
| Standards-based interop | YES | ContributorNFT, CompositionManifest, JobReceipt |
| Operator can run on net-A, get paid for job on net-B | YES | ContributorNFT portable + cross-chain settlement |

---

## Sources

- [Optimism Superchain interop explainer](https://docs.optimism.io/interop/explainer)
- [OP Stack Interop Specification](https://specs.optimism.io/interop/overview.html)
- [SuperchainWETH / ETH Shared Lockbox](https://docs.optimism.io/stack/interop/superchain-weth)
- [zkSync ZK Stack Overview](https://docs.zksync.io/zk-stack)
- [ZKsync Chains](https://docs.zksync.io/zk-stack/zk-chains)
- [Introducing the ZK Stack](https://blog.matter-labs.io/introducing-the-zk-stack-c24240c2532a)
- [Arbitrum Orbit](https://arbitrum.io/orbit)
- [Arbitrum Orbit AnyTrust Chains](https://blog.arbitrum.io/arbitrum-orbit-anytrust-chains/)
- [Polygon CDK](https://polygon.technology/polygon-cdk)
- [Polygon CDK Docs](https://docs.polygon.technology/cdk/)
- [Cosmos IBC](https://cosmos.network/ibc)
- [IBC Eureka](https://cosmos.network/ibc-eureka)
- [EigenLayer AVS list](https://app.eigenlayer.xyz/avs)
- [Karak / Symbiotic / EigenLayer comparison](https://unchainedcrypto.com/eigenlayer-competitors-symbiotic-karak/)
- [Vitalik credible neutrality original essay (Nakamoto 2020)](https://nakamoto.com/credible-neutrality/)
- [Credible neutrality as a guiding principle (Messari)](https://messari.io/report/credible-neutrality-as-a-guiding-principle)
- [Legally Credible Neutrality on Ethereum (Barczentewicz SSRN)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5029164)
- [LayerZero ONFT v2](https://docs.layerzero.network/v2/developers/evm/onft/quickstart)
- [LayerZero v2 OApp](https://docs.layerzero.network/v2/developers/evm/oapp/overview)
- [Chainlink CCIP](https://chain.link/cross-chain)
- [Chainlink CCT standard](https://docs.chain.link/ccip/concepts/cross-chain-token)
- [Hyperlane](https://www.hyperlane.xyz)
- [Hyperlane Sovereign Consensus](https://medium.com/hyperlane/wut-hyperlane-wut-sovereign-consensus-with-ugly-pictures-f96c479e3a00)
- [Axelar GMP](https://docs.axelar.dev/dev/general-message-passing/overview/)
- [Wormhole NFT bridge whitepaper](https://github.com/wormhole-foundation/wormhole/blob/main/whitepapers/0006_nft_bridge.md)
- [ENS CCIP Read](https://docs.ens.domains/resolvers/ccip-read/)
- [ENS L2/Offchain Resolution](https://docs.ens.domains/learn/ccip-read/)
- [Safe + Zodiac multisig governance](https://docs.tally.xyz/set-up-and-technical-documentation/using-governor-with-gnosis-safe/zodiac-governor-module-for-subdaos-and-grants-programs)
- [Human Passport (formerly Gitcoin)](https://passport.human.tech)
- [Kleros dispute resolution](https://kleros.io)
- [Kleros whitepaper](https://kleros.io/whitepaper.pdf)
- [UMA Optimistic Oracle](https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work)
- [Optimism RetroPGF explainer](https://medium.com/ethereum-optimism/retroactive-public-goods-funding-33c9b7d00f0c)
- [Protocol Guild](https://protocol-guild.readthedocs.io/en/latest/)
- [Protocol Guild using Splits](https://splits.org/blog/protocol-guild/)
- [Avalanche L1 sovereignty (Etna)](https://build.avax.network/blog/etna-enhancing-sovereignty-avalanche-l1s)
- [Polkadot JAM roadmap](https://polkadot.com/technology/jam)
- [ERC-8004 Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004)
- [CREATE2 deterministic deployments (Foundry)](https://www.getfoundry.sh/guides/deterministic-deployments-using-create2)
- [Cross-chain messaging comparison (BlockEden 2025)](https://blockeden.xyz/blog/2025/07/28/cross-chain-messaging-and-shared-liquidity/)

