# Gemini Prompt: PCC Facade Layer + Agent Harness + Standards Architecture

**Instructions**: Copy everything below this line into Gemini 2.5 Pro (or Flash) with a large context window. This prompt is self-contained with all PCC context needed.

---

## ROLE

You are a senior systems architect specializing in distributed physical infrastructure marketplaces, multi-agent orchestration, and industrial compliance. You are designing the comprehensive Facade layer, agent harness system, and standards-compliant architecture for the Physical Capability Cloud (PCC).

## CONTEXT: WHAT IS PCC

**Physical Capability Cloud (PCC)** is "AWS for the physical world" — a distributed marketplace where AI agents discover, negotiate, and orchestrate physical capabilities (3D printing, CNC machining, liquid handling, spectroscopy, robotics, courier delivery) on real hardware at distributed hubs, with cryptographic proof of work, milestone escrow settlement, and autonomous operation.

**Live at**: https://capability.network
**Stack**: TypeScript monorepo (pnpm + turbo), Fastify gateway, React 19 dashboard, Viem (Ethereum), Zod schemas, SQLite, Vitest
**Scale**: 25 packages + 1 dashboard app, 3300+ tests, 218 agent tools, 347 REST endpoints across 54 route files, 34 A2A intents, 6 SSE streams, 56 MCP tools

### Core Concepts

| AWS Concept | PCC Equivalent | Description |
|-------------|---------------|-------------|
| Region | Geographic Zone | Metro areas with courier coverage + capability density |
| Availability Zone | **Shop Kernel** | Physical site running equipment (the trust boundary) |
| EC2 Instance Type | **Capability Type** | What a machine can DO (e.g., "FDM 250x210mm", "5-axis CNC Tier-2") |
| Running Instance | **Capability Slot** | Reserved time window on a capability |
| S3 Object | **Evidence Bundle** | Cryptographically signed, content-addressed proof of work |
| Lambda | **Digital Microservice** | Quote, route, simulate (x402-gated, micropaid) |
| IAM Role | **Identity Registry (ERC-8004)** | Machine + operator + agent identity + reputation |
| SLA | **Assurance Tier (0-3)** | Evidence depth, liability, dispute window, bond amount |

### The Six-Phase Job Lifecycle

```
DISCOVER → BID → ESCROW → EXECUTE → VERIFY → SETTLE
   │        │       │         │        │        │
  DHT    Auction  Lock     Real    Verifier  Auto-
  gossip  pricing  funds   hardware  market  release
                  on-chain          (Bittensor)
```

### Package Architecture (25 packages)

**Foundation:**
- `packages/spec` — Single source of truth for ALL types + Zod schemas (20+ type files)
- `packages/contracts` — Solidity: MilestoneEscrow + PCCProtocol + IdentityRegistry + ReputationRegistry; Solana: soulbound NFTs + reward engine
- `packages/db` — SQLite store layer (better-sqlite3)

**Core Runtime:**
- `packages/gateway` — Fastify HTTP gateway (54 route files, 347+ endpoints, SSE streams, WebSocket DHT)
- `packages/kernel` — Shop Kernel runtime: device adapters (OctoPrint, Modbus, OPC-UA, SiLA, Generic HTTP, Opentrons), evidence emitter, job runner
- `packages/scheduler` — Workflow compiler + capability router
- `packages/verifier` — Hybrid verifier market + Bittensor subnet + evidence verification + ZK proofs (Noir)
- `packages/payments` — x402 middleware + MPP/Tempo + Meteora DLMM pools

**Agent Layer (A2A, 6 agent types):**
- `packages/a2a` — Message bus, typed intents (34), crypto (Ed25519 sign, NaCl-box encrypt), security middleware
- `packages/agent-runtime` — Base framework: wallet (viem), tools, intent handlers, SmartAccountManager (ERC-4337)
- `packages/agent-user` — User Agent: wallet, discovery, negotiation, workflow submission
- `packages/agent-broker` — Broker Agent: capability routing, quoting, workflow compilation
- `packages/agent-kernel` — Kernel Agent: wraps shop kernel, accepts jobs, emits evidence
- `packages/agent-evaluator` — Evaluator Agent: quality assessment, attestation VCs, reputation bridge

**Distributed Infrastructure:**
- `packages/dht` — WebSocket gossip DHT for decentralized capability discovery
- `packages/pcc-node` — Python CLI for operators: hardware auto-detection, Ed25519 keys, daemon loop
- `packages/identity-8004` — ERC-8004 Identity/Reputation/Validation registry clients (viem)

**Frontend:**
- `apps/dashboard` — React 19 + Vite + Zustand stores + Wagmi (wallet) — 57+ routes

### Current Architectural Issues

1. **No Facade layer**: 54 route files with inline data enrichment, no separation between HTTP concerns and business logic
2. **357 inconsistent error returns**: Some routes return empty objects, some return `{error}`, some use HTTP status codes — no standard
3. **No agent harness formalization**: Action classification exists (5 classes, per-agent allowlists) but not documented or enforced at the facade level
4. **SSE streams have no authentication**: Any client can monitor any job/kernel/device
5. **Single SQLite connection**: Synchronous calls in async context, no read replicas
6. **In-memory agent bridge**: MessageBus not persistent, no replay on crash
7. **Service singletons**: KernelService, SettlementService are lazy-initialized globals with no DI
8. **x402 + MPP coexist**: Two payment protocols active, unclear precedence
9. **No formal SoD enforcement**: Agents CAN theoretically access operations outside their role

### Implemented Standards (Already Working)

| Standard | Implementation |
|----------|---------------|
| W3C DIDs (v1.1) | `did:key` + `did:pcc` in `packages/spec/src/identity/` |
| W3C VCs 2.0 | Capability credentials, evidence attestations |
| ERC-8004 | Full: Identity + Reputation + Validation registries, Agent Registration File |
| MCP | 49-tool stdio server in `packages/mcp-server` |
| IPFS/CID | Content-addressed evidence via Helia + Storacha |
| x402 | HTTP 402 micropayments (Coinbase) |
| Lit Protocol | AES-256-GCM encryption with access conditions |
| Starknet | ProofRegistry for ZK proof anchoring |
| Bittensor | Verification subnet (validators + miners + Yuma Consensus) |
| Solana cNFTs | Soulbound capability certificates (Metaplex Core) |
| OPC-UA | Device adapter in kernel |
| SiLA 2.0 | Device adapter in kernel |
| Ed25519/NaCl | Signed announcements, encrypted P2P messages |

### Type System (packages/spec)

Every wire type is defined in `packages/spec/src/types/`. Key types:

```typescript
// Capability — the "SKU" equivalent
Capability { id, type, name, materials[], tolerances, envelope, assuranceTiers[], availability, pricing, location }

// Shop Kernel — the "Availability Zone"
ShopKernel { id, did?, name, operatorAddress, location, capabilities[], maxAssuranceTier, publicKey, reputation, status, lastHeartbeat }

// Evidence Bundle — proof of physical work
EvidenceBundle { id, jobId, stepId, kernelId, assuranceTier, events[], bundleHash(SHA-256), kernelSignature(Ed25519) }

// Evidence Event — single signal from one source (68 event types)
EvidenceEvent { id, type, timestamp, source{deviceId, deviceType, kernelId}, payload, hash(SHA-256) }

// Assurance Tiers — tiered evidence requirements
Tier 0: gcode_hash_verified + execution_completed (1h challenge, 0% bond)
Tier 1: + power_profile_summary (4h challenge, 5% bond)
Tier 2: + cv_inspection_result OR camera_snapshot (24h challenge, 15% bond)
Tier 3: + tee_attestation + independent_inspection (72h challenge, 25% bond)

// A2A Message — typed agent communication
A2AMessage { id, conversationId, from, to, intent(discriminated union of 34 types), timestamp, signature?, encrypted? }

// CWM — Capability Workflow Manifest (multi-step job DAG)
CWM { version, id, steps[{id, capability, params, inputs?, assuranceTier, dependsOn[], preferredKernel?, maxPrice?}], settlement{currency, maxBudget, payer} }

// Negotiation Session
NegotiationSession { id, agentId, status(CREATED→CONFIGURING→QUOTED→REVIEWING→COMMITTED), expiresAt, operatorConstraints, quote, auditLog }

// Operator Policy
OperatorPolicy { approvalMode, agentTrust{whitelist, blacklist, minReputation}, rateLimits, pricingRules[], safetyGuardrails }

// Escrow Milestone
EscrowMilestone { stepId, amount, status, evidenceBundleHash, verifierAttestationHash, challengeWindow, bondAmount }
```

### Solidity Contracts (On-Chain)

```
PCCProtocol.sol — Factory + governance hub
  - Immutable fee recipient
  - Fee: 10-500 bps (default 235 bps)
  - Registry addresses: identity, reputation, validation, verifier

MilestoneEscrow.sol — Settlement
  - Milestone states: Unfunded → Funded → Locked → Evidenced → Attested → Released/Disputed/Refunded
  - Per-milestone bonds, challenge windows per tier
  - Oracle gating (no settlement without attestation)
  - PGTR (ERC-8194) support for relay flow

IdentityRegistry.sol — ERC-8004 entities (Agent, Machine, Operator, Verifier)
ReputationRegistry.sol — Score 0-1000, feedback with tags
```

### Agent Harness (Current State)

```
Action Classes: read | write | exec | network | credential
Per-Agent Allowlists (14 agent roles in action-policy.json)
Dangerous Keyword Scoring: 0.0-1.0 (threshold 0.5)
Audit Logging: JSONL with timestamp, session_id, tool, action_class, args_hash
Execution Scope Protocol: 4 classes (READ/SAFE/SCOPED/PRIVILEGED)
Content Scanner: Regex-based adversarial pattern detection (AEGIS gate)
```

---

## STANDARDS TAXONOMY: 198 REQUIREMENTS ACROSS 6 PILLARS

The following is the complete requirements tree. Every requirement needs to be addressed in the architecture.

### L1.1 — TRUST & IDENTITY (5 domains, 27 requirements)
- Agent Identity: DIDs, AgentCard, SPIFFE, certificates
- Machine Identity: X.509, TPM, FIDO2 attestation, equipment DIDs
- Operator Identity: VCs, did:pkh, KYC/KYB, operator policies
- Reputation: ERC-8004, scoring events, decay, cold-start, anti-sybil
- Trust Frameworks: ToIP 4-layer stack, TRQP

### L1.2 — CAPABILITY MARKETPLACE (5 domains, 35 requirements)
- CSD (Capability StructureDefinition): FHIR lifecycle, OPC-UA companion specs, taxonomy
- Discovery & Routing: P2P DHT, reputation-weighted ranking, geographic routing
- Pricing & Negotiation: CDA, combinatorial auction, surge pricing, AMM pools, negotiation sessions
- Hub Architecture: trust boundaries, supplies marketplace, hosting spaces, inter-hub logistics
- Workflow Compilation: CWM DAGs, Temporal.io, BPMN import/export, saga compensation

### L1.3 — AGENT ORCHESTRATION & SAFETY (6 domains, 48 requirements)
- Operational Envelopes: OWASP Agentic Top 10, constitutional constraints, guardrails, EU AI Act
- RBAC + SoD: Six-role model, action classes, static/dynamic SoD, keyword scoring
- Multi-Agent Coordination: Contract Net, blackboard, BFT, stigmergic routing, typed intents
- Physical Safety: IEC 61508 SIL, IEC 62443 zones, ISO 10218 robot safety, e-stop independence, LOTO
- Observability: OpenTelemetry, W3C Trace Context, SOC 2, ISO 27001 logging, FINRA trails
- Agent Auth: mTLS, SPIFFE/SPIRE, ACE-OAuth, proof-of-possession

### L1.4 — EVIDENCE & COMPLIANCE (5 domains, 42 requirements)
- Evidence Architecture: RATS RFC 9334, content-addressed storage, on-chain anchoring
- Assurance Tiers: Tiered evidence, challenge windows, bonds, slashing
- Verification Market: Bittensor, stake-weighted selection, guild curation, BFT consensus
- Regulatory Compliance: ISO 9001/13485/17025, FDA Part 11, NIST 800-171, AS9100, IATF 16949, GxP, EU DPP
- Supply Chain Traceability: EPCIS 2.0, W3C Traceability VCs, material certificates, custody chain

### L1.5 — SETTLEMENT & ECONOMICS (4 domains, 24 requirements)
- Escrow: Milestone states, bonds, challenge windows, oracle gating, fee deduction
- Payment Protocols: x402, MPP, escrow, fiat ramps, cross-chain
- DePIN Incentives: Soulbound NFTs, reward epochs, burn-and-mint, token-gated access
- Sovereign Wealth Fund: 2% accrual, weekly distribution, proposal governance

### L1.6 — EQUIPMENT INTEROPERABILITY (4 domains, 22 requirements)
- Device Adapters: OPC-UA, SiLA 2, MTConnect, Sparkplug B, Modbus, OctoPrint
- Equipment State Machine: PackML 17 states, ISA-95 alignment
- Sensor Pipeline: Real-time streaming, SPC, anomaly detection, compliance logging
- Hardware Auto-Detection: mDNS, SiLA Discovery, OPC-UA discovery, serial enumeration

---

## YOUR TASK

Design the complete architecture for PCC's Facade layer, agent harness system, and standards integration. Produce the following deliverables:

### Deliverable 1: Facade Architecture

Design the Facade layer for `packages/gateway/src/facades/` that:

1. **Defines 6-8 Facade classes** that map to the strategic pillars (CapabilityFacade, JobFacade, SettlementFacade, KernelFacade, AgentFacade, MarketplaceFacade, ComplianceFacade, DiscoveryFacade)

2. **For each Facade, specify:**
   - Public methods (the API surface for routes and agents)
   - Populator functions that transform internal models → DTOs
   - Which services/repos it orchestrates
   - Error handling strategy (standardized Result<T, E> pattern)
   - How it maps to the standards taxonomy (which L2/L3 requirements it addresses)

3. **Define the DTO layer** (`packages/gateway/src/facades/types.ts`):
   - Typed response DTOs distinct from internal models
   - Enrichment fields (availability, reputation, estimated delivery, compliance status)
   - Pagination, filtering, and sorting contracts
   - SSE event DTOs for real-time streams

4. **Define the Populator pattern**:
   - `populate<Entity>Data(model, context) → DTO`
   - Context injection pattern (how populators get access to reputation, queue depth, etc.)
   - Batch population for list endpoints (avoid N+1 queries)
   - Compliance populator (attaches regulatory status per evidence bundle)

5. **Show the refactored route pattern**:
   - Before (current inline enrichment) vs. After (thin route → facade → populator)
   - Standardized error response format: `{ success: boolean, data?: T, error?: { code, message, details } }`
   - Auth integration (how facade methods receive authenticated context)

### Deliverable 2: Agent Harness Architecture

Design the comprehensive agent harness that:

1. **Formalizes the 6-role RBAC model** with tool allowlists and SoD enforcement:
   - discovery-agent, negotiation-agent, escrow-agent, execution-agent, verification-agent, settlement-agent
   - Per-role: allowed facades, allowed actions, forbidden actions
   - SoD matrix: which role combinations are prohibited

2. **Defines the Safety Governor architecture** (IEC 61508 + 62443):
   - Independent process/service separate from agent system
   - Command validation pipeline: parameter range check → operational envelope → rate limit → safety interlock
   - E-stop channel: hardware-only, independent of software stack
   - Zone architecture: Enterprise → Agent → Equipment Control → Equipment
   - Conduit specifications between zones

3. **Specifies the Agent Lifecycle Harness**:
   - Agent registration and credential provisioning
   - Per-invocation scope: what tools, what data, what duration
   - Checkpoint/resume pattern for long-running workflows
   - Failure handling: circuit breaker, fallback, escalation ladder
   - Observability: OpenTelemetry spans with W3C Trace Context

4. **Maps OWASP Agentic Top 10 mitigations**:
   - ASI01 (Goal Hijack): Constitutional constraints per agent role
   - ASI02 (Tool Misuse): Strict-mode schemas, parameter range validation for physical commands
   - ASI03 (Identity Abuse): Short-lived SPIFFE credentials, no credential inheritance
   - ASI04 (Supply Chain): Gate A vetting for all MCP servers and tools
   - ASI05 (Code Execution): No eval/exec near physical equipment
   - ASI07 (Insecure Inter-Agent): mTLS + Ed25519 signatures on all A2A messages
   - ASI08 (Cascading Failures): Circuit breakers, saga compensation, independent verification
   - ASI10 (Rogue Agents): Monitor agent with amplified oversight, anomaly detection

### Deliverable 3: Standards Integration Roadmap

For each of the 38 standards in the integration matrix, specify:

1. **Integration approach**: Native (build into core), Adapter (translation layer), Export (generate on demand)
2. **Affected packages**: Which PCC packages need changes
3. **Interface changes**: New types, new routes, new facade methods
4. **Agent harness implications**: New roles, new permissions, new safety checks
5. **Testing strategy**: How to verify compliance
6. **Priority and dependencies**: What must come first

### Deliverable 4: Implementation Blueprint

Provide a concrete implementation plan:

1. **Phase 1 (Foundation)**: Facade layer + standardized errors + DTO types + populators
2. **Phase 2 (Agent Harness)**: RBAC formalization + SoD enforcement + Safety Governor independence
3. **Phase 3 (Standards Core)**: OWASP mitigations + IEC 62443 zones + OpenTelemetry + Trace Context
4. **Phase 4 (Standards Extended)**: PackML states + RATS alignment + AgentCard + mTLS
5. **Phase 5 (Compliance)**: EU AI Act + ISO 42001 + SOC 2 readiness + DPP generation

For each phase:
- Estimated package changes
- New files/modules to create
- Test coverage requirements
- Migration strategy for existing routes

## OUTPUT FORMAT

Structure your response as a detailed technical specification document. Use TypeScript interfaces for all type definitions. Include code examples for key patterns. Use tables for matrices and mappings. Be specific — file paths, method signatures, type names, not hand-wavy descriptions.

## CONSTRAINTS

- The codebase is TypeScript (Node.js). All new code must be TypeScript.
- No dependency injection framework — use constructor injection and factory functions.
- Zod for runtime validation of all external input (already established pattern).
- SQLite is the database (via better-sqlite3). No ORM.
- Fastify is the HTTP framework. Routes are async functions registered on `FastifyInstance`.
- The frontend uses Zustand stores. No Redux/NgRx.
- On-chain interactions use Viem (Ethereum) and @solana/web3.js (Solana).
- The MCP server communicates over stdio (JSON-RPC 2.0).
- The A2A bus is currently in-memory. Design for future distribution.
- Physical safety is non-negotiable. When in doubt, fail-safe (deny the command).
- The system must work today with SQLite and in-memory bus, but the facade/harness design should not preclude migration to Postgres/Redis/message queue.
