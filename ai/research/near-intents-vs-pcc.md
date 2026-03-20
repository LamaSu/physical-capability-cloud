# NEAR Intents vs. Physical Capability Cloud (PCC) — Deep Comparison

**Date:** 2026-03-19
**Context:** Both systems use intent-based architectures but for fundamentally different domains. NEAR Intents is "The Universal Transaction Layer for the AI Economy" — digital asset swaps across 31+ chains. PCC is "AWS for the Physical World" — a cloud control plane for physical manufacturing capabilities with on-chain settlement.

---

## Executive Summary

These two systems share a surprising amount of architectural DNA — intent-based request models, solver/broker competition, multi-agent coordination, escrow settlement, evidence/verification layers, and privacy primitives. But they target opposite ends of the digital-physical spectrum. NEAR Intents settles fungible digital asset swaps in seconds; PCC orchestrates multi-step physical manufacturing workflows that take hours or days. The comparison reveals complementary strengths and potential integration points.

---

## 1. Intent Model

### What "Intent" Means

| Dimension | NEAR Intents | PCC |
|-----------|-------------|-----|
| **Core expression** | "I want X tokens for Y tokens" | "I want this part manufactured to this spec" |
| **Intent format** | `token_diff` — signed JSON with exact amounts | `CWM` (Capability Work Manifest) — DAG of typed manufacturing steps |
| **Complexity** | Simple: one token pair, one atomic swap | Complex: multi-step workflows with dependencies, tolerances, materials |
| **Determinism** | Fully deterministic outcomes (exact token amounts) | Probabilistic outcomes (physical processes have variance) |
| **Time horizon** | Seconds to minutes | Hours to weeks |
| **Reversibility** | Atomic — all or nothing | Milestone-based — partial completion is valid |

### Intent Types

**NEAR Intents** has 9 intent types, all financial:
- `token_diff`, `transfer`, `ft_withdraw`, `nft_withdraw`, `mt_withdraw`, `native_withdraw`, `add_public_key`, `remove_public_key`, `storage_deposit`

**PCC** has 20+ intent types spanning the full lifecycle:
- **Discovery**: `discover_capabilities`, `capabilities_response`, `discover_hubs`, `hubs_response`
- **Negotiation**: `request_quote`, `quote_response`, `negotiate`, `negotiation_response`
- **Execution**: `submit_workflow`, `workflow_accepted`, `job_status_query`, `job_status_response`, `job_completed`
- **Payment**: `payment_request`, `payment_confirmation`, `escrow_funded`
- **Logistics**: `request_courier`, `courier_assigned`, `courier_status`
- **Verification**: `request_verification`, `verification_result`

### Key Insight

NEAR Intents optimizes for a single primitive (token exchange) executed at massive scale. PCC models a full-lifecycle workflow with heterogeneous steps. NEAR's simplicity enables sub-second settlement; PCC's richness captures real-world manufacturing complexity.

---

## 2. Architecture Comparison

### Component Mapping

| Function | NEAR Intents | PCC |
|----------|-------------|-----|
| **Settlement contract** | `intents.near` (Rust/WASM, NEAR chain) | `MilestoneEscrow.sol` (Solidity, Base/EVM) |
| **Routing/matching** | Solver Bus (WebSocket relay) | `CapabilityRouter` + `BrokerAgent` |
| **Message transport** | WebSocket JSON-RPC | `MessageBus` (in-memory pub/sub) + Gateway SSE |
| **Worker nodes** | Solvers (off-chain market makers) | Shop Kernels (physical sites with equipment) |
| **Verification** | Verifier contract (signature validation) | `VerifierMarket` + `EvidenceVerifier` + `ZKProofService` |
| **Privacy** | Confidential Intents (TEE private shard) | `EncryptionService` (AES-256-GCM) + Lit Protocol |
| **Cross-chain** | Chain Signatures (MPC) | x402 protocol + EVM settlement |
| **Agent framework** | Simple add_public_key delegation | Full multi-agent system (BaseAgent, 4 agent types, AgentWallet) |
| **API gateway** | 1Click REST API | Fastify gateway (20+ routes, SIWE auth, x402 gate) |
| **Dashboard** | None (third-party explorers) | Full SPA: 45+ routes, React Flow builders, live sensor monitoring |
| **Type system** | Ad-hoc JSON payloads | 400+ typed interfaces, Zod schemas, canonical hashing |

### Internal Accounting vs. Milestone Escrow

**NEAR Intents** uses an **internal ledger model**:
- All assets deposited into `intents.near` are tracked as internal balances
- Swaps are ledger updates (no tokens actually move on-chain during a swap)
- Zero-sum constraint: all token_diffs in a batch must sum to zero
- Settlement is instantaneous and atomic

**PCC** uses a **milestone escrow model**:
- Funds locked in `MilestoneEscrow.sol` on Base chain
- Released incrementally as milestones are completed with evidence
- 4 assurance tiers with escalating bonds (0% → 5% → 15% → 25%) and challenge windows (1hr → 4hr → 24hr → 72hr)
- Settlement spans the full job lifecycle — could be days

| Settlement Aspect | NEAR Intents | PCC |
|-------------------|-------------|-----|
| Speed | Sub-second | Hours to days |
| Granularity | All-or-nothing per batch | Per-milestone |
| Dispute mechanism | None built-in (trust the math) | Challenge windows + ZK proofs + arbiter agents |
| Collateral | Solver pre-funds Verifier | Bond deposits per assurance tier |
| Currency | Any supported token | USDC (MockUSDC in dev) |

---

## 3. Solver/Broker Architecture

### NEAR Intents: Competing Solvers

- **Model**: Open competition — solvers race to fill orders within 3 seconds
- **Entry**: Permissionless — anyone can connect to the Solver Bus
- **Incentive**: Spread between user's requested price and execution price
- **Inventory**: Solvers pre-fund the Verifier and manage their own inventory
- **Intelligence**: Off-chain optimization (routing, MEV extraction, rebalancing)
- **Number**: Unlimited concurrent solvers per asset pair

### PCC: Broker + Router

- **Model**: Intelligent routing — BrokerAgent + CapabilityRouter score and match
- **Entry**: Kernel registration (publish capabilities, reputation tracked)
- **Incentive**: Job completion fees, DePIN rewards, reputation building
- **Inventory**: Physical equipment (machines, instruments, sensors)
- **Intelligence**: NLP understanding of requests, multi-factor scoring (0.3×price + 0.3×queue + 0.3×rep + 0.5×preferBonus)
- **Number**: Limited by physical infrastructure

### Key Difference

NEAR solvers are **fungible** — any solver with inventory can fill any order. PCC kernels are **differentiated** — a CNC-5axis kernel cannot fill an SLS request. This means PCC routing is a constraint-satisfaction problem, not just a price auction.

---

## 4. Evidence & Verification

This is where PCC dramatically exceeds NEAR Intents in depth.

### NEAR Intents: Cryptographic Verification Only

- Validates signatures (NEP-413, ERC-191, BIP-322, etc.)
- Checks zero-sum constraint on token diffs
- No concept of "evidence" — the math IS the proof
- No dispute resolution (atomic settlement eliminates the need)

### PCC: Full Evidence Pipeline

- **20+ evidence event types**: sensor data, CV inspections, power profiles, dimensional measurements, calibration records, chromatography results
- **Evidence bundles**: Cryptographically hashed collections of events, per-step
- **Tier requirements**: Escalating evidence demands per assurance level
  - Tier 0: Self-attested (minimal evidence)
  - Tier 1: Sensor-verified (machine telemetry)
  - Tier 2: CV-inspected + third-party verified
  - Tier 3: Full audit trail + bonded + extended challenge window
- **Encryption**: AES-256-GCM envelope encryption with per-recipient key capsules
- **Commitments**: Merkle tree commitments for batched evidence
- **ZK proofs**: Prove evidence inclusion or tier compliance without revealing data
- **Dispute settlement**: Challenger submits ZK proof → operator counter-proof → arbiter rules

### Evidence Flow (PCC)

```
Machine executes step
  → Sensors emit readings (SensorPipeline: ring buffer, LTTB downsample, anomaly detection)
  → Camera does CV inspection (MockCameraAdapter)
  → Power monitor records energy profile
  → EvidenceEmitter hashes each event, creates bundle
  → EncryptionService encrypts bundle (AES-256-GCM)
  → CommitmentService creates Merkle commitment
  → Bundle stored (IPFS/Helia/Storacha)
  → Commitment anchored on-chain
  → Milestone released from escrow IF evidence meets tier requirements
```

Nothing remotely like this exists in NEAR Intents — because digital token swaps don't need physical evidence. But this is precisely what makes PCC's intent model fundamentally harder.

---

## 5. Agent Architecture

### NEAR Intents: Lightweight Delegation

- Agents are just signers — they construct intents and submit them
- `add_public_key` / `remove_public_key` for delegation
- No built-in agent framework — use any language/framework
- NEAR AI Agent Market: natural-language task posting + agent bidding (Feb 2026)
- IronClaw Runtime: TEE enclaves for confidential agent execution
- **Agent capabilities**: swap tokens, manage portfolios, execute DeFi strategies

### PCC: Full Multi-Agent System

- **4 specialized agent types**: UserAgent, BrokerAgent, KernelAgent, VerifierAgent (planned)
- **BaseAgent abstract class**: id, name, role, wallet, bus, tools, intentHandlers
- **AgentWallet**: Full viem-based wallet with signMessage, getBalance, approveToken, fundEscrow, callContract
- **SolanaAgentWallet**: Cross-chain wallet support
- **SpendingPolicy**: Per-agent spend limits and approval rules
- **MessageBus**: Typed pub/sub with conversations, intent routing, agent discovery
- **A2A Protocol**: 27+ typed intents with role-based routing
- **Agent capabilities**: discover capabilities, negotiate contracts, submit workflows, manage jobs, emit evidence, coordinate logistics, resolve disputes

### Comparison Table

| Dimension | NEAR Intents Agents | PCC Agents |
|-----------|-------------------|------------|
| Complexity | Signer with key pair | Full runtime with wallet, bus, tools, handlers |
| Roles | Generic (any agent can do anything) | Specialized (user, broker, kernel, verifier, courier, arbiter) |
| Communication | Via Solver Bus (simple quote/publish) | Via MessageBus (27+ typed intents, conversations) |
| Wallet | External (any NEAR/EVM/SOL wallet) | Built-in AgentWallet (viem, multi-chain) |
| Autonomy | Fully autonomous financial agents | Autonomous within role constraints + spending policies |
| Discovery | N/A (solvers always available) | Agent discovery via MessageBus.findByIntent() |
| Conversations | None (stateless request/response) | Full conversation threads with history |

---

## 6. Cross-Chain Strategy

### NEAR Intents: MPC Chain Signatures

- **31+ chains** supported via MPC (no bridges)
- Key shares distributed across NEAR validators/MPC nodes
- Threshold cooperation to sign transactions on any chain
- Yield-and-resume for multi-block async signing
- PoA Bridge for asset custody
- **Goal**: Any token on any chain, swappable in seconds

### PCC: EVM-Centric with x402

- **Primary settlement**: Base chain (EVM)
- **x402 protocol**: HTTP-native micropayments (request → 402 → pay → retry)
- **Starknet ZK anchoring**: `StarknetProofAnchoringService` for proof commitment
- **IPFS/Storacha**: Decentralized evidence storage
- **Solana**: `SolanaAgentWallet` for cross-chain agent operations
- **Goal**: Physical-world settlement with crypto guarantees

### Key Difference

NEAR Intents treats cross-chain as its core value prop — seamless asset movement across heterogeneous chains. PCC treats on-chain settlement as a trust layer for physical-world operations — the chain is infrastructure, not the product.

---

## 7. Privacy Architecture

### NEAR Intents: Confidential Intents (TEE)

- Launched Feb 25, 2026
- Transactions encrypted locally → routed through private NEAR shard → TEE bridge to mainnet
- Validators verify without seeing amounts/routes/balances
- **Hides**: Asset amounts, routing paths, wallet balances, trade strategy
- **Preserves**: Verifiable execution, auditability (selective disclosure), atomicity
- **Purpose**: Prevent frontrunning and strategy replication

### PCC: Encryption + ZK + Lit Protocol

- **AES-256-GCM** envelope encryption for evidence bundles
- **Per-recipient KeyCapsules** (ECIES-wrapped AES keys)
- **AccessGrant** system with expiration and revocation
- **Lit Protocol** integration for decentralized access control
- **ZK proofs** for selective disclosure:
  - `evidence_inclusion`: Prove a specific event exists in a bundle without revealing other events
  - `tier_compliance`: Prove evidence meets tier requirements without revealing data
  - `data_integrity`: Prove data hasn't been tampered with
  - `selective_disclosure`: Reveal specific fields while hiding others
- **Purpose**: Protect trade secrets in manufacturing while enabling dispute resolution

### Comparison

| Aspect | NEAR Intents | PCC |
|--------|-------------|-----|
| What's protected | Financial transaction details | Manufacturing evidence (sensor data, processes, recipes) |
| Encryption scope | Entire transaction | Per-bundle, per-recipient granularity |
| Selective disclosure | Post-finalization proofs to regulators | ZK proofs for disputes without revealing full evidence |
| Access control | Chain-level (TEE shard) | Application-level (Lit Protocol + key capsules) |
| ZK purpose | None currently | Dispute settlement, compliance proof |

---

## 8. Type System & Data Model

### NEAR Intents: Minimal

- JSON payloads with ad-hoc structure
- NEP-245 token IDs (string prefixes: `nep141:`, `nep171:`)
- Nonces (256-bit base64)
- Deadlines (ISO timestamps)
- No formal schema validation (contract validates on-chain)

### PCC: Extremely Rich

- **400+ TypeScript interfaces** across 17 packages
- **Zod schema validation** for all types at runtime
- **Canonical hashing** (SHA-256) with deterministic JSON serialization
- **ID generation** with typed prefixes (cwm_, step_, kernel_, cap_, job_, evidence_, etc.)
- **17 capability types** (fdm, sla, sls, mjf, cnc-3axis, cnc-5axis, lathe, laser-cut, waterjet, sheet-metal, injection-mold, assembly, inspection, courier-pickup, courier-delivery, custom)
- **Physical units** (30+ PhysicalUnit types: degC, Pa, W, N, mL/min, nm, pH, ppm...)
- **Sensor data types** (scalar, vector, spectrum, image, waveform, boolean, string, matrix, histogram)
- **Assurance tiers** (0-3 with escalating requirements)
- **Evidence events** (36+ types covering machine, sensor, instrument, batch, encryption, ZK)

### Why This Matters

NEAR Intents can get away with minimal types because digital assets are inherently simple — a token has an amount and an address. PCC must model the full complexity of physical reality: tolerances, materials, sensor readings, process parameters, environmental conditions, quality metrics.

---

## 9. Scaling Model

| Dimension | NEAR Intents | PCC |
|-----------|-------------|-----|
| **Bottleneck** | Chain throughput (solved by Nightshade sharding) | Physical machine capacity |
| **Theoretical max** | 1M+ TPS (Nightshade 3.0) | Bounded by real-world infrastructure |
| **Current volume** | $1.8B+, 3.6M swaps | Pre-production (hackathon stage) |
| **Scaling strategy** | More shards, more MPC nodes | More kernels (physical sites joining network) |
| **Network effects** | More solvers → better prices → more users | More kernels → more capabilities → more workflows |
| **Marginal cost** | Near-zero per additional swap | Real-world costs (materials, energy, labor) |

---

## 10. Token Economics

### NEAR Intents

- NEAR = gas for all transactions
- Protocol fee: 0.0001% per tx
- Buy-and-burn: Intents revenue burns NEAR 2x faster than inflation → net deflationary
- Solvers earn spread between quoted and execution prices
- Partners get 50/50 revenue sharing

### PCC

- **MilestoneEscrow**: USDC locked per job, released on milestone completion
- **Capability NFTs (cNFTs)**: Soulbound certificates proving machine capabilities (`CapabilityCertificateService`)
- **DePIN Rewards**: Epoch-based rewards for kernel operators (`RewardEngine`)
- **x402 micropayments**: HTTP-native pay-per-request for digital microservices
- **Bonding**: Assurance tier bonds (5-25% of job value)

### Key Difference

NEAR Intents has a mature token flywheel (volume → fees → burns → scarcity → price). PCC has a more complex multi-token model where value accrues to kernel operators (DePIN rewards), capability holders (cNFTs), and the protocol (escrow fees).

---

## 11. Philosophical Differences

| Aspect | NEAR Intents | PCC |
|--------|-------------|-----|
| **Metaphor** | "Universal Transaction Layer" | "AWS for the Physical World" |
| **Cloud analogy** | Payment processor (Stripe for crypto) | Cloud provider (AWS/GCP for manufacturing) |
| **What it abstracts** | Chain complexity, bridging, gas | Machine complexity, process management, quality assurance |
| **Trust model** | Math (zero-sum proofs, atomic settlement) | Evidence (sensor data, CV inspections, ZK proofs) |
| **Time model** | Instant (sub-second settlement) | Extended (hours/days for physical processes) |
| **Failure mode** | Transaction reverts (no harm) | Partial completion, material waste, quality defects |
| **User** | Traders, DeFi users, AI agents | Manufacturers, labs, engineers, equipment operators |
| **Value prop** | Best execution price across all chains | Guaranteed physical output with cryptographic evidence |

---

## 12. Integration Opportunities

Where PCC could leverage NEAR Intents:

### 12a. Cross-Chain Settlement

PCC currently settles on Base (EVM only). NEAR Intents could enable:
- Users paying for manufacturing jobs in **any token on any chain** (BTC, SOL, TRON, etc.)
- Automatic conversion to USDC for escrow funding
- Multi-chain payout to kernel operators in their preferred currency

**Implementation**: Replace `AgentWallet.fundEscrow()` with a NEAR Intents 1Click deposit that converts any input token to USDC on Base → funds MilestoneEscrow.

### 12b. AI Agent Market Integration

NEAR AI Agent Market already supports "physical services" as a task type. PCC could:
- Register PCC capabilities in the NEAR Agent Market
- Accept manufacturing intents posted as natural-language tasks
- Bridge between NEAR's task-posting model and PCC's structured CWM format

### 12c. Cross-Chain Evidence Anchoring

PCC already has `StarknetProofAnchoringService`. NEAR's chain signatures could:
- Anchor evidence commitments to **any chain** (not just Starknet)
- Let users verify evidence on their preferred chain
- Use NEAR as a universal commitment layer

### 12d. Solver-as-Broker

NEAR Intents' solver model could inspire PCC enhancements:
- Open competition for job routing (currently centralized through BrokerAgent)
- Market-making for manufacturing capacity (solvers maintain "inventory" of available machine time)
- 3-second quoting windows for standardized capabilities (e.g., FDM prints with standard materials)

---

## 13. Where PCC Goes Beyond

### Physical Reality

NEAR Intents operates in a clean digital world where assets are fungible and settlement is atomic. PCC must handle:

- **Non-fungible outputs**: A CNC part is not interchangeable with another CNC part
- **Process variance**: Physical processes have tolerances, defect rates, environmental sensitivity
- **Temporal complexity**: A 5-step workflow might span days with dependencies
- **Custody chains**: Materials move physically between sites (`CustodyEvent`)
- **Sensor data**: Real-time telemetry from machines (temperature, pressure, vibration, UV absorbance)
- **Batch processing**: Multiple users' samples in one instrument run (`BatchManifest`, `SampleSlot`)
- **Quality assurance**: CV inspection, dimensional verification, spectral analysis
- **Logistics**: Courier pickup/delivery between kernels
- **Equipment lifecycle**: Device birth/death, calibration, maintenance

### Evidence as First-Class Primitive

In NEAR Intents, the transaction IS the proof. In PCC, evidence must be:
- **Collected** (from sensors, cameras, instruments)
- **Processed** (downsampled, aggregated, anomaly-detected)
- **Bundled** (per-step, with canonical hashing)
- **Encrypted** (per-recipient, with granular access control)
- **Committed** (Merkle tree on-chain)
- **Provable** (ZK proofs for disputes)
- **Stored** (IPFS/Helia/Storacha, decentralized)

This 7-stage evidence pipeline has no analog in any intent-based DeFi protocol.

### Assurance Tiers

PCC's 4-tier assurance model is unique:

| Tier | Bond | Challenge Window | Evidence Required | Use Case |
|------|------|-----------------|-------------------|----------|
| 0 | 0% | 1 hour | Self-attested | Low-value, trust-based |
| 1 | 5% | 4 hours | Sensor-verified | Standard manufacturing |
| 2 | 15% | 24 hours | CV-inspected + third-party | Precision work |
| 3 | 25% | 72 hours | Full audit + bonded | Aerospace/medical/regulated |

Nothing in NEAR Intents requires this graduated trust model because digital assets don't have quality grades.

---

## 14. Where NEAR Intents Goes Beyond

### Scale & Maturity

- **$1.8B+ in volume** vs. PCC's pre-production state
- **3.6M+ transactions** vs. PCC's e2e simulations
- **31+ chains** vs. PCC's EVM-only settlement
- **Mainnet-deployed** contract vs. PCC's hackathon-stage code
- **Ecosystem**: THORSwap, SwapKit, Infinex, KyberSwap vs. PCC has no external integrations yet

### Chain Abstraction

NEAR's MPC chain signatures are a genuinely novel cryptographic primitive. PCC's cross-chain story is limited to:
- EVM settlement (Base)
- Starknet proof anchoring
- Solana agent wallet
- x402 micropayments

NEAR can sign transactions on **any chain** without bridges.

### Confidential Intents

The TEE private shard model — where validators verify without seeing data — is architecturally more elegant than PCC's application-level encryption. Though PCC's approach has advantages in granularity (per-field selective disclosure via ZK).

### Developer Ecosystem

- 3 integration levels (1Click API, SDK, direct contract)
- React widget for instant frontend integration
- SDKs in TypeScript, Go, Rust, Python
- Active Telegram support channel
- Partner Portal with revenue sharing

PCC has rich internal tooling but no external developer ecosystem yet.

---

## 15. Summary Matrix

| Dimension | NEAR Intents | PCC | Winner |
|-----------|-------------|-----|--------|
| Intent expressiveness | Simple (token diffs) | Rich (multi-step workflows) | PCC |
| Settlement speed | Sub-second | Hours-days | NEAR |
| Cross-chain reach | 31+ chains, bridgeless | EVM-centric | NEAR |
| Evidence/verification | Signature validation only | Full pipeline (sensors→ZK) | PCC |
| Agent sophistication | Lightweight delegation | Full multi-agent system | PCC |
| Privacy architecture | TEE private shard | Encryption + ZK per-bundle | Tie (different strengths) |
| Type safety | Minimal | 400+ types + Zod schemas | PCC |
| Scale/maturity | $1.8B volume, mainnet | Pre-production, simulations | NEAR |
| Physical world modeling | None | Deep (sensors, batches, custody) | PCC |
| Token economics | Mature flywheel | Multi-token design | NEAR (maturity) |
| Developer ecosystem | SDKs, widget, docs, partners | Internal tooling only | NEAR |
| Regulatory readiness | AML/compliance screening | 22 compliance framework mapping | PCC |
| Dashboard/UX | None (third-party) | 45+ route SPA | PCC |

---

## 16. Conclusion

**NEAR Intents** and **PCC** are not competitors — they're complementary systems operating at different layers of the same stack. NEAR Intents is a **financial settlement primitive** — it moves value across chains with atomic guarantees. PCC is a **physical capability orchestrator** — it coordinates real-world manufacturing with cryptographic evidence.

The most interesting opportunity is **integration**: using NEAR Intents as PCC's cross-chain payment rail (any token → USDC → escrow), while PCC provides NEAR's AI Agent Market with actual physical-world capability fulfillment. NEAR handles the money; PCC handles the work.

Together, they could enable a workflow like:
1. User posts "I need 100 titanium brackets to aerospace spec" as a NEAR AI Agent Market task
2. PCC BrokerAgent bids on the task via NEAR Intents
3. User pays in BTC → NEAR Intents converts to USDC → PCC MilestoneEscrow
4. PCC orchestrates: CNC-5axis kernel executes → sensors emit evidence → CV inspects → ZK proves compliance
5. Milestones release incrementally as evidence meets Tier 3 requirements
6. Final payment converted via NEAR Intents to operator's preferred chain/token

That's the full stack: intent → settlement → orchestration → execution → evidence → payment.
