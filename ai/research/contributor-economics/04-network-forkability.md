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

