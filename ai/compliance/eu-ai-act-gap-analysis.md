# EU AI Act — High-Risk AI Compliance Gap Analysis

**Project**: Physical Capability Cloud (PCC)  
**Classification**: High-Risk AI System (Article 6, Annex III) — AI controlling physical infrastructure / safety components of machinery  
**Deadline**: August 2, 2026 (full requirements effective)  
**Prepared**: 2026-04-03  
**Sources**: [artificialintelligenceact.eu/article/16](https://artificialintelligenceact.eu/article/16/), [legalnodes.com EU AI Act 2026](https://www.legalnodes.com/article/eu-ai-act-2026-updates-compliance-requirements-and-business-risks), [Kennedy's Law timeline](https://www.kennedyslaw.com/en/thought-leadership/article/2026/the-eu-ai-act-implementation-timeline-understanding-the-next-deadline-for-compliance/)

---

## Why PCC is High-Risk

PCC falls under **Annex III, Point 2** (management and operation of critical infrastructure) and **Point 9** (safety components of products covered by machinery regulation). Specifically:

- PCC Shop Kernels remotely command CNC machines, 3D printers, lab robots, and industrial automation equipment
- Autonomous agents negotiate, schedule, and execute physical manufacturing tasks
- Physical harm is a foreseeable consequence of incorrect AI outputs (incorrect G-code execution, safety-stop bypass, wrong parameters)
- PCC operates as a provider AND deployer: it places the AI system on market AND operates it for customers

**Penalty exposure**: Up to EUR 15 million or 3% of global annual turnover for non-compliance.

---

## Article 16 Requirements — Gap Analysis Table

| # | Requirement | Article Reference | PCC Current Coverage | Status | Gap Description |
|---|-------------|------------------|---------------------|--------|-----------------|
| 1 | **Risk Management System** | Art. 9 (via Art. 16a) | SafetyGovernor: 4-layer (FiPer entropy → OOD → Code-as-Monitor → Conformal); command rejection logging; safety-stop events in evidence | **Partial** | No documented iterative risk lifecycle process; missing formal risk register with residual risk acceptance; no periodic review cadence |
| 2 | **Data Governance** | Art. 10 (via Art. 16b) | Evidence bundles are content-addressed (SHA-256); TEE attestation for data integrity; verifier consensus | **Partial** | Training/validation data governance not documented; no bias detection process for capability routing decisions; no data lineage for ML model inputs |
| 3 | **Technical Documentation** | Art. 11 + Annex IV (via Art. 16c) | CLAUDE.md, package READMEs, architecture docs; agent-harness-standards.md | **Partial** | Not structured per Annex IV requirements; missing: system architecture diagram for conformity assessment, risk management description, human oversight mechanisms, accuracy/robustness metrics, test protocols with pass/fail criteria |
| 4 | **Record-Keeping / Automatic Logging** | Art. 12 (via Art. 16d) | OTel audit logging (tool-calls.jsonl); evidence bundles with hash-chained logs; SafetyGovernor verdict logging; HLOS kernel signing | **Partial** | Logs not yet retained for 10-year minimum; no W3C Trace Context propagation for cross-system correlation; no automated log integrity verification on retrieval |
| 5 | **Transparency to Deployers** | Art. 13 (via Art. 16e) | Agent-package.json describes 154 tools; operator PWA with job status; setup wizard with capability descriptions | **Partial** | No formal "Instructions for Use" document per Art. 13(3); no disclosure of system limitations, accuracy ranges, or known failure modes to deployers; no machine-readable capability limitations |
| 6 | **Human Oversight Design** | Art. 14 (via Art. 16f) | Execution Scope Protocol (4 classes: READ/SAFE/SCOPED/PRIVILEGED); operator approval for PRIVILEGED ops; emergency stop in scope revocation | **Partial** | Emergency stop must be independent of AI system (hardware-level); no documented human override latency SLA; human oversight UI not yet built for real-time intervention; no operator training documentation |
| 7 | **Accuracy, Robustness, Cybersecurity** | Art. 15 (via Art. 16g) | TEE attestation; ECIES encryption; Ed25519 signing; ZK proofs; Storacha evidence storage; Sentry error monitoring | **Partial** | No documented accuracy metrics for capability routing; no adversarial robustness testing; cybersecurity policy not formally documented; no penetration testing record; SPIFFE/SPIRE workload identity not implemented |
| 8 | **Quality Management System (QMS)** | Art. 17 (via Art. 16h) | CI/CD pipeline (Railway); 3300+ tests; vitest + pytest coverage | **Gap** | No ISO 9001-aligned QMS documentation; no formal quality policy; no defined quality objectives with measurement; no management review process; no supplier/operator qualification process |
| 9 | **Conformity Assessment** | Art. 43 (via Art. 16i) | N/A | **Gap** | No conformity assessment completed or scheduled; must choose between self-assessment (if harmonised standard applies) or notified body assessment; CE marking not affixed |
| 10 | **EU Declaration of Conformity** | Art. 47 (via Art. 16j) | N/A | **Gap** | DoC not drafted; must be maintained for 10 years post-placement on market |
| 11 | **CE Marking** | Art. 48 (via Art. 16k) | N/A | **Gap** | CE marking not affixed to product/documentation; required before placing on EU market |
| 12 | **EU Database Registration** | Art. 49 (via Art. 16l) | N/A | **Gap** | Not registered in EU AI database (EUDAMED-equivalent for AI); mandatory before August 2026 deployment in EU |
| 13 | **Post-Market Monitoring** | Art. 72 (via Art. 16m) | Sentry error monitoring; Railway healthcheck; evidence drift detection | **Partial** | No formal post-market surveillance plan; no systematic incident reporting to national competent authorities; no serious incident reporting procedure (Art. 73) |
| 14 | **Corrective Actions & Reporting** | Art. 20 (via Art. 16n) | GitHub issue tracking; deployment rollback via Railway | **Gap** | No defined corrective action procedure; no serious incident reporting workflow to national supervisory authority; no documented recall/withdrawal procedure |
| 15 | **Cooperation with Authorities** | Art. 21 (via Art. 16o) | N/A | **Gap** | No designated EU representative identified; no documented procedure for authority access to technical documentation and logs |
| 16 | **Accessibility** | Directives 2016/2102 + 2019/882 (via Art. 16p) | React dashboard exists | **Gap** | Accessibility audit not performed; WCAG 2.1 AA compliance not verified for operator interfaces |

---

## PCC System → Requirement Mapping

| PCC System | Covers (Partial) | Gap Remaining |
|-----------|-----------------|---------------|
| **SafetyGovernor** (4-layer) | Art. 9 risk management runtime; Art. 14 human oversight (scope classes) | Formal risk register; independent emergency stop |
| **OTel + audit logging** (tool-calls.jsonl) | Art. 12 record-keeping | 10-year retention; W3C Trace Context; log integrity verification |
| **RBAC + Execution Scope** (4 classes) | Art. 14 human oversight design | Real-time human intervention UI; override latency SLA |
| **TEE attestation + ZK proofs** | Art. 15 robustness/cybersecurity | Formal cybersecurity policy; pen testing; SPIFFE/SPIRE |
| **Evidence bundles** (SHA-256, hash chains) | Art. 12 logging; Art. 10 data integrity | Data governance documentation; bias detection |
| **ComplianceFacade** (ISO 9001/FDA 21 CFR) | Art. 17 QMS (partial) | Full ISO 9001 QMS process documentation |
| **ERC-8004 identity registry** | Art. 13 transparency (machine identity) | Instructions for Use document; limitation disclosures |
| **VerifierRegistry.sol** | Art. 10 data governance (on-chain) | Training data governance; ML model data lineage |
| **Storacha + IPFS** (evidence storage) | Art. 12 record retention (immutable CIDs) | Retention policy enforcement (10 years minimum) |
| **HLOS kernel signing** | Art. 15 cybersecurity | Formal cybersecurity policy; threat model |
| **3300+ tests + CI/CD** | Art. 17 QMS (testing component) | Formal QMS documentation; quality objectives |

---

## Gap Severity Classification

| Severity | Gaps | Description |
|----------|------|-------------|
| **Critical (must fix before EU deployment)** | Conformity Assessment, EU DoC, CE Marking, EU Database Registration | Cannot legally place on EU market without these |
| **High (must fix by Aug 2, 2026)** | QMS documentation, Instructions for Use, Post-Market Monitoring plan, Corrective Action procedure | Enforcement begins August 2026 |
| **Medium (significant work needed)** | Risk Management lifecycle formalization, 10-year log retention, Cybersecurity policy, Human oversight UI | Partial coverage exists; needs formalization |
| **Low (documentation / process)** | Accessibility audit, EU representative appointment, Authority cooperation procedure | Process/admin items with lower technical complexity |

---

## August 2026 Timeline — What Must Be Done

### By June 1, 2026 (Pre-Conformity)
- [ ] **Draft Technical Documentation** (Annex IV) — complete system description, risk management description, test protocols, accuracy metrics
- [ ] **Formal risk register** — document all foreseeable risks, mitigations, residual risk acceptance criteria
- [ ] **QMS documentation** — quality policy, quality objectives, process map (can be lightweight for small providers)
- [ ] **Instructions for Use** (Art. 13) — deployer-facing document: system capabilities, limitations, accuracy ranges, known failure modes

### By July 1, 2026 (Conformity Assessment)
- [ ] **Choose conformity assessment path**: self-assessment (if harmonised standard EN ISO/IEC 42001 applied) or notified body
- [ ] **Complete conformity assessment** — document results
- [ ] **Draft EU Declaration of Conformity** (Art. 47 template)
- [ ] **Appoint EU representative** (if PCC operates from outside EU)

### By August 2, 2026 (Market Readiness)
- [ ] **Register in EU AI Act database** — mandatory pre-market registration
- [ ] **Affix CE marking** — to product documentation / operator-facing materials
- [ ] **Post-market monitoring plan** — incident reporting thresholds, surveillance cadence, serious incident SOP
- [ ] **Corrective action procedure** — documented workflow for incidents, recalls, authority requests

### Ongoing After August 2026
- [ ] **10-year log retention** — enforce log retention policy (evidence bundles + OTel spans)
- [ ] **Annual risk management review** — iterative update of risk register
- [ ] **Serious incident reporting** — report to national competent authority within 15 days of incident
- [ ] **Post-market surveillance report** — annual or event-triggered

---

## Recommended Build Priorities for PCC Engineering

### Priority 1: Infrastructure (enables conformity assessment)

1. **Risk Register Module** (`packages/gateway/src/compliance/risk-register.ts`)
   - CRUD for risks: description, likelihood, severity, mitigation, residual risk, owner
   - API: `GET/POST /api/compliance/risks`
   - Maps to: Art. 9 risk management system

2. **Log Retention Policy** (`packages/kernel/src/log-retention.ts`)
   - Enforce 10-year retention on evidence bundles (Storacha is permanent by design — good)
   - Add retention metadata to evidence bundles: `retainUntil: ISO8601`
   - Maps to: Art. 12 record-keeping

3. **W3C Trace Context Propagation**
   - Add `traceparent`/`tracestate` headers to all inter-agent and agent-to-equipment messages
   - Embed `jobId` in `tracestate` for cross-system correlation
   - Maps to: Art. 12 logging correlation

### Priority 2: Documentation Generation (enables DoC + Annex IV)

4. **Technical Documentation Generator** (`packages/gateway/src/compliance/tech-doc-generator.ts`)
   - Auto-generate Annex IV sections from: capability CSDs, evidence tier requirements, SafetyGovernor config
   - Export as PDF-ready markdown
   - Maps to: Art. 11 technical documentation

5. **Instructions for Use Generator** (`packages/gateway/src/compliance/ifu-generator.ts`)
   - Per-capability IFU: what the AI does, what it cannot do, accuracy metrics, human oversight requirements
   - Maps to: Art. 13 transparency

### Priority 3: Human Oversight UI

6. **Real-Time Oversight Dashboard** (`apps/ui/src/pages/oversight/`)
   - Live feed of AI decisions requiring human review
   - One-click approve/reject with audit trail
   - Emergency stop button (independent of AI execution path — calls hardware-level stop)
   - Override latency SLA: < 500ms from decision to stop signal
   - Maps to: Art. 14 human oversight

---

## Cost Estimate (Engineering Days)

| Item | Estimated Days |
|------|---------------|
| Risk Register Module | 3 |
| Log Retention Policy | 1 |
| W3C Trace Context | 3 |
| Technical Documentation Generator | 5 |
| Instructions for Use Generator | 3 |
| Human Oversight UI | 8 |
| Conformity Assessment prep (process) | 5 |
| QMS documentation (process) | 5 |
| EU Database Registration (process) | 1 |
| **Total** | **34 days** |

---

## References

- [Article 16: Obligations of Providers of High-Risk AI Systems](https://artificialintelligenceact.eu/article/16/)
- [EU AI Act 2026 Updates: Compliance Requirements and Business Risks](https://www.legalnodes.com/article/eu-ai-act-2026-updates-compliance-requirements-and-business-risks)
- [Kennedy's Law: EU AI Act Implementation Timeline](https://www.kennedyslaw.com/en/thought-leadership/article/2026/the-eu-ai-act-implementation-timeline-understanding-the-next-deadline-for-compliance/)
- [AI Act Service Desk — Article 16](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-16)
- [EU AI Act: Obligations for Providers — DataGuard](https://www.dataguard.com/blog/the-eu-ai-act-and-obligations-for-providers/)
- PCC internal: `ai/research/agent-harness-standards.md` §1.7
