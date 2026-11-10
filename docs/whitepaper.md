# Physical Capability Cloud

**Version 4.0, November 2026.**

**Turn abilities and inventions into trusted, economically callable capacity that other agents can immediately build on.**

---

## 1. Why PCC

PCC is built to make physical work purchasable as a composable, verifiable obligation: specify an outcome, assemble the capabilities needed to produce it, agree on acceptance and payment, execute across organizations, and carry the evidence forward. Today, putting those steps together often needs a coordinator who understands each supplier's interfaces, reads their records, reconciles invoices and absorbs the failures between organizations.

The unit PCC is built around is an agreed physical obligation: an executable acceptance rule, attributable evidence and a funded payment consequence. PCC supplies each of the three pieces: committed acceptance programs, evidence signed by the executing kernel's key, and escrow units that release only against committed evidence. Each job runs end to end as one such obligation: funded, executed, evidenced, verified and paid.

With PCC, several things become practical:

- A buyer orders an outcome that spans several suppliers without integrating each supplier separately.
- A small operator sells spare capacity as a capability that another agent can discover, procure and pay for.
- A downstream buyer checks upstream provenance without rebuilding the history from emails and disconnected databases.
- Contributors receive agreed shares as work settles, instead of waiting for a lead contractor to reconcile and distribute revenue afterwards.

### What each industry needs beyond "execution completed"

| Industry | What becomes possible | What PCC establishes beyond "execution completed" |
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

PCC has two sides, and each reaches PCC through its own agent. Buyers' agents discover capabilities, compose plans and pay for work. Suppliers' agents onboard a lab, an operator or a device. Each side has its own entry point: an agent connection for buyers, and a step-by-step runbook that a supplier's coding agent follows.

The buyer's agent authors the plan, and PCC's part is to check it, price it, fund it and settle it, not to write it.

Buyers and operators bring their own agent and their own model. PCC's execution, evidence and settlement path makes no model call.

---

## 3. For buyers' agents: find, price, commit, follow

### Connecting

- Agents connect to PCC's MCP server at the path /mcp on PCC's gateway, capability.network. A separate, read-only MCP surface at /mcp/apps serves interface views.
- The agent package at capability.network/agent-package.json gives any LLM agent PCC's tools, auth modes and worked examples in one file.
- The API is published as an OpenAPI document at /openapi.json, and a documentation MCP server at /mcp/docs serves PCC's guides with a search tool.
- An agent holding a PCC API key searches PCC's tool catalog by intent.
- One golden-path file, /.well-known/agent.md, tells an agent exactly what to do, for buyers and for suppliers.
- An MCP tool, `pcc_search_tools`, wraps tool search with a small default toolset.
- Signup needs no browser: an agent registers, verifies an emailed code and claims the account; then it checks the account's status from the command line and installs PCC's MCP server into a coding agent with one command.

### The buyer's path

An agent searches PCC's capability registry, and a person browses the same registry at /discover.

The agent prices a capability from its parameters, opens a negotiation session, gets a quote, commits, and submits the job.

The buyer funds the job's escrow from its own wallet, as the payer on chain.

The buyer follows the money through settlement reads that report each settlement unit's lifecycle, receipt and provenance. Each read is pinned to a block (section 9).

A fresh buyer agent goes from nothing to a quoted, composed plan.

---

## 4. For operators: join with your own agent

### What joining produces

Joining PCC produces an honestly described, safely executable, evidence-capable supplier. That takes adapter conformance, identity enrollment, capability validation and a watched acceptance job.

### How an operator joins

- PCC's starter runbook lets an operator's own coding agent onboard a device in ordered phases: identify, intake, research, build, register, verify, operate and publish.
- pcc-node, a Python program in PCC's repository, gives the operator's machine start, discover, detect and status commands.
- PCC's kernel has adapters for IPP printers (with a built-in IPP client), OctoPrint, Modbus sensors, OPC UA, SiLA instruments and cameras.
- PCC's own hosted agent offers only reviewed public read tools through an explicit allowlist, and shows results only through typed projections. It acts as the user, never as PCC.
- Operators onboard new machines, processes and capabilities with their own agents through the ADK, PCC's agent development kit. The ADK makes the adapters; PCC does not write each capability's rules.
- The ADK guides the operator's own agent to build a template's adapter, its tests and its negative controls. PCC supplies no generator.
- A one-command installer sets up a node.
- PCC runs as a managed end-to-end service: partner-hosted sandboxed agents and a device kit for a shop, a lab, a car or a phone. An operator's hosted agent acts through a scoped session key.
- A fresh Claude Code, a fresh Codex and PCC's own agent each onboard a simulated instrument end to end.

---

## 5. Capabilities, kits and templates

A capability is described by a Capability StructureDefinition (CSD): a versioned document that may inherit from a base definition, with typed parameters, cross-parameter constraints, evidence requirements for each assurance tier, and pricing rules. The format borrows FHIR's idea of a base definition that profiles narrow.

A Capability Kit is a versioned manifest that records its parent kit's digest, so a fork's lineage is visible.

PCC's kit registry stores published kits write-once: a published version never changes, and an edit is a new manifest. An agent with a PCC API key lists published kits and fetches any one by its digest, and a fork is published with its parent's digest.

Operators publish kits themselves, and agents search kits alongside available operators.

An operator adapts a kit and sees where its provenance has gaps.

A template is an adapter plus its proof rules and payout profile, published as a Capability Kit.

An operator binds to PCC and advertises its capacity and pricing.

---

## 6. Rights, licensing and author earnings

Templates let one operator's work serve many others. PCC pays the people who make them through its own contracts, under terms everyone accepts before money moves.

A template's author is paid a share, in basis points, of each job that uses the template, through PCC's own escrow payouts.

Licensing and payout terms are versioned and accepted before a job is funded. A license that doesn't fit is refused, not given an invented split. Terms fixed before funding are compiled into exact payouts and checked.

Licensing and economic terms are audited.

---

## 7. Plans and composition

A buyer's agent submits its own plan, a graph of capability steps, and PCC compiles it deterministically under a one-use budget.

Snapshots and evidence contracts are re-authenticated before value moves.

A dashboard that combines windows from several operators is saved, shared and forked at its own capability.network/a/ address, and it reloads without being regenerated.

The author of a composition republishes an improved version of it.

---

## 8. Evidence and acceptance

Section 1's limits apply here: a signed record shows which key signed it, not that it is true.

Evidence that a PCC kernel emits for a job is signed with that kernel's registered key.

Acceptance is defined by committed programs: each program is identified by its hash, and an evidence bundle is checked against the program committed for its assurance tier.

The operator posts the job's signed result package, and PCC's gateway signs the receipt.

An independent oracle checks the evidence against the committed program and signs the verdict that releases or withholds payment.

Evidence that a machine accepted a command is not evidence that the output met the specification, and a missing failure event proves little unless the record covers the whole run.

---

## 9. Settlement

PCC's settlement escrow is an on-chain contract with a published deployment record.

A job's escrow funding carries up to 16 settlement units, and each unit up to 16 payout legs. Each unit has its own required assurance tier, its own evidence gate and its own reclaim deadline.

A unit's funds are released only against the evidence its operator committed: on an attested verdict over that evidence, after the unit's challenge window, or, for a unit at assurance tier 0, on the buyer's own signed approval of it. Otherwise the buyer can reclaim the funds after the deadline.

Every money fact that PCC's settlement reads serve is a chain read pinned to a block. Each reply echoes the block number and hash, and a mismatch is refused, so anyone can re-check a reply against their own node.

Every money display and receipt on screen shows its block reference, and nothing shows as paid before finality.

Multi-party jobs are split into legs, such as print, courier and carrier, each with its own operator, wallet, evidence and payout, so a good leg is paid even when a later leg fails.

PCC holds the vendor accounts, such as postage, email and carriers, and pays them, so no buyer or operator has to sign up for or wire up a third-party vendor.

One bill: the buyer approves one all-in price that names every payee, and pays it once.

---

## 10. Wallets and authority

Everyone gets a wallet at sign-up, non-custodial by default, with gas sponsored on mainnet and automatic funding on the test network.

A person or an agent links an existing wallet to a PCC account through a device-authorization flow, proving control of the wallet with a signature. Smart-contract wallets are accepted.

Spending authority is bound to a principal and capped durably across every step of a plan.

Remote control of a device runs under an execution scope: a grant that names the allowed tools and sets a command budget, which the operator can revoke, with an audit trail.

An operator's emergency stop rejects the kernel's pending approvals and queued commands, so nothing queued before the stop runs after the resume.

Permission to spend money on a job does not make a command safe for a device or a site, so safety controls sit at the point where commands are dispatched.

---

## 11. Interfaces across operators

PCC's interface design, in the operator's words: "Operator interfaces are compiled artifacts; orchestration interfaces are user-agent compositions. PCC defines, validates, distributes and safely renders the language connecting them, but does not need to supply the intelligence that creates them." The reasoning: an operator serves mostly the same interface over and over, so that interface should be compiled once; a user's agent combines many operators in one workflow, so the composing belongs there.

- Every node in a rendered interface view comes from deterministic PCC code and a closed catalog, and carries a provenance class: authoritative, accepted, proposed, preference or ephemeral.
- A composed dashboard uses a closed set of window kinds: note, metric, capability, list, form, run, approval, receipt, chain and actions.
- Interface views reach MCP hosts as MCP App views, and a reader on another origin gets only render fields, through a server-side projection.
- Third-party and composed views are read-only: the only operation they can name is a request for a quote. Approvals and payments are confirmed on PCC's own pages.
- A routine run makes no model call: it loads a stored interface, renders it and reads current state. PCC hosts no model to generate or render interfaces.
- No artifact, model or user agent can create, suppress or restyle a trust surface: restyling uses design tokens only, and trust surfaces are style-locked.
- An operator publishes its interface once, bound to its proven identity, versioned and cached, and a user's agent composes interfaces from many operators.
- Operator interfaces arrive in A2UI v0.9.1 through an adapter, and are compiled at publish time into PCC's own format. The renderer never reads A2UI.
- Models make bounded decisions (typed questions answered with a confidence), and deterministic rules map the answers to catalog components. Models never decide payment, grants, whether evidence suffices, or physical safety.
- A user's agent may rearrange, group, collapse and restyle within limits, but may not change what an operator's inputs, outputs or actions mean, or remove a warning or an approval.

---

## 12. Feedback and improvement

Agents report a problem to PCC in one call.

A reporter looks up its report's status as PCC triages it.

Execution observations are derived from receipts and evidence, never from self-reports, and feed back into a capability's record.

Known-answer test tasks run inside the job path to check that a capability still performs.

---

## 13. From a new method to a buyable capability

A new method becomes safely buyable in hours to days: its author gets a usable safety path, made of a capability spec, a committed program and an assurance ladder, without PCC writing its rules.

---

## 14. Risks and what PCC does not guarantee

- Retries can repeat irreversible physical work. An idempotent payment does not make a device command idempotent, and a refund cannot unprint a part.
- Ratings and evaluator signals can reward the wrong actors unless they are tied to authenticated participation and accepted outcomes.
- Discovery can concentrate demand, assurance costs can shut out small operators, and evidence rules can become surveillance.
- Some choices belong to the operator, not the code: how temporary organizations form and wind down, how contracts for several parties are combined, what competition optimizes, how rights feed payouts, and who finances work that runs in stages.

---

## 15. Join the private beta

Buyers, operators and builders can sign up for PCC's private beta. The signup form is at the end of the whitepaper page, https://capability.network/whitepaper.
