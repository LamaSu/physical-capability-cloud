# Agent Harness Patterns, Safety Rails, and Operational Standards for Multi-Agent Physical Infrastructure Control

**Research Date**: 2026-04-02
**Scope**: Standards, frameworks, and patterns for multi-agent systems that control physical infrastructure
**Application Context**: Physical Capability Cloud (PCC) — remote orchestration of physical equipment via AI agents

---

## Table of Contents

1. [Agent Operational Envelopes](#1-agent-operational-envelopes)
2. [Multi-Agent Coordination Patterns](#2-multi-agent-coordination-patterns)
3. [Physical Safety Standards for Remote Equipment Control](#3-physical-safety-standards-for-remote-equipment-control)
4. [Observability and Audit for Agent Systems](#4-observability-and-audit-for-agent-systems)
5. [Agent Identity and Authentication](#5-agent-identity-and-authentication)
6. [PCC Integration Recommendations](#6-pcc-integration-recommendations)

---

## 1. Agent Operational Envelopes

An "operational envelope" defines the complete boundary of what an agent CAN and CANNOT do — its permissions, capabilities, autonomy limits, and safety constraints. This section covers the six major frameworks that define these boundaries.

### 1.1 OWASP Top 10 for LLM Applications (2025)

**Source**: https://genai.owasp.org/resource/owasp-top-10-for-llm-applications-2025/

The 2025 update significantly expanded coverage of agent-specific risks. The key risk for PCC is **Excessive Agency**, decomposed into three root causes:

| Root Cause | Description | PCC Relevance |
|------------|-------------|---------------|
| **Excessive Functionality** | Agents can reach tools beyond their task scope | An operator agent should not access escrow settlement tools |
| **Excessive Permissions** | Tools operate with broader privileges than necessary | A verification agent should not have write access to job state |
| **Excessive Autonomy** | High-impact actions proceed without human-in-the-loop | Physical equipment commands must require approval gates |

**Mitigation prescription**: Restrict agent permissions to exactly what each task requires. Require human approval for consequential actions. Implement strong identity and access controls. Run extensions in the user's security context rather than with generic high-privileged identities.

### 1.2 OWASP Top 10 for Agentic Applications (2026)

**Source**: https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/

This is the dedicated agentic security framework, distinct from the LLM Top 10. It addresses the far greater risks that come from autonomous action — agents accessing APIs, modifying databases, sending commands to physical equipment.

**Complete Risk List**:

| ID | Risk | Description | PCC Impact |
|----|------|-------------|------------|
| ASI01 | **Agent Goal Hijack** | Attackers alter agent objectives through malicious text, causing unintended actions like data exfiltration | CRITICAL — a hijacked agent could send dangerous commands to equipment |
| ASI02 | **Tool Misuse and Exploitation** | Agents misuse legitimate tools due to ambiguous prompts, leading to destructive parameter execution | CRITICAL — legitimate motion commands with wrong parameters can damage equipment |
| ASI03 | **Identity and Privilege Abuse** | Agents inherit user/system identities with high-privilege credentials, session tokens, delegated access | HIGH — agents must not inherit operator credentials wholesale |
| ASI04 | **Agentic Supply Chain Vulnerabilities** | Dynamically fetched tools/plugins become compromised, altering agent behavior | HIGH — MCP servers and tool registries are attack surface |
| ASI05 | **Unexpected Code Execution** | Agents generate or run code unsafely, including shell commands via prompt injection | CRITICAL — code execution near physical equipment is highest risk |
| ASI06 | **Memory and Context Poisoning** | Attackers poison memory/RAG to influence future agent decisions | MEDIUM — long-lived agent memory could be poisoned to affect equipment scheduling |
| ASI07 | **Insecure Inter-Agent Communication** | Multi-agent messages lack auth/encryption, enabling interception and injection | HIGH — agent-to-agent messages in PCC carry physical commands |
| ASI08 | **Cascading Failures** | Errors in one agent propagate across planning, execution, and downstream systems | CRITICAL — a failed verification agent must not cascade to release unsafe escrow |
| ASI09 | **Human-Agent Trust Exploitation** | Users over-trust agent recommendations, accepting dangerous suggestions | MEDIUM — operators must maintain skepticism of agent-suggested actions |
| ASI10 | **Rogue Agents** | Compromised or misaligned agents act harmfully while appearing legitimate | CRITICAL — a rogue agent with equipment access is a physical safety hazard |

**Key design principle introduced**: **Least Agency** — only grant agents the minimum autonomy required to perform safe, bounded tasks.

**Industry adoption**: Microsoft's agentic failure modes, NVIDIA's Safety and Security Framework, and AWS all now reference this framework.

### 1.3 Anthropic's Constitutional AI and Tool Use Safety

**Sources**:
- https://www.anthropic.com/research/constitutional-ai-harmlessness-from-ai-feedback
- https://www.anthropic.com/research/next-generation-constitutional-classifiers
- https://www.anthropic.com/activating-asl3-report

**Constitutional AI (CAI)** gives an AI system a set of principles (a "constitution") against which it evaluates its own outputs. Key elements:

- **Self-critique loop**: Model generates output, critiques it against 70+ ethical principles (drawn from UN Declaration of Human Rights and trust/safety frameworks), revises
- **Constitutional Classifiers**: Input/output monitors trained on synthetic data from natural-language rules specifying allowed/forbidden content. Reduces jailbreak success to 4.4%
- **ASL-3 Deployment Standard**: For enhanced-capability models (e.g., those with advanced tool use), requires red-teaming of deployment measures, real-time classifiers, and bug bounties

**Relevant patterns for PCC**:

| Pattern | Description | Application |
|---------|-------------|-------------|
| **Constitutional constraints** | Hard rules the agent cannot violate regardless of instructions | "Never send motion commands exceeding safe velocity limits" |
| **Classifier pre-screening** | Lightweight models screen inputs before the main agent processes them | Screen all tool invocations for dangerous parameter ranges |
| **Layered defense** | Input validation + output sanitization at every boundary | Every agent-to-equipment message validated at send AND receive |
| **Graduated autonomy (ASL levels)** | Higher capability = stricter safety requirements | Physical control agents get stricter oversight than data agents |

### 1.4 OpenAI Function Calling Strict Mode and Guardrails

**Sources**:
- https://platform.openai.com/docs/guides/function-calling
- https://openai.github.io/openai-agents-python/guardrails/

**Strict Mode** ensures function calls reliably adhere to the function schema (not best-effort). Under the hood it uses structured outputs and requires `additionalProperties: false` on every object in parameters. This is critical for physical systems where malformed parameters can cause damage.

**Guardrail Architecture**:

```
                    ┌─────────────────────┐
                    │    Input Guardrails  │ ← Run on user's initial input
                    │  (PII redaction,     │    (parallel with agent exec)
                    │   jailbreak detect,  │
                    │   keyword filter)    │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Agent Execution    │
                    │  (tool calls, etc.)  │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Tool Guardrails   │ ← Per-tool output validation
                    │  (reject_content or │    (block_on_tool_violations
                    │   block execution)  │     halts immediately)
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Output Guardrails  │ ← Run on agent's final response
                    │  (safety classify,  │
                    │   blocklist enforce) │
                    └─────────────────────┘
```

**Key design**: Guardrails run in parallel with agent execution and fail fast when checks fail. Two modes:
- `reject_content`: Block the violative tool call but let agent continue
- `block_on_tool_violations=True`: Halt execution immediately

**PCC application**: Physical command guardrails should ALWAYS use `block_on_tool_violations=True`. Never let a physical command fail softly.

### 1.5 Google DeepMind Frontier Safety Framework (v3.0)

**Sources**:
- https://deepmind.google/blog/strengthening-our-frontier-safety-framework/
- https://storage.googleapis.com/deepmind-media/DeepMind.com/Blog/evaluating-potential-cybersecurity-threats-of-advanced-ai/An_Approach_to_Technical_AGI_Safety_Apr_2025.pdf

**FSF v3.0** (September 2025) introduces:

| Concept | Description | PCC Application |
|---------|-------------|-----------------|
| **Critical Capability Levels** | Tiered assessment of model capabilities tied to risk | Map agent capability tiers to equipment access levels |
| **Manipulation detection** | Expanded to cover models that may influence human beliefs at scale | Detect agents that try to convince operators to bypass safety |
| **Shutdown resistance** | Scenarios where models resist human shutdown/control | Equipment agents MUST honor e-stop commands unconditionally |
| **Amplified oversight** | Use AI capabilities themselves for oversight | Use a monitor agent to watch equipment-control agents |
| **Robust training + monitoring** | System-level security: monitoring, access control | All agent actions to equipment logged and monitored |

**Scalable oversight approach**: For sufficiently powerful AI systems, DeepMind leverages AI capabilities for oversight — building aligned models through amplified oversight and robust training, complemented by system-level monitoring and access control.

### 1.6 NIST AI 100-1 (AI Risk Management Framework)

**Source**: https://nvlpubs.nist.gov/nistpubs/ai/nist.ai.100-1.pdf

Voluntary, technology-agnostic framework. Four core functions:

| Function | Purpose | PCC Implementation |
|----------|---------|-------------------|
| **GOVERN** | Establish accountability, oversight structures | Define who owns agent safety decisions, escalation paths |
| **MAP** | Identify risks in context of use | Map each agent role to its physical risk profile |
| **MEASURE** | Quantify and track risks | Metrics: command rejection rate, safety-stop frequency, latency to human override |
| **MANAGE** | Mitigate and monitor risks | Runbooks for agent failures, automatic fallback procedures |

**Gap noted**: Released 2023, does not explicitly cover agentic systems (planning, self-correction, multi-step actions). Organizations must extend for agents capable of tool use and autonomous planning. The NIST Playbook and companion profiles (2024-2025) partially address this.

### 1.7 EU AI Act — Autonomous Agent Compliance

**Sources**:
- https://artificialintelligenceact.eu/article/16/
- https://trilateralresearch.com/responsible-ai/eu-ai-act-implementation-timeline-mapping-your-models-to-the-risk-tiers

**Classification**: AI systems controlling critical infrastructure are **high-risk** under the EU AI Act. This includes:
- Physical infrastructure management
- Safety components of machinery
- Remote equipment control systems

**Timeline**:
- **August 2, 2025**: Governance infrastructure must be operational
- **August 2, 2026**: Full requirements for high-risk systems take effect (risk management, data governance, technical documentation, record-keeping, transparency, human oversight, accuracy, robustness, cybersecurity)
- **August 2, 2027**: Extended deadline for certain existing systems

**Mandatory requirements for high-risk AI** (Article 16 obligations):

| Requirement | Description |
|-------------|-------------|
| Risk management system | Continuous, iterative process throughout AI lifecycle |
| Data governance | Training data quality, bias detection, representativeness |
| Technical documentation | Before placing on market, sufficient for conformity assessment |
| Record-keeping | Automatic logging of events during operation |
| Transparency | Users informed the system is AI, understand capabilities and limitations |
| Human oversight | Designed to allow effective human oversight during use |
| Accuracy, robustness, cybersecurity | Appropriate levels for intended purpose |
| Conformity assessment | CE marking required, third-party assessment for certain categories |

**Penalties**: Up to EUR 15 million or 3% of global annual turnover for non-compliance.

### 1.8 ISO/IEC 42001 (AI Management Systems)

**Source**: https://www.iso.org/standard/42001

First international standard for an AI Management System (AIMS), published December 2023. Uses Plan-Do-Check-Act methodology.

**Key requirements**:
- Policies and procedures for AI governance
- Risk assessment specific to AI (probabilistic outputs, training data governance, explainability)
- Continuous improvement cycle
- Third-party certification available (DNV, BSI, ANAB)

**PCC relevance**: Certification to ISO 42001 would demonstrate AI governance maturity to enterprise customers using PCC for physical operations.

---

## 2. Multi-Agent Coordination Patterns

### 2.1 FIPA Contract Net Protocol (IEEE)

**Source**: https://en.wikipedia.org/wiki/Contract_Net_Protocol

Originally introduced by Reid G. Smith (1980), standardized by FIPA (now IEEE). The fundamental task allocation protocol for multi-agent systems.

**Protocol flow**:

```
Manager                          Contractors (N agents)
   │                                    │
   ├──── Call-For-Proposals (CFP) ─────>│
   │     (task description, deadline)   │
   │                                    │
   │<─── Propose / Refuse ─────────────┤
   │     (bid with cost/capability)     │
   │                                    │
   ├──── Accept / Reject ─────────────>│
   │     (select best proposal)         │
   │                                    │
   │<─── Inform-Done / Failure ────────┤
   │     (result or failure report)     │
   └────────────────────────────────────┘
```

**PCC application**: Job allocation to operators. The PCC gateway acts as Manager, operators as Contractors. Operators submit bids (availability, capability, price). Gateway selects based on reputation, proximity, and capability match.

**Strengths**: Decentralized, fault-tolerant (can re-auction on failure), time-limited contracts
**Weaknesses**: Communication overhead with many contractors, no complex negotiation

### 2.2 Blackboard Architecture

**Sources**:
- https://en.wikipedia.org/wiki/Blackboard_system
- https://medium.com/@dp2580/building-intelligent-multi-agent-systems-with-mcps-and-the-blackboard-pattern

**Core concept**: A shared knowledge base ("blackboard") that specialist agents ("knowledge sources") read from and write to. A control component decides which agent acts next based on blackboard state.

**Architecture**:

```
┌─────────────────────────────────────────────┐
│                 BLACKBOARD                   │
│  (shared state: job status, equipment       │
│   state, verification results, escrow)      │
├─────────────────────────────────────────────┤
│              CONTROL COMPONENT               │
│  (decides which knowledge source acts next) │
├─────────┬────────┬────────┬─────────────────┤
│  Agent  │  Agent │  Agent │  Agent          │
│ Verify  │ Escrow │ Sched  │ Equipment       │
│ Source  │ Source │ Source │  Source          │
└─────────┴────────┴────────┴─────────────────┘
```

**Key property**: **Opportunistic reasoning** — agents don't follow a predetermined sequence. They respond dynamically to evolving problem state. This is especially useful for PCC where job state changes unpredictably (equipment failure, operator unavailability, verification failure).

**Modern implementation**: LbMAS (LLM-based Multi-Agent System) uses a shared blackboard to coordinate diverse LLM agents with a control unit for real-time agent selection and iterative consensus.

**PCC application**: The job lifecycle is a natural blackboard problem. Multiple specialist agents (discovery, negotiation, escrow, execution, verification, settlement) each contribute partial solutions. The blackboard holds the canonical job state.

### 2.3 Market-Based Task Allocation (MURDOCH / TraderBots)

**Sources**:
- https://www.ri.cmu.edu/publications/traderbots-a-market-based-approach-for-resource-role-and-task-allocation-in-multirobot-coordination/
- https://link.springer.com/article/10.1007/s10846-022-01803-0

**MURDOCH**: Uses first-price auctions where robots submit bids for offered tasks. Allows renegotiation (selling tasks to other robots). Time-limited contracts provide fault tolerance.

**TraderBots** (CMU Robotics Institute): Inherently distributed market architecture with:
- Multiple trading agents (one per robot, plus operators, sensors, computers)
- Each trader reasons about tasks and resources for rational negotiation
- Task descriptions generalized into **task trees** allowing variable-abstraction trading
- Robust to robot/agent failure, quick response to dynamic conditions
- Handles online addition/subtraction of robots and tasks

**PCC application**: This is essentially what PCC already does with capability discovery and job negotiation. The task tree concept maps directly to PCC's job decomposition (capability → sub-tasks → individual operations).

### 2.4 Stigmergic Coordination

**Sources**:
- https://en.wikipedia.org/wiki/Stigmergy
- https://medium.com/@jsmith0475/collective-stigmergic-optimization-leveraging-ant-colony-emergent-properties-for-multi-agent-ai-55fa5e80456a

**Core idea**: Agents coordinate not by communicating with each other, but by modifying a shared environment that other agents respond to. Coined by Pierre-Paul Grasse (1959) studying termite nest construction.

**Digital pheromone mechanics**:
1. Agent completes a task and leaves a "trace" in shared state (reinforcement signal)
2. Other agents encountering the trace are probabilistically more likely to follow/extend it
3. Traces that lead to good outcomes get reinforced; traces to bad outcomes decay (natural evaporation)
4. System converges on optimal paths without any agent computing the optimal path

**Properties**:
- Scalable: No central coordinator
- Asynchronous: Agents act independently
- Resilient: Communication failures don't break coordination
- Emergent optimization: System-level intelligence from simple local rules

**PCC application**: Operator reputation and job routing. Successful job completions leave "pheromone traces" (reputation scores, completion rates). Future job routing is probabilistically influenced by these traces. Bad operators' traces decay. System converges on reliable operator networks without explicit central scheduling.

### 2.5 Byzantine Fault Tolerance for Agent Consensus

**Sources**:
- https://www.scs.stanford.edu/20sp-cs244b/projects/Multi-Agent%20Consensus%20for%20Decision%20Making.pdf
- https://www.mdpi.com/2079-9292/12/18/3801

**Problem**: In a multi-agent system controlling physical equipment, some agents may be compromised, faulty, or malicious (Byzantine). The system must reach correct consensus despite up to f faulty agents out of n total (requires n >= 3f + 1).

**PBFT protocol** (Practical Byzantine Fault Tolerance):

```
Phase 1: PRE-PREPARE  → Leader proposes action
Phase 2: PREPARE      → All agents broadcast agreement
Phase 3: COMMIT       → After 2f+1 matching PREPAREs, broadcast commit
Result:  EXECUTE      → After 2f+1 matching COMMITs, execute action
```

**Communication cost**: O(n^2) for standard PBFT, reduced to O(n) with hierarchical variants (SDMA-PBFT).

**PCC application**: Verification consensus. Multiple verifier agents must agree that physical work was completed before escrow is released. BFT ensures that even if some verifiers are compromised or faulty, the consensus is correct. PCC already uses a multi-verifier architecture — formalizing it as BFT would provide provable safety guarantees.

### 2.6 RBAC for Agent Permissions

**Sources**:
- https://medium.com/@christopher_79834/ai-agent-rbac-essential-security-framework-for-enterprise-ai-deployment-d9d1d4711183
- https://www.osohq.com/learn/why-rbac-is-not-enough-for-ai-agents

**Core principle**: Each agent is assigned a role that defines its permissions. Only 52% of enterprises can currently track and audit all data accessed by AI agents.

**Two-layer RBAC for agents**:
1. **Role layer**: Defines which tools/capabilities the agent can access
2. **Permission layer**: Fine-grained control over specific features within each tool

**Separation of Duties (SoD)**:

| Type | Description | PCC Example |
|------|-------------|-------------|
| **Static SoD (SSD)** | Prevents assignment of incompatible roles | Same agent cannot be both job executor AND job verifier |
| **Dynamic SoD (DSD)** | Allows conflicting roles but prevents simultaneous activation | Agent can have escrow-write and verification-write roles but cannot use both in same session |

**Why RBAC alone is not enough for AI agents**:
- Agents generate thousands of API calls per minute — a misconfigured permission at this velocity causes rapid damage
- Agents exhibit emergent behaviors not anticipated by role definitions
- Need complementary controls: rate limiting, output validation, anomaly detection

**PCC agent roles** (recommended):

| Role | Allowed Actions | Forbidden Actions |
|------|----------------|-------------------|
| discovery-agent | read capability registry, read operator profiles | write anything, execute commands |
| negotiation-agent | read/write job proposals, read pricing | execute physical commands, access escrow |
| escrow-agent | read/write escrow state, interact with smart contracts | send physical commands, modify verification |
| execution-agent | send equipment commands (within envelope), read job spec | modify escrow, write verification |
| verification-agent | read evidence, write verification results | modify job spec, send equipment commands, write escrow |
| settlement-agent | read verification, trigger escrow release | send equipment commands, modify verification results |

### 2.7 Segregation of Duties in Agent Swarms

The fundamental principle: **No single agent should control the entire lifecycle of a physical job.** Decompose into at minimum:

```
Discovery → Negotiation → Escrow → Execution → Verification → Settlement
    │            │           │          │            │             │
    └── All different agents with non-overlapping write permissions ──┘
```

This prevents a compromised agent from both executing work AND verifying its own work AND releasing its own payment. Each stage has an independent agent with narrowly scoped permissions.

---

## 3. Physical Safety Standards for Remote Equipment Control

### 3.1 IEC 61508 (Functional Safety)

**Source**: https://en.wikipedia.org/wiki/IEC_61508

The parent standard for functional safety of Electrical/Electronic/Programmable Electronic (E/E/PE) safety-related systems. All other safety standards in this section derive from or reference IEC 61508.

**Safety Integrity Levels (SIL)**:

| SIL | Probability of Dangerous Failure (per hour, continuous) | Risk Reduction Factor | Typical Application |
|-----|--------------------------------------------------------|----------------------|---------------------|
| SIL 1 | >= 10^-6 to < 10^-5 | 10-100x | Low-consequence monitoring |
| SIL 2 | >= 10^-7 to < 10^-6 | 100-1000x | Process industry safety |
| SIL 3 | >= 10^-8 to < 10^-7 | 1000-10000x | Machinery safety, rail |
| SIL 4 | >= 10^-9 to < 10^-8 | 10000-100000x | Nuclear, aviation |

**Determining SIL**: Conduct risk assessment examining:
1. Systematic Capability (design and development quality)
2. Architecture Constraints (hardware fault tolerance)
3. Probability of Dangerous Failure (quantitative reliability)

**PCC implications**: Remote equipment control via AI agents is a novel safety case. The agent software layer must be assessed as part of the safety function. Key requirements:
- Appropriate quality control and management processes
- Validation and verification techniques proportional to SIL
- Failure analysis (FMEA, fault trees) covering agent failure modes
- Independent verification of safety claims

**Recommended SIL for PCC**:
- Equipment motion commands: **SIL 2** minimum (agent + safety governor + e-stop)
- Emergency stop function: **SIL 3** (must be independent of agent system)
- Monitoring/observation only: **SIL 1** sufficient

### 3.2 IEC 62443 (Industrial Cybersecurity)

**Sources**:
- https://www.dragos.com/blog/isa-iec-62443-concepts
- https://www.fortinet.com/resources/cyberglossary/iec-62443

The standard for cybersecurity in Industrial Automation and Control Systems (IACS). Directly applicable to PCC as a system that automates physical equipment control.

**Zones and Conduits model**:

```
┌───────────────────────────────────────────┐
│  ZONE: Enterprise Network (SL-1)          │
│  ┌─────────────┐   ┌─────────────────┐   │
│  │ PCC Web App  │   │ Payment Gateway │   │
│  └──────┬───────┘   └────────┬────────┘   │
│         │                    │             │
├─────────┼── CONDUIT (firewall, IDS) ──┼───┤
│         │                    │             │
│  ZONE: Agent Network (SL-2)               │
│  ┌──────────┐  ┌──────────┐  ┌─────────┐  │
│  │Discovery │  │Negotiate │  │Verify   │  │
│  │Agent     │  │Agent     │  │Agent    │  │
│  └────┬─────┘  └────┬─────┘  └────┬────┘  │
│       │              │             │        │
├───────┼── CONDUIT (mTLS, rate-limit) ──┼──┤
│       │              │             │        │
│  ZONE: Equipment Control (SL-3)            │
│  ┌──────────────┐  ┌───────────────────┐   │
│  │Safety Governor│  │Equipment Gateway │   │
│  └──────┬────────┘  └───────┬──────────┘   │
│         │                   │              │
├─────────┼── CONDUIT (hardware e-stop) ─┼──┤
│         │                   │              │
│  ZONE: Physical Equipment (SL-3)           │
│  ┌──────────┐  ┌──────────┐                │
│  │ Robot    │  │ Printer  │                │
│  │ Arm      │  │ /CNC     │                │
│  └──────────┘  └──────────┘                │
└───────────────────────────────────────────┘
```

**Security Levels** (analogous to SIL):

| SL | Protection Against | PCC Zone |
|----|--------------------|----------|
| SL-1 | Unintentional misuse | Enterprise network |
| SL-2 | Intentional misuse, simple means | Agent network |
| SL-3 | Sophisticated attacks, moderate resources | Equipment control |
| SL-4 | State-sponsored, extensive resources | N/A for most PCC deployments |

**Seven Foundational Requirements**:
1. **Identification and Authentication Control** — every agent and device must be uniquely identified
2. **Use Control** — enforce permissions per zone
3. **System Integrity** — detect unauthorized changes
4. **Data Confidentiality** — encrypt agent-to-equipment communications
5. **Restricted Data Flow** — conduits control all cross-zone traffic
6. **Timely Response to Events** — alerts within defined SLA
7. **Resource Availability** — equipment control zone must maintain availability

### 3.3 ISO 10218 / ISO 15066 (Robot Safety) — 2025 Revision

**Sources**:
- https://www.iso.org/standard/73933.html
- https://blog.ansi.org/ansi/iso-10218-1-2025-robots-and-robotic-devices-safety/

**Major 2025 changes**:
- ISO/TS 15066 (collaborative robot safety) has been **integrated into ISO 10218-2:2025** — no longer a separate document
- New **cybersecurity requirements** pertaining to robot safety (first time)
- Term "collaborative robot" replaced with **"collaborative application"** — the application is what's validated as safe, not the robot itself
- Clarified functional safety requirements

**Two parts**:
- **ISO 10218-1:2025**: Requirements for manufacturers of industrial robots (design, build, safety functions)
- **ISO 10218-2:2025**: Requirements for integrators of robot applications and robot cells (installation, safeguarding, validation)

**PCC implications**: PCC is an integrator (ISO 10218-2). Every robot cell accessible through PCC must have:
- Documented risk assessment
- Safeguarding measures (physical guards, safety-rated monitoring)
- Emergency stop accessible to both local operator AND remote system
- Cybersecurity measures for the robot control interface

### 3.4 ANSI/A3 R15.06-2025 (US National Adoption)

**Source**: https://blog.ansi.org/ansi/ansi-a3-r15-06-2025-robot-safety/

US national adoption of ISO 10218-1:2025 and ISO 10218-2:2025. Replaces ANSI/RIA R15.06-2012.

**Risk assessment requirements**:
1. Set use limits for robot system
2. Task/hazard identification for ALL phases of operation
3. Initial risk estimation
4. Risk reduction determination
5. Implement risk reduction measures
6. Verification of risk reduction
7. Document everything

**Critical for PCC**: The risk assessment must cover remote operation as a specific use phase. This is not a standard factory floor scenario — the operator may be miles away, commanding through an AI agent layer.

### 3.5 Emergency Stop Standards (IEC 60204-1, ISO 13850)

**Sources**:
- https://www.unitecd.com/emergency-stop-circuit-testing-procedure-functional-verification-response-time-measurement-and-documentation-for-industrial-machinery/
- https://www.airpf.com/can-you-use-e-stop-lockout-devices-in-lockout-procedures/

**Critical distinction**: Emergency stops and energy isolation (LOTO) are DIFFERENT:

| Function | Standard | Purpose | Method |
|----------|----------|---------|--------|
| **Emergency Stop** | IEC 60204-1, ISO 13850 | Stop dangerous motion immediately | Software/hardware interrupt, removes power from actuators |
| **Energy Isolation (LOTO)** | OSHA 1910.147 | Prevent restart during maintenance | Physical lockout of energy sources (electrical, pneumatic, hydraulic) |

**E-stops CANNOT be used for energy isolation** because they are not sufficiently reliable for that purpose. A device rated for isolation (IEC 60947-1) must be manually operated and lockable in the OFF state.

**Remote operations challenge**: E-stops are designed for single-location operation. For remote operations:
- Equipment MUST have a local physical e-stop (not software-controlled)
- Remote e-stop must be implemented as a **safety-rated communication channel** independent of the agent system
- The remote e-stop must work even if the agent system is completely compromised
- E-stop response time must be measured and documented

**PCC architecture requirement**: The emergency stop path must be **completely independent** of the agent software stack:

```
┌───────────────────────────────────────┐
│       AGENT SYSTEM (can fail)         │
│  ┌────────┐  ┌────────┐  ┌────────┐  │
│  │ Agent  │  │ Agent  │  │ Agent  │  │
│  └────────┘  └────────┘  └────────┘  │
└───────────────────────────────────────┘
         ↓ normal commands ↓
┌───────────────────────────────────────┐
│    SAFETY GOVERNOR (independent)       │
│  Validates all commands against        │
│  operational envelope before relay     │
└───────────┬───────────────────────────┘
            │
┌───────────▼───────────────────────────┐
│    EQUIPMENT + HARDWARE E-STOP         │
│  ┌─────────┐   ┌──────────────────┐   │
│  │ E-STOP  │   │ Safety PLC       │   │
│  │ Button  │   │ (SIL-3 rated)    │   │
│  │(local)  │   │ Monitors envelope│   │
│  └────┬────┘   └────────┬─────────┘   │
│       └────── OR gate ──┘             │
│       (either trigger stops equip)    │
└───────────────────────────────────────┘
```

### 3.6 LOTO for Remote Operations

**Source**: https://www.osha.gov/control-hazardous-energy

Lockout/Tagout (LOTO) is the physical isolation of hazardous energy during maintenance. OSHA 1910.147 requires:

1. **Preparation** — identify all energy sources
2. **Shutdown** — orderly shutdown of equipment
3. **Isolation** — physically disconnect from energy sources
4. **Lockout/Tagout** — apply locks and tags to isolation devices
5. **Stored energy release** — verify no residual energy
6. **Verification** — confirm equipment is de-energized

**Remote operations challenge**: LOTO inherently requires physical presence. For PCC:
- LOTO cannot be done remotely — it requires a human physically at the equipment
- PCC must have a **maintenance mode** that prevents any agent from sending commands while LOTO is in progress
- The LOTO state must be represented in the system as an **immutable hardware interlock** that agents cannot override
- Re-energization requires physical verification by the on-site person

### 3.7 Machinery Directive 2006/42/EC (being replaced by Regulation 2023/1230)

**Sources**:
- https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:02006L0042-20190726
- https://en.wikipedia.org/wiki/Machinery_Directive

Remote-controlled machinery must be equipped with:
- Devices for **stopping operation automatically and immediately**
- Devices for **preventing potentially dangerous operation**

The Directive has been **repealed by Regulation (EU) 2023/1230 on machinery**, which applies from **20 January 2027**. The new Regulation is directly applicable (no national transposition needed) and includes updated requirements for digital and remote-controlled machinery.

**PCC relevance**: Any equipment accessible through PCC that is deployed in the EU must comply with the new Machinery Regulation by January 2027. This includes AI-controlled equipment, which is explicitly in scope of the new regulation.

---

## 4. Observability and Audit for Agent Systems

### 4.1 OpenTelemetry for Agent Traces

**Sources**:
- https://opentelemetry.io/blog/2025/ai-agent-observability/
- https://github.com/traceloop/openllmetry
- https://glama.ai/blog/2025-11-29-open-telemetry-for-model-context-protocol-mcp-analytics-and-agent-observability

**Key concepts**:

A **trace** represents the entire end-to-end journey of a single agent session or request, composed of individual units of work called **spans**. For PCC, a trace would cover: job discovery → negotiation → escrow → execution → verification → settlement.

**Semantic conventions status** (as of 2025):
- **Finalized**: Agent application semantic conventions (based on Google's AI agent whitepaper)
- **Experimental**: GenAI model conventions (model name, token usage, etc.)
- **In development**: Agent framework conventions (for CrewAI, AutoGen, LangGraph, etc.)

**Two instrumentation approaches**:

| Approach | Description | Pros | Cons |
|----------|-------------|------|------|
| **Baked-in** | Framework embeds OTel directly | Simple adoption, immediate coverage | Dependency lock-in |
| **External** | Separate instrumentation libraries | Decoupled, community maintained | Risk of fragmentation |

**Recommended tooling**:
- **OpenLLMetry** (Traceloop): Custom OTel extensions for LLM calls, vector DBs — open source
- **OpenLIT**: One-line OTel instrumentation for AI stack (LLMs, vector DBs, GPUs)
- **OTel GenAI SIG**: CNCF working group driving convention development

**PCC implementation plan**:
1. Each agent span includes: agent_role, tool_called, action_class, target_equipment, safety_check_result
2. Physical command spans include: command_type, parameters, safety_governor_verdict, equipment_response
3. All spans propagate trace context (W3C Trace Context) across agent boundaries
4. Export to a backend that supports SIL-appropriate retention

### 4.2 W3C Trace Context

**Source**: https://www.w3.org/TR/trace-context/

Standard HTTP headers for propagating trace context across service boundaries.

**traceparent header format**:
```
traceparent: {version}-{trace-id}-{parent-id}-{trace-flags}
Example:     00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
```

| Field | Size | Purpose |
|-------|------|---------|
| version | 1 byte (2 hex chars) | Format version (currently "00") |
| trace-id | 16 bytes (32 hex chars) | Unique ID for entire distributed trace |
| parent-id | 8 bytes (16 hex chars) | ID of the parent span |
| trace-flags | 1 byte (2 hex chars) | Flags (bit 0 = sampled) |

**tracestate header**: Vendor-specific key-value pairs for additional context. Used to carry PCC-specific metadata (job_id, safety_level, equipment_zone) alongside the standard trace.

**PCC requirement**: Every agent-to-agent and agent-to-equipment message MUST carry W3C Trace Context headers. This enables:
- End-to-end trace reconstruction for any job
- Correlation of agent decisions with physical outcomes
- Forensic analysis when something goes wrong

### 4.3 SOC 2 Type II Audit Requirements

**Sources**:
- https://goteleport.com/blog/ai-agents-soc-2/
- https://www.schellman.com/blog/soc-examinations/how-to-incorporate-ai-into-your-soc-2-examination

SOC 2 Type II verifies that controls operate effectively **over time** (3-6 month observation period). Five Trust Services Criteria, each affected by AI agents:

| Criterion | Standard Requirement | AI Agent Extension |
|-----------|---------------------|-------------------|
| **Security** | Access controls for systems/data | Access controls for models and APIs; agent permission management |
| **Availability** | System uptime and reliability | Resilient, reliable AI services; agent failover; graceful degradation |
| **Processing Integrity** | Transactions complete, valid, accurate, timely | Validate AI outputs; monitor for hallucinations, data poisoning; physical command verification |
| **Confidentiality** | Protect sensitive data | Protect training data, model artifacts, physical equipment configurations |
| **Privacy** | Lawful handling of personal data | Agent data collection, operator PII, equipment telemetry |

**CC6.3 (Least Privilege)**: Agents must operate with minimum permissions. Elevated rights must be time-bound and logged. Role-based access with automated monitoring for privilege creep.

**PCC-specific audit evidence needed**:
- Complete audit trail of every agent decision and physical command
- Evidence that agent permissions are reviewed regularly
- Demonstration that hallucinated or erroneous commands are caught before reaching equipment
- 3-6 month history of safety governor intervention rates

### 4.4 FINRA/SEC Audit Trails (Analogous to Automated Physical Services)

**Sources**:
- https://www.finra.org/rules-guidance/key-topics/algorithmic-trading
- https://daytraderbusiness.com/regulations/sec-finra/sec-finra-rules-on-automated-trading-and-algorithms/

While not directly applicable to physical services, FINRA/SEC requirements for automated trading provide the most mature regulatory model for AI-controlled autonomous systems. Key analogous requirements:

| FINRA/SEC Requirement | Physical Services Analog |
|----------------------|-------------------------|
| Pre-trade risk checks | Pre-command safety envelope validation |
| Real-time monitoring of algorithmic strategies | Real-time monitoring of agent decision patterns |
| Order Audit Trail System (OATS) — electronic capture of all order/execution data | Physical Command Audit Trail — capture all command/execution/result data |
| Registration of algorithm developers | Registration/certification of agent system developers |
| Kill switches for malfunctioning algorithms | E-stop for malfunctioning agents |
| Adequate documentation of development and testing | Documented development, testing, and safety validation of agent systems |
| Supervision by registered persons | Human oversight by qualified safety personnel |

**Key insight**: FINRA requires that all persons "primarily responsible for the design, development, or significant modification of algorithmic trading strategies" must register as Securities Traders. An analogous requirement for physical automation would require certification of persons responsible for agent systems that control equipment.

### 4.5 ISO 27001 Audit Logging Requirements

**Sources**:
- https://sprinto.com/blog/iso-27001-logging-and-monitoring-policy/
- https://hightable.io/iso-27001-annex-a-8-15-logging/

ISO/IEC 27001:2022 maps audit logging to controls **A.8.15 (Logging)** and **A.8.16 (Monitoring)**.

**What must be logged**:
- Authentication attempts (successful and failed)
- Privileged account activity and administrative actions
- System and application errors or failures
- Access to sensitive data
- Configuration changes

**Log protection requirements**:
- System administrators must not be able to delete/deactivate logs of their own activities
- Logs must be stored in append-only or write-once media where possible
- Time synchronization via NTP across all infrastructure (critical for correlating events across agent systems and equipment)

**Retention and review**:
- Defined retention policy (how long, why)
- Evidence of regular log review
- Investigation records for anomalies

**PCC logging matrix**:

| Event Type | What to Log | Retention |
|------------|-------------|-----------|
| Agent authentication | Agent ID, auth method, success/fail, timestamp | 1 year |
| Tool invocation | Agent ID, tool name, parameters (hashed if sensitive), result | 1 year |
| Physical command | Agent ID, equipment ID, command type, parameters, safety check result, equipment response | 5 years (safety-critical) |
| Safety governor intervention | Agent ID, rejected command, reason, alternative action | 5 years |
| Emergency stop | Trigger source, timestamp, equipment state before/after | Permanent |
| Verification result | Verifier IDs, evidence hashes, consensus result | Matches escrow retention |
| Escrow state change | Transaction ID, old state, new state, trigger agent | Matches financial retention |

---

## 5. Agent Identity and Authentication

### 5.1 OAuth 2.0 for Things (RFC 9200 — ACE-OAuth)

**Source**: https://www.rfc-editor.org/rfc/rfc9200.html

Framework for authentication and authorization in constrained IoT environments. Adapts OAuth 2.0 for devices with limited compute/memory.

**Architecture**:

```
┌──────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Client  │────>│ Authorization    │────>│ Resource Server   │
│  (Agent) │     │ Server (AS)      │     │ (Equipment)       │
│          │<────│ Issues CWT       │     │ Validates token   │
└──────────┘     │ (CBOR Web Token) │     └──────────────────┘
                 └──────────────────┘
```

**Key technical components**:
- **CBOR Web Token (CWT)**: Compact binary token format (smaller than JWT)
- **COSE**: Object-level signing and encryption
- **Proof-of-Possession (PoP)**: Tokens bound to a specific cryptographic key — prevents token theft
- **OSCORE**: Application-layer security for CoAP (lighter than TLS)

**Profiles standardized**:
- CoAP over TLS/DTLS (RFC 9202, RFC 9430)
- CoAP with OSCORE (RFC 9203)

**PCC application**: Equipment gateways are constrained devices. ACE-OAuth provides:
- Lightweight token-based auth suitable for edge devices
- Proof-of-possession prevents stolen tokens from being replayed
- Authorization Server can be the PCC gateway itself
- Equipment only needs to validate compact binary tokens

### 5.2 FIDO2/WebAuthn for Device Identity

**Sources**:
- https://fidoalliance.org/fido-technotes-the-truth-about-attestation/
- https://www.yubico.com/authentication-standards/fido2/

FIDO2 provides:
- **Hardware attestation**: Cryptographically verified chain of trust from device manufacturer
- **AAGUID**: 128-bit identifier for device type (make/model)
- **Metadata Service (MDS)**: Automated, secure way to acquire device metadata
- **Public key cryptography**: No shared secrets

**Limitation for PCC**: FIDO2/WebAuthn is primarily designed for user authentication, not machine-to-machine. However, the **attestation model** is valuable — the concept of hardware-attested device identity (a physical device proving it is what it claims to be through a manufacturer-signed certificate chain) is directly applicable to equipment identity.

**PCC application**: Equipment could register with PCC using a FIDO2-like attestation flow:
1. Equipment ships with manufacturer-signed attestation key
2. On registration, equipment provides attestation statement proving it is genuine hardware
3. PCC verifies attestation against manufacturer's root certificate
4. Equipment gets a PCC-issued credential for ongoing authentication

### 5.3 X.509 Certificates for Machine Identity

**Sources**:
- https://learn.microsoft.com/en-us/azure/iot-hub/authenticate-authorize-x509
- https://www.keyfactor.com/blog/pki-and-certificates-for-industrial-iot-what-they-are-and-why-you-need-them/

X.509 certificates are the industry standard for machine identity in IoT/OT environments.

**Certificate chain of trust**:
```
Root CA (PCC root certificate)
  └── Intermediate CA (per-region or per-operator)
       └── Device Certificate (per-equipment)
            └── Agent Certificate (per-agent instance)
```

**Key challenges for PCC**:
- **Certificate lifecycle management**: Automated issuance, renewal, revocation at scale
- **Constrained device support**: Some equipment may have limited crypto capabilities
- **Offline operation**: Equipment may need to validate agent identity without contacting CA
- **Revocation checking**: CRL/OCSP must be accessible from equipment zones

**Recommended**: Use automated PKI (e.g., step-ca, Vault PKI, EJBCA) with short-lived certificates (hours to days). This reduces the impact of certificate compromise and eliminates most revocation challenges.

### 5.4 mTLS for Agent-to-Agent Authentication

**Sources**:
- https://blog.gitguardian.com/mutual-tls-mtls-authentication/
- https://www.buoyant.io/blog/zero-trust-mtls-and-the-service-mesh-explained

Mutual TLS requires **both** client and server to present certificates and verify each other. This is the foundation of zero-trust agent communication.

**Benefits over one-way TLS**:
- Bidirectional identity verification (agent proves identity to equipment AND equipment proves identity to agent)
- Eliminates credential theft risks (no passwords/tokens to steal)
- Prevents MITM attacks (both endpoints cryptographically verified)
- Enables fine-grained authorization based on certificate attributes

**Service mesh implementation**: Sidecar proxies (Istio, Linkerd) automate mTLS:
- No code changes needed in agent or equipment software
- Automatic certificate issuance, distribution, rotation
- Policy enforcement at the mesh level

**Industry standard**: Netflix, Uber, Google all use mTLS + SPIFFE for workload identity.

### 5.5 SPIFFE/SPIRE for Workload Identity

**Source**: https://spiffe.io/

SPIFFE (Secure Production Identity Framework For Everyone) provides cryptographic workload identity across heterogeneous infrastructure.

**Core concepts**:

| Component | Description | PCC Mapping |
|-----------|-------------|-------------|
| **SPIFFE ID** | URI-format identity: `spiffe://trust-domain/path` | `spiffe://pcc.network/agent/verification/us-west-1` |
| **SVID** | Short-lived credential (X.509 cert or JWT) proving identity | Each agent gets an SVID, auto-rotated |
| **SPIRE Server** | Signing authority, maintains workload registry | PCC control plane component |
| **SPIRE Agent** | Runs on each node, exposes Workload API | Runs alongside each agent process |
| **Attestation** | Two-phase: node attestation + workload attestation | Node = server/container identity, Workload = specific agent process |

**Advantages over raw X.509**:
- Automatic credential rotation (short-lived = less blast radius)
- Platform-agnostic (works across Kubernetes, VMs, bare metal)
- No secrets to manage (workloads request identity at runtime)
- Federated trust across domains (PCC operators in different clouds can trust each other)

**PCC architecture**:
```
PCC Trust Domain: spiffe://pcc.network

Agent identities:
  spiffe://pcc.network/agent/discovery
  spiffe://pcc.network/agent/negotiation
  spiffe://pcc.network/agent/escrow
  spiffe://pcc.network/agent/execution/{operator-id}
  spiffe://pcc.network/agent/verification/{verifier-id}
  spiffe://pcc.network/agent/settlement

Equipment identities:
  spiffe://pcc.network/equipment/{operator-id}/{device-id}

Operator identities:
  spiffe://pcc.network/operator/{operator-id}
```

### 5.6 Decentralized Identifiers (DID) Methods

**Sources**:
- https://www.w3.org/TR/did-1.0/
- https://www.w3.org/TR/did-1.1/

DIDs provide self-sovereign identity — the entity controls its own identifier without a central authority.

**Relevant DID methods for PCC**:

| Method | Resolution | Pros | Cons | PCC Use |
|--------|------------|------|------|---------|
| **did:web** | HTTPS resolution from domain | Simple, familiar infra | Depends on web server availability | Operator identity (resolves from their domain) |
| **did:key** | Self-contained in the DID string | No resolution infrastructure needed | No key rotation without new DID | Agent ephemeral identity (disposable, short-lived) |
| **did:ion** | Bitcoin-anchored (Microsoft ION) | Highly durable, decentralized | Slow updates, Bitcoin dependency | Long-lived equipment identity |
| **did:pkh** | Blockchain account address | Works with existing crypto wallets | Chain-specific | Operators already using crypto for escrow |

**PCC already uses crypto**: Since PCC has on-chain escrow (Base Sepolia), operator wallets can serve as DID subjects. A `did:pkh` derived from the operator's Ethereum address provides:
- Self-sovereign identity (operator controls their key)
- Verifiable credentials (signed attestations of capability, reputation)
- No additional identity infrastructure needed

**Verifiable Credentials (W3C VC 2.0, 2025)**: Operators can hold VCs attesting to:
- Equipment certifications (signed by equipment manufacturer)
- Safety training (signed by training provider)
- Insurance coverage (signed by insurer)
- Past job performance (signed by PCC verification system)

---

## 6. PCC Integration Recommendations

### 6.1 Priority Matrix

| Standard/Pattern | Priority | Effort | Impact | Status |
|-----------------|----------|--------|--------|--------|
| OWASP Agentic Top 10 mitigations | P0 | Medium | Critical | Some patterns already in harness |
| IEC 62443 zones and conduits | P0 | High | Critical | Architecture needed |
| RBAC + SoD for agents | P0 | Medium | Critical | Partial (harness action classes) |
| mTLS agent-to-agent | P1 | Medium | High | Not implemented |
| Emergency stop independence | P1 | High | Critical | Architecture needed |
| OpenTelemetry traces | P1 | Medium | High | Partial (audit logging exists) |
| W3C Trace Context propagation | P1 | Low | High | Not implemented |
| SPIFFE/SPIRE workload identity | P2 | High | High | Not implemented |
| ISO 42001 certification | P2 | High | Medium | Process, not code |
| EU AI Act compliance | P2 | High | High | August 2026 deadline |
| BFT verification consensus | P3 | High | Medium | PCC already has multi-verifier |
| DID-based operator identity | P3 | Medium | Medium | Crypto wallet already exists |
| ACE-OAuth for equipment | P3 | Medium | Medium | Equipment gateway needed |
| SOC 2 Type II | P3 | High | Medium | 3-6 month observation needed |

### 6.2 Immediate Architecture Changes

**1. Safety Governor Independence (IEC 61508 + IEC 60204-1)**
The safety governor must be a separate process/service that cannot be bypassed by agent code. It validates every physical command against the operational envelope before relaying to equipment. It must have its own e-stop channel independent of the agent network.

**2. Zone Architecture (IEC 62443)**
Implement network segmentation: Enterprise zone (web app, payments) -> Agent zone (all AI agents) -> Equipment control zone (safety governor, equipment gateway) -> Equipment zone (physical devices). Each boundary is a monitored conduit with appropriate security level.

**3. Agent RBAC with SoD (OWASP + RBAC)**
Formalize the six-role agent model (discovery, negotiation, escrow, execution, verification, settlement). No agent may hold write permissions in more than one lifecycle stage. Implement as allowlists in the existing harness action-policy.json.

**4. Trace Context Propagation (W3C + OTel)**
Every inter-agent and agent-to-equipment message carries traceparent/tracestate headers. Job ID embedded in tracestate for correlation. Export spans to OTel-compatible backend with retention appropriate to safety criticality.

### 6.3 Standards Compliance Roadmap

```
2026 Q2: OWASP Agentic mitigations + RBAC/SoD formalization
         IEC 62443 zone architecture design
         OpenTelemetry instrumentation

2026 Q3: mTLS for all agent communication
         Safety governor independence verification
         W3C Trace Context propagation
         Begin SOC 2 observation period

2026 Q4: SPIFFE/SPIRE deployment
         EU AI Act gap analysis (ahead of Aug 2027 deadline for existing systems)
         ISO 42001 readiness assessment

2027 Q1: SOC 2 Type II audit (after 3-6 month observation)
         EU AI Act conformity assessment
         ISO 42001 certification pursuit
```

---

## References

### Section 1: Agent Operational Envelopes
- OWASP Top 10 for LLM Applications 2025: https://genai.owasp.org/resource/owasp-top-10-for-llm-applications-2025/
- OWASP Top 10 for Agentic Applications 2026: https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/
- Anthropic Constitutional AI: https://www.anthropic.com/research/constitutional-ai-harmlessness-from-ai-feedback
- Anthropic Constitutional Classifiers: https://www.anthropic.com/research/next-generation-constitutional-classifiers
- Anthropic ASL-3 Report: https://www.anthropic.com/activating-asl3-report
- OpenAI Function Calling: https://platform.openai.com/docs/guides/function-calling
- OpenAI Agents SDK Guardrails: https://openai.github.io/openai-agents-python/guardrails/
- DeepMind Frontier Safety Framework v3.0: https://deepmind.google/blog/strengthening-our-frontier-safety-framework/
- DeepMind Technical AGI Safety: https://storage.googleapis.com/deepmind-media/DeepMind.com/Blog/evaluating-potential-cybersecurity-threats-of-advanced-ai/An_Approach_to_Technical_AGI_Safety_Apr_2025.pdf
- NIST AI 100-1: https://nvlpubs.nist.gov/nistpubs/ai/nist.ai.100-1.pdf
- EU AI Act Article 16: https://artificialintelligenceact.eu/article/16/
- EU AI Act Timeline: https://trilateralresearch.com/responsible-ai/eu-ai-act-implementation-timeline-mapping-your-models-to-the-risk-tiers
- ISO/IEC 42001: https://www.iso.org/standard/42001

### Section 2: Multi-Agent Coordination Patterns
- FIPA Contract Net Protocol: https://en.wikipedia.org/wiki/Contract_Net_Protocol
- Blackboard Architecture: https://en.wikipedia.org/wiki/Blackboard_system
- Blackboard + MCP: https://medium.com/@dp2580/building-intelligent-multi-agent-systems-with-mcps-and-the-blackboard-pattern
- TraderBots (CMU): https://www.ri.cmu.edu/publications/traderbots-a-market-based-approach-for-resource-role-and-task-allocation-in-multirobot-coordination/
- Market-Based Survey: https://link.springer.com/article/10.1007/s10846-022-01803-0
- Stigmergy: https://en.wikipedia.org/wiki/Stigmergy
- BFT Survey: https://www.mdpi.com/2079-9292/12/18/3801
- RBAC for AI Agents: https://medium.com/@christopher_79834/ai-agent-rbac-essential-security-framework-for-enterprise-ai-deployment-d9d1d4711183
- Why RBAC Not Enough: https://www.osohq.com/learn/why-rbac-is-not-enough-for-ai-agents

### Section 3: Physical Safety Standards
- IEC 61508: https://en.wikipedia.org/wiki/IEC_61508
- IEC 62443: https://www.dragos.com/blog/isa-iec-62443-concepts
- ISO 10218-1:2025: https://www.iso.org/standard/73933.html
- ISO 10218-2:2025: https://www.iso.org/standard/73934.html
- ANSI/A3 R15.06-2025: https://blog.ansi.org/ansi/ansi-a3-r15-06-2025-robot-safety/
- IEC 60204-1 / ISO 13850: https://www.unitecd.com/emergency-stop-circuit-testing-procedure-functional-verification-response-time-measurement-and-documentation-for-industrial-machinery/
- OSHA LOTO: https://www.osha.gov/control-hazardous-energy
- Machinery Directive: https://en.wikipedia.org/wiki/Machinery_Directive

### Section 4: Observability and Audit
- OTel AI Agent Observability: https://opentelemetry.io/blog/2025/ai-agent-observability/
- OpenLLMetry: https://github.com/traceloop/openllmetry
- OTel for MCP: https://glama.ai/blog/2025-11-29-open-telemetry-for-model-context-protocol-mcp-analytics-and-agent-observability
- W3C Trace Context: https://www.w3.org/TR/trace-context/
- SOC 2 for AI Agents: https://goteleport.com/blog/ai-agents-soc-2/
- SOC 2 AI Controls: https://www.schellman.com/blog/soc-examinations/how-to-incorporate-ai-into-your-soc-2-examination
- FINRA Algorithmic Trading: https://www.finra.org/rules-guidance/key-topics/algorithmic-trading
- ISO 27001 Logging: https://sprinto.com/blog/iso-27001-logging-and-monitoring-policy/
- ISO 27001 A.8.15: https://hightable.io/iso-27001-annex-a-8-15-logging/

### Section 5: Agent Identity and Authentication
- RFC 9200 (ACE-OAuth): https://www.rfc-editor.org/rfc/rfc9200.html
- FIDO2 Attestation: https://fidoalliance.org/fido-technotes-the-truth-about-attestation/
- X.509 for IoT: https://learn.microsoft.com/en-us/azure/iot-hub/authenticate-authorize-x509
- PKI for IIoT: https://www.keyfactor.com/blog/pki-and-certificates-for-industrial-iot-what-they-are-and-why-you-need-them/
- mTLS Guide: https://blog.gitguardian.com/mutual-tls-mtls-authentication/
- mTLS + Zero Trust: https://www.buoyant.io/blog/zero-trust-mtls-and-the-service-mesh-explained
- SPIFFE: https://spiffe.io/
- SPIFFE Concepts: https://spiffe.io/docs/latest/spiffe-about/spiffe-concepts/
- W3C DID v1.0: https://www.w3.org/TR/did-1.0/
- W3C DID v1.1: https://www.w3.org/TR/did-1.1/
