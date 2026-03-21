# Physical Capability Cloud: A Protocol for Direct Settlement of Physical Work

**Version 0.9 — March 2026**

---

## Abstract

Organizations exist because coordination is expensive. Finding a person who can do a job, verifying they can actually do it, agreeing on terms, monitoring the work, and enforcing payment — these transaction costs are so high that we build entire companies, platforms, and bureaucracies just to manage them. The worker who welds, machines, tests, delivers, or builds is the source of all value, but typically captures less than half of it. The rest goes to coordination overhead that exists solely because strangers cannot trust each other.

The Physical Capability Cloud (PCC) is an open protocol that reduces these transaction costs to near-zero. Any physical capability — a CNC mill, a welder's skill, a laboratory instrument, a delivery van — can be registered, discovered, contracted, verified, and paid for directly, with no intermediary organization required. AI agents handle discovery and negotiation. Cryptographic evidence proves work was done. Milestone escrow enforces payment. The protocol speaks A2A (agent-to-agent) and MCP (Model Context Protocol), making any capable AI agent a potential participant.

When transaction costs approach zero, two things happen. First, the organizational structures we built to manage them — companies, platforms, staffing agencies, supply chain intermediaries — become optional rather than necessary. Second, something new emerges: individual capability owners voluntarily cluster together, creating compound capabilities that are worth more than the sum of their parts. A machinist with a CNC mill can do milling. Five machinists with complementary equipment, sharing a facility, can do end-to-end precision manufacturing — and collectively capture the full project margin that a company would have absorbed.

This paper describes the protocol architecture, the economic model, the clustering dynamics, and the implications across industries from manufacturing to biotech to government services.

---

## 1. The Cost of Coordination

In 1937, Ronald Coase asked a question that economics had ignored: if markets are efficient, why do firms exist? [1] His answer was transaction costs. It is cheaper to organize workers and equipment inside a company than to negotiate every piece of work as an independent market transaction. Hiring an employee eliminates the recurring costs of search, bargaining, and contract enforcement that would attend each task if contracted on the open market.

Williamson [2, 3] formalized this. Transactions are costly when they involve asset specificity (specialized investments that lock parties together), uncertainty (incomplete information about quality or intent), and frequency (repeated interactions that compound per-transaction costs). When these factors are high, firms internalize activities. When they are low, markets suffice.

Grossman, Hart, and Moore [4, 5, 6] added a property rights lens: firms exist to allocate residual control rights over assets when contracts are inevitably incomplete. The owner of an asset has power over decisions not specified in the contract. Vertical integration — one entity owning complementary assets — arises because incomplete contracts create hold-up problems between independent owners.

These theories explain the organizational structures we observe. A manufacturing company owns machines and employs workers because the alternative — contracting each operation to an independent machinist — involves prohibitive search, verification, and enforcement costs. A construction general contractor exists because coordinating twenty independent trades on a single project, without a central authority, is too complex and risky. A staffing agency exists because employers cannot efficiently verify the skills and reliability of unknown workers.

The critical insight: **these organizations are not inherent to the work itself. They are artifacts of high transaction costs.** If you could reduce the cost of finding, verifying, contracting, monitoring, and paying for physical work to near-zero, the economic rationale for many organizational structures would weaken or disappear entirely.

---

## 2. The Current State: Intermediaries and Extraction

The transition to digital platforms has not solved the coordination problem. It has merely shifted who captures the coordination rent.

### 2.1 Platform Economics

Digital labor platforms promised to disintermediate legacy gatekeepers, but in practice they replaced one intermediary with another — one that is often more extractive because of information asymmetry and network effects.

The Economic Policy Institute found that Uber drivers earn the equivalent of $9.21 per hour in net wages after platform commissions and vehicle expenses — less than 90% of all other U.S. wage and salary earners [7]. The MIT Center for Energy and Environmental Policy Research found median pretax profit of $8.55–10.00 per hour for ride-hailing drivers after expenses [8]. TaskRabbit takes 15% of every job [9]. Fiverr takes 20% [10]. Amazon FBA takes 30-45% of third-party seller revenue. Handy, a home services platform, has been reported to retain 50-75% of the job price [11].

Bill Gurley of Benchmark Capital described this as "a rake too far" — platforms that extract more than 20-25% of transaction value are structurally vulnerable to disintermediation because the value they provide (matching, trust, payment processing) does not justify the extraction [12].

The JPMorgan Chase Institute, analyzing 2.3 million checking accounts, found that platform earnings dropped 47% between 2013 and 2017 in the transportation sector, even as participation grew [13]. The platform captured an increasing share of a growing pie.

### 2.2 Beyond Gig Platforms

The extraction problem is not limited to gig work. It permeates every industry where organizations exist primarily to coordinate physical work.

A general contractor takes 15-25% of a construction project's total cost for coordination and risk management. The trades — electricians, plumbers, framers, roofers — do all the physical work. A staffing agency takes 25-100% markup on the worker's hourly rate. A contract research organization (CRO) charges pharmaceutical companies $100-500 per assay hour; the technician running the instrument sees a fraction. A 3PL (third-party logistics) provider takes 20-40% for warehousing and fulfillment that is performed by individual workers operating standard equipment.

In each case, the intermediary's primary function is coordination and trust. They find the workers, verify their capabilities, manage the workflow, and guarantee the outcome. This is real and necessary work — but it is work that technology can now perform at near-zero marginal cost.

### 2.3 The Worker's Actual Take-Home

The UCLA Institute for Research on Labor and Employment found that employers save 29-39 cents per dollar of pay by classifying workers as independent contractors rather than employees [14]. The worker absorbs this gap directly: self-employment taxes (an additional 7.65% above employee rates [15]), health insurance ($6,000-8,400 per year without employer subsidy [16]), and administrative overhead (invoicing, accounting, marketing, collections).

For a physical worker doing $100 of work, the actual flow looks like this:

| Deduction | Amount |
|-----------|--------|
| Platform or intermediary fee | $15–32 |
| Self-employment tax premium | $7–8 |
| Vehicle, tools, equipment costs | $10–20 |
| Health insurance (annualized) | $3–7 |
| Unpaid admin and dead time | $5–10 |
| **Worker retains** | **$23–60** |

The McKinsey Global Institute estimated that 20-30% of the working-age population in the U.S. and Europe — 162 million people — engage in some form of independent work [17]. The U.S. freelance economy contributed $1.27 trillion in annual earnings in 2023 [18]. The Bureau of Labor Statistics reported that 7.4% of all U.S. workers are independent contractors on their primary job [19].

This is not a niche problem. It is the dominant economic arrangement for a large and growing share of the global workforce — and the structural extraction is baked in at every layer.

---

## 3. Protocol Design

PCC is an open protocol, not a platform. The distinction matters. A platform is a company that mediates transactions and captures a fee. A protocol is a set of rules that enables direct transactions between parties. HTTP is a protocol. Email is a protocol. Bitcoin is a protocol. No single entity operates them or captures rent from their use.

### 3.1 Core Primitives

**Capability.** The atomic unit. Not a machine and not a person — what a machine or person *can do*. A CNC mill's capability is "3-axis milling, aluminum, ±0.05mm tolerance, 500×400×300mm envelope." A welder's capability is "TIG welding, stainless steel, 6G position qualified." A laboratory instrument's capability is "HPLC analysis, C18 column, gradient elution, UV detection at 254nm." Capabilities have types, parameters, pricing models, and availability schedules.

The protocol defines 37 built-in capability types across manufacturing, logistics, and biotech domains, with an open extension mechanism for arbitrary capability types [20].

**Shop Kernel.** The software runtime that represents a physical site (workshop, lab, warehouse, vehicle). A kernel registers its capabilities, accepts jobs, drives equipment via device adapters (OctoPrint, Modbus, OPC-UA, SiLA), collects evidence, and reports results. The kernel is to a physical site what an operating system is to a computer: the interface between the protocol and the hardware.

**Evidence Bundle.** A cryptographically committed record of work performed. Evidence events span 57 types: G-code hashes, execution timestamps, power profiles, vibration signatures, camera snapshots, CV inspection results, temperature logs, custody chain events, TEE attestations [21]. Each event is individually hashed. The bundle hash is the SHA-256 of all event hashes, sorted canonically. This makes evidence tamper-evident without revealing event contents.

**Assurance Tier.** The SLA level, ranging from 0 (self-attested) to 3 (machine-verified with TEE attestation). Each tier defines minimum evidence requirements:

| Tier | Required Evidence | Minimum Events | Use Case |
|------|------------------|----------------|----------|
| 0 | File hash + completion timestamp | 2 | Low-stakes, trust-the-operator |
| 1 | Tier 0 + power consumption profile | 3 | Standard commercial |
| 2 | Tier 1 + visual inspection (photo or CV) | 4 | Quality-critical |
| 3 | Tier 2 + CV pass + TEE attestation | 5 | Regulated, aerospace, medical |

Higher tiers require larger operator bonds, have longer challenge windows, and support more rigorous dispute resolution [22].

**Capability Workflow Manifest (CWM).** A job specification: an ordered set of steps, each requiring a specific capability type, with parameters, dependencies, and settlement terms. The CWM is the "purchase order" of the protocol. A scheduler compiles a CWM into an execution plan by matching each step to a registered capability and resolving the dependency graph via topological sort [23].

**Milestone Escrow.** A smart contract deployed per workflow on Base (EVM, USDC settlement). The buyer funds the escrow. Each milestone locks funds, releases them when evidence meets the tier's requirements and the challenge window expires without dispute, or slashes the operator's bond if a dispute is sustained. The contract handles the full lifecycle: funding, evidence submission, attestation, challenge, dispute resolution, and release [24].

### 3.2 Agent Layer

Agents are the coordination layer. They replace the organizational functions — discovery, negotiation, contracting, monitoring, payment — that companies and platforms currently perform.

PCC defines seven agent roles: user, broker, kernel, verifier, courier, arbiter, and evaluator. Each role has a specific function in the protocol:

- **User Agent**: Holds the buyer's wallet, discovers capabilities, negotiates terms, submits workflows, monitors progress, claims deliverables.
- **Broker Agent**: Routes capability requests, compiles quotes from multiple kernels, selects optimal assignments, manages workflow-level coordination.
- **Kernel Agent**: Wraps a shop kernel, accepts jobs, drives execution, emits evidence, reports completion.
- **Verifier Agent**: Third-party evidence verification. Selected from a market based on stake and reputation, with quorum requirements that scale with assurance tier.
- **Evaluator Agent**: Independent quality assessment. Produces attestation credentials against defined requirements (dimensional, material, process, documentation, safety). Bridges between the PCC intent system and external evaluation protocols.
- **Courier Agent**: Manages physical logistics between capabilities — pickup, transit, delivery, with evidence at each custody handoff.
- **Arbiter Agent**: Dispute resolution. Reviews evidence from both parties, renders binding decisions.

Agents communicate via 34 typed intents organized by function: discovery, quoting, negotiation, job lifecycle, payment, logistics, verification, evaluation, and funding [25]. The protocol is transport-agnostic; the reference implementation uses an in-process message bus, but intents can flow over HTTP, WebSocket, or any A2A-compatible transport.

### 3.3 Interoperability

PCC is designed to be reachable by any AI agent, not just PCC-native agents.

**A2A (Agent-to-Agent Protocol)** [26]: Google's open standard for agent interoperability, launched April 2025 with 50+ enterprise partners. PCC agents publish Agent Cards — JSON capability advertisements — that any A2A-speaking agent can discover and interact with.

**MCP (Model Context Protocol)** [27]: Anthropic's open standard for agent-to-tool communication. PCC exposes 29 MCP tools that allow any MCP-compatible agent (Claude, Cursor, VS Code Copilot, custom agents) to interact with PCC services: discover capabilities, submit workflows, check job status, manage escrow.

**x402** [28]: Coinbase's internet-native payment protocol. PCC uses x402 for agent-to-agent digital service payments — the agent equivalent of swiping a credit card. Over 15 million transactions processed by the launch cohort.

This means a user doesn't need a "PCC app." They need an AI agent — any AI agent — that can speak these open protocols. Claude Code, Cursor, OpenClaw, a custom enterprise agent: if it can send an intent and sign a transaction, it can participate in the physical capability economy.

### 3.4 Identity and Trust

Trust in PCC is not reputation-by-review (star ratings from strangers). It is trust-by-evidence.

**Decentralized Identifiers (DIDs)** [29]: Every kernel, device, operator, and agent has a W3C DID. Two methods are supported: `did:key` (Ed25519 keys, portable) and `did:pcc` (PCC-namespaced, typed by role).

**Verifiable Credentials (VCs)** [30]: Capabilities are attested via W3C Verifiable Credentials. A capability credential certifies that a specific device has a specific capability at a specific assurance tier, with calibration proof and tolerance specifications. Credentials are cryptographically signed and independently verifiable.

**Soulbound Capability Certificates**: On-chain NFTs (Solana, via Metaplex Core) that are permanently non-transferable. A `PermanentFreezeDelegate` plugin enforces this at the protocol level. You cannot buy someone else's reputation. The `transferCertificate()` function always returns `{ transferred: false }` — enforced in both application code and on-chain [31].

**ERC-8004 Registries** [32]: On-chain identity, reputation, and validation registries. Reputation scores (0-1000, initialized at 500) are updated mechanistically: +10 to +50 for job completion, +20 for winning a dispute, -50 for losing one, up to -500 for slashing events. Only authorized attesters (verifiers, escrow contracts) can write scores. This is not subjective rating — it is a deterministic function of on-chain events.

### 3.5 Evidence Integrity

The evidence pipeline is the core of PCC's trust model. It replaces brand reputation, platform ratings, and organizational oversight with cryptographic proof.

**Merkle Commitments** [33]: Evidence events are committed via Merkle trees. The root commits to all events; individual events can be verified with O(log n) hashes without revealing other events. This enables selective disclosure — a buyer can verify that CV inspection passed without seeing the raw sensor data, which may be proprietary.

**Zero-Knowledge Proofs**: PCC supports ZK proof generation and Starknet anchoring for evidence that requires privacy-preserving verification [34]. A verifier can confirm that machining tolerances were met without learning the actual toolpath — which is the manufacturer's intellectual property.

**Decentralized Storage**: Evidence bundles are stored on IPFS (via Helia) or Storacha (w3up), content-addressed and immutable. On-chain state stores only hashes, never raw data [35].

**Lit Protocol Encryption**: Evidence can be access-controlled via Lit Protocol, allowing the evidence creator to specify who can decrypt and under what conditions [36].

---

## 4. The Clustering Thesis

The first-order effect of PCC is disintermediation: individual capability owners deal directly with buyers, keeping a larger share of the value they create. This is important but incomplete.

The second-order effect is more significant: **PCC creates economic incentive for capability owners to voluntarily co-locate, forming clusters that can serve end-to-end workflows no individual capability could serve alone.**

### 4.1 Why Proximity Creates Compound Value

Digital services compose over networks. Physical capabilities do not. The output of a CNC milling operation cannot be piped over the internet to a surface grinder. The workpiece must physically move. Every inter-facility handoff adds cost (shipping), time (days instead of minutes), risk (damage, loss), and quality gaps (the downstream operator cannot observe the upstream operation in real time).

When complementary capabilities are co-located — sharing a facility or occupying adjacent spaces — handoffs become minutes instead of days. Feedback loops tighten. Quality improves because operators can observe and respond to each other's work. Logistics cost drops to near-zero for inter-step transfers.

This is why factories exist. But factories bundle the proximity advantage with ownership hierarchy, employment relationships, and organizational overhead. A factory owner decides what machines to buy, hires workers, manages production schedules, and captures the margin between input costs and sale price.

PCC unbundles proximity from ownership. Capability owners can co-locate and compose their capabilities into compound workflows without any of them being the "boss," forming a company, or negotiating profit-sharing. Each step in the workflow has its own market price. When a cluster serves a multi-step job, payment distributes automatically via milestone escrow — each capability earns what the market says that step is worth.

### 4.2 Cluster Formation Dynamics

Clusters form because agents surface market signals that individual operators cannot see.

A machinist with a CNC mill receives jobs for milling operations. Their agent also sees the jobs that *don't* come — multi-step workflows that require milling AND turning AND surface finishing, which bypass this machinist because they can only serve one step. The agent quantifies the gap: "47 unfilled workflows per month in your area require turning capability within 10 miles of a CNC mill. Adding a CNC lathe to your facility — or co-locating with a lathe operator — would increase addressable market by 340% and projected revenue by $X/month."

This is transparent demand signaling. The agent is not guessing. It is aggregating real intent data — actual workflows submitted by buyers — and identifying capability gaps. Equipment purchase and co-location decisions become evidence-based rather than speculative.

### 4.3 How Clusters Differ from Companies

| Dimension | Company | PCC Cluster |
|-----------|---------|-------------|
| **Ownership** | Company owns the equipment | Each operator owns their own equipment |
| **Employment** | Workers are employees | Everyone is independent |
| **Revenue split** | Company decides | Market prices each step; escrow distributes automatically |
| **Decision-making** | Management hierarchy | Each operator makes their own decisions |
| **Reconfiguration** | Retooling is a major capital decision | Operators join/leave; agents find replacements |
| **Liability** | Company carries umbrella policy | Per-capability insurance, priced by evidence history |
| **Reputation** | Brand reputation (opaque) | Per-capability evidence history (transparent, compositional) |
| **Failure mode** | Company goes bankrupt; workers lose jobs | One operator leaves; cluster adapts |

The fundamental difference: a company is a centralized decision-making structure that bundles coordination, ownership, and employment under one legal entity. A cluster is a set of independently-owned capabilities that compose into compound workflows via protocol. The cluster has the productive advantages of co-location without the organizational overhead of the firm.

### 4.4 Revenue Distribution Without Conflict

The most common failure mode for cooperatives and partnerships is disagreement over revenue distribution [37, 38]. When multiple parties contribute to a joint outcome, the question "who deserves how much?" becomes contentious.

PCC eliminates this question. Each capability in a workflow has an independently market-priced rate. When a cluster serves a multi-step workflow, the buyer's CWM specifies each step; the scheduler assigns each step to a capability; the escrow funds each milestone independently; evidence triggers release per-step. There is no shared revenue pool to divide. There is no profit-sharing negotiation. Each operator earns what the market says their step is worth, proven by evidence, enforced by escrow.

This removes the single largest source of friction in collective physical work arrangements.

### 4.5 Dynamic Reconfiguration

A company that owns a factory is committed to its equipment mix. Retooling is a multi-million dollar decision involving capital expenditure approval, procurement, installation, training, and downtime.

A PCC cluster reconfigures organically. If demand for 3-axis milling drops and demand for metal additive manufacturing rises, one operator can sell their mill and acquire a metal 3D printer. The cluster's capability mix updates instantly — no board meeting, no committee, no approval chain. The operator made a market-informed decision based on demand signals from their agent, and the cluster adapted as a side effect.

If an operator leaves the cluster, it doesn't collapse. The remaining operators' agents signal the capability gap, and the protocol's discovery mechanism finds replacement capability owners. If an operator upgrades their equipment (better tolerances, larger work envelope, higher throughput), the cluster's maximum capability improves immediately.

The cluster is anti-fragile in a way that companies are not. It improves under stress because its individual components make independent, market-driven decisions.

### 4.6 Space as Infrastructure

If proximity creates compound value, then shared industrial space becomes critical infrastructure for the PCC economy. The protocol includes a Space Finder that matches capability owners with available facilities based on complementarity — not just square footage and price, but which *other capabilities are already present* in the space.

This creates a new real estate model. A property owner with a 20,000 sq ft industrial building is incentivized to curate their tenant mix for capability complementarity. Their agent might recommend: "Offer below-market rent to an electroplating operator. Adding electroplating to this building's cluster would enable end-to-end metal finishing workflows, increasing total throughput by 30% and allowing you to charge utilization premiums." The landlord's revenue becomes a function of the cluster's workflow coverage, not just rent per square foot.

---

## 5. Industry Analysis

### 5.1 Manufacturing

**Individual capability**: A machinist owns a 3-axis CNC mill. Addressable market: milling jobs only.

**Cluster**: CNC mill + CNC lathe + surface grinder + wire EDM + CMM (coordinate measuring machine) + heat treatment oven + anodizing line. Addressable market: complete precision parts from raw stock to certified, finished component.

**What the cluster replaces**: The job shop. The U.S. precision machining industry exceeds $80 billion in annual revenue. A job shop is a company that owns machines, employs machinists, bids on work, and manages quality. The machines and machinists are the value producers. The company is the coordination and trust wrapper.

**What changes**: Five machinists sharing a 5,000 sq ft industrial space, each owning their machines, collectively capture the full project margin. Their agents decompose incoming CWMs: mill does rough cutting → lathe bores the hole → grinder finishes the surface → CMM inspects → coating line anodizes. Each step settles independently. No general manager. No sales team. No accounting department. The agents handle discovery, the evidence handles quality, the escrow handles payment.

**Capital deployment signal**: The agents see unfilled demand in real time. "This region has 200 unfilled workflows per month requiring 5-axis machining. No 5-axis capability exists within 150 miles. Projected utilization for a new 5-axis mill: 65%. ROI at current pricing: 14 months." This transforms equipment financing from speculative to evidence-based. A lender can underwrite a machine purchase based on actual demand data, not a business plan.

### 5.2 Life Sciences and Biotech

**Individual capability**: A researcher owns a PCR machine. Addressable market: PCR assay services.

**Cluster**: PCR + next-gen sequencer + mass spectrometer + cell culture hood + -80°C freezer + plate reader + biosafety cabinet + fume hood + NMR spectrometer. Addressable market: complete contract research — drug screening, genomics pipelines, proteomics, toxicology panels, ADME studies.

**What the cluster replaces**: Contract research organizations (CROs). Charles River Laboratories ($4B revenue), Eurofins ($7B), LabCorp Drug Development ($6B). The global CRO market exceeds $80 billion. These companies aggregate instruments and technicians under one roof and sell access to end-to-end analytical workflows.

**What changes**: A postdoc with an idle NMR, a graduate student with a flow cytometer, a retired scientist with a BSL-2 garage lab, and a university core facility with a sequencer form a cluster. Their combined capability set can serve assay work that currently goes to CROs — particularly the long tail: small studies, academic collaborations, and startup biotech work that cannot afford CRO minimums.

Evidence for biotech is especially rich: chromatograms, sequencing QC metrics, mass spectra, microscopy images, chain-of-custody timestamps, temperature logs for cold-chain compliance. The assurance tier system maps directly to regulatory requirements: Tier 2 for standard analytical work, Tier 3 for GLP/GMP-regulated studies requiring full audit trails.

This connects directly to the OpenClaw ecosystem and laboratory automation frameworks (pylabrobot, Opentrons): physical instruments wrapped as PCC capabilities, actuated programmatically, with evidence captured automatically by the kernel.

### 5.3 Construction

**Individual capabilities**: An electrician, a plumber, a framer, a roofer, a concrete specialist, an HVAC technician.

**Cluster**: All six, plus a project coordinator (someone whose skill is reading plans and sequencing work phases).

**What the cluster replaces**: General contractors (GCs). A GC wins the bid, hires subcontractors, manages the schedule, handles inspections, and carries the liability umbrella. For this coordination work, they take 15-25% of the total project cost. The trades do all the physical work.

**What changes**: The protocol enforces sequencing via step dependencies in the CWM: foundation must complete before framing can start; rough-in must complete before insulation; etc. Each trade's work is verified by evidence: photos with GPS coordinates, inspection reports, permit scans, sensor data (concrete moisture readings, electrical test results). The homeowner or developer's agent contracts directly with the cluster.

Project coordination doesn't disappear — it becomes a priced capability like any other. The coordinator registers on PCC, and the market prices their contribution at what coordination is actually worth, not at 20% of total project cost.

Liability deserves specific attention: the GC model bundles liability into a single entity. In a cluster, liability can be structured per-capability (each trade carries their own insurance, priced by their evidence history) plus a workflow-level bond held in escrow that covers defects discovered post-completion. The assurance tier system already supports graduated bond requirements and challenge windows of up to 72 hours for Tier 3 work.

### 5.4 Logistics and Fulfillment

**Individual capabilities**: A warehouse owner with 10,000 sq ft. A delivery driver with a van. A worker with a forklift license.

**Cluster**: Warehouse + pick/pack labor + local delivery fleet + freight connection + returns processing.

**What the cluster replaces**: Third-party logistics (3PL) providers and Amazon FBA. Amazon takes 30-45% of third-party seller revenue for FBA. A cluster of warehouse owners, drivers, and sorters can provide the same service at a fraction of the cost because there is no Amazon in the middle.

**Dynamic scaling**: Individual capability owners join and leave clusters based on seasonal demand. The agent network handles coordination: Black Friday surge triggers additional pick/pack workers and drivers to join the cluster. January slowdown releases them to serve other workflows. No employment contracts, no hiring/firing, no staffing agency — just real-time market-driven resource allocation.

### 5.5 Agriculture

**Individual capabilities**: A farmer with a combine harvester. A drone operator with crop monitoring equipment. A soil testing laboratory.

**Cluster**: Tractor + planter + harvester + crop monitoring drones + soil lab + grain storage + trucking.

**What the cluster replaces**: Farm management companies and the organizational overhead of traditional agricultural cooperatives.

**What changes**: A landowner posts their land as a capability need ("2,000 acres of corn ground, full-season management"). The agents compose a complete farming operation from individual equipment owners and operators: soil preparation → planting → monitoring → spraying → harvesting → hauling → storage. Each step has rich evidence: GPS tracks from equipment, yield monitor data, soil test results, moisture readings, satellite imagery from drones. The landowner pays per-step, sees proof at every stage.

Agricultural equipment sharing already exists in practice (custom harvesting operations travel the Great Plains following the harvest northward each season). PCC formalizes this pattern and extends it to the full crop cycle.

### 5.6 Healthcare (Physical Services)

**Individual capabilities**: A phlebotomist. A mobile X-ray technician. A medical courier. A pathology laboratory.

**Cluster**: Blood draw + mobile imaging + mobile ultrasound + courier + lab analysis + report delivery.

**What the cluster replaces**: LabCorp and Quest Diagnostics (combined ~$15B revenue). These companies are logistics and trust wrappers around individual capabilities.

PCC's evidence pipeline (encrypted storage, access-controlled via Lit Protocol, auditable chain of custody) supports HIPAA and CLIA compliance requirements. Evidence bundles for healthcare work are encrypted at rest, with access policies defined by the evidence creator.

### 5.7 Energy and Distributed Infrastructure

**Individual capabilities**: A solar panel installer. An electrician. A battery storage owner. A grid interconnection specialist.

**Cluster**: Design + installation + electrical + battery + interconnection + monitoring + maintenance.

**What the cluster replaces**: Solar installation companies (SunRun: $2B revenue) and battery aggregation platforms.

The DePIN angle: PCC's reward engine supports ongoing capability participation. A battery storage owner registers their battery as a capability. When grid load balancing is needed, the battery discharges. Evidence: power meter readings. Settlement: per-kWh via escrow. This is distributed energy storage without a utility company managing it — a true DePIN application that goes beyond the connectivity (Helium) and storage (Filecoin) use cases that dominate the current DePIN landscape.

### 5.8 Film and Media Production

**Individual capabilities**: A camera operator with a RED camera. A sound technician. A gaffer with a lighting kit. A grip with a truck.

**Cluster**: Camera + sound + lighting + grip + colorist + editor.

**What the cluster replaces**: Production companies, which take 30-50% for coordination and brand. The actual creative work is done by freelancers and owner-operators.

### 5.9 Waste Management

**Individual capabilities**: A truck owner. A sorting facility. A composting operation. A recycling processor.

**Cluster**: Collection + sorting + recycling + composting + disposal.

**What the cluster replaces**: Waste Management, Inc. ($20B revenue), Republic Services ($14B). These companies win exclusive municipal contracts and operate as regulated monopolies. A cluster of individual operators, with transparent evidence (GPS route tracking, weight tickets, recycling yield data, environmental monitoring), could bid on the same contracts — offering the municipality per-unit pricing with verified outcomes instead of opaque bulk contracts.

### 5.10 Government Services

Government is simultaneously a buyer and a provider of physical capabilities.

**As buyer**: A city needs 50,000 potholes assessed and 12,000 repaired. Instead of a $30M contract with one road maintenance company, capabilities are posted. Individual operators bid per-pothole. Evidence: before/after photos with GPS, material receipts, compaction sensor data. Settlement: per-repair. The city pays for verified outcomes, not organizational overhead.

**As provider**: A city water testing laboratory runs at 40% capacity. Register the idle capacity on PCC. Private companies that need water testing (breweries, manufacturers, real estate developers) book it through agents. The city generates revenue from underutilized public infrastructure.

**Structural implication**: Government departments are capability clusters. Each department aggregates capabilities (inspection, maintenance, testing, processing, response) under a bureaucratic hierarchy. If these capabilities are individually addressable and their performance is verified by evidence, the hierarchy becomes optional. Citizens and businesses interact with capabilities, not departments. "I need a building permit" becomes a workflow: plan review capability → zoning compliance capability → inspection scheduling capability. The agents route it. Evidence proves each step completed.

---

## 6. Economic Model

### 6.1 Pricing

Capability pricing is market-driven. Each capability defines a pricing model: base cost, per-minute rate, per-gram rate, per-cubic-centimeter rate, and minimum. These are *maximum* prices — the upper bound of what the operator will accept. The capability router applies bid discounts based on queue depth (up to 15% for idle capacity) and reputation bonus (up to 5% for highly rated operators) [39].

Auction-mode pricing allows the market to set rates dynamically. Fixed-mode pricing is available for operators who prefer predictable rates.

### 6.2 Settlement

All settlement occurs via milestone escrow on Base (EVM, USDC). The flow:

1. Buyer funds escrow with total workflow budget
2. Operator deposits bond (scaled by assurance tier: 0-25% of milestone value)
3. Operator submits evidence bundle hash on-chain
4. Verifier submits attestation hash on-chain
5. Challenge window opens (1-72 hours by tier)
6. If unchallenged: funds release to operator
7. If challenged: arbiter reviews evidence, renders decision; losing party's bond is slashed

Gas costs on Base L2 are sub-dollar. Settlement is seconds, not Net-30.

### 6.3 DePIN Rewards

The reward engine incentivizes capability deployment and quality through epoch-based scoring [40]:

```
score = jobs(0.40) + quality(0.25) + uptime(0.15) + diversity(0.10) + scarcity(0.10)
```

Each dimension is normalized relative to the best performer in the epoch. Rewards are distributed proportionally: `reward = (score / totalScores) × epochPool`.

The scarcity bonus (0.10 weight) directly incentivizes operators to deploy capabilities in under-served areas or capability types. If a region has strong demand for electroplating but no electroplating capability, an operator who adds one receives elevated rewards — a market-driven subsidy for filling capability gaps.

### 6.4 Spending Policies

Agent spending is policy-gated with rolling windows [41]:

| Agent Type | Max Per Transaction | Max Per Window | Human Approval Threshold |
|------------|-------------------|----------------|--------------------------|
| User agent | $50 | $200/hour | > $10 |
| Broker agent | $500 | $5,000/hour | > $500 |
| Kernel agent | $10 | $50/hour | > $10 |

This prevents runaway spending while enabling autonomous operation within defined bounds.

---

## 7. Verification and Dispute Resolution

### 7.1 Evidence Verification

The verifier market operates as a stake-weighted random selection with quorum requirements that scale by tier [42]:

| Tier | Min Verifier Reputation | Min Stake | Quorum | Guild Required |
|------|------------------------|-----------|--------|----------------|
| 0 | 0 | 0 | 1 | No |
| 1 | 200 | 100 | 1 | No |
| 2 | 500 | 500 | 2 | No |
| 3 | 800 | 1000 | 3 | Yes |

Verification is a 5-pass protocol: bundle hash integrity → per-event hash integrity → tier requirements → execution duration validity → power/duration consistency. Confidence scoring produces a quantitative assessment: 90-100 on clean pass, degrading by 15 points per critical failure [43].

### 7.2 Bittensor Subnet Integration

For high-assurance verification (Tier 2-3), PCC integrates with Bittensor subnet 42. Evidence bundles are dispatched as synapses to a pool of miners. Each miner independently verifies the evidence and returns a score. Yuma Consensus is applied across miner responses. The consensus score must exceed 0.6 for the verification to pass. This creates a decentralized, incentive-aligned verification market where miners compete on accuracy [44].

### 7.3 Dispute Resolution

Disputes are filed during the challenge window by depositing a challenger bond. The arbiter reviews evidence from both parties and renders a binding decision: challenger wins (operator bond slashed, milestone refunded), operator wins (challenger bond slashed, operator paid in full), or split. All evidence is on-chain or content-addressed off-chain, making disputes verifiable rather than he-said-she-said [45].

---

## 8. Related Work

### 8.1 DePIN (Decentralized Physical Infrastructure Networks)

DePIN reached a $50B market cap across 350 tokens in 2024 with 13 million devices contributing daily [46]. The category is predominantly focused on connectivity (Helium: 350,000+ hotspots, 80 countries [47]), storage (Filecoin), and compute (Render, Akash).

PCC differs from existing DePIN in three ways:

1. **Capability, not infrastructure**: DePIN projects typically deploy homogeneous infrastructure (all hotspots, all storage nodes). PCC supports heterogeneous capabilities that compose into workflows. A CNC mill is not interchangeable with a lathe the way one Helium hotspot is interchangeable with another.

2. **Workflow composition**: DePIN projects serve single-step requests (store this file, route this data). PCC serves multi-step workflows with dependencies, handoffs, and compound evidence chains.

3. **Evidence-based settlement**: DePIN projects typically use proof-of-coverage or proof-of-storage — binary pass/fail. PCC's assurance tiers enable graduated evidence requirements, from self-attested to machine-verified with TEE attestation.

Grayscale Research noted that manufacturing and industrial capability is an underserved vertical in the DePIN landscape [48]. PCC occupies this gap.

### 8.2 Platform Cooperatives

Platform cooperativism [49, 50] proposes that gig platforms should be owned and governed by their workers. This addresses the extraction problem but introduces governance overhead that conventional platforms avoid.

Worker cooperatives survive at rates comparable to conventional firms when adequately capitalized [51]. The Mondragon Corporation (80,000+ employees) demonstrates that the cooperative model can scale. But the dominant failure mode is governance complexity and revenue-sharing disputes [52], and platform cooperatives specifically face a structural funding disadvantage: they cannot raise equity capital without diluting worker control [53].

PCC sidesteps the cooperative governance problem entirely. There is no organization to govern. There is no shared revenue pool to distribute. Each capability owner operates independently; the protocol handles coordination; the market prices each contribution; escrow distributes payment. The cooperative's goal — worker ownership and fair compensation — is achieved without the cooperative's overhead.

### 8.3 Supply Chain Blockchain

Blockchain-based supply chain projects have produced notable proofs of concept. Walmart's Hyperledger Fabric implementation reduced food traceability from 6+ days to 2.2 seconds [54]. But most enterprise supply chain blockchain projects have failed to scale beyond pilots [55]. The primary barrier is multi-party adoption friction: every participant in the supply chain must agree to use the same system.

PCC addresses this through open protocol standards rather than proprietary networks. Capabilities don't need to "join" a platform — they register with an agent, which advertises them via standard A2A and MCP protocols. The adoption unit is the individual capability, not the supply chain.

---

## 9. Limitations and Open Questions

### 9.1 Capital-Intensive Capabilities

Some capabilities require capital investment that exceeds individual ownership: semiconductor fabrication ($20B per fab), nuclear power, large-scale chemical processing. These capabilities will likely remain centrally owned. PCC can still improve how they transact with customers, but it will not decentralize their ownership structure.

### 9.2 Regulatory Resistance

Existing organizations will resist disintermediation. Trade licensing requirements, while partly about quality and safety, also serve as barriers to entry that protect incumbents. Construction trades, medical laboratories, and financial services all have regulatory frameworks that assume organizational intermediaries. PCC compliance must work within these frameworks, not around them.

### 9.3 Pricing Pressure

Global discoverability and price transparency may drive commodity capability prices below sustainable levels. The protocol's mitigation is the assurance tier system: higher-quality evidence, better track records, and more rigorous verification command premium pricing. But for truly undifferentiated work, downward pricing pressure is real.

### 9.4 Coordination Complexity Ceiling

Some projects are so complex that coordination requires deep domain expertise and judgment that cannot be reduced to workflow sequencing and evidence verification. Building a skyscraper, manufacturing an aircraft, conducting a clinical trial — these may still require organizational structures for high-level architectural decisions. PCC can handle the sub-workflows, but a human coordinator (registered as a capability) may be needed for the overall orchestration.

### 9.5 Cold Start

Clusters require geographic density of complementary capabilities. In regions with few registered capabilities, the cluster advantage does not materialize. Bootstrapping requires concentrated onboarding effort in specific geographies and capability domains.

### 9.6 Safety and Liability

Complex physical work has real safety implications. The current model — companies carry insurance and are liable for outcomes — has known properties. A protocol-based model needs clear liability allocation: per-capability insurance (priced by evidence history), workflow-level bonds, and regulatory clarity on who is accountable when things go wrong. This is solvable but not yet fully defined.

---

## 10. Conclusion

Ronald Coase predicted in 1937 that if transaction costs could be eliminated, the firm would have no reason to exist. We cannot eliminate them entirely. But we can reduce them by orders of magnitude.

AI agents reduce search and negotiation costs to near-zero. Cryptographic evidence reduces verification costs to near-zero. Milestone escrow reduces enforcement costs to near-zero. Open protocols (A2A, MCP, x402) reduce interoperability costs to near-zero.

What remains is the work itself — and the people and machines that do it.

PCC is not a platform. It does not sit between the worker and the buyer. It is a protocol that enables them to deal directly. The worker keeps the money. The evidence keeps the trust. The escrow keeps the peace.

And when workers bring their capabilities together — voluntarily, without hierarchy, without negotiating profit shares — they form clusters that can serve markets no individual could reach alone. Not because anyone told them to. Because the economics demand it.

The physical cloud is not a company. It is not a marketplace. It is the infrastructure that makes companies and marketplaces unnecessary for coordinating physical work.

Open source. Open protocol. Open economy.

---

## References

[1] Coase, R.H. (1937). "The Nature of the Firm." *Economica*, 4(16), 386–405.

[2] Williamson, O.E. (1975). *Markets and Hierarchies: Analysis and Antitrust Implications*. New York: Free Press.

[3] Williamson, O.E. (1979). "Transaction-Cost Economics: The Governance of Contractual Relations." *Journal of Law and Economics*, 22(2), 233–261.

[4] Grossman, S. and Hart, O. (1986). "The Costs and Benefits of Ownership: A Theory of Vertical and Lateral Integration." *Journal of Political Economy*, 94(4), 691–719.

[5] Hart, O. and Moore, J. (1990). "Property Rights and the Nature of the Firm." *Journal of Political Economy*, 98(6), 1119–1158.

[6] Hart, O. (2017). "Incomplete Contracts and Control." Nobel Prize Lecture. Stockholm: Nobel Prize Committee.

[7] Mishel, L. (2018). "Uber and the Labor Market." Economic Policy Institute.

[8] Zoepf, S., Chen, S., Adu, P., and Pozo, G. (2018). "The Economics of Ride-Hailing." MIT CEEPR Working Paper 2018-005.

[9] TaskRabbit. "What's the TaskRabbit Service Fee?" TaskRabbit Support Center.

[10] Fiverr. "Fiverr Fee Structure." Fiverr Help Center.

[11] SideHusl. "Handy Review." sidehusl.com.

[12] Gurley, B. (2013). "A Rake Too Far: Optimal Platform Pricing Strategy." *Above the Crowd* (Benchmark Capital).

[13] Farrell, D., Greig, F., and Hamoudi, A. (2018). "The Online Platform Economy in 2018." JPMorgan Chase Institute.

[14] UCLA Institute for Research on Labor and Employment. (2015). "Exploring the Costs of Classifying Workers as Independent Contractors."

[15] U.S. Internal Revenue Service. "Self-Employment Tax." IRS Topic 554.

[16] eHealth Insurance. "Self-Employed Health Insurance Costs."

[17] Manyika, J. et al. (2016). "Independent Work: Choice, Necessity, and the Gig Economy." McKinsey Global Institute.

[18] Upwork / Freelancers Union. (2023). "Freelance Forward 2023."

[19] Bureau of Labor Statistics. (2023). "Contingent and Alternative Employment Arrangements Summary." Current Population Survey, July 2023.

[20] PCC Specification: `packages/spec/src/types/capability.ts`. 37 built-in capability types.

[21] PCC Specification: `packages/spec/src/types/evidence.ts`. 57 evidence event types.

[22] PCC Specification: `packages/spec/src/types/evidence.ts`. `DEFAULT_TIER_REQUIREMENTS`.

[23] PCC Scheduler: `packages/scheduler/src/compiler.ts`. Topological sort with cycle detection.

[24] PCC Contracts: `packages/contracts/src/MilestoneEscrow.sol`. 9-state milestone lifecycle.

[25] PCC A2A: `packages/a2a/src/`. 34 typed intents across 10 categories.

[26] Google. (2025). "Announcing the Agent2Agent Protocol (A2A)." Google Developers Blog.

[27] Anthropic. (2024). "Model Context Protocol (MCP)." Anthropic Developer Documentation.

[28] Coinbase Developer Platform. (2025). "x402: An Internet-Native Payment Protocol."

[29] W3C. (2022). "Decentralized Identifiers (DIDs) v1.0." W3C Recommendation.

[30] W3C. (2025). "Verifiable Credentials Data Model v2.0." W3C Recommendation.

[31] PCC Contracts: `packages/contracts/ts/capability-certificates.ts`. Soulbound enforcement via PermanentFreezeDelegate.

[32] PCC Contracts: `packages/contracts/src/IdentityRegistry.sol`, `ReputationRegistry.sol`. ERC-8004.

[33] Merkle, R.C. (1987). "A Digital Signature Based on a Conventional Encryption Function." *CRYPTO 1987*, LNCS 293.

[34] PCC Verifier: `packages/verifier/src/zk/`. ZKProofService + StarknetProofAnchoringService.

[35] PCC Kernel: `packages/kernel/src/evidence-storage.ts`. IPFS via Helia; Storacha via w3up.

[36] PCC Kernel: `packages/kernel/src/lit-encryption-service.ts`. Lit Protocol access control.

[37] Basterretxea, I. et al. (2022). "Corporate Governance as a Key Aspect in the Failure of Worker Cooperatives." *Economic and Industrial Democracy*, 43(1), 362–387.

[38] Pérotin, V. (2015). "What Do We Really Know About Workers' Cooperatives?" Co-operatives UK.

[39] PCC Scheduler: `packages/scheduler/src/router.ts`. Multi-factor scoring with bid discounts.

[40] PCC Contracts: `packages/contracts/ts/reward-engine.ts`. 5-dimension epoch scoring.

[41] PCC Agent Runtime: `packages/agent-runtime/src/spending-policy.ts`. Rolling window enforcement.

[42] PCC Verifier: `packages/verifier/src/market.ts`. Stake-weighted random selection.

[43] PCC Verifier: `packages/verifier/src/evidence-verifier.ts`. 5-pass verification protocol.

[44] PCC Verifier: `packages/verifier/src/bittensor/`. Subnet 42, Yuma Consensus.

[45] PCC Contracts: `packages/contracts/src/MilestoneEscrow.sol`. Dispute resolution flow.

[46] Messari Research. (2024). "State of DePIN 2024."

[47] Messari Research. (2025). "State of Helium Q4 2024."

[48] Grayscale Research. (2024). "The Real World: How DePIN Bridges Crypto Back to Physical Systems."

[49] Scholz, T. (2016). *Platform Cooperativism*. Rosa Luxemburg Foundation.

[50] Scholz, T. and Schneider, N. (eds.) (2016). *Ours to Hack and to Own*. OR Books.

[51] Pérotin, V. (2015). "What Do We Really Know About Workers' Cooperatives?" Co-operatives UK.

[52] Basterretxea, I. et al. (2022). "Corporate Governance and Worker Cooperative Failure." *Economic and Industrial Democracy*.

[53] Christiaens, T. (2025). "Platform Cooperativism and Freedom as Non-Domination." *Work, Employment and Society*, 39(1).

[54] Walmart / Linux Foundation Decentralized Trust. (2022). "Walmart Food Supply Chain Case Study."

[55] Saberi, S. et al. (2019). "Blockchain Technology and Sustainable Supply Chain Management." *International Journal of Production Research*, 57(7), 2117–2135.
