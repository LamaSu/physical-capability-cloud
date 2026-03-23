# Physical Capability Cloud: A Credibly Neutral Coordination Layer for Physical Manufacturing

**Version**: 1.0 | **Date**: March 21, 2026

---

## Abstract

Physical manufacturing is fragmented. A CNC shop in Detroit, a plating operation in Austin, and a quality-inspection lab in Munich cannot form a trustless workflow without a broker, a contract, and months of relationship-building. No neutral coordination layer exists for physical capabilities the way AWS exists for compute. The Physical Capability Cloud (PCC) is that layer.

PCC abstracts physical manufacturing capabilities into composable, verifiable, settleable services discoverable by AI agents. Shop Kernels are the Availability Zones — physical sites with equipment connected to the network. Capabilities are the billing units — not machines, but what machines can do: 5-axis milling at ±0.01mm, FDM extrusion in PETG up to 250×210×210mm, HPLC purity analysis down to 0.1% peak area. Assurance Tiers are the SLAs — escalating evidence requirements and slashable bonds that make claims credible. Milestone escrow with cryptographic evidence makes settlement automatic and auditable.

The key innovation is that PCC does not just coordinate work — it creates permanent intellectual property from it. Capability StructureDefinitions (CSDs) are machine-readable design artifacts registered as IP Assets on Story Protocol. Every job run is a derivative of the CSD it was built from, creating an on-chain provenance chain. Every CSD fork pays royalties to the original designer. Physical work becomes programmable IP, and operators, designers, and verifiers earn from the network they build.

---

## 1. Introduction

### 1.1 Why Cloud Infrastructure Succeeded

Amazon Web Services succeeded because it solved three hard problems at once. First, abstraction: developers no longer needed to know the physical location, hardware model, or maintenance schedule of the server running their code. An EC2 instance is an EC2 instance. Second, standardized billing: compute is priced by the unit (CPU-hour, GB-month), making cost predictable and discoverable without a sales conversation. Third, SLAs with teeth: AWS commits to 99.99% uptime with documented remedies for failures, backed by contractual obligations rather than reputation alone.

These three properties — capability abstraction, unit pricing, and credible commitment — allowed the cloud ecosystem to compose. A startup in 2008 could string together S3, EC2, RDS, and SQS without speaking to a human, because each service published what it did, what it cost, and what happened if it failed.

### 1.2 Why Physical Manufacturing Has Not Had Its AWS Moment

Physical manufacturing is the largest sector of the global economy and remains almost entirely opaque to programmatic access. A company that needs aluminum parts milled, anodized, and inspected must find vendors manually, negotiate contracts individually, manage delivery schedules in spreadsheets, and verify quality through sampling and relationship trust. None of this is API-accessible. None of it composes.

The structural reasons are not lack of technology. CNC machines, lab instruments, and industrial sensors are increasingly networked. The missing layer is not connectivity — it is coordination. Specifically:

- **No capability abstraction**: There is no universal format for expressing what a machine can do. A Haas VF-2 and a Tormach PCNC 440 are both 3-axis CNC mills, but their tolerable geometries, supported materials, and achievable surface finishes differ significantly. No standard lets these machines advertise their actual working envelope in a way that agents can reason about.
- **No trustless pricing**: Quoting requires a human conversation because no machine-readable format encodes pricing rules that respond to job parameters (material, tolerance, batch size, delivery speed).
- **No credible settlement**: Payment is contingent on trust, not cryptographic proof. If a part fails inspection, the legal and financial resolution is slow, expensive, and uncertain.
- **No composability**: Multi-step workflows (machine → treat → inspect → ship) cross organizational boundaries, each with separate contracts, separate escrow relationships, and no shared notion of evidence.

### 1.3 The Gap: No Neutral Coordination Layer

Every attempt to build a "manufacturing marketplace" has produced a platform, not a protocol. Platforms aggregate supply and demand but position themselves as intermediaries — they take a percentage, they own the relationships, and they create lock-in. The physical world needs what the internet needed: a protocol, not a platform. A layer that is credibly neutral because no single party controls it, and that composes because it has defined, machine-readable primitives.

PCC is that protocol layer. It is not a marketplace. It is a control plane.

---

## 2. Architecture

PCC's architecture follows the same organizing principle as cloud infrastructure: abstract the physical into billable, auditable, composable units.

### 2.1 Shop Kernels as Availability Zones

A Shop Kernel is the edge compute node for a physical site. It runs as a Fastify service, connects to local devices through typed adapters, emits evidence from every job, and exposes a standardized API to the rest of the network. Like an AWS Availability Zone, a Shop Kernel is independent: it has its own devices, its own queue, and its own identity on-chain. Failure of one Kernel does not cascade.

Each Kernel connects to physical devices through a typed adapter layer. The current adapter registry supports:

| Protocol | Discovery | Use Case |
|----------|-----------|----------|
| IPP (Internet Printing Protocol) | mDNS `_ipp._tcp` | 2D printers (Canon, HP, Brother) |
| OctoPrint REST API | mDNS `_octoprint._tcp` | 3D printers via OctoPrint |
| Modbus TCP/RTU | Manual config | Industrial sensors, PLCs |
| OPC-UA | Discovery endpoint | CNC machines, industrial automation |
| SiLA 2 | SiLA Discovery | Lab instruments (Hamilton, Tecan, Beckman) |
| Generic HTTP | Manual URL | Any device with a REST API |

Every Kernel has a W3C DID (`did:key` Ed25519 or `did:pcc`), a wallet for on-chain settlement, and a reputation score maintained by the network's ERC-8004 identity registry.

### 2.2 Capabilities as the Billing Unit

The fundamental departure from existing manufacturing marketplaces is the unit of account. PCC does not list machines — it lists capabilities. A capability is not "Prusa MK4 printer at 192.168.1.50." It is "FDM extrusion: PETG/PLA/ABS, build volume 250×210×210mm, layer heights 0.1–0.35mm, ±0.2mm dimensional accuracy, heated bed, tier-2 assurance available."

This matters because:

1. **Buyers describe requirements, not equipment**: A customer who needs a structural bracket printed in PETG does not need to know what printer produces it. They specify the material, dimensions, and tolerance. The network matches to capable equipment.
2. **Dynamic routing**: When one Kernel is busy or unavailable, the BrokerAgent routes to an equivalent capability elsewhere. This is not possible if the booking is for a specific machine.
3. **Pricing from parameters**: A capability's price varies by job parameters. FDM printing in ABS costs more than PLA because it requires an enclosure, higher nozzle temperatures, and longer cooldown. The capability's pricing rules encode this. No quote call required.

### 2.3 Assurance Tiers as SLAs

Every capability advertises the assurance level it can provide, from 0 to 3:

- **Tier 0**: Self-reported completion. Job receipt with timestamp. Suitable for low-stakes jobs where the buyer trusts the operator.
- **Tier 1**: Protocol verification. Machine-generated logs (OctoPrint completion state, IPP job-state, Modbus register snapshots) proving the adapter executed. Evidence is content-addressed to IPFS.
- **Tier 2**: Quality verification. Sensor readings, QC photographs, dimensional measurements, or chromatography results. Evidence is encrypted via Lit Protocol and content-addressed. Bittensor subnet scores quality.
- **Tier 3**: Third-party attestation. Independent EvaluatorAgent reviews evidence. ZK Merkle proof anchors the commitment on Starknet. Disputes go to UMA arbitration.

Higher tiers require larger bonds from the operator. A Tier-2 job requires the operator to post a slashable bond before the job begins. If evidence is rejected during the challenge window, the bond is slashed and redistributed to the challenger and the network treasury.

### 2.4 Milestone Escrow with Slashable Bonds

Settlement in PCC is not payment processing — it is programmable escrow with aligned incentives. The `MilestoneEscrow` Solidity contract, deployed on Base Sepolia, enforces the following lifecycle:

1. Customer funds the escrow before work begins. Funds are locked — the operator cannot access them, and the customer cannot withdraw unilaterally while work is in progress.
2. Operator posts a bond proportional to the assurance tier. This is skin in the game.
3. Job executes. Evidence flows from the Kernel to IPFS and the evidence DB.
4. Challenge window opens (duration varies by tier: 0–72 hours). Any party with standing can challenge by submitting counter-evidence.
5. If no challenge is raised, funds release automatically to the operator. The bond is returned.
6. If a challenge is raised, evidence goes to the verification layer (Bittensor consensus for Tier 2, UMA for Tier 3). The bond is slashed proportionally to the finding.

This structure means operators have an economic incentive to do the work correctly, not just to complete it.

---

## 3. Capability StructureDefinitions (CSD)

The capability abstraction requires a format for describing what a machine can do in a way that is machine-readable, constraint-aware, version-controlled, and composable. PCC's answer is the Capability StructureDefinition (CSD), directly inspired by FHIR StructureDefinitions.

### 3.1 The FHIR Analogy

FHIR (Fast Healthcare Interoperability Resources) solved an analogous problem in healthcare. Medical devices, lab systems, and EHRs all needed to exchange data, but the same concept — a "blood pressure reading" — had dozens of incompatible encodings. FHIR introduced StructureDefinitions: formal JSON schemas that define, constrain, and extend clinical data types with inheritance, invariants, and cross-field constraints. A US Core Patient profile says "a US Core Patient MUST have a race extension." A FHIR validator enforces this at runtime.

PCC's CSD plays the same role for physical capabilities. A base CSD for `pcc://capabilities/fdm/v2` defines the universal parameters for FDM printing: material, layer height, infill density, support structures, build volume. A device-specific profile (`pcc://capabilities/prusa-mk4/v1`) inherits from the base and narrows: removes materials the printer cannot handle, restricts the build volume to 250×210×210mm, adds printer-specific extensions like input shaping. A runtime validator enforces these constraints when a job is submitted.

### 3.2 CSD Structure

A CSD is a self-describing JSON document. Its key sections:

- **`discovery`**: How to find devices of this type on the network. Protocol hints (IPP, OctoPrint, mDNS service type, Modbus register map), detection queries, and attribute mappings.
- **`adapter`**: Which adapter protocol drives the machine and the command schema (print, status, cancel, emergency stop).
- **`parameters`**: The typed, annotated parameter space for a job. Each parameter has a type (enum, number, boolean, string), validation rules (min/max/step/regex), grouping for UI display, and pricing impact.
- **`constraints`**: Cross-parameter rules evaluated at job-configuration time. Example: "borderless printing requires photo paper; if `borderless=true` and `mediaType` is not in `[photographic-high-gloss, photographic-matte]`, reject with message." These are the equivalent of FHIR's FHIRPath invariants — but for physical processes.
- **`invariants`**: Device-level conditions that must hold regardless of job parameters. Example: "custom paper size requires a printer that can handle A3 dimensions."
- **`evidence`**: Per-tier evidence requirements. Tier 0 requires `[jobId, timestamp, pageCount]`. Tier 2 requires additionally `[ippJobState, ippJobId, outputScanCid]`.
- **`pricing`**: Base price, currency, unit (per page, per gram, per hour), minimum charge, and pricing impact rules for individual parameters.

### 3.3 Auto-Discovery Pipeline

The self-describing property of CSDs enables zero-config onboarding. When an agent discovers a device on the network, it follows a deterministic pipeline:

```
mDNS scan → find _ipp._tcp / _octoprint._tcp services
→ Query device capabilities (IPP Get-Printer-Attributes, OctoPrint /api/printerprofiles)
→ Map reported attributes to CSD parameter space
  (IPP media-supported → mediaSize options, sides-supported → duplex options)
→ Intersect with base CSD (remove options device doesn't support, add device extensions)
→ Generate device-specific CSD profile with canonical URI
→ Validate CSD (schema validation, constraint consistency, pricing sanity)
→ Register: IPFS publication + DB record + on-chain hash commitment
→ Start adapter and run test job
```

For a Canon PIXMA TR8620, the agent reads `printer-make-and-model`, `media-supported`, `print-color-mode-supported`, `printer-resolution-supported`, and `finishings-supported` from the IPP endpoint and constructs a complete, validated CSD profile in seconds, without any human configuration.

### 3.4 Constraint Propagation and Invariants

The constraint engine runs on every parameter change. When a user or agent sets `borderless=true`, the engine:
1. Evaluates all constraints involving `borderless` as a trigger condition
2. Finds constraint `2d-print-1`: borderless requires photo paper
3. Checks if `mediaType` satisfies the condition
4. If not, either rejects (severity: error) or warns (severity: warning) immediately

This enables real-time interactive configuration — the same mechanism that powers a UI form graying out incompatible options also powers an agent's decision loop when composing job parameters. The constraint engine is a first-class part of the protocol, not a UI concern.

Invariants operate at the device level rather than the parameter level. An invariant expression like `mediaSize != 'custom' or device.capabilities.includes('iso_a3_297x420mm')` is evaluated at job-acceptance time against the actual device's reported capabilities, preventing jobs from reaching devices that cannot physically execute them.

### 3.5 CSD Registry with URI Addressing and Inheritance

CSDs are organized in a URI namespace with hierarchical inheritance:

```
pcc://capabilities/                     root namespace
├── fdm/v2                              base: FDM 3D printing
│   ├── prusa-mk4/v1                    device profile (inherits fdm/v2)
│   ├── bambulab-x1c/v1
│   └── ender-3-v3/v1
├── cnc-3axis/v1                        base: CNC milling
│   ├── haas-vf2/v1
│   └── tormach-pcnc440/v1
├── 2d-print/v1                         base: 2D printing
│   ├── inkjet/v1                       protocol profile
│   │   └── canon-pixma-tr8620/v1       device profile
│   └── laser/v1
└── hplc/v1                             base: HPLC analysis
```

Each CSD is stored in three places: IPFS (canonical, content-addressed, immutable), SQLite (local cache for fast queries), and on-chain (hash commitment for integrity verification). URI resolution queries the local SQLite cache first, falling back to the IPFS registry.

Versioning follows semantic versioning. Breaking changes — removed parameters, narrowed constraint ranges — require a major version bump. Additive changes — new optional parameters, widened ranges — are minor. The version is part of the canonical URI, so old references remain valid indefinitely.

---

## 4. Agent-to-Agent Protocol

Physical work is orchestrated by a three-agent system communicating over a typed A2A message bus. The protocol is designed for trustless coordination: agents do not share state, they exchange cryptographically signed messages with defined semantics.

### 4.1 Three-Agent Model

**UserAgent** acts on behalf of a customer. It holds the customer's wallet, formulates intent (building a workflow from a natural language description), calls the BrokerAgent to discover and price capabilities, assembles the contract, and releases funds from escrow when work is verified.

**BrokerAgent** is the network router. It has no physical capabilities of its own. It receives workflow intents from UserAgents, queries the capability registry, runs a competitive auction among KernelAgents offering matching capabilities, compiles multi-step DAGs, and manages the escrow lifecycle for each step.

**KernelAgent** wraps a Shop Kernel. It accepts job offers from BrokerAgents, executes them through the adapter layer, collects evidence, and emits evidence bundles to IPFS. It manages the Kernel's devices and reports health status.

### 4.2 Typed Intents

The message bus carries typed intents rather than free-form messages. PCC defines 34 intent types across seven categories:

| Category | Count | Example Intents |
|----------|-------|-----------------|
| Discovery | 4 | `capability_search`, `capability_search_result`, `kernel_status`, `kernel_status_result` |
| Quoting/Negotiation | 4 | `quote_request`, `quote_response`, `negotiation_counter`, `negotiation_accept` |
| Contract Builder | 4 | `build_contract`, `build_contract_result`, `workflow_compile`, `workflow_compile_result` |
| Job Lifecycle | 5 | `job_submit`, `job_accept`, `job_progress`, `job_complete`, `job_cancel` |
| Verification | 2 | `evidence_submit`, `evidence_verified` |
| Funding/Setup | 9 | `funding_request`, `funding_provided`, `setup_detect`, `setup_configure`, `setup_validate`, and variants |
| IP (Story Protocol) | 8 | `ip_register`, `ip_revenue_query`, `ip_propose_split`, `ip_claim_revenue`, and variants |

Every intent carries a sender DID, a conversation ID, a timestamp, and a cryptographic signature. The message bus routes by intent type, with each agent declaring which intents it handles.

### 4.3 Conversational Negotiation with NLP Routing

Agents can interact in natural language — the BrokerAgent has an NLP router that maps text messages to intent handlers. When a UserAgent says "I need 50 aluminum brackets machined, drilled, and anodized, delivered by Friday," the BrokerAgent:

1. Parses the request to extract capabilities needed (CNC milling, drilling, anodizing), material (aluminum), batch size (50), and deadline.
2. Queries the capability registry for matching CSDs.
3. Runs an auction: broadcasts `quote_request` to all KernelAgents offering compatible capabilities.
4. Receives `quote_response` messages, ranks by price/quality/availability.
5. Compiles a 3-step workflow DAG using the WorkflowCompiler (topological sort with dependency resolution).
6. Returns a structured `build_contract_result` with pricing breakdown, delivery timeline, and assurance tier options.
7. Waits for the UserAgent to approve and fund escrow.

The negotiation loop supports counter-proposals, constraint relaxation ("we can hit that delivery date if you accept Tier-1 assurance instead of Tier-2"), and multi-round bargaining. Revenue split terms for Story Protocol IP are negotiated in this same phase — the `ip_propose_split` and `ip_split_response` intents allow operators to counter-propose before committing to a job.

### 4.4 Agent Wallets and Spending Policies

Every agent carries its own wallet, separate from the operator's personal funds. Agent wallets are derived from the UnifiedKeychain (EVM via viem, Solana via `@solana/web3.js`). Each wallet operates under a configurable SpendingPolicy that enforces:

- Per-transaction limits
- Rolling-window budget caps (e.g., no more than $500 in any 24-hour period)
- Allowlisted contract addresses (can only call the MilestoneEscrow and IP registry contracts)
- Automatic refusal of transactions that exceed risk thresholds

SpendingPolicies are encoded as ERC-4337 session keys for EVM operations, limiting the blast radius if an agent is compromised or behaves unexpectedly.

---

## 5. Sovereign Infrastructure

PCC's evidence and identity layer is designed for censorship resistance. No central server holds the ground truth of what happened. Evidence is distributed across cryptographically linked storage and verification systems.

### 5.1 Evidence Storage: IPFS via Helia and Storacha

Every completed job produces an evidence bundle: a JSON document containing sensor readings, machine logs, QC measurements, operator attestations, and job metadata. The bundle is:

1. Canonicalized (deterministic JSON serialization for reproducible hashing)
2. Hashed (SHA-256, becomes the bundle's canonical ID)
3. Encrypted (AES-256-GCM via Lit Protocol, key fragments distributed across the network)
4. Pinned to IPFS via Helia (local node embedded in the Kernel)
5. Archived to Filecoin via Storacha w3up for durable long-term storage (`EVIDENCE_STORAGE=storacha`)

Content addressing means any party can independently verify a bundle: hash the bundle, compare to the CID stored on-chain. Tampering is detectable without trusting any server.

### 5.2 Access Control: Lit Protocol

Raw evidence data is encrypted. Lit Protocol's threshold encryption scheme distributes key fragments across a decentralized network of nodes. Access conditions are evaluated at decryption time: only the job's customer, the operator, the assigned verifier, or a party that wins a formal dispute can decrypt the bundle.

This means operators can post evidence publicly (as a CID on IPFS) without exposing sensitive process parameters, material compositions, or quality measurements to competitors. The CID proves the evidence exists; decryption requires authorization.

The integration supports both mock mode (AES-256-GCM with simulated access conditions, for development) and real mode (`@lit-protocol/lit-node-client` v6 on the `datil-test` network).

### 5.3 ZK Proofs Anchored to Starknet

The `StarknetProofAnchoringService` computes Merkle proofs over evidence bundle hashes and anchors the Merkle root on Starknet via Cairo contracts. This provides:

- **Selective disclosure**: A party can prove a specific evidence bundle was included in a commitment without revealing the entire batch
- **Efficient verification**: Verifying a Merkle proof is O(log n); the full dataset stays off-chain
- **Cross-chain anchoring**: Starknet's ZK rollup provides a secondary integrity checkpoint independent of the Base Sepolia escrow chain

Three gateway routes expose this: `POST /api/zk/anchor-starknet`, `GET /api/zk/verify-starknet`, and `GET /api/zk/starknet-status`.

### 5.4 Bittensor Verification Subnet

Tier-2 and Tier-3 evidence is scored by a Bittensor subnet. MockMiner nodes evaluate evidence quality against the tier's requirements (Did the sensor readings arrive? Are they in the plausible range? Does the QC photo match the job description?). A MockValidator applies Yuma Consensus to aggregate miner scores into a network-level quality verdict.

The subnet design is testnet-ready: the `BittensorSubnetBridge` connects PCC's evidence verification to a real Bittensor subnet, where economic incentives keep miners honest. Miners that consistently score incorrectly lose stake; miners that score correctly earn from the network.

### 5.5 W3C DIDs and Verifiable Credentials

Every Kernel, device, and agent has a W3C DID. The `did:pcc` method anchors identities on-chain via the ERC-8004 identity registry. The `did:key` method provides offline-generated Ed25519 identities for lightweight agents.

Completing verified work earns Verifiable Credentials: structured, signed JSON-LD documents asserting demonstrated capability. These are issued as soulbound cNFTs via Metaplex Core on Solana — non-transferable attestations that an operator's equipment has executed verified jobs at a specific assurance tier. A credential cannot be bought or transferred; it can only be earned.

---

## 6. Intellectual Property Layer: Story Protocol Integration

This is the layer that transforms PCC from a coordination protocol into an IP network. The key insight: physical work creates intellectual property, and that IP has been invisible until now.

### 6.1 Why Physical Work Creates IP

When a designer writes a Capability StructureDefinition for precision aluminum milling — encoding the parameter space, constraint rules, pricing logic, evidence requirements, and adapter configuration — they have created a design artifact. It encodes knowledge about how to correctly configure and price a manufacturing process. That knowledge has value: every time someone uses that CSD to run a job, they are building on the designer's work.

Similarly, when an operator produces verified evidence of a completed job, they have created a proof of execution. That evidence is a specific instance of the process the CSD describes. It is a derivative work.

The music industry solved an analogous problem decades ago. A songwriter earns royalties every time a band records their song. The band earns performance royalties every time a venue plays their recording. The rights are registered, the royalties flow automatically, and the original creator earns from every downstream use. Story Protocol brings this model to any form of programmable IP — and PCC applies it to physical manufacturing processes.

### 6.2 IP Assets: CSDs as Programmable IP on Story Network

Publishing a CSD on PCC simultaneously registers it as an IP Asset on Story Network (chain ID 1514, or Aeneid testnet 1513). The `StoryIPService.registerCapabilityAsIP()` call:

1. Builds IP metadata following the IPA Metadata Standard: title, description, capability type, assurance tier, kernel ID, creator address and name.
2. Uploads metadata to IPFS via the existing Storacha/Helia integration.
3. Calls `client.ipAsset.registerIpAsset()` with a commercial remix PIL (Programmable IP License): `commercialRevShare: 5` (5% of all derivative revenue flows to this IP Asset's Royalty Vault).
4. Returns an `ipId` — the IP Account address (an ERC-6551 Token Bound Account) — which is stored alongside the CSD in PCC's database.

The CSD is now a programmable IP Asset. It has an on-chain identity, a Royalty Vault, and 100 Royalty Tokens representing shares of its revenue stream. These tokens can be distributed to collaborators at registration time.

The concept mapping between PCC and Story Protocol:

| PCC Concept | Story Protocol Concept |
|-------------|----------------------|
| CSD (Capability StructureDefinition) | IP Asset (ERC-721 + IP Account) |
| Capability contract (booking) | License (PIL terms minted at booking) |
| Job evidence bundle | Derivative IP Asset (child of the CSD) |
| Multi-step workflow | IP chain (parent → child → grandchild) |
| MilestoneEscrow release | Royalty payment to IP Royalty Vault |
| CSD fork (inheritance) | Derivative IP with automatic rev-share |
| Operator revenue share | Royalty Token holding |
| Challenge window dispute | Story Dispute Module (UMA arbitration) |

### 6.3 Derivative IP: Every Job Is a Proof of Execution

When a job completes and evidence is finalized, `StoryIPService.registerJobAsDerivative()` registers the evidence bundle as a child IP Asset of the CSD:

```
CSD: pcc://capabilities/cnc-3axis/v1   →  ipId: 0xA1... (parent IP)
  └── Job JOB-20260321-001 evidence    →  ipId: 0xB2... (child, derivative)
       └── Inspection report output    →  ipId: 0xC3... (grandchild, derivative)
```

This creates an on-chain provenance chain. Anyone can trace: this part was made using that process, which was derived from that capability definition, authored by that person, verified by that subnet, and settled at that escrow address. The chain is immutable and publicly auditable.

Royalty flows are automatic: when the job's escrow releases on Base Sepolia, a configured portion (default 5% of job value) flows as a royalty payment to the parent CSD's IP Royalty Vault via `StoryIPService.payJobRoyalty()`. The vault accumulates revenue; Royalty Token holders claim their share whenever they choose via `claimRevenue()`.

### 6.4 Royalty Flows: Multi-Party Revenue Splits

Every IP Asset's Royalty Vault holds 100 Royalty Tokens. PCC distributes these tokens according to the role each party played in creating the capability:

| Role | Default Tokens | Revenue Share | Who |
|------|----------------|---------------|-----|
| CSD Designer | 10 | 10% | Person who authored the capability definition |
| Machine Operator | 70 | 70% | Person whose equipment ran the job |
| Verifier | 10 | 10% | Subnet/agent that verified evidence quality |
| Network Treasury | 10 | 10% | PCC protocol fee, non-transferable |

These are defaults. During the contract negotiation phase, the BrokerAgent can propose custom splits — operators can require a minimum revenue floor, designers can negotiate higher royalty rates for novel processes, and multi-party collaborations can encode arbitrary splits as on-chain license terms before the job begins. Once the job starts, the split is immutable.

Royalty Tokens are ERC-20 tokens. A designer who publishes a CSD and receives 10 Royalty Tokens can hold them indefinitely, sell them to investors, or distribute them to collaborators who helped design the process. This creates a secondary market for manufacturing process IP — a liquid asset class that did not previously exist.

### 6.5 Multi-Step Workflow IP Chains

A 4-step workflow — CNC milling → anodizing → quality inspection → shipping — creates four IP Assets, one per step. The customer pays once; the BrokerAgent distributes payment across the escrow chain, and each step's escrow release triggers a royalty payment to the corresponding IP Royalty Vault:

```
Customer pays $100 for the full workflow
├── Step 1: CNC Milling  ($40) → IP Asset 0xA1
│   ├── CNC CSD Designer (10%): $4.00
│   ├── CNC Operator (70%):     $28.00
│   ├── Verifier (10%):          $4.00
│   └── Network (10%):           $4.00
├── Step 2: Anodizing    ($25) → IP Asset 0xB1
│   └── [same distribution pattern — $2.50 / $17.50 / $2.50 / $2.50]
├── Step 3: Inspection   ($15) → IP Asset 0xC1
│   └── [same distribution pattern]
└── Step 4: Shipping     ($20) → IP Asset 0xD1
    └── [same distribution pattern]

Additionally: 5% of each step's revenue flows to parent CSD IP Assets
(when a device CSD is a fork of a base CSD, the base earns from all derivatives)
```

When a CSD is derived from another CSD, the revenue flows up the IP chain automatically through Story Protocol's derivative royalty mechanism. A step-2 anodizing CSD that derives from a base anodizing CSD pays 5% to the base's Royalty Vault, which flows to the base's Royalty Token holders.

### 6.6 CSD Forking: Remix a Capability, Parent Earns Forever

The CSD registry supports inheritance. When an operator takes the base `pcc://capabilities/fdm/v2` and creates `pcc://capabilities/bambulab-x1c/v1` with X1C-specific parameters, the fork is registered as a derivative IP Asset of the parent.

From that point forward:
- Every job run using the fork generates 5% royalties flowing to the parent CSD's IP Royalty Vault
- The fork can itself be further forked, creating multi-generation chains
- The original author of `fdm/v2` earns micropayments from every FDM job run on the entire network, regardless of which specific device profile was used

A researcher who designs a novel PCR amplification protocol, encodes it as a CSD, and publishes it to the PCC registry earns every time any lab on the network runs that protocol — whether they use the base CSD directly or any of its device-specific derivatives. This is the music royalty model applied to manufacturing processes.

### 6.7 The CSD as a Durable Design Asset

The critical distinction between PCC and previous coordination systems is that capability definitions are treated as first-class intellectual property, not throw-away configuration files. A CSD represents accumulated engineering knowledge: which parameter combinations are valid for which materials, which evidence types are meaningful for which assurance claims, how pricing should respond to job complexity. This knowledge is valuable and deserves to be compensated.

Story Protocol's IP infrastructure ensures this compensation is:
- **Automatic**: Revenue flows to Royalty Vaults without anyone manually triggering payments
- **Proportional**: Each contributor earns in proportion to their contribution (encoded as Royalty Tokens)
- **Permanent**: The on-chain record persists for the life of the blockchain; a designer earns from their CSD for as long as it is used
- **Composable**: Royalty Token portfolios can be sold, staked, or used in DeFi protocols built on Story Network

### 6.8 Dispute Resolution via Story Protocol

Story Protocol's Dispute Module uses UMA's optimistic oracle for on-chain arbitration. When a PCC challenge window produces a contested dispute:

1. The challenger calls `StoryIPService.raiseDispute()` with an evidence hash and reason string
2. Story's DisputeModule (deployed at `0x9b7A9c70AFF961C799110954fc06F3093aeb94C5`) opens an optimistic dispute period
3. If the defendant does not respond within the challenge window, the dispute resolves in the challenger's favor
4. If contested, UMA token holders adjudicate; the losing party's bond is slashed

This supplements PCC's own challenge windows with a decentralized arbitration layer that operates independently of PCC's gateway — ensuring disputes can be resolved even if PCC's infrastructure is temporarily unavailable.

---

## 7. Economic Model

### 7.1 Per-Capability Pricing with Constraint-Aware Calculators

Every CSD encodes a pricing model. The base price sets the floor; parameter selections apply multiplicative or additive modifiers. For an FDM print job:

```
Base price: $0.50/gram
Material modifier: PLA=1.0×, PETG=1.4×, ABS=1.6×, Nylon=2.2×
Resolution modifier: 0.3mm=0.8×, 0.2mm=1.0×, 0.1mm=1.8×
Infill modifier: 20%=1.0×, 50%=1.3×, 100%=2.0×
Supports: none=$0.00, generated=$0.15/gram (estimated weight)
Minimum charge: $5.00
```

The pricing calculator runs both in the browser (real-time configuration preview) and server-side (binding quote generation). Agents can call the `pcc_calculate_price` MCP tool to get a binding quote before submitting a job. No human conversation required.

Operators can set overrides on top of CSD pricing: maximum price ceilings, minimum revenue floors, volume discounts for batch orders, and dynamic pricing via Meteora DLMM pools (adjusting price based on current queue depth and market demand signals).

### 7.2 Escrow with Challenge Windows

The escrow lifecycle creates a sealed, time-boxed settlement window that removes the need for trust between parties who have never met. Tier-0 jobs settle immediately on evidence submission. Tier-3 jobs hold a 72-hour challenge window during which any party with standing can submit counter-evidence. During the window, neither the operator nor the customer can unilaterally touch the funds.

This structure means the economic risk is symmetric and clearly allocated before work begins — a significant improvement over traditional manufacturing contracts where payment disputes can extend for months.

### 7.3 DePIN Reward Epochs

Operators who consistently execute verified work earn additional rewards from the network treasury through DePIN epoch scoring. The `RewardEngine` evaluates operators on three axes:

- **Uptime**: What fraction of scheduled hours was the device available and accepting jobs?
- **Quality**: What is the mean evidence quality score from the Bittensor subnet?
- **Throughput**: How many verified jobs were completed in the epoch?

Epoch rewards create a baseline income floor for operators who maintain reliable infrastructure, even during periods of low demand. This incentivizes sustained participation rather than cherry-picking only high-value jobs.

### 7.4 Royalty Tokens as Process IP Equity

Royalty Tokens represent fractional ownership of a capability's revenue stream. A designer who publishes a CSD receives 10 Royalty Tokens (10% of all revenue). They can hold these indefinitely, sell them to investors, or distribute them to collaborators.

This creates a secondary market for manufacturing process IP. A researcher who designs a breakthrough polymerization process and encodes it as a CSD can sell a portion of their Royalty Tokens to a lab equipment manufacturer interested in seeing the protocol proliferate. Both parties earn proportionally from the protocol's adoption. Process IP becomes a liquid asset class.

### 7.5 Network Treasury and Protocol Fees

PCC's network treasury receives 10% of every job's royalty payment. These funds finance:

- Bittensor subnet incentives (paying miners to evaluate evidence)
- ZK proof anchoring costs (Starknet transaction fees)
- Story Protocol transaction fees (IP registration and royalty distribution)
- Protocol development grants
- Dispute resolution bond pool

Treasury flows are on-chain and auditable.

---

## 8. Setup Agent: Zero-Config Onboarding

The vision is radical accessibility: a person with any networked device — a 3D printer, a CNC machine, a lab instrument, even a standard inkjet printer — should be able to join the PCC network with minimal technical knowledge.

### 8.1 The "Dad in Florida" Test

The test for the onboarding experience is not "can a DevOps engineer configure this" — it is "can my 70-year-old dad in Florida get his Canon inkjet printer earning money on the PCC network." This standard forces radical simplification.

The flow:

1. Dad installs the PCC agent (npm package or standalone binary)
2. Agent scans the local network via mDNS, finds Canon PIXMA TR8620a at `192.168.1.50`
3. Agent reports: "Found your Canon PIXMA. It can print color/B&W, Letter/A4/Legal, up to 4800 DPI, double-sided. Want to add it to PCC?"
4. Dad says yes
5. Agent generates a wallet, requests testnet funds from the faucet, and registers the device
6. Agent prints a test page to verify the pipeline: submit → IPP Print-Job → evidence collected → settlement
7. Done. The printer is live on PCC

The full onboarding requires exactly three decisions from the operator: confirm the detected device is correct, approve the generated config, and optionally fund the wallet if on-chain settlement is needed. Everything else is automated.

### 8.2 MCP Tools for Agent-Driven Setup

The `@pcc/mcp-server` exposes 29 tools, including 10 setup-specific tools:

| Tool | Purpose |
|------|---------|
| `pcc_setup_detect` | Auto-detect current config state (env vars, DB, chain, adapters, storage, identity) |
| `pcc_setup_generate_config` | Generate `KERNEL_CONFIG` JSON from device descriptions |
| `pcc_setup_validate_config` | Validate adapter connectivity and configuration completeness |
| `pcc_setup_register_device` | Register a device in the network DB and run health check |
| `pcc_setup_health_check` | Ping all configured devices and report status |
| `pcc_setup_generate_env` | Generate a `.env` file for a deployment profile (dev/testnet/mainnet) |
| `pcc_setup_deploy_contracts` | Deploy escrow contracts to testnet (requires funded wallet) |
| `pcc_setup_register_identity` | Register Kernel identity via ERC-8004 |
| `pcc_setup_test_job` | Run an end-to-end test job (submit → execute → evidence → settle) |
| `pcc_setup_status` | Comprehensive status across all categories with remediation steps |

Any AI agent — Claude Code, Cursor, a custom GPT assistant — can call these tools to walk an operator through setup conversationally, with no manual environment variable configuration.

### 8.3 SetupAgent and A2A Intents

The `SetupAgent` extends `BaseAgent` and handles setup-specific intents: `setup_detect`, `setup_configure`, and `setup_validate`. It orchestrates the detection, configuration, and validation phases, routing text messages to setup commands via NLP. The same logic that backs the MCP tools is accessible via the A2A protocol, enabling automated onboarding pipelines where a parent orchestrator can set up multiple kernels in parallel.

The agent's machine-readable `AGENT_INSTRUCTIONS.md` provides a 12-step onboarding guide that any LLM agent can follow without human translation — making PCC the first manufacturing network that can be onboarded entirely by an AI acting on behalf of a user.

---

## 9. Related Work

### 9.1 Asset Administration Shell (AASX/AAS)

The Asset Administration Shell (AASX), developed under IEC 63278 and maintained by the Industrial Digital Twin Association (IDTA), is the closest existing standard to PCC's CSD. AAS defines digital twins of physical assets with typed Submodels (NameplateV2, TechnicalDataV1, etc.) and hierarchical inheritance via SubmodelTemplates.

PCC's CSD differs from AASX in three critical ways:

1. **Interactive constraint propagation**: AASX has no constraint engine. SubmodelTemplates describe what data a Submodel may contain, but they do not constrain how selecting one parameter affects the valid range of another. PCC's constraint engine handles bidirectional cross-parameter dependencies in real time — essential for agent-driven job configuration.

2. **Economic primitives**: AASX is an engineering data model. It has no concept of per-job pricing, evidence tiers, slashable bonds, or settlement. PCC's CSD embeds pricing rules, evidence requirements, and assurance tier definitions directly in the capability description.

3. **Agent-first design**: AASX is designed for OPC UA servers and Industry 4.0 middleware. PCC's CSD is designed for LLM agents consuming MCP tools and A2A intents. The discovery and adapter sections are specifically designed to be actionable by autonomous agents without human translation.

PCC plans to build a bidirectional CSD ↔ AASX Submodel Template translator for industry interoperability.

### 9.2 MTConnect

MTConnect (IIC/ANSI) is a read-only telemetry standard for CNC machine tools. It answers "what is this machine doing right now?" — not "what can this machine do?" The SensorPipeline in `@pcc/kernel` uses MTConnect-compatible semantics for sensor data taxonomy, but MTConnect is not suitable as a capability advertisement format.

### 9.3 OPC UA Companion Specifications

OPC UA's companion specification system (OPC UA for Machine Tools, OPC 40501) is structurally analogous to CSD base types and device profiles. OPC UA's type hierarchy supports subtype inheritance and device-level instantiation. The key gap: no cross-field constraint mechanism. OPC UA types can specialize further (additive inheritance) but cannot narrow the valid range of a base type's fields. PCC's CSD constraint system explicitly solves this.

PCC's adapter layer includes an OPC-UA adapter, and CSD profiles can reference OPC UA node addresses for parameter mapping, enabling PCC to serve as an IP and coordination layer on top of existing OPC UA infrastructure.

### 9.4 SiLA 2

SiLA 2 (Standardization in Lab Automation) is the closest analog to PCC's CSD for laboratory instruments. SiLA Feature Definitions (FDLs) describe instrument commands with typed parameters and return values, exposed via gRPC. PCC includes a `SiLAAdapter` that connects SiLA 2 instruments to the kernel, with CSD profiles for HPLC, PCR, and liquid handling capabilities.

### 9.5 The FHIR Inspiration

PCC's CSD format was directly inspired by BabelFHIR-TS, a FHIR StructureDefinition compiler that generates TypeScript interfaces and runtime validators from FHIR profiles. The planned `BabelPCC` compiler will compile CSDs to TypeScript interfaces, runtime validators, pricing calculators, adapter scaffolds, and test data generators — the same toolchain that FHIR developers use for healthcare interoperability, applied to physical manufacturing.

---

## 10. Technical Implementation

PCC is a pnpm monorepo of 22 packages and one application, implemented in TypeScript (ES2022, NodeNext module resolution, strict mode) with Turbo for build orchestration.

### 10.1 Package Architecture

| Package | Description |
|---------|-------------|
| `@pcc/spec` | Canonical types, Zod schemas, ID generation, W3C DIDs, VCs, Story IP types |
| `@pcc/kernel` | Shop Kernel runtime: adapters, EvidenceEmitter, JobRunner, SensorPipeline, BatchTracker, EncryptionService, IPFS/Storacha storage |
| `@pcc/contracts` | Solidity: MilestoneEscrow, MockUSDC; TS: CapabilityCertificateService, RewardEngine, StoryIPService |
| `@pcc/scheduler` | WorkflowCompiler (DAG/topo-sort), CapabilityRouter, competitive auction |
| `@pcc/verifier` | VerifierMarket, EvidenceVerifier, CommitmentService (Merkle), ZKProofService, BittensorSubnetBridge |
| `@pcc/payments` | x402 middleware + client; Meteora DLMM capability pricing pools |
| `@pcc/contract-builder` | Schema-driven contract builder: templates, profiles, resolver, pricing, validator |
| `@pcc/orchestrator` | TransferGraph, ResourcePool, SampleTracker, ProtocolEngine, ProtocolRunner |
| `@pcc/a2a` | 34 typed intents, MessageBus, Conversations |
| `@pcc/agent-runtime` | BaseAgent, AgentWallet (viem), SolanaAgentWallet, SpendingPolicy, ERC-4337 session keys |
| `@pcc/agent-user` | UserAgent: discover, negotiate, submit, build contracts |
| `@pcc/agent-broker` | BrokerAgent: routing, escrow, NLP, FundingHandler |
| `@pcc/agent-kernel` | KernelAgent: wraps kernel, jobs, evidence |
| `@pcc/agent-evaluator` | EvaluatorAgent: quality assessment, ACP bridge, reputation |
| `@pcc/identity-8004` | ERC-8004 identity/reputation/validation registry clients, cross-chain registration |
| `@pcc/onboard-kit` | quickStart, scaffold, validate, CLI, AGENT_INSTRUCTIONS.md |
| `@pcc/ui` | Solarpunk component library: 64+ components, DIDBadge, IPFSLink, ChainTxLink |
| `@pcc/gateway` | Fastify REST/SSE: 130+ endpoints, StreamHub, SIWE auth, x402 gate |
| `@pcc/dashboard` | Vite SPA: 52 routes, React Flow builders, Recharts, 18-step onboarding tour |

### 10.2 Test Coverage

The test suite has 1,174 passing tests across 69 test files. Coverage spans unit tests for every package, integration tests for the gateway API, and end-to-end simulations:

- `scripts/e2e-simulation.ts`: Kernel-level E2E (job submit → adapter execute → evidence → settlement)
- `scripts/agent-e2e-simulation.ts`: Agent-to-agent negotiation (UserAgent → BrokerAgent → KernelAgent)
- `scripts/sovereign-e2e-simulation.ts`: 9-phase sovereign infrastructure test (DIDs, IPFS, Lit, ZK, Bittensor, DePIN, cNFTs)
- `scripts/openclaw-print-deliver-e2e.ts`: OpenClaw print-and-deliver scenario (3 variations, 37 assertions)

### 10.3 Dual-Chain Architecture

PCC operates across two blockchains with distinct roles:

**Base Sepolia (chain 84532)**: Escrow and settlement. The `MilestoneEscrow` contract holds customer funds, manages bonds, and releases payment when evidence is verified. All economic settlement happens here. Base provides low gas costs and full EVM compatibility.

**Story Network (chain 1514 / Aeneid testnet 1513)**: IP registration, licensing, royalties, and disputes. CSDs are registered as IP Assets here. Royalty Token distribution and revenue claims happen on Story. The `StoryIPService` bridges the two chains: when escrow releases on Base, it triggers a royalty payment on Story.

x402 (HTTP 402 Payment Required) handles per-request micropayments for lightweight digital services — API access, data feeds, computation — without requiring full escrow setup.

### 10.4 Dashboard

The dashboard is a 52-route Vite/React 19 SPA with React Router v7, TanStack Query v5, Zustand v5, Tailwind v4, React Flow (DAG visualization), and Recharts. Key views:

- **Contract Builder** (`/build`): Process selector → parameter configurator with real-time constraint validation → pricing preview with Story Protocol revenue split display
- **Workflow Builder** (`/workflow`): React Flow DAG editor for assembling multi-step capability chains
- **Evidence Explorer** (`/evidence`): Encrypted evidence bundles with decrypt-on-demand and ZK proof status
- **DePIN Dashboard** (`/depin`): Treasury balance, soulbound certificate registry, reward epoch history
- **Operator Dashboard** (`/operator`): Machine management, earnings, capability certificates, IP Asset holdings

---

## 11. Future Work

### 11.1 BabelPCC Compiler

The `BabelPCC` compiler will transform CSDs into type-safe TypeScript artifacts: interfaces for job parameters, runtime validators, pricing calculators, adapter scaffolds, and test data generators. The compiler will be published as an npm package (`babelpcc`) and integrated into the PCC CLI:

```bash
babelpcc compile pcc://capabilities/fdm/v2 --output ./generated/
# Output:
# generated/fdm.ts               — interfaces (FDMParams, FDMConfig)
# generated/fdm.validator.ts     — runtime validation
# generated/fdm.pricing.ts       — price calculator
# generated/fdm.adapter.ts       — adapter scaffold
# generated/fdm.test.ts          — test data generators
```

### 11.2 Cross-Chain Bridges

Story Network, Base, and Solana operate as independent settlement and identity chains. Cross-chain bridges will enable:

- Royalty Tokens minted on Story to be staked in Base DeFi protocols
- Solana soulbound cNFTs to carry Story IP lineage metadata
- Cross-chain escrow settlement: customer funds in USDC on Base → royalties distributed in WIP on Story → certificates minted on Solana in a single atomic transaction

### 11.3 Real Hardware Integration at Scale

The current integration targets OctoPrint, Modbus, OPC-UA, SiLA 2, and IPP. Future adapters will include:

- **OpenClaw / OpenDroids**: Robot arm control via ROS 2 + Isaac ROS for lab automation tasks
- **GMP pharmaceutical**: Batch manufacturing via SiLA 2 + 21 CFR Part 11 evidence for regulatory compliance
- **Semiconductor equipment**: Fab-grade interfaces via SECS/GEM and SEMI E164 standards

### 11.4 Industry 4.0 Interop via AASX Mapping

A bidirectional CSD ↔ AASX Submodel Template translator will enable PCC to interoperate with Industry 4.0 systems that already speak AASX. A CNC shop running a Siemens MES can export its AAS to PCC, which translates it to a CSD and registers it on the network. PCC capabilities can also be exported as AASX for consumption by traditional industrial systems — allowing PCC to overlay IP and settlement on top of existing Industry 4.0 infrastructure rather than requiring a full replacement.

### 11.5 Story Protocol Mainnet Migration

Current Story integration targets the Aeneid testnet (chain 1513). Migration to Story mainnet (chain 1514) requires funded IP wallets and production-grade royalty vault management. The `StoryIPService` is designed for zero-configuration switching: setting `STORY_NETWORK=story` and `STORY_MOCK=false` activates production mode with no code changes required.

---

## 12. Conclusion

Physical Capability Cloud is the missing coordination layer for the physical world. It applies the three principles that made cloud infrastructure succeed — capability abstraction, unit pricing, and credible commitment — to physical manufacturing, adding the sovereign infrastructure (encrypted IPFS evidence, Lit Protocol access control, Bittensor quality verification, Starknet ZK anchoring) needed for trustless operation, and the IP layer (Story Protocol) needed to make physical work financially composable.

The result is a network where a machinist in Detroit and a biologist in Boston can form a trustless workflow without a broker, a marketplace, or a negotiated contract. Where the intellectual property embedded in a manufacturing process earns royalties for its designer forever. Where verified physical work builds permanent on-chain credentials. Where any AI agent can discover, book, and settle a physical capability through a typed API, the same way it calls any other microservice.

The Story Protocol integration is not an afterthought — it is the mechanism that makes the network self-sustaining. When designers earn from every use of their CSDs, they are incentivized to publish better definitions. When operators earn not just from execution but from the IP equity in their device profiles, they are incentivized to maintain and improve their capabilities. When the network treasury accumulates from protocol fees, it can fund the verification infrastructure that makes evidence credible. The economic flywheel is fully specified in the protocol.

This is not a marketplace. It is a protocol — and protocols are how the internet got built.

---

## Appendix A: Story Protocol Contract Addresses

Both Story mainnet (chain 1514) and Aeneid testnet (chain 1513) share the same addresses:

| Contract | Address |
|----------|---------|
| IPAssetRegistry | `0x77319B4031e6eF1250907aa00018B8B1c67a244b` |
| LicenseRegistry | `0x529a750E02d8E2f15649c13D69a465286a780e24` |
| RoyaltyModule | `0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086` |
| DisputeModule | `0x9b7A9c70AFF961C799110954fc06F3093aeb94C5` |
| PILicenseTemplate | `0x2E896b0b2Fdb7457499B56AAaA4AE55BCB4Cd316` |
| WIP Token (mainnet) | `0x1514000000000000000000000000000000000000` |

## Appendix B: Default Revenue Split Parameters

| Parameter | Default | Configurable | Description |
|-----------|---------|-------------|-------------|
| `commercialRevShare` | 5% | 1–50% | Percent of derivative revenue flowing to parent CSD IP |
| Designer Royalty Tokens | 10 / 100 | Yes | Share of all revenue earned by CSD author |
| Operator Royalty Tokens | 70 / 100 | Yes | Share of revenue earned by executing operator |
| Verifier Royalty Tokens | 10 / 100 | Yes | Share earned by evidence verifier |
| Network Treasury Tokens | 10 / 100 | No | Protocol fee, non-transferable |

## Appendix C: Key Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `STORY_MOCK` | `true` | `false` for real Story Network transactions |
| `STORY_NETWORK` | `story-aeneid` | `story` for mainnet |
| `STORY_PRIVATE_KEY` | none | Private key for Story chain (separate from escrow key) |
| `EVIDENCE_STORAGE` | `helia` | `storacha` for Filecoin archival via Storacha w3up |
| `LIT_PROTOCOL_REAL` | unset | `true` for real Lit Network (datil-test) |
| `STARKNET_NETWORK` | `goerli` | `mainnet` for production ZK anchoring |
| `PCC_NETWORK` | `base-sepolia` | EVM chain for escrow settlement |

---

**Live Gateway**: [pcc-gateway-production.up.railway.app](https://pcc-gateway-production.up.railway.app)

**Repository**: [github.com/global-mysterysnailrevolution/physical-capability-cloud](https://github.com/global-mysterysnailrevolution/physical-capability-cloud)

**Hackathon**: PL Genesis Season 2 — Existing Code Track — Deadline April 1, 2026
