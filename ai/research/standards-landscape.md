# Standards Landscape for Distributed Physical Capability Marketplace

**Generated**: 2026-04-02
**Purpose**: Comprehensive standards survey for PCC — a marketplace where AI agents orchestrate physical work on hardware
**Status**: Complete

---

## Table of Contents

1. [Agent-to-Agent Communication Standards](#1-agent-to-agent-communication-standards)
2. [Industrial Equipment Interop](#2-industrial-equipment-interop)
3. [DePIN / Physical Infrastructure Networks](#3-depin--physical-infrastructure-networks)
4. [Supply Chain & Logistics Standards](#4-supply-chain--logistics-standards)
5. [Quality & Compliance](#5-quality--compliance)
6. [Agent Harness / Guardrails](#6-agent-harness--guardrails)
7. [Marketplace Protocol Design](#7-marketplace-protocol-design)
8. [Decentralized Identity & Trust](#8-decentralized-identity--trust)
9. [Evidence & Attestation](#9-evidence--attestation)
10. [Workflow Orchestration](#10-workflow-orchestration)
11. [PCC Alignment Matrix](#11-pcc-alignment-matrix)

---

## 1. Agent-to-Agent Communication Standards

### 1.1 Google Agent2Agent Protocol (A2A)

| Field | Detail |
|-------|--------|
| **Standard Name** | Agent2Agent Protocol (A2A) |
| **Governing Body** | Linux Foundation (donated by Google, Dec 2025) |
| **Current Version** | v0.3 (2026) |
| **Spec URL** | https://a2a-protocol.org/latest/specification/ |
| **GitHub** | https://github.com/a2aproject/A2A |
| **License** | Apache 2.0 |

**Key Features**:
- Built on HTTP, SSE, JSON-RPC — enterprise stack-friendly
- **AgentCard**: JSON at `/.well-known/agent-card.json` (RFC 8615) describing agent capabilities, skills, auth methods, input/output modes
- **Task lifecycle**: defined states (submitted, working, input-needed, completed, failed, canceled) with streaming updates via SSE
- **Capability discovery**: AgentSkill objects with id, name, description, inputModes, outputModes, examples
- **v0.3 additions**: gRPC support, signed security cards, extended Python SDK
- **50+ partners**: Atlassian, Salesforce, SAP, ServiceNow, PayPal, LangChain, MongoDB

**Adoption Level**: HIGH and growing rapidly. De facto standard for cross-vendor agent interop. Enterprise-focused.

**PCC Mapping**: PCC already implements 34 A2A intents across 5 agent types. The AgentCard spec maps directly to PCC's `/.well-known/agent-registration.json` (ERC-8004). PCC should adopt the `.well-known/agent-card.json` path as a secondary discovery endpoint to gain compatibility with the A2A ecosystem. The task lifecycle model maps to PCC's job states. SSE streaming aligns with PCC's existing 6 SSE streams.

---

### 1.2 FIPA ACL (Agent Communication Language)

| Field | Detail |
|-------|--------|
| **Standard Name** | FIPA Agent Communication Language |
| **Governing Body** | IEEE Computer Society (FIPA accepted 2005) |
| **Current Version** | FIPA-SL (stable); other specs experimental |
| **Spec URL** | http://www.fipa.org/repository/aclspecs.html |

**Key Features**:
- 12 message fields, performative-first (request, inform, confirm, query-if, not-understood)
- Speech-act theory foundation — messages express communicative intent, not just data
- Content language (FIPA-SL), interaction protocols (contract net, auction, brokering)
- Implementations: JADE (Java), FIPA-OS

**Adoption Level**: LOW/LEGACY. Academic standard from the 2000s. Gave way to SOA and REST. Still referenced in multi-agent systems research.

**PCC Mapping**: Conceptual ancestor. PCC's typed intent bus is spiritually similar (performatives map to intent types). Not worth direct adoption, but the interaction protocol patterns (especially ContractNet for capability bidding and Brokering for the broker agent) are worth studying as design patterns. PCC's negotiation protocol already resembles FIPA's contract-net protocol.

---

### 1.3 Model Context Protocol (MCP)

| Field | Detail |
|-------|--------|
| **Standard Name** | Model Context Protocol (MCP) |
| **Governing Body** | Agentic AI Foundation (AAIF) under Linux Foundation; co-founded by Anthropic, Block, OpenAI |
| **Current Version** | 2025-11-25 spec revision |
| **Spec URL** | https://modelcontextprotocol.io/specification/2025-11-25 |
| **GitHub** | https://github.com/modelcontextprotocol/modelcontextprotocol |

**Key Features**:
- JSON-RPC 2.0 over stdio/HTTP/SSE transport
- Three primitives: Tools (actions), Resources (data), Prompts (templates)
- 2025 updates: async operations, statelessness option, server identity, official registry
- MCP Apps Extension (SEP-1865) for interactive UIs (Anthropic + OpenAI joint spec)
- Adopted by: OpenAI, Google DeepMind, Microsoft, thousands of developers

**Adoption Level**: VERY HIGH. De facto standard for LLM-to-tool integration. Ecosystem of 10,000+ MCP servers.

**PCC Mapping**: PCC already has a 49-tool MCP server (`packages/mcp-server`). This is the primary interface for AI agents to interact with PCC. The MCP Apps Extension could be used to expose PCC's dashboard UI components directly to AI clients. MCP server registry listing would increase PCC's discoverability.

---

### 1.4 OpenAI Function Calling (Strict Mode)

| Field | Detail |
|-------|--------|
| **Standard Name** | OpenAI Function Calling / Structured Outputs |
| **Governing Body** | OpenAI |
| **Current Version** | Agents SDK (March 2025+) |
| **Docs URL** | https://developers.openai.com/api/docs/guides/function-calling |

**Key Features**:
- `strict: true` guarantees model output matches JSON Schema exactly (constrained decoding)
- All fields must be in `required` array; `additionalProperties: false` enforced
- Three SDK primitives: Handoffs (agent transfer), Guardrails (I/O validation), Tracing (observability)
- Schema pre-processing on first request (latency hit), then cached
- Not all JSON Schema features supported (no `oneOf`, limitations on dynamic schemas)

**Adoption Level**: HIGH. All OpenAI API users. De facto for GPT-based agent systems.

**PCC Mapping**: PCC's 154-tool agent package at `/agent-package.json` should ensure all tool schemas are strict-mode compatible (all properties required, no `additionalProperties`). This would make PCC tools work reliably with OpenAI's Agents SDK without modification.

---

### 1.5 Summary: Agent Communication

| Standard | Maturity | PCC Relevance | Action |
|----------|----------|--------------|--------|
| A2A v0.3 | Growing fast | HIGH | Publish AgentCard at `.well-known/agent-card.json`, align task states |
| FIPA ACL | Legacy | LOW | Study contract-net pattern only |
| MCP | Production | ALREADY INTEGRATED | 56 tools live; add to MCP registry |
| OpenAI Strict | Production | HIGH | Validate agent-package.json for strict-mode compat |

---

## 2. Industrial Equipment Interop

### 2.1 OPC-UA (IEC 62541)

| Field | Detail |
|-------|--------|
| **Standard Name** | OPC Unified Architecture |
| **Governing Body** | OPC Foundation / IEC |
| **Current Version** | IEC 62541-*:2025 (multiple parts updated) |
| **Spec URL** | https://opcfoundation.org |
| **Open Source** | open62541 (MPL 2.0) — https://github.com/open62541/open62541 |

**Key Features**:
- Cross-platform data exchange from sensors to cloud (client/server + pub/sub)
- Information models for 60+ equipment types via Companion Specifications
- Security: X.509 certificates, encryption, authentication, audit trail
- Transport: TCP binary, HTTPS, WebSocket, MQTT, AMQP
- IEC 62541-15:2025 adds safety communication layer (SafetyData)
- IEC 62541-10:2025 updates program state machines

**Adoption Level**: VERY HIGH. Industry standard for manufacturing, energy, building automation. Siemens, ABB, Beckhoff, Rockwell all implement natively.

**PCC Mapping**: PCC's kernel already has an OPC-UA device adapter (`packages/kernel`). OPC-UA Companion Specifications should be used to model capability types for CNC, 3D printing, and industrial equipment. The OPC-UA pub/sub model maps to PCC's SSE streaming for real-time sensor data. OPC-UA's built-in audit trail maps to PCC's evidence chain. Key gap: PCC should consider OPC-UA's information model structure when defining CSDs for industrial equipment.

---

### 2.2 SiLA 2.0

| Field | Detail |
|-------|--------|
| **Standard Name** | SiLA 2 (Standardization in Lab Automation) |
| **Governing Body** | SiLA Consortium (sila-standard.com) |
| **Current Version** | SiLA 2 (Core + Mapping + Features) |
| **Spec URL** | https://sila2.gitlab.io/sila_base/ |

**Key Features**:
- HTTP/2 + Protocol Buffers (gRPC-style) for lab instrument communication
- Microservice architecture — each instrument exposes Features (not device-type-specific)
- Core/Mapping/Features split: Core is stable, Features evolve per vendor
- SiLA Discovery for automatic instrument detection on network
- Security: TLS, authentication built into core spec
- Targets: liquid handlers, readers, chromatography, analytical instruments

**Adoption Level**: MEDIUM. Growing in pharma/biotech. Tecan, Hamilton, Beckman Coulter participating. Not as ubiquitous as OPC-UA.

**PCC Mapping**: PCC's kernel already has a SiLA device adapter. SiLA 2's Feature model maps directly to PCC's CSD (Capability StructureDefinition) concept — both define capabilities functionally rather than by device type. SiLA Discovery maps to `pcc_discover_scan`. The gRPC foundation is compatible with PCC's kernel architecture. PCC should promote SiLA 2 Features as the preferred CSD format for lab instruments.

---

### 2.3 MTConnect

| Field | Detail |
|-------|--------|
| **Standard Name** | MTConnect |
| **Governing Body** | MTConnect Institute (AMT) |
| **Current Version** | v2.2.0 (August 2023); v2.0 was the major SysML rewrite (June 2022) |
| **Spec URL** | https://www.mtconnect.org |
| **ANSI** | ANSI/MTC1.4-2018 (older certification) |

**Key Features**:
- RESTful HTTP API for manufacturing equipment data (read-only by design)
- XML-based semantic vocabulary for CNC machines, robots, sensors
- Agent/Adapter architecture: agents aggregate data from adapters on machines
- SysML-based information model (v2.0+) — machine-readable, extensible
- Streaming via long-poll or HTTP chunked transfer
- OPC-UA Companion Specification exists (MTConnect + OPC-UA bridge)

**Adoption Level**: HIGH in discrete manufacturing. Mazak, DMG Mori, Haas widely implement. Standard in US machine shops.

**PCC Mapping**: MTConnect's read-only agent model is a natural fit for PCC's capability monitoring (sensor data, machine state, cycle counts). The MTConnect agent could feed PCC's evidence chain with real-time machine telemetry. The OPC-UA Companion Spec means PCC can access MTConnect data through the existing OPC-UA adapter. MTConnect's semantic vocabulary should inform PCC's CSD definitions for CNC/machining capabilities.

---

### 2.4 MQTT / Sparkplug B (ISO/IEC 20237)

| Field | Detail |
|-------|--------|
| **Standard Name** | Eclipse Sparkplug 3.0 |
| **Governing Body** | Eclipse Foundation; ISO/IEC 20237 |
| **Current Version** | 3.0 (backward compatible with 2.2) |
| **Spec URL** | https://sparkplug.eclipse.org/specification/ |

**Key Features**:
- Extends MQTT 3.1.1 with structured topic namespace, state management
- Google Protocol Buffer payloads (compact, typed)
- Birth/Death certificates for device lifecycle management
- Metric aliasing for bandwidth optimization
- Store-and-forward for intermittent connectivity (field devices)
- SCADA/HMI integration focus
- ISO/IEC 20237 international standard since November 2023

**Adoption Level**: HIGH in IIoT/SCADA. Growing adoption with Azure Event Grid native support. Preferred for edge-to-cloud in oil & gas, utilities, discrete manufacturing.

**PCC Mapping**: Sparkplug B's birth/death certificates map to PCC's kernel online/offline state management. The structured topic namespace (`spBv1.0/{group_id}/{message_type}/{edge_node_id}/{device_id}`) could define PCC's MQTT topic structure for real-time sensor streaming. Store-and-forward is critical for PCC's field deployments where connectivity is intermittent. This should be the wire protocol for PCC's sensor data pipeline, especially for shop kernels with many devices.

---

### 2.5 PackML (ISA-TR88.00.02-2022)

| Field | Detail |
|-------|--------|
| **Standard Name** | ISA-TR88.00.02 PackML (Packaging Machine Language) |
| **Governing Body** | ISA (OMAC maintains) |
| **Current Version** | ANSI/ISA-TR88.00.02-2022 |

**Key Features**:
- Standardized state machine: 17 states (Idle, Starting, Execute, Completing, Complete, Aborting, Aborted, Stopping, Stopped, Resetting, Holding, Held, Unholding, Suspending, Suspended, Unsuspending, Clearing)
- PackTags: standardized communication tags for machine-to-machine and machine-to-MES
- Modes: Production, Maintenance, Manual, Dry-run
- OPC-UA Companion Specification available
- Originally packaging industry, now used in assembly, discrete manufacturing

**Adoption Level**: HIGH in packaging/CPG. Growing in general manufacturing via OPC-UA Companion Spec.

**PCC Mapping**: PackML's state machine is directly adoptable as PCC's standard equipment state model. PCC's job execution lifecycle could map to PackML states (Idle -> Starting -> Execute -> Completing -> Complete, with Aborting/Holding for exceptions). This would give PCC instant compatibility with any PackML-compliant machine. The 4 modes (Production, Maintenance, Manual, Dry-run) map to PCC's assurance tiers and execution scope classes.

---

### 2.6 ISA-95 / IEC 62264

| Field | Detail |
|-------|--------|
| **Standard Name** | ANSI/ISA-95 / IEC 62264 |
| **Governing Body** | ISA / IEC |
| **Current Version** | ANSI/ISA-95.00.01-2025 (Part 1 revised) |
| **Parts** | 8 parts total |

**Key Features**:
- 5-level hierarchy: Level 0 (sensors) to Level 4 (ERP)
- Level 3 = MES (Manufacturing Execution System) — PCC's primary integration layer
- Common Object Model: operations definitions, schedules, performance, resource models
- B2MML (Business to Manufacturing Markup Language) — XML schemas for data exchange
- Part 8: Information Exchange Profiles for implementation groups

**Adoption Level**: VERY HIGH. The foundational enterprise-to-plant standard. SAP, Oracle, Siemens, Rockwell all build to ISA-95.

**PCC Mapping**: PCC sits at ISA-95 Level 3 (MES equivalent) — it orchestrates manufacturing operations, tracks work orders (jobs), manages resources (capabilities), and reports performance (evidence). The ISA-95 activity model maps to PCC's workflow compiler: Production Operations Management covers PCC's core job lifecycle, Quality Operations Management covers PCC's evidence/verification, and Maintenance Operations Management covers PCC's health monitoring. PCC should adopt ISA-95's terminology where possible to speak the language of enterprise manufacturing customers.

---

### 2.7 Summary: Industrial Equipment Interop

| Standard | Maturity | PCC Relevance | Action |
|----------|----------|--------------|--------|
| OPC-UA (2025) | Production | ALREADY INTEGRATED | Use Companion Specs for CSD definitions |
| SiLA 2.0 | Growing | ALREADY INTEGRATED | Promote as lab CSD format |
| MTConnect 2.2 | Production | HIGH | Map to evidence/telemetry pipeline |
| Sparkplug B 3.0 | Production | HIGH | Adopt for MQTT sensor streaming |
| PackML 2022 | Production | HIGH | Adopt state machine for job execution |
| ISA-95 (2025) | Dominant | HIGH | Align terminology and activity model |

---

## 3. DePIN / Physical Infrastructure Networks

### 3.1 DePIN Ecosystem Patterns

| Field | Detail |
|-------|--------|
| **Category** | Decentralized Physical Infrastructure Networks |
| **Market Size** | 321+ projects, ~$18.3B combined market cap (2025) |
| **TAM** | $3.5T projected by 2028 |
| **Key Projects** | Helium (wireless), Hivemapper (mapping), Render (compute), Filecoin (storage), IoTeX (IoT) |

**Core Architecture Patterns**:

1. **Burn-and-Mint Equilibrium (BME)**: Demand-side users burn native tokens to mint usage credits (Helium Data Credits at $0.00001 each, Render burn-and-mint for GPU jobs). This decouples service pricing from token volatility.

2. **Proof-of-Physical-Work (PoPW)**: Operators prove they deployed and maintain physical infrastructure. Helium uses Proof-of-Coverage (hotspots prove RF coverage). Hivemapper uses dashcam GPS verified against Helium hotspot proximity. Render verifies GPU computation output.

3. **Two-Tier Network Taxonomy**:
   - **PRN (Physical Resource Networks)**: Non-fungible, location-specific (wireless, sensors, energy)
   - **DRN (Digital Resource Networks)**: Fungible (compute, storage, bandwidth)

4. **DePIN Flywheel**: Token rewards attract operators -> more infrastructure -> better service -> more demand -> token value rises -> more operators. The flywheel works when real demand exists (AI infrastructure is the 2025-2026 driver).

5. **Token-Gated Physical Access**: Smart contracts issue capability-based access tokens. On verification of attributes, a smart contract issues secret keys to access physical resources. Blockchain-enabled smart locks use smart contracts for lock/unlock operations with programmable payment integration.

**Adoption Level**: HIGH and accelerating. Helium has 1M+ hotspots. Hivemapper maps 30%+ of world roads. Render processes millions of GPU jobs. AI infrastructure demand is the structural demand driver in 2024-2026.

**PCC Mapping**: PCC IS a DePIN. Current implementation:
- Soulbound NFT certificates (`packages/contracts/ts/capability-certificates.ts`) = proof of capability
- Reward epochs (`packages/contracts/ts/reward-engine.ts`) = operator incentives
- Sovereign Wealth Fund = community treasury
- Ed25519-signed capability announcements = proof-of-physical-work claims
- WebSocket gossip DHT = decentralized discovery

Gaps to close:
- PCC should formalize a Burn-and-Mint model where marketplace usage fees burn PCC tokens to mint job credits
- PCC needs explicit Proof-of-Physical-Work verification (not just signed announcements — actual capability proofs like Helium's coverage challenges)
- PCC's PRN/DRN taxonomy: physical equipment is PRN (location-specific), compute/verification is DRN (fungible)
- Token-gated access pattern maps directly to PCC's execution scope protocol — the scope token IS the access token

---

## 4. Supply Chain & Logistics Standards

### 4.1 GS1 EPCIS 2.0

| Field | Detail |
|-------|--------|
| **Standard Name** | EPCIS 2.0 (Electronic Product Code Information Services) + CBV 2.0 |
| **Governing Body** | GS1 |
| **Current Version** | EPCIS 2.0 / CBV 2.0 |
| **Spec URL** | https://www.gs1.org/standards/epcis |

**Key Features**:
- Event-based traceability: What, When, Where, Why + How for every supply chain event
- EPCIS 2.0: REST API with JSON/JSON-LD payloads (major modernization from XML-only)
- Core Business Vocabulary (CBV) 2.0: standardized terms for business context
- Sensor data integration: standardized method for environmental readings
- Product/process certifications in event messages
- Open-source implementation: Oliot EPCIS

**Adoption Level**: HIGH in retail, pharma, food safety. FDA FSMA 204 mandates EPCIS-style critical tracking events.

**PCC Mapping**: PCC's evidence bundles are conceptually EPCIS events — they record What (capability executed), When (timestamp), Where (kernel location), Why (job contract), and How (equipment parameters + sensor data). PCC should consider EPCIS 2.0 as the evidence event schema for supply chain customers. The JSON-LD format enables semantic interoperability. EPCIS events could be the external representation of PCC evidence for enterprise customers who already use GS1 systems.

---

### 4.2 EDI X12 / UN EDIFACT

| Field | Detail |
|-------|--------|
| **Standard Name** | ANSI ASC X12 / UN/EDIFACT |
| **Governing Body** | ASC X12 (ANSI) / UN/CEFACT |
| **Current Version** | X12 008060 (January 2025); EDIFACT updated biannually |
| **Market Size** | ~$41B EDI market (2025), projected $67B by 2030 |

**Key Features**:
- X12: 300+ transaction sets covering purchase orders, invoices, shipping notices, healthcare claims
- EDIFACT: International equivalent, dominant in Europe/Asia
- X12 008060: Major update replacing 005010, especially for HIPAA
- Both: Batch-oriented, document-exchange paradigm
- 3,000+ industry professionals on ASC X12 committee

**Adoption Level**: VERY HIGH. Foundational B2B commerce. Every large enterprise uses EDI.

**PCC Mapping**: PCC will need EDI compatibility for enterprise customers. Key transaction sets: 850 (Purchase Order = job submission), 810 (Invoice = settlement), 856 (Advance Ship Notice = capability delivery), 997 (Functional Acknowledgment = job acceptance). PCC's gateway should eventually support EDI-to-REST translation for enterprise integration. Not a near-term priority — focus on REST/JSON first, add EDI adapters for enterprise customers.

---

### 4.3 EU Digital Product Passport (DPP)

| Field | Detail |
|-------|--------|
| **Standard Name** | Digital Product Passport (DPP) |
| **Governing Body** | European Commission (Regulation EU 2024/1781, ESPR) |
| **Current Version** | Standards under development by CEN/CENELEC (due 2026) |
| **Timeline** | Registry operational by July 2026; batteries first (2027), textiles/steel (mid-2027) |

**Key Features**:
- Machine-readable product lifecycle data accessible via QR code, RFID, or NFC
- Mandatory for products sold in EU under ESPR (Ecodesign for Sustainable Products Regulation)
- 8 harmonised standards expected by 2026 (CEN/CENELEC)
- Interoperable data formats
- EBSI blockchain verification for cryptographic proof
- Covers: materials composition, carbon footprint, repairability, recyclability

**Adoption Level**: EMERGING — regulatory mandate with 2027+ enforcement. Market is scrambling to prepare.

**PCC Mapping**: PCC-executed manufacturing jobs could generate DPP-compliant data as a byproduct. Evidence bundles (materials used, process parameters, quality measurements, energy consumption) map directly to DPP requirements. PCC could offer DPP generation as a value-add service: every job produces not just the physical output but also its Digital Product Passport. This is a significant competitive advantage for EU market access. The CID-anchored evidence chain provides the tamper-proof audit trail DPP requires.

---

### 4.4 W3C Traceability Vocabulary

| Field | Detail |
|-------|--------|
| **Standard Name** | Traceability Vocabulary v1.0 |
| **Governing Body** | W3C Credentials Community Group |
| **Current Version** | v1.0 (December 2024) — Community Group report, NOT a W3C Recommendation |
| **GitHub** | https://github.com/w3c-ccg/traceability-vocab |
| **Interop Spec** | Traceability Interoperability v1.0 (December 2024) |

**Key Features**:
- Linked Data vocabulary for supply chain Verifiable Credentials
- Covers: country of origin, chemical properties, mechanical properties, product attributes
- HTTP API for enterprise-grade credential exchange using DIDs and VCs
- Goal: secure digitized global supply chain via W3C cryptographic standards
- JSON-LD based, interoperable with existing VC ecosystem

**Adoption Level**: MEDIUM. Growing in government/regulated supply chains. Companies like Tradeverifyd building on it.

**PCC Mapping**: PCC's evidence chain should be expressible as W3C Traceability VCs. When a 3D print job completes, the evidence (material certificate, dimensional measurements, process parameters) could be issued as Verifiable Credentials using this vocabulary. The existing VC infrastructure in `packages/spec/src/identity/` provides the foundation. PCC should define PCC-specific credential types that extend the Traceability Vocabulary for physical capability execution.

---

### 4.5 Summary: Supply Chain & Logistics

| Standard | Maturity | PCC Relevance | Action |
|----------|----------|--------------|--------|
| EPCIS 2.0 | Production | HIGH | Align evidence schema for enterprise interop |
| EDI X12/EDIFACT | Dominant | MEDIUM | Future adapter for enterprise integration |
| EU DPP | Emerging | HIGH | Generate DPP data from evidence bundles |
| W3C Traceability | Growing | HIGH | Issue evidence as Verifiable Credentials |

---

## 5. Quality & Compliance

### 5.1 ISO 9001 (Quality Management)

| Field | Detail |
|-------|--------|
| **Standard Name** | ISO 9001 Quality Management Systems |
| **Governing Body** | ISO/TC 176 |
| **Current Version** | ISO 9001:2015 (confirmed 2021; revision expected September 2026) |

**Key Features**:
- Plan-Do-Check-Act cycle; risk-based thinking; process approach
- Context of the organization, leadership, planning, support, operation, performance evaluation, improvement
- 81 National Standards Bodies confirmed revision without delay (2025)
- Expected September 2026 publication of revised standard

**Adoption Level**: DOMINANT. >1 million certified organizations worldwide. Baseline for all quality management.

**PCC Mapping**: PCC must facilitate ISO 9001 compliance for shop kernel operators. Evidence bundles should map to ISO 9001's "documented information" requirements. PCC's quality control workflow (evidence -> verification -> attestation) IS the ISO 9001 monitoring and measurement process. PCC should provide ISO 9001-aligned audit reports as exportable artifacts from the evidence chain.

---

### 5.2 ISO 13485 (Medical Device QMS)

| Field | Detail |
|-------|--------|
| **Standard Name** | ISO 13485 Medical Devices — Quality Management Systems |
| **Governing Body** | ISO/TC 210 |
| **Current Version** | ISO 13485:2016 (confirmed in 2025 review, no revision planned) |

**Key Features**:
- ISO 9001 derivative with medical device-specific requirements
- Design controls, risk management (ISO 14971), traceability, sterility, biocompatibility
- Regulatory harmonization: EU MDR, FDA 21 CFR 820, Health Canada
- Process validation requirements for production and service provision
- Strict documentation and record-keeping requirements

**Adoption Level**: HIGH. Required for medical device manufacturers worldwide.

**PCC Mapping**: PCC's Assurance Tier 3 should meet ISO 13485 requirements for medical device manufacturing. This means: full process validation records in evidence bundles, traceability from raw material to finished device (EPCIS-style events), design control documentation in CSDs, and risk management artifacts. PCC's evidence-chain approach is naturally aligned — the gap is in ensuring the evidence captures all required ISO 13485 documented information.

---

### 5.3 ISO/IEC 17025 (Testing & Calibration Labs)

| Field | Detail |
|-------|--------|
| **Standard Name** | ISO/IEC 17025 General Requirements for Testing and Calibration Laboratories |
| **Governing Body** | ISO/IEC |
| **Current Version** | ISO/IEC 17025:2025 (new edition, transition period to September 2028) |

**Key Features**:
- Risk-based competence approach (calibration intervals based on performance history)
- New: explicit digital data integrity requirements, software validation
- Harmonized with ISO/IEC 17020 (inspection) and 17043 (proficiency testing)
- Updated IT provisions for networked instruments, cloud LIMS, automated data pipelines
- Metrological traceability to SI units
- Measurement uncertainty reporting

**Adoption Level**: HIGH. Required for lab accreditation globally.

**PCC Mapping**: Critical for PCC's lab instrument capabilities (HPLC, spectroscopy, materials testing). The 2025 edition's new digital data integrity requirements align perfectly with PCC's content-addressed evidence chain. PCC's sensor data pipeline (channels, readings, anomalies) maps to 17025's measurement and calibration record requirements. PCC should offer a 17025-compliance mode that ensures all required metadata (uncertainty, traceability, environmental conditions) is captured in evidence bundles.

---

### 5.4 FDA 21 CFR Part 11 (Electronic Records)

| Field | Detail |
|-------|--------|
| **Standard Name** | 21 CFR Part 11 — Electronic Records; Electronic Signatures |
| **Governing Body** | FDA |
| **Current Version** | Original 1997, never formally revised; enforcement guided by FDA Guidance documents |

**Key Features**:
- Electronic records equivalent to paper records if validated
- Electronic signatures equivalent to handwritten signatures
- Requirements: audit trails, system validation, access controls, authority checks
- Data integrity focus: ALCOA+ principles (Attributable, Legible, Contemporaneous, Original, Accurate + Complete, Consistent, Enduring, Available)
- Applies to any FDA-regulated industry: pharma, biotech, medical devices, food

**Adoption Level**: MANDATORY for FDA-regulated industries. Universal compliance requirement.

**PCC Mapping**: PCC's evidence chain is inherently Part 11-aligned:
- **Audit trail**: Hash-chained evidence logs with content-addressed storage
- **Attributable**: Every evidence bundle has agent/operator identity (ERC-8004, DIDs)
- **Contemporaneous**: Timestamped sensor data and evidence capture
- **Original**: Content-addressed storage (CIDs) ensures immutability
- **Enduring**: IPFS/Storacha provides durable storage
PCC should document Part 11 compliance mapping and offer it as a feature for pharma/biotech customers.

---

### 5.5 NIST 800-171 (CUI Protection)

| Field | Detail |
|-------|--------|
| **Standard Name** | NIST SP 800-171 — Protecting CUI in Nonfederal Systems |
| **Governing Body** | NIST |
| **Current Version** | Rev 3 (May 2024) — 97 controls; Rev 2 still mandated by DoD for CMMC |

**Key Features**:
- 97 security controls (consolidated from 110 in Rev 2)
- 3 new control families in Rev 3
- Organizationally Defined Parameters (ODPs) for flexibility
- Basis for CMMC (Cybersecurity Maturity Model Certification) Level 2
- Covers: access control, awareness training, audit, configuration management, identification, incident response, maintenance, media protection, physical protection, risk assessment, security assessment, system/communications protection, system/information integrity

**Adoption Level**: MANDATORY for US government contractors handling CUI. Expanding via CMMC to entire defense supply chain.

**PCC Mapping**: PCC must meet NIST 800-171 to serve defense/government customers. Key alignment areas: PCC's execution scope protocol (access control), audit logging (JSONL audit trail), NaCl-box encryption (system/communications protection), Ed25519 signing (identification/authentication). Gap: PCC needs a formal NIST 800-171 self-assessment and system security plan. This is a prerequisite for defense manufacturing marketplace participation.

---

### 5.6 AS9100 / IA9100 (Aerospace QMS)

| Field | Detail |
|-------|--------|
| **Standard Name** | AS9100 (transitioning to IA9100) |
| **Governing Body** | IAQG (International Aerospace Quality Group) |
| **Current Version** | AS9100D (current); IA9100 limited update 2025-2026, full update 2027 after ISO 9001:2026 |

**Key Features**:
- ISO 9001 + aerospace-specific: product safety, configuration management, counterfeit parts prevention
- Rebranding from "AS" to "IA" to reflect international governance
- Modernized supplier management and digital assurance in upcoming revision
- Special processes: welding, heat treatment, surface coating require additional qualification
- OASIS (Online Aerospace Supplier Information System) for audit management

**Adoption Level**: MANDATORY for aerospace supply chain. Boeing, Airbus, Lockheed Martin require it.

**PCC Mapping**: PCC's Assurance Tier 3 should satisfy AS9100/IA9100 requirements for aerospace parts manufacturing. Configuration management maps to PCC's CSD versioning. Counterfeit parts prevention maps to PCC's evidence chain + content-addressed storage. Product safety requirements map to PCC's evidence verification + attestation pipeline. Key gap: PCC needs Special Process qualification tracking in kernel configurations.

---

### 5.7 IATF 16949 (Automotive QMS)

| Field | Detail |
|-------|--------|
| **Standard Name** | IATF 16949 |
| **Governing Body** | IATF (International Automotive Task Force) |
| **Current Version** | IATF 16949:2016; Rules 6th Edition effective January 2025; 2nd edition expected 2027 |

**Key Features**:
- ISO 9001 + automotive-specific: APQP (Advanced Product Quality Planning), PPAP (Production Part Approval Process), FMEA, MSA, SPC
- Core tools: Control Plans, Process Flow Diagrams, PFMEA
- Customer-specific requirements (CSRs) from each OEM
- Defect prevention orientation; reduction of variation and waste

**Adoption Level**: MANDATORY for automotive supply chain. GM, Ford, Toyota, VW, BMW require it.

**PCC Mapping**: PCC's workflow compiler should support IATF 16949 core tool artifacts: Control Plans (map to capability contracts), PFMEA (map to risk assessment in CSDs), SPC (map to sensor data statistical analysis). PPAP documentation could be auto-generated from PCC evidence bundles. This is a significant value proposition for automotive contract manufacturers using PCC.

---

### 5.8 GxP (Good Practice — Pharma)

| Field | Detail |
|-------|--------|
| **Standard Name** | GxP (GMP, GLP, GCP, GDP) |
| **Governing Body** | FDA, EMA, WHO |
| **Current Regulations** | FDA: 21 CFR Parts 210-211 (GMP), 58 (GLP), 50/56/312 (GCP); EU: EudraLex Vol 4, Annex 11 |

**Key Features**:
- GMP (Good Manufacturing Practice): production controls, process validation, environmental monitoring
- GLP (Good Laboratory Practice): non-clinical study conduct, data integrity
- GCP (Good Clinical Practice): clinical trial conduct, patient safety
- GDP (Good Distribution Practice): storage, transport, temperature monitoring
- ALCOA+ data integrity principles across all GxP areas
- Annex 11 (EU): computerized systems validation and compliance monitoring
- GAMP 5 2nd Edition: risk-based approach to computerized system validation

**Adoption Level**: MANDATORY for pharma/biotech. Global enforcement.

**PCC Mapping**: PCC serves GxP-regulated industries through lab instrument capabilities. PCC's evidence chain must satisfy ALCOA+ for every GxP-relevant data point. The kernel's environmental monitoring (temperature, humidity sensors) maps directly to GDP requirements. Process validation records in evidence bundles satisfy GMP. The gap is in PCC providing GAMP 5-aligned system validation documentation for the PCC platform itself — this is needed for customer validation qualification (IQ/OQ/PQ).

---

### 5.9 Summary: Quality & Compliance

| Standard | Maturity | PCC Relevance | Action |
|----------|----------|--------------|--------|
| ISO 9001 (2015/2026) | Dominant | HIGH | Align evidence exports with documented info requirements |
| ISO 13485 (2016) | Dominant | HIGH (medical) | Tier 3 assurance for medical device mfg |
| ISO 17025 (2025) | Dominant | HIGH (labs) | 17025-compliance mode for lab capabilities |
| 21 CFR Part 11 | Mandatory | HIGH (FDA) | Document compliance mapping, ALCOA+ alignment |
| NIST 800-171 | Mandatory | HIGH (defense) | Self-assessment needed for gov customers |
| AS9100 / IA9100 | Mandatory | HIGH (aero) | Special process tracking in kernels |
| IATF 16949 | Mandatory | HIGH (auto) | Auto-generate PPAP from evidence bundles |
| GxP | Mandatory | HIGH (pharma) | GAMP 5 validation docs for PCC platform |

---

## 6. Agent Harness / Guardrails

### 6.1 LangGraph Checkpointing

| Field | Detail |
|-------|--------|
| **Framework** | LangGraph (LangChain) |
| **Key Pattern** | State graph checkpointing |
| **Docs** | https://langchain-ai.github.io/langgraph/ |

**Key Features**:
- Graph-based agent orchestration with typed state
- Checkpointer snapshots entire graph state at configurable points
- Resume from last checkpoint on failure (not from scratch)
- Human-in-the-loop: pause at any node, inject input, resume
- LangSmith integration for observability and tracing
- Streaming support for real-time UI updates
- Highest production readiness among agent frameworks (2025-2026 consensus)

**Adoption Level**: HIGH. De facto for production LangChain-based agents.

**PCC Mapping**: PCC's workflow compiler produces DAGs — LangGraph could execute them as state graphs with checkpointing. PCC's job execution lifecycle (submitted -> executing -> completing -> complete) maps to LangGraph graph states. The human-in-the-loop pattern maps to PCC's execution scope escalation (auto-retry -> brain recovery -> operator escalation). PCC should consider LangGraph as a reference for its own agent runtime checkpointing.

---

### 6.2 CrewAI Guardrails

| Field | Detail |
|-------|--------|
| **Framework** | CrewAI |
| **Key Pattern** | Role-based agent teams with guardrails |
| **Docs** | https://docs.crewai.com |

**Key Features**:
- Agent Roles, Goals, Backstories — declarative agent configuration
- Task-level guardrails: input/output validation
- Sequential and hierarchical process execution
- Session memory with conversation persistence
- Growing ecosystem, medium production readiness
- Limited checkpointing granularity vs LangGraph

**Adoption Level**: MEDIUM. Popular for rapid prototyping, growing enterprise adoption.

**PCC Mapping**: PCC's 5 agent types (User, Broker, Kernel, Evaluator, Support) already implement role-based design. CrewAI's task-level guardrails pattern is similar to PCC's action classification system (read/write/exec/network/credential classes with per-agent allowlists). PCC's existing guardrail system is more sophisticated than CrewAI's (policy files, keyword scoring, dual-logging). Lessons to learn: CrewAI's declarative agent configuration is cleaner than PCC's current code-defined agents.

---

### 6.3 OpenAI Agents SDK Safety

| Field | Detail |
|-------|--------|
| **Framework** | OpenAI Agents SDK |
| **Key Pattern** | Handoffs + Guardrails + Tracing |
| **Docs** | https://openai.com/agents-sdk |

**Key Features**:
- Handoffs: Type-safe agent-to-agent transfer of control
- Guardrails: Input validation (pre-execution) and output validation (post-execution)
- Tracing: End-to-end observability with trace IDs
- Function calling with strict mode for schema enforcement
- Lightweight — minimal abstraction over API

**Adoption Level**: GROWING. Released March 2025. Strong adoption due to OpenAI ecosystem.

**PCC Mapping**: PCC's A2A intent bus already implements handoff patterns. The guardrails model (pre/post validation) should be formalized in PCC's agent runtime — currently the tool-broker does action classification, but explicit input/output validators per intent type would add defense-in-depth. Tracing maps to PCC's JSONL audit log.

---

### 6.4 Enterprise Guardrail Patterns (2025 Consensus)

Based on cross-industry analysis (AI Agent Index 2025, enterprise playbooks):

**Three Pillars**:
1. **Guardrails**: Prevent harmful/out-of-scope behavior. Multi-layer: input validation, output validation, tool call interception, rate limiting, content filtering.
2. **Permissions**: Define exact boundaries of agent authority. Default-deny tool access. ABAC (Attribute-Based Access Control) policies for top-risk actions.
3. **Auditability**: Traceability, accountability, transparency. Every action logged with timestamp, agent identity, action class, arguments hash.

**Sandboxing Patterns**:
- Documented for 9/30 production agents (developer/CLI tools, browser agents)
- Hermetic execution: no network unless explicitly permitted, full cleanup between executions
- Egress allowlists + time/resource quotas
- VM/container isolation for untrusted code execution

**Tool Use Constraints**:
- Consumer agents: limited permissions + action space (8/30 agents)
- Prompt injection defenses (7/30 agents)
- Dangerous action keyword scoring (rm -rf, git push --force, drop table, curl | sh)
- Dual-logging for high-risk actions

**PCC Mapping**: PCC's harness system already implements all three pillars:
- **Guardrails**: Action classification with 5 classes, dangerous keyword scoring (0.0-1.0 threshold at 0.5)
- **Permissions**: Per-agent allowlists in `action-policy.json` (14 agent roles)
- **Auditability**: JSONL audit log with action classification, args hash (SHA256)
- **Sandboxing**: Execution scope protocol with 4 operation classes (READ/SAFE/SCOPED/PRIVILEGED)
PCC is ahead of the industry consensus. The gap is formal documentation of the security model for external auditors.

---

### 6.5 Summary: Agent Harness / Guardrails

| Pattern | Maturity | PCC Relevance | Action |
|---------|----------|--------------|--------|
| LangGraph Checkpointing | Production | HIGH | Reference for agent runtime checkpointing |
| CrewAI Guardrails | Growing | MEDIUM | Declarative agent config pattern |
| OpenAI Agents SDK | Growing | HIGH | Strict-mode compat for agent-package.json |
| Enterprise Guardrails | Consensus | ALREADY IMPLEMENTED | Document security model formally |

---

## 7. Marketplace Protocol Design

### 7.1 Double Auction Mechanisms

| Field | Detail |
|-------|--------|
| **Mechanism** | Double Auction / Continuous Double Auction (CDA) |
| **Foundation** | Microeconomic theory; Vernon Smith (Nobel 2002) |
| **Key Property** | Converges to competitive equilibrium |

**Key Features**:
- Buyers submit bids, sellers submit asks; clearing price where supply meets demand
- Continuous Double Auction (CDA): matching happens in real-time (stock exchanges)
- Call Auction: bids/asks collected, cleared at discrete intervals
- Myerson-Satterthwaite impossibility: no mechanism simultaneously achieves individual rationality (IR), incentive compatibility (IC), strong budget-balance (SBB), and efficiency
- O(1)-approximation mechanisms exist that achieve IR + IC + SBB with near-optimal welfare

**Adoption Level**: VERY HIGH. Foundation of all financial exchanges. eBay, stock markets.

**PCC Mapping**: PCC's capability marketplace could use a CDA for commoditized capabilities (3D printing with standard materials, basic CNC operations) where multiple providers compete. For specialized capabilities (rare instruments, unique equipment), an auction is less appropriate — direct negotiation or posted prices work better. PCC's negotiation protocol (CREATED -> COMMITTED) currently supports bilateral negotiation. Adding CDA for commodity capabilities would improve price discovery and allocation efficiency.

---

### 7.2 Combinatorial Auctions

| Field | Detail |
|-------|--------|
| **Mechanism** | Combinatorial Auction / Combinatorial Double Auction |
| **Key Property** | Bidding on bundles of items simultaneously |

**Key Features**:
- Participants bid on combinations of items, not just individual items
- Solves complementarity problem: "I need CNC + surface coating together, not separately"
- NP-hard winner determination problem (computational complexity)
- Recent: O(1)-approximation for two-sided combinatorial auctions with IR + IC + SBB
- Applications: spectrum allocation, cloud resource markets, additive manufacturing markets
- Iterative price-based combinatorial double auctions for additive manufacturing (2024 research)

**Adoption Level**: MEDIUM. FCC spectrum auctions, some cloud markets. Academic interest in manufacturing application.

**PCC Mapping**: HIGHLY relevant. PCC workflows often require multiple capabilities in sequence (e.g., "print + cure + inspect + ship"). A combinatorial auction lets requesters bid on the entire workflow bundle. This maps directly to PCC's workflow compiler — the compiled DAG becomes the bundle specification. Implementation: PCC's broker agent could run a combinatorial auction when a workflow requires capabilities from multiple kernels.

---

### 7.3 Dynamic Pricing (Uber Surge Model)

| Field | Detail |
|-------|--------|
| **Mechanism** | Real-time dynamic pricing / Surge pricing |
| **Key Example** | Uber surge pricing algorithm |
| **Update Frequency** | Every 5-10 minutes per geographic zone |

**Key Features**:
- Core principles: real-time data aggregation, geospatial partitioning, predictive demand modeling
- Multiplier applied to base fare components (base, per-mile, per-minute)
- Two-sided incentive: higher prices reduce demand AND increase supply simultaneously
- Additive surge more incentive-compatible than multiplicative surge (research finding)
- Weak supply response: demand drops when prices rise, but supply bump is "weak"
- Reinforcement learning approaches for optimization (2023+ research)

**Adoption Level**: VERY HIGH. Uber, Lyft, DoorDash, all delivery platforms.

**PCC Mapping**: PCC already has Meteora DLMM pools for dynamic capability pricing. The Uber model provides a simpler approach for real-time pricing: PCC could implement per-kernel surge pricing based on queue depth (demand) and availability (supply). The key insight from Uber research is that additive pricing (base + surge_amount) is more fair than multiplicative (base * multiplier). PCC's pricing engine should consider both queue-based surge and AMM-based liquidity pool pricing, with the broker agent selecting the appropriate mechanism per capability type.

---

### 7.4 Reputation Systems

| Field | Detail |
|-------|--------|
| **Domain** | Online marketplace trust and reputation |
| **Key Models** | eBay (feedback scores), Airbnb (5-star + reviews + verification), Uber (two-sided ratings) |

**Key Features**:
- **eBay model**: Aggregate feedback score, percentage positive, detailed seller ratings. First-generation: reviews + product descriptions were the main trust signals.
- **Airbnb model**: Personal profiles, photos, identity verification, 5-star ratings (skewed: 94% are 4.5-5 stars), host "Superhost" status. Trust engine: reviews + verification + AI safety.
- **Uber model**: Two-sided ratings (rider rates driver, driver rates rider), algorithmic reputation score combining consumer data and platform surveillance.
- **Challenges**: Ratings inflation (Airbnb 4.7 average), discrimination (bias against African American users), manipulation, cold-start problem for new participants.
- **AI integration (2025)**: Airbnb uses ML for suspicious listing detection (40% scam reduction), AI-suggested pricing (15% booking increase for compliant hosts).

**Adoption Level**: UNIVERSAL. Every marketplace uses some form of reputation.

**PCC Mapping**: PCC has ERC-8004 Reputation Registry and evidence-based attestation. Advantages over traditional models:
- **Evidence-based**: Reputation derived from verified evidence (sensor data, photos, measurements) not subjective reviews
- **On-chain**: Portable across platforms, not locked in a single marketplace
- **Objective**: Quality metrics (dimensional accuracy, timing compliance, material properties) measured by instruments, not humans
- **Bittensor verification**: Third-party consensus on evidence quality
Key gaps: PCC needs a cold-start mechanism (new operators get jobs through lower assurance tiers), rating aggregation (how to combine multiple evidence-based scores into a single reputation), and decay (reputation should degrade with inactivity).

---

### 7.5 Summary: Marketplace Protocol Design

| Pattern | Maturity | PCC Relevance | Action |
|---------|----------|--------------|--------|
| Double Auction (CDA) | Mature theory | HIGH | Add for commodity capabilities |
| Combinatorial Auction | Mature theory | VERY HIGH | Workflow bundle bidding via broker |
| Dynamic Pricing (Surge) | Production | PARTIALLY IMPLEMENTED | Meteora pools; add queue-based surge |
| Reputation Systems | Universal | PARTIALLY IMPLEMENTED | ERC-8004 registry; add cold-start + decay |

---

## 8. Decentralized Identity & Trust

### 8.1 W3C DIDs (Decentralized Identifiers)

| Field | Detail |
|-------|--------|
| **Standard Name** | Decentralized Identifiers (DIDs) |
| **Governing Body** | W3C DID Working Group |
| **Current Version** | v1.1 Candidate Recommendation Snapshot (March 5, 2026) |
| **Spec URL** | https://www.w3.org/TR/did-1.1/ |

**Key Features**:
- Self-sovereign identifiers: no central registration authority
- DID syntax: `did:<method>:<method-specific-id>`
- DID Document: public keys, authentication methods, service endpoints
- DID Resolution: resolve DID to DID Document via method-specific resolver
- 100+ DID methods: did:key, did:web, did:ethr, did:ion, did:peer, etc.
- v1.1 updates: stability improvements, comments open until April 2026

**Adoption Level**: HIGH. W3C Recommendation (v1.0 since 2022). Foundational for decentralized identity.

**PCC Mapping**: PCC already implements DIDs (`did:key` + `did:pcc`) in `packages/spec/src/identity/`. Every agent, operator, and kernel has a DID. The `did:pcc` method should be formally specified and registered. PCC's DID Documents should include service endpoints for A2A AgentCard, MCP server, and capability discovery. Current implementation is solid — the gap is formal DID method specification documentation.

---

### 8.2 W3C Verifiable Credentials (VCs) 2.0

| Field | Detail |
|-------|--------|
| **Standard Name** | Verifiable Credentials Data Model 2.0 |
| **Governing Body** | W3C VC Working Group |
| **Current Version** | v2.0 W3C Recommendation (May 15, 2025) |
| **Spec URL** | https://www.w3.org/TR/vc-data-model-2.0/ |

**Key Features**:
- Issuer -> Holder -> Verifier trust triangle
- Cryptographic proof of credential integrity and issuer identity
- v2.0: refined terminology, JOSE/COSE + Data Integrity security mechanisms
- Selective disclosure and privacy guarantees
- JSON-LD extensibility
- Ecosystem: 100+ issuers, verifiers, wallets

**Adoption Level**: HIGH. W3C Recommendation. EU digital identity (eIDAS 2.0), US government digital credentials.

**PCC Mapping**: PCC already implements VCs for identity. Evidence attestations should be issued as VCs — when a verifier confirms evidence quality, the attestation is a Verifiable Credential that can be verified by anyone without contacting PCC. This makes PCC evidence portable and independently verifiable. The evaluator agent's ACP-to-A2A bridge should produce VC-formatted attestations.

---

### 8.3 ERC-725/735 (Blockchain Identity & Claims)

| Field | Detail |
|-------|--------|
| **Standard Name** | ERC-725 (Proxy Identity) + ERC-735 (Claim Holder) |
| **Governing Body** | Ethereum EIP process |
| **Proposed By** | Fabian Vogelsteller (2017) |
| **Status** | Draft / Low adoption |

**Key Features**:
- ERC-725: Proxy contract representing an identity on Ethereum; manages keys and executes actions
- ERC-735: Claims management on identity — third parties can attest claims about an identity
- Web of trust: rely on claims from trusted third parties about a given identity
- Superseded in practice by newer standards (ERC-8004, W3C DIDs)

**Adoption Level**: LOW. Historical importance. Not widely adopted. ERC-725 Alliance exists but small.

**PCC Mapping**: PCC has moved past ERC-725/735 to ERC-8004, which is the correct choice. ERC-725's proxy identity pattern is still relevant for PCC's SmartAccountManager (ERC-4337 smart accounts). The claims model in ERC-735 is conceptually similar to PCC's evidence attestations. No action needed — PCC's ERC-8004 implementation is the modern evolution.

---

### 8.4 ERC-8004 (Trustless Agents)

| Field | Detail |
|-------|--------|
| **Standard Name** | ERC-8004 — Trustless Agents |
| **Governing Body** | Ethereum EIP process |
| **Status** | Draft (proposed 2025) |

**Key Features**:
- Three lightweight on-chain registries:
  - **Identity Registry**: Register agent identities with metadata
  - **Reputation Registry**: Portable, decentralized reputation scores
  - **Validation Registry**: Third-party validation attestations
- Designed for AI agent discovery and trust establishment "without pre-existing trust"
- Builds on W3C DID/VC foundations but adds on-chain discoverability
- Agent Registration File at well-known endpoint

**Adoption Level**: EMERGING. Early-stage Ethereum EIP. PCC is one of the first implementers.

**PCC Mapping**: PCC already implements ERC-8004 fully:
- `packages/identity-8004`: Identity/Reputation/Validation registry clients (viem), ABIs
- `/.well-known/agent-registration.json`: Agent Registration File served by gateway
- Reputation bridge in evaluator agent
PCC is a leader in ERC-8004 adoption and could contribute to the EIP's finalization.

---

### 8.5 Trust over IP (ToIP)

| Field | Detail |
|-------|--------|
| **Standard Name** | Trust over IP Stack |
| **Governing Body** | ToIP Foundation (Linux Foundation Decentralized Trust) |
| **Key Specs** | Technology Architecture Spec, Governance Architecture Spec, TRQP v2.0 (Trust Registry Query Protocol) |
| **Spec URL** | https://trustoverip.org |

**Key Features**:
- Four-layer stack (modeled on TCP/IP):
  - **Layer 1**: Trust roots (DIDs, decentralized PKI)
  - **Layer 2**: DIDComm protocol (encrypted peer-to-peer messaging)
  - **Layer 3**: Credential exchange (W3C VCs)
  - **Layer 4**: Application ecosystems (governance frameworks)
- TRQP: Lightweight read-only protocol for trust registry queries ("DNS for trust")
- Governance Architecture: human accountability layer over technical stack
- Technology + Governance halves form complete trust infrastructure

**Adoption Level**: MEDIUM. Growing. Adopted by Canadian government (Pan-Canadian Trust Framework), EBSI, various industry verticals.

**PCC Mapping**: ToIP provides the theoretical framework for PCC's trust architecture:
- Layer 1: PCC's `did:key` + `did:pcc` identifiers
- Layer 2: PCC's NaCl-box encrypted P2P messaging
- Layer 3: PCC's evidence VCs and capability attestations
- Layer 4: PCC's assurance tier governance (tier definitions, evidence requirements, dispute rules)
TRQP is highly relevant — PCC's capability registry could implement TRQP so external systems can query "is this operator trusted for Tier 2 CNC machining?" PCC should evaluate adopting TRQP for its registry API.

---

### 8.6 EBSI (European Blockchain Services Infrastructure)

| Field | Detail |
|-------|--------|
| **Standard Name** | European Blockchain Services Infrastructure |
| **Governing Body** | European Commission / EUROPEUM-EDIC |
| **Status** | Production-ready (5+ years development); EDIC governance entity forming |
| **Network** | 27 EU countries + Norway + Liechtenstein + European Commission nodes |

**Key Features**:
- Distributed blockchain network for public services
- Use cases: verifiable diplomas, social security, digital identity
- Built on W3C DIDs and VCs
- Cross-border credential verification without intermediaries
- EBSI Sandbox: third cohort of pilot projects (2025)
- Cryptographic verification via EBSI Trusted Issuers Registry

**Adoption Level**: MEDIUM. EU-focused. Growing through regulatory mandate.

**PCC Mapping**: EBSI provides a path for PCC to integrate with EU digital identity infrastructure. PCC operators in the EU could use EBSI-issued VCs for identity verification. PCC's evidence VCs could be anchored in EBSI for EU regulatory compliance. Relevant for EU DPP (Digital Product Passport) compliance — EBSI blockchain verification for product passports. Not a near-term priority but important for EU market expansion.

---

### 8.7 Summary: Decentralized Identity & Trust

| Standard | Maturity | PCC Relevance | Action |
|----------|----------|--------------|--------|
| W3C DIDs v1.1 | Recommendation | ALREADY IMPLEMENTED | Formalize did:pcc method spec |
| W3C VCs 2.0 | Recommendation | ALREADY IMPLEMENTED | Issue evidence as VCs |
| ERC-725/735 | Legacy | SUPERSEDED | No action (ERC-8004 is the evolution) |
| ERC-8004 | Emerging | ALREADY IMPLEMENTED | Contribute to EIP finalization |
| ToIP Stack | Growing | HIGH | Evaluate TRQP for registry API |
| EBSI | Growing | MEDIUM (EU) | Future EU market integration |

---

## 9. Evidence & Attestation

### 9.1 IETF RATS (Remote Attestation Procedures) — RFC 9334

| Field | Detail |
|-------|--------|
| **Standard Name** | Remote ATtestation procedureS (RATS) Architecture |
| **Governing Body** | IETF RATS Working Group |
| **Current Version** | RFC 9334 (January 2023) |
| **Spec URL** | https://datatracker.ietf.org/doc/rfc9334/ |
| **Authors** | H. Birkholz, D. Thaler, M. Richardson, N. Smith, W. Pan |

**Key Features**:
- Architecture for determining trustworthiness of remote peers (Attesters)
- Two-stage appraisal via trusted Verifier with supply chain links
- Key roles:
  - **Attester**: Entity being appraised (produces Evidence)
  - **Verifier**: Trusted party that appraises Evidence against Reference Values
  - **Relying Party**: Consumer of Attestation Results
  - **Endorser**: Provides Endorsements to help Verifier appraise Evidence
  - **Reference Value Provider**: Provides expected values for comparison
- Evidence types: TPM PCRs, TEE measurements, firmware hashes, TCG event logs
- Processor-architecture neutral, content-format neutral, protocol neutral

**Adoption Level**: HIGH in hardware security. Growing in cloud attestation services.

**PCC Mapping**: RATS RFC 9334 is the theoretical foundation for PCC's evidence verification pipeline:
- **Attester** = Shop Kernel (produces evidence bundles)
- **Verifier** = PCC verifier market + Bittensor subnet
- **Relying Party** = Job requester / marketplace participants
- **Endorser** = Equipment manufacturer (device calibration certificates)
- **Reference Value Provider** = CSD definitions (expected parameters, tolerances)
PCC should formally map its evidence flow to RATS terminology. The two-stage appraisal model (evidence collection -> verification -> attestation result) is exactly what PCC implements. RATS compliance would legitimize PCC's approach with hardware security community.

---

### 9.2 TPM (Trusted Platform Module)

| Field | Detail |
|-------|--------|
| **Standard Name** | Trusted Platform Module (TPM) |
| **Governing Body** | Trusted Computing Group (TCG) |
| **Current Version** | TPM 2.0 (ISO/IEC 11889:2015) |

**Key Features**:
- Hardware security module embedded in devices
- Platform Configuration Registers (PCRs): tamper-evident measurement chain
- Secure key generation and storage
- Remote attestation: prove platform integrity to remote verifier
- Sealed storage: encrypt data to specific platform state
- Used in: Windows (BitLocker), Linux (IMA), cloud attestation

**Adoption Level**: VERY HIGH. Mandatory in Windows 11. Standard in enterprise hardware.

**PCC Mapping**: PCC shop kernels running on TPM-equipped hardware could use TPM attestation to prove platform integrity — proving the kernel software hasn't been tampered with. This is Assurance Tier 3 territory: not just "did the machine produce good output?" but "can we trust the computer reporting the results?" TPM PCR measurements could be included in evidence bundles as platform attestation. Long-term goal, not near-term.

---

### 9.3 Intel SGX/TDX Attestation

| Field | Detail |
|-------|--------|
| **Standard Name** | Intel SGX (Software Guard Extensions) / Intel TDX (Trust Domain Extensions) |
| **Governing Body** | Intel; Confidential Computing Consortium (CCC) |
| **Current State** | SGX: mature, application-level TEE; TDX: VM-level confidential computing, expanding in 2025 |

**Key Features**:
- **SGX**: Secure enclaves for sensitive code/data isolation; memory encryption; attestation via EPID/DCAP
- **TDX**: VM-level confidential computing; entire VM protected from hypervisor; hardware-encrypted memory
- **Intel Trust Authority**: Multi-cloud, multi-TEE attestation service; V2 composite policies (attest VM + GPU simultaneously)
- Cloud adoption: Google Cloud Confidential VMs with TDX, Azure Confidential Computing
- Challenges: side-channel mitigation, attestation standardization, developer accessibility

**Adoption Level**: GROWING. Major cloud providers support. Enterprise adoption accelerating.

**PCC Mapping**: Confidential computing enables a powerful PCC feature: verifiable computation. If PCC's verifier runs in a TDX-protected VM, the verification result has hardware-backed integrity — a verifier can't be compromised to approve bad evidence. Intel Trust Authority's composite attestation (VM + GPU) could attest both the PCC gateway and any GPU-accelerated verification. This is the path to trustless verification in PCC — not just cryptographic, but hardware-attested.

---

### 9.4 Content-Addressed Storage (IPFS/CID)

| Field | Detail |
|-------|--------|
| **Standard Name** | IPFS Content Identifiers (CIDs) / Multihash |
| **Governing Body** | IPFS Project (Protocol Labs), Multiformats project |
| **Current Version** | CIDv1 (multibase + multicodec + multihash) |
| **Spec** | https://docs.ipfs.tech/concepts/content-addressing/ |

**Key Features**:
- Content-addressed: CID derived from cryptographic hash of content
- Tamper-evident: any content change produces different CID
- Location-independent: address by what, not where
- CIDv1 encodes hash algorithm + hash value (self-describing)
- Blockchain anchoring: store CID on-chain for immutable proof of existence
- 98.7% integrity rate in blockchain-anchored IPFS systems (2025 research)
- Ecosystem: Filecoin (incentivized storage), Helia (JS implementation), Storacha (w3up)

**Adoption Level**: HIGH. Filecoin, NFT metadata, academic records, supply chain evidence.

**PCC Mapping**: PCC already implements content-addressed storage:
- `packages/kernel/src/evidence-storage.ts`: IPFS evidence via Helia
- Storacha (w3up) as production storage backend
- SHA-256 content addressing for all evidence bundles (Invariant #2)
- CIDs stored in evidence records, resolvable on w3s.link
The gap is formally leveraging blockchain anchoring — PCC should anchor evidence CIDs on-chain (Starknet ProofRegistry is already wired) to create non-repudiable proof of evidence existence at a specific time.

---

### 9.5 Summary: Evidence & Attestation

| Standard | Maturity | PCC Relevance | Action |
|----------|----------|--------------|--------|
| RATS RFC 9334 | Standard | HIGH | Map PCC evidence flow to RATS roles |
| TPM 2.0 | Mature | MEDIUM (long-term) | Platform attestation for Tier 3 kernels |
| Intel SGX/TDX | Growing | MEDIUM (long-term) | Confidential computing for verifiers |
| IPFS/CID | Production | ALREADY IMPLEMENTED | Strengthen on-chain CID anchoring |

---

## 10. Workflow Orchestration

### 10.1 BPMN 2.0

| Field | Detail |
|-------|--------|
| **Standard Name** | Business Process Model and Notation 2.0 |
| **Governing Body** | OMG (Object Management Group) |
| **Current Version** | BPMN 2.0.2 (January 2014); ISO/IEC 19510:2013 |
| **Spec URL** | https://www.omg.org/spec/BPMN/2.0.2/ |

**Key Features**:
- Flowchart-like notation for business process modeling
- Formalized execution semantics (v2.0+)
- Event composition, correlation, choreography
- Human interaction definitions
- Extensibility mechanisms for domain-specific additions
- Implementations: Camunda, jBPM, Activiti, Bonita
- Broadly understood by business analysts AND developers

**Adoption Level**: VERY HIGH. The standard for business process modeling. Millions of BPMN diagrams in production.

**PCC Mapping**: BPMN 2.0 provides a standard visual representation for PCC workflows. PCC's workflow compiler currently produces DAGs — these could be imported/exported as BPMN diagrams for enterprise customers who model processes in BPMN tools. The BPMN choreography model maps to PCC's multi-agent coordination (agent conversations). PCC should support BPMN 2.0 import/export as an enterprise integration feature, converting BPMN process definitions into PCC capability workflows.

---

### 10.2 Temporal.io

| Field | Detail |
|-------|--------|
| **Framework** | Temporal.io |
| **Category** | Durable Execution Engine |
| **Docs** | https://docs.temporal.io |

**Key Features**:
- Durable, reliable, scalable workflow execution
- Code-first approach: workflows are code, not DSL/DAG/XML
- Saga pattern: compensating transactions for distributed rollback
- Automatic retry with configurable policies
- State machines simplified — state is implicit in code position
- AI agent orchestration support (2025): maintain state over long periods, human intervention
- Resume from failure at exact code position (not from checkpoint — from statement)
- SDKs: Go, Java, Python, TypeScript, .NET

**Adoption Level**: HIGH. Netflix, Snap, Stripe, Datadog, HashiCorp use in production.

**PCC Mapping**: Temporal is the strongest candidate for PCC's workflow execution runtime. PCC's compiled DAGs could execute as Temporal workflows with durable execution guarantees. Key advantages:
- **Saga pattern** = PCC's settlement rollback (if evidence fails, compensate by releasing escrow)
- **Long-running workflows** = PCC jobs that span hours/days (CNC machining, multi-step lab protocols)
- **Human-in-the-loop** = PCC's operator escalation pattern
- **TypeScript SDK** = Native fit for PCC's Node.js stack
The gap: PCC currently executes workflows synchronously or via queue. Temporal would add production-grade durability, retry, and saga compensation.

---

### 10.3 Apache Airflow

| Field | Detail |
|-------|--------|
| **Framework** | Apache Airflow |
| **Governing Body** | Apache Software Foundation |
| **Current Version** | 2.x (regularly updated) |
| **Docs** | https://airflow.apache.org |

**Key Features**:
- DAG-based workflow orchestration (define DAGs in Python)
- Scheduler: cron expressions, timetables, dataset triggers
- Kubernetes integration: KubernetesExecutor (pod-per-task), KubernetesPodOperator
- Rich UI: DAG visualization, task logs, run history
- 1000+ operators/hooks for integrations
- Batch-oriented: not ideal for real-time/streaming
- Orchestration layer, not data processor — coordinates across systems

**Adoption Level**: VERY HIGH. De facto for data engineering pipelines. Used by Airbnb, Slack, Square, and thousands of companies.

**PCC Mapping**: Airflow's DAG model directly maps to PCC's workflow compiler. However, Airflow is batch-oriented while PCC needs real-time coordination. Airflow could serve as the scheduling layer for recurring capability workflows (daily HPLC runs, weekly calibration sequences) while Temporal handles the execution. The Kubernetes integration pattern is relevant for PCC's deployment: each job step as an isolated pod. PCC should not adopt Airflow wholesale but can borrow the DAG visualization and scheduling patterns.

---

### 10.4 Kubernetes Job/CronJob Patterns

| Field | Detail |
|-------|--------|
| **Platform** | Kubernetes |
| **Resources** | Job (one-off), CronJob (scheduled), custom controllers |
| **Docs** | https://kubernetes.io/docs/concepts/workloads/controllers/job/ |

**Key Features**:
- **Job**: Run-to-completion workload with retry policies
- **CronJob**: Scheduled jobs with cron syntax
- **Pod isolation**: Each task runs in its own container
- **Resource limits**: CPU/memory quotas per pod
- **Parallelism**: configurable concurrent pods
- **Deadline**: activeDeadlineSeconds for timeout
- Custom controllers (Argo Workflows, Tekton) add DAG execution on top

**Adoption Level**: VERY HIGH. Standard for containerized workloads.

**PCC Mapping**: PCC's gateway and worker processes should deploy as Kubernetes workloads. Each PCC job step could be a Kubernetes Job with resource isolation, retry policies, and deadlines. CronJobs for recurring maintenance (calibration checks, evidence archival, reward epoch processing). Argo Workflows could be an alternative to Temporal for DAG execution on Kubernetes. The pod-per-task isolation model maps to PCC's execution scope: each scope gets an isolated execution environment.

---

### 10.5 Summary: Workflow Orchestration

| Pattern | Maturity | PCC Relevance | Action |
|---------|----------|--------------|--------|
| BPMN 2.0.2 | Dominant | MEDIUM | Support import/export for enterprise |
| Temporal.io | Production | VERY HIGH | Adopt for durable workflow execution |
| Apache Airflow | Dominant | MEDIUM | Borrow DAG visualization + scheduling |
| K8s Job/CronJob | Dominant | HIGH | Deploy jobs as isolated pods |

---

## 11. PCC Alignment Matrix

### Current Standards Integration Status

| Standard | PCC Component | Status |
|----------|--------------|--------|
| MCP | packages/mcp-server (56 tools) | LIVE |
| A2A Protocol | packages/a2a (34 intents) | IMPLEMENTED |
| W3C DIDs | packages/spec/src/identity/ | IMPLEMENTED |
| W3C VCs | packages/spec/src/identity/ | IMPLEMENTED |
| ERC-8004 | packages/identity-8004 | IMPLEMENTED |
| OPC-UA | packages/kernel (adapter) | IMPLEMENTED |
| SiLA 2.0 | packages/kernel (adapter) | IMPLEMENTED |
| IPFS/CID | packages/kernel/evidence-storage.ts | LIVE |
| Modbus | packages/kernel (adapter) | IMPLEMENTED |
| PackML | NOT INTEGRATED | Gap |
| ISA-95 | NOT INTEGRATED | Gap |
| MTConnect | NOT INTEGRATED | Gap |
| Sparkplug B | NOT INTEGRATED | Gap |
| EPCIS 2.0 | NOT INTEGRATED | Gap |
| RATS RFC 9334 | NOT INTEGRATED | Gap (conceptually aligned) |
| Temporal.io | NOT INTEGRATED | Gap |
| BPMN 2.0 | NOT INTEGRATED | Gap |

### Priority Recommendations (by impact)

**Tier 1 — High Impact, Aligned with Current Architecture**:
1. Publish A2A AgentCard at `.well-known/agent-card.json` — immediate ecosystem discoverability
2. Validate agent-package.json for OpenAI strict-mode compatibility — wider agent adoption
3. Adopt PackML state machine for equipment job lifecycle — instant compatibility with industrial equipment
4. Map evidence flow to RATS RFC 9334 terminology — legitimacy with hardware security community
5. Add TRQP (Trust Registry Query Protocol) to capability registry — external trust queries

**Tier 2 — Medium Impact, Strategic Value**:
6. Implement EPCIS 2.0 event schema for evidence export — enterprise supply chain interop
7. Add BPMN 2.0 import/export to workflow compiler — enterprise workflow modeling
8. Evaluate Temporal.io for durable workflow execution — production-grade job reliability
9. Implement Sparkplug B topic structure for MQTT sensor streaming — IIoT field deployments
10. Align ISA-95 terminology in API and documentation — speak manufacturing language

**Tier 3 — Future Strategic, Regulatory**:
11. DPP (Digital Product Passport) generation from evidence — EU market access
12. ISO 17025 compliance mode for lab capabilities — lab accreditation support
13. NIST 800-171 self-assessment — defense manufacturing customers
14. 21 CFR Part 11 compliance documentation — pharma/biotech customers
15. Combinatorial auction mechanism for multi-capability workflows — pricing efficiency

### Standards Convergence Pattern

PCC sits at the intersection of multiple standards domains. The key insight: PCC doesn't need to implement every standard natively. Instead, PCC should:

1. **Native core**: MCP, A2A, W3C DID/VC, ERC-8004, IPFS/CID, RATS
2. **Adapter layer**: OPC-UA, SiLA, Modbus, MTConnect, Sparkplug B (equipment-facing)
3. **Export layer**: EPCIS, BPMN, EDI X12, DPP (customer-facing)
4. **Compliance mapping**: ISO 9001/13485/17025, 21 CFR Part 11, NIST 800-171, AS9100, IATF 16949, GxP (documentation, not code)

This three-layer approach (native + adapter + export) keeps PCC's core lean while enabling broad ecosystem integration.

---

*Research completed 2026-04-02. Sources from W3C, ISO, IEC, IEEE, IETF, OMG, GS1, ISA, OPC Foundation, Eclipse Foundation, Linux Foundation, Google, Anthropic, OpenAI, NIST, FDA, and primary project documentation.*
