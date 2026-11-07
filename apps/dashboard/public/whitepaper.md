# Physical Capability Cloud

**Version 4.0, November 2026.** This version describes PCC's code as of November 7, 2026.

**Turn abilities and inventions into trusted, economically callable capacity that other agents can immediately build on.**

Public beta: payments settle on a test network.

---

## How to read this paper

Every capability in this paper carries one of two labels.

- **Live** means it is in PCC's code today. The table at the end gives each live item's proof level on this scale: specified, implemented, integrated locally, deployed, observed successfully, observed under failure, repeatedly operated.
- **Planned** means it is not built yet, or not yet working end to end. A planned item says where PCC is going, not what it does today.

This paper names the main things PCC does not guarantee.

---

## 1. Why PCC

PCC is built to make physical work purchasable as a composable, verifiable obligation: specify an outcome, assemble the capabilities needed to produce it, agree on acceptance and payment, execute across organizations, and carry the evidence forward. That is the aim. Today, putting those steps together often needs a coordinator who understands each supplier's interfaces, reads their records, reconciles invoices and absorbs the failures between organizations.

The unit PCC is built around is an agreed physical obligation: an executable acceptance rule, attributable evidence and a funded payment consequence. **Live:** each of the three pieces exists in PCC's code: committed acceptance programs, evidence signed by the executing kernel's key, and escrow units that, above assurance tier 0, release only against committed evidence. **Planned:** one such obligation run end to end on a real job, funded, executed, evidenced, verified and paid.

If this works, several things become practical. **Planned:**

- A buyer could order an outcome that spans several suppliers without integrating each supplier separately.
- A small operator could sell spare capacity as a capability that another agent can discover, procure and pay for.
- A downstream buyer could check upstream provenance without rebuilding the history from emails and disconnected databases.
- Contributors could receive agreed shares as work settles, instead of waiting for a lead contractor to reconcile and distribute revenue afterwards.

### What each industry needs beyond "execution completed"

This table lists requirements, not services PCC offers today. **Planned.**

| Industry | What could become possible | What PCC must establish beyond "execution completed" |
|---|---|---|
| Manufacturing | An agent orders design, fabrication, inspection and delivery from different suppliers. | Material identity, process conditions, dimensional acceptance, and continuity between the inspected part and the delivered part. |
| Laboratories | A protocol procures preparation, instrument time, analysis and review across facilities. | Sample identity, custody, calibration, protocol version, and the link between raw measurements and reported results. |
| Logistics | Each custody transfer and delivery condition becomes a separately accepted obligation. | That scans concern the same parcel, that records are timely, and that relevant observations are independent of the claimant. |
| Construction | Fabrication, delivery, installation and inspection settle in stages. | Site-specific acceptance, installed-object identity, and responsibility when later work exposes an earlier defect. |
| Agriculture and energy | Agents procure measured interventions or delivered output. | Coverage over time, calibrated measurements, baseline definitions, and attribution when weather or other actors affect the result. |
| Healthcare | Equipment servicing, specimen transport and other bounded operational services gain traceable acceptance records. | Appropriate access controls, custody, qualified acceptance, and a clear boundary between operational evidence and clinical judgment. |
| Creative production | Design, licensed assets, fabrication, printing and distribution share a traceable production history. | Authorized use, versioned rights, accepted quality, and explicit royalty obligations. |

### The limits, up front

- A hash shows that bytes are unchanged, and a signature shows which key signed them. Neither shows that a sensor observed the right object, that no failure was left out, or that the acceptance rule measures what the buyer actually cares about. Those are jobs for the measurement, identity, custody and acceptance layers.
- Evidence can show that a contribution happened. It cannot say what that contribution is fairly worth. PCC can enforce an allocation the parties accepted; the allocation rule itself stays their choice.
- Escrow ties up capital. Paying on verified milestones lowers a supplier's credit risk, but it does not lower the financing a job needs.

---

## 2. How PCC works: two sides, each with its own agent

PCC has two sides, and each reaches PCC through its own agent. In PCC's design, buyers' agents discover capabilities, compose plans and pay for work. Suppliers' agents onboard a lab, an operator or a device. **Live:** both entry points exist: an agent connection for buyers, and a step-by-step runbook that a supplier's coding agent follows.

In PCC's design, the buyer's agent authors the plan, and PCC's part is to check it, price it, fund it and settle it, not to write it. **Planned:** the route that accepts a plan the buyer's agent wrote.

Buyers and operators bring their own agent and their own model. **Live:** PCC's execution, evidence and settlement path makes no model call. PCC's code does call a hosted model in some assisting features, such as onboarding chat, document analysis, device identification, an optional embedding search of the tool catalog and an older request-decomposition service. PCC's own hosted agent, described in section 4, also calls a hosted model.

---

## 3. For buyers' agents: find, price, commit, follow

### Connecting

**Live:**

- Agents connect to PCC's MCP server at the path /mcp on PCC's gateway, capability.network. A separate, read-only MCP surface at /mcp/apps serves interface views; in production it serves them only when an app domain is configured.
- The agent package at capability.network/agent-package.json gives any LLM agent PCC's tools, auth modes and worked examples in one file.
- The API is published as an OpenAPI document at /openapi.json, and a documentation MCP server at /mcp/docs serves PCC's guides with a search tool.
- An agent holding a PCC API key can search PCC's tool catalog by intent.

This paper gives no tool counts. The catalog changes, and a hand-kept number goes stale.

**Planned:**

- One golden-path file, /.well-known/agent.md, that tells an agent exactly what to do, for buyers and for suppliers.
- An MCP tool, `pcc_search_tools`, that wraps tool search with a small default toolset.
- Signup without a browser: register, verify an emailed code and claim the account; then check the account's status from the command line, and install PCC's MCP server into a coding agent with one command.

### The buyer's path

**Live:** An agent searches PCC's capability registry, and a person can browse the same registry at /discover. The registry lists what operators have registered; this paper makes no claim about how much supply it holds.

**Live:** The agent prices a capability from its parameters, opens a negotiation session, gets a quote, commits, and submits the job.

**Planned:** the buyer funds the job's escrow from its own wallet, as the payer on chain.

**Live:** PCC's code defines the settlement reads a buyer will follow the money through: each settlement unit's lifecycle, receipt and provenance, each pinned to a block (section 9). **Planned:** the chain reader behind them; until it lands, they answer 'not ready'.

**Planned:** a watched acceptance run in which a fresh buyer agent goes from nothing to a quoted, composed plan.

---

## 4. For operators: join with your own agent

### What joining has to produce

Joining PCC should produce an honestly described, safely executable, evidence-capable supplier. That takes adapter conformance, identity enrollment, capability validation and a watched acceptance job. **Planned:** that guarantee. Registering a device today does not, by itself, prove that the device executes commands safely, supports a given assurance level, stays available, or is ready to be paid.

### What exists today

**Live:**

- PCC's starter runbook lets an operator's own coding agent onboard a device in ordered phases: identify, intake, research, build, register, verify, operate and publish.
- pcc-node, a Python program in PCC's repository, gives the operator's machine start, discover, detect and status commands.
- PCC's kernel has adapters for IPP printers (with a built-in IPP client), OctoPrint, Modbus sensors, OPC UA, SiLA instruments and cameras. Each is implemented in code; none has been certified by a conformance run yet.
- PCC's own hosted agent (read-only), in PCC's repository, offers only reviewed public read tools through an explicit allowlist, and shows results only through typed projections. It acts as the user, never as PCC.

### What is planned

**Planned:**

- Operators onboard new machines, processes and capabilities with their own agents through the ADK, PCC's agent development kit. The ADK makes the adapters; PCC does not write each capability's rules.
- The ADK guides the operator's own agent to build a template's adapter, its tests and its negative controls. PCC supplies no generator.
- A one-command installer for a node.
- In the operator's words, PCC as a managed end-to-end service: partner-hosted sandboxed agents and a device kit (for a shop, a lab, a car or a phone). An operator's hosted agent would act through a scoped session key.
- A watched acceptance run in which a fresh Claude Code, a fresh Codex and PCC's own agent each onboard a simulated instrument end to end.

---

## 5. Capabilities, kits and templates

**Live:** A capability is described by a Capability StructureDefinition (CSD): a versioned document that may inherit from a base definition, with typed parameters, cross-parameter constraints, evidence requirements for each assurance tier, and pricing rules. The format borrows FHIR's idea of a base definition that profiles narrow.

**Live:** A Capability Kit is a versioned manifest that records its parent kit's digest, so a fork's lineage is visible.

**Live:** PCC's kit registry stores published kits write-once: a published version never changes, and an edit is a new manifest. An agent with a PCC API key can list published kits and fetch any one by its digest, and a fork is published with its parent's digest. Publishing needs an issued publishing role today; operators' self-service keys can't publish yet.

**Planned:** operators publish kits themselves, and agents search kits alongside live operators.

**Planned:** an operator adapts a kit and sees where its provenance has gaps.

**Planned:** a template is an adapter plus its proof rules and payout profile, published as a Capability Kit.

**Planned:** an operator binds to PCC and advertises its capacity and pricing.

---

## 6. Rights, licensing and author earnings

Templates would let one operator's work serve many others. The plan is to pay the people who make them through PCC's own contracts, under terms everyone accepts before money moves.

**Planned:** a template's author is paid a share of each job that uses the template, through PCC's own escrow payouts.

**Planned:** licensing and payout terms are versioned and accepted before a job is funded. A license that doesn't fit is refused, not given an invented split. Terms fixed before funding can be compiled into exact payouts and checked.

**Planned:** licensing and economic terms are audited.

---

## 7. Plans and composition

**Planned:** a buyer's agent submits its own plan, a graph of capability steps, and PCC compiles it deterministically under a one-use budget.

**Live:** the accepted-plan compiler and the canonical plan format are in PCC's code today. The buyer-facing route that uses them is planned.

**Planned:** snapshots and evidence contracts are re-authenticated before value moves.

**Live:** a dashboard that combines windows from several operators can be saved, shared and forked at its own capability.network/a/ address, and it reloads without being regenerated.

**Planned:** an improved composition can be republished.

---

## 8. Evidence and acceptance

Section 1's limits apply here: a signed record shows which key signed it, not that it is true.

**Live:** a PCC kernel can sign the evidence it emits for a job with that kernel's registered key.

**Live:** acceptance is defined by committed programs: each program is identified by its hash and checked against the assurance tier it backs.

**Live:** when an operator submits a completed job's signed evidence package, PCC's gateway issues a signed receipt recording when it arrived.

**Planned:** an independent oracle checks the evidence against the committed program and signs the verdict that releases or withholds payment.

Evidence that a machine accepted a command is not evidence that the output met the specification, and a missing failure event proves little unless the record covers the whole run.

---

## 9. Settlement

**Live:** PCC's settlement escrow is deployed on the Base Sepolia test network, and its deployment record is committed in PCC's repository.

**Live:** a job's escrow funding can carry up to 16 settlement units, and each unit up to 16 payout legs. Each unit has its own required assurance tier, its own evidence gate and its own reclaim deadline.

**Live:** at assurance tier 1 and above, a unit's funds are released only against the evidence its operator committed, on an attested verdict over that evidence after the unit's challenge window. A unit at assurance tier 0 is released only on the buyer's own signed approval. Otherwise the buyer can reclaim the funds after the deadline. These rules are in the deployed contract; running a real job through them end to end is planned (section 1).

**Live:** PCC's settlement read routes are built so that every money fact comes from one chain read pinned to a block: each reply echoes the block number and hash, and a mismatch is refused. **Planned:** the chain reader behind them, so anyone can re-check a reply against their own node.

**Planned:** every money display and receipt on screen shows its block reference, and nothing shows as paid before finality.

**Planned:** multi-party jobs are split into legs, such as print, courier and carrier, each with its own operator, wallet, evidence and payout, so a good leg is paid even when a later leg fails.

**Planned:** PCC holds the vendor accounts, such as postage, email and carriers, and pays them, so no buyer or operator has to sign up for or wire up a third-party vendor.

**Planned:** one bill: the buyer approves one all-in price that names every payee, and pays it once.

---

## 10. Wallets and authority

**Planned:** everyone gets a wallet at sign-up, non-custodial by default, with gas sponsored on mainnet and automatic funding on the test network.

**Live:** a person or an agent can link an existing wallet to a PCC account through a device-authorization flow, proving control of the wallet with a signature. Smart-contract wallets are accepted.

**Live:** on the test network, a linked wallet can be funded for testing.

**Planned:** spending authority bound to a principal and capped durably across every step of a plan.

**Live:** remote control of a device runs under an execution scope: a grant that names the allowed tools and sets a command budget, which the operator can revoke, with an audit trail.

**Live:** an operator's emergency stop rejects the kernel's pending approvals and queued relay commands, so none of those runs after the resume. Queued jobs are held during the stop, not cancelled, and can start after the resume.

Permission to spend money on a job does not make a command safe for a device or a site. **Planned:** safety controls at the point where commands are dispatched.

---

## 11. Interfaces across operators

PCC's interface design, in the operator's words: "Operator interfaces are compiled artifacts; orchestration interfaces are user-agent compositions. PCC defines, validates, distributes and safely renders the language connecting them, but does not need to supply the intelligence that creates them." The reasoning: an operator serves mostly the same interface over and over, so that interface should be compiled once; a user's agent combines many operators in one workflow, so the composing belongs there.

**Live:**

- In PCC's closed render format, every node of a rendered view is chosen by deterministic PCC code from a closed catalog, and each data or prose node carries a provenance class: authoritative, accepted, proposed, preference or ephemeral.
- A composed dashboard uses a closed set of window kinds: note, metric, capability, list, form, run, approval, receipt, chain and actions.
- Interface views reach MCP hosts as MCP App views (in production, only when an app domain is configured), and a reader on another origin gets only render fields, through a server-side projection.
- Views inside a third-party host, composed ones included, are read-only: the only operation they can run is a request for a quote. Approvals and payments are confirmed on PCC's own pages.
- A routine run makes no model call: it loads a stored interface, renders it and reads live state. PCC hosts no model to generate or render interfaces.

**Planned:**

- No artifact, model or user agent can create, suppress or restyle a trust surface: restyling uses design tokens only, and trust surfaces are style-locked.
- An operator publishes its interface once, bound to its proven identity, versioned and cached, and a user's agent composes interfaces from many operators.
- Operator interfaces can arrive in A2UI v0.9.1 through an adapter, and are compiled at publish time into PCC's own format. The renderer never reads A2UI.
- Models make bounded decisions (typed questions answered with a confidence), and deterministic rules map the answers to catalog components. Models never decide payment, grants, whether evidence suffices, or physical safety.
- A user's agent may rearrange, group, collapse and restyle within limits, but may not change what an operator's inputs, outputs or actions mean, or remove a warning or an approval.

---

## 12. Feedback and improvement

**Live:** agents can report a problem to PCC in one call.

**Planned:** a reporter can look up its report's status as PCC triages it.

**Planned:** execution observations derived from receipts and evidence, never from self-reports, that feed back into a capability's record.

**Planned:** known-answer test tasks that run inside the job path, to check that a capability still performs.

---

## 13. From a new method to a buyable capability

**Planned:** a new method becomes safely buyable in hours to days: its author gets a usable safety path, made of a capability spec, a committed program and an assurance ladder, without PCC writing its rules. "Hours to days" is the goal, not a measured time.

---

## 14. Risks and what PCC does not guarantee

- Retries can repeat irreversible physical work. An idempotent payment does not make a device command idempotent, and a refund cannot unprint a part.
- Ratings and evaluator signals can reward the wrong actors unless they are tied to authenticated participation and accepted outcomes.
- Discovery can concentrate demand, assurance costs can shut out small operators, and evidence rules can become surveillance.
- Some choices belong to the operator, not the code: how temporary organizations form and wind down, how contracts for several parties are combined, what competition optimizes, how rights feed payouts, and who finances work that runs in stages.

---

## 15. Status at a glance

This table is generated from the claim list behind this paper, not kept by hand. Proof levels use the scale from "How to read this paper".

| Capability | Status | Proof level |
|---|---|---|
| The aim: physical work as a composable, verifiable obligation | Planned | - |
| The three pieces of an obligation: committed acceptance programs, kernel-signed evidence, escrow units gated on evidence above tier 0 | Live | implemented; deployed on a test network |
| One obligation run end to end on a real job | Planned | - |
| Two entry points: an agent connection for buyers, a runbook for suppliers' coding agents | Live | implemented |
| Accepting a plan the buyer's agent wrote | Planned | - |
| No model call on the execution, evidence and settlement path | Live | implemented |
| MCP server at /mcp; read-only interface surface at /mcp/apps (in production, only with an app domain) | Live | implemented |
| Agent package (tools, auth modes, examples) | Live | implemented |
| OpenAPI document and documentation MCP server | Live | implemented |
| Tool search by intent (with an API key) | Live | implemented |
| Golden-path file at /.well-known/agent.md | Planned | - |
| pcc_search_tools MCP tool | Planned | - |
| Browserless signup, account status, one-command install into a coding agent | Planned | - |
| Capability registry search and /discover | Live | implemented |
| Price, negotiate, quote, commit and submit | Live | implemented |
| Buyer funds escrow from its own wallet | Planned | - |
| Settlement read routes: lifecycle, receipt, provenance (the chain reader is planned) | Live | implemented (routes only) |
| Watched acceptance runs (buyer and supplier) | Planned | - |
| Joining produces an honestly described, safely executable, evidence-capable supplier | Planned | - |
| Starter runbook for an operator's coding agent | Live | implemented |
| pcc-node commands | Live | implemented |
| Kernel adapters (IPP, OctoPrint, Modbus, OPC UA, SiLA, cameras) | Live | implemented |
| PCC's own hosted agent (read-only) | Live | implemented |
| Onboarding through the ADK | Planned | - |
| ADK guidance for adapters, tests and negative controls | Planned | - |
| One-command node installer | Planned | - |
| Managed end-to-end service: device kit and partner-hosted agents | Planned | - |
| An operator's hosted agent with a scoped session key | Planned | - |
| Capability StructureDefinition (CSD) | Live | implemented |
| Capability Kit manifest with parent digest | Live | implemented |
| Write-once kit registry: list, fetch, fork (publishing by issued role) | Live | implemented |
| Operators publish kits; kits searched alongside live operators | Planned | - |
| Adapt a kit and see its provenance gaps | Planned | - |
| Templates as kits | Planned | - |
| Operator binding, capacity and pricing | Planned | - |
| Template authors paid through PCC's escrow payouts | Planned | - |
| Versioned terms accepted before funding | Planned | - |
| Audited licensing and economic terms | Planned | - |
| Agent-authored plan, deterministic compile, one-use budget | Planned | - |
| Accepted-plan compiler and canonical plan format | Live | implemented |
| Re-authenticated snapshots and evidence contracts | Planned | - |
| Saved, shared and forked dashboards | Live | implemented |
| Republishing an improved composition | Planned | - |
| Kernel signing of emitted evidence (available, not on every path) | Live | implemented |
| Committed acceptance programs, checked against their tier | Live | implemented |
| Gateway-signed receipts for submitted evidence packages | Live | implemented |
| Independent oracle verdicts | Planned | - |
| Settlement escrow on the Base Sepolia test network | Live | implemented; deployed on a test network |
| Settlement units and payout legs | Live | implemented; deployed on a test network |
| Release rules: evidence and verdict above tier 0, buyer approval at tier 0, reclaim | Live | implemented; deployed on a test network |
| Block-pinned money facts in the settlement read routes (the chain reader is planned) | Live | implemented (routes only) |
| Block references on every money display | Planned | - |
| Multi-party legs | Planned | - |
| PCC holds the vendor accounts | Planned | - |
| One bill naming every payee | Planned | - |
| A wallet for everyone at sign-up | Planned | - |
| Linking an existing wallet (smart-contract wallets included) | Live | implemented |
| Test-network funding of a linked wallet | Live | implemented |
| Durable spending limits bound to a principal | Planned | - |
| Execution scopes | Live | implemented |
| Emergency stop rejects pending approvals and queued relay commands; queued jobs are held | Live | implemented |
| Safety controls at the dispatch point | Planned | - |
| Closed render format: closed catalog and provenance classes | Live | implemented |
| Closed set of dashboard window kinds | Live | implemented |
| MCP App views (in production, only with an app domain) and the cross-origin projection | Live | implemented |
| Read-only views inside third-party hosts; one operation | Live | implemented |
| No model call to load, render or generate interfaces | Live | implemented |
| Style-locked trust surfaces | Planned | - |
| Operator-published interfaces bound to identity | Planned | - |
| A2UI v0.9.1 adapter | Planned | - |
| Bounded model decisions | Planned | - |
| Customization limits for a user's agent | Planned | - |
| One-call problem reports | Live | implemented |
| Report status lookup | Planned | - |
| Observations from receipts and evidence | Planned | - |
| Known-answer tasks in the job path | Planned | - |
| A new method buyable in hours to days | Planned | - |
