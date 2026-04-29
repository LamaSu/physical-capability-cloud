# PCC Standards Taxonomy — Exhaustive Hierarchical Requirements Tree

**Generated**: 2026-04-02
**Purpose**: Complete standards map from vision-level goals to protocol-level granularities for the Physical Capability Cloud
**Research basis**: standards-landscape.md (40+ standards), agent-harness-standards.md (30+ frameworks)

---

## L0: VISION — AWS for the Physical World

A distributed marketplace where AI agents discover, negotiate, and orchestrate physical capabilities on hardware at hubs, with cryptographic proof of work, fair settlement, and autonomous operation.

---

## L1: STRATEGIC PILLARS (6)

### L1.1 — TRUST & IDENTITY
Establish who/what every actor is, prove it cryptographically, track reputation over time.

### L1.2 — CAPABILITY MARKETPLACE
Standardized discovery, pricing, negotiation, and allocation of physical capabilities across a distributed network of hubs.

### L1.3 — AGENT ORCHESTRATION & SAFETY
Harness every AI agent with typed permissions, operational envelopes, segregation of duties, and fail-safe physical safety.

### L1.4 — EVIDENCE & COMPLIANCE
Cryptographic proof that physical work was done correctly, meeting regulatory requirements across verticals.

### L1.5 — SETTLEMENT & ECONOMICS
Fair, transparent, on-chain settlement with milestone escrow, dispute resolution, and protocol-level incentive alignment.

### L1.6 — EQUIPMENT INTEROPERABILITY
Standard protocols for communicating with physical hardware across manufacturing, lab, robotics, and logistics domains.

---

## L2: DOMAINS (24)

### L1.1 — TRUST & IDENTITY

#### L2.1.1 — Agent Identity
- Every agent (user, broker, kernel, verifier, courier, arbiter) has a unique, cryptographically verifiable identity
- Standards: W3C DIDs v1.1, ERC-8004 Identity Registry, SPIFFE/SPIRE, did:pkh
- Requirements:
  - L3: DID Document with public keys, auth methods, service endpoints
  - L3: AgentCard at `/.well-known/agent-card.json` (Google A2A v0.3 format)
  - L3: Agent Registration File at `/.well-known/agent-registration.json` (ERC-8004)
  - L3: Short-lived credentials via SPIFFE SVIDs (auto-rotated)
  - L3: Certificate chain: Root CA → Intermediate (per-operator) → Device cert → Agent cert

#### L2.1.2 — Machine/Equipment Identity
- Every physical device has a verifiable identity traceable to its manufacturer
- Standards: X.509 certificates, TPM 2.0, FIDO2 attestation model, did:ion
- Requirements:
  - L3: Hardware-attested identity (manufacturer-signed attestation key)
  - L3: Equipment DID: `did:pcc:device:{operator_id}:{device_id}`
  - L3: Calibration credential (VC) with IPFS-anchored calibration proof
  - L3: Firmware version tracking in identity metadata
  - L3: TPM PCR measurements for Tier 3 platform attestation

#### L2.1.3 — Operator Identity
- Human operators (shop owners, lab managers) have verified identities with qualifications
- Standards: W3C VCs 2.0, did:web, did:pkh, EU eIDAS 2.0
- Requirements:
  - L3: Operator DID derived from Ethereum wallet address (did:pkh)
  - L3: VCs for: equipment certifications, safety training, insurance, business licenses
  - L3: KYC/KYB integration for regulated verticals (pharma, aerospace, defense)
  - L3: Operator policy document (approval modes, trust gates, rate limits, pricing rules)

#### L2.1.4 — Reputation System
- Evidence-based, on-chain, portable reputation across the network
- Standards: ERC-8004 Reputation Registry, stigmergic coordination patterns
- Requirements:
  - L3: Score range 0-1000, starting at 500
  - L3: Scoring events: job_completed (+10-50), dispute_won (+20), dispute_lost (-50), bond_slashed (-100 to -500)
  - L3: Per-tag reputation (e.g., `assurance:tier-2`, `quality:95`, `cnc-3axis`)
  - L3: Reputation decay for inactivity (configurable half-life)
  - L3: Cold-start mechanism (new operators gated to Tier 0/1)
  - L3: Anti-sybil measures (minimum stake, identity verification)

#### L2.1.5 — Trust Frameworks
- Governance layers that define trust relationships and policies
- Standards: Trust over IP (ToIP) 4-layer stack, TRQP v2.0
- Requirements:
  - L3: Layer 1 (trust roots): did:key + did:pcc
  - L3: Layer 2 (messaging): NaCl-box encrypted P2P
  - L3: Layer 3 (credentials): Evidence VCs + capability attestations
  - L3: Layer 4 (governance): Assurance tier definitions, dispute rules, SWF voting

---

### L1.2 — CAPABILITY MARKETPLACE

#### L2.2.1 — Capability Definition Standard (CSD)
- Declarative, versioned schema for what a machine can do
- Standards: FHIR lifecycle (base/profile/extension), OPC-UA Companion Specs, SiLA 2 Features, MTConnect vocabulary
- Requirements:
  - L3: CSD schema: type, materials, tolerances, envelope, assurance tiers, pricing model, availability
  - L3: FHIR-style lifecycle: draft → active → retired
  - L3: Versioning with derivation (profiles extend base CSDs)
  - L3: Equipment taxonomy: 15+ categories (additive, subtractive, forming, bio-chemical, inspection, logistics, etc.)
  - L3: Material specifications with traceability (GS1 standards)
  - L3: Tolerance specifications per ISO GPS (Geometrical Product Specifications)

#### L2.2.2 — Discovery & Routing
- Decentralized capability discovery across the network
- Standards: P2P DHT (WebSocket gossip), Google A2A AgentCard, mDNS (local), TRQP (trust registry queries)
- Requirements:
  - L3: Ed25519-signed capability announcements with TTL
  - L3: Multi-attribute query: type, material, price range, assurance tier, location, availability
  - L3: Bootstrap node architecture (gateway as initial peer)
  - L3: Geographic routing with configurable radius
  - L3: Reputation-weighted ranking in discovery results

#### L2.2.3 — Pricing & Negotiation
- Dynamic, transparent pricing with multiple mechanisms
- Standards: Double auction (CDA), combinatorial auction, Uber surge model, Meteora DLMM
- Requirements:
  - L3: Base pricing model: baseCost + perMinute + perGram + minimum
  - L3: Operator pricing rules: volume_discount, batch_discount, rush_surcharge, offpeak_discount, material_markup, loyalty_discount
  - L3: Dynamic pricing: queue-based surge (additive, not multiplicative)
  - L3: AMM pools for commodity capabilities (Meteora DLMM)
  - L3: Combinatorial auction for multi-step workflows (bundle bidding)
  - L3: Negotiation session: CREATED → CONFIGURING → QUOTED → REVIEWING → COMMITTED (30min TTL)
  - L3: Quote validity window (15 minutes)
  - L3: Pricing decomposition for transparency (item-by-item impact analysis)

#### L2.2.4 — Hub Architecture
- Physical locations (hubs) that host equipment, materials, and operators
- Requirements:
  - L3: Hub = Shop Kernel = Availability Zone (trust boundary)
  - L3: Hub metadata: location, capabilities, operators, power specs, amenities, access hours
  - L3: Hub-level reputation (aggregate of operator reputations)
  - L3: Hub networking: inter-hub courier logistics, federated discovery
  - L3: Hub governance: local policies, pricing, access control
  - L3: Hosting spaces: power specs, environmental systems, safety features, machine assignments
  - L3: Supplies marketplace: materials, reagents, tooling, consumables with escrow-backed orders

#### L2.2.5 — Workflow Compilation
- Multi-step job decomposition, DAG compilation, and execution planning
- Standards: BPMN 2.0 (import/export), Temporal.io (durable execution), Airflow (scheduling), K8s Job patterns
- Requirements:
  - L3: Capability Workflow Manifest (CWM): JSON DAG with steps, dependencies, constraints
  - L3: DAG compilation: topological sort, parallel wave identification, critical path analysis
  - L3: Kernel assignment per step (best match by capability, price, reputation, proximity)
  - L3: Time window scheduling with buffer for logistics
  - L3: Saga compensation (rollback on step failure)
  - L3: Long-running workflow support (hours/days for CNC, lab protocols)
  - L3: BPMN 2.0 import/export for enterprise customers
  - L3: Recurring workflow scheduling (daily HPLC, weekly calibration)

---

### L1.3 — AGENT ORCHESTRATION & SAFETY

#### L2.3.1 — Agent Operational Envelopes
- Define exactly what each agent CAN and CANNOT do
- Standards: OWASP Top 10 for Agentic Applications (2026), Anthropic Constitutional AI, OpenAI Strict Mode, EU AI Act, ISO 42001
- Requirements:
  - L3: Least Agency principle — minimum autonomy required per task
  - L3: Constitutional constraints: hard rules agents cannot violate
  - L3: Input guardrails: PII redaction, jailbreak detection, keyword filtering (run in parallel)
  - L3: Tool guardrails: per-tool output validation with block_on_tool_violations=True for physical commands
  - L3: Output guardrails: safety classification, blocklist enforcement
  - L3: Agent package strict-mode compatibility (all schemas with additionalProperties: false)
  - L3: EU AI Act high-risk classification compliance (August 2026 deadline)

#### L2.3.2 — Role-Based Access Control (RBAC) + Segregation of Duties (SoD)
- No single agent controls the entire job lifecycle
- Standards: RBAC two-layer model, Static/Dynamic SoD, OWASP agent permission model
- Requirements:
  - L3: Six agent roles: discovery, negotiation, escrow, execution, verification, settlement
  - L3: Per-role tool allowlists (from action-policy.json)
  - L3: Five action classes: read, write, exec, network, credential
  - L3: Static SoD: executor ≠ verifier (never same agent)
  - L3: Dynamic SoD: escrow-write and verification-write never active in same session
  - L3: Dangerous action keyword scoring (0.0-1.0 threshold at 0.5)
  - L3: Dual-logging for high-risk actions
  - L3: Rate limiting per agent per action class

#### L2.3.3 — Multi-Agent Coordination
- Structured protocols for agent collaboration
- Standards: FIPA Contract Net, Blackboard architecture, TraderBots, BFT consensus
- Requirements:
  - L3: Contract Net Protocol for job allocation (CFP → Propose → Accept → Inform)
  - L3: Blackboard pattern: shared job state that specialist agents read/write opportunistically
  - L3: Market-based task allocation with task trees at variable abstraction
  - L3: BFT consensus for verification (n ≥ 3f+1 for safety)
  - L3: Stigmergic routing (reputation traces influence future routing)
  - L3: A2A typed intents (34 distinct types, no free-form between infrastructure agents)
  - L3: Message crypto: Ed25519 signatures, NaCl-box encryption

#### L2.3.4 — Physical Safety
- Independent safety systems that agents cannot bypass
- Standards: IEC 61508 (SIL), IEC 62443 (zones/conduits), ISO 10218/15066 (robot safety), IEC 60204-1 (e-stop), OSHA LOTO
- Requirements:
  - L3: Safety Governor as independent process (separate from agent system)
  - L3: Equipment motion commands: SIL 2 minimum (agent + safety governor + e-stop)
  - L3: Emergency stop: SIL 3, independent of agent system, hardware-only path
  - L3: IEC 62443 zone architecture: Enterprise → Agent → Equipment Control → Equipment
  - L3: Each zone boundary = monitored conduit with appropriate security level
  - L3: LOTO state = immutable hardware interlock, agents cannot override
  - L3: Maintenance mode that prevents all agent commands
  - L3: Execution Scope Protocol: 4 classes (READ/SAFE/SCOPED/PRIVILEGED)
  - L3: Scope lifecycle: PROPOSED → ACTIVE → COMPLETED/EXPIRED/REVOKED
  - L3: Rate limits per scope: max commands, max retries, max duration
  - L3: Troubleshooting ladder: auto-retry → brain recovery → operator escalation → e-stop

#### L2.3.5 — Agent Observability & Audit
- Complete traceability of every agent decision and physical command
- Standards: OpenTelemetry, W3C Trace Context, SOC 2 Type II, ISO 27001 A.8.15/A.8.16, FINRA audit trails
- Requirements:
  - L3: Every agent action logged: timestamp, agent_id, tool, action_class, args_hash (SHA256), result
  - L3: W3C Trace Context propagation across all agent-to-agent messages
  - L3: Physical command spans: command_type, parameters, safety_governor_verdict, equipment_response
  - L3: Safety governor intervention logging: 5-year retention
  - L3: Emergency stop logging: permanent retention
  - L3: Append-only log storage (admins cannot delete their own logs)
  - L3: NTP time synchronization across all infrastructure
  - L3: SOC 2 Type II audit evidence: 3-6 month observation period

#### L2.3.6 — Agent Authentication
- Agents prove identity to each other and to equipment
- Standards: mTLS, SPIFFE/SPIRE, ACE-OAuth (RFC 9200), X.509 certificate chains
- Requirements:
  - L3: mTLS for all agent-to-agent communication
  - L3: SPIFFE workload identities: `spiffe://pcc.network/agent/{role}/{region}`
  - L3: Short-lived certificates (hours, auto-rotated via SPIRE)
  - L3: ACE-OAuth (CBOR Web Tokens) for constrained equipment
  - L3: Proof-of-Possession tokens (prevent replay attacks)

---

### L1.4 — EVIDENCE & COMPLIANCE

#### L2.4.1 — Evidence Architecture
- Content-addressed, tiered, cryptographically signed proof of physical work
- Standards: IETF RATS RFC 9334, IPFS/CID, TPM 2.0, Intel SGX/TDX
- Requirements:
  - L3: Evidence Event: id, type (68 types), timestamp, source (device, kernel, firmware), payload, SHA-256 hash
  - L3: Evidence Bundle: collection of events per job step, signed by kernel (Ed25519)
  - L3: Bundle hash = SHA-256 of canonical JSON of all event hashes
  - L3: Content-addressed storage (IPFS/Storacha, CIDs resolve on w3s.link)
  - L3: On-chain anchoring (Starknet ProofRegistry for non-repudiation)
  - L3: RATS role mapping: Attester=Kernel, Verifier=VerifierMarket, Relying Party=Requester
  - L3: Endorser=Equipment manufacturer (calibration certs)
  - L3: Reference Value Provider=CSD definitions

#### L2.4.2 — Assurance Tiers (0-3)
- Layered evidence requirements scaling with risk/liability
- Requirements:
  - L3: Tier 0: G-code hash + execution completion (2 events min, 1h challenge, 0% bond)
  - L3: Tier 1: + power profile summary (3 events, 4h challenge, 5% bond)
  - L3: Tier 2: + CV inspection or camera snapshot (4 events, 24h challenge, 15% bond)
  - L3: Tier 3: + TEE attestation + independent inspection (5 events, 72h challenge, 25% bond)
  - L3: Tier requirements are declarative (AND groups of OR conditions)
  - L3: Bond slashing: 100% on all tiers for fraud

#### L2.4.3 — Verification Market
- Stake-weighted, tiered verifier selection with BFT consensus
- Standards: Bittensor subnet, PBFT, ERC-8004 Validation Registry
- Requirements:
  - L3: Tier 0/1: Open market, stake-weighted selection (min rep 0/200, quorum 1)
  - L3: Tier 2/3: Curated guild, domain-expert allowlist (min rep 500/800, quorum 2/3)
  - L3: Weight formula: staked_amount * (reputation / 1000)
  - L3: Verification checks: hash integrity, tier requirements, consistency (power ≈ execution duration)
  - L3: Attestation output: findings, confidence score (0-100), result (valid/invalid/inconclusive)
  - L3: POAW-style audit receipt (scanHash, position, checksPerformed)
  - L3: Yuma Consensus for Bittensor subnet

#### L2.4.4 — Regulatory Compliance Frameworks
- Industry-specific compliance from evidence bundles
- Standards: ISO 9001, ISO 13485, ISO 17025:2025, FDA 21 CFR Part 11, NIST 800-171, AS9100, IATF 16949, GxP
- Requirements:
  - L3: ALCOA+ data integrity (Attributable, Legible, Contemporaneous, Original, Accurate + Complete, Consistent, Enduring, Available)
  - L3: ISO 9001 audit report export from evidence chain
  - L3: ISO 13485 process validation records in evidence bundles (Tier 3)
  - L3: ISO 17025:2025 compliance mode (uncertainty, traceability, environmental conditions)
  - L3: 21 CFR Part 11 mapping (audit trails, system validation, access controls)
  - L3: NIST 800-171 self-assessment for defense customers
  - L3: AS9100 special process tracking in kernel configurations
  - L3: IATF 16949 PPAP auto-generation from evidence bundles
  - L3: GxP GAMP 5 validation documentation for PCC platform
  - L3: EU Digital Product Passport generation from evidence (mandatory 2027)

#### L2.4.5 — Supply Chain Traceability
- Track physical items from raw material through manufacturing to delivery
- Standards: GS1 EPCIS 2.0, W3C Traceability Vocabulary, EU DPP
- Requirements:
  - L3: EPCIS event alignment: What (capability), When (timestamp), Where (kernel), Why (job), How (parameters)
  - L3: W3C Traceability VCs for evidence attestations
  - L3: Digital Product Passport data generation as manufacturing byproduct
  - L3: Material certificate tracking (origin, composition, properties)
  - L3: Custody chain events (kernel → courier → recipient, each signed)

---

### L1.5 — SETTLEMENT & ECONOMICS

#### L2.5.1 — Escrow & Settlement
- Milestone-based on-chain escrow with bonds and dispute resolution
- Standards: ERC-20 (USDC), MilestoneEscrow.sol, PCCProtocol.sol
- Requirements:
  - L3: Milestone states: Unfunded → Funded → Locked → Evidenced → Attested → Released/Disputed/Refunded
  - L3: Per-milestone bond amounts (configurable by tier)
  - L3: Challenge window: 1h (T0), 4h (T1), 24h (T2), 72h (T3)
  - L3: Oracle gating: no settlement without oracle attestation
  - L3: Fee deduction at release: protocol fee (10-500 bps, default 235 bps)
  - L3: PGTR (ERC-8194) for custodial/relay flow
  - L3: Atomic release: evidence meets tier requirements AND challenge window expires

#### L2.5.2 — Payment Protocols
- Multiple payment rails for different use cases
- Standards: x402 (HTTP 402), MPP/Tempo, ERC-8194 PGTR, Stripe, Yellowcard, Wise
- Requirements:
  - L3: x402 for digital microservices (quote=$0.01, simulate=$0.05, route=$0.02)
  - L3: MPP/Tempo as x402 successor (feature-flagged)
  - L3: Milestone escrow for physical work (USDC on Base/Flow EVM)
  - L3: Fiat on-ramps: Stripe (global), Yellowcard (34 emerging markets), Wise (enterprise bank)
  - L3: Cross-chain: Ethereum + Solana + Starknet

#### L2.5.3 — DePIN Incentives
- Operator rewards for infrastructure provision
- Standards: Helium BME pattern, soulbound NFTs (Metaplex Core), DePIN flywheel
- Requirements:
  - L3: Capability certificates: soulbound cNFTs on Solana (PermanentFreezeDelegate)
  - L3: Reward epoch scoring: jobs (40%) + quality (25%) + uptime (15%) + diversity (10%) + scarcity (10%)
  - L3: Weekly distribution proportional to normalized scores
  - L3: Burn-and-mint equilibrium for marketplace usage fees
  - L3: Token-gated execution scope (scope token = access token)

#### L2.5.4 — Sovereign Wealth Fund
- Protocol-level community treasury with democratic governance
- Requirements:
  - L3: 2% accrual on every fee-generating transaction
  - L3: Weekly distribution: job volume (30%) + reputation (25%) + uptime (20%) + tenure (15%) + governance (10%)
  - L3: Allocation: dividends (60%) + infrastructure (25%) + grants (10%) + reserve (5%)
  - L3: Proposal system: 30+ days tenure, weighted votes, 30% quorum, simple majority
  - L3: Governable allocation strategy

---

### L1.6 — EQUIPMENT INTEROPERABILITY

#### L2.6.1 — Device Adapter Standards
- Standard protocols for communicating with physical hardware
- Standards: OPC-UA (IEC 62541), SiLA 2.0, MTConnect 2.2, Sparkplug B 3.0, Modbus TCP, OctoPrint REST
- Requirements:
  - L3: OPC-UA: Companion Specs for CNC, 3D printing, lab instruments
  - L3: SiLA 2.0: Feature model for lab instruments (liquid handlers, readers, chromatography)
  - L3: MTConnect: Read-only telemetry feed for CNC machines (Haas, DMG Mori, Mazak)
  - L3: Sparkplug B: MQTT sensor streaming with birth/death certificates
  - L3: Modbus TCP: Industrial register read/write
  - L3: OctoPrint REST: 3D printer control and monitoring
  - L3: Generic HTTP: Custom REST adapters

#### L2.6.2 — Equipment State Machine
- Standardized states for all equipment types
- Standards: PackML (ISA-TR88.00.02-2022), ISA-95 activity model
- Requirements:
  - L3: PackML 17-state model adoption (Idle, Starting, Execute, Completing, Complete, Aborting, Aborted, Stopping, Stopped, Resetting, Holding, Held, Unholding, Suspending, Suspended, Unsuspending, Clearing)
  - L3: PackML modes: Production, Maintenance, Manual, Dry-run
  - L3: ISA-95 Level 3 alignment (MES equivalent)
  - L3: PackML → PCC job lifecycle mapping
  - L3: PackTags for standardized machine-to-machine communication

#### L2.6.3 — Sensor Data Pipeline
- Real-time sensor data collection, streaming, and analysis
- Standards: Sparkplug B (IIoT), OPC-UA pub/sub, SSE streams
- Requirements:
  - L3: Sensor channels: temperature, pressure, power, vibration, humidity, absorbance
  - L3: Real-time streaming via SSE (gateway) and MQTT/Sparkplug B (edge)
  - L3: Anomaly detection on sensor data
  - L3: Statistical process control (SPC) for quality monitoring
  - L3: Environmental condition logging for compliance (17025, GMP)

#### L2.6.4 — Hardware Auto-Detection
- Automatic discovery and configuration of local equipment
- Standards: mDNS, SiLA Discovery, OPC-UA discovery, USB/serial enumeration
- Requirements:
  - L3: mDNS for OctoPrint printers
  - L3: SiLA Discovery for lab instruments
  - L3: OPC-UA endpoint discovery for industrial equipment
  - L3: Modbus register probes for legacy equipment
  - L3: Serial port enumeration for OT-2/OT-3 robots
  - L3: Ed25519 key pair generation on first detection
  - L3: Automatic CSD generation from detected capabilities

---

## L3: PROTOCOL-LEVEL REQUIREMENTS (Summary Counts)

| Domain | L2 Subcategories | L3 Requirements |
|--------|-----------------|-----------------|
| Trust & Identity | 5 | 27 |
| Capability Marketplace | 5 | 35 |
| Agent Orchestration & Safety | 6 | 48 |
| Evidence & Compliance | 5 | 42 |
| Settlement & Economics | 4 | 24 |
| Equipment Interoperability | 4 | 22 |
| **TOTAL** | **29** | **198** |

---

## Standards Integration Matrix

| Standard | PCC Status | Priority | Domain |
|----------|-----------|----------|--------|
| W3C DIDs v1.1 | IMPLEMENTED | — | L1.1 |
| W3C VCs 2.0 | IMPLEMENTED | — | L1.1, L1.4 |
| ERC-8004 | IMPLEMENTED | — | L1.1 |
| MCP | IMPLEMENTED (56 tools) | — | L1.2 |
| IPFS/CID | IMPLEMENTED | — | L1.4 |
| A2A (PCC custom, 34 intents) | IMPLEMENTED | — | L1.3 |
| OPC-UA adapter | IMPLEMENTED | — | L1.6 |
| SiLA 2.0 adapter | IMPLEMENTED | — | L1.6 |
| Execution Scope Protocol | IMPLEMENTED | — | L1.3 |
| Action classification (5-class) | IMPLEMENTED | — | L1.3 |
| OWASP Agentic mitigations | P0 | Immediate | L1.3 |
| IEC 62443 zone architecture | P0 | Immediate | L1.3 |
| RBAC + SoD formalization | P0 | Immediate | L1.3 |
| Google A2A AgentCard | P1 | Q2 2026 | L1.1, L1.2 |
| PackML state machine | P1 | Q2 2026 | L1.6 |
| RATS RFC 9334 alignment | P1 | Q2 2026 | L1.4 |
| OpenTelemetry instrumentation | P1 | Q2 2026 | L1.3 |
| W3C Trace Context | P1 | Q2 2026 | L1.3 |
| mTLS agent-to-agent | P1 | Q3 2026 | L1.3 |
| Safety Governor independence | P1 | Q3 2026 | L1.3 |
| MTConnect integration | P1 | Q3 2026 | L1.6 |
| Sparkplug B sensor streaming | P1 | Q3 2026 | L1.6 |
| Temporal.io workflows | P2 | Q3 2026 | L1.2 |
| EU Digital Product Passport | P2 | Q4 2026 | L1.4 |
| SPIFFE/SPIRE deployment | P2 | Q4 2026 | L1.3 |
| EU AI Act compliance | P2 | Q1 2027 | L1.3 |
| ISO 42001 certification | P2 | Q1 2027 | L1.3 |
| EPCIS 2.0 evidence export | P2 | Q1 2027 | L1.4 |
| BPMN 2.0 import/export | P3 | Future | L1.2 |
| EDI X12 adapter | P3 | Future | L1.4 |
| TPM platform attestation | P3 | Future | L1.4 |
| Intel TDX confidential computing | P3 | Future | L1.4 |
| BFT verification consensus | P3 | Future | L1.4 |
| Combinatorial auctions | P3 | Future | L1.2 |
| EBSI integration | P3 | Future | L1.1 |
| ToIP TRQP | P3 | Future | L1.1 |
| ACE-OAuth for equipment | P3 | Future | L1.3 |
| SOC 2 Type II | P3 | Future | L1.3 |
